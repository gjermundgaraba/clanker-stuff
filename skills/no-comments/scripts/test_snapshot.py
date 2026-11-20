"""Run with: python3 -m unittest discover -s scripts -v."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


HELPER = Path(__file__).resolve().parent / 'snapshot.sh'


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='no-comments-test-')
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name).resolve()
        self.repo = self.temp / 'repo'
        config = self.temp / 'gitconfig'
        config.touch()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        self.env.update({
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': str(config),
            'GIT_AUTHOR_NAME': 'Synthetic Test',
            'GIT_AUTHOR_EMAIL': 'test@example.invalid',
            'GIT_COMMITTER_NAME': 'Synthetic Test',
            'GIT_COMMITTER_EMAIL': 'test@example.invalid',
            'TMPDIR': str(self.temp),
        })
        self.repo.mkdir()
        self.git('init', '--initial-branch=main')
        self.write('both.txt', 'base\n')
        self.write('doomed.txt', 'keep me\n')
        self.write('dir with space/file name.txt', 'base\n')
        self.git('add', '.')
        self.git('commit', '-m', 'base')

        self.write('both.txt', 'staged\n')
        self.git('add', 'both.txt')
        self.write('both.txt', 'staged then unstaged\n')
        self.write('dir with space/file name.txt', 'unstaged\n')
        self.write('untracked.txt', 'untracked\n')
        self.before = self.worktree()
        self.before_status = self.git('status', '--porcelain=v1', '-z').stdout
        self.before_staged = self.git('diff', '--cached').stdout

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *map(str, args)],
                              env=self.env, capture_output=True, text=True, check=True)

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def worktree(self):
        return {str(p.relative_to(self.repo)): p.read_text()
                for p in self.repo.rglob('*')
                if p.is_file() and '.git' not in p.relative_to(self.repo).parts}

    def helper(self, *args, cwd=None):
        return subprocess.run(['sh', str(HELPER), *args], cwd=cwd or self.repo,
                              env=self.env, capture_output=True, text=True, check=True)

    def review(self):
        self.write('both.txt', 'reviewed\n')
        self.write('dir with space/file name.txt', 'reviewed\n')
        self.write('untracked.txt', 'reviewed\n')
        (self.repo / 'doomed.txt').unlink()
        self.write('created.txt', 'new\n')

    def read_only_git_dir(self):
        git_dir = self.repo / '.git'
        modes = {p: p.stat().st_mode for p in [git_dir, *git_dir.rglob('*')]}
        for path, mode in modes.items():
            path.chmod(mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))

        def restore_modes():
            for path, mode in sorted(modes.items(), key=lambda item: -len(item[0].parts)):
                path.chmod(mode)
            git_dir.chmod(modes[git_dir])
        self.addCleanup(restore_modes)

    def test_diff_lists_only_edits_made_after_take(self):
        snapshot = self.helper('take').stdout.strip()
        self.assertEqual(self.helper('diff', snapshot, '--name-only').stdout, '')

        self.review()
        changed = self.helper('diff', snapshot, '--name-status').stdout.splitlines()

        self.assertEqual(sorted(changed), sorted([
            'M\tboth.txt',
            'A\tcreated.txt',
            'M\tdir with space/file name.txt',
            'D\tdoomed.txt',
            'M\tuntracked.txt',
        ]))
        self.assertIn('-staged then unstaged\n+reviewed',
                      self.helper('diff', snapshot, 'both.txt').stdout)

    def test_restore_returns_worktree_and_index_to_take_state(self):
        snapshot = self.helper('take').stdout.strip()
        self.review()

        self.helper('restore', snapshot)

        self.assertEqual(self.worktree(), self.before)
        self.assertEqual(self.git('status', '--porcelain=v1', '-z').stdout, self.before_status)
        self.assertEqual(self.git('diff', '--cached').stdout, self.before_staged)

    def test_works_from_a_subdirectory_with_a_read_only_git_dir(self):
        subdir = self.repo / 'dir with space'
        self.read_only_git_dir()

        snapshot = self.helper('take', cwd=subdir).stdout.strip()
        self.review()
        changed = self.helper('diff', snapshot, '--name-only', cwd=subdir).stdout
        self.helper('restore', snapshot, cwd=subdir)

        self.assertIn('dir with space/file name.txt\n', changed)
        self.assertEqual(self.worktree(), self.before)
        self.assertEqual(self.git('status', '--porcelain=v1', '-z').stdout, self.before_status)


if __name__ == '__main__':
    unittest.main()
