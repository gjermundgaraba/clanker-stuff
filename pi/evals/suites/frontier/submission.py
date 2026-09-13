"""Transport Python source only; never execute a submission during export/import."""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import subprocess

LIMIT = 32 * 1024 * 1024


def snapshot(workspace):
    files = {}
    size = 0
    for root, dirs, names in os.walk(workspace, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in {'.git', '__pycache__'}
                         and not (Path(root)/d).is_symlink())
        for name in sorted(names):
            path = Path(root)/name
            if path.suffix != '.py' or path.is_symlink() or not path.is_file():
                continue
            if path.resolve() != path.absolute():
                raise ValueError('unsafe source path')
            size += path.stat().st_size
            if size > LIMIT:
                raise ValueError('submission exceeds transport limit')
            files[path.relative_to(workspace).as_posix()] = base64.b64encode(path.read_bytes()).decode()
    return {'files': files}


def materialize(submission, workspace):
    # Validate the entire submission before writing any file; disallow links and traversal.
    decoded = {}
    size = 0
    for name, encoded in submission['files'].items():
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or str(path) != name or path.suffix != '.py':
            raise ValueError('unsafe submission path')
        target = workspace/name
        if target.resolve() != target.absolute():
            raise ValueError('submission targets symlink')
        data = base64.b64decode(encoded, validate=True)
        size += len(data)
        if size > LIMIT:
            raise ValueError('submission exceeds transport limit')
        decoded[target] = data
    for target, data in decoded.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def export(workspace, logs, validity):
    logs.mkdir(parents=True, exist_ok=True)
    (logs/'candidate.json').write_text(json.dumps(snapshot(workspace)))
    (logs/'reward.json').write_text(json.dumps({**validity, 'submission_exported': 1}))


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['import']:
        materialize(json.loads(Path('/candidate.json').read_text()), Path('/app'))
    elif sys.argv[1:] == ['capture']:
        logs = Path('/logs/agent'); logs.mkdir(parents=True, exist_ok=True)
        temp = logs/'candidate.json.tmp'
        temp.write_text(json.dumps(snapshot(Path('/app'))))
        temp.replace(logs/'candidate.json')
    else:
        validity = json.loads(subprocess.check_output(['node', '/tests/validity.mjs'], text=True))
        logs = Path('/logs/verifier'); logs.mkdir(parents=True, exist_ok=True)
        candidate = Path('/logs/agent/candidate.json')
        if candidate.is_file():
            (logs/'candidate.json').write_bytes(candidate.read_bytes())
            (logs/'reward.json').write_text(json.dumps({**validity, 'submission_exported': 1}))
        else:
            export(Path('/app'), logs, validity)
