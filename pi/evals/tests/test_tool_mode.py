import json
import subprocess
import unittest
from copy import deepcopy
from pathlib import Path
import yaml
from pi_evals.adapters.pi import PiEval, convert_pi_events
from pi_evals.artifacts import EVALS
from pi_evals.protocol import validate_manifest

PROFILE = yaml.safe_load((EVALS / "profiles/code-mode.yaml").read_text())


class ToolModeTest(unittest.TestCase):
    def test_strict_arm_contract(self):
        for agent in PROFILE["agents"]:
            manifest = agent["kwargs"]["pi_evals"]
            self.assertEqual(validate_manifest(manifest), manifest)
            for patch in (
                {"tool_mode": "hybrid"},
                {"compaction_mode": "on"},
                {"pair_id": ""},
            ):
                with self.assertRaises(ValueError):
                    validate_manifest({**manifest, **patch})
            self.assertEqual(validate_manifest({**manifest, "provenance": {"note": "retained"}})["provenance"], {"note": "retained"})
            adapter = PiEval(
                logs_dir=Path("."), model_name=agent["model_name"], **agent["kwargs"]
            )
            self.assertIn("--no-skills", adapter._session_args())
            self.assertIn("--no-context-files", adapter._session_args())
            invalid = deepcopy(agent["kwargs"])
            invalid["extensions"] = ["retired-provider.ts"]
            with self.assertRaises(ValueError):
                PiEval(logs_dir=Path("."), model_name=agent["model_name"], **invalid)

    def test_runtime_evidence_survives_conversion_and_is_validated(self):
        manifest = PROFILE["agents"][0]["kwargs"]["pi_evals"]
        evidence = {
            "type": "pi_eval_tools",
            "mode": "direct",
            "model": "openai/gpt-6.1-sol",
            "thinking": "high",
            "valid": True,
            "activeTools": ["bash", "edit", "read", "write"],
        }
        events = [
            evidence,
            {
                "type": "tool_execution_end",
                "toolCallId": "a",
                "toolName": "bash",
                "result": {"content": []},
                "isError": False,
            },
        ]
        trajectory = convert_pi_events(
            events,
            [],
            agent_version="test",
            model_name="openai/gpt-6.1-sol",
            pi_evals=manifest,
        ).to_json_dict()
        self.assertEqual(
            trajectory["agent"]["extra"]["tool_operations"],
            [{"id": "a", "name": "bash", "success": True}],
        )
        verifier = (EVALS / "verifiers/tool-mode-core.mjs").as_uri()

        def valid(value, expected=None):
            run = subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    f'import {{validateToolMode}} from "{verifier}"; console.log(validateToolMode(JSON.parse(process.argv[1]),JSON.parse(process.argv[2])).valid_experiment)',
                    json.dumps(value),
                    json.dumps(expected or {"model": PROFILE["agents"][0]["model_name"], "thinking": PROFILE["agents"][0]["kwargs"]["thinking"], "directTools": manifest["direct_tools"]}),
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            return int(run.stdout)

        self.assertEqual(valid(trajectory), 1)
        selected = {"model": "openai/offline-selected-model", "thinking": "medium", "directTools": manifest["direct_tools"]}
        another = deepcopy(trajectory)
        another["agent"]["extra"]["tool_mode_evidence"][0].update(selected)
        another["agent"]["extra"]["pi_evals"]["provenance"] = {"note": "harmless"}
        self.assertEqual(valid(another), 0)
        self.assertEqual(valid(another, selected), 1)
        custom = deepcopy(another)
        custom["agent"]["extra"]["pi_evals"]["direct_tools"] = ["grep", "read"]
        custom["agent"]["extra"]["tool_mode_evidence"][0]["activeTools"] = ["grep", "read"]
        self.assertEqual(valid(custom, {**selected, "directTools": ["grep", "read"]}), 1)
        self.assertEqual(valid(custom, selected), 0)
        for patch in (
            {"activeTools": ["exec"]},
            {"valid": False},
            {"model": "other"},
            {"thinking": "low"},
        ):
            altered = deepcopy(trajectory)
            altered["agent"]["extra"]["tool_mode_evidence"][0].update(patch)
            self.assertEqual(valid(altered), 0)
        for evidence in [None, {}, "invalid", [None], [evidence, {"type": "unrecognized"}]]:
            altered = deepcopy(trajectory)
            altered["agent"]["extra"]["tool_mode_evidence"] = evidence
            self.assertEqual(valid(altered), 0)
        altered = deepcopy(trajectory)
        altered["steps"] = "invalid"
        self.assertEqual(valid(altered), 0)
        for malformed in [None, [], {"agent": []}, {"agent": {"extra": "invalid"}}]:
            self.assertEqual(valid(malformed), 0)
        trajectory["agent"]["extra"]["tool_mode_evidence"].append(
            {"type": "pi_eval_compaction"}
        )
        self.assertEqual(valid(trajectory), 0)

    def test_selected_model_effort_and_arm_owned_settings(self):
        profile = PROFILE["agents"][1]
        kwargs = deepcopy(profile["kwargs"])
        kwargs["thinking"] = "medium"
        adapter = PiEval(logs_dir=Path("."), model_name="openai/offline-selected-model", **kwargs)
        self.assertEqual(adapter._thinking, "medium")
        for override in ({"defaultTools": ["+codemode"]}, {"codemode": {"mode": "on"}}):
            with self.assertRaisesRegex(ValueError, "selected by arm"):
                PiEval(logs_dir=Path("."), model_name="openai/offline-selected-model", **{**kwargs, "settings": {**kwargs["settings"], **override}})

    def test_unrelated_settings_and_configured_retry_do_not_change_arm_contract(self):
        profile = PROFILE["agents"][0]
        for settings in (
            {**profile["kwargs"]["settings"], "theme": "dark"},
            {
                "compaction": {"enabled": False, "reserveTokens": 2048},
                "retry": {"enabled": True, "maxRetries": 3},
            },
        ):
            adapter = PiEval(
                logs_dir=Path("."),
                model_name=profile["model_name"],
                **{**profile["kwargs"], "settings": settings},
            )
            self.assertEqual(adapter._settings, settings)
        for compaction in ({}, {"enabled": True}, False):
            with self.assertRaisesRegex(ValueError, "compaction disabled"):
                PiEval(
                    logs_dir=Path("."),
                    model_name=profile["model_name"],
                    **{**profile["kwargs"], "settings": {"compaction": compaction}},
                )
