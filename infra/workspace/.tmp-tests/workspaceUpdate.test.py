import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest
import subprocess
import time
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('workspace_update', pathlib.Path(__file__).parents[1] / 'workspaceUpdate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WorkspaceUpdateTest(unittest.TestCase):
    def setUp(self):
        root = pathlib.Path(__file__).resolve().parents[3] / 'tmp/workspace-updates'
        root.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        (self.root / 'image').write_text('halo-workspace:old')
        self.addCleanup(patch.stopall)
        patch.object(module, 'ROOT', self.root).start()
        patch.object(module, 'STATE', self.root / 'update-state.json').start()
        self.commands, self.reports = [], []
        self.version = '0.1.90'
        self.target = {'image': 'registry.example/halo@sha256:' + 'a' * 64, 'version': '0.1.92'}
        self.activate, self.force, self.busy, self.reserved = True, False, False, False
        self.supported = True
        self.reject_prepare = False
        self.fail_upgrade = False
        self.fail_pull = False
        self.pull_delay = 0
        self.fail_heartbeat = False
        self.request_id = 0
        self.target_swap = None
        self.health_failure = False
        self.fail_cleanup = False
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                if not owner.supported:
                    self.send_response(404); self.end_headers(); return
                self.reply({'version': owner.version, 'busy': owner.busy, 'upgrading': owner.reserved})
            def do_DELETE(self):
                owner.reserved = False
                self.reply({})
            def do_POST(self):
                if self.path == '/maintenance':
                    if owner.reject_prepare or (owner.busy and self.headers.get('x-halo-force-update') != 'true'):
                        self.send_response(409); self.end_headers(); return
                    owner.reserved = True
                    self.reply({})
                    return
                size = int(self.headers.get('content-length', '0'))
                body = json.loads(self.rfile.read(size) or '{}')
                if self.path.endswith('update-token'):
                    self.reply({'token': 'private-reader-token'})
                else:
                    owner.reports.append(body)
                    if owner.fail_heartbeat and body['state'] == 'downloading' and sum(r['state'] == 'downloading' for r in owner.reports) > 1:
                        owner.fail_heartbeat = False
                        self.send_response(503); self.end_headers(); return
                    if owner.version == owner.target['version']:
                        self.reply({})
                    else:
                        self.reply({'target': owner.target, 'activate': owner.activate, 'force': owner.force, 'requestId': owner.request_id})
            def reply(self, value):
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(value).encode())
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.config = {'port': self.server.server_port, 'gateway': {'token': 'private-host-token'},
                       'runtime': {'origin': 'http://127.0.0.1:' + str(self.server.server_port), 'token': 'private-runtime-token'}}
        (self.root / 'workspace-server.json').write_text(json.dumps(self.config))
        def command(args, **kwargs):
            self.commands.append((args, kwargs))
            if args[:3] == ['docker', 'image', 'inspect']:
                return '1024'
            if args[:2] == ['docker', 'inspect']:
                if self.health_failure:
                    raise subprocess.CalledProcessError(1, args)
                return json.dumps(['HALO_BUILD_VERSION=' + self.version])
            if args[:2] == ['docker', 'pull'] and self.fail_pull:
                raise subprocess.CalledProcessError(1, args)
            if args[:2] == ['docker', 'pull']:
                time.sleep(self.pull_delay)
                if self.target_swap:
                    self.target = self.target_swap
            if args[:2] == ['docker', 'rmi'] and args[-1] == 'halo-workspace:old' and self.fail_cleanup:
                raise subprocess.CalledProcessError(1, args)
            if args[0].endswith('halo-workspace-upgrade'):
                if self.fail_upgrade:
                    raise subprocess.CalledProcessError(1, args)
                (self.root / 'image').write_text(args[1])
                if self.health_failure:
                    self.supported = False
                else:
                    self.version = self.target['version']
                    self.supported = True
            return ''
        patch.object(module, 'command', side_effect=command).start()

    def updater(self):
        return module.Updater(self.config)

    def upgrades(self):
        return [args for args, _kwargs in self.commands if args[0].endswith('halo-workspace-upgrade')]

    def test_idle_update_reserves_then_restarts_and_reports_health(self):
        self.updater().run()
        self.assertEqual(len(self.upgrades()), 1)
        self.assertFalse(self.reserved)
        self.assertEqual(self.reports[-1]['state'], 'current')
        self.assertEqual(json.loads(module.STATE.read_text())['previous'], 'halo-workspace:old')
        login = next(kwargs for args, kwargs in self.commands if args[:2] == ['docker', 'login'])
        self.assertEqual(login['input'], 'private-reader-token')
        self.assertFalse(pathlib.Path(login['env']['DOCKER_CONFIG']).exists())

    def test_busy_workspace_downloads_without_restarting(self):
        self.busy = True
        self.activate = False
        self.updater().run()
        self.assertFalse(self.upgrades())
        self.assertEqual(self.reports[-1]['state'], 'ready')

    def test_latest_pending_image_replaces_the_older_prepared_image(self):
        self.activate = False
        self.updater().run()
        old = 'halo-workspace:' + 'a' * 64
        self.target = {'image': 'registry.example/halo@sha256:' + 'b' * 64, 'version': '0.1.93'}
        self.updater().run()
        self.assertIn(['docker', 'rmi', old], [args for args, _kwargs in self.commands])
        self.assertFalse(self.upgrades())
        self.assertEqual(json.loads(module.STATE.read_text())['targetVersion'], '0.1.93')

    def test_last_moment_busy_reservation_refuses_to_restart(self):
        self.reject_prepare = True
        self.updater().run()
        self.assertFalse(self.upgrades())
        self.assertFalse(self.reserved)

    def test_explicit_confirmation_allows_interruption(self):
        self.busy = True
        self.force = True
        self.updater().run()
        self.assertEqual(len(self.upgrades()), 1)

    def test_unknown_older_server_requires_explicit_confirmation(self):
        self.supported = False
        self.updater().run()
        self.assertFalse(self.upgrades())
        self.force = True
        self.updater().run()
        self.assertEqual(len(self.upgrades()), 1)

    def test_failed_restart_releases_reservation_and_persists_a_retry(self):
        self.fail_upgrade = True
        module.main()
        self.assertFalse(self.reserved)
        self.assertEqual(self.reports[-1]['state'], 'failed')
        previous = len(self.commands)
        module.main()
        self.assertEqual(len(self.commands), previous)

    def test_download_failure_preserves_running_server(self):
        self.fail_pull = True
        module.main()
        self.assertFalse(self.upgrades())
        self.assertEqual(self.reports[-1]['state'], 'failed')

    def test_unassigned_and_shared_app_hosts_do_not_upgrade(self):
        (self.root / 'workspace-server.json').unlink()
        module.main()
        (self.root / 'workspace-server.json').write_text(json.dumps({**self.config, 'sharedApp': {}}))
        module.main()
        self.assertFalse(self.commands)

    def test_current_workspace_does_not_download_or_restart(self):
        self.version = self.target['version']
        self.updater().run()
        self.assertFalse(self.commands)
        self.assertEqual(self.reports[-1]['state'], 'current')

    def test_a_new_manual_request_retries_a_failed_download_immediately(self):
        self.fail_pull = True
        module.main()
        self.fail_pull = False
        self.request_id = int(time.time() * 1000)
        module.main()
        self.assertEqual(len(self.upgrades()), 1)
        self.assertEqual(self.reports[-1]['state'], 'current')

    def test_superseded_download_waits_for_the_newest_release(self):
        self.target_swap = {'image': 'registry.example/halo@sha256:' + 'b' * 64, 'version': '0.1.93'}
        self.updater().run()
        self.assertFalse(self.upgrades())
        self.target_swap = None
        self.updater().run()
        self.assertEqual(len(self.upgrades()), 1)
        self.assertEqual(self.version, '0.1.93')

    def test_missing_disk_space_and_unpinned_images_preserve_running_work(self):
        with patch.object(module.os, 'statvfs', return_value=SimpleNamespace(f_bfree=0, f_frsize=4096)):
            module.main()
        self.assertFalse(self.upgrades())
        self.target = {'image': 'registry.example/halo:latest', 'version': '0.1.93'}
        self.request_id = int(time.time() * 1000)
        module.main()
        self.assertFalse(self.upgrades())
        self.assertEqual(self.reports[-1]['state'], 'failed')

    def test_download_heartbeats_recover_after_a_transient_report_failure(self):
        self.pull_delay = 20.2
        self.fail_heartbeat = True
        self.updater().run()
        self.assertFalse(self.fail_heartbeat)
        self.assertGreaterEqual(sum(r['state'] == 'downloading' for r in self.reports), 3)
        self.assertEqual(self.reports[-1]['state'], 'current')

    def test_health_failure_releases_maintenance_and_reports_failure(self):
        self.health_failure = True
        with patch.object(module.time, 'monotonic', side_effect=[0, 1, 61]):
            module.main()
        self.assertFalse(self.reserved)
        self.assertEqual(self.reports[-1]['state'], 'failed')

    def test_success_keeps_one_previous_image_even_when_cleanup_fails(self):
        self.updater().run()
        self.target = {'image': 'registry.example/halo@sha256:' + 'b' * 64, 'version': '0.1.93'}
        self.fail_cleanup = True
        self.updater().run()
        self.assertEqual(self.reports[-1]['state'], 'current')
        self.assertIn(['docker', 'rmi', 'halo-workspace:old'], [args for args, _ in self.commands])

    def test_only_one_updater_runs_and_non_runtime_hosts_are_skipped(self):
        with patch.object(module.fcntl, 'flock', side_effect=BlockingIOError):
            module.main()
        (self.root / 'workspace-server.json').write_text('{}')
        module.main()
        self.assertFalse(self.commands)
