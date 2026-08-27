import hashlib
import inspect
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.services.role_service import BATCH_TASK_PERMISSION
from app.routers.batch_tasks import get_batch_tasks, post_batch_tasks
from app.services import batch_task_service
from app.services.workspace_service import task_stage_order


class BatchTaskQueueTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            """
            CREATE TABLE batch_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER,
                scenario TEXT NOT NULL DEFAULT 'rewrite',
                status TEXT NOT NULL,
                current_stage TEXT,
                stop_after_stage TEXT,
                current_job_id INTEGER,
                last_job_id INTEGER,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 2,
                next_attempt_at TEXT,
                last_error TEXT,
                started_at TEXT,
                finished_at TEXT,
                run_duration_seconds INTEGER NOT NULL DEFAULT 0,
                active_started_at TEXT,
                execution_owner TEXT,
                execution_lease_expires_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self.conn.execute(
            """
            CREATE TABLE agent_jobs (
                id INTEGER PRIMARY KEY,
                status TEXT NOT NULL
            )
            """
        )

    def tearDown(self):
        self.conn.close()

    def add_task(
        self,
        *,
        status="queued",
        project_id=1,
        stop_after_stage=None,
        current_job_id=None,
        retry_count=0,
        max_retries=3,
        next_attempt_at=None,
    ):
        self.conn.execute(
            """
            INSERT INTO batch_tasks (
                project_id, status, current_stage, stop_after_stage, current_job_id, retry_count, max_retries, next_attempt_at
            ) VALUES (?, ?, 'outline_rewrite', ?, ?, ?, ?, ?)
            """,
            (project_id, status, stop_after_stage, current_job_id, retry_count, max_retries, next_attempt_at),
        )
        return self.conn.execute("SELECT * FROM batch_tasks WHERE id = last_insert_rowid()").fetchone()

    def test_scheduler_claims_at_most_two_tasks(self):
        self.add_task()
        self.add_task()
        self.add_task()
        self.conn.commit()

        with patch.object(batch_task_service.settings, "batch_task_max_parallel", 8):
            task_ids = batch_task_service.schedule_batch_tasks(self.conn)

        self.assertEqual(len(task_ids), 2)
        running = self.conn.execute("SELECT COUNT(*) AS count FROM batch_tasks WHERE status = 'running'").fetchone()["count"]
        queued = self.conn.execute("SELECT COUNT(*) AS count FROM batch_tasks WHERE status = 'queued'").fetchone()["count"]
        self.assertEqual(running, 2)
        self.assertEqual(queued, 1)

    def test_scheduler_claims_uninitialized_task_for_workspace_preparation(self):
        task = self.add_task(project_id=None)
        self.conn.commit()

        task_ids = batch_task_service.schedule_batch_tasks(self.conn)

        self.assertEqual(task_ids, [task["id"]])
        status = self.conn.execute("SELECT status FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()["status"]
        self.assertEqual(status, "running")

    def test_retryable_failure_requeues_then_exhausts(self):
        task = self.add_task(status="running", retry_count=0, max_retries=1)
        self.conn.commit()

        batch_task_service._queue_retry(
            self.conn,
            task=task,
            error="临时服务不可用",
            retryable=True,
            job_id=41,
        )
        queued = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertEqual(queued["status"], "queued")
        self.assertEqual(queued["retry_count"], 1)
        self.assertEqual(queued["last_job_id"], 41)
        self.assertIsNotNone(queued["next_attempt_at"])

        self.conn.execute("UPDATE batch_tasks SET status = 'running' WHERE id = ?", (task["id"],))
        self.conn.commit()
        batch_task_service._queue_retry(
            self.conn,
            task=queued,
            error="临时服务仍不可用",
            retryable=True,
            job_id=42,
        )
        failed = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["last_job_id"], 42)

    def test_failed_task_requeues_three_times_and_keeps_its_stage_job(self):
        task = self.add_task(status="running", current_job_id=40, max_retries=3)
        self.conn.commit()

        for retry_index in range(1, 4):
            current = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
            batch_task_service._queue_retry(
                self.conn,
                task=current,
                error="创作任务执行失败",
                retryable=True,
                job_id=40 + retry_index,
            )
            queued = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
            self.assertEqual(queued["status"], "queued")
            self.assertEqual(queued["retry_count"], retry_index)
            self.assertEqual(queued["current_job_id"], 40 + retry_index)
            self.assertIn(f"第 {retry_index}/3 次自动重试", batch_task_service._result_text(queued))
            self.conn.execute("UPDATE batch_tasks SET status = 'running' WHERE id = ?", (task["id"],))
            self.conn.commit()

        current = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        batch_task_service._queue_retry(
            self.conn,
            task=current,
            error="创作任务执行失败",
            retryable=True,
            job_id=44,
        )
        failed = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["current_job_id"], 44)
        self.assertIn("已自动重试 3 次仍未完成", batch_task_service._result_text(failed))

    def test_requeued_task_waits_behind_earlier_queued_work(self):
        retried = self.add_task(next_attempt_at="2000-01-02T00:00:00Z")
        waiting = self.add_task(next_attempt_at="2000-01-01T00:00:00Z")
        self.conn.execute("UPDATE batch_tasks SET created_at = '2020-01-01 00:00:00' WHERE id = ?", (retried["id"],))
        self.conn.execute("UPDATE batch_tasks SET created_at = '2025-01-01 00:00:00' WHERE id = ?", (waiting["id"],))
        self.conn.commit()

        with patch.object(batch_task_service.settings, "batch_task_max_parallel", 1):
            task_ids = batch_task_service.schedule_batch_tasks(self.conn)

        self.assertEqual(task_ids, [waiting["id"]])
        self.assertEqual(self.conn.execute("SELECT status FROM batch_tasks WHERE id = ?", (retried["id"],)).fetchone()["status"], "queued")

    def test_failed_task_can_continue_without_creating_a_new_project(self):
        task = self.add_task(status="failed", project_id=9, current_job_id=41, retry_count=3)
        actor = {"id": 1, "username": "admin"}
        task_for_action = {"id": task["id"], "status": "failed", "project_name": "批量测试"}

        with patch.object(batch_task_service, "get_batch_task_or_404", return_value=task_for_action), patch.object(
            batch_task_service, "_public_task", return_value={}
        ), patch.object(batch_task_service, "record_audit"):
            batch_task_service.start_batch_task(self.conn, task_id=task["id"], actor=actor)

        resumed = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertEqual(resumed["status"], "queued")
        self.assertEqual(resumed["project_id"], 9)
        self.assertEqual(resumed["current_stage"], "outline_rewrite")
        self.assertEqual(resumed["current_job_id"], 41)
        self.assertEqual(resumed["last_job_id"], 41)
        self.assertEqual(resumed["retry_count"], 0)

    def test_checkpointed_interruption_reuses_the_original_stage_job(self):
        task = self.add_task(status="running", current_job_id=41)
        self.conn.execute("INSERT INTO agent_jobs (id, status) VALUES (41, 'canceled')")
        self.conn.commit()
        job = self.conn.execute("SELECT * FROM agent_jobs WHERE id = 41").fetchone()

        def finish_resumed_job(job_id: int) -> None:
            self.conn.execute("UPDATE agent_jobs SET status = 'succeeded' WHERE id = ?", (job_id,))
            self.conn.commit()

        with patch.object(batch_task_service, "resume_failed_continuation_job", return_value=job) as resume, patch.object(
            batch_task_service, "run_agent_job", side_effect=finish_resumed_job
        ) as run:
            resumed = batch_task_service._resume_interrupted_stage_job(
                self.conn,
                task=task,
                project={"id": 1, "workspace_dir": "/tmp/project"},
                actor={"username": "admin"},
                job=job,
            )

        self.assertEqual(resume.call_args.kwargs["job"]["id"], 41)
        run.assert_called_once_with(41)
        self.assertEqual(resumed["id"], 41)
        self.assertEqual(resumed["status"], "succeeded")

    def test_legacy_failed_task_uses_last_job_for_checkpoint_resume(self):
        self.conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)")
        self.conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, deleted_at TEXT)")
        self.conn.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
        self.conn.execute("INSERT INTO projects (id, deleted_at) VALUES (1, NULL)")
        self.conn.execute("INSERT INTO agent_jobs (id, status) VALUES (41, 'failed')")
        self.conn.commit()
        task = {
            "id": 1,
            "status": "running",
            "created_by": 1,
            "project_id": 1,
            "project_deleted_at": None,
            "scenario": "rewrite",
            "current_stage": "outline_rewrite",
            "current_job_id": None,
            "last_job_id": 41,
        }

        with patch.object(batch_task_service, "get_batch_task_or_404", return_value=task), patch.object(
            batch_task_service, "_resume_interrupted_stage_job", return_value={"id": 41, "status": "succeeded"}
        ) as resume, patch.object(batch_task_service, "_complete_stage", return_value=False) as complete:
            batch_task_service._run_task_pipeline(self.conn, task_id=task["id"])

        self.assertEqual(resume.call_args.kwargs["job"]["id"], 41)
        self.assertEqual(complete.call_args.kwargs["job_id"], 41)

    def test_restart_recovery_releases_a_stale_batch_lease(self):
        task = self.add_task(status="running")
        self.conn.execute(
            "UPDATE batch_tasks SET execution_owner = 'previous-server', execution_lease_expires_at = '2099-01-01T00:00:00Z' WHERE id = ?",
            (task["id"],),
        )
        self.conn.commit()

        task_ids = batch_task_service.recover_batch_tasks(self.conn, force=True)

        recovered = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertEqual(task_ids, [task["id"]])
        self.assertIsNone(recovered["execution_owner"])
        self.assertIsNone(recovered["execution_lease_expires_at"])

    def test_scene_pipeline_is_read_from_shared_registry(self):
        self.assertEqual(
            task_stage_order("rewrite"),
            ["world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"],
        )
        self.assertEqual(
            task_stage_order("replicate"),
            ["world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"],
        )
        self.assertEqual(batch_task_service.DEFAULT_STOP_AFTER_STAGES["replicate"], "trial_generate")
        self.assertEqual(task_stage_order("review"), ["foreign_review"])
        self.assertEqual(task_stage_order("translate"), ["dialogue_translate"])

    def test_paused_task_reports_accumulated_run_duration(self):
        duration = batch_task_service._duration_seconds(
            {
                "status": "paused",
                "started_at": "2026-07-22T12:59:00Z",
                "run_duration_seconds": 75,
            }
        )

        self.assertEqual(duration, 75)

    def test_pausing_a_running_task_stops_duration_accumulation(self):
        task = self.add_task(status="running")
        self.conn.execute(
            "UPDATE batch_tasks SET started_at = datetime('now', '-90 seconds'), active_started_at = datetime('now', '-90 seconds') WHERE id = ?",
            (task["id"],),
        )
        self.conn.commit()
        task_for_action = {"id": task["id"], "status": "running", "current_job_id": None, "project_name": "批量测试"}

        with patch.object(batch_task_service, "get_batch_task_or_404", return_value=task_for_action), patch.object(
            batch_task_service, "_public_task", return_value={}
        ), patch.object(batch_task_service, "record_audit"):
            batch_task_service.pause_batch_task(self.conn, task_id=task["id"], actor={"id": 1, "username": "admin"})

        paused = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertEqual(paused["status"], "paused")
        self.assertIsNone(paused["active_started_at"])
        self.assertGreaterEqual(paused["run_duration_seconds"], 89)

    def test_public_task_includes_creator_name(self):
        task = batch_task_service._public_task(
            {
                "id": 1,
                "batch_id": 1,
                "batch_name": "北美改写第一批",
                "creator_name": "张三",
                "project_name": "批量测试",
                "scenario": "rewrite",
                "current_stage": "outline_rewrite",
                "stop_after_stage": "trial_generate",
                "status": "queued",
            }
        )

        self.assertEqual(task["creator_name"], "张三")

    def test_batch_input_uses_region_and_omits_blank_optional_values(self):
        input_data = batch_task_service._normalize_input(
            {
                "project_name": "批量测试",
                "scenario": "rewrite",
                "target_region": "北美",
                "target_country": "加拿大",
                "target_locale": "fr-CA",
                "extra_requirements": " ",
            },
            source_path=Path("/tmp/source.md"),
            source_name="source.md",
        )

        self.assertEqual(input_data["target_region"], "北美")
        self.assertEqual(input_data["stop_after_stage"], "trial_generate")
        self.assertNotIn("target_country", input_data)
        self.assertNotIn("target_locale", input_data)
        self.assertNotIn("extra_requirements", input_data)
        self.assertEqual(input_data["maturity_target"], batch_task_service.DEFAULT_MATURITY_TARGET)
        self.assertEqual(
            batch_task_service._distribution_brief(input_data),
            {"maturity_target": batch_task_service.DEFAULT_MATURITY_TARGET},
        )

    def test_review_batch_defaults_to_foreign_review_stop(self):
        input_data = batch_task_service._normalize_input(
            {
                "project_name": "批量审核",
                "scenario": "review",
                "target_region": "北美",
            },
            source_path=Path("/tmp/source.md"),
            source_name="source.md",
        )

        self.assertEqual(input_data["stop_after_stage"], "foreign_review")

    def test_translate_batch_defaults_to_dialogue_translation_stop(self):
        input_data = batch_task_service._normalize_input(
            {
                "project_name": "批量台词翻译",
                "scenario": "translate",
                "target_region": "北美",
            },
            source_path=Path("/tmp/source.md"),
            source_name="source.md",
        )

        self.assertEqual(input_data["stop_after_stage"], "dialogue_translate")
        self.assertEqual(input_data["scenario"], "translate")

    def test_stop_stage_must_belong_to_the_selected_scenario(self):
        with self.assertRaises(HTTPException) as raised:
            batch_task_service._normalize_input(
                {
                    "project_name": "批量审核",
                    "scenario": "review",
                    "target_region": "北美",
                    "stop_after_stage": "trial_generate",
                },
                source_path=Path("/tmp/source.md"),
                source_name="source.md",
            )

        self.assertEqual(raised.exception.status_code, 422)

    def test_reaching_configured_stop_stage_pauses_before_the_next_stage(self):
        task = self.add_task(status="running", stop_after_stage="outline_rewrite")
        project = {"id": 1, "name": "批量测试项目", "task_type": "rewrite", "workspace_dir": "workspace"}
        actor = {"id": 1, "username": "admin"}

        with patch.object(batch_task_service, "load_progress", return_value={"stages": {"outline_rewrite": {"status": "completed"}}}), patch.object(
            batch_task_service, "record_audit"
        ):
            advanced = batch_task_service._complete_stage(
                self.conn,
                task=task,
                project=project,
                actor=actor,
                stage="outline_rewrite",
                job_id=41,
            )

        paused = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertFalse(advanced)
        self.assertEqual(paused["status"], "paused")
        self.assertEqual(paused["current_stage"], "character_rewrite")
        self.assertIsNone(paused["current_job_id"])
        self.assertEqual(paused["last_job_id"], 41)
        self.assertIn("已按设置暂停", paused["last_error"])

    def test_novel_analysis_batch_automatically_accepts_unit_recommendations_before_advancing(self):
        task = self.add_task(status="running")
        self.conn.execute(
            "UPDATE batch_tasks SET scenario = 'novel', current_stage = 'novel_analysis' WHERE id = ?",
            (task["id"],),
        )
        self.conn.commit()
        task = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        project = {
            "id": 1,
            "name": "批量小说项目",
            "task_type": "novel",
            "target_region": "北美",
            "workspace_dir": "workspace",
        }
        actor = {"id": 1, "username": "admin"}
        recommendation_result = {
            "ok": True,
            "changed": True,
            "deleted_unit_count": 2,
            "newly_confirmed_merge_count": 1,
            "remaining_unit_count": 4,
        }

        with patch.object(
            batch_task_service,
            "load_progress",
            return_value={"stages": {"novel_analysis": {"status": "completed"}}},
        ), patch.object(
            batch_task_service,
            "_accept_novel_analysis_recommendations",
            return_value=recommendation_result,
        ) as accept, patch.object(batch_task_service, "record_system_audit") as audit:
            advanced = batch_task_service._complete_stage(
                self.conn,
                task=task,
                project=project,
                actor=actor,
                stage="novel_analysis",
                job_id=41,
            )

        advanced_task = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertTrue(advanced)
        self.assertEqual(advanced_task["current_stage"], "outline_rewrite")
        accept.assert_called_once_with(project)
        acceptance_audit = next(
            call for call in audit.call_args_list
            if call.kwargs["action"] == "batch_task.novel_analysis.recommendations_accepted"
        )
        self.assertEqual(acceptance_audit.kwargs["details"]["deleted_unit_count"], 2)
        self.assertEqual(acceptance_audit.kwargs["details"]["newly_confirmed_merge_count"], 1)

    def test_new_contract_only_pauses_for_explicit_user_approval(self):
        self.assertEqual(batch_task_service._batch_stage_completion_action("world_view", "completed"), "advance")
        self.assertEqual(batch_task_service._batch_stage_completion_action("trial_generate", "awaiting_approval"), "awaiting_approval")
        self.assertEqual(batch_task_service._batch_stage_completion_action("foreign_review", "approved"), "advance")
        with self.assertRaises(HTTPException):
            batch_task_service._batch_stage_completion_action("trial_generate", "completed")

    def test_saved_trial_edit_advances_batch_to_full_generation(self):
        task = self.add_task(status="running")
        project = {
            "id": 1,
            "name": "批量测试项目",
            "task_type": "rewrite",
            "target_region": "北美",
            "workspace_dir": "workspace",
        }
        actor = {"id": 1, "username": "admin"}
        progress = {
            "stages": {
                "trial_generate": {
                    "status": "awaiting_approval",
                    "document_sync": {"status": "pending"},
                },
            },
        }

        with patch.object(batch_task_service, "load_progress", return_value=progress), patch.object(
            batch_task_service, "record_system_audit"
        ):
            advanced = batch_task_service._complete_stage(
                self.conn,
                task=task,
                project=project,
                actor=actor,
                stage="trial_generate",
                job_id=41,
            )

        resumed = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertTrue(advanced)
        self.assertEqual(resumed["current_stage"], "full_generate")
        self.assertIsNone(resumed["current_job_id"])
        self.assertEqual(resumed["last_job_id"], 41)

    def test_batch_auto_approves_trial_when_selected_stop_is_later(self):
        task = self.add_task(status="running", stop_after_stage="full_generate")
        project = {
            "id": 1,
            "name": "批量测试项目",
            "task_type": "rewrite",
            "target_region": "北美",
            "workspace_dir": "workspace",
        }
        actor = {"id": 1, "username": "admin"}

        with patch.object(
            batch_task_service,
            "load_progress",
            return_value={"stages": {"trial_generate": {"status": "awaiting_approval"}}},
        ), patch.object(batch_task_service, "_auto_approve_batch_stage") as approve, patch.object(
            batch_task_service, "record_system_audit"
        ):
            advanced = batch_task_service._complete_stage(
                self.conn,
                task=task,
                project=project,
                actor=actor,
                stage="trial_generate",
                job_id=41,
            )

        advanced_task = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertTrue(advanced)
        self.assertEqual(advanced_task["current_stage"], "full_generate")
        approve.assert_called_once_with(
            self.conn,
            task=task,
            project=project,
            actor=actor,
            stage="trial_generate",
            stop_after_stage="full_generate",
            job_id=41,
        )

    def test_batch_keeps_trial_waiting_for_approval_when_trial_is_selected_stop(self):
        task = self.add_task(status="running", stop_after_stage="trial_generate")
        project = {
            "id": 1,
            "name": "批量测试项目",
            "task_type": "rewrite",
            "target_region": "北美",
            "workspace_dir": "workspace",
        }
        actor = {"id": 1, "username": "admin"}

        with patch.object(
            batch_task_service,
            "load_progress",
            return_value={"stages": {"trial_generate": {"status": "awaiting_approval"}}},
        ), patch.object(batch_task_service, "_auto_approve_batch_stage") as approve, patch.object(
            batch_task_service, "record_system_audit"
        ):
            advanced = batch_task_service._complete_stage(
                self.conn,
                task=task,
                project=project,
                actor=actor,
                stage="trial_generate",
                job_id=41,
            )

        paused = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertFalse(advanced)
        self.assertEqual(paused["status"], "paused")
        approve.assert_not_called()

    def test_auto_approval_writes_the_trial_approval_record(self):
        self.conn.executescript(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                current_stage TEXT,
                updated_at TEXT
            );
            CREATE TABLE stage_approvals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                stage TEXT NOT NULL,
                artifact_hash TEXT NOT NULL,
                quality_contract_version TEXT,
                memory_revision INTEGER,
                approved_by INTEGER NOT NULL,
                job_id INTEGER
            );
            """
        )
        self.conn.execute("INSERT INTO projects (id, current_stage) VALUES (1, 'trial_generate')")
        task = self.add_task(status="running", stop_after_stage="full_generate")
        project = {
            "id": 1,
            "name": "批量测试项目",
            "workspace_dir": "workspace",
        }
        actor = {"id": 1, "username": "admin"}

        with TemporaryDirectory() as temporary_dir:
            workspace = Path(temporary_dir)
            artifact_path = workspace / "output" / "剧本试稿.md"
            artifact_path.parent.mkdir()
            artifact_path.write_text("# 剧本试稿\n", encoding="utf-8")
            artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()

            with patch.object(batch_task_service, "resolve_workspace", return_value=workspace), patch.object(
                batch_task_service,
                "approve_new_stage",
                return_value={
                    "quality_contract_version": "agents-new-v1",
                    "memory": {"revision": 7},
                },
            ) as approve, patch.object(batch_task_service, "record_system_audit") as audit:
                batch_task_service._auto_approve_batch_stage(
                    self.conn,
                    task=task,
                    project=project,
                    actor=actor,
                    stage="trial_generate",
                    stop_after_stage="full_generate",
                    job_id=41,
                )

        approval = self.conn.execute("SELECT * FROM stage_approvals").fetchone()
        current_stage = self.conn.execute("SELECT current_stage FROM projects WHERE id = 1").fetchone()["current_stage"]
        self.assertEqual(approval["project_id"], 1)
        self.assertEqual(approval["stage"], "trial_generate")
        self.assertEqual(approval["artifact_hash"], artifact_hash)
        self.assertEqual(approval["quality_contract_version"], "agents-new-v1")
        self.assertEqual(approval["memory_revision"], 7)
        self.assertEqual(approval["approved_by"], 1)
        self.assertEqual(approval["job_id"], 41)
        self.assertEqual(current_stage, "trial_generate")
        approve.assert_called_once_with(workspace, stage="trial_generate", actor="admin", artifact_hash=artifact_hash)
        self.assertEqual(audit.call_args.kwargs["action"], "batch_task.stage.auto_approve")

    def test_pause_for_user_approval_keeps_the_completed_job_for_resume(self):
        task = self.add_task(status="running")
        project = {"id": 1, "name": "批量测试项目", "task_type": "rewrite"}
        actor = {"id": 1, "username": "admin"}

        with patch.object(batch_task_service, "record_audit"):
            batch_task_service._pause_for_stage_approval(
                self.conn,
                task=task,
                project=project,
                actor=actor,
                stage="trial_generate",
                job_id=41,
            )

        paused = self.conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
        self.assertEqual(paused["status"], "paused")
        self.assertEqual(paused["current_job_id"], 41)
        self.assertEqual(paused["last_job_id"], 41)
        self.assertIn("等待用户确认", paused["last_error"])
        self.assertIn("等待用户确认", batch_task_service._result_text(paused))

    def test_batch_routes_require_batch_task_permission(self):
        get_dependency = inspect.signature(get_batch_tasks).parameters["actor"].default.dependency
        post_dependency = inspect.signature(post_batch_tasks).parameters["actor"].default.dependency
        self.assertEqual(get_dependency.__closure__[0].cell_contents, BATCH_TASK_PERMISSION)
        self.assertEqual(post_dependency.__closure__[0].cell_contents, BATCH_TASK_PERMISSION)


if __name__ == "__main__":
    unittest.main()
