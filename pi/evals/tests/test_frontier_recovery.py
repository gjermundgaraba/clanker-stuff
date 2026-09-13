"""Grading is resumable; model attempts and execution identity are not."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from pi_evals import frontier as f, frontier_report, frontier_state
from fixtures.trials import completed_trajectory, write_trial


class FrontierRecoveryTest(TestCase):
    def test_grader_timeout_preserves_attempt_and_allows_only_same_input_retry(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            f.write_json(root/'series.json', {'grader': {'image_id': 'sha256:grader'}})
            candidate = root/'candidate.json'
            candidate.write_text('{}')
            destination = root/'grading'
            with patch.object(f, 'docker', side_effect=subprocess.TimeoutExpired('docker', 8500)), patch.object(f.subprocess, 'run'):
                with self.assertRaises(subprocess.TimeoutExpired):
                    f.grade(root, candidate, destination)
            failed = destination/'attempt-0001'
            self.assertEqual(json.loads((failed/'status.json').read_text())['state'], 'failed')
            before = {p.name: p.read_bytes() for p in failed.iterdir()}
            def success(*args, **kwargs):
                attempt = Path(next(arg.removesuffix(':/logs/verifier') for arg in args if isinstance(arg, str) and arg.endswith(':/logs/verifier')))
                f.write_json(attempt/'reward.json', {'valid': 1, 'reward': 0.7})
                f.write_json(attempt/'details.json', {'solved': 7})
            with patch.object(f, 'docker', side_effect=success) as docker, patch.object(f.subprocess, 'run'):
                self.assertEqual(f.grade(root, candidate, destination), {'valid': 1, 'reward': 0.7})
                self.assertEqual(f.grade(root, candidate, destination), {'valid': 1, 'reward': 0.7})
                docker.assert_called_once()
            self.assertEqual(json.loads((destination/'attempt-0002/status.json').read_text())['state'], 'succeeded')
            self.assertEqual({p.name: p.read_bytes() for p in failed.iterdir()}, before)
            candidate.write_text('changed')
            with self.assertRaisesRegex(ValueError, 'grading inputs changed'):
                f.grade(root, candidate, destination)

    def test_captured_error_is_graded_without_repeating_model_or_spending_on_next_slot(self):
        for started in (False, True):
            with self.subTest(started=started), TemporaryDirectory() as directory:
                root = Path(directory)
                schedule = [{'arm': arm, 'job_name': arm, 'config': arm+'.yaml'} for arm in f.ARMS]
                f.write_json(root/'schedule.json', schedule)
                f.write_json(root/'preflight-passed.json', {})
                candidate = root/'jobs/pi-direct/trial/agent/candidate.json'
                candidate.parent.mkdir(parents=True)
                candidate.write_text('{}')
                if started:
                    (root/'started').mkdir()
                    (root/'started/pi-direct').touch()
                rows = [{**entry, 'capture': {'captured': True}, 'comparison_eligible': False,
                         'status': 'errored', 'valid': 0} for entry in schedule]
                current = {'rows': rows, 'observed_cost': 0}
                with patch.object(f, 'verify', return_value={}), patch.object(frontier_state, 'read_series', return_value=current), patch.object(frontier_state, 'read_slot', return_value=rows[0]), patch.object(f, 'grade') as grade, patch.object(f.subprocess, 'run', return_value=subprocess.CompletedProcess('harbor', 2)) as run:
                    with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                        f.run(root, resume=started)
                    grade.assert_called_once_with(root, candidate, root/'grading/pi-direct')
                    self.assertEqual(run.call_count, 0 if started else 1)
                self.assertFalse((root/'started/pi-code').exists())
                if not started:
                    self.assertEqual(json.loads((root/'harbor-exits/pi-direct.json').read_text()), {'return_code': 2})

    def test_unknown_cost_preserves_independent_capture_and_score_after_harbor_error(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            f.write_json(root/'series.json', {})
            f.write_json(root/'schedule.json', [{'job_name': 'native', 'arm': 'native'}])
            job = root/'jobs/native'
            job.mkdir(parents=True)
            trajectory = completed_trajectory()
            trajectory['final_metrics']['total_cost_usd'] = None
            trajectory['steps'][0]['metrics'].pop('cost_usd')
            write_trial(job, trajectory=trajectory, result={
                'trial_name': 'trial', 'exception_info': {'exception_type': 'RuntimeError'},
                'verifier_result': {'rewards': {'valid_experiment': 0, 'submission_exported': 1}},
            })
            logs = job/'trial/agent'
            (logs/'candidate.json').write_text('{}')
            f.write_json(logs/'run-status.json', {'captured': True, 'outcome': 'runtime_error',
                         'submission_sha256': hashlib.sha256(b'{}').hexdigest(), 'work_seconds': 5})
            (root/'grading/native').mkdir(parents=True)
            (root/'harbor-exits').mkdir()
            f.write_json(root/'grading/native/reward.json', {'valid': 1, 'reward': 0.8})
            f.write_json(root/'harbor-exits/native.json', {'return_code': 2})
            row = frontier_report.report(root)['rows'][0]
            self.assertTrue(row['capture']['captured'])
            self.assertEqual(row['frontier']['reward'], 0.8)
            self.assertEqual(row['input'], 5)
            self.assertIsNone(row['total_cost'])
            self.assertFalse(row['comparison_eligible'])
            self.assertEqual(row['harbor_status'], 'errored')

    def test_execution_freeze_ignores_analysis_but_enforces_adapters(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'evals'
            # Build an isolated execution snapshot; never edit the shared repo inputs.
            for tree, files in f.sources().items():
                for name in files:
                    target = source/tree/name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(f.EVALS/tree/name, target)
            series = root/'series'
            series.mkdir()
            with patch.object(f, 'EVALS', source), patch.object(f, 'ASSETS', source/'suites/frontier'):
                frozen = {'sources': f.sources(), 'artifacts': {}}
                f.write_json(series/'frozen.json', frozen)
                formatter = source/'src/pi_evals/frontier_report.py'
                before = Path(frontier_report.__file__).read_text()
                formatter.write_text(before.replace('observed cost is not a complete bill.',
                                                    'recorded costs may be incomplete.'))
                self.assertNotEqual(formatter.read_text(), before)
                (source/'src/pi_evals/report.py').write_text('changed generic reporting')
                (source/'src/pi_evals/unrelated_suite.py').write_text('changed unrelated suite')
                self.assertEqual(f.verify(series), frozen)
                for name in ('frontier.py', 'frontier_state.py', 'trials.py', 'adapters/pi.py'):
                    target = source/'src/pi_evals'/name
                    original = target.read_bytes()
                    target.write_bytes(original + b'\n# execution change\n')
                    with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'frozen source'):
                        f.verify(series)
                    target.write_bytes(original)

    def test_run_uses_evidence_not_report_to_authorize_spending(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            schedule = [{'arm':arm,'job_name':arm,'config':arm+'.yaml'} for arm in f.ARMS]
            f.write_json(root/'schedule.json', schedule)
            f.write_json(root/'preflight-passed.json', {})
            def launch(command, **kwargs):
                entry = next(e for e in schedule if e['config'] == command[4])
                job = root/'jobs'/entry['job_name']
                job.mkdir(parents=True)
                write_trial(job, trajectory=completed_trajectory(), result={
                    'trial_name':'trial', 'verifier_result':{'rewards':{'valid_experiment':1,'submission_exported':1}}})
                logs = job/'trial/agent'
                (logs/'candidate.json').write_text('{}')
                f.write_json(logs/'run-status.json', {
                    'captured':True, 'outcome':'completed', 'work_seconds':1,
                    'submission_sha256':hashlib.sha256(b'{}').hexdigest()})
                return subprocess.CompletedProcess(command, 0)
            def grade(output, candidate, destination):
                destination.mkdir(parents=True)
                f.write_json(destination/'reward.json', {'valid':1,'reward':0})
            with patch.object(f, 'verify', return_value={}),                  patch.object(f.subprocess, 'run', side_effect=launch) as launches,                  patch.object(f, 'grade', side_effect=grade),                  patch.object(frontier_report, 'report', side_effect=AssertionError('report used for execution')):
                f.run(root)
                self.assertEqual(launches.call_count, 3)
            self.assertTrue(frontier_state.read_series(root)['clean_run'])
