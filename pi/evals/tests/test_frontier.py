import base64
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import tomllib
from unittest import TestCase
from unittest.mock import patch

import yaml
from pi_evals.adapters.frontier import FrontierPi
from pi_evals import frontier as f, frontier_report, frontier_state


class FrontierTest(TestCase):
    def test_prepare_pins_latest_and_preserves_prompt_three_arms_and_grader(self):
        with TemporaryDirectory() as directory:
            root = Path(directory); upstream = root/'upstream'; source = upstream/'tasks'/f.TASK
            (source/'environment').mkdir(parents=True)
            (source/'instruction.md').write_text('original prompt')
            (source/'environment/grader.py').write_text('original grader')
            output = root/'output'
            def built(*args):
                return {'image_id': 'sha256:frozen', 'tag': 'image:frozen', 'architecture': 'amd64'}
            with patch.object(f, 'command', side_effect=[f.SOURCE, '', '9.8.7']) as cmd, \
                 patch.object(f, 'build', side_effect=built), patch.object(f, 'image_info', side_effect=built), \
                 patch.object(f, 'pin_tag', return_value='image:runtime'), patch.object(f, 'docker'), \
                 patch.object(f, 'sources', return_value={'frozen': True}):
                f.prepare(output, upstream)
                self.assertIn(['npm', 'view', '@openai/codex', 'version'], [c.args[0] for c in cmd.call_args_list])
                self.assertEqual((output/'task/instruction.md').read_text(), 'original prompt')
                self.assertEqual((output/'upstream/environment/grader.py').read_text(), 'original grader')
                task = tomllib.loads((output/'task/task.toml').read_text())
                self.assertEqual(task['agent'], {'timeout_sec': 1890.0, 'user': 'agent'})
                self.assertEqual(task['environment']['cpus'], 4)
                self.assertIn('rm -rf /root/tests', (output/'build/Dockerfile').read_text())
                self.assertNotIn('grader.py', [p.name for p in (output/'task/tests').iterdir()])
                rows = frontier_report.report(output)['rows']
                self.assertEqual([r['arm'] for r in rows], list(f.ARMS))
                self.assertTrue(all(r['status'] == 'incomplete' for r in rows))
                for row in rows:
                    config = yaml.safe_load(Path(row['config']).read_text())
                    self.assertEqual(config['retry']['max_retries'], 0)
                    self.assertEqual(config['n_attempts'], 1)
                    kwargs = config['agents'][0]['kwargs']
                    self.assertEqual(kwargs['budget_seconds'], 1800)
                    self.assertTrue(config['agents'][0]['import_path'].startswith('pi_evals.adapters.frontier:'))
                    if row['arm'] == 'native':
                        self.assertEqual(kwargs['version'], '9.8.7')
                    else:
                        self.assertEqual(kwargs['settings'], f.PI_SETTINGS)
                        FrontierPi(logs_dir=root/'logs', model_name=config['agents'][0]['model_name'], **kwargs)
                        self.assertEqual(kwargs['pi_evals']['tool_mode'], 'direct' if row['arm']=='pi-direct' else 'code_mode_only')
                f.verify(output)
                with self.assertRaises(FileNotFoundError):
                    f.run(output)
                (output/'task/instruction.md').write_text('changed')
                with self.assertRaisesRegex(ValueError, 'frozen artifact'):
                    f.verify(output)

    def test_transport_preserves_helpers_and_modified_engine_but_no_links(self):
        transport = f.load_transport()
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve(); workspace = root/'work'; workspace.mkdir()
            (workspace/'router.py').write_text('def route_instance(i): return []\n')
            (workspace/'helpers').mkdir(); (workspace/'helpers/a.py').write_bytes(b'\x00\xff')
            (workspace/'qubit_routing').mkdir(); (workspace/'qubit_routing/simulator.py').write_text('modified')
            (workspace/'secret.py').symlink_to('/etc/passwd')
            (workspace/'outside').symlink_to('/etc', target_is_directory=True)
            (workspace/'data.txt').write_text('not submitted')
            payload = transport.snapshot(workspace)
            self.assertEqual(set(payload['files']), {'router.py','helpers/a.py','qubit_routing/simulator.py'})
            destination = root/'import'; destination.mkdir()
            transport.materialize(payload, destination)
            self.assertEqual(transport.snapshot(destination), payload)
            transport.export(workspace, root/'logs', {'valid_experiment': 0})
            self.assertEqual(json.loads((root/'logs/reward.json').read_text()), {'valid_experiment':0,'submission_exported':1})

    def test_import_rejects_traversal_links_non_python_and_oversized(self):
        transport = f.load_transport()
        encoded = base64.b64encode(b'hello').decode()
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ('../escape.py', '/absolute.py', 'a/../escape.py', './file.py', 'data.json'):
                with self.assertRaises(ValueError):
                    transport.materialize({'files': {name: encoded}}, root)
            (root/'link').symlink_to('/tmp', target_is_directory=True)
            with self.assertRaises(ValueError):
                transport.materialize({'files': {'link/escape.py': encoded}}, root)
            with patch.object(transport, 'LIMIT', 1), self.assertRaises(ValueError):
                transport.materialize({'files': {'router.py': encoded}}, root)
            self.assertFalse((root/'router.py').exists())

    def test_resume_never_retries_started_invalid_trial_and_cost_checkpoint(self):
        with TemporaryDirectory() as directory:
            root = Path(directory); (root/'started').mkdir(); (root/'started/pi-direct').touch()
            f.write_json(root/'preflight-passed.json', {})
            f.write_json(root/'schedule.json', [{'arm': 'pi-direct', 'job_name': 'pi-direct'}])
            row = {'arm': 'pi-direct', 'job_name': 'pi-direct', 'status': 'errored', 'valid': 0}
            with patch.object(f, 'verify', return_value={}), patch.object(frontier_state, 'read_series', return_value={'rows':[row]}), patch.object(f.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'cannot be retried'):
                    f.run(root, resume=True)
                run.assert_not_called()
            (root/'started/pi-direct').unlink()
            with patch.object(f, 'verify', return_value={}), patch.object(frontier_state, 'read_series', return_value={'rows':[row], 'observed_cost':20}), patch.object(f.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'cost checkpoint'):
                    f.run(root, resume=True)
                run.assert_not_called()

    def test_recovery_policy_is_owned_and_frozen_by_series(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            schedule = f.make_schedule(root, 'sha256:image', '9.8.7')
            direct = next(e for e in schedule if e['arm'] == 'pi-direct')
            path = Path(direct['config'])
            config = yaml.safe_load(path.read_text())
            self.assertEqual(config['agents'][0]['kwargs']['settings'], f.PI_SETTINGS)
            frozen = {'sources': f.sources(), 'artifacts': f.task_hashes(root)}
            f.write_json(root/'frozen.json', frozen)
            f.verify(root)
            config['agents'][0]['kwargs']['settings']['retry']['maxRetries'] = 99
            path.write_text(yaml.safe_dump(config))
            with self.assertRaisesRegex(ValueError, 'frozen artifact'):
                f.verify(root)

    def test_two_round_schedule_rotates_each_arm_and_pins_one_version(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            schedule = f.make_schedule(root, 'sha256:frozen', '9.8.7', rounds=2, order_offset=1)
            self.assertEqual([e['arm'] for e in schedule],
                             ['pi-code', 'native', 'pi-direct', 'native', 'pi-direct', 'pi-code'])
            self.assertEqual(len({e['job_name'] for e in schedule}), 6)
            for entry in schedule:
                config = yaml.safe_load(Path(entry['config']).read_text())
                self.assertEqual(config['job_name'], entry['job_name'])
                self.assertEqual(config['n_attempts'], 1)
                self.assertEqual(config['retry']['max_retries'], 0)
                if entry['arm'] == 'native':
                    self.assertEqual(config['agents'][0]['kwargs']['version'], '9.8.7')

    def test_report_retains_all_rounds_and_excludes_failed_scores_from_aggregate(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            f.make_schedule(root, 'sha256:frozen', '9.8.7', rounds=2, order_offset=1)
            f.write_json(root/'series.json', {})
            def rows(job, **kwargs):
                return [{'trial': 'trial', 'status': 'completed' if job.name.startswith('round-1') else 'errored',
                         'valid': 1, 'work_seconds': 10, 'total_cost': 2}]
            for entry in json.loads((root/'schedule.json').read_text()):
                logs = root/'jobs'/entry['job_name']/'trial/agent'
                logs.mkdir(parents=True)
                (logs/'candidate.json').write_text('{}')
                f.write_json(logs/'run-status.json', {
                    'outcome': 'completed', 'captured': True, 'work_seconds': 10,
                    'submission_sha256': hashlib.sha256(b'{}').hexdigest()})
                (root/'grading'/entry['job_name']).mkdir(parents=True)
                f.write_json(root/'grading'/entry['job_name']/'reward.json', {'valid': 1, 'reward': 0.5})
            with patch.object(frontier_state, 'trial_rows', side_effect=rows):
                report = frontier_report.report(root)
            self.assertEqual(len(report['rows']), 6)
            self.assertEqual(report['observed_cost'], 12)
            self.assertFalse(report['clean_run'])
            for arm in f.ARMS:
                self.assertEqual(report['aggregates'][arm]['valid_scored'], 1)
                self.assertEqual(report['aggregates'][arm]['score']['mean'], .5)
                self.assertEqual(report['aggregates'][arm]['recorded_cost']['n'], 2)


    def test_report_requires_capture_and_all_three_arms(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            f.make_schedule(root, 'sha256:frozen', '9.8.7')
            f.write_json(root/'series.json', {})
            with patch.object(frontier_state, 'trial_rows', return_value=[{'status': 'completed', 'valid': 1}]):
                report = frontier_report.report(root)
            self.assertFalse(report['clean_run'])
            self.assertTrue(all(not row['comparison_eligible'] for row in report['rows']))
            f.write_json(root/'schedule.json', [])
            self.assertFalse(frontier_report.report(root)['clean_run'])

    def test_report_preserves_harbor_errors_and_corrupt_logs_without_losing_capture(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            schedule = f.make_schedule(root, 'sha256:frozen', '9.8.7')
            f.write_json(root/'series.json', {})
            for entry in schedule:
                logs = root/'jobs'/entry['job_name']/'trial/agent'
                logs.mkdir(parents=True)
                (logs/'candidate.json').write_text('{}')
                f.write_json(logs/'run-status.json', {
                    'outcome': 'completed', 'captured': True, 'work_seconds': 10,
                    'submission_sha256': hashlib.sha256(b'{}').hexdigest()})
            with patch.object(frontier_state, 'trial_rows', return_value=[{'trial': 'trial', 'status': 'errored', 'valid': 1}]):
                rows = frontier_report.report(root)['rows']
            self.assertTrue(all(r['status'] == 'errored' and not r['comparison_eligible'] for r in rows))
            logs = root/'jobs/pi-direct/trial/agent'
            (logs/'pi-events.jsonl').write_text('{"type":')
            with patch.object(frontier_state, 'trial_rows', return_value=[{'trial': 'trial', 'status': 'completed', 'valid': 1}]):
                row = frontier_report.report(root)['rows'][0]
            self.assertEqual(row['valid'], 0)
            self.assertTrue(row['capture']['captured'])
            self.assertIn('event_log_error', row)

    def test_prepare_rejects_untracked_upstream_before_spending(self):
        with TemporaryDirectory() as directory:
            with patch.object(f, 'command', side_effect=[f.SOURCE, '?? tasks/qubit-routing/environment/leak.py']) as command, patch.object(f, 'build') as build:
                with self.assertRaisesRegex(ValueError, 'modified upstream'):
                    f.prepare(Path(directory)/'output', Path(directory)/'upstream')
                build.assert_not_called()
                self.assertIn('--untracked-files=all', command.call_args_list[-1].args[0])
