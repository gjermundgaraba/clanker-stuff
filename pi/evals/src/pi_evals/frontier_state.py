"""Execution-relevant Frontier evidence: identity, eligibility and spending state."""
import hashlib
import json

from pi_evals.runtime import ARMS
from pi_evals.trials import trial_rows


def read_slot(output, entry):
    found = trial_rows(output/'jobs'/entry['job_name'], export_reward='submission_exported')
    if len(found) > 1:
        raise ValueError('multiple trials per scheduled slot')
    row = {**entry, **(found[0] if found else {'status': 'incomplete', 'valid': 0})}
    row.pop('underlying_operations', None)
    exit_path = output/'harbor-exits'/f"{entry['job_name']}.json"
    if exit_path.exists():
        row['harbor_exit_code'] = json.loads(exit_path.read_text())['return_code']
        if row['harbor_exit_code'] != 0:
            row['status'] = 'errored'
    row['harbor_status'] = row['status']
    if row.get('trial'):
        logs = output/'jobs'/entry['job_name']/row['trial']/'agent'
        status = logs/'run-status.json'
        if status.exists():
            capture = json.loads(status.read_text())
            row['capture'] = capture
            candidate = logs/'candidate.json'
            if capture.get('captured') and candidate.is_file():
                if hashlib.sha256(candidate.read_bytes()).hexdigest() != capture['submission_sha256']:
                    raise ValueError('captured submission hash changed')
                if row['harbor_status'] == 'completed':
                    row['status'] = capture['outcome']
                row['work_seconds'] = capture.get('work_seconds')
            else:
                row['status'] = 'capture_failed'
        events_path = logs/'pi-events.jsonl'
        if events_path.exists():
            events = []
            try:
                with events_path.open() as stream:
                    for line_number, line in enumerate(stream, 1):
                        if line.strip():
                            event = json.loads(line)
                            if not isinstance(event, dict):
                                raise ValueError(f'line {line_number}: expected event object')
                            if event.get('type') == 'message_end' and not isinstance(event.get('message', {}), dict):
                                raise ValueError(f'line {line_number}: expected message object')
                            events.append(event)
            except (ValueError, UnicodeError) as error:
                row['event_log_error'] = str(error)
                row['valid'] = 0
            else:
                row['recovery'] = {
                    'attempts': sum(e.get('type') == 'auto_retry_start' for e in events),
                    'successful_episodes': sum(e.get('type') == 'auto_retry_end' and e.get('success') is True for e in events),
                    'failed_episodes': sum(e.get('type') == 'auto_retry_end' and e.get('success') is False for e in events),
                    'errored_responses': sum(e.get('type') == 'message_end' and e.get('message', {}).get('role') == 'assistant' and e['message'].get('stopReason') == 'error' for e in events),
                }
        if (logs/'telemetry-error.json').exists():
            row['telemetry_error'] = json.loads((logs/'telemetry-error.json').read_text())
            row['valid'] = 0
    row['comparison_eligible'] = (
        row['status'] in ('completed', 'budget_exhausted')
        and row.get('valid') == 1
        and row.get('capture', {}).get('captured') is True
        and row.get('work_seconds') is not None
    )
    grade_path = output/'grading'/entry['job_name']/'reward.json'
    if grade_path.exists():
        row['frontier'] = json.loads(grade_path.read_text())
    return row


def read_series(output):
    rows = [read_slot(output, entry) for entry in json.loads((output/'schedule.json').read_text())]
    costs = [r['total_cost'] for r in rows if r.get('total_cost') is not None]
    return {
        'rows': rows,
        'observed_cost': sum(costs),
        'cost_observations': len(costs),
        'clean_run': bool(rows) and set(r['arm'] for r in rows) == set(ARMS)
            and len({r['job_name'] for r in rows}) == len(rows)
            and len({sum(r['arm'] == arm for r in rows) for arm in ARMS}) == 1
            and all(r['comparison_eligible'] and r.get('frontier', {}).get('valid') == 1 for r in rows),
    }
