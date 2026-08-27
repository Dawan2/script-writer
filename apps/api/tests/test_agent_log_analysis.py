from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.services.agent_log_analysis import scan_semantic_operations


class AgentLogAnalysisTest(unittest.TestCase):
    def test_semantic_operation_classification(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            agents = root / "Agents"
            workspace = agents / "workspaces" / "demo"
            batch_file = workspace / "runtime/jobs/51/full-batches/011-015.md"
            log_path = root / "agent_job_51.jsonl"
            entries: list[dict] = []

            def call(call_id: str, name: str, tool_input: dict, content: str, *, error: bool = False) -> None:
                entries.extend([
                    {
                        "type": "assistant",
                        "message": {"content": [{
                            "type": "tool_use", "id": call_id, "name": name, "input": tool_input,
                        }]},
                    },
                    {
                        "type": "user",
                        "message": {"content": [{
                            "type": "tool_result", "tool_use_id": call_id,
                            "content": content, "is_error": error,
                        }]},
                    },
                ])

            validate = (
                f'node "{agents}/.claude/skills/full_generate/scripts/full-draft-tool.mjs" '
                f'validate --workspace "{workspace}" --job-id "51" --range "11-15"'
            )
            call("validate-1", "Bash", {"command": validate}, "quality gate 未通过", error=True)
            call("validate-2", "Bash", {"command": validate}, "quality gate 未通过", error=True)
            call(
                "edit-1",
                "Edit",
                {"file_path": str(batch_file), "old_string": "旧台词", "new_string": "新台词"},
                "updated",
            )
            call("validate-3", "Bash", {"command": validate}, "ok")

            read_input = {"file_path": str(workspace / "runtime/jobs/51/stage-context.json")}
            call("read-1", "Read", read_input, "same context")
            call("read-2", "Read", read_input, "same context")

            status = (
                f'node "{agents}/.claude/skills/full_generate/scripts/full-draft-tool.mjs" '
                f'status --workspace "{workspace}" --job-id "51"'
            )
            call("status-1", "Bash", {"command": status}, "API Error: 429 model cooldown", error=True)
            call("status-2", "Bash", {"command": status}, "ok")

            for index, episode_range in enumerate(("1-5", "6-10", "11-15"), start=1):
                command = (
                    f'node "{agents}/.claude/skills/_shared/scripts/memory-tool.mjs" episode '
                    f'--workspace "{workspace}" --job-id "51" --range "{episode_range}"'
                )
                call(f"memory-{index}", "Bash", {"command": command}, "ok")

            log_path.write_text(
                "".join(f"{json.dumps(entry, ensure_ascii=False)}\n" for entry in entries),
                encoding="utf-8",
            )
            summary, operations = scan_semantic_operations(
                [{"id": 51, "raw_log_path": str(log_path)}],
                repo_root=root,
                agents_dir=agents,
            )

        classes = [item["classification"] for item in operations]
        self.assertIn("blind_retry", classes)
        self.assertIn("repair_retry", classes)
        self.assertIn("cached_repeat", classes)
        self.assertIn("infra_retry", classes)
        self.assertIn("fan_out", classes)
        self.assertEqual(summary["analysis_version"], "2.0.0")
        self.assertEqual(summary["tool_counts"]["Bash"], 8)
        self.assertEqual(summary["classification_counts"]["fan_out"], 1)

        repair = next(item for item in operations if item["classification"] == "repair_retry")
        self.assertEqual(repair["operation"], "full_draft.validate")
        self.assertEqual(repair["target"], "episode_range:11-15")
        self.assertTrue(repair["occurrences"][0]["intervening_write_hashes"])
        self.assertIn("--job-id <job_id>", repair["normalized_arguments"])
        self.assertNotIn("新台词", json.dumps(operations, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
