from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import ai_skill_runner


class AiSkillRunnerTest(unittest.TestCase):
    def test_retries_with_fallback_model_after_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            call_keys: list[str] = []

            def fake_run(command, **kwargs):
                api_key = kwargs["env"]["ANTHROPIC_AUTH_TOKEN"]
                call_keys.append(api_key)
                if api_key == "primary-key":
                    raise subprocess.TimeoutExpired(command, 30)
                return subprocess.CompletedProcess(command, 0, stdout="fallback completed", stderr="")

            runtime = {
                "model_type": "claude_code",
                "api_key": "primary-key",
                "model_name": "primary-model",
                "thinking_level": "high",
                "fallback": {
                    "model_type": "claude_code",
                    "api_key": "fallback-key",
                    "model_name": "fallback-model",
                    "thinking_level": "medium",
                },
            }
            with patch.object(ai_skill_runner.subprocess, "run", side_effect=fake_run):
                result = ai_skill_runner.run_ai_skill(
                    "处理任务",
                    log_path=root / "fallback.log",
                    timeout_seconds=30,
                    model_runtime=runtime,
                )

            self.assertEqual(result.returncode, 0)
            self.assertEqual(call_keys, ["primary-key", "fallback-key"])
            self.assertIn("fallback completed", (root / "fallback.log").read_text(encoding="utf-8"))

    def test_zdebug_wrapper_captures_streamed_skill_run(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            fake_claude = root / "fake-claude.mjs"
            fake_claude.write_text(
                """
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "result", result: `# 报告\\n\\n${prompt}` }));
});
""".strip()
                + "\n",
                encoding="utf-8",
            )
            runtime_log_path = root / "analysis.jsonl"
            plain_log_path = root / "analysis.log"
            settings = SimpleNamespace(repo_root=repo_root, agents_dir=root)
            environment = {
                "ORCA_CLAUDE_PATH": str(fake_claude),
                "ORCA_NODE_PATH": "node",
                "ORCA_CLAUDE_DANGEROUS_SKIP_PERMISSIONS": "0",
            }

            with patch.object(ai_skill_runner, "settings", settings), patch.dict(
                os.environ, environment, clear=False
            ):
                result = ai_skill_runner.run_ai_skill(
                    "只分析证据",
                    log_path=plain_log_path,
                    timeout_seconds=10,
                    disable_tools=True,
                    persist_session=False,
                    runtime_log_path=runtime_log_path,
                    runtime_id="agent-evolution-9",
                )

            self.assertEqual(result.returncode, 0)
            result_payload = next(
                json.loads(line)
                for line in result.stdout.splitlines()
                if json.loads(line).get("type") == "result"
            )
            self.assertEqual(result_payload["result"], "# 报告\n\n只分析证据")
            entries = [
                json.loads(line)
                for line in runtime_log_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(entries[0]["type"], "zdebug_start")
            self.assertEqual(entries[0]["job_id"], "agent-evolution-9")
            tools_index = entries[0]["args"].index("--tools")
            self.assertEqual(entries[0]["args"][tools_index + 1], "")
            self.assertIn("--strict-mcp-config", entries[0]["args"])
            self.assertNotIn("--allowedTools", entries[0]["args"])
            self.assertTrue(any(entry.get("type") == "result" for entry in entries))
            self.assertEqual(entries[-1]["type"], "zdebug_end")
            self.assertTrue(plain_log_path.is_file())


if __name__ == "__main__":
    unittest.main()
