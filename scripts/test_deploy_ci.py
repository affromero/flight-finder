"""Exercise the runner-local staging entrypoint at Docker and HTTP boundaries."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
SHA = 'a' * 40
IMAGE = 'sha256:' + 'b' * 64
BOUNDARY = '''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
with open(os.environ['BOUNDARY_LOG'], 'a') as stream:
    stream.write(json.dumps({'command': name, 'args': args, 'image': os.environ.get('FLIGHT_FINDER_TEST_IMAGE')}) + '\\n')
if name == 'docker':
    if args[:2] == ['context', 'inspect']: print(os.environ.get('TEST_CONTEXT', 'unix:///var/run/docker.sock'))
    elif args[:2] == ['image', 'inspect']: print(os.environ['TEST_REVISION'])
    elif args[-2:] == ['access', 'setup']:
        for prompt in ('First Admin profile name: ', 'Shared password: ', 'Confirm shared password: '):
            print(prompt, end='', flush=True)
            if not sys.stdin.readline(): sys.exit(1)
elif name == 'curl':
    url = next((v for v in args if v.startswith('http')), '')
    if '%{http_code}' in args: print('200')
    elif url.endswith('/api/health'): print(json.dumps({'status':'ok', 'database':'connected', 'redis':'connected'}))
    elif url.endswith('/api/version'): print(json.dumps({'data':{'commit':os.environ['TEST_LIVE_SHA']}}))
    elif url.endswith('/api/admin/providers'): print(json.dumps({'ok':True,'data':{'ollama':{'status':'unreachable'}}}))
    elif url.endswith('/api/admin/config'):
        print(json.dumps({'ok':not any('TOOLONG' in v for v in args),'data':{'defaultCurrency':'EUR','defaultCountry':'DE'}}))
    else: print('<html>Flight Finder</html>')
'''


class StagingSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / 'commands.jsonl'
        for name in ('docker', 'curl'):
            path = self.root / name
            path.write_text(BOUNDARY)
            path.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ['PATH'],
                        BOUNDARY_LOG=str(self.log), FLIGHT_FINDER_DISPOSABLE_DOCKER='1',
                        TEST_REVISION=SHA, TEST_LIVE_SHA=SHA, GITHUB_ACTIONS='', DOCKER_HOST='')

    def execute(self, image=IMAGE, sha=SHA, *args):
        return subprocess.run(['bash', 'scripts/staging-test.sh', image, sha, *args],
                              cwd=ROOT, env=self.env, text=True, capture_output=True, timeout=20)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_disposable_daemon_requires_explicit_opt_in(self):
        self.env['FLIGHT_FINDER_DISPOSABLE_DOCKER'] = ''
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('disposable', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_mutable_images_and_short_commits_are_rejected_without_docker(self):
        for image, sha in [('example:latest', SHA), (IMAGE, SHA[:7])]:
            with self.subTest(image=image, sha=sha):
                self.assertNotEqual(self.execute(image, sha).returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_remote_docker_host_is_rejected(self):
        self.env['DOCKER_HOST'] = 'ssh://example'
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_remote_context_cannot_start_containers(self):
        self.env['TEST_CONTEXT'] = 'tcp://example:2376'
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertFalse(any(c['args'][0] == 'compose' for c in self.calls()))

    def test_wrong_revision_cannot_start_containers(self):
        self.env['TEST_REVISION'] = 'c' * 40
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('revision', result.stderr)
        self.assertFalse(any(c['args'][0] == 'compose' for c in self.calls()))

    def test_success_uses_the_exact_image_and_cleans_only_its_test_project(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('identity and integration checks passed', result.stdout)
        compose = [c for c in self.calls() if c['command'] == 'docker' and c['args'][0] == 'compose']
        self.assertTrue(any('up' in c['args'] for c in compose))
        self.assertTrue(any('down' in c['args'] for c in compose))
        for call in compose:
            self.assertEqual(call['image'], IMAGE)
            self.assertIn('flight-finder-integration-test', call['args'])
        self.assertFalse(any('prune' in c['args'] or 'build' in c['args'] for c in self.calls()))

    def test_wrong_running_commit_fails_and_cleans_up_even_with_keep_alive(self):
        self.env['TEST_LIVE_SHA'] = 'd' * 40
        result = self.execute(IMAGE, SHA, '--keep-alive')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Running commit mismatch', result.stderr)
        self.assertTrue(any('down' in c['args'] for c in self.calls()))


if __name__ == '__main__':
    unittest.main()
