"""Frontier presentation only; never used to authorize model execution."""
import json
import statistics

from pi_evals.artifacts import EVALS, task_hashes, write_json
from pi_evals.frontier_state import read_series
from pi_evals.runtime import ARMS, LABELS


def report(output):
    state = read_series(output)
    rows = state['rows']
    aggregates = {}
    for arm in ARMS:
        scheduled = [r for r in rows if r['arm'] == arm]
        eligible = [r for r in scheduled if r['comparison_eligible'] and r.get('frontier', {}).get('valid') == 1]
        aggregates[arm] = {'label': LABELS[arm], 'scheduled': len(scheduled), 'valid_scored': len(eligible)}
        for name, values in (
            ('score', [r['frontier']['reward'] for r in eligible]),
            ('work_seconds', [r['work_seconds'] for r in eligible]),
            ('recorded_cost', [r['total_cost'] for r in scheduled if r.get('total_cost') is not None]),
        ):
            aggregates[arm][name] = {'n': len(values), 'mean': statistics.mean(values) if values else None,
                                     'min': min(values) if values else None, 'max': max(values) if values else None}
    result = {
        **state,
        'series': json.loads((output/'series.json').read_text()),
        'analysis_provenance': task_hashes(EVALS/'src'),
        'aggregates': aggregates,
        'cost_caveat': 'Failed/interrupted responses may have unreported usage; observed cost is not a complete bill.',
    }
    write_json(output/'report.json', result)
    return result
