#!/usr/bin/env python3
"""A root-owned systemd job; its lifetime is independent of the workspace container."""
import contextlib
import fcntl
import json
import os
import pathlib
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

PROC = pathlib.Path('/proc')
ROOT = pathlib.Path('/etc/halo')
STATE = ROOT / 'update-state.json'


def request(url, token, data=None, method=None, force=False):
    headers = {'authorization': 'Bearer ' + token, 'content-type': 'application/json'}
    if force:
        headers['x-halo-force-update'] = 'true'
    req = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
                                 headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def save(state):
    temporary = STATE.with_suffix('.tmp')
    with temporary.open('w') as output:
        os.chmod(temporary, 0o600)
        json.dump(state, output)
    os.replace(temporary, STATE)


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout


def background_commands():
    # A command can redirect its pipes and outlive the tool invocation. Only
    # inspect this container's PIDs, and never print process environments.
    try:
        rows = command(['docker', 'top', 'halo-workspace', '-eo', 'pid'], timeout=10).splitlines()
        if not rows or rows[0].strip() != 'PID':
            return True
        for row in rows[1:]:
            pid = row.strip()
            if not pid.isdecimal():
                return True
            try:
                environment = (PROC / pid / 'environ').read_bytes()
            except FileNotFoundError:
                continue
            if any(value.startswith(b'HALO_BASH_RUN_ID=') for value in environment.split(b'\0')):
                return True
        return False
    except (OSError, subprocess.SubprocessError):
        # Failed observation cannot grant automatic interruption permission.
        return True


class Updater:
    def __init__(self, config):
        self.config = config
        self.runtime = config['runtime']
        self.local = 'http://127.0.0.1:' + str(config.get('port', 8788)) + '/maintenance'
        self.state = json.loads(STATE.read_text()) if STATE.exists() else {
            'state': 'current', 'version': 'unknown', 'targetVersion': '', 'busy': True}
        self.supported = False

    def inspect(self):
        try:
            status = request(self.local, self.config['gateway']['token'])
            self.supported = True
            self.state['version'] = status['version']
            self.state['busy'] = status['busy'] or background_commands()
        except (urllib.error.URLError, TimeoutError, ValueError):
            # An old or unavailable server is never assumed safe to restart.
            self.supported = False
            self.state['busy'] = True
            try:
                env = json.loads(command(['docker', 'inspect', '--format', '{{json .Config.Env}}', 'halo-workspace'], timeout=10))
                self.state['version'] = next((value.split('=', 1)[1] for value in env
                                              if value.startswith('HALO_BUILD_VERSION=')), 'unknown')
            except subprocess.SubprocessError:
                self.state['version'] = 'unknown'

    def report(self):
        save(self.state)
        return request(self.runtime['origin'] + '/api/workspace-runtime/update', self.runtime['token'],
                       {key: value for key, value in self.state.items() if key in
                        ['state', 'version', 'targetVersion', 'busy', 'error']})

    def pull(self, target):
        self.state.update(state='downloading', targetVersion=target['version'])
        self.state.pop('error', None)
        self.report()
        token = request(self.runtime['origin'] + '/api/workspace-runtime/update-token',
                        self.runtime['token'], {})['token']
        image = target['image']
        if not re.fullmatch(r'[a-z0-9.-]+/[^\s]+@sha256:[a-f0-9]{64}', image):
            raise ValueError('Release image must be pinned by digest')
        name = 'halo-workspace:' + image.rsplit(':', 1)[1]
        # Leave room for user writes and extraction while retaining the running image.
        current = (ROOT / 'image').read_text().strip()
        size = int(command(['docker', 'image', 'inspect', '--format', '{{.Size}}', current], timeout=10))
        disk = os.statvfs(ROOT)
        if disk.f_bfree * disk.f_frsize < size * 2 + 1024 ** 3:
            raise RuntimeError('Not enough free space to prepare a workspace update')
        with tempfile.TemporaryDirectory(prefix='halo-update-') as directory:
            env = {**os.environ, 'DOCKER_CONFIG': directory}
            command(['docker', 'login', '-u', 'oauth2accesstoken', '--password-stdin', image.split('/')[0]],
                    input=token, env=env, timeout=30)
            # Reports continue during a long image pull. Never log credentials or process environments.
            stopped = threading.Event()
            def heartbeat():
                while not stopped.wait(10):
                    try:
                        self.report()
                    except (OSError, ValueError, TimeoutError):
                        print('Could not report workspace download progress', flush=True)
            reporter = threading.Thread(target=heartbeat, daemon=True)
            reporter.start()
            try:
                command(['docker', 'pull', '--platform', 'linux/amd64', image], env=env, timeout=900)
                command(['docker', 'tag', image, name], timeout=15)
                command(['docker', 'rmi', image], timeout=15)
            finally:
                stopped.set()
                reporter.join()
        previous = self.state.get('prepared')
        if previous and previous not in (name, current):
            command(['docker', 'rmi', previous], timeout=30)
        self.state.update(state='ready', prepared=name, preparedImage=image)
        self.report()

    def run(self):
        self.inspect()
        if self.state['state'] == 'upgrading':
            # Resume after a host restart or an updater killed by its deadline.
            if self.supported and self.state['version'] == self.state['targetVersion']:
                self.state.update(state='current')
                previous = self.state.pop('attemptPrevious', None)
                if previous:
                    self.state['previous'] = previous
            else:
                self.state.update(state='failed', blockedImage=self.state.get('preparedImage'), retryAt=time.time() + 300,
                                  error='Workspace update was interrupted. Try updating again.')
                previous = self.state.get('attemptPrevious')
                if previous and (ROOT / 'image').read_text().strip() != previous:
                    command(['/usr/local/bin/halo-workspace-upgrade', previous], timeout=90)
                    self.inspect()
                with contextlib.suppress(OSError, ValueError, TimeoutError):
                    request(self.local, self.config['gateway']['token'], method='DELETE')
                self.report()
                return
        plan = self.report()
        target = plan.get('target')
        if not target:
            self.state.update(state='current')
            self.state.pop('error', None)
            self.state.pop('blockedImage', None)
            self.report()
            return
        # Failed attempts are visible and retried at a bounded interval.
        request_id = plan.get('requestId', 0)
        if request_id > self.state.get('attemptedRequest', 0):
            self.state.update(attemptedRequest=request_id, retryAt=0,
                              state='ready' if self.state.get('preparedImage') == target['image'] else 'available')
            self.state.pop('error', None)
            self.state.pop('blockedImage', None)
            self.report()
        if self.state.get('blockedImage') == target['image']:
            return
        if time.time() < self.state.get('retryAt', 0):
            return
        if self.state.get('preparedImage') != target['image']:
            self.pull(target)
        # Re-read both the latest release and user activity after downloading.
        self.inspect()
        plan = self.report()
        if plan.get('target') != target or not plan.get('activate'):
            return
        force = plan.get('force') is True
        if not force and (not self.supported or self.state['busy']):
            return
        reserved = False
        activated = False
        previous = (ROOT / 'image').read_text().strip()
        if self.state['version'] == 'unknown':
            previous = self.state.get('attemptPrevious', self.state.get('previous', previous))
        try:
            if self.supported:
                reserved = True
                try:
                    request(self.local, self.config['gateway']['token'], {}, method='POST', force=force)
                except urllib.error.HTTPError as error:
                    if error.code == 409:
                        reserved = False
                        return
                    raise
                # Admission is now closed. Recheck detached children created by
                # a tool that completed between the first observation and reservation.
                if not force and background_commands():
                    self.state['busy'] = True
                    self.report()
                    return
            self.state.update(state='upgrading', attemptPrevious=previous)
            # Persist maintenance before disconnecting readers.
            self.report()
            # Host files travel with the pinned image, so delayed VMs install
            # the matching scripts and security profile at the same idle boundary.
            with tempfile.TemporaryDirectory(prefix='halo-host-') as directory:
                container = command(['docker', 'create', '--entrypoint', 'true', self.state['prepared']], timeout=15).strip()
                try:
                    command(['docker', 'cp', container + ':/opt/halo/host/.', directory], timeout=15)
                finally:
                    command(['docker', 'rm', container], timeout=10)
                command(['bash', directory + '/exeTemplate.sh', self.state['prepared'], 'update-personal-host'], timeout=30)
            if self.supported:
                # Refresh the reservation after host preparation, before stopping work.
                request(self.local, self.config['gateway']['token'], {}, method='POST', force=force)
            self.report()
            activated = True
            command(['/usr/local/bin/halo-workspace-upgrade', self.state['prepared']], timeout=90)
            deadline = time.monotonic() + 60
            healthy = False
            while time.monotonic() < deadline:
                try:
                    self.inspect()
                except (OSError, ValueError, TimeoutError, subprocess.SubprocessError):
                    pass
                else:
                    if self.supported and self.state['version'] == target['version']:
                        healthy = True
                        break
                time.sleep(2)
            if not healthy:
                raise RuntimeError('Updated workspace did not become ready')
            # Reporting is not a health check: a control-plane outage must not
            # roll back a healthy workspace. The next timer retries reporting.
            activated = False
            self.state.update(state='current')
            self.state.pop('error', None)
            self.state.pop('attemptPrevious', None)
            obsolete = self.state.get('previous')
            if obsolete and obsolete not in (previous, self.state['prepared']):
                try:
                    command(['docker', 'rmi', obsolete], timeout=30)
                except subprocess.SubprocessError:
                    print('Could not remove an old workspace image', flush=True)
            self.state['previous'] = previous
            save(self.state)
            with contextlib.suppress(OSError, ValueError, TimeoutError):
                self.report()
            return
        except (OSError, ValueError, TimeoutError, RuntimeError, subprocess.SubprocessError):
            if activated:
                self.state['blockedImage'] = target['image']
                try:
                    command(['/usr/local/bin/halo-workspace-upgrade', previous], timeout=90)
                    self.inspect()
                    print('Restored the previous workspace image after a failed update', flush=True)
                except (OSError, ValueError, TimeoutError, subprocess.SubprocessError):
                    print('Could not restore the previous workspace image', flush=True)
            raise
        finally:
            if reserved:
                with contextlib.suppress(OSError, ValueError, TimeoutError):
                    request(self.local, self.config['gateway']['token'], method='DELETE')


def main():
    config_path = ROOT / 'workspace-server.json'
    if not config_path.exists():
        return
    config = json.loads(config_path.read_text())
    if 'sharedApp' in config or 'runtime' not in config:
        return
    with (ROOT / 'update.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        updater = Updater(config)
        try:
            updater.run()
        except (OSError, ValueError, TimeoutError, RuntimeError, subprocess.SubprocessError) as error:
            print(type(error).__name__ + ": " + str(error)[:1000], flush=True)
            updater.state.update(state='failed', error='Workspace update failed. Try updating again.', retryAt=time.time() + 300)
            with contextlib.suppress(OSError, ValueError, TimeoutError):
                updater.report()
            print('Workspace update failed; retry scheduled', flush=True)


# coverage-exempt: The root entrypoint delegates to main, exercised with real HTTP/files and controlled host commands; a subprocess would read the machine's real /etc/halo.
if __name__ == '__main__':
    main()
