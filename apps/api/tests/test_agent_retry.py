from __future__ import annotations

import errno
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import agent_runner


class AgentRetryTest(unittest.TestCase):
    def test_full_episode_prompt_reads_stored_maturity_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            (workspace / "1.1-user-input.json").write_text(
                '{"project":{"distribution_brief":{"episode_duration":"120 秒","maturity_target":"R限制级影片，允许大量血腥暴力、性爱画面、持续粗口、毒品描写"}}}',
                encoding="utf-8",
            )

            prompt = agent_runner.full_episode_playability_prompt(workspace)

        self.assertIn("单集目标时长：120 秒", prompt)
        self.assertIn("内容分级：R限制级影片，允许大量血腥暴力、性爱画面、持续粗口、毒品描写", prompt)

    def test_full_episode_prompt_defaults_to_pg13_for_missing_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            prompt = agent_runner.full_episode_playability_prompt(Path(temporary_directory))

        self.assertIn(f"内容分级：{agent_runner.DEFAULT_MATURITY_TARGET}", prompt)

    def test_provisional_stream_error_is_cleared_by_success_result(self) -> None:
        cause = agent_runner.update_model_unavailable_cause(
            None,
            {
                "type": "stream_event",
                "event": {
                    "type": "message_start",
                    "message": "Upstream service temporarily unavailable",
                },
            },
        )
        self.assertIsNotNone(cause)

        cause = agent_runner.update_model_unavailable_cause(
            cause,
            {"type": "result", "is_error": False, "result": "OK"},
        )
        self.assertIsNone(cause)

    def test_temporary_upstream_400_is_retryable_model_unavailability(self) -> None:
        error = agent_runner.classify_agent_failure(
            "API Error: 400 Upstream service temporarily unavailable",
            return_code=1,
        )

        self.assertIsInstance(error, agent_runner.ModelUnavailableError)
        self.assertEqual(error.code, "MODEL_COOLDOWN")
        self.assertTrue(error.retryable)
        self.assertIn("Upstream service temporarily unavailable", error.root_cause)

    def test_argument_length_failure_is_not_retried_as_a_transport_failure(self) -> None:
        error = agent_runner.classify_agent_failure(OSError(errno.E2BIG, "Argument list too long"))

        self.assertEqual(error.code, "INPUT_TRANSPORT_LIMIT")
        self.assertFalse(error.retryable)
        self.assertIsNone(agent_runner.automatic_recovery_policy(error))

    def test_network_failure_uses_the_bounded_reconnect_policy(self) -> None:
        error = agent_runner.classify_agent_failure("request timed out while connecting to the upstream service")
        policy = agent_runner.automatic_recovery_policy(error)

        self.assertEqual(error.code, "NETWORK_TRANSIENT")
        self.assertTrue(error.retryable)
        self.assertIsNotNone(policy)
        self.assertEqual(policy.delays, agent_runner.NETWORK_TRANSIENT_RETRY_DELAYS)

    def test_recovery_budget_is_isolated_by_failure_category(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute(
            """
            CREATE TABLE agent_job_recovery_attempts (
                job_id INTEGER NOT NULL,
                scope TEXT NOT NULL,
                recovery_group TEXT NOT NULL,
                reason_code TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                retry_limit INTEGER NOT NULL,
                delay_seconds INTEGER NOT NULL,
                strategy TEXT NOT NULL,
                checkpoint_path TEXT,
                status TEXT NOT NULL,
                root_cause TEXT,
                started_at TEXT,
                finished_at TEXT,
                UNIQUE(job_id, scope, recovery_group, attempt)
            )
            """
        )
        model_error = agent_runner.ModelUnavailableError(root_cause="model cooling down")
        network_error = agent_runner.classify_agent_failure("ETIMEDOUT")

        model_plan = agent_runner.plan_automatic_recovery(
            connection,
            job_id=72,
            scope="stage:novel_analysis",
            error=model_error,
        )
        assert model_plan is not None
        agent_runner.mark_automatic_recovery_attempt(
            connection,
            job_id=72,
            scope="stage:novel_analysis",
            group=model_plan.group,
            attempt=model_plan.attempt,
            status_value="failed",
        )
        network_plan = agent_runner.plan_automatic_recovery(
            connection,
            job_id=72,
            scope="stage:novel_analysis",
            error=network_error,
        )

        self.assertIsNotNone(network_plan)
        assert network_plan is not None
        self.assertNotEqual(model_plan.group, network_plan.group)
        self.assertEqual(network_plan.attempt, 1)
        self.assertEqual(network_plan.delay_seconds, agent_runner.NETWORK_TRANSIENT_RETRY_DELAYS[0])
        connection.close()

    def test_agent_process_environment_removes_deprecated_large_prompt_channel(self) -> None:
        with patch.dict(os.environ, {"ORCA_ZDEBUG_USER_INPUT": "小说正文" * 20_000}, clear=False):
            environment = agent_runner.agent_process_environment()

        self.assertNotIn("ORCA_ZDEBUG_USER_INPUT", environment)

    def test_model_prompt_is_persisted_outside_the_command_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            long_prompt = "小说正文资料\n" + ("第十章剧情内容。" * 20_000)

            launcher_prompt, input_path = agent_runner.model_prompt_input(
                workspace,
                job_id=71,
                label="novel-read-001",
                prompt=long_prompt,
            )
            self.assertIsNotNone(input_path)
            assert input_path is not None
            command = agent_runner._full_worker_command(
                launcher_prompt,
                "session-71",
                workspace / "worker.jsonl",
                prompt_input_file=input_path,
                structured_output=True,
            )

            self.assertEqual(input_path.read_text(encoding="utf-8"), long_prompt)
            self.assertIn("runtime/jobs/71/model-inputs", str(input_path))
            self.assertLess(len(launcher_prompt), 500)
            self.assertNotIn(long_prompt, launcher_prompt)
            self.assertIn("--pipe-stdin", command)
            self.assertIn("--user-input-file", command)
            self.assertIn(str(input_path), command)
            self.assertTrue(all(long_prompt not in item for item in command))
            prompt_index = command.index("-p")
            self.assertEqual(command[prompt_index + 1], "--output-format")
            tools_index = command.index("--tools")
            self.assertEqual(command[tools_index + 1], "Read")

    def test_recovery_attempts_are_persisted_and_reuse_an_unstarted_plan(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute(
            """
            CREATE TABLE agent_job_recovery_attempts (
                job_id INTEGER NOT NULL,
                scope TEXT NOT NULL,
                recovery_group TEXT NOT NULL,
                reason_code TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                retry_limit INTEGER NOT NULL,
                delay_seconds INTEGER NOT NULL,
                strategy TEXT NOT NULL,
                checkpoint_path TEXT,
                status TEXT NOT NULL,
                root_cause TEXT,
                started_at TEXT,
                finished_at TEXT,
                UNIQUE(job_id, scope, recovery_group, attempt)
            )
            """
        )
        error = agent_runner.AgentExecutionError(
            "NETWORK_TRANSIENT", "runtime", True, "连接暂时中断", root_cause="ETIMEDOUT"
        )
        checkpoint = Path("/tmp/model-input.md")

        first = agent_runner.plan_automatic_recovery(
            connection,
            job_id=71,
            scope="stage:novel_analysis",
            error=error,
            checkpoint_path=checkpoint,
        )
        repeated = agent_runner.plan_automatic_recovery(
            connection,
            job_id=71,
            scope="stage:novel_analysis",
            error=error,
            checkpoint_path=checkpoint,
        )
        self.assertIsNotNone(first)
        self.assertEqual(repeated, first)

        assert first is not None
        agent_runner.mark_automatic_recovery_attempt(
            connection,
            job_id=71,
            scope="stage:novel_analysis",
            group=first.group,
            attempt=first.attempt,
            status_value="running",
        )
        agent_runner.mark_automatic_recovery_attempt(
            connection,
            job_id=71,
            scope="stage:novel_analysis",
            group=first.group,
            attempt=first.attempt,
            status_value="failed",
        )
        plans = [first]
        for _ in range(2):
            plan = agent_runner.plan_automatic_recovery(
                connection,
                job_id=71,
                scope="stage:novel_analysis",
                error=error,
                checkpoint_path=checkpoint,
            )
            self.assertIsNotNone(plan)
            assert plan is not None
            plans.append(plan)
            agent_runner.mark_automatic_recovery_attempt(
                connection,
                job_id=71,
                scope="stage:novel_analysis",
                group=plan.group,
                attempt=plan.attempt,
                status_value="running",
            )
            agent_runner.mark_automatic_recovery_attempt(
                connection,
                job_id=71,
                scope="stage:novel_analysis",
                group=plan.group,
                attempt=plan.attempt,
                status_value="failed",
            )

        self.assertEqual([plan.delay_seconds for plan in plans], list(agent_runner.NETWORK_TRANSIENT_RETRY_DELAYS))
        self.assertIsNone(agent_runner.plan_automatic_recovery(
            connection,
            job_id=71,
            scope="stage:novel_analysis",
            error=error,
            checkpoint_path=checkpoint,
        ))
        agent_runner.mark_automatic_recovery_attempt(
            connection,
            job_id=71,
            scope="stage:novel_analysis",
            group=plans[-1].group,
            status_value="exhausted",
        )
        rows = connection.execute(
            "SELECT attempt, delay_seconds, checkpoint_path, status FROM agent_job_recovery_attempts ORDER BY attempt"
        ).fetchall()
        self.assertEqual([row["attempt"] for row in rows], [1, 2, 3])
        self.assertEqual(rows[-1]["status"], "exhausted")
        self.assertTrue(all(row["checkpoint_path"] == str(checkpoint) for row in rows))
        connection.close()

    def test_scene_review_retries_only_the_interrupted_chunk(self) -> None:
        class FinishedProcess:
            created = 0

            def __init__(self, *_args, **_kwargs) -> None:
                type(self).created += 1
                self.pid = 60_000 + type(self).created
                self.returncode = 1 if type(self).created == 1 else 0

            def poll(self) -> int:
                return self.returncode

        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            chunk = {
                "id": "scene-001",
                "range": {"start": 1, "end": 1},
                "title": "开场冲突",
                "goal": "主角必须在威胁下作出选择。",
                "handoff_contract": "结尾保留下一集的追问。",
                "source": "第1集\n主角拒绝交出证据。",
                "line_start": 1,
                "line_end": 2,
            }
            review = {
                "schema_version": "1.0.0",
                "review_id": "scene-001",
                "source_hash": "script-hash",
                "range": {"start": 1, "end": 1},
                "status": "passed",
                "summary": "主角的拒绝与威胁形成清晰冲突，并留下下一集追问。",
                "issues": [],
            }
            worker_settings = SimpleNamespace(
                agents_dir=workspace,
                repo_root=workspace,
                full_generate_parallel_workers=1,
                agent_worker_response_stall_seconds=600,
            )
            with (
                patch.object(agent_runner, "settings", worker_settings),
                patch.object(agent_runner.subprocess, "Popen", FinishedProcess),
                patch.object(agent_runner, "_tail_text", return_value="ETIMEDOUT"),
                patch.object(agent_runner, "extract_structured_worker_output", return_value=review),
                patch.object(agent_runner, "terminate_process_group"),
                patch.object(agent_runner.zdebug_manager, "register_worker_log"),
                patch.object(agent_runner, "add_event"),
                patch.object(agent_runner, "assert_job_execution_active"),
                patch.object(agent_runner, "sleep_before_retry") as sleep_before_retry,
            ):
                records = agent_runner.run_parallel_full_scene_reviews(
                    object(),
                    {"id": 72},
                    workspace,
                    chunks=[chunk],
                    source_hash="script-hash",
                    timeout_event=threading.Event(),
                )

        self.assertEqual(FinishedProcess.created, 2)
        self.assertEqual([call.args[2] for call in sleep_before_retry.call_args_list], [1])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["review"]["review_id"], "scene-001")

    def test_full_worker_retries_temporary_model_unavailability(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            output_file = workspace / "candidate.md"
            output_file.write_text("已保存正文\n", encoding="utf-8")
            timeout_event = threading.Event()
            connection = object()
            job = {"id": 17, "claude_session_id": "session-17", "authoring_session_id": ""}

            with (
                patch.object(
                    agent_runner,
                    "run_full_worker_attempt",
                    side_effect=[
                        agent_runner.ModelUnavailableError(
                            root_cause="API Error: 400 Upstream service temporarily unavailable"
                        ),
                        {"ok": True},
                    ],
                ) as attempt,
                patch.object(agent_runner, "add_event") as add_event,
                patch.object(agent_runner, "sleep_before_retry") as sleep_before_retry,
                patch.object(agent_runner, "session_transcript_path", return_value=None),
            ):
                result = agent_runner.run_full_worker(
                    connection,
                    job,
                    workspace,
                    "继续生成",
                    "full-generate",
                    output_file,
                    timeout_event,
                )
                output_content = output_file.read_text(encoding="utf-8")

        self.assertEqual(attempt.call_count, 2)
        self.assertEqual(result["model_unavailable_retry_attempts"], 1)
        sleep_before_retry.assert_called_once_with(connection, 17, 3, timeout_event)
        self.assertEqual(output_content, "已保存正文\n")
        self.assertTrue(any(call.args[2] == "model_unavailable_retry" for call in add_event.call_args_list))

    def test_full_worker_reports_retry_limit_with_original_cause(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            output_file = workspace / "candidate.md"
            output_file.write_text("已保存正文\n", encoding="utf-8")
            timeout_event = threading.Event()
            connection = object()
            job = {"id": 17, "claude_session_id": "session-17", "authoring_session_id": ""}
            unavailable = agent_runner.ModelUnavailableError(
                root_cause="API Error: 400 Upstream service temporarily unavailable"
            )

            with (
                patch.object(agent_runner, "run_full_worker_attempt", side_effect=[unavailable] * 4) as attempt,
                patch.object(agent_runner, "add_event"),
                patch.object(agent_runner, "sleep_before_retry") as sleep_before_retry,
                patch.object(agent_runner, "session_transcript_path", return_value=None),
            ):
                with self.assertRaises(agent_runner.ModelUnavailableError) as raised:
                    agent_runner.run_full_worker(
                        connection,
                        job,
                        workspace,
                        "继续生成",
                        "full-generate",
                        output_file,
                        timeout_event,
                    )

        self.assertEqual(attempt.call_count, 4)
        self.assertEqual(
            [call.args[2] for call in sleep_before_retry.call_args_list],
            list(agent_runner.MODEL_COOLDOWN_RETRY_DELAYS),
        )
        self.assertIn("Upstream service temporarily unavailable", raised.exception.root_cause)
        self.assertEqual(raised.exception.details["retry_attempts"], 3)
        self.assertEqual(raised.exception.details["retry_limit"], 3)

    def test_stage_runner_reports_retry_limit_with_original_cause(self) -> None:
        timeout_event = threading.Event()
        connection = object()
        job = {
            "id": 17,
            "claude_session_id": "session-17",
            "target_stage": "outline_rewrite",
            "stage": "outline_rewrite",
        }
        unavailable_cause = "API Error: 400 Upstream service temporarily unavailable"
        process_result = (1, None, unavailable_cause, 123, False, False, False, None)

        with (
            patch.object(agent_runner, "claude_command", return_value=["claude"]),
            patch.object(agent_runner, "claude_command_mode", return_value="resume"),
            patch.object(agent_runner, "stream_claude_process", side_effect=[process_result] * 4) as stream,
            patch.object(agent_runner, "add_event") as add_event,
            patch.object(agent_runner, "sleep_before_retry") as sleep_before_retry,
        ):
            with self.assertRaises(agent_runner.ModelUnavailableError) as raised:
                agent_runner.run_claude_prompt_with_recovery(connection, job, "继续生成", timeout_event)

        self.assertEqual(stream.call_count, 4)
        self.assertEqual(
            [call.args[2] for call in sleep_before_retry.call_args_list],
            list(agent_runner.MODEL_COOLDOWN_RETRY_DELAYS),
        )
        self.assertIn("Upstream service temporarily unavailable", raised.exception.root_cause)
        self.assertEqual(raised.exception.details["retry_attempts"], 3)
        self.assertEqual(raised.exception.details["retry_limit"], 3)
        self.assertEqual(
            [call.args[2] for call in add_event.call_args_list if call.args[2] == "model_unavailable_retry"],
            ["model_unavailable_retry"] * 3,
        )


if __name__ == "__main__":
    unittest.main()
