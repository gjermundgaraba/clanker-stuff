"""Run with: python3 -m unittest discover -s scripts -v."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


HELPER = Path(__file__).resolve().parent / 'review-copy.sh'
LINES = [f'line {n}\n' for n in range(1, 10)]


def lines(**changes):
    return ''.join(changes.get(f'l{n}', line) for n, line in enumerate(LINES, start=1))


class ReviewCopyTests(unittest.TestCase):
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
        self.write('both.txt', lines())
        self.write('doomed.txt', 'keep me\n')
        self.write('dir with space/file name.txt', 'base\n')
        self.git('add', '.')
        self.git('commit', '-m', 'base')
        self.git('switch', '-c', 'feature')

        self.write('both.txt', lines(l5='staged\n'))
        self.git('add', 'both.txt')
        self.write('both.txt', lines(l5='staged then unstaged\n'))
        self.write('dir with space/file name.txt', 'unstaged\n')
        self.write('untracked.txt', 'untracked\n')
        self.before = self.worktree()
        self.before_status = self.git('status', '--porcelain=v1', '-z').stdout
        self.before_staged = self.git('diff', '--cached').stdout

    def git(self, *args, repo=None):
        return subprocess.run(['git', '-C', str(repo or self.repo), *map(str, args)],
                              env=self.env, capture_output=True, text=True, check=True)

    def write(self, name, text, root=None):
        path = (root or self.repo) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def worktree(self, root=None):
        root = root or self.repo
        return {str(p.relative_to(root)): p.read_text()
                for p in root.rglob('*')
                if p.is_file() and '.git' not in p.relative_to(root).parts}

    def helper(self, *args, cwd=None, check=True):
        return subprocess.run(['sh', str(HELPER), *map(str, args)], cwd=cwd or self.repo,
                              env=self.env, capture_output=True, text=True, check=check)

    def take(self, cwd=None):
        return Path(self.helper('take', cwd=cwd).stdout.strip())

    def review(self, copy):
        self.write('both.txt', lines(l5='staged then unstaged\n', l9='reviewed\n'), root=copy)
        self.write('dir with space/file name.txt', 'reviewed\n', root=copy)
        self.write('untracked.txt', 'reviewed\n', root=copy)
        (copy / 'doomed.txt').unlink()
        self.write('created.txt', 'new\n', root=copy)

    def concurrent_edits(self):
        self.write('both.txt', lines(l1='concurrent\n', l5='staged then unstaged\n'))
        self.write('other.txt', 'concurrent\n')

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

    def test_take_copies_head_branches_and_uncommitted_state(self):
        copy = self.take()

        self.assertNotEqual(copy, self.repo)
        self.assertEqual(self.worktree(copy), self.before)
        self.assertEqual(self.git('status', '--porcelain=v1', '-z', repo=copy).stdout,
                         self.before_status)
        self.assertEqual(self.git('diff', '--cached', repo=copy).stdout, self.before_staged)
        self.assertEqual(self.git('rev-parse', 'HEAD', 'main', repo=copy).stdout,
                         self.git('rev-parse', 'HEAD', 'main').stdout)
        self.assertEqual(self.worktree(), self.before)

    def test_diff_lists_only_edits_made_in_the_copy(self):
        copy = self.take()
        self.assertEqual(self.helper('diff', copy, '--name-only').stdout, '')

        self.review(copy)
        self.concurrent_edits()
        changed = self.helper('diff', copy, '--name-status').stdout.splitlines()

        self.assertEqual(sorted(changed), sorted([
            'M\tboth.txt',
            'A\tcreated.txt',
            'M\tdir with space/file name.txt',
            'D\tdoomed.txt',
            'M\tuntracked.txt',
        ]))
        self.assertIn('-line 9\n+reviewed', self.helper('diff', copy, 'both.txt').stdout)

    def test_apply_adds_the_copy_edits_to_concurrent_edits(self):
        copy = self.take()
        self.review(copy)
        self.concurrent_edits()

        self.helper('apply', copy)

        self.assertEqual(self.worktree(), {
            'both.txt': lines(l1='concurrent\n', l5='staged then unstaged\n', l9='reviewed\n'),
            'created.txt': 'new\n',
            'dir with space/file name.txt': 'reviewed\n',
            'other.txt': 'concurrent\n',
            'untracked.txt': 'reviewed\n',
        })
        self.assertEqual(self.git('diff', '--cached').stdout, self.before_staged)

    def test_apply_writes_nothing_when_a_concurrent_edit_conflicts(self):
        copy = self.take()
        self.review(copy)
        self.concurrent_edits()
        self.write('both.txt', lines(l5='staged then unstaged\n', l9='conflicting\n'))
        edited = self.worktree()

        refused = self.helper('apply', copy, check=False)

        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('both.txt', refused.stderr)
        self.assertEqual(self.worktree(), edited)

    def test_drop_deletes_only_a_copy_and_leaves_the_checkout_alone(self):
        copy = self.take()
        self.review(copy)
        self.concurrent_edits()
        edited = self.worktree()
        not_copy = self.temp / 'not-a-copy'
        not_copy.mkdir()

        self.helper('drop', copy)
        refused = self.helper('drop', not_copy, check=False)

        self.assertFalse(copy.exists())
        self.assertNotEqual(refused.returncode, 0)
        self.assertTrue(not_copy.exists())
        self.assertEqual(self.worktree(), edited)

    def test_works_from_a_subdirectory_with_a_read_only_git_dir(self):
        subdir = self.repo / 'dir with space'
        self.read_only_git_dir()

        copy = self.take(cwd=subdir)
        self.review(copy)
        self.helper('apply', copy, cwd=self.temp)

        self.assertEqual(self.worktree(), self.worktree(copy))
        self.assertEqual(self.git('diff', '--cached').stdout, self.before_staged)

    def test_take_keeps_history_of_a_shallow_clone(self):
        shallow = self.temp / 'shallow'
        self.git('commit', '-qm', 'second')
        subprocess.run(['git', 'clone', '-q', '--depth=1', f'file://{self.repo}', str(shallow)],
                       env=self.env, check=True)

        copy = self.take(cwd=shallow)

        self.assertEqual(self.git('log', '--format=%s', repo=copy).stdout, 'second\n')
        self.assertEqual(self.git('status', '--porcelain', repo=copy).stdout, '')


if __name__ == '__main__':
    unittest.main()
