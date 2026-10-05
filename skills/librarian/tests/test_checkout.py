"""Run with: python3 -m unittest discover -s tests -v.

All remotes resolve to disposable local Git repositories. Unmapped network
transports are disabled, and the user's Git configuration is never read.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HELPER = Path(__file__).resolve().parents[1] / 'checkout.sh'


class CheckoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='librarian-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.cache = self.root / "cache with space's"
        self.seed = self.root / 'seed'
        self.remote = self.root / 'remote.git'
        self.config = self.root / 'gitconfig'
        self.config.touch()
        self.trace = self.root / 'git-trace'
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('GIT_', 'LIBRARIAN_'))}
        self.env.update({
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': str(self.config),
            'GIT_TERMINAL_PROMPT': '0',
            'GIT_ALLOW_PROTOCOL': 'file',
            'GIT_AUTHOR_NAME': 'Synthetic Librarian Test',
            'GIT_AUTHOR_EMAIL': 'librarian@example.invalid',
            'GIT_COMMITTER_NAME': 'Synthetic Librarian Test',
            'GIT_COMMITTER_EMAIL': 'librarian@example.invalid',
            'LIBRARIAN_CACHE_ROOT': str(self.cache),
        })
        self.git('init', '--bare', '--initial-branch=main', self.remote)
        self.git('init', '--initial-branch=main', self.seed)
        (self.seed / 'file.txt').write_text('first\n')
        self.git('-C', self.seed, 'add', '.')
        self.git('-C', self.seed, 'commit', '-m', 'synthetic initial commit')
        self.git('-C', self.seed, 'remote', 'add', 'origin', self.remote)
        self.git('-C', self.seed, 'push', '-u', 'origin', 'main')
        self.url = 'https://git.example.test/team/repo.git'
        self.map_url(self.url)

    def git(self, *args, check=True):
        return subprocess.run(['git', *map(str, args)], env=self.env,
                              capture_output=True, text=True, check=check)

    def map_url(self, url):
        self.git('config', '--file', self.config, '--add',
                 f'url.{self.remote.as_uri()}.insteadOf', url)

    def run_helper(self, *args, success=True, env=None):
        child_env = dict(self.env, GIT_TRACE=str(self.trace))
        if env:
            child_env.update(env)
        result = subprocess.run(['bash', str(HELPER), *args], cwd=self.root,
                                env=child_env, capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(result.stdout, '', result.stdout)
        return result

    def checkout(self):
        result = self.run_helper(self.url, '--path-only')
        path = Path(result.stdout.strip())
        self.assertEqual(path, self.cache / 'git.example.test/team/repo')
        return path

    def revision(self, path):
        return self.git('-C', path, 'rev-parse', 'HEAD').stdout.strip()

    def push_change(self):
        (self.seed / 'file.txt').write_text('second\n')
        self.git('-C', self.seed, 'commit', '-am', 'synthetic remote advance')
        self.git('-C', self.seed, 'push')
        return self.revision(self.seed)

    def test_invalid_inputs_do_not_create_cache_or_run_git(self):
        invalid = [
            'https://github.com/../../outside',
            'https://github.com/team/../outside',
            'https://github.com/team/repo/tree/../../outside',
            'https://github.com/team/%2e%2e/outside',
            'https://github.com/team//repo',
            'https://github.com/team/repo//',
            'https://github.com/team/.git',
            'https://github.com/team/...git',
            'https://github.com', 'single', '',
            'https://../team/repo', 'https://-bad.test/team/repo',
            'https://host:99999/team/repo', 'https://host:abc/team/repo',
            'https://user:secret@host/team/repo',
            'git@host:team/../../outside', 'git@host:/team/repo',
            'ssh://git@host:22', 'file:///tmp/team/repo',
            'https://host/team/repo\nextra', '--bogus',
        ]
        for reference in invalid:
            with self.subTest(reference=reference):
                self.run_helper(reference, '--path-only', success=False)
                self.assertFalse(self.cache.exists())
                self.assertFalse(self.trace.exists())
        self.run_helper('team/repo', '--path-only', success=False,
                        env={'LIBRARIAN_DEFAULT_HOST': '../../outside'})
        self.assertFalse(self.cache.exists())
        self.assertFalse(self.trace.exists())

    def test_rejects_missing_arguments_and_invalid_intervals(self):
        for args in [(), ('--path-only',), (self.url, '--update-interval'),
                     (self.url, '--update-interval', 'nonsense'),
                     (self.url, '--update-interval', '-1'),
                     (self.url, '--update-interval', '9999999999999999')]:
            with self.subTest(args=args):
                self.run_helper(*args, success=False)
        self.assertFalse(self.cache.exists())
        self.run_helper(self.url, '--update-interval', '0008', '--path-only')

    def test_clone_preserves_supported_transports_and_repository_paths(self):
        cases = [
            ('https://git.example.test/team/repo.git', 'https://git.example.test/team/repo.git', 'git.example.test/team/repo'),
            ('http://git.example.test/team/repo', 'http://git.example.test/team/repo', 'git.example.test/team/repo'),
            ('git@git.example.test:team/repo.git', 'git@git.example.test:team/repo.git', 'git.example.test/team/repo'),
            ('alice@git.example.test:team/repo', 'alice@git.example.test:team/repo', 'git.example.test/team/repo'),
            ('ssh://alice@git.example.test:2222/team/repo.git', 'ssh://alice@git.example.test:2222/team/repo.git', 'git.example.test:2222/team/repo'),
            ('git.example.test/team/sub/repo', 'https://git.example.test/team/sub/repo.git', 'git.example.test/team/sub/repo'),
            ('https://git.example.test/team/repo/issues/nested.git', 'https://git.example.test/team/repo/issues/nested.git', 'git.example.test/team/repo/issues/nested'),
            ('team/repo', 'https://github.com/team/repo.git', 'github.com/team/repo'),
            ('https://github.com/team/repo/tree/main/src?view=1#anchor', 'https://github.com/team/repo', 'github.com/team/repo'),
        ]
        for index, (reference, origin, key) in enumerate(cases):
            with self.subTest(reference=reference):
                self.map_url(origin)
                cache = self.root / f'case-{index}'
                result = self.run_helper(reference, '--path-only',
                                         env={'LIBRARIAN_CACHE_ROOT': str(cache)})
                checkout = Path(result.stdout.strip())
                self.assertEqual(checkout, cache / key)
                configured = self.git('-C', checkout, 'config', '--get', 'remote.origin.url').stdout.strip()
                self.assertEqual(configured, origin)
                self.assertEqual(self.revision(checkout), self.revision(self.seed))

    def test_existing_ssh_origin_is_preserved_for_https_request(self):
        checkout = self.checkout()
        ssh_url = 'alice@git.example.test:team/repo.git'
        self.map_url(ssh_url)
        self.git('-C', checkout, 'remote', 'set-url', 'origin', ssh_url)
        latest = self.push_change()
        self.run_helper(self.url, '--force-update', '--path-only')
        self.assertEqual(self.revision(checkout), latest)
        self.assertEqual(self.git('-C', checkout, 'config', '--get', 'remote.origin.url').stdout.strip(), ssh_url)

    def test_mismatched_missing_or_multiple_origins_stop_before_fetch(self):
        checkout = self.checkout()
        before = self.revision(checkout)
        for origins in [('https://elsewhere.test/team/repo.git',), (),
                        (self.url, 'https://elsewhere.test/team/repo.git')]:
            with self.subTest(origins=origins):
                self.git('-C', checkout, 'config', '--unset-all', 'remote.origin.url', check=False)
                for origin in origins:
                    self.git('-C', checkout, 'config', '--add', 'remote.origin.url', origin)
                self.trace.unlink(missing_ok=True)
                self.run_helper(self.url, '--force-update', '--path-only', success=False)
                configured = self.git('-C', checkout, 'config', '--get-all', 'remote.origin.url', check=False).stdout.splitlines()
                self.assertEqual(configured, list(origins))
                self.assertNotIn(' fetch ', self.trace.read_text())
                self.assertEqual(self.revision(checkout), before)

    def test_symlink_escape_and_dangling_symlink_are_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        for component in ['git.example.test', 'git.example.test/team', 'git.example.test/team/repo']:
            for target in [outside, self.root / 'does-not-exist']:
                with self.subTest(component=component, target=target):
                    if self.cache.exists():
                        shutil.rmtree(self.cache)
                    link = self.cache / component
                    link.parent.mkdir(parents=True)
                    link.symlink_to(target, target_is_directory=True)
                    self.run_helper(self.url, '--path-only', success=False)
                    self.assertEqual(list(outside.iterdir()), [])
                    self.assertFalse(self.trace.exists())

    def test_cache_root_symlink_is_allowed(self):
        physical = self.root / 'physical-cache'
        physical.mkdir()
        self.cache.symlink_to(physical, target_is_directory=True)
        result = self.run_helper(self.url, '--path-only')
        self.assertEqual(Path(result.stdout.strip()), physical / 'git.example.test/team/repo')

    def test_force_refresh_advances_and_ordinary_reuse_is_throttled(self):
        checkout = self.checkout()
        original = self.revision(checkout)
        latest = self.push_change()
        self.trace.unlink()
        self.run_helper(self.url, '--update-interval', '3600', '--path-only')
        self.assertNotIn(' fetch ', self.trace.read_text())
        self.assertEqual(self.revision(checkout), original)
        result = self.run_helper(self.url, '--force-update')
        self.assertIn('fast_forward: fast-forwarded', result.stdout)
        self.assertEqual(self.revision(checkout), latest)
        result = self.run_helper(self.url, '--force-update')
        self.assertIn('fast_forward: up-to-date', result.stdout)

    def test_dirty_tracked_staged_and_untracked_files_block_force(self):
        checkout = self.checkout()
        original = self.revision(checkout)
        self.push_change()
        stamp = checkout / '.git/librarian-last-fetch'
        before_stamp = stamp.read_bytes()
        for state in ['tracked', 'staged', 'untracked']:
            with self.subTest(state=state):
                target = checkout / ('untracked.txt' if state == 'untracked' else 'file.txt')
                target.write_text('keep this local work\n')
                if state == 'staged':
                    self.git('-C', checkout, 'add', 'file.txt')
                result = self.run_helper(self.url, '--force-update', '--path-only', success=False)
                self.assertIn('skipped-dirty', result.stderr)
                self.assertEqual(target.read_text(), 'keep this local work\n')
                self.assertEqual(self.revision(checkout), original)
                self.assertEqual(stamp.read_bytes(), before_stamp)
                self.git('-C', checkout, 'reset', '--hard', original)
                if state == 'untracked':
                    target.unlink()

    def test_detached_and_missing_or_other_upstream_block_force(self):
        checkout = self.checkout()
        original = self.revision(checkout)
        self.git('-C', checkout, 'checkout', '--detach')
        result = self.run_helper(self.url, '--force-update', '--path-only', success=False)
        self.assertIn('skipped-detached', result.stderr)
        self.git('-C', checkout, 'checkout', 'main')
        self.git('-C', checkout, 'branch', '--unset-upstream')
        result = self.run_helper(self.url, '--force-update', '--path-only', success=False)
        self.assertIn('skipped-no-upstream', result.stderr)
        self.git('-C', checkout, 'config', 'branch.main.remote', '.')
        self.git('-C', checkout, 'config', 'branch.main.merge', 'refs/heads/main')
        result = self.run_helper(self.url, '--force-update', '--path-only', success=False)
        self.assertIn('skipped-upstream-not-origin', result.stderr)
        self.assertEqual(self.revision(checkout), original)

    def test_ahead_and_divergent_branches_are_preserved_and_rejected(self):
        checkout = self.checkout()
        (checkout / 'local.txt').write_text('local commit\n')
        self.git('-C', checkout, 'add', '.')
        self.git('-C', checkout, 'commit', '-m', 'synthetic local commit')
        local_head = self.revision(checkout)
        for state in ['ahead', 'divergent']:
            with self.subTest(state=state):
                if state == 'divergent':
                    self.push_change()
                result = self.run_helper(self.url, '--force-update', '--path-only', success=False)
                self.assertIn('skipped-non-ff', result.stderr)
                self.assertEqual(self.revision(checkout), local_head)
                self.assertEqual((checkout / 'local.txt').read_text(), 'local commit\n')
        result = self.run_helper(self.url, '--update-interval', '0', '--path-only')
        self.assertEqual(result.stdout.strip(), str(checkout))
        self.assertIn('warning: using cached revision', result.stderr)

    def test_fetch_failure_does_not_report_success_or_mark_fresh(self):
        checkout = self.checkout()
        stamp = checkout / '.git/librarian-last-fetch'
        before = stamp.read_bytes()
        self.remote.rename(self.root / 'unavailable.git')
        result = self.run_helper(self.url, '--force-update', '--path-only', success=False)
        self.assertIn('origin fetch failed', result.stderr)
        self.assertEqual(stamp.read_bytes(), before)

    def test_excluded_upstream_cannot_silently_satisfy_force(self):
        checkout = self.checkout()
        latest = self.push_change()
        # A successful general fetch can leave origin/main stale when a local
        # negative refspec excludes it. Force must obtain main or report failure.
        for exclusion in ['^refs/heads/main', '^refs/heads/m*']:
            with self.subTest(exclusion=exclusion):
                self.git('-C', checkout, 'config', '--unset-all', 'remote.origin.fetch')
                self.git('-C', checkout, 'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
                self.git('-C', checkout, 'config', '--add', 'remote.origin.fetch', exclusion)
                result = subprocess.run(['bash', str(HELPER), self.url, '--force-update', '--path-only'],
                                        cwd=self.root, env=self.env, capture_output=True, text=True)
                if result.returncode == 0:
                    self.assertEqual(self.revision(checkout), latest)
                else:
                    self.assertEqual(result.stdout, '')

    def test_git_directory_and_timestamp_symlinks_are_rejected(self):
        checkout = self.checkout()
        stamp = checkout / '.git/librarian-last-fetch'
        outside = self.root / 'keep.txt'
        outside.write_text('keep\n')
        stamp.unlink()
        stamp.symlink_to(outside)
        self.run_helper(self.url, '--force-update', '--path-only', success=False)
        self.assertEqual(outside.read_text(), 'keep\n')
        stamp.unlink()
        outside_git = self.root / 'outside-git'
        (checkout / '.git').rename(outside_git)
        (checkout / '.git').symlink_to(outside_git, target_is_directory=True)
        self.run_helper(self.url, '--force-update', '--path-only', success=False)


if __name__ == '__main__':
    unittest.main()
