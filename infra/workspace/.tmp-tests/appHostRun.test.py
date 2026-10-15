import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'infra/workspace'))
import appHost

TOKENS = {'hostToken': 'h' * 40, 'toolToken': 't' * 40}


class Ready:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class RunAppTests(unittest.TestCase):
    """The Docker argument builders and control flow, with the host commands mocked."""

    def setUp(self):
        self.commands = []
        self.stopped = []
        patches = [
            mock.patch.object(appHost, 'cgroup_parent', return_value='halo-apps.slice'),
            mock.patch.object(appHost, 'stop', side_effect=lambda name: self.stopped.append(name)),
            mock.patch.object(appHost.time, 'sleep'),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def command(self, inspect='{"3000/tcp":[{"HostPort":"40001"}]}'):
        def run(args, timeout=30, env=None):
            self.commands.append((args, env))
            if args[:2] == ['docker', 'inspect']:
                if isinstance(inspect, Exception):
                    raise inspect
                return inspect
            return 'container'
        return run

    def run_app(self, iptables_present=False, **command):
        checked = subprocess.CompletedProcess([], 0 if iptables_present else 1)
        with mock.patch.object(appHost, 'command', side_effect=self.command(**command)), \
                mock.patch.object(appHost.subprocess, 'run', return_value=checked):
            return appHost.run_app(name='halo-app-books', source=pathlib.Path('/src'), data=pathlib.Path('/data-volume'),
                                   broker_port=8788, access='actions', body=TOKENS)

    def test_tokens_reach_docker_only_through_the_environment(self):
        with mock.patch.object(appHost.urllib.request, 'urlopen', return_value=Ready()):
            self.assertEqual(self.run_app(), {'url': 'http://127.0.0.1:40001/view/'})
        run_args, run_env = next((args, env) for args, env in self.commands if args[:2] == ['docker', 'run'])
        flat = ' '.join(arg for args, _ in self.commands for arg in args)
        self.assertNotIn(TOKENS['hostToken'], flat)
        self.assertNotIn(TOKENS['toolToken'], flat)
        self.assertEqual(run_env['HALO_EXTENSION_HOST_TOKEN'], TOKENS['hostToken'])
        self.assertEqual(run_env['HALO_EXTENSION_TOOLS_TOKEN'], TOKENS['toolToken'])
        self.assertIn('HALO_EXTENSION_HOST_TOKEN', run_args)
        for flag in ['--runtime=runsc', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                     'type=bind,src=/src,dst=/app,readonly', 'type=bind,src=/data-volume,dst=/data']:
            self.assertIn(flag, run_args)
        self.assertEqual(self.stopped, [])

    def test_the_broker_rule_is_inserted_only_when_missing(self):
        with mock.patch.object(appHost.urllib.request, 'urlopen', return_value=Ready()):
            self.run_app(iptables_present=False)
            inserted = [args for args, _ in self.commands if args[:2] == ['iptables', '-I']]
            self.assertEqual(len(inserted), 1)
            self.commands.clear()
            self.run_app(iptables_present=True)
            self.assertEqual([args for args, _ in self.commands if args[0] == 'iptables'], [])

    def test_failed_readiness_or_inspection_stops_the_container(self):
        clock = iter(range(0, 1000, 5))
        with mock.patch.object(appHost.urllib.request, 'urlopen', side_effect=OSError('refused')), \
                mock.patch.object(appHost.time, 'monotonic', side_effect=lambda: next(clock)):
            with self.assertRaises(ValueError):
                self.run_app()
        self.assertEqual(self.stopped, ['halo-app-books'])
        with self.assertRaises(RuntimeError):
            self.run_app(inspect=RuntimeError('inspect failed'))
        self.assertEqual(self.stopped, ['halo-app-books', 'halo-app-books'])


class RunBuildTests(unittest.TestCase):
    def test_the_script_reaches_sandboxed_bash_on_stdin_without_live_data(self):
        calls = []

        def run(args, **options):
            calls.append((args, options))
            return subprocess.CompletedProcess(args, 3, stdout='x' * 9000 + 'built')

        stopped = []
        with mock.patch.object(appHost, 'cgroup_parent', return_value='halo-apps.slice'), \
                mock.patch.object(appHost, 'stop', side_effect=lambda name: stopped.append(name)), \
                mock.patch.object(appHost.subprocess, 'run', side_effect=run):
            result = appHost.run_build(name='halo-app-books-build', source=pathlib.Path('/src'),
                                       script='npm run build # $(secret)')
        self.assertEqual(result['exitCode'], 3)
        self.assertEqual(len(result['output']), 8192)
        self.assertTrue(result['output'].endswith('built'))
        args, options = calls[0]
        self.assertTrue(options['input'].endswith('npm run build # $(secret)'))
        self.assertNotIn('npm run build', ' '.join(args))
        self.assertEqual(args[-2:], ['bash', '-l'])
        for flag in ['--runtime=runsc', '--read-only', '--cap-drop=ALL', 'type=bind,src=/src,dst=/app',
                     'type=bind,src=/var/lib/halo/app-sdk,dst=/halo-sdk,readonly']:
            self.assertIn(flag, args)
        self.assertFalse(any('dst=/data' in arg for arg in args))
        self.assertIn('/halo-sdk/get-halo-extension-sdk.tgz', options['input'])
        self.assertEqual(stopped, ['halo-app-books-build'])


class SnapshotFallbackTests(unittest.TestCase):
    def test_before_the_first_start_the_workspace_copy_is_exported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            original = root / 'workspace/.halo/extension-data/books'
            original.mkdir(parents=True)
            (original / 'tandem.json').write_text('{"installed":true}')
            with mock.patch.object(appHost, 'WORKSPACE', root / 'workspace'), \
                    mock.patch.object(appHost, 'DATA', root / 'data'), \
                    mock.patch.object(appHost, 'volume', return_value=None):
                self.assertEqual(appHost.snapshot('books'), {'data': '{"installed":true}'})
                (original / 'tandem.json').unlink()
                self.assertEqual(appHost.snapshot('books'), {})


if __name__ == '__main__':
    unittest.main()
