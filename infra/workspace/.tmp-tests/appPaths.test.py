import contextlib
import http.client
import json
import socket
import threading
import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'infra/workspace'))
import appPaths
import appHost


class AppPathsTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / 'tmp/extension-sharing'
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.workspace = self.root / 'workspace'
        self.source = self.workspace / '.halo/extensions/books'
        self.source.mkdir(parents=True)
        (self.source / 'dist').mkdir()
        (self.source / 'dist/start.mjs').write_text('start')
        self.original = self.workspace / '.halo/extension-data/books'
        self.original.mkdir(parents=True)
        self.secret = self.root / 'private-secret'
        self.secret.write_text('must not be exported')
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(appHost, 'WORKSPACE', self.workspace))
        self.stack.enter_context(mock.patch.object(appHost, 'DATA', self.root / 'data'))
        self.stack.enter_context(mock.patch.object(appHost, 'command', return_value=''))

    def test_under_keeps_request_values_below_their_root(self):
        root = self.root / 'data'
        self.assertEqual(appPaths.under(root, 'books', 'source'), root / 'books/source')
        for parts in [('..',), ('books', '../../etc'), ('/etc',), ('',)]:
            with self.assertRaises(ValueError):
                appPaths.under(root, *parts)

    def test_open_regular_file_and_reject_non_regular_or_missing_files(self):
        with appPaths.regular_file(self.secret) as source:
            self.assertEqual(source.read(), b'must not be exported')
        with self.assertRaises(FileNotFoundError):
            with appPaths.regular_file(self.root / 'missing'):
                pass
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError):
            with appPaths.regular_file(fifo):
                pass
        with self.assertRaises(ValueError):
            with appPaths.directory('relative'):
                pass

    def test_every_workspace_directory_component_rejects_symlinks(self):
        for relative in ['.halo', '.halo/extensions', '.halo/extensions/books', '.halo/extensions/books/dist']:
            component = self.workspace / relative
            saved = component.with_name(component.name + '-saved')
            component.rename(saved)
            component.symlink_to(saved, target_is_directory=True)
            with self.assertRaises(OSError):
                appHost.start(self.input())
            if not relative.endswith('/dist'):
                with self.assertRaises(OSError):
                    appHost.execute({'extensionId': 'books', 'command': 'echo x'})
            component.unlink()
            saved.rename(component)

    def test_import_does_not_follow_file_or_parent_symlinks(self):
        # A valid source mount reaches import validation without any Docker call.
        self.stack.enter_context(mock.patch.object(appHost, 'source_mount', return_value=self.source))
        self.stack.enter_context(mock.patch.object(appHost, 'volume', return_value=self.root / 'volume'))
        (self.root / 'volume').mkdir()
        (self.root / 'data/books').mkdir(parents=True)
        file = self.original / 'tandem.json'
        file.symlink_to(self.secret)
        with self.assertRaises(OSError):
            appHost.start(self.input())
        file.unlink()
        for component in [self.workspace / '.halo/extension-data', self.original]:
            saved = component.with_name(component.name + '-saved')
            component.rename(saved)
            component.symlink_to(saved, target_is_directory=True)
            with self.assertRaises(OSError):
                appHost.start(self.input())
            component.unlink()
            saved.rename(component)
        self.assertFalse((self.root / 'volume/tandem.json').exists())

    def test_source_mount_uses_an_open_descriptor_not_a_mutable_workspace_path(self):
        commands = []
        with mock.patch.object(appHost, 'command', side_effect=lambda args: commands.append(args) or ''):
            target = appHost.source_mount('books')
        self.assertEqual(target, self.root / 'data/books/source')
        self.assertEqual(commands[0][:2], ['mount', '--bind'])
        self.assertTrue(commands[0][2].startswith(f'/proc/{os.getpid()}/fd/'))
        # A remount replaces the previous pinned source instead of stacking mounts.
        with mock.patch.object(appHost.os.path, 'ismount', return_value=True):
            with mock.patch.object(appHost, 'command', side_effect=lambda args: commands.append(args) or ''):
                appHost.source_mount('books')
        self.assertEqual(commands[1], ['umount', str(target)])

    def test_start_input_rejects_invalid_identity_ports_access_and_credentials(self):
        self.assertEqual(appHost.start_input(self.input()), 'halo-app-books')
        for change in [{'extensionId': '../books'}, {'extensionId': None}, {'brokerPort': 0}, {'brokerPort': '8788'},
                       {'brokerPort': True}, {'syncAccess': 'admin'}, {'hostToken': 'short'}, {'toolToken': None}]:
            with self.assertRaises(ValueError):
                appHost.start_input({**self.input(), **change})

    def test_import_copies_regular_data_once_and_bounds_its_size(self):
        self.stack.enter_context(mock.patch.object(appHost, 'source_mount', return_value=self.source))
        volume = self.root / 'volume'
        volume.mkdir()
        self.stack.enter_context(mock.patch.object(appHost, 'volume', return_value=volume))
        self.stack.enter_context(mock.patch.object(appHost, 'run_app', return_value={'url': 'ok'}))
        (self.root / 'data/books').mkdir(parents=True)
        (self.original / 'tandem.json').write_text('{"records":1}')
        self.assertEqual(appHost.start(self.input()), {'url': 'ok'})
        self.assertEqual((volume / 'tandem.json').read_text(), '{"records":1}')
        # The import marker prevents a later workspace file from replacing live data.
        (self.original / 'tandem.json').write_text('stale')
        appHost.start(self.input())
        self.assertEqual((volume / 'tandem.json').read_text(), '{"records":1}')
        (self.root / 'data/books/imported').unlink()
        (volume / 'tandem.json').unlink()
        (self.original / 'tandem.json').unlink()
        appHost.start(self.input())
        self.assertFalse((volume / 'tandem.json').exists())
        (self.root / 'data/books/imported').unlink()
        with open(self.original / 'tandem.json', 'wb') as large:
            large.truncate(appHost.MAX_DATA + 1)
        with self.assertRaises(ValueError):
            appHost.start(self.input())
        self.assertFalse((volume / 'tandem.json').exists())
        with mock.patch.object(appHost, 'command', return_value='a\nb\nc\nd'):
            with self.assertRaises(ValueError):
                appHost.start(self.input())

    def test_snapshot_mounts_before_reading_and_never_follows_guest_links(self):
        volume = self.root / 'volume'
        calls = []
        def mounted(directory, create=True):
            calls.append((directory, create))
            if not (self.root / 'data/books/data.ext4').exists():
                return None
            volume.mkdir(exist_ok=True)
            return volume
        self.stack.enter_context(mock.patch.object(appHost, 'volume', side_effect=mounted))
        self.assertEqual(appHost.snapshot('books'), {})
        self.assertEqual(calls, [(self.root / 'data/books', False)])
        (self.root / 'data/books').mkdir(parents=True)
        (self.root / 'data/books/data.ext4').write_text('image')
        self.assertEqual(appHost.snapshot('books'), {})
        (volume / 'tandem.json').write_text('{"live":true}')
        self.assertEqual(appHost.snapshot('books'), {'data': '{"live":true}'})
        (volume / 'tandem.json').unlink()
        (volume / 'tandem.json').symlink_to(self.secret)
        with self.assertRaises(OSError):
            appHost.snapshot('books')
        (volume / 'tandem.json').unlink()
        os.mkfifo(volume / 'tandem.json')
        with self.assertRaises(ValueError):
            appHost.snapshot('books')
        (volume / 'tandem.json').unlink()
        with open(volume / 'tandem.json', 'wb') as large:
            large.truncate(appHost.MAX_DATA + 1)
        with self.assertRaises(ValueError):
            appHost.snapshot('books')
        with self.assertRaises(ValueError):
            appHost.snapshot('../books')

    def test_demo_instances_have_separate_names_volumes_and_reset(self):
        self.assertEqual(appHost.slot('books', 'abcdef012345'), ('halo-app-books--abcdef012345', self.root / 'data/books/instances/abcdef012345'))
        for instance in ['../x', 'ABCDEF012345', 'abc', 7]:
            with self.assertRaises(ValueError):
                appHost.slot('books', instance)
        self.stack.enter_context(mock.patch.object(appHost, 'source_mount', return_value=self.source))
        volumes = []
        def volume(directory, create=True, size='128M'):
            volumes.append((directory, size))
            target = directory / 'data'
            target.mkdir(parents=True, exist_ok=True)
            return target
        self.stack.enter_context(mock.patch.object(appHost, 'volume', side_effect=volume))
        started = self.stack.enter_context(mock.patch.object(appHost, 'run_app', return_value={'url': 'ok'}))
        (self.original / 'tandem.json').write_text('{"sample":true}')
        appHost.start({**self.input(), 'instance': 'abcdef012345'})
        self.assertEqual(volumes, [(self.root / 'data/books/instances/abcdef012345', '32M')])
        self.assertEqual(started.call_args.kwargs['name'], 'halo-app-books--abcdef012345')
        self.assertEqual((self.root / 'data/books/instances/abcdef012345/data/tandem.json').read_text(), '{"sample":true}')
        with self.assertRaises(ValueError):
            appHost.start({**self.input(), 'instance': '../../escape'})

    def test_reset_stops_and_discards_every_instance_including_orphans(self):
        instances = self.root / 'data/books/instances'
        (instances / 'abcdef012345').mkdir(parents=True)
        (instances / 'not-an-instance').mkdir()
        listed = []
        def command(args, timeout=30):
            listed.append(args)
            return 'halo-app-books--0123456789ab\nhalo-app-books--abcdef012345\nhalo-app-booksx\n'
        self.stack.enter_context(mock.patch.object(appHost, 'command', side_effect=command))
        stopped = self.stack.enter_context(mock.patch.object(appHost, 'stop'))
        discarded = self.stack.enter_context(mock.patch.object(appHost, 'discard'))
        self.assertEqual(appHost.reset('books'), {'reset': True})
        self.assertEqual(listed[0][-1], 'name=^/halo-app-books--')
        self.assertEqual([call.args[0] for call in stopped.call_args_list], ['halo-app-books--0123456789ab', 'halo-app-books--abcdef012345'])
        self.assertEqual([call.args[0] for call in discarded.call_args_list], [instances / '0123456789ab', instances / 'abcdef012345'])
        with self.assertRaises(ValueError):
            appHost.reset('../x')

    def test_read_limited_rejects_growth_after_stat(self):
        class Growing:
            def fileno(self):
                return os.open(os.devnull, os.O_RDONLY)
            def read(self, size):
                return b'x' * size
        with self.assertRaises(ValueError):
            appHost.read_limited(Growing())

    def test_execute_validates_command_before_mounting_source(self):
        self.stack.enter_context(mock.patch.object(appHost, 'run_build', return_value={'exitCode': 0}))
        mounted = self.stack.enter_context(mock.patch.object(appHost, 'source_mount', return_value=self.source))
        for script in [None, 'x' * 8193]:
            with self.assertRaises(ValueError):
                appHost.execute({'extensionId': 'books', 'command': script})
        mounted.assert_not_called()
        self.assertEqual(appHost.execute({'extensionId': 'books', 'command': 'npm run build'}), {'exitCode': 0})

    def test_unix_socket_handler_bounds_requests_and_dispatches_operations(self):
        path = str(self.root / 'control.sock')
        server = appHost.Server(path, appHost.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        def post(route, body=None, raw=None):
            connection = http.client.HTTPConnection('halo-apps')
            connection.sock = socket.socket(socket.AF_UNIX)
            connection.sock.connect(path)
            payload = raw if raw is not None else json.dumps(body).encode()
            connection.request('POST', route, payload, {'Content-Length': str(len(payload))})
            response = connection.getresponse()
            result = (response.status, json.loads(response.read()))
            connection.close()
            return result
        self.stack.enter_context(mock.patch.object(appHost, 'start', return_value={'url': 'started'}))
        self.stack.enter_context(mock.patch.object(appHost, 'execute', return_value={'exitCode': 0}))
        self.stack.enter_context(mock.patch.object(appHost, 'snapshot', return_value={'data': 'x'}))
        stopped = self.stack.enter_context(mock.patch.object(appHost, 'stop'))
        discarded = self.stack.enter_context(mock.patch.object(appHost, 'discard'))
        self.stack.enter_context(mock.patch.object(appHost, 'command', return_value='abc'))
        self.assertEqual(post('/start', {'extensionId': 'books'}), (200, {'url': 'started'}))
        self.assertEqual(post('/stop', {'extensionId': 'books'}), (200, {'stopped': True}))
        discarded.assert_not_called()
        self.assertEqual(post('/stop', {'extensionId': 'books', 'instance': 'abcdef012345'}), (200, {'stopped': True}))
        stopped.assert_called_with('halo-app-books--abcdef012345')
        discarded.assert_called_once_with(self.root / 'data/books/instances/abcdef012345')
        self.assertEqual(post('/stop', {'extensionId': 'books', 'instance': '../..'})[0], 400)
        self.assertEqual(post('/exec', {'extensionId': 'books'}), (200, {'exitCode': 0}))
        self.assertEqual(post('/snapshot', {'extensionId': 'books'}), (200, {'data': 'x'}))
        self.assertEqual(post('/reset', {'extensionId': 'books'}), (200, {'reset': True}))
        self.assertEqual(post('/status', {'extensionId': 'books'}), (200, {'running': True}))
        self.assertEqual(post('/delete', {'extensionId': 'books'})[0], 400)
        self.assertEqual(post('/start', {'extensionId': '../x'})[0], 400)
        self.assertEqual(post('/start', ['books'])[0], 400)
        self.assertEqual(post('/start', raw=b'')[0], 400)
        self.assertEqual(post('/start', raw=b'x' * 16385)[0], 400)

    def input(self):
        return {'extensionId': 'books', 'brokerPort': 8788, 'syncAccess': 'actions', 'hostToken': 'h' * 32, 'toolToken': 't' * 32}
