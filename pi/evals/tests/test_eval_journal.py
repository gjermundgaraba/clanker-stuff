import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import time
from unittest import TestCase

from pi_evals.artifacts import EVALS


class EvalJournalTest(TestCase):
    def test_shared_file_queue_keeps_large_records_intact_under_stdout_backpressure(self):
        with TemporaryDirectory() as directory:
            path = Path(directory)/'nested/events.jsonl'
            script = rf"""
              import {{createJournal}} from {json.dumps((EVALS/'runtime/eval-journal.mjs').as_uri())};
              const path={json.dumps(str(path))}, a=createJournal(path), b=createJournal(path);
              await a.reset();
              process.stdout.write(JSON.stringify({{type:"pi",text:"x".repeat(4*1024*1024)}})+"\n");
              await Promise.all(Array.from({{length:40}},(_,i)=>(i%2?a:b).emit({{id:i,text:"y".repeat(80000)}})));
            """
            with subprocess.Popen(['node', '--input-type=module', '-e', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
                # Deliberately let the JSON stdout pipe fill before consuming it.
                time.sleep(0.15)
                stdout, stderr = process.communicate(timeout=30)
                self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(json.loads(stdout), {'type': 'pi', 'text': 'x'*(4*1024*1024)})
            events = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual([event['id'] for event in events], list(range(40)))
            self.assertTrue(all(event['text'] == 'y'*80000 for event in events))

    def test_actual_wrapper_awaits_setup_request_and_compaction_journal(self):
        for mode in ('direct', 'code_mode_only'):
            with self.subTest(mode=mode), TemporaryDirectory() as directory:
                path = Path(directory)/'events.jsonl'
                journal = (EVALS/'runtime/eval-journal.mjs').as_uri()
                wrapper = (EVALS/'runtime/pi-eval-tools.mjs').as_uri()
                redirect = f'import {{createJournal as real}} from {json.dumps(journal)}; export const createJournal=()=>real({json.dumps(str(path))});'
                script = rf"""
                  import assert from "node:assert/strict";
                  import {{registerHooks}} from "node:module";
                  const moduleUrl=source=>"data:text/javascript,"+encodeURIComponent(source);
                  registerHooks({{resolve(specifier, context, next) {{
                    if(specifier==="/opt/codex-provider/index.ts")
                      return {{url:moduleUrl("export default function(){{}}"),shortCircuit:true}};
                    if(specifier==="./eval-journal.mjs" && context.parentURL==={json.dumps(wrapper)})
                      return {{url:moduleUrl({json.dumps(redirect)}),shortCircuit:true}};
                    return next(specifier,context);
                  }}}});
                  process.env.PI_EVAL_TOOL_MODE={json.dumps(mode)};
                  process.env.PI_EVAL_MODEL="openai-codex/gpt-6-astra";
                  process.env.PI_EVAL_THINKING="high";
                  const hooks=new Map(), names={json.dumps(['apply_patch','exec_command','view_image','write_stdin'] if mode=='direct' else ['exec','wait'])};
                  const pi={{on:(name,fn)=>hooks.set(name,fn),getActiveTools:()=>[...names],getThinkingLevel:()=>"high"}};
                  const ctx={{model:{{provider:"openai-codex",id:"gpt-6-astra"}},getSystemPrompt:()=>"prompt",abort:()=>{{}}}};
                  (await import({json.dumps(wrapper)})).default(pi);
                  await hooks.get("session_start")({{}},ctx);
                  await hooks.get("before_provider_request")({{}},ctx);
                  assert.deepEqual(await hooks.get("session_before_compact")(),{{cancel:true}});
                  await assert.rejects(hooks.get("before_provider_request")({{}},ctx),/runtime contract/);
                """
                completed = subprocess.run(['node', '--input-type=module', '-e', script], text=True, capture_output=True, timeout=30)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(completed.stdout, '')
                events = [json.loads(line) for line in path.read_text().splitlines()]
                self.assertEqual([e['type'] for e in events], ['pi_eval_setup','pi_eval_tools','pi_eval_compaction','pi_eval_tools'])
                self.assertTrue(events[1]['valid'])
                self.assertFalse(events[3]['valid'])
