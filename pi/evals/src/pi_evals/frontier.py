"""FrontierSWE v2 Qubit Routing: capped three-arm pilot, unchanged upstream grading."""
from __future__ import annotations

import argparse
import base64
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from uuid import uuid4

from harbor.models.job.config import JobConfig
import yaml

from pi_evals.artifacts import EVALS, task_hashes, write_json
from pi_evals.runtime import ARMS, LABELS, command, docker, image_info, pin_tag
from pi_evals import frontier_report, frontier_state
from pi_evals.preflight import run_preflight

ASSETS = EVALS/'suites/frontier'
SOURCE = '9e3f71cac38ef3d7e14a41b361c7b2b54c59899b'
TASK = 'qubit-routing'

# Reuse Pi's built-in session recovery, not whole-trial reruns. The deadline
# includes retries/backoff, and successful tool calls are not replayed.
PI_SETTINGS = {
    'compaction': {'enabled': False},
    'retry': {'enabled': True, 'maxRetries': 3, 'baseDelayMs': 2000,
              'provider': {'maxRetries': 0}},
}


def sources():
    """Freeze execution inputs, not unrelated suites or analysis implementations."""
    selected = {
        'src': ('pi_evals/frontier.py', 'pi_evals/frontier_state.py', 'pi_evals/trials.py', 'pi_evals/runtime.py', 'pi_evals/artifacts.py', 'pi_evals/preflight.py',
                'pi_evals/adapters/pi.py', 'pi_evals/adapters/codex.py', 'pi_evals/jsonl.py',
                'pi_evals/adapters/frontier.py', 'pi_evals/adapters/auth.py', 'pi_evals/protocol.py'),
        'runtime': ('Dockerfile', 'pi-eval-tools.mjs', 'eval-journal.mjs', 'codex-eval.mjs', 'pi-eval-compact.mjs'),
        'profiles': ('code-mode.yaml', 'native-astra.yaml'),
        'verifiers': ('tool-mode.mjs', 'native-astra.mjs'),
    }
    return {**{root: {name: hashlib.sha256((EVALS/root/name).read_bytes()).hexdigest() for name in names}
               for root, names in selected.items()}, 'suites/frontier': task_hashes(ASSETS)}


def build(context, tag):
    docker('build', '--platform', 'linux/amd64', '-t', tag, context)
    info = image_info(tag)
    info['tag'] = pin_tag(info['image_id'])
    return info


def make_schedule(output, image, version, seconds=1800, rounds=1, order_offset=0):
    pi = yaml.safe_load((EVALS/'profiles/code-mode.yaml').read_text())
    native = yaml.safe_load((EVALS/'profiles/native-astra.yaml').read_text())['agents'][0]
    native['kwargs']['version'] = version
    compose = output/'configs/runtime.compose.yaml'
    compose.parent.mkdir(parents=True, exist_ok=True)
    compose.write_text(yaml.safe_dump({'services': {'main': {'image': image, 'platform': 'linux/amd64'}}}))
    if not 1 <= rounds <= 10 or not 0 <= order_offset < len(ARMS):
        raise ValueError('rounds must be 1..10 and order_offset 0..2')
    schedule = []
    agents = dict(zip(ARMS, [*pi['agents'], native], strict=True))
    for round_index in range(rounds):
        offset = (order_offset + round_index) % len(ARMS)
        order = list(ARMS[offset:]) + list(ARMS[:offset])
        for position, arm in enumerate(order, 1):
            agent = deepcopy(agents[arm])
            agent['import_path'] = 'pi_evals.adapters.frontier:' + ('FrontierCodex' if arm == 'native' else 'FrontierPi')
            agent['kwargs']['budget_seconds'] = seconds
            if arm != 'native':
                agent['kwargs']['pi_evals']['pair_id'] = TASK
                agent['kwargs']['settings'] = deepcopy(PI_SETTINGS)
            job_name = arm if rounds == 1 else f'round-{round_index+1}-{arm}'
            config = deepcopy(pi)
            config.update(job_name=job_name, jobs_dir=str(output/'jobs'), n_attempts=1, n_concurrent_trials=1,
                          retry={'max_retries': 0}, agents=[agent], tasks=[{'path': str(output/'task')}],
                          environment={'type': 'docker', 'delete': True, 'extra_docker_compose': [str(compose)]})
            JobConfig.model_validate(config)
            path = output/'configs'/f'{job_name}.yaml'
            path.write_text(yaml.safe_dump(config, sort_keys=False))
            schedule.append({'arm': arm, 'label': LABELS[arm], 'job_name': job_name, 'config': str(path), 'round': round_index+1, 'position': position})
    write_json(output/'schedule.json', schedule)
    return schedule


def prepare(output, upstream, seconds=1800, rounds=1, order_offset=0):
    if not 1 <= rounds <= 10 or not 0 <= order_offset < len(ARMS):
        raise ValueError('rounds must be 1..10 and order_offset 0..2')
    if output.exists():
        raise FileExistsError(output)
    if not 60 <= seconds <= 72000:
        raise ValueError('agent budget must be between 60 and 72000 seconds')
    if command(['git', '-C', upstream, 'rev-parse', 'HEAD']) != SOURCE:
        raise ValueError('wrong FrontierSWE v2 revision')
    if command(['git', '-C', upstream, 'status', '--porcelain', '--untracked-files=all']):
        raise ValueError('modified upstream checkout')
    version = command(['npm', 'view', '@openai/codex', 'version'])
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('invalid latest Codex version')
    output.mkdir(parents=True)
    snapshot = output/'upstream'
    shutil.copytree(upstream/'tasks'/TASK, snapshot)
    grader = build(snapshot/'environment', 'clanker-pi-evals:frontier-qubit-upstream')
    docker('build', '--platform', 'linux/amd64', '-f', EVALS/'runtime/Dockerfile',
           '-t', 'clanker-pi-evals:frontier-runtime-base', EVALS.parents[1])
    runtime = image_info('clanker-pi-evals:frontier-runtime-base')
    runtime['tag'] = pin_tag(runtime['image_id'])
    context = output/'build'; context.mkdir()
    shutil.copy(ASSETS/'submission.py', context/'submission.py')
    (context/'Dockerfile').write_text(f'''FROM {runtime['tag']} AS runtime
FROM {grader['tag']}
# The agent cannot access the held-out corpus, scorer, baselines, or targets.
RUN rm -rf /root/tests && apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=runtime /usr/local/ /usr/local/
COPY --from=runtime /opt/codex-provider/ /opt/codex-provider/
COPY --from=runtime /tmp/pi-eval/ /tmp/pi-eval/
RUN npm install --global --ignore-scripts @openai/codex@{version} && test "$(codex --version)" = "codex-cli {version}"
COPY submission.py /opt/frontier-submission.py
RUN chmod 444 /opt/frontier-submission.py && chmod -R a+rX /opt/codex-provider
ENV PATH="/opt/codex-provider/node_modules/.bin:${{PATH}}" TASK_BUDGET_SECS="{seconds}"
WORKDIR /app
''')
    agent = build(context, 'clanker-pi-evals:frontier-qubit-agent')
    task = output/'task'; tests = task/'tests'; tests.mkdir(parents=True)
    (task/'environment').mkdir()
    (task/'environment/Dockerfile').write_text(f'FROM {agent["tag"]}\n')
    shutil.copy(snapshot/'instruction.md', task/'instruction.md')
    (task/'task.toml').write_text(f'''schema_version = "1.4"
[task]
name = "pi-evals/frontier-qubit-routing"
[agent]
timeout_sec = {seconds+90}.0
user = "agent"
[verifier]
timeout_sec = 120.0
[environment]
workdir = "/app"
cpus = 4
memory_mb = 16384
storage_mb = 10240
docker_image = "{agent['tag']}"
''')
    shutil.copy(ASSETS/'submission.py', tests)
    for name in ('native-astra.mjs', 'tool-mode.mjs'):
        shutil.copy(EVALS/'verifiers'/name, tests)
    shutil.copy(ASSETS/'validity.mjs', tests)
    (tests/'test.sh').write_text('#!/bin/bash\nset -euo pipefail\npython3 /tests/submission.py\n')
    series = {'benchmark': 'FrontierSWE v2 capped pilot', 'task': TASK, 'source_revision': SOURCE,
              'source_url': 'https://github.com/Proximal-Labs/frontier-swe-v2',
              'codex_version': version, 'model': 'gpt-6-astra', 'reasoning': 'high', 'arms': LABELS,
              'rounds': rounds, 'order_offset': order_offset,
              'agent_seconds_limit': seconds, 'cleanup_grace_seconds': 90, 'official_agent_seconds_limit': 72000,
              'recovery_policy': {'pi': PI_SETTINGS['retry'], 'native': 'Frozen released Codex built-in recovery; no external restart', 'time_budget': 'All recovery and backoff count against the original work deadline', 'trial_retries': 0},
              'cutoff_policy': 'Kill all agent-user processes at the work deadline; capture actual source before telemetry conversion. Budget exhaustion is a scored outcome. Unrecovered stream errors are diagnostic partial submissions, never restarted.',
              'grader': grader, 'agent': agent, 'runtime': runtime, 'platform': 'linux/amd64',
              'adaptations': ['Harbor 0.21 export adapter and host-side unchanged upstream verifier',
                              'Shorter agent budget; no Proximus continuation/submit harness',
                              'Agent image adds matched Pi/Codex runtimes and removes hidden verifier assets',
                              'Agent network follows existing coding harness; grader network disabled',
                              '32 MiB Python-source transport limit; links and non-Python files excluded'],
              'limitations': ['One selected task, sequential attempts; not a suite ranking',
                              'Upstream thread timeouts wait for executor shutdown; pathological routers can block until the driver cap',
                              'No executable optimal oracle; greedy baseline and scoring anchors used for free controls',
                              'Legacy underlying-operation telemetry excluded from comparisons']}
    write_json(output/'series.json', series)
    make_schedule(output, agent['image_id'], version, seconds, rounds, order_offset)
    write_json(output/'frozen.json', {'sources': sources(), 'artifacts': task_hashes(output),
                                      'analysis_provenance': task_hashes(EVALS/'src')})
    frontier_report.report(output)


def verify(output):
    frozen = json.loads((output/'frozen.json').read_text())
    if frozen['sources'] != sources():
        raise ValueError('frozen source changed')
    for name, digest in frozen['artifacts'].items():
        if hashlib.sha256((output/name).read_bytes()).hexdigest() != digest:
            raise ValueError(f'frozen artifact changed: {name}')
    return frozen


def grade(output, candidate, destination):
    """Retry postprocessing only; each attempt retains its inputs, logs and status."""
    if candidate is not None and not candidate.is_file():
        raise ValueError('candidate must be an existing file')
    series = json.loads((output/'series.json').read_text())
    identity = {'candidate_sha256': hashlib.sha256(candidate.read_bytes()).hexdigest() if candidate else None,
                'grader_image_id': series['grader']['image_id'],
                'transport_sha256': hashlib.sha256((ASSETS/'submission.py').read_bytes()).hexdigest()}
    destination.mkdir(parents=True, exist_ok=True)
    inputs = destination/'inputs.json'
    if inputs.exists():
        if json.loads(inputs.read_text()) != identity:
            raise ValueError('grading inputs changed; cannot reuse grading history')
    else:
        if any(destination.iterdir()):
            raise ValueError('existing grading directory has no input identity')
        write_json(inputs, identity)
    reward = destination/'reward.json'
    if reward.exists():
        score = json.loads(reward.read_text())
        if score.get('valid') != 1:
            raise RuntimeError('invalid published grade')
        return score
    attempts = list(destination.glob('attempt-[0-9]*'))
    attempt = destination/f'attempt-{len(attempts)+1:04d}'
    attempt.mkdir(exist_ok=False)
    write_json(attempt/'status.json', {'state': 'started', **identity})
    container = 'frontier-grade-' + uuid4().hex
    args = ['run', '--rm', '--name', container, '--platform', 'linux/amd64', '--network', 'none',
            '--cpus', '4', '--memory', '16g', '--entrypoint', 'bash',
            '-v', f'{attempt}:/logs/verifier', '-v', f'{ASSETS/"submission.py"}:/submission.py:ro']
    script = 'set -euo pipefail; '
    if candidate is not None:
        args += ['-v', f'{candidate}:/candidate.json:ro']
        script += 'python3 /submission.py import; '
    script += 'bash /root/tests/test.sh'
    try:
        with (attempt/'stdout.log').open('w') as stdout, (attempt/'stderr.log').open('w') as stderr:
            try:
                docker(*args, series['grader']['image_id'], '-c', script, timeout=8500, stdout=stdout, stderr=stderr)
            finally:
                subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=30)
        score = json.loads((attempt/'reward.json').read_text())
        if score.get('valid') != 1:
            raise RuntimeError(f'upstream grader invalid: {attempt}')
    except BaseException as error:
        write_json(attempt/'status.json', {'state': 'failed', 'error': str(error), **identity})
        raise
    write_json(attempt/'status.json', {'state': 'succeeded', **identity})
    # Publish only complete, valid postprocessing. Failed attempts never occupy
    # the successful result path and can never silently replace an earlier grade.
    if (attempt/'details.json').exists():
        shutil.copyfile(attempt/'details.json', destination/'details.json')
    write_json(reward, score)
    return score


def load_transport():
    import importlib.util
    spec = importlib.util.spec_from_file_location('frontier_submission', ASSETS/'submission.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def preflight(output):
    run_preflight(output, verify(output), lambda logs: _preflight(output, logs))


def _preflight(output, logs):
    series = json.loads((output/'series.json').read_text())
    recovery = command(['docker', 'run', '--rm', '--platform', 'linux/amd64', '--network', 'none',
                        '--entrypoint', 'node',
                        '-v', f'{ASSETS/"recovery.mjs"}:/opt/codex-provider/frontier-recovery.mjs:ro',
                        series['agent']['image_id'], '/opt/codex-provider/frontier-recovery.mjs',
                        json.dumps(PI_SETTINGS)])
    (logs/'recovery.log').write_text(recovery)
    # A nop agent cannot detect unreadable runtime extensions. Exercise actual Pi
    # startup as the task user with synthetic auth and no possible network access.
    for mode, expected in (('direct', ['apply_patch', 'exec_command', 'view_image', 'write_stdin']),
                           ('code_mode_only', ['exec', 'wait'])):
        probe = command(['docker', 'run', '--rm', '--platform', 'linux/amd64', '--network', 'none',
                         '--entrypoint', 'bash', series['agent']['image_id'], '-c',
                         'set -euo pipefail; install -d -o agent -g agent /tmp/pi-eval /logs/agent; '
                         'printf \'{"openai-codex":{"type":"api_key","key":"offline-preflight"}}\' > /tmp/pi-eval/auth.json; '
                         'printf \'{"retry":{"enabled":false}}\' > /tmp/pi-eval/settings.json; '
                         'chown -R agent:agent /tmp/pi-eval; '
                         'runuser -u agent -- codex --version; '
                         f'runuser -u agent -- env PI_CODING_AGENT_DIR=/tmp/pi-eval PI_EVAL_TOOL_MODE={mode} '
                         'PI_EVAL_MODEL=openai-codex/gpt-6-astra PI_EVAL_THINKING=high '
                         'timeout 30 pi --print --mode json --provider openai-codex --model gpt-6-astra '
                         '--thinking high --no-extensions --no-context-files --no-skills --no-prompt-templates '
                         '--no-themes --extension /opt/codex-provider/pi-eval-tools.mjs "Reply OK" 2>&1 || true; '
                         'cat /logs/agent/eval-events.jsonl'])
        (logs/f'startup-{mode}.log').write_text(probe)
        events = [json.loads(line) for line in probe.splitlines() if line.startswith('{')]
        setup = [event for event in events if event.get('type') == 'pi_eval_setup']
        if len(setup) != 1 or setup[0]['activeTools'] != expected or setup[0]['model'] != 'openai-codex/gpt-6-astra' or 'Failed to load extension' in probe:
            raise RuntimeError(f'non-root offline runtime startup failed: {mode}')
    # Exercise real Harbor discovery, non-root agent setup, and runtime/export boundary without models.
    direct = next(e for e in json.loads((output/'schedule.json').read_text()) if e['arm'] == 'pi-direct')
    config = yaml.safe_load(Path(direct['config']).read_text())
    config.update(job_name='nop', jobs_dir=str(logs/'harbor'), agents=[{'name': 'nop'}])
    JobConfig.model_validate(config)
    path = logs/'nop.yaml'; path.write_text(yaml.safe_dump(config, sort_keys=False))
    subprocess.run(['harbor', 'job', 'start', '--config', str(path), '--yes'], cwd=EVALS, check=True)
    results = list((logs/'harbor/nop').glob('*/result.json'))
    if len(results) != 1:
        raise RuntimeError('missing Harbor smoke result')
    raw = json.loads(results[0].read_text())
    if raw.get('exception_info') or (raw.get('verifier_result') or {}).get('rewards') != {'valid_experiment': 0.0, 'submission_exported': 1.0}:
        raise RuntimeError('Harbor export smoke failed')
    # Prove cutoff kills detached tools and preserves source even when telemetry
    # conversion fails. This probe cannot make model calls.
    config.update(job_name='capture-cutoff', agents=[{
        'import_path': 'pi_evals.adapters.frontier:FrontierCaptureProbe',
        'kwargs': {'budget_seconds': 3}}])
    path = logs/'capture-cutoff.yaml'; path.write_text(yaml.safe_dump(config, sort_keys=False))
    subprocess.run(['harbor', 'job', 'start', '--config', str(path), '--yes'], cwd=EVALS, check=True)
    trials = list((logs/'harbor/capture-cutoff').glob('*/result.json'))
    if len(trials) != 1:
        raise RuntimeError('missing capture preflight result')
    trial = trials[0].parent
    status = json.loads((trial/'agent/run-status.json').read_text())
    payload = json.loads((trial/'agent/candidate.json').read_text())
    if (status.get('outcome') != 'budget_exhausted' or not status.get('captured')
        or base64.b64decode(payload['files']['router.py']) != b'CAPTURE_PROBE = True\n'
        or not (trial/'agent/telemetry-error.json').exists()
        or (trial/'agent/candidate.json').read_bytes() != (trial/'verifier/candidate.json').read_bytes()):
        raise RuntimeError('timeout/telemetry-independent capture preflight failed')
    empty = grade(output, None, logs/'empty')
    if empty['reward'] != 0:
        raise RuntimeError('empty submission unexpectedly scored')
    transport = load_transport()
    reference = logs/'reference-source'; reference.mkdir()
    baseline = (output/'upstream/environment/tests/trusted_baseline.py').read_text()
    (reference/'router.py').write_text(baseline + '\nroute_instance = greedy_route\n')
    payload = logs/'baseline.json'; write_json(payload, transport.snapshot(reference))
    baseline_score = grade(output, payload, logs/'baseline')
    if baseline_score.get('n_instances', 0) < 100 or baseline_score.get('n_solved') != baseline_score['n_instances']:
        raise RuntimeError('greedy baseline did not solve full test pool')
    # Real source export from the exact agent image, no hidden test files present.
    exported = logs/'export'; exported.mkdir()
    docker('run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--cpus', '4', '--memory', '16g',
           '--entrypoint', 'bash', '-v', f'{output/"task/tests"}:/tests:ro',
           '-v', f'{payload}:/candidate.json:ro', '-v', f'{exported}:/logs', series['agent']['image_id'], '-c',
           'set -euo pipefail; test ! -e /root/tests; test ! -e /solution; '
           'node --version; codex --version; python3 /tests/submission.py import; bash /tests/test.sh')
    if json.loads((exported/'verifier/reward.json').read_text()) != {'valid_experiment': 0, 'submission_exported': 1}:
        raise RuntimeError('reference export/validity failed')
    roundtrip = grade(output, exported/'verifier/candidate.json', logs/'roundtrip')
    a = json.loads((logs/'baseline/details.json').read_text())['additional_data']['instances']
    b = json.loads((logs/'roundtrip/details.json').read_text())['additional_data']['instances']
    if a != b or baseline_score['reward'] != roundtrip['reward']:
        raise RuntimeError('baseline export roundtrip changed results')
    # Empty interface produces a valid scored zero; edited simulator is rejected, not trusted.
    (reference/'router.py').write_text('def route_instance(instance):\n    return []\n')
    write_json(logs/'wrong.json', transport.snapshot(reference))
    wrong = grade(output, logs/'wrong.json', logs/'wrong')
    if wrong['reward'] != 0 or wrong['n_solved'] != 0:
        raise RuntimeError('negative router control failed')
    (reference/'qubit_routing').mkdir()
    (reference/'qubit_routing/simulator.py').write_text('raise RuntimeError("tampered")\n')
    write_json(logs/'tampered.json', transport.snapshot(reference))
    tampered = grade(output, logs/'tampered.json', logs/'tampered')
    if tampered['reward'] != 0 or 'modifies pristine' not in (logs/'tampered/details.json').read_text():
        raise RuntimeError('tamper control failed')
    # Pure scoring anchor controls, using the frozen original scorer in its container.
    docker('run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--entrypoint', 'python3',
           series['grader']['image_id'], '-c',
           'import sys; sys.path.insert(0,"/root/tests"); from verifier_common import score_instance; '
           'from types import SimpleNamespace as R; '
           'assert score_instance(R(valid=True,solved=True,steps=10),10,5)==0; '
           'assert score_instance(R(valid=True,solved=True,steps=5),10,5)==1; '
           'assert 0<score_instance(R(valid=True,solved=True,steps=7),10,5)<1; '
           'assert score_instance(R(valid=False,solved=True,steps=1),10,5)==0')



def run(output, resume=False, cost_checkpoint=20):
    if json.loads((output/'preflight-passed.json').read_text()) != verify(output):
        raise ValueError('matching preflight required')
    started = output/'started'
    if started.exists() and not resume:
        raise FileExistsError('use --resume for unstarted slots only')
    started.mkdir(exist_ok=True)
    for entry in json.loads((output/'schedule.json').read_text()):
        verify(output)
        current = frontier_state.read_series(output)
        row = next(r for r in current['rows'] if r['job_name'] == entry['job_name'])
        marker = started/entry['job_name']
        completed = None
        if marker.exists():
            # A model attempt is immutable, but an independently captured failed
            # attempt may still be graded diagnostically, without another model call.
            if not row.get('capture', {}).get('captured'):
                raise RuntimeError('started invalid/incomplete trial cannot be retried')
        else:
            if current['observed_cost'] >= cost_checkpoint:
                raise RuntimeError('cost checkpoint reached before next trial')
            marker.touch(exist_ok=False)
            completed = subprocess.run(['harbor', 'job', 'start', '--config', entry['config'], '--yes'], cwd=EVALS)
            exits = output/'harbor-exits'; exits.mkdir(exist_ok=True)
            write_json(exits/f"{entry['job_name']}.json", {'return_code': completed.returncode})
            row = frontier_state.read_slot(output, entry)
        if 'frontier' not in row:
            candidates = list((output/'jobs'/entry['job_name']).glob('*/agent/candidate.json'))
            if len(candidates) != 1 or not row.get('capture', {}).get('captured'):
                raise RuntimeError('missing independently captured submission; stop spending')
            grade(output, candidates[0], output/'grading'/entry['job_name'])
        elif row['frontier'].get('valid') != 1:
            raise RuntimeError('invalid existing grade; inspect before continuing')
        # Record grading before refusing further spending on any failed model or
        # runtime attempt. Completion eligibility never follows from grading alone.
        row = frontier_state.read_slot(output, entry)
        if completed is not None:
            completed.check_returncode()
        if not row['comparison_eligible']:
            raise RuntimeError('runtime-invalid trial; submission preserved and graded; stop spending')

    if not frontier_state.read_series(output)['clean_run']:
        raise RuntimeError('series did not produce a clean three-arm run; preserve failures for diagnosis')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'preflight', 'run', 'report'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--upstream', type=Path)
    parser.add_argument('--seconds', type=int, default=1800)
    parser.add_argument('--rounds', type=int, default=1)
    parser.add_argument('--order-offset', type=int, default=0)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--cost-checkpoint', type=float, default=20)
    args = parser.parse_args(); output = args.output.resolve()
    if args.command == 'prepare':
        if args.upstream is None:
            parser.error('prepare requires --upstream')
        prepare(output, args.upstream.resolve(), args.seconds, args.rounds, args.order_offset)
    elif args.command == 'run':
        try:
            run(output, args.resume, args.cost_checkpoint)
        finally:
            frontier_report.report(output)
    elif args.command == 'report':
        print(json.dumps(frontier_report.report(output), indent=2))
    else:
        preflight(output)


if __name__ == '__main__':
    main()
