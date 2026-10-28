from __future__ import annotations

import asyncio
import hashlib
import json
import shlex
import time

from harbor.agents.nop import NopAgent

from pi_evals.adapters.pi import PiEval
from pi_evals.adapters.codex import CodexEval


class BudgetCapture:
    def __init__(self, *args, budget_seconds=1800, **kwargs):
        if not 0 < budget_seconds <= 72000:
            raise ValueError('invalid agent budget')
        self.budget_seconds = budget_seconds
        super().__init__(*args, **kwargs)

    async def _quiesce(self, environment):
        if environment.default_user != 'agent':
            raise ValueError('budget capture requires the dedicated agent user')
        await self.exec_as_root(environment, timeout_sec=20, command=
            'set -e; uid=$(id -u agent); test "$uid" -ge 1000; '
            'pkill -STOP -u "$uid" || test "$?" = 1; '
            'pkill -KILL -u "$uid" || test "$?" = 1')

    async def _capture(self, environment):
        await self.exec_as_root(environment, command=
            'python3 -I /opt/frontier-submission.py capture')
        await environment.download_file('/logs/agent/candidate.json', self.logs_dir/'candidate.json')
        if isinstance(self, CodexEval):
            home = self._REMOTE_CODEX_HOME.as_posix()
            await self.exec_as_root(environment, command=
                f'if [ -d {home}/sessions ]; then rm -rf /logs/agent/sessions; '
                f'cp -R {home}/sessions /logs/agent/sessions; fi; '
                f'if [ -f {home}/eval-events.jsonl ]; then '
                f'cp {home}/eval-events.jsonl /logs/agent/codex-events.jsonl; fi')

    async def run(self, instruction, environment, context):
        status = {'outcome': 'supervisor_error', 'budget_seconds': self.budget_seconds,
                  'captured': False}
        start = time.monotonic()
        quiesced = False
        task = asyncio.create_task(super().run(instruction, environment, context))
        try:
            done, _ = await asyncio.wait({task}, timeout=self.budget_seconds)
            await self._quiesce(environment)
            quiesced = True
            status['work_seconds'] = time.monotonic()-start
            status['outcome'] = 'completed' if done else 'budget_exhausted'
            if not done:
                task.cancel()
            try:
                await asyncio.wait_for(task, timeout=20)
            except asyncio.CancelledError:
                if done:
                    raise
            except Exception as error:
                if done:
                    status.update(outcome='runtime_error', error=str(error))
                else:
                    status.update(outcome='supervisor_error', shutdown_error=str(error))
        except BaseException as error:
            status.update(outcome='supervisor_error', error=str(error))
            raise
        finally:
            try:
                if not quiesced:
                    try:
                        await self._quiesce(environment)
                        quiesced = True
                        status['work_seconds'] = time.monotonic()-start
                    except Exception as error:
                        status['quiesce_error'] = str(error)
                if not task.done():
                    task.cancel()
                    try:
                        await asyncio.wait_for(task, timeout=20)
                    except (Exception, asyncio.CancelledError):
                        pass
                if task.done() and not task.cancelled():
                    task.exception()
                if quiesced:
                    try:
                        await self._capture(environment)
                        status['submission_sha256'] = hashlib.sha256(
                            (self.logs_dir/'candidate.json').read_bytes()).hexdigest()
                        status['captured'] = True
                    except Exception as error:
                        status.update(outcome='capture_failed', capture_error=str(error))
                        raise
            finally:
                (self.logs_dir/'run-status.json').write_text(json.dumps(status, indent=2)+'\n')

    def populate_context_post_run(self, context):
        try:
            super().populate_context_post_run(context)
        except Exception as error:
            (self.logs_dir/'telemetry-error.json').write_text(json.dumps({'error':str(error)})+'\n')


class FrontierPi(BudgetCapture, PiEval):
    pass


class FrontierCodex(BudgetCapture, CodexEval):
    pass


class _CaptureProbe(NopAgent):
    async def exec_as_root(self, environment, **kwargs):
        result = await environment.exec(user='root', **kwargs)
        if result.return_code:
            raise RuntimeError(result.stderr)
        return result

    async def run(self, instruction, environment, context):
        script = """import pathlib, subprocess, sys, time
pathlib.Path('/app/router.py').write_text('CAPTURE_PROBE = True\\n')
subprocess.Popen([sys.executable, '-c', "import time,pathlib; time.sleep(8); pathlib.Path('/app/router.py').write_text('ESCAPED = True\\\\n')"], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(300)
"""
        await environment.exec(command='python3 -c '+shlex.quote(script))

    def populate_context_post_run(self, context):
        raise ValueError('intentional preflight telemetry failure')


class FrontierCaptureProbe(BudgetCapture, _CaptureProbe):
    async def _capture(self, environment):
        await asyncio.sleep(9)
        await super()._capture(environment)
