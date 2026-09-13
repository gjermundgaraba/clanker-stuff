import asyncio
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock

from pi_evals.adapters.frontier import BudgetCapture
from pi_evals.frontier import EVALS


class Wrapped:
    def __init__(self, logs_dir, outcome):
        self.logs_dir = logs_dir
        self.outcome = outcome
        self.events = []

    async def run(self, instruction, environment, context):
        try:
            if self.outcome == 'hang':
                await asyncio.sleep(100)
            if self.outcome == 'error':
                raise RuntimeError('stream failed')
        finally:
            self.events.append('wrapped_finally')

    def populate_context_post_run(self, context):
        raise ValueError('missing telemetry')


class Capture(BudgetCapture, Wrapped):
    async def _quiesce(self, environment):
        self.events.append('quiesce')

    async def _capture(self, environment):
        self.events.append('capture')
        (self.logs_dir/'candidate.json').write_text('{"files": {}}')


class CaptureTest(IsolatedAsyncioTestCase):
    async def test_cutoff_quiesces_before_cancellation_and_preserves_before_telemetry(self):
        with TemporaryDirectory() as directory:
            agent = Capture(logs_dir=Path(directory), outcome='hang', budget_seconds=.01)
            await agent.run('', None, None)
            self.assertEqual(agent.events, ['quiesce', 'wrapped_finally', 'capture'])
            status = json.loads((agent.logs_dir/'run-status.json').read_text())
            self.assertEqual(status['outcome'], 'budget_exhausted')
            self.assertTrue(status['captured'])
            agent.populate_context_post_run(None)
            self.assertTrue((agent.logs_dir/'candidate.json').is_file())
            self.assertTrue((agent.logs_dir/'telemetry-error.json').is_file())

    async def test_completion_and_stream_failure_are_distinct_captured_outcomes(self):
        for outcome, expected in [('ok', 'completed'), ('error', 'runtime_error')]:
            with TemporaryDirectory() as directory:
                agent = Capture(logs_dir=Path(directory), outcome=outcome, budget_seconds=1)
                await agent.run('', None, None)
                status = json.loads((agent.logs_dir/'run-status.json').read_text())
                self.assertEqual(status['outcome'], expected)
                self.assertTrue(status['captured'])


    async def test_failed_quiescence_never_captures_live_workspace(self):
        with TemporaryDirectory() as directory:
            agent = Capture(logs_dir=Path(directory), outcome='hang', budget_seconds=.01)
            agent._quiesce = AsyncMock(side_effect=RuntimeError('cannot terminate tools'))
            with self.assertRaisesRegex(RuntimeError, 'cannot terminate'):
                await agent.run('', None, None)
            status = json.loads((agent.logs_dir/'run-status.json').read_text())
            self.assertEqual(status['outcome'], 'supervisor_error')
            self.assertFalse(status['captured'])
            self.assertNotIn('capture', agent.events)
            self.assertIn('wrapped_finally', agent.events)

    async def test_capture_failure_leaves_explicit_failure_status(self):
        with TemporaryDirectory() as directory:
            agent = Capture(logs_dir=Path(directory), outcome='ok', budget_seconds=1)
            agent._capture = AsyncMock(side_effect=RuntimeError('download failed'))
            with self.assertRaisesRegex(RuntimeError, 'download failed'):
                await agent.run('', None, None)
            status = json.loads((agent.logs_dir/'run-status.json').read_text())
            self.assertEqual(status['outcome'], 'capture_failed')
            self.assertFalse(status['captured'])

    async def test_outer_cancellation_is_not_a_successful_budget_cutoff(self):
        with TemporaryDirectory() as directory:
            agent = Capture(logs_dir=Path(directory), outcome='hang', budget_seconds=100)
            task = asyncio.create_task(agent.run('', None, None))
            await asyncio.sleep(.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            status = json.loads((agent.logs_dir/'run-status.json').read_text())
            self.assertEqual(status['outcome'], 'supervisor_error')
            self.assertTrue(status['captured'])
            self.assertEqual(agent.events, ['quiesce', 'wrapped_finally', 'capture'])


class NativeDurabilityTest(TestCase):
    def test_real_runner_journals_before_turn_completion_and_survives_sigkill(self):
        # Stub only transport; exercise run(), RPC parsing and its actual journal.
        script = """
import {run} from MODULE;
globalThis.WebSocket = class extends EventTarget {
  constructor() { super(); setTimeout(()=>this.dispatchEvent(new Event('open')),0); }
  close() {}
  emit(value) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)})); }
  send(text) {
    const {id,method}=JSON.parse(text);
    if (id===undefined) return;
    const result=method==='thread/start'?{thread:{id:'thread'}}:method==='turn/start'?{turn:{id:'turn'}}:{};
    queueMicrotask(()=>{
      this.emit({id,result});
      if(method==='turn/start') {
        this.emit({method:'rawResponse/completed',params:{
          responseId:'response',threadId:'thread',turnId:'turn',
          usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0,totalTokens:12}
        }});
        process.kill(process.pid,'SIGKILL');
      }
    });
  }
};
await run(process.argv[1]);
"""
        script = script.replace('MODULE', json.dumps((EVALS/'runtime/codex-eval.mjs').as_uri()))
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'prompt').write_text('no model calls')
            (root/'config.json').write_text(json.dumps({
                'compactBefore': False, 'compactedAfterSegment': -1,
                'effort': 'high', 'instructionPath': str(root/'prompt'),
                'model': 'gpt-6-astra', 'summary': None,
            }))
            result = subprocess.run(['node', '--input-type=module', '-e', script, str(root/'config.json')],
                                    env={**os.environ, 'CODEX_HOME': directory}, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, -9, result.stderr)
            records = [json.loads(line) for line in (root/'eval-events.jsonl').read_text().splitlines()]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]['responseId'], 'response')
            self.assertEqual(records[0]['usage']['totalTokens'], 12)
