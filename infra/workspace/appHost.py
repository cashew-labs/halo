#!/usr/bin/env python3
"""Narrow, root-owned container supervisor. Never give the workspace docker.sock."""
import contextlib
import http.server
import json
import os
import pathlib
import re
import socket
import subprocess
import threading
import time
import urllib.request
import appPaths

WORKSPACE = pathlib.Path('/var/lib/halo/home/documents')
DATA = pathlib.Path('/var/lib/halo/apps')
SOCKET = '/run/halo-apps/control.sock'
NETWORK = 'halo-apps'
GATEWAY = '172.30.0.1'
LABEL = 'halo.shared=true'
IMAGE = 'node:24.21.0-bookworm-slim'
MAX_DATA = 16 * 1024 * 1024
lock = threading.Lock()


# coverage-exempt: Linux root/Docker adapter; user explicitly deferred live gVisor provisioning tests. IPC and editing boundaries are tested locally.
def command(args, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Host command failed: ' + result.stderr[:1024])
    return result.stdout.strip()


# coverage-exempt: Linux root/Docker adapter; user explicitly deferred live gVisor provisioning tests. IPC and editing boundaries are tested locally.
def cgroup_parent():
    driver = command(['docker', 'info', '--format', '{{.CgroupDriver}}'])
    if driver == 'systemd':
        return 'halo-apps.slice'
    group = command(['systemctl', 'show', '--property=ControlGroup', '--value', 'halo-apps.slice'])
    if not group.startswith('/'):
        raise RuntimeError('Aggregate app cgroup is unavailable')
    return group


def app_name(extension_id, instance=None):
    if not isinstance(extension_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', extension_id):
        raise ValueError('Invalid extension ID')
    if instance is None:
        return 'halo-app-' + extension_id
    # Template demos run one instance per visitor.
    if not isinstance(instance, str) or not re.fullmatch(r'[a-f0-9]{12}', instance):
        raise ValueError('Invalid demo instance')
    return 'halo-app-' + extension_id + '--' + instance


def slot(extension_id, instance=None):
    """The container name and private state directory of an app or demo instance."""
    name = app_name(extension_id, instance)
    directory = DATA / extension_id if instance is None else DATA / extension_id / 'instances' / instance
    return name, directory


# coverage-exempt: Linux root/Docker adapter; user explicitly deferred live gVisor provisioning tests. IPC and editing boundaries are tested locally.
def stop(name):
    found = command(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$'])
    if found:
        command(['docker', 'stop', '--time', '5', name], timeout=15)
        command(['docker', 'rm', '-f', name])


# coverage-exempt: Linux root/Docker adapter; user explicitly deferred live gVisor provisioning tests. IPC and editing boundaries are tested locally.
def volume(directory, create=True, size='128M'):
    # A filesystem-backed quota also bounds writes from arbitrary bash programs.
    image = directory / 'data.ext4'
    if not create and not image.exists():
        return None
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    mount = directory / 'data'
    mount.mkdir(mode=0o700, exist_ok=True)
    if not image.exists():
        command(['fallocate', '-l', size, str(image)])
        command(['mkfs.ext4', '-q', '-F', '-m', '0', str(image)])
    if not os.path.ismount(mount):
        command(['mount', '-o', 'loop,nosuid,nodev', str(image), str(mount)])
    os.chown(mount, 1000, 1000)
    os.chmod(mount, 0o700)
    return mount


def source_mount(extension_id):
    app_name(extension_id)
    target = DATA / extension_id / 'source'
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    with appPaths.directory(WORKSPACE / '.halo/extensions' / extension_id) as descriptor:
        if os.path.ismount(target):
            command(['umount', str(target)])
        # The mount source is a pinned descriptor, not a pathname the user can
        # replace between validation and the privileged mount syscall.
        command(['mount', '--bind', f'/proc/{os.getpid()}/fd/{descriptor}', str(target)])
    return target


def start_input(body):
    name = app_name(body.get('extensionId'), body.get('instance'))
    broker_port = body.get('brokerPort')
    if type(broker_port) is not int or not 1 <= broker_port <= 65535:
        raise ValueError('Invalid broker port')
    if body.get('syncAccess') not in ['read-only', 'shared', 'actions']:
        raise ValueError('Invalid sync access')
    for key in ['hostToken', 'toolToken']:
        if not isinstance(body.get(key), str) or not re.fullmatch(r'[a-zA-Z0-9_-]{32,128}', body[key]):
            raise ValueError('Invalid app credential')
    return name


def read_limited(source):
    if os.fstat(source.fileno()).st_size > MAX_DATA:
        raise ValueError('App data exceeds the transfer limit')
    contents = source.read(MAX_DATA + 1)
    if len(contents) > MAX_DATA:
        raise ValueError('App data exceeds the transfer limit')
    return contents


def instances(extension_id):
    """Demo instances of an extension with a container or state directory."""
    prefix = app_name(extension_id) + '--'
    names = command(['docker', 'ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^/' + prefix]).splitlines()
    found = {name[len(prefix):] for name in names if name.startswith(prefix)}
    root = DATA / extension_id / 'instances'
    if root.is_dir() and not root.is_symlink():
        found.update(entry.name for entry in root.iterdir())
    return sorted(instance for instance in found if re.fullmatch(r'[a-f0-9]{12}', instance))


def reset(extension_id):
    """Stops and discards every demo instance, including ones a crashed server left."""
    for instance in instances(extension_id):
        name, directory = slot(extension_id, instance)
        stop(name)
        discard(directory)
    return {'reset': True}


# coverage-exempt: Linux root unmount adapter; instance naming and selection are tested.
def discard(directory):
    """Resets a demo instance: its data volume and directory are removed."""
    mount = directory / 'data'
    if os.path.ismount(mount):
        command(['umount', str(mount)])
    command(['rm', '-rf', '--one-file-system', str(directory)])


def import_data(extension_id, directory, data):
    """Copies workspace data into the app volume once, never through a symlink."""
    imported = directory / 'imported'
    if imported.exists():
        return
    original = WORKSPACE / '.halo/extension-data' / extension_id / 'tandem.json'
    try:
        with appPaths.regular_file(original) as source_data:
            contents = read_limited(source_data)
    except FileNotFoundError:
        contents = None
    if contents is not None:
        with appPaths.directory(data) as parent:
            descriptor = os.open('tandem.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(contents)
            os.fchown(output.fileno(), 1000, 1000)
    imported.touch(mode=0o600)


def snapshot(extension_id):
    _name, directory = slot(extension_id)
    # Mounting first distinguishes an unmounted volume from an app without data.
    data = volume(directory, create=False)
    if data is None:
        return {}
    try:
        with appPaths.regular_file(data / 'tandem.json') as data_file:
            return {'data': read_limited(data_file).decode('utf8')}
    except FileNotFoundError:
        return {}


def start(body):
    name = start_input(body)
    extension_id = body['extensionId']
    broker_port = body['brokerPort']
    access = body['syncAccess']
    source = source_mount(extension_id)
    with appPaths.regular_file(WORKSPACE / '.halo/extensions' / extension_id / 'dist/start.mjs'):
        pass
    stop(name)
    running = command(['docker', 'ps', '-q', '--filter', 'label=' + LABEL]).splitlines()
    if len(running) >= 4:
        raise ValueError('This VM supports four running shared apps')
    _name, directory = slot(extension_id, body.get('instance'))
    # A demo instance starts from the installed sample data in a small volume.
    data = volume(directory, size='128M' if body.get('instance') is None else '32M')
    import_data(extension_id, directory, data)
    return run_app(name=name, source=source, data=data, broker_port=broker_port, access=access, body=body)


# coverage-exempt: Linux root/Docker adapter; user explicitly deferred live gVisor provisioning tests. Inputs are validated by start_input.
def run_app(name, source, data, broker_port, access, body):
    # Host-bound bridge traffic uses INPUT, while forwarded egress uses DOCKER-USER.
    rule = ['-s', '172.30.0.0/24', '-d', GATEWAY, '-p', 'tcp', '--dport', str(broker_port), '-j', 'ACCEPT']
    existing = subprocess.run(['iptables', '-C', 'HALO-APPS-HOST', *rule], capture_output=True)
    if existing.returncode:
        command(['iptables', '-I', 'HALO-APPS-HOST', '1', *rule])
    env = {
        'HALO_EXTENSION_HOST_TOKEN': body['hostToken'],
        'HALO_EXTENSION_TOOLS_TOKEN': body['toolToken'],
        'HALO_EXTENSION_TOOLS_ORIGIN': f'http://{GATEWAY}:{broker_port}',
        'HALO_EXTENSION_LISTEN_HOST': '0.0.0.0',
        'HALO_EXTENSION_SYNC_ACCESS': access,
        'HOME': '/data',
    }
    args = ['docker', 'run', '-d', '--name', name, '--label', LABEL,
            '--runtime=runsc', '--network', NETWORK, '--init', '--user', '1000:1000',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--memory=128m', '--memory-swap=128m', '--cpus=0.5', '--pids-limit=64',
            '--cgroup-parent=' + cgroup_parent(), '--log-opt=max-size=2m', '--log-opt=max-file=2',
            '--tmpfs=/tmp:rw,nosuid,nodev,size=32m,mode=1777',
            '--mount', f'type=bind,src={source},dst=/app,readonly',
            '--mount', f'type=bind,src={data},dst=/data',
            '--workdir=/app', '--publish', '127.0.0.1::3000']
    for key, value in env.items():
        args.extend(['--env', key + '=' + value])
    args.extend([IMAGE, 'node', 'dist/start.mjs', '--port', '3000', '--data-dir', '/data'])
    with contextlib.ExitStack() as cleanup:
        command(args)
        cleanup.callback(stop, name)
        binding = json.loads(command(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))
        port = binding['3000/tcp'][0]['HostPort']
        origin = f'http://127.0.0.1:{port}'
        ready = urllib.request.Request(origin + '/__halo/ready', headers={'x-halo-extension-token': body['hostToken']})
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(ready, timeout=0.5) as response:
                    if response.status == 200:
                        cleanup.pop_all()
                        return {'url': origin + '/view/'}
            except OSError:
                pass
            time.sleep(0.1)
        raise ValueError('Sandboxed extension did not become ready')


def execute(body):
    extension_id = body['extensionId']
    name = app_name(extension_id) + '-build'
    script = body.get('command')
    if not isinstance(script, str) or len(script) > 8192:
        raise ValueError('Invalid remote command')
    source = source_mount(extension_id)
    return run_build(name=name, source=source, script=script)


# coverage-exempt: Linux root/Docker adapter; user explicitly deferred live gVisor provisioning tests. Inputs are validated by execute.
def run_build(name, source, script):
    stop(name)
    # The owner's command can edit source, but receives neither live data nor
    # privileged credentials. npm scripts and dependencies remain untrusted.
    prepare = """node --input-type=module -e '
import fs from "node:fs";
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.dependencies ??= {};
p.devDependencies ??= {};
p.dependencies["@get-halo/extension-sdk"] = "file:/halo-sdk/get-halo-extension-sdk-0.0.0.tgz";
p.devDependencies["@get-halo/extension-tools"] = "file:/halo-sdk/get-halo-extension-tools-0.0.0.tgz";
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\\n");
' && """
    args = ['docker', 'run', '-d', '--name', name, '--label', LABEL,
            '--runtime=runsc', '--network', NETWORK, '--init', '--user', '1000:1000',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--memory=256m', '--memory-swap=256m', '--cpus=0.5', '--pids-limit=64',
            '--cgroup-parent=' + cgroup_parent(), '--log-opt=max-size=2m', '--log-opt=max-file=2',
            '--tmpfs=/tmp:rw,nosuid,nodev,size=32m,mode=1777',
            '--env=HOME=/tmp', '--mount', f'type=bind,src={source},dst=/app',
            '--mount', 'type=bind,src=/var/lib/halo/app-sdk,dst=/halo-sdk,readonly',
            '--workdir=/app', IMAGE, 'timeout', '--signal=KILL', '120', 'bash', '-lc', prepare + script]
    with contextlib.ExitStack() as cleanup:
        command(args)
        cleanup.callback(stop, name)
        exit_code = command(['docker', 'wait', name], timeout=130)
        logs = subprocess.run(['docker', 'logs', '--tail', '64', name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30)
        return {'exitCode': int(exit_code), 'output': logs.stdout[-8192:]}


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True

    def server_bind(self):
        self.socket.bind(self.server_address)
        self.server_name = 'halo-apps'
        self.server_port = 0


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def do_POST(self):
        self.connection.settimeout(40)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise ValueError('Invalid request size')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Invalid request')
            name, directory = slot(body.get('extensionId'), body.get('instance'))
            with lock:
                if self.path == '/start':
                    result = start(body)
                elif self.path == '/stop':
                    stop(name)
                    if body.get('instance') is not None:
                        discard(directory)
                    result = {'stopped': True}
                elif self.path == '/exec':
                    result = execute(body)
                elif self.path == '/reset':
                    result = reset(body['extensionId'])
                elif self.path == '/snapshot':
                    result = snapshot(body['extensionId'])
                elif self.path == '/status':
                    found = command(['docker', 'ps', '-q', '--filter', 'name=^/' + name + '$'])
                    result = {'running': bool(found)}
                else:
                    raise ValueError('Unknown app operation')
            self.respond(200, result)
        except (ValueError, KeyError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            self.respond(400, {'error': str(error)[:1024]})

    def respond(self, status, body):
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


# coverage-exempt: Service entry point binds the root-owned socket; the server and handler are tested on a temporary socket.
if __name__ == '__main__':
    pathlib.Path(SOCKET).parent.mkdir(mode=0o750, exist_ok=True)
    os.chown(pathlib.Path(SOCKET).parent, 0, 1000)
    pathlib.Path(SOCKET).unlink(missing_ok=True)
    server = Server(SOCKET, Handler)
    os.chown(SOCKET, 0, 1000)
    os.chmod(SOCKET, 0o660)
    server.serve_forever()
