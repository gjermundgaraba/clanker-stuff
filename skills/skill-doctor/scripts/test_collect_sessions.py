#!/usr/bin/env python3
"""Tests for skill-doctor session collection."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from collect_sessions import (
    detect_skills_from_entries,
    discover_hermes_databases,
    discover_skills,
    find_claude_session_files,
    find_grok_session_files,
    find_hermes_sessions,
    find_pi_session_files,
    parse_claude_session,
    parse_args,
    parse_codex_session,
    parse_grok_session,
    parse_hermes_session,
    parse_pi_session,
    parse_zcode_session,
    resolve_hermes_home,
    sample_sessions,
    session_matches_repos,
)

PREVIOUS_FILE_LIMIT = 8 * 1024 * 1024


def sampling_session(index, *, project="example", harness="codex",
                     week="2026-10-05", skill=True):
    return {
        "_key": f"{harness}:{index}",
        "harness": harness,
        "meta": {"id": str(index), "cwd": f"/nonexistent-sampling-fixture/{project}",
                 "started_at": f"{week}T12:00:00+00:00"},
        "stats": {},
        "modified_at": f"{week}T12:00:00+00:00",
        "skills_used": ["example"] if skill else [],
    }


class SamplingTests(unittest.TestCase):
    def test_default_scales_with_population_and_supports_light_pass_cap_and_census(self):
        sessions = [sampling_session(i) for i in range(4289)]
        for options, count, capped in [
            ({}, 429, False),
            ({"percent": 5}, 215, False),
            ({"maximum": 100}, 100, True),
            ({"percent": 100}, 4289, False),
        ]:
            with self.subTest(options=options):
                selected, sampling = sample_sessions(sessions, **options)
                self.assertEqual(len(selected), count)
                self.assertEqual(sampling["eligible_sessions"], 4289)
                self.assertEqual(sampling["actual_percent"], count / 4289 * 100)
                self.assertEqual(sampling["capped"], capped)

        for population, expected in [(0, 0), (5, 5), (50, 12)]:
            selected, _ = sample_sessions(sessions[:population])
            self.assertEqual(len(selected), expected)

    def test_reproducible_proportional_coverage_includes_sessions_without_skills(self):
        sessions = []
        for project in ("first", "second"):
            for harness in ("claude", "codex"):
                for week in ("2026-10-05", "2026-10-12"):
                    for skill in (True, False):
                        for _ in range(20):
                            sessions.append(sampling_session(
                                len(sessions), project=project, harness=harness,
                                week=week, skill=skill,
                            ))
        selected, sampling = sample_sessions(sessions)
        reordered, _ = sample_sessions(list(reversed(sessions)))
        other_seed, _ = sample_sessions(sessions, seed=1)
        self.assertEqual(selected, reordered)
        self.assertNotEqual(selected, other_seed)
        self.assertEqual(len(selected), 32)
        self.assertEqual(len(sampling["strata"]), 16)
        self.assertTrue(all(s["sampled"] == 2 for s in sampling["strata"]))
        self.assertEqual(
            sum(s["_key"] in selected for s in sessions if not s["skills_used"]), 16,
        )

    def test_small_strata_can_be_selected_without_inflating_sample(self):
        sessions = [sampling_session(i, project=str(i)) for i in range(30)]
        observed = set()
        for seed in range(100):
            selected, sampling = sample_sessions(sessions, percent=10, minimum=0, seed=seed)
            self.assertEqual(len(selected), 3)
            self.assertEqual(sum(s["sampled"] for s in sampling["strata"]), 3)
            observed.update(selected)
        self.assertEqual(observed, {s["_key"] for s in sessions})

    def test_exclusions_precede_target_calculation_and_preserve_other_sessions(self):
        sessions = [sampling_session(i) for i in range(21)]
        selected, sampling = sample_sessions(
            sessions, percent=10, minimum=0, exclude_ids=["0", "missing"],
        )
        self.assertEqual(len(selected), 2)
        self.assertNotIn("codex:0", selected)
        self.assertEqual(sampling["eligible_sessions"], 20)
        self.assertEqual(sampling["excluded_sessions"], 1)
        self.assertEqual(sampling["excluded_session_ids"], ["0", "missing"])
        self.assertEqual(len(sessions), 21)

    def test_cli_defaults_and_invalid_sampling_controls(self):
        args = parse_args([])
        self.assertEqual(args.sample_percent, 10)
        self.assertEqual(args.min_sessions, 12)
        self.assertIsNone(args.max_sessions)
        for arguments in [
            ["--sample-percent", "0"], ["--sample-percent", "101"],
            ["--sample-percent", "nan"], ["--min-sessions", "-1"],
            ["--max-sessions", "0"],
        ]:
            with self.subTest(arguments=arguments), patch("sys.stderr"):
                with self.assertRaises(SystemExit) as error:
                    parse_args(arguments)
                self.assertEqual(error.exception.code, 2)


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")


def write_jsonl_past_previous_limit(path, first_record, last_records):
    path.parent.mkdir(parents=True, exist_ok=True)
    filler = json.dumps({"type": "ignored", "padding": "x" * 1024}) + "\n"
    with path.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(first_record) + "\n")
        while stream.tell() <= PREVIOUS_FILE_LIMIT:
            stream.write(filler)
        for record in last_records:
            stream.write(json.dumps(record) + "\n")


class ClaudeSessionTests(unittest.TestCase):
    def test_discovers_skills_and_matches_sessions_across_projects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "first"
            second = root / "second"
            first_skill = first / ".agents" / "skills" / "alpha" / "SKILL.md"
            second_skill = second / ".claude" / "skills" / "beta" / "SKILL.md"
            first_skill.parent.mkdir(parents=True)
            second_skill.parent.mkdir(parents=True)
            first_skill.write_text("---\ndescription: Alpha\n---\n")
            second_skill.write_text("---\ndescription: Beta\n---\n")

            skills = discover_skills(
                [first, second],
                root / "codex-home",
                [],
                False,
            )

            self.assertEqual(set(skills), {"alpha", "beta"})
            self.assertTrue(
                session_matches_repos(second / "src", [first, second])
            )
            self.assertFalse(
                session_matches_repos(root / "elsewhere", [first, second])
            )

    def test_discovers_global_skills_without_repositories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            homes = {
                name: root / f"{name}-home"
                for name in ("codex", "pi", "grok", "zcode", "hermes")
            }
            for name, home in homes.items():
                skill = home / "skills" / f"{name}-skill" / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text(f"---\ndescription: {name.title()} skill\n---\n")

            skills = discover_skills(
                [],
                homes["codex"],
                [],
                True,
                pi_home=homes["pi"],
                grok_home=homes["grok"],
                zcode_home=homes["zcode"],
                hermes_home=homes["hermes"],
            )

            self.assertTrue(
                {
                    "codex-skill",
                    "pi-skill",
                    "grok-skill",
                    "zcode-skill",
                    "hermes-skill",
                }.issubset(skills)
            )

    def test_detects_skills_from_deferred_tool_entries(self):
        entries = [
            ("tool:Skill", '{"skill": "alpha"}'),
            ("tool:read", '{"path": "/repo/.agents/skills/beta/SKILL.md"}'),
            ("assistant", "Mentioning gamma here does not count."),
        ]

        self.assertEqual(
            detect_skills_from_entries(entries, {"alpha", "beta", "gamma"}),
            {"alpha", "beta"},
        )

    def test_discovers_parent_sessions_and_optional_subagents(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp)
            parent = claude_home / "projects" / "-repo" / "parent.jsonl"
            subagent = (
                claude_home
                / "projects"
                / "-repo"
                / "parent"
                / "subagents"
                / "agent-child.jsonl"
            )
            old = claude_home / "projects" / "-repo" / "old.jsonl"
            for path in (parent, subagent, old):
                write_jsonl(path, [{"type": "user"}])
            old_time = (datetime.now(timezone.utc) - timedelta(days=10)).timestamp()
            os.utime(old, (old_time, old_time))
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)

            parents = find_claude_session_files(claude_home, cutoff, False)
            with_subagents = find_claude_session_files(claude_home, cutoff, True)

            self.assertEqual([path for _, path in parents], [parent])
            self.assertEqual(
                {path for _, path in with_subagents},
                {parent, subagent},
            )

    def test_parses_messages_tools_skills_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            common = {
                "sessionId": "session-1",
                "cwd": "/tmp/repo",
                "timestamp": "2026-08-20T10:00:00Z",
                "version": "1.0.0",
            }
            write_jsonl(path, [
                {
                    **common,
                    "type": "user",
                    "uuid": "user-1",
                    "message": {"role": "user", "content": "Improve my skill"},
                },
                {
                    **common,
                    "type": "assistant",
                    "uuid": "assistant-1",
                    "message": {
                        "id": "message-1",
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": "I will inspect it."},
                            {
                                "type": "tool_use",
                                "name": "Skill",
                                "input": {"skill": "update-skill"},
                            },
                        ],
                    },
                },
                {
                    **common,
                    "type": "assistant",
                    "uuid": "assistant-2",
                    "message": {
                        "id": "message-1",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "name": "Edit",
                                "input": {"file_path": "/tmp/repo/SKILL.md"},
                            }
                        ],
                    },
                },
                {
                    **common,
                    "type": "user",
                    "uuid": "result-1",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "is_error": True,
                                "content": "permission denied",
                            }
                        ],
                    },
                },
            ])

            meta, stats, entries, skills = parse_claude_session(
                path,
                {"update-skill"},
                False,
            )

            self.assertEqual(meta["id"], "session-1")
            self.assertEqual(meta["cwd"], "/tmp/repo")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 1)
            self.assertEqual(stats["tool_calls"], 2)
            self.assertEqual(stats["error_outputs"], 1)
            self.assertTrue(stats["has_code_edits"])
            self.assertEqual(skills, ["update-skill"])
            self.assertIn(("user", "Improve my skill"), entries)
            self.assertIn(("assistant", "I will inspect it."), entries)

    def test_excludes_sidechains_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "agent-child.jsonl"
            write_jsonl(path, [{
                "type": "user",
                "sessionId": "session-1",
                "agentId": "child-1",
                "isSidechain": True,
                "cwd": "/tmp/repo",
                "timestamp": "2026-08-20T10:00:00Z",
                "message": {"role": "user", "content": "Investigate"},
            }])

            self.assertIsNone(parse_claude_session(path, set(), False))
            parsed = parse_claude_session(path, set(), True)
            self.assertEqual(parsed[0]["id"], "session-1-child-1")
            self.assertEqual(parsed[0]["thread_source"], "subagent")


class PiSessionTests(unittest.TestCase):
    def test_parses_messages_tools_skills_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "2026-08-20T10-00-00-000Z_session-1.jsonl"
            write_jsonl(path, [
                {
                    "type": "session",
                    "id": "session-1",
                    "cwd": "/tmp/repo",
                    "timestamp": "2026-08-20T10:00:00.000Z",
                },
                {"type": "model_change", "provider": "zai", "modelId": "glm"},
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:01.000Z",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "Improve my skill"}],
                    },
                },
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:02.000Z",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "thinking", "thinking": "plan the edit"},
                            {"type": "text", "text": "I will inspect it."},
                            {
                                "type": "toolCall",
                                "name": "read",
                                "arguments": {
                                    "path": "/repo/.agents/skills/update-skill/SKILL.md"
                                },
                            },
                        ],
                    },
                },
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:03.000Z",
                    "message": {
                        "role": "toolResult",
                        "toolName": "read",
                        "content": [{"type": "text", "text": "--- description: alpha"}],
                    },
                },
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:04.000Z",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "toolCall",
                                "name": "edit",
                                "arguments": {
                                    "path": "/tmp/repo/SKILL.md",
                                    "oldText": "a",
                                    "newText": "b",
                                },
                            },
                        ],
                    },
                },
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:05.000Z",
                    "message": {
                        "role": "toolResult",
                        "toolName": "edit",
                        "content": [
                            {"type": "text", "text": "oldText not found", "isError": True}
                        ],
                    },
                },
            ])

            meta, stats, entries, skills = parse_pi_session(path, {"update-skill"}, False)

            self.assertEqual(meta["id"], "session-1")
            self.assertEqual(meta["cwd"], "/tmp/repo")
            self.assertEqual(meta["originator"], "pi")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 2)
            self.assertEqual(stats["tool_calls"], 2)
            self.assertEqual(stats["repeated_tool_calls"], 0)
            self.assertEqual(stats["error_outputs"], 1)
            self.assertTrue(stats["has_code_edits"])
            self.assertEqual(stats["first_ts"], "2026-08-20T10:00:00.000Z")
            self.assertEqual(stats["last_ts"], "2026-08-20T10:00:05.000Z")
            self.assertEqual(skills, ["update-skill"])
            self.assertIn(("user", "Improve my skill"), entries)
            self.assertIn(("assistant", "I will inspect it."), entries)
            self.assertIn(("output", "--- description: alpha"), entries)
            self.assertFalse(any(role == "thinking" for role, _ in entries))

    def test_accepts_include_subagents_without_changing_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session-2.jsonl"
            write_jsonl(path, [
                {"type": "session", "id": "session-2", "cwd": "/tmp/repo",
                 "timestamp": "2026-08-20T10:00:00.000Z"},
                {"type": "message", "timestamp": "2026-08-20T10:00:01.000Z",
                 "message": {"role": "user", "content": "Hello there"}},
            ])

            without_flag = parse_pi_session(path, set(), False)
            with_flag = parse_pi_session(path, set(), True)

            self.assertEqual(without_flag, with_flag)
            self.assertEqual(with_flag[0]["originator"], "pi")

    def test_finds_recent_session_files_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            pi_home = Path(tmp)
            recent = pi_home / "sessions" / "--tmp-repo" / "recent.jsonl"
            old = pi_home / "sessions" / "--tmp-repo" / "old.jsonl"
            for path in (recent, old):
                write_jsonl(path, [{"type": "session", "id": "x"}])
            old_time = (datetime.now(timezone.utc) - timedelta(days=10)).timestamp()
            os.utime(old, (old_time, old_time))
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)

            files = find_pi_session_files(pi_home, cutoff)

            self.assertEqual([path for _, path in files], [recent])


class GrokSessionTests(unittest.TestCase):
    def test_parses_tool_calls_and_skips_synthetic_messages(self):
        with tempfile.TemporaryDirectory() as tmp:
            grok_home = Path(tmp)
            session_dir = grok_home / "sessions" / "%2Ftmp%2Frepo" / "abc-123"
            path = session_dir / "chat_history.jsonl"
            write_jsonl(path, [
                {"type": "system", "content": "You are Grok."},
                {
                    "type": "user",
                    "synthetic_reason": "system_reminder",
                    "content": [{"type": "text", "text": "<system-reminder>skills</system-reminder>"}],
                },
                {"type": "user", "content": "Fix the collector"},
                {
                    "type": "reasoning",
                    "id": "rs-1",
                    "summary": "[]",
                    "encrypted_content": "xx",
                    "status": "completed",
                },
                {
                    "type": "assistant",
                    "content": "I will read the skill.",
                    "tool_calls": [{
                        "id": "call-1",
                        "name": "read_file",
                        "arguments": "{\"path\": \"/repo/.grok/skills/update-skill/SKILL.md\"}",
                    }],
                },
                {"type": "tool_result", "tool_call_id": "call-1", "content": "file body"},
                {
                    "type": "assistant",
                    "content": "Now writing the file.",
                    "tool_calls": [{
                        "id": "call-2",
                        "name": "write",
                        "arguments": "{\"path\": \"/tmp/repo/out.txt\", \"content\": \"hi\"}",
                    }],
                },
            ])
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)

            files = find_grok_session_files(grok_home, cutoff)
            self.assertEqual([found for _, found in files], [path])

            meta, stats, entries, skills = parse_grok_session(path, {"update-skill"}, False)

            self.assertEqual(meta["id"], "abc-123")
            self.assertEqual(meta["cwd"], "/tmp/repo")
            self.assertEqual(meta["originator"], "grok")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 2)
            self.assertEqual(stats["tool_calls"], 2)
            self.assertEqual(stats["error_outputs"], 0)
            self.assertTrue(stats["has_code_edits"])
            self.assertEqual(skills, ["update-skill"])
            self.assertEqual(entries[0], ("user", "Fix the collector"))
            self.assertNotIn("system-reminder", json.dumps(entries))


class ZcodeSessionTests(unittest.TestCase):
    def test_parses_last_request_messages_and_tool_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model-io-sess_1.jsonl"
            empty_request = {"request": {"body": {"messages": []}}}
            full_request = {
                "request": {
                    "body": {
                        "messages": [
                            {"role": "system", "content": "You are ZCode."},
                            {"role": "user", "content": "Update the skill"},
                            {
                                "role": "assistant",
                                "content": "Checking.",
                                "tool_calls": [{
                                    "id": "c1",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": "{\"path\": \"/r/.agents/skills/update-skill/SKILL.md\"}",
                                    },
                                }],
                            },
                            {"role": "tool", "content": "skill body"},
                        ]
                    }
                }
            }
            path.write_text(
                json.dumps(empty_request) + "\n" + json.dumps(full_request) + "\n"
            )

            meta, stats, entries, skills = parse_zcode_session(path, {"update-skill"}, False)

            self.assertEqual(meta["id"], "sess_1")
            self.assertEqual(meta["originator"], "zcode")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 1)
            self.assertEqual(stats["tool_calls"], 1)
            self.assertEqual(skills, ["update-skill"])
            self.assertEqual(entries[0], ("user", "Update the skill"))

    def test_returns_none_without_request_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model-io-sess_2.jsonl"
            path.write_text("{\"unrelated\": true}\n")

            self.assertIsNone(parse_zcode_session(path, set(), False))


class CodexSessionTests(unittest.TestCase):
    def test_cli_samples_canonical_rollouts_with_shared_session_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex_home = root / "codex-home"
            out_dir = root / "report"
            rollouts = {
                "original": ("pwd", "Original inspection complete"),
                "reverted": ("git status", "Reverted inspection complete"),
            }
            for name, (command, reply) in rollouts.items():
                path = codex_home / "sessions" / f"rollout-{name}.jsonl"
                write_jsonl(path, [
                    {
                        "type": "session_meta",
                        "payload": {"id": "canonical", "cwd": str(root / "project")},
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message", "role": "user",
                            "content": [{"type": "input_text", "text": "Inspect the project"}],
                        },
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call", "name": "exec_command",
                            "arguments": json.dumps({"cmd": command}),
                        },
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message", "role": "assistant",
                            "content": [{"type": "output_text", "text": reply}],
                        },
                    },
                ])

            result = subprocess.run(
                [
                    sys.executable, str(Path(__file__).with_name("collect_sessions.py")),
                    "--harness", "codex", "--codex-home", str(codex_home),
                    "--all-conversations", "--out", str(out_dir),
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            inventory = json.loads((out_dir / "inventory.json").read_text())
            self.assertEqual(inventory["stats"]["sessions_considered"], 2)
            self.assertEqual(inventory["stats"]["sessions_sampled"], 2)
            self.assertEqual(
                len({session["transcript_path"] for session in inventory["sessions"]}),
                2,
            )
            for session in inventory["sessions"]:
                name = Path(session["file"]).stem.removeprefix("rollout-")
                command, reply = rollouts[name]
                with self.subTest(rollout=name):
                    self.assertEqual(session["meta"]["id"], "canonical")
                    self.assertTrue(session["sampled"])
                    self.assertEqual(session["stats"]["user_turns"], 1)
                    self.assertEqual(session["stats"]["assistant_turns"], 1)
                    self.assertEqual(session["stats"]["tool_calls"], 1)
                    transcript = Path(session["transcript_path"]).read_text()
                    self.assertIn(f"Source: {session['file']}", transcript)
                    self.assertIn("[user] Inspect the project", transcript)
                    self.assertIn(f"[assistant] {reply}", transcript)
                    self.assertIn(
                        f"[tool:exec_command] {json.dumps({'cmd': command})}",
                        transcript,
                    )
                    for other_name, (_, other_reply) in rollouts.items():
                        if other_name != name:
                            self.assertNotIn(other_reply, transcript)

            # The executing Codex thread must be excluded even without an explicit flag.
            excluded_out = root / "excluded-report"
            with patch.dict(os.environ, {"CODEX_THREAD_ID": "canonical"}):
                excluded_result = subprocess.run(
                    [
                        sys.executable, str(Path(__file__).with_name("collect_sessions.py")),
                        "--harness", "codex", "--codex-home", str(codex_home),
                        "--all-conversations", "--out", str(excluded_out),
                    ],
                    capture_output=True, text=True, timeout=30,
                )
            self.assertEqual(excluded_result.returncode, 0, excluded_result.stderr)
            excluded_inventory = json.loads((excluded_out / "inventory.json").read_text())
            self.assertEqual(excluded_inventory["stats"]["sessions_eligible"], 0)
            self.assertEqual(excluded_inventory["stats"]["sessions_sampled"], 0)
            self.assertEqual(excluded_inventory["sampling"]["excluded_sessions"], 2)
            self.assertTrue(all(s["excluded_from_sample"] for s in excluded_inventory["sessions"]))

    def test_counts_readable_canonical_messages_once_and_ignores_other_traffic(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout-mixed.jsonl"
            records = [{
                "type": "session_meta",
                "payload": {"id": "mixed", "cwd": "/tmp/project"},
            }]
            for role, texts in (
                ("user", ["Inspect the project"]),
                ("assistant", ["Inspection complete", "No issues found"]),
                ("user", ["<environment_context>injected context</environment_context>"]),
                ("developer", ["Follow developer instructions"]),
                ("system", ["Follow system instructions"]),
                ("user", [""]),
                ("assistant", [""]),
            ):
                records.append({
                    "type": "response_item",
                    "payload": {
                        "type": "message", "role": role,
                        "content": [
                            {"type": "output_text" if role == "assistant" else "input_text", "text": text}
                            for text in texts
                        ],
                    },
                })
                if role in ("user", "assistant"):
                    for text in texts:
                        records.append({
                            "type": "event_msg",
                            "payload": {
                                "type": "agent_message" if role == "assistant" else "user_message",
                                "message": text,
                            },
                        })
            records.append({
                "type": "response_item",
                "payload": {
                    "type": "agent_message", "author": "/root/worker",
                    "recipient": "/root",
                    "content": [{"type": "input_text", "text": "Worker status"}],
                },
            })
            write_jsonl(path, records)

            _, stats, entries, _ = parse_codex_session(path, set(), False)

            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 1)
            self.assertEqual(entries, [
                ("user", "Inspect the project"),
                ("assistant", "Inspection complete\nNo issues found"),
            ])

    def test_first_metadata_owns_session_identity_and_subagent_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout-parent.jsonl"
            write_jsonl(path, [
                {
                    "type": "session_meta",
                    "payload": {
                        "id": "parent", "cwd": "/tmp/project",
                        "originator": "codex", "cli_version": "1.0",
                    },
                },
                {
                    "type": "session_meta",
                    "payload": {
                        "id": "inherited-child", "cwd": "/tmp/other-project",
                        "thread_source": "subagent",
                    },
                },
            ])

            for include_subagents in (False, True):
                with self.subTest(include_subagents=include_subagents):
                    parsed = parse_codex_session(path, set(), include_subagents)
                    self.assertIsNotNone(parsed)
                    meta = parsed[0]
                    self.assertEqual(meta["id"], "parent")
                    self.assertEqual(meta["cwd"], "/tmp/project")
                    self.assertEqual(meta["originator"], "codex")
                    self.assertEqual(meta["cli_version"], "1.0")
                    self.assertIsNone(meta["thread_source"])

    def test_first_subagent_metadata_requires_explicit_inclusion(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout-child.jsonl"
            for source in (
                {"thread_source": "subagent"},
                {"source": {"subagent": {"parent_thread_id": "parent"}}},
            ):
                with self.subTest(source=source):
                    write_jsonl(path, [
                        {
                            "type": "session_meta",
                            "payload": {"id": "child", "cwd": "/tmp/child", **source},
                        },
                        {
                            "type": "session_meta",
                            "payload": {"id": "inherited-parent", "cwd": "/tmp/parent"},
                        },
                    ])

                    self.assertIsNone(parse_codex_session(path, set(), False))
                    meta, _, _, _ = parse_codex_session(path, set(), True)
                    self.assertEqual(meta["id"], "child")
                    self.assertEqual(meta["cwd"], "/tmp/child")


class ManualSkillLoadingTests(unittest.TestCase):
    NATIVE_LOADS = {
        "codex": (
            "<skill>\n<name>example</name>\n"
            "<path>/fixture/skills/example/SKILL.md</path>\n"
            "# Instructions\nFollow the example procedure.\n"
            "See /fixture/skills/reference-only/SKILL.md if needed.\n</skill>"
        ),
        "claude": (
            "Base directory for this skill: /fixture/skills/example\n\n"
            "# Instructions\nFollow the example procedure.\n"
            "See /fixture/skills/reference-only/SKILL.md if needed."
        ),
        "pi": (
            '<skill name="declared-example" location="/fixture/skills/example/SKILL.md">\n'
            "References are relative to /fixture/skills/example.\n\n"
            "# Instructions\nFollow the example procedure.\n"
            "See /fixture/skills/reference-only/SKILL.md if needed.\n</skill>\n\n"
            "Optional arguments"
        ),
    }

    def _message(self, harness, role, text, is_meta=False):
        if harness == "codex":
            return {
                "type": "response_item",
                "payload": {
                    "type": "message", "role": role,
                    "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}],
                },
            }
        return {
            "type": "message" if harness == "pi" else role,
            "isMeta": is_meta,
            "message": {"role": role, "content": text},
        }

    def _parse(self, root, harness, records):
        path = root / f"{harness}.jsonl"
        write_jsonl(path, records)
        parser = {
            "codex": parse_codex_session,
            "claude": parse_claude_session,
            "pi": parse_pi_session,
        }[harness]
        return parser(path, set(), False)

    def test_native_loads_are_skill_entries_without_extra_human_turns(self):
        with tempfile.TemporaryDirectory() as tmp:
            for harness, native_load in self.NATIVE_LOADS.items():
                with self.subTest(harness=harness):
                    records = [self._message(harness, "user", native_load, is_meta=True)]
                    if harness != "pi":
                        records.insert(0, self._message(
                            harness, "user", "$example" if harness == "codex" else "/example",
                        ))
                    if harness == "codex":
                        records[-1]["payload"]["content"].append({
                            "type": "input_text",
                            "text": native_load.replace("<name>example</name>", "<name>namespace:example</name>"),
                        })
                    _, stats, entries, skills = self._parse(Path(tmp), harness, records)

                    self.assertEqual(skills, ["example"])
                    self.assertEqual(stats["user_turns"], 1)
                    skill_entries = [text for role, text in entries if role.startswith("skill:")]
                    self.assertEqual(len(skill_entries), 2 if harness == "codex" else 1)
                    self.assertIn("Follow the example procedure.", skill_entries[0])
                    if harness == "pi":
                        self.assertIn(("user", "Optional arguments"), entries)

                    if harness == "codex":
                        records.append({
                            "type": "response_item",
                            "payload": {
                                "type": "function_call", "name": "read_file",
                                "arguments": '{"path": "/fixture/skills/example/SKILL.md"}',
                            },
                        })
                    elif harness == "claude":
                        records.append({
                            "type": "assistant",
                            "message": {"role": "assistant", "content": [{
                                "type": "tool_use", "name": "Skill",
                                "input": {"skill": "example"},
                            }]},
                        })
                    else:
                        records.append({
                            "type": "message",
                            "message": {"role": "assistant", "content": [{
                                "type": "toolCall", "name": "read",
                                "arguments": {"path": "/fixture/skills/example/SKILL.md"},
                            }]},
                        })
                    self.assertEqual(self._parse(Path(tmp), harness, records)[3], ["example"])

    def test_native_load_candidates_survive_transcript_omission(self):
        with tempfile.TemporaryDirectory() as tmp:
            for harness, native_load in self.NATIVE_LOADS.items():
                with self.subTest(harness=harness):
                    records = [] if harness == "pi" else [
                        self._message(harness, "user", "Run the example procedure."),
                    ]
                    records.extend(
                        self._message(harness, "assistant", f"Before loading {index}")
                        for index in range(100)
                    )
                    records.append(self._message(harness, "user", native_load, is_meta=True))
                    records.extend(
                        self._message(harness, "assistant", f"After loading {index}")
                        for index in range(100)
                    )

                    _, stats, entries, skills = self._parse(Path(tmp), harness, records)

                    self.assertEqual(skills, ["example"])
                    self.assertEqual(stats["user_turns"], 1)
                    self.assertTrue(any(role == "note" and "omitted" in text for role, text in entries))
                    self.assertFalse(any(role.startswith("skill:") for role, _ in entries))
                    self.assertNotIn("Follow the example procedure.", json.dumps(entries))

    def test_commands_prose_and_quoted_loads_do_not_prove_skill_loading(self):
        with tempfile.TemporaryDirectory() as tmp:
            for harness, native_load in self.NATIVE_LOADS.items():
                examples = [
                    "$example",
                    "/example",
                    "Mention example and /fixture/skills/example/SKILL.md in the report.",
                    f"Here is an example skill load:\n{native_load}",
                    f"```text\n{native_load}\n```",
                    "\n".join(f"> {line}" for line in native_load.splitlines()),
                ]
                records = [
                    self._message(harness, "user", text, is_meta=True)
                    for text in examples
                ]
                if harness == "claude":
                    records.append(self._message(harness, "user", native_load))
                with self.subTest(harness=harness):
                    _, _, entries, skills = self._parse(Path(tmp), harness, records)

                    self.assertEqual(skills, [])
                    self.assertFalse(any(role.startswith("skill:") for role, _ in entries))

    def test_cli_discovers_project_skill_after_native_manual_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "project"
            skill_path = repo / ".agents" / "skills" / "example" / "SKILL.md"
            skill_path.parent.mkdir(parents=True)
            skill_path.write_text(
                "---\nname: example\ndescription: Example procedure\n"
                "disable-model-invocation: true\n---\nFollow the example procedure.\n"
            )
            reference_skill = repo / ".agents" / "skills" / "reference-only" / "SKILL.md"
            reference_skill.parent.mkdir(parents=True)
            reference_skill.write_text("---\nname: reference-only\ndescription: Reference only\n---\n")
            subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
            codex_home = root / "codex-home"
            out_dir = root / "report"
            native_load = self.NATIVE_LOADS["codex"].replace(
                "/fixture/skills/example/SKILL.md", str(skill_path),
            ).replace(
                "<name>example</name>", "<name>reference-only</name>",
            )
            write_jsonl(codex_home / "sessions" / "rollout-manual.jsonl", [
                {
                    "type": "session_meta",
                    "payload": {"id": "manual", "cwd": str(repo)},
                },
                self._message("codex", "user", "$example"),
                self._message("codex", "user", native_load),
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call", "name": "exec_command",
                        "arguments": '{"cmd": "pwd"}',
                    },
                },
                self._message("codex", "assistant", "Procedure complete."),
            ])

            result = subprocess.run(
                [
                    sys.executable, str(Path(__file__).with_name("collect_sessions.py")),
                    "--harness", "codex", "--codex-home", str(codex_home),
                    "--all-conversations", "--out", str(out_dir),
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            inventory = json.loads((out_dir / "inventory.json").read_text())
            self.assertEqual(inventory["stats"]["skills_found"], 2)
            self.assertEqual(inventory["stats"]["sessions_sampled"], 1)
            self.assertEqual(inventory["skill_usage"], {"example": 1, "reference-only": 0})
            session = inventory["sessions"][0]
            self.assertEqual(session["skills_used"], ["example"])
            self.assertEqual(session["stats"]["user_turns"], 1)
            self.assertTrue(session["sampled"])
            transcript = Path(session["transcript_path"]).read_text()
            self.assertIn("[skill:reference-only]", transcript)
            self.assertIn("Follow the example procedure.", transcript)


class StreamingSessionReadTests(unittest.TestCase):
    def test_claude_and_codex_parse_records_after_previous_file_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            claude_path = root / "claude.jsonl"
            codex_path = root / "codex.jsonl"
            write_jsonl_past_previous_limit(
                claude_path,
                {
                    "type": "user",
                    "sessionId": "claude-session",
                    "cwd": "/tmp/repo",
                    "timestamp": "2026-08-30T10:00:00Z",
                    "message": {"role": "user", "content": "hello"},
                },
                [{
                    "type": "assistant",
                    "sessionId": "claude-session",
                    "cwd": "/tmp/repo",
                    "timestamp": "2026-08-30T10:01:00Z",
                    "message": {
                        "id": "late-message",
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": "late claude message"},
                            {
                                "type": "tool_use",
                                "name": "Read",
                                "input": {
                                    "file_path": "/tmp/.agents/skills/late-skill/SKILL.md"
                                },
                            },
                        ],
                    },
                }],
            )
            write_jsonl_past_previous_limit(
                codex_path,
                {
                    "type": "session_meta",
                    "payload": {"id": "codex-session", "cwd": "/tmp/repo"},
                },
                [{
                    "type": "response_item",
                    "timestamp": "2026-08-30T10:00:30Z",
                    "payload": {
                        "type": "function_call",
                        "name": "read_file",
                        "arguments": {
                            "path": "/tmp/.codex/skills/late-skill/SKILL.md",
                            "operation": "apply_patch",
                        },
                    },
                }, {
                    "type": "response_item",
                    "timestamp": "2026-08-30T10:01:00Z",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "late codex message"}],
                    },
                }],
            )

            parsed_claude = parse_claude_session(claude_path, {"late-skill"}, False)
            parsed_codex = parse_codex_session(codex_path, {"late-skill"}, False)

            self.assertEqual(parsed_claude[1]["assistant_turns"], 1)
            self.assertEqual(parsed_claude[1]["tool_calls"], 1)
            self.assertEqual(parsed_claude[3], ["late-skill"])
            self.assertIn(("assistant", "late claude message"), parsed_claude[2])
            self.assertEqual(parsed_codex[1]["assistant_turns"], 1)
            self.assertEqual(parsed_codex[1]["tool_calls"], 1)
            self.assertTrue(parsed_codex[1]["has_code_edits"])
            self.assertEqual(parsed_codex[3], ["late-skill"])
            self.assertIn(("assistant", "late codex message"), parsed_codex[2])

    def test_codex_keeps_only_transcript_head_and_tail_while_parsing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "codex.jsonl"
            records = [{
                "type": "session_meta",
                "payload": {"id": "codex-session", "cwd": "/tmp/repo"},
            }]
            for index in range(201):
                records.extend(({
                    "type": "event_msg",
                    "payload": {"type": "agent_message"},
                }, {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": f"message-{index}"}],
                    },
                }))
            write_jsonl(path, records)

            _, stats, entries, _ = parse_codex_session(path, set(), False)

            self.assertEqual(stats["assistant_turns"], 201)
            self.assertEqual(len(entries), 141)
            self.assertEqual(entries[0], ("assistant", "message-0"))
            self.assertEqual(entries[99], ("assistant", "message-99"))
            self.assertEqual(entries[100], ("note", "[... 61 entries omitted ...]"))
            self.assertEqual(entries[101], ("assistant", "message-161"))
            self.assertEqual(entries[-1], ("assistant", "message-200"))


class HermesCollectorTests(unittest.TestCase):
    def _make_db(self, root):
        import sqlite3

        db_path = root / "state.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """CREATE TABLE sessions (
                id TEXT, source TEXT, cwd TEXT, title TEXT, display_name TEXT,
                parent_session_id TEXT, started_at REAL, last_activity_at REAL, ended_at REAL)"""
        )
        conn.execute(
            """CREATE TABLE messages (
                session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL)"""
        )
        return conn

    def test_parse_hermes_session_extracts_stats_and_skills(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._make_db(Path(tmp))
            base = 1_800_000_000.0
            conn.execute(
                "INSERT INTO sessions VALUES ('s1','cli','/tmp/repo','t','d',NULL,?,?,?)",
                (base, base + 60, base + 60),
            )
            conn.execute(
                "INSERT INTO messages VALUES ('s1','user','do the thing',NULL,?)", (base,)
            )
            tool_calls = json.dumps([
                {"function": {"name": "skill_view", "arguments": "{\"name\":\"my-skill\"}"}},
                {"function": {"name": "terminal", "arguments": "ls"}},
            ])
            conn.execute(
                "INSERT INTO messages VALUES ('s1','assistant','ok',?,?)", (tool_calls, base + 1)
            )
            conn.execute(
                "INSERT INTO messages VALUES ('s1','tool','error: boom',NULL,?)", (base + 2,)
            )
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM sessions").fetchone()

            parsed = parse_hermes_session(conn, row, {"my-skill"}, False)

            self.assertIsNotNone(parsed)
            meta, stats, entries, skills_used = parsed
            self.assertEqual(meta["id"], "s1")
            self.assertEqual(meta["started_at"], datetime.fromtimestamp(base, tz=timezone.utc).isoformat())
            self.assertEqual(meta["timestamp"], datetime.fromtimestamp(base + 2, tz=timezone.utc).isoformat())
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 1)
            self.assertEqual(stats["tool_calls"], 2)
            self.assertEqual(stats["error_outputs"], 1)
            self.assertEqual(stats["first_ts"], datetime.fromtimestamp(base, tz=timezone.utc).isoformat())
            self.assertEqual(stats["last_ts"], datetime.fromtimestamp(base + 2, tz=timezone.utc).isoformat())
            self.assertEqual(skills_used, ["my-skill"])

    def test_parse_hermes_session_skips_injected_user_content(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._make_db(Path(tmp))
            base = 1_800_000_000.0
            conn.execute(
                "INSERT INTO sessions VALUES ('s-inj','cli','/tmp/repo',NULL,NULL,NULL,?,?,?)",
                (base, base + 60, base + 60),
            )
            conn.execute(
                "INSERT INTO messages VALUES ('s-inj','user','<environment_context injected>',NULL,?)",
                (base,),
            )
            conn.execute(
                "INSERT INTO messages VALUES ('s-inj','assistant','ok',?,?)",
                (json.dumps([{"function": {"name": "terminal", "arguments": "ls"}}]), base + 1),
            )
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM sessions WHERE id='s-inj'").fetchone()

            parsed = parse_hermes_session(conn, row, set(), False)

            self.assertIsNotNone(parsed)
            _, stats, entries, _ = parsed
            self.assertEqual(stats["user_turns"], 0)
            self.assertFalse(any(role == "user" for role, _ in entries))

    def test_parse_hermes_session_skips_subagents(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._make_db(Path(tmp))
            base = 1_800_000_000.0
            conn.execute(
                "INSERT INTO sessions VALUES ('s2','subagent','/tmp',NULL,NULL,'parent',?,?,?)",
                (base, base, base),
            )
            conn.execute(
                "INSERT INTO messages VALUES ('s2','assistant','hi',?,?)",
                (json.dumps([{"function": {"name": "terminal", "arguments": "ls"}}]), base),
            )
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM sessions").fetchone()

            self.assertIsNone(parse_hermes_session(conn, row, set(), False))
            self.assertIsNotNone(parse_hermes_session(conn, row, set(), True))

    def test_find_hermes_sessions_filters_by_cutoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            conn = self._make_db(root)
            old, new = 1_000_000_000.0, datetime.now(tz=timezone.utc).timestamp()
            for sid, started_at, last_activity_at, ended_at in (
                ("old", old, old, old),
                ("recent", new - 30, new - 30, new - 30),
                ("completed", old, None, new),
            ):
                conn.execute(
                    "INSERT INTO sessions VALUES (?,?,?,?,?,NULL,?,?,?)",
                    (sid, "cli", "/tmp", None, None, started_at, last_activity_at, ended_at),
                )
            conn.commit()
            conn.close()

            records, scanned = find_hermes_sessions(
                [root / "state.db"], datetime.fromtimestamp(new - 60, tz=timezone.utc)
            )

            self.assertEqual(scanned, 2)
            self.assertEqual([row["id"] for _, row in records], ["completed", "recent"])

    def test_find_hermes_sessions_skips_incompatible_messages_schema(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path = root / "state.db"
            conn = sqlite3.connect(db_path)
            conn.execute(
                """CREATE TABLE sessions (
                    id TEXT, source TEXT, cwd TEXT, title TEXT, display_name TEXT,
                    parent_session_id TEXT, started_at REAL, last_activity_at REAL, ended_at REAL)"""
            )
            conn.execute(
                """CREATE TABLE messages (
                    session_id TEXT, role TEXT, content TEXT, timestamp REAL)"""
            )
            ts = datetime.now(tz=timezone.utc).timestamp()
            conn.execute(
                "INSERT INTO sessions VALUES ('bad','cli','/tmp',NULL,NULL,NULL,?,?,?)",
                (ts, ts, ts),
            )
            conn.commit()
            conn.close()

            records, scanned = find_hermes_sessions(
                [db_path], datetime.fromtimestamp(ts - 60, tz=timezone.utc)
            )

            self.assertEqual(records, [])
            self.assertEqual(scanned, 0)

    def test_parse_hermes_session_counts_repeated_calls_by_name_and_args(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._make_db(Path(tmp))
            base = 1_800_000_000.0
            conn.execute(
                "INSERT INTO sessions VALUES ('s3','cli','/tmp/repo',NULL,NULL,NULL,?,?,?)",
                (base, base + 60, base + 60),
            )
            tool_calls = json.dumps([
                {"function": {"name": "terminal", "arguments": "ls"}},
                {"function": {"name": "terminal", "arguments": "pwd"}},
                {"function": {"name": "terminal", "arguments": "ls"}},
            ])
            conn.execute(
                "INSERT INTO messages VALUES ('s3','assistant','ok',?,?)", (tool_calls, base + 1)
            )
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM sessions WHERE id='s3'").fetchone()

            parsed = parse_hermes_session(conn, row, set(), False)

            self.assertIsNotNone(parsed)
            _, stats, _, _ = parsed
            self.assertEqual(stats["tool_calls"], 3)
            self.assertEqual(stats["repeated_tool_calls"], 1)

    def test_parse_hermes_session_handles_non_string_tool_args(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._make_db(Path(tmp))
            base = 1_800_000_000.0
            conn.execute(
                "INSERT INTO sessions VALUES ('s4','cli','/tmp/repo',NULL,NULL,NULL,?,?,?)",
                (base, base + 60, base + 60),
            )
            tool_calls = json.dumps([
                {"function": {"name": "skill_view", "arguments": {"name": "my-skill"}}},
            ])
            conn.execute(
                "INSERT INTO messages VALUES ('s4','assistant','ok',?,?)", (tool_calls, base + 1)
            )
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM sessions WHERE id='s4'").fetchone()

            parsed = parse_hermes_session(conn, row, {"my-skill"}, False)

            self.assertIsNotNone(parsed)
            _, stats, entries, skills_used = parsed
            self.assertEqual(stats["tool_calls"], 1)
            self.assertIn(("tool:skill_view", '{"name": "my-skill"}'), entries)
            self.assertEqual(skills_used, ["my-skill"])

    def test_parse_hermes_session_reads_top_level_tool_call_shape(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            conn = self._make_db(Path(tmp))
            base = 1_800_000_000.0
            conn.execute(
                "INSERT INTO sessions VALUES ('s5','cli','/tmp/repo',NULL,NULL,NULL,?,?,?)",
                (base, base + 60, base + 60),
            )
            tool_calls = json.dumps([
                {"name": "skill_view", "arguments": '{"name":"my-skill"}'},
            ])
            conn.execute(
                "INSERT INTO messages VALUES ('s5','assistant','ok',?,?)", (tool_calls, base + 1)
            )
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM sessions WHERE id='s5'").fetchone()

            parsed = parse_hermes_session(conn, row, {"my-skill"}, False)

            self.assertIsNotNone(parsed)
            _, stats, entries, skills_used = parsed
            self.assertEqual(stats["tool_calls"], 1)
            self.assertIn(("tool:skill_view", '{"name":"my-skill"}'), entries)
            self.assertEqual(skills_used, ["my-skill"])

    def test_discover_hermes_databases_resolves_relative_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes-home"
            hermes_home.mkdir()
            (hermes_home / "state.db").write_text("sqlite")

            old_cwd = Path.cwd()
            try:
                os.chdir(root)
                discovered = discover_hermes_databases("hermes-home")
            finally:
                os.chdir(old_cwd)

            self.assertEqual(discovered[0], (hermes_home / "state.db").resolve())

    def test_discover_hermes_databases_explicit_path_is_authoritative(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            env_home = home / "env-hermes"
            env_home.mkdir()
            (env_home / "state.db").write_text("sqlite")
            bad_path = home / "does-not-exist"

            old_home = os.environ.get("HOME")
            old_hermes_home = os.environ.get("HERMES_HOME")
            try:
                os.environ["HOME"] = str(home)
                os.environ["HERMES_HOME"] = str(env_home)
                discovered = discover_hermes_databases(str(bad_path))
            finally:
                if old_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = old_home
                if old_hermes_home is None:
                    os.environ.pop("HERMES_HOME", None)
                else:
                    os.environ["HERMES_HOME"] = old_hermes_home

            self.assertEqual(discovered, [])

    def test_resolve_hermes_home_prefers_dot_hermes_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            dot_hermes = home / ".hermes"
            dot_hermes.mkdir()
            (dot_hermes / "state.db").write_text("sqlite")

            old_home = os.environ.get("HOME")
            old_hermes_home = os.environ.get("HERMES_HOME")
            try:
                os.environ["HOME"] = str(home)
                os.environ.pop("HERMES_HOME", None)
                resolved = resolve_hermes_home(None)
            finally:
                if old_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = old_home
                if old_hermes_home is None:
                    os.environ.pop("HERMES_HOME", None)
                else:
                    os.environ["HERMES_HOME"] = old_hermes_home

            self.assertEqual(resolved, dot_hermes.resolve())


if __name__ == "__main__":
    unittest.main()
