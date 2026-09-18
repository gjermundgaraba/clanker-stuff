"""Execute generated programs, including all three runtime validity boundaries."""

import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from pi_evals.artifacts import EVALS
from pi_evals import scaling


class ServiceGenerationTest(TestCase):
    def test_generated_grader_definitions_serialized_solution_and_budget(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = [
                scaling.generate_task(root, size, "behavioral-test", 1)
                for size in scaling.SIZES
            ]
            for task in tasks:
                with self.subTest(task=task.name):
                    logs = root / "logs" / task.name
                    logs.mkdir(parents=True)
                    result = subprocess.run(
                        [
                            "node",
                            str(EVALS / "tests/fixtures/service-task-controls.mjs"),
                            str(task),
                            str(EVALS / "runtime"),
                            str(logs),
                        ],
                        text=True,
                        capture_output=True,
                        timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_metric_decoder_preserves_counts_while_rejecting_malformed_records(self):
        module = (EVALS / "suites/scaling/service-metrics.mjs").as_uri()
        script = f"""
          import assert from "node:assert/strict";
          import {{serviceMetrics}} from {json.dumps(module)};
          const start = {{type:"pi_eval_service_start", operation:1, name:"list_records",
                          args:{{collection:"ledger",cursor:null}}, start_ms:10, concurrent:1}};
          const end = {{type:"pi_eval_service_end", operation:1, name:"list_records",
                        start_ms:10,end_ms:20,success:true,error:null,response_bytes:120}};
          assert.partialDeepStrictEqual(serviceMetrics([start,end]), {{
            ledger_complete:true,underlying_operations:1,completed_operations:1,
            successful_operations:1,response_bytes:120,max_concurrency:1,service_elapsed_ms:10,
          }});
          for (const invalid of [null,[],"bad",{{...end,response_bytes:"120"}},
                                 {{...end,response_bytes:Infinity}},{{...end,end_ms:NaN}}]) {{
            const metrics = serviceMetrics([start,invalid]);
            assert.equal(metrics.ledger_complete,false);
            assert.equal(metrics.underlying_operations,1);
            assert.equal(metrics.response_bytes,0);
          }}
          assert.partialDeepStrictEqual(serviceMetrics([{{type:start.type}},end]), {{
            ledger_complete:false,underlying_operations:1,completed_operations:1,
            response_bytes:120,service_elapsed_ms:10,
          }});
          assert.equal(serviceMetrics([start,start,end,end]).ledger_complete,false);
          assert.equal(serviceMetrics([start,{{...end,end_ms:9}}]).ledger_complete,false);
        """
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
