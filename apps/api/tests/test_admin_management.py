import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from app.db import session
from app.services import admin_service, project_lifecycle_service, region_admin_service, workspace_service
from app.services.admin_service import bulk_admin_project_action, dashboard_data, delete_admin_user
from app.services.project_lifecycle_service import archive_project, reopen_project
from app.services.region_admin_service import RegionRulesConfig, public_region_config, save_region_config


class AdminManagementTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.data_dir = self.root / "data"
        self.agents_dir = self.root / "Agents"
        self.workspaces_dir = self.agents_dir / "workspaces"
        self.workspaces_dir.mkdir(parents=True)
        self.settings = SimpleNamespace(
            data_dir=self.data_dir,
            database_path=self.data_dir / "app.db",
            repo_root=self.root,
            agents_dir=self.agents_dir,
            workspaces_dir=self.workspaces_dir,
            upload_dir=self.data_dir / "uploads",
        )
        self.patches = [
            patch.object(session, "settings", self.settings),
            patch.object(admin_service, "settings", self.settings),
            patch.object(region_admin_service, "settings", self.settings),
            patch.object(workspace_service, "settings", self.settings),
        ]
        for item in self.patches:
            item.start()
        rules_path = self.agents_dir / ".claude/config/region-rules.json"
        rules_path.parent.mkdir(parents=True)
        rules_path.write_text(
            json.dumps(
                {
                    "schema_version": "1.1.0",
                    "regions": {
                        "北美": {
                            "aliases": ["North America"],
                            "default_market": "美国",
                            "default_locale": "en-US",
                            "rules": ["保留角色主动选择", "避免直接照搬中国制度"],
                            "stage_overrides": {
                                "world_view": {
                                    "rules": ["世界观阶段保留原故事的权力关系"],
                                }
                            },
                        }
                    },
                },
                ensure_ascii=False,
                indent=2,
            ) + "\n",
            encoding="utf-8",
        )
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'admin', '管理员', 'hash', 'admin')"
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (2, 'author', '作者', 'hash', 'user')"
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (3, 'receiver', '接收人', 'hash', 'user')"
        )
        self.admin = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        self.author = self.conn.execute("SELECT * FROM users WHERE id = 2").fetchone()
        self.receiver = self.conn.execute("SELECT * FROM users WHERE id = 3").fetchone()
        self.create_project()
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def create_project(self):
        workspace = self.workspaces_dir / "test-project"
        (workspace / "output").mkdir(parents=True, exist_ok=True)
        (workspace / "output" / "审稿报告.md").write_text("# 审稿报告\n", encoding="utf-8")
        (workspace / "output" / "剧本全稿.md").write_text("# 剧本\n", encoding="utf-8")
        (workspace / "1.2-project-progress.json").write_text(
            json.dumps(
                {
                    "current_skill": "foreign_review",
                    "stages": {
                        "project_init": {"status": "completed"},
                        "world_view": {"status": "completed"},
                        "outline_rewrite": {"status": "approved"},
                        "character_rewrite": {"status": "approved"},
                        "trial_generate": {"status": "approved"},
                        "full_generate": {"status": "completed"},
                        "foreign_review": {"status": "approved"},
                    },
                    "audit": {"created_at": "2026-07-10T00:00:00Z", "created_by": "author", "updated_at": "2026-07-10T00:00:00Z", "updated_by": "admin"},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, status, claude_session_id, created_at, updated_at
            ) VALUES (1, 2, '测试项目', 'workspaces/test-project', '北美', 'review',
                      'foreign_review', 'active', 'session', '2026-07-10 00:00:00', '2026-07-10 00:00:00')
            """
        )

    def test_workspace_project_list_includes_creator_name(self):
        self.conn.execute("INSERT INTO batch_task_batches (id, created_by, name) VALUES (1, 1, '批量导入')")
        self.conn.execute(
            """
            INSERT INTO batch_tasks (id, batch_id, project_id, created_by, scenario, source_path, input_json)
            VALUES (1, 1, 1, 1, 'review', '/tmp/source.pdf', '{}')
            """
        )
        projects = workspace_service.list_projects(self.conn, self.admin)

        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]["creator_name"], "作者")
        self.assertEqual(projects[0]["last_modified_by"], "管理员")
        self.assertTrue(projects[0]["is_batch_task"])

    def test_delete_user_transfers_projects_and_preserves_history_with_tombstone(self):
        self.conn.execute(
            """
            INSERT INTO agent_jobs (id, project_id, user_id, stage, status, claude_session_id)
            VALUES (10, 1, 2, 'foreign_review', 'succeeded', 'job-session')
            """
        )
        self.conn.execute(
            """
            INSERT INTO file_versions (project_id, stage, file_path, edited_by, content_hash)
            VALUES (1, 'foreign_review', 'workspaces/test-project/99-审稿报告.md', 2, 'hash')
            """
        )
        upload = self.settings.upload_dir / "2" / "source.md"
        upload.parent.mkdir(parents=True)
        upload.write_text("原始文件", encoding="utf-8")

        result = delete_admin_user(
            self.conn,
            actor=self.admin,
            target=self.author,
            transfer_to_user_id=self.receiver["id"],
        )

        self.assertEqual(result["transferred_projects"], 1)
        self.assertIsNone(self.conn.execute("SELECT id FROM users WHERE id = 2").fetchone())
        self.assertEqual(self.conn.execute("SELECT owner_user_id FROM projects WHERE id = 1").fetchone()[0], 3)
        job_user_id = self.conn.execute("SELECT user_id FROM agent_jobs WHERE id = 10").fetchone()[0]
        tombstone = self.conn.execute("SELECT * FROM users WHERE id = ?", (job_user_id,)).fetchone()
        self.assertEqual(tombstone["username"], "__deleted_user__")
        self.assertTrue(tombstone["is_system"])
        self.assertFalse((self.settings.upload_dir / "2").exists())
        self.assertEqual(self.conn.execute("SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()[0], "user.delete")

    def test_delete_user_is_blocked_while_owned_project_has_active_job(self):
        self.conn.execute(
            """
            INSERT INTO agent_jobs (id, project_id, user_id, stage, status, claude_session_id)
            VALUES (11, 1, 2, 'foreign_review', 'running', 'job-session')
            """
        )
        with self.assertRaises(HTTPException) as context:
            delete_admin_user(
                self.conn,
                actor=self.admin,
                target=self.author,
                transfer_to_user_id=self.receiver["id"],
            )
        self.assertEqual(context.exception.status_code, 409)
        self.assertIsNotNone(self.conn.execute("SELECT id FROM users WHERE id = 2").fetchone())

    def test_current_region_config_keeps_project_management_available(self):
        payload = public_region_config(self.conn)
        projects = admin_service.list_admin_projects(self.conn)

        self.assertEqual(region_admin_service.region_rules_path(), self.agents_dir / ".claude/config/region-rules.json")
        self.assertEqual(payload["config"]["regions"]["北美"]["default_market"], "美国")
        self.assertEqual(payload["config"]["regions"]["北美"]["default_locale"], "en-US")
        self.assertEqual(
            payload["config"]["regions"]["北美"]["stage_overrides"]["world_view"]["rules"],
            ["世界观阶段保留原故事的权力关系"],
        )
        self.assertEqual(projects["pagination"]["total"], 1)
        self.assertEqual(projects["projects"][0]["name"], "测试项目")

    def test_region_update_is_atomic_and_used_region_cannot_be_removed(self):
        payload = public_region_config(self.conn)
        updated = json.loads(json.dumps(payload["config"]))
        updated["regions"]["北美"]["rules"].append("保持每集结尾的行动压力")
        result = save_region_config(
            self.conn,
            actor=self.admin,
            config=RegionRulesConfig.model_validate(updated),
            expected_hash=payload["content_hash"],
        )
        self.assertIn("保持每集结尾的行动压力", result["config"]["regions"]["北美"]["rules"])
        self.assertEqual(result["config"]["regions"]["北美"]["aliases"], ["North America"])
        self.assertEqual(
            result["config"]["regions"]["北美"]["stage_overrides"]["world_view"]["rules"],
            ["世界观阶段保留原故事的权力关系"],
        )

        removed = json.loads(json.dumps(result["config"]))
        removed["regions"] = {"拉美": {**updated["regions"]["北美"], "default_locale": "es-MX"}}
        with self.assertRaises(HTTPException) as context:
            save_region_config(
                self.conn,
                actor=self.admin,
                config=RegionRulesConfig.model_validate(removed),
                expected_hash=result["content_hash"],
            )
        self.assertEqual(context.exception.status_code, 409)

    def test_region_config_rejects_legacy_region_fields(self):
        payload = public_region_config(self.conn)["config"]
        for field, value in (
            ("core_audience", "18-35 岁女性用户"),
            ("language_overrides", {"美国": "en-US"}),
            ("markets", [{"label": "美国"}]),
        ):
            with self.subTest(field=field):
                stale = json.loads(json.dumps(payload))
                stale["regions"]["北美"][field] = value
                with self.assertRaises(ValidationError):
                    RegionRulesConfig.model_validate(stale)

    def test_region_config_rejects_invalid_stage_overrides(self):
        payload = public_region_config(self.conn)["config"]
        for stage_overrides in (
            {" ": {"rules": ["有效规则"]}},
            {"world_view": {"rules": [" "]}},
            {"world_view": {"rules": ["有效规则"], "unknown": True}},
        ):
            with self.subTest(stage_overrides=stage_overrides):
                invalid = json.loads(json.dumps(payload))
                invalid["regions"]["北美"]["stage_overrides"] = stage_overrides
                with self.assertRaises(ValidationError):
                    RegionRulesConfig.model_validate(invalid)

    def test_archive_and_reopen_define_project_completion(self):
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        archived = archive_project(self.conn, project=project, actor=self.author)
        self.assertEqual(archived["status"], "completed")
        self.assertIsNotNone(archived["completed_at"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM stage_approvals WHERE project_id = 1").fetchone()[0], 0)
        self.assertEqual(
            self.conn.execute("SELECT status FROM preference_summary_jobs WHERE project_id = 1").fetchone()["status"],
            "queued",
        )

        completed = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        reopened = reopen_project(self.conn, project=completed, actor=self.author)
        self.assertEqual(reopened["status"], "active")
        self.assertIsNone(reopened["completed_at"])
        self.assertEqual(
            self.conn.execute("SELECT status FROM preference_summary_jobs WHERE project_id = 1").fetchone()["status"],
            "canceled",
        )

    def test_archive_queues_one_preference_summary_per_archive_iteration(self):
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        archive_project(self.conn, project=project, actor=self.author)
        self.conn.commit()
        queued = self.conn.execute(
            "SELECT project_id, user_id, archive_iteration, status FROM preference_summary_jobs"
        ).fetchall()
        self.assertEqual(len(queued), 1)
        self.assertEqual((queued[0]["project_id"], queued[0]["user_id"], queued[0]["archive_iteration"]), (1, 2, 1))
        self.assertEqual(queued[0]["status"], "queued")

        completed = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        archive_project(self.conn, project=completed, actor=self.author)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM preference_summary_jobs WHERE project_id = 1").fetchone()[0],
            1,
        )

        reopened = reopen_project(self.conn, project=completed, actor=self.author)
        self.assertEqual(reopened["status"], "active")
        active = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        archive_project(self.conn, project=active, actor=self.author)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM preference_summary_jobs WHERE project_id = 1").fetchone()[0],
            2,
        )

    def test_archive_is_not_blocked_when_preference_summary_queue_is_unavailable(self):
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        with patch.object(project_lifecycle_service, "queue_preference_summary", side_effect=sqlite3.OperationalError("queue unavailable")):
            archived = archive_project(self.conn, project=project, actor=self.author)
        self.assertEqual(archived["status"], "completed")

    def test_bulk_project_action_processes_valid_projects_and_reports_stale_ids(self):
        result = bulk_admin_project_action(
            self.conn,
            actor=self.admin,
            action="trash",
            project_ids=[1, 999],
        )

        self.assertEqual(result["succeeded"], [1])
        self.assertEqual(result["failed"], [{"project_id": 999, "message": "项目不存在或状态已变化"}])
        self.assertIsNotNone(self.conn.execute("SELECT deleted_at FROM projects WHERE id = 1").fetchone()[0])
        self.assertEqual(self.conn.execute("SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()[0], "project.trash")

    def test_dashboard_uses_operator_filter_and_keeps_preferences_outside_time_filter(self):
        self.conn.execute(
            """
            INSERT INTO writer_preferences (user_id, content, source, enabled, position, created_at, updated_at)
            VALUES (2, '偏好 A', 'manual', 1, 0, '2026-07-01 00:00:00', '2026-07-01 00:00:00')
            """
        )
        self.conn.execute(
            """
            INSERT INTO writer_preferences (user_id, content, source, enabled, position, created_at, updated_at)
            VALUES (2, '偏好 B', 'manual', 1, 1, '2026-07-02 00:00:00', '2026-07-02 00:00:00')
            """
        )
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, status, claude_session_id,
                started_at, finished_at, created_at, updated_at
            ) VALUES (10, 1, 1, 'outline_rewrite', 'outline_rewrite', 'succeeded', 'session-10',
                      '2026-07-12 01:00:00', '2026-07-12 01:10:00',
                      '2026-07-12 01:00:00', '2026-07-12 01:10:00')
            """
        )
        self.conn.commit()

        author_data = dashboard_data(
            self.conn,
            period="custom",
            operator_user_id=2,
            start_date="2026-07-12",
            end_date="2026-07-12",
        )
        author_outline = next(item for item in author_data["execution"]["stage_metrics"] if item["key"] == "outline_rewrite")
        self.assertEqual(author_data["summary"]["scripts_total"], 0)
        self.assertEqual(author_data["summary"]["writers_total"], 1)
        self.assertEqual(author_data["summary"]["preferences_total"], 2)
        self.assertEqual(author_outline["job_count"], 0)
        self.assertEqual(author_data["filters"]["operator_user_id"], 2)

        admin_data = dashboard_data(
            self.conn,
            period="custom",
            operator_user_id=1,
            start_date="2026-07-12",
            end_date="2026-07-12",
        )
        admin_outline = next(item for item in admin_data["execution"]["stage_metrics"] if item["key"] == "outline_rewrite")
        self.assertEqual(admin_data["summary"]["scripts_total"], 0)
        self.assertEqual(admin_data["summary"]["preferences_total"], 0)
        self.assertEqual(admin_outline["job_count"], 1)

    def test_dashboard_filters_project_metrics_and_stages_by_scenario(self):
        self.conn.execute(
            "UPDATE projects SET created_at = '2026-07-13 00:00:00', updated_at = '2026-07-13 00:00:00' WHERE id = 1"
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, status, claude_session_id, created_at, updated_at
            ) VALUES (2, 2, '小说项目', 'workspaces/novel-project', '北美', 'novel',
                      'outline_rewrite', 'active', 'session-2', '2026-07-13 00:00:00', '2026-07-13 00:00:00')
            """
        )
        for job_id, project_id, stage in ((10, 1, "foreign_review"), (11, 2, "outline_rewrite")):
            self.conn.execute(
                """
                INSERT INTO agent_jobs (
                    id, project_id, user_id, stage, target_stage, status, claude_session_id,
                    started_at, finished_at, created_at, updated_at
                ) VALUES (?, ?, 2, ?, ?, 'succeeded', ?,
                          '2026-07-13 01:00:00', '2026-07-13 01:10:00',
                          '2026-07-13 01:00:00', '2026-07-13 01:10:00')
                """,
                (job_id, project_id, stage, stage, f"session-{job_id}"),
            )
        self.conn.commit()

        data = dashboard_data(
            self.conn,
            period="custom",
            task_type="review",
            start_date="2026-07-13",
            end_date="2026-07-13",
        )

        stage_metric_keys = [item["key"] for item in data["execution"]["stage_metrics"]]
        funnel_keys = [item["key"] for item in data["execution"]["funnel"]]
        operation_stage_keys = [item["key"] for item in data["execution"]["operations"]["by_stage"]]
        trend_day = next(item for item in data["trend"] if item["date"] == "2026-07-13")
        author = next(item for item in data["people"] if item["id"] == 2)
        self.assertEqual(data["filters"]["task_type"], "review")
        self.assertEqual(data["summary"]["scripts_total"], 1)
        self.assertEqual(data["execution"]["operations"]["total"], 1)
        self.assertEqual(stage_metric_keys, ["foreign_review"])
        self.assertEqual(funnel_keys, ["project_init", "foreign_review"])
        self.assertEqual(operation_stage_keys, ["project_init", "foreign_review"])
        self.assertEqual(trend_day["scripts"], 1)
        self.assertEqual(author["task_count"], 1)

        novel_data = dashboard_data(
            self.conn,
            period="custom",
            task_type="novel",
            start_date="2026-07-13",
            end_date="2026-07-13",
        )
        novel_stage_metric_keys = [item["key"] for item in novel_data["execution"]["stage_metrics"]]
        self.assertEqual(
            novel_stage_metric_keys,
            ["novel_analysis", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"],
        )
        self.assertNotIn("world_view", novel_stage_metric_keys)
        self.assertNotIn("humanizer_zh", novel_stage_metric_keys)

        with self.assertRaises(HTTPException) as context:
            dashboard_data(self.conn, task_type="unsupported")
        self.assertEqual(context.exception.status_code, 400)

    def test_dashboard_reports_recorded_usage_cost_and_script_duration_p95_without_archiving(self):
        jobs = [
            (10, "outline_rewrite", "outline_rewrite", "2026-07-13 01:00:00", "2026-07-13 01:10:00"),
            (11, "chat_edit", "outline_rewrite", "2026-07-13 02:00:00", "2026-07-13 02:20:00"),
            (12, "foreign_review", "foreign_review", "2026-07-13 03:00:00", "2026-07-13 03:05:00"),
        ]
        for job_id, stage, target_stage, started_at, finished_at in jobs:
            self.conn.execute(
                """
                INSERT INTO agent_jobs (
                    id, project_id, user_id, stage, target_stage, status, claude_session_id,
                    started_at, finished_at, created_at, updated_at
                ) VALUES (?, 1, 2, ?, ?, 'succeeded', ?, ?, ?, ?, ?)
                """,
                (job_id, stage, target_stage, f"session-{job_id}", started_at, finished_at, started_at, finished_at),
            )
        results = {
            10: {
                "type": "result",
                "modelUsage": {
                    "gpt-5.5": {
                        "inputTokens": 100,
                        "cacheReadInputTokens": 200,
                        "cacheCreationInputTokens": 0,
                        "outputTokens": 10,
                        "costUSD": 0.0015,
                    },
                    "gpt-5.6": {
                        "inputTokens": 50,
                        "cacheReadInputTokens": 0,
                        "cacheCreationInputTokens": 0,
                        "outputTokens": 5,
                        "costUSD": 0.000225,
                    },
                },
            },
            11: {
                "type": "result",
                "usage": {
                    "input_tokens": 50,
                    "cache_read_input_tokens": 50,
                    "cache_creation_input_tokens": 0,
                    "output_tokens": 5,
                },
                "total_cost_usd": 0.000625,
            },
        }
        for job_id, raw in results.items():
            self.conn.execute(
                """
                INSERT INTO agent_events (job_id, seq, event_type, message, raw_json, created_at)
                VALUES (?, 1, 'result', 'done', ?, CURRENT_TIMESTAMP)
                """,
                (job_id, json.dumps(raw)),
            )
        self.conn.commit()

        data = dashboard_data(
            self.conn,
            period="custom",
            start_date="2026-07-13",
            end_date="2026-07-13",
        )
        outline = next(item for item in data["execution"]["stage_metrics"] if item["key"] == "outline_rewrite")
        self.assertEqual(outline["job_count"], 2)
        self.assertEqual(outline["metered_job_count"], 2)
        self.assertEqual(outline["costed_job_count"], 2)
        self.assertEqual(outline["total_tokens"], 470)
        self.assertEqual(outline["p95_tokens"], 365)
        self.assertEqual(outline["p95_duration_seconds"], 1200.0)
        self.assertAlmostEqual(outline["total_cost_usd"], 0.00235)
        self.assertEqual(data["summary"]["tokens_total"], 470)
        self.assertAlmostEqual(data["summary"]["cost_usd_total"], 0.00235)
        self.assertEqual(data["summary"]["script_duration_p95_seconds"], 2100.0)
        self.assertEqual(data["summary"]["completed_pipeline_count"], 1)
        aggregate = data["execution"]["aggregate"]
        self.assertEqual(aggregate["total_tokens"], 470)
        self.assertEqual(aggregate["p95_tokens"], 365)
        self.assertAlmostEqual(aggregate["total_cost_usd"], 0.00235)
        self.assertEqual(aggregate["total_duration_seconds"], 2100.0)
        self.assertEqual(aggregate["p95_duration_seconds"], 1500.0)

    def test_dashboard_aggregates_stage_p95_values_for_full_task(self):
        jobs = [
            (40, "outline_rewrite", "2026-07-13 01:00:00", "2026-07-13 01:02:00"),
            (41, "foreign_review", "2026-07-13 02:00:00", "2026-07-13 02:01:00"),
        ]
        for job_id, stage, started_at, finished_at in jobs:
            self.conn.execute(
                """
                INSERT INTO agent_jobs (
                    id, project_id, user_id, stage, target_stage, status, claude_session_id,
                    started_at, finished_at, created_at, updated_at
                ) VALUES (?, 1, 2, ?, ?, 'succeeded', ?, ?, ?, ?, ?)
                """,
                (job_id, stage, stage, f"session-{job_id}", started_at, finished_at, started_at, finished_at),
            )
        results = {
            40: {"type": "result", "usage": {"input_tokens": 100, "output_tokens": 20}, "total_cost_usd": 0.12},
            41: {"type": "result", "usage": {"input_tokens": 200, "output_tokens": 30}, "total_cost_usd": 0.34},
        }
        for job_id, raw in results.items():
            self.conn.execute(
                """
                INSERT INTO agent_events (job_id, seq, event_type, message, raw_json, created_at)
                VALUES (?, 1, 'result', 'done', ?, CURRENT_TIMESTAMP)
                """,
                (job_id, json.dumps(raw)),
            )
        self.conn.commit()

        data = dashboard_data(
            self.conn,
            period="custom",
            start_date="2026-07-13",
            end_date="2026-07-13",
        )
        aggregate = data["execution"]["aggregate"]
        stage_metrics = data["execution"]["stage_metrics"]

        self.assertEqual(aggregate["p95_tokens"], sum(item["p95_tokens"] for item in stage_metrics))
        self.assertAlmostEqual(aggregate["p95_cost_usd"], sum(item["p95_cost_usd"] for item in stage_metrics))
        self.assertEqual(aggregate["p95_duration_seconds"], sum(item["p95_duration_seconds"] for item in stage_metrics))
        self.assertEqual(aggregate["p95_tokens"], 350)
        self.assertAlmostEqual(aggregate["p95_cost_usd"], 0.46)
        self.assertEqual(aggregate["p95_duration_seconds"], 180.0)

    def test_dashboard_uses_successful_runs_for_duration_metrics(self):
        jobs = [
            (30, "outline_rewrite", "outline_rewrite", "failed", "2026-07-13 01:00:00", "2026-07-13 09:38:00"),
            (31, "outline_rewrite", "outline_rewrite", "succeeded", "2026-07-13 10:00:00", "2026-07-13 10:10:00"),
            (32, "foreign_review", "foreign_review", "succeeded", "2026-07-13 10:11:00", "2026-07-13 10:16:00"),
        ]
        for job_id, stage, target_stage, job_status, started_at, finished_at in jobs:
            self.conn.execute(
                """
                INSERT INTO agent_jobs (
                    id, project_id, user_id, stage, target_stage, status, claude_session_id,
                    started_at, finished_at, created_at, updated_at
                ) VALUES (?, 1, 2, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (job_id, stage, target_stage, job_status, f"session-{job_id}", started_at, finished_at, started_at, finished_at),
            )
        self.conn.commit()

        data = dashboard_data(
            self.conn,
            period="custom",
            start_date="2026-07-13",
            end_date="2026-07-13",
        )
        outline = next(item for item in data["execution"]["stage_metrics"] if item["key"] == "outline_rewrite")
        self.assertEqual(outline["job_count"], 2)
        self.assertEqual(outline["total_duration_seconds"], 600.0)
        self.assertEqual(outline["p95_duration_seconds"], 600.0)
        self.assertEqual(data["summary"]["script_duration_p95_seconds"], 900.0)
        self.assertEqual(data["summary"]["completed_pipeline_count"], 1)

    def test_dashboard_reads_token_usage_from_archived_raw_log(self):
        log_path = self.data_dir / "zdebug/jobs/agent_job_12.jsonl"
        log_path.parent.mkdir(parents=True)
        log_path.write_text(
            "\n".join([
                json.dumps({"type": "zdebug_start"}),
                json.dumps({
                    "type": "result",
                    "modelUsage": {
                        "gpt-5.5": {
                            "inputTokens": 1_000,
                            "cacheReadInputTokens": 2_000,
                            "cacheCreationInputTokens": 0,
                        "outputTokens": 100,
                    }
                },
                "total_cost_usd": 0.009,
            }),
                json.dumps({"type": "zdebug_end"}),
            ]) + "\n",
            encoding="utf-8",
        )
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, status, claude_session_id,
                raw_log_path, started_at, finished_at, created_at, updated_at
            ) VALUES (12, 1, 2, 'full_generate', 'full_generate', 'succeeded', 'session-12',
                      ?, '2026-07-13 03:00:00', '2026-07-13 03:30:00',
                      '2026-07-13 03:00:00', '2026-07-13 03:30:00')
            """,
            (str(log_path),),
        )
        self.conn.commit()

        data = dashboard_data(
            self.conn,
            period="custom",
            start_date="2026-07-13",
            end_date="2026-07-13",
        )
        full = next(item for item in data["execution"]["stage_metrics"] if item["key"] == "full_generate")
        self.assertEqual(full["metered_job_count"], 1)
        self.assertEqual(full["costed_job_count"], 1)
        self.assertEqual(full["total_tokens"], 3_100)
        self.assertEqual(full["p95_duration_seconds"], 1800.0)
        self.assertAlmostEqual(full["total_cost_usd"], 0.009)

    def test_dashboard_classifies_stage_operations_from_existing_records(self):
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, status, claude_session_id,
                started_at, finished_at, created_at, updated_at
            ) VALUES (20, 1, 2, 'outline_rewrite', 'outline_rewrite', 'succeeded', 'session-20',
                      '2026-07-13 01:00:00', '2026-07-13 01:10:00',
                      '2026-07-13 01:00:00', '2026-07-13 01:10:00')
            """
        )
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, status, claude_session_id,
                retry_of_job_id, started_at, finished_at, created_at, updated_at
            ) VALUES (21, 1, 2, 'outline_rewrite', 'outline_rewrite', 'succeeded', 'session-21', 20,
                      '2026-07-13 02:00:00', '2026-07-13 02:10:00',
                      '2026-07-13 02:00:00', '2026-07-13 02:10:00')
            """
        )
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, status, claude_session_id,
                started_at, finished_at, created_at, updated_at
            ) VALUES (22, 1, 2, 'chat_edit', 'outline_rewrite', 'succeeded', 'session-22',
                      '2026-07-13 03:00:00', '2026-07-13 03:10:00',
                      '2026-07-13 03:00:00', '2026-07-13 03:10:00')
            """
        )
        self.conn.execute(
            """
            INSERT INTO audit_logs (
                actor_user_id, actor_username, action, target_type, target_id, project_id,
                details_json, created_at
            ) VALUES (2, 'author', 'document.edit', 'project_document', '1:outline_rewrite', 1,
                      '{"stage": "outline_rewrite"}', '2026-07-13 04:00:00')
            """
        )
        self.conn.commit()

        data = dashboard_data(
            self.conn,
            period="custom",
            operator_user_id=2,
            start_date="2026-07-13",
            end_date="2026-07-13",
        )
        operations = data["execution"]["operations"]
        self.assertEqual(operations["total"], 4)
        breakdown = {(item["stage"], item["key"]): item["value"] for item in operations["by_stage_kind"]}
        self.assertEqual(breakdown[("outline_rewrite", "automatic")], 1)
        self.assertEqual(breakdown[("outline_rewrite", "regenerate")], 1)
        self.assertEqual(breakdown[("outline_rewrite", "conversation")], 1)
        self.assertEqual(breakdown[("outline_rewrite", "manual_edit")], 1)
        self.assertEqual(data["people"][0]["operation_count"], 4)
        trend_day = next(item for item in data["trend"] if item["date"] == "2026-07-13")
        self.assertEqual(trend_day["scripts"], 1)
        self.assertEqual(trend_day["writers"], 1)

        with self.assertRaises(HTTPException) as context:
            dashboard_data(
                self.conn,
                period="custom",
                start_date="2026-07-12",
                end_date="2026-07-10",
            )
        self.assertEqual(context.exception.status_code, 400)

    def test_dashboard_attributes_created_tasks_to_the_creation_operator(self):
        self.conn.execute(
            """
            INSERT INTO audit_logs (
                actor_user_id, actor_username, action, target_type, target_id, project_id, created_at
            ) VALUES (1, 'admin', 'project.create', 'project', '1', 1, '2026-07-10 00:00:00')
            """
        )
        self.conn.commit()

        admin_data = dashboard_data(
            self.conn,
            period="custom",
            operator_user_id=1,
            start_date="2026-07-10",
            end_date="2026-07-10",
        )
        author_data = dashboard_data(
            self.conn,
            period="custom",
            operator_user_id=2,
            start_date="2026-07-10",
            end_date="2026-07-10",
        )

        self.assertEqual(admin_data["summary"]["scripts_total"], 1)
        self.assertEqual(admin_data["people"][0]["task_count"], 1)
        self.assertEqual(author_data["summary"]["scripts_total"], 0)


if __name__ == "__main__":
    unittest.main()
