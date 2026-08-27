from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.db import session
from app.services.audit_service import record_audit
from app.services import model_config_service, script_sync_service


class ModelConfigServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=self.root / "data",
            database_path=self.root / "data" / "app.db",
        )
        self.settings_patch = patch.object(session, "settings", self.settings)
        self.settings_patch.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'admin', '管理员', 'hash', 'admin')"
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (2, 'author', '作者', 'hash', 'user')"
        )
        self.admin = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()
        self.settings_patch.stop()
        self.temp_dir.cleanup()

    def _create_claude_model(self, *, name: str, model_name: str, fallback_model_id: int | None = None) -> dict:
        return model_config_service.create_model_config(
            self.conn,
            actor=self.admin,
            payload={
                "name": name,
                "model_type": "claude_code",
                "request_url": "https://models.example.com/v1",
                "api_key": "test-secret-key",
                "model_name": model_name,
                "thinking_level": "high",
                "image_size": "",
                "image_output_format": "png",
                "image_watermark": False,
                "fallback_model_id": fallback_model_id,
                "is_enabled": True,
            },
        )

    def test_default_models_and_function_routes_are_initialized_without_exposing_keys(self) -> None:
        payload = model_config_service.list_model_management(self.conn)

        self.assertEqual({model["model_type"] for model in payload["models"]}, {"claude_code", "image"})
        self.assertEqual(
            {(route["scenario_key"], route["action_key"]) for route in payload["routes"]},
            {(item["scenario_key"], item["action_key"]) for item in model_config_service.FUNCTION_MODEL_CATALOG},
        )
        route_keys = {(route["scenario_key"], route["action_key"]) for route in payload["routes"]}
        self.assertTrue({
            ("script_review", "foreign_review"),
            ("dialogue_translation", "dialogue_translate"),
            ("script_humanization", "humanizer_zh"),
            ("viral_replication", "world_view"),
            ("viral_replication", "foreign_review"),
        }.issubset(route_keys))
        self.assertTrue(all("api_key" not in model for model in payload["models"]))
        self.assertTrue(all("api_key_configured" in model for model in payload["models"]))

    def test_created_model_returns_key_status_but_not_key_value(self) -> None:
        created = self._create_claude_model(name="剧本主模型", model_name="claude-test-v1")

        self.assertTrue(created["api_key_configured"])
        self.assertNotIn("api_key", created)
        stored = self.conn.execute("SELECT api_key FROM ai_model_configs WHERE id = ?", (created["id"],)).fetchone()
        self.assertEqual(stored["api_key"], "test-secret-key")

    def test_legacy_script_catalog_route_keeps_its_saved_model_choice(self) -> None:
        legacy_model = self._create_claude_model(name="剧本库整理模型", model_name="catalog-model")
        self.conn.execute(
            """
            INSERT INTO ai_function_model_routes (
                scenario_key, action_key, model_type, model_config_id
            ) VALUES ('script_library', 'mechanism_curation', 'claude_code', ?)
            """,
            (legacy_model["id"],),
        )
        self.conn.commit()

        model_config_service.ensure_model_configuration_defaults(self.conn)

        current = self.conn.execute(
            """
            SELECT model_config_id FROM ai_function_model_routes
            WHERE scenario_key='script_library' AND action_key='formula_curation'
            """
        ).fetchone()
        legacy = self.conn.execute(
            """
            SELECT 1 FROM ai_function_model_routes
            WHERE scenario_key='script_library' AND action_key='mechanism_curation'
            """
        ).fetchone()
        self.assertEqual(current["model_config_id"], legacy_model["id"])
        self.assertIsNone(legacy)

    def test_database_migration_backfills_a_successful_model_test_status(self) -> None:
        created = self._create_claude_model(name="待回填测试状态模型", model_name="claude-test-v1")
        self.conn.execute(
            "UPDATE ai_model_configs SET last_tested_at = NULL, updated_at = '2026-01-01 00:00:00' WHERE id = ?",
            (created["id"],),
        )
        record_audit(
            self.conn,
            actor=self.admin,
            action="model_config.test",
            target_type="model_config",
            target_id=created["id"],
            target_label=created["name"],
            outcome="success",
        )
        expected = self.conn.execute(
            "SELECT created_at FROM audit_logs WHERE action = 'model_config.test' ORDER BY id DESC LIMIT 1"
        ).fetchone()["created_at"]
        self.conn.commit()

        session.init_db()

        stored = self.conn.execute(
            "SELECT last_tested_at FROM ai_model_configs WHERE id = ?", (created["id"],)
        ).fetchone()
        self.assertEqual(stored["last_tested_at"], expected)

    def test_route_and_fallback_must_use_matching_model_types(self) -> None:
        models = model_config_service.list_model_management(self.conn)["models"]
        image_model = next(model for model in models if model["model_type"] == "image")
        claude_model = next(model for model in models if model["model_type"] == "claude_code")

        with self.assertRaises(HTTPException) as route_error:
            model_config_service.update_function_model_route(
                self.conn,
                actor=self.admin,
                scenario_key="script_rewrite",
                action_key="world_view",
                model_config_id=image_model["id"],
            )
        self.assertEqual(route_error.exception.status_code, 422)

        with self.assertRaises(HTTPException) as fallback_error:
            self._create_claude_model(
                name="类型不匹配的兜底",
                model_name="claude-test-v1",
                fallback_model_id=image_model["id"],
            )
        self.assertEqual(fallback_error.exception.status_code, 422)

        with self.assertRaises(HTTPException) as disable_error:
            model_config_service.update_model_config(
                self.conn,
                actor=self.admin,
                model_id=claude_model["id"],
                payload={"is_enabled": False},
            )
        self.assertEqual(disable_error.exception.status_code, 409)

    def test_bulk_route_update_applies_one_model_to_selected_actions(self) -> None:
        model = self._create_claude_model(name="批量配置模型", model_name="claude-batch")
        route_keys = [
            {"scenario_key": "script_rewrite", "action_key": "world_view"},
            {"scenario_key": "script_rewrite", "action_key": "outline_rewrite"},
        ]

        result = model_config_service.update_function_model_routes(
            self.conn,
            actor=self.admin,
            route_keys=route_keys,
            model_config_id=model["id"],
        )

        self.assertEqual(result["updated_count"], 2)
        self.assertEqual({route["model_config_id"] for route in result["routes"]}, {model["id"]})
        persisted = self.conn.execute(
            """
            SELECT model_config_id
            FROM ai_function_model_routes
            WHERE scenario_key = 'script_rewrite' AND action_key IN ('world_view', 'outline_rewrite')
            """
        ).fetchall()
        self.assertEqual({row["model_config_id"] for row in persisted}, {model["id"]})
        audit = self.conn.execute("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(audit["action"], "model_route.bulk_update")

    def test_bulk_route_update_rejects_mixed_model_types_without_changes(self) -> None:
        image_model = next(
            model for model in model_config_service.list_model_management(self.conn)["models"]
            if model["model_type"] == "image"
        )
        before = self.conn.execute(
            """
            SELECT model_config_id FROM ai_function_model_routes
            WHERE scenario_key = 'script_rewrite' AND action_key = 'world_view'
            """
        ).fetchone()["model_config_id"]

        with self.assertRaises(HTTPException) as context:
            model_config_service.update_function_model_routes(
                self.conn,
                actor=self.admin,
                route_keys=[{"scenario_key": "script_rewrite", "action_key": "world_view"}],
                model_config_id=image_model["id"],
            )

        self.assertEqual(context.exception.status_code, 422)
        after = self.conn.execute(
            """
            SELECT model_config_id FROM ai_function_model_routes
            WHERE scenario_key = 'script_rewrite' AND action_key = 'world_view'
            """
        ).fetchone()["model_config_id"]
        self.assertEqual(after, before)

    def test_agent_snapshot_keeps_the_model_selected_when_the_task_started(self) -> None:
        selected = self._create_claude_model(name="任务快照模型", model_name="claude-before-update")
        model_config_service.update_function_model_route(
            self.conn,
            actor=self.admin,
            scenario_key="script_rewrite",
            action_key="outline_rewrite",
            model_config_id=selected["id"],
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, task_type, claude_session_id
            ) VALUES (1, 2, '快照项目', 'workspaces/snapshot', 'rewrite', 'session-1')
            """
        )
        self.conn.execute(
            """
            INSERT INTO agent_jobs (id, project_id, user_id, stage, status, claude_session_id)
            VALUES (1, 1, 2, 'outline_rewrite', 'queued', 'session-1')
            """
        )
        job = self.conn.execute("SELECT * FROM agent_jobs WHERE id = 1").fetchone()
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        snapped_job = model_config_service.ensure_agent_model_snapshot(self.conn, job=job, project=project)

        model_config_service.update_model_config(
            self.conn,
            actor=self.admin,
            model_id=selected["id"],
            payload={"model_name": "claude-after-update"},
        )
        runtime = model_config_service.agent_runtime_model(snapped_job, "outline_rewrite")

        self.assertEqual(runtime["model_name"], "claude-before-update")
        persisted = json.loads(snapped_job["model_config_snapshot_json"])
        self.assertEqual(
            persisted["routes"]["script_rewrite:outline_rewrite"]["model_name"],
            "claude-before-update",
        )

    def test_standalone_frontend_task_uses_its_own_route_in_the_snapshot(self) -> None:
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, task_type, claude_session_id
            ) VALUES (1, 2, '翻译项目', 'workspaces/translation', 'translate', 'session-1')
            """
        )
        self.conn.execute(
            """
            INSERT INTO agent_jobs (id, project_id, user_id, stage, status, claude_session_id)
            VALUES (1, 1, 2, 'dialogue_translate', 'queued', 'session-1')
            """
        )
        job = self.conn.execute("SELECT * FROM agent_jobs WHERE id = 1").fetchone()
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()

        snapped_job = model_config_service.ensure_agent_model_snapshot(self.conn, job=job, project=project)
        snapshot = json.loads(snapped_job["model_config_snapshot_json"])

        self.assertEqual(snapshot["scenario_key"], "dialogue_translation")
        self.assertIn("dialogue_translation:dialogue_translate", snapshot["routes"])

    def test_replication_project_uses_the_replication_model_route(self) -> None:
        self.assertEqual(
            model_config_service._agent_scenario({"task_type": "replicate"}),
            "viral_replication",
        )

    def test_claude_runtime_supports_the_full_cli_effort_range(self) -> None:
        options = model_config_service.claude_command_options({
            "model_type": "claude_code",
            "model_name": "claude-test-v1",
            "thinking_level": "xhigh",
        })

        self.assertEqual(options, ["--model", "claude-test-v1", "--effort", "xhigh"])

    def test_managed_claude_runtime_overrides_user_provider_settings(self) -> None:
        runtime = {
            "model_type": "claude_code",
            "request_url": "https://minimax.example.com",
            "api_key": "managed-key",
            "model_name": "MiniMax-M3",
            "thinking_level": "xhigh",
        }
        with patch.dict(os.environ, {
            "ANTHROPIC_BASE_URL": "https://tokenone.example.com",
            "ANTHROPIC_AUTH_TOKEN": "tokenone-key",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "tokenone-model",
            "CLAUDE_CODE_EFFORT_LEVEL": "high",
            "UNRELATED_SETTING": "preserved",
        }, clear=True):
            options = model_config_service.claude_command_options(runtime)
            environment = model_config_service.claude_process_environment(runtime)

        self.assertEqual(
            options,
            [
                "--setting-sources", "project,local",
                "--model", "MiniMax-M3",
                "--effort", "xhigh",
            ],
        )
        self.assertEqual(environment["ANTHROPIC_BASE_URL"], "https://minimax.example.com")
        self.assertEqual(environment["ANTHROPIC_AUTH_TOKEN"], "managed-key")
        self.assertEqual(environment["ANTHROPIC_API_KEY"], "managed-key")
        self.assertNotIn("ANTHROPIC_DEFAULT_SONNET_MODEL", environment)
        self.assertNotIn("CLAUDE_CODE_EFFORT_LEVEL", environment)
        self.assertEqual(environment["UNRELATED_SETTING"], "preserved")

    def test_claude_model_test_uses_saved_runtime_without_fallback(self) -> None:
        fallback = self._create_claude_model(name="Claude 兜底模型", model_name="claude-fallback")
        self.conn.execute("UPDATE ai_model_configs SET api_key = ? WHERE id = ?", ("fallback-secret", fallback["id"]))
        primary = self._create_claude_model(
            name="Claude 主模型",
            model_name="claude-primary",
            fallback_model_id=fallback["id"],
        )
        process = SimpleNamespace(returncode=0, stdout=json.dumps({"result": "OK"}))

        with patch.object(model_config_service, "_claude_test_executable", return_value="/opt/claude"), patch.object(
            model_config_service.subprocess, "run", return_value=process
        ) as run:
            result = model_config_service.test_model_config(
                self.conn,
                actor=self.admin,
                model_id=primary["id"],
            )

        command = run.call_args.args[0]
        environment = run.call_args.kwargs["env"]
        self.assertEqual(result["model_type"], "claude_code")
        self.assertEqual(result["message"], "Claude Code 已完成测试请求。")
        self.assertIn("stream-json", command)
        self.assertIn("--no-session-persistence", command)
        self.assertIn("--tools", command)
        self.assertIn("--setting-sources", command)
        self.assertIn("claude-primary", command)
        self.assertNotIn("test-secret-key", command)
        self.assertEqual(environment["ANTHROPIC_AUTH_TOKEN"], "test-secret-key")
        self.assertNotIn("fallback-secret", environment.values())
        self.assertTrue(result["last_tested_at"])
        stored = self.conn.execute(
            "SELECT last_tested_at FROM ai_model_configs WHERE id = ?", (primary["id"],)
        ).fetchone()
        self.assertEqual(stored["last_tested_at"], result["last_tested_at"])
        audit = self.conn.execute("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(audit["action"], "model_config.test")
        self.assertEqual(audit["outcome"], "success")

    def test_model_test_status_is_cleared_when_the_test_target_changes(self) -> None:
        primary = self._create_claude_model(name="待重新测试模型", model_name="claude-primary")
        process = SimpleNamespace(returncode=0, stdout=json.dumps({"result": "OK"}))
        with patch.object(model_config_service, "_claude_test_executable", return_value="/opt/claude"), patch.object(
            model_config_service.subprocess, "run", return_value=process
        ):
            model_config_service.test_model_config(self.conn, actor=self.admin, model_id=primary["id"])

        updated = model_config_service.update_model_config(
            self.conn,
            actor=self.admin,
            model_id=primary["id"],
            payload={"model_name": "claude-primary-v2"},
        )

        self.assertIsNone(updated["last_tested_at"])

    def test_claude_model_test_accepts_a_successful_terminal_stream_event(self) -> None:
        primary = self._create_claude_model(name="流式测试模型", model_name="claude-primary")
        process = SimpleNamespace(
            returncode=0,
            stdout="\n".join((
                "provider diagnostic output",
                json.dumps({"type": "system", "subtype": "init"}),
                json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": ""}),
            )),
        )

        with patch.object(model_config_service, "_claude_test_executable", return_value="/opt/claude"), patch.object(
            model_config_service.subprocess, "run", return_value=process
        ):
            result = model_config_service.test_model_config(
                self.conn,
                actor=self.admin,
                model_id=primary["id"],
            )

        self.assertEqual(result["message"], "Claude Code 已完成测试请求。")

    def test_claude_model_test_accepts_a_successful_cli_exit_without_output(self) -> None:
        primary = self._create_claude_model(name="兼容中转输出模型", model_name="claude-primary")
        process = SimpleNamespace(returncode=0, stdout="")

        with patch.object(model_config_service, "_claude_test_executable", return_value="/opt/claude"), patch.object(
            model_config_service.subprocess, "run", return_value=process
        ):
            result = model_config_service.test_model_config(
                self.conn,
                actor=self.admin,
                model_id=primary["id"],
            )

        self.assertEqual(result["message"], "Claude Code 已完成测试请求。")

    def test_claude_model_test_rejects_an_explicit_terminal_error(self) -> None:
        primary = self._create_claude_model(name="显式失败模型", model_name="claude-primary")
        process = SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"type": "result", "is_error": True, "result": "provider rejected request"}),
        )

        with patch.object(model_config_service, "_claude_test_executable", return_value="/opt/claude"), patch.object(
            model_config_service.subprocess, "run", return_value=process
        ):
            with self.assertRaises(HTTPException) as context:
                model_config_service.test_model_config(
                    self.conn,
                    actor=self.admin,
                    model_id=primary["id"],
                )

        self.assertEqual(context.exception.status_code, 502)

    def test_image_model_test_generates_with_primary_runtime_only(self) -> None:
        fallback = model_config_service.create_model_config(
            self.conn,
            actor=self.admin,
            payload={
                "name": "生图兜底模型",
                "model_type": "image",
                "request_url": "https://images.example.com/v1",
                "api_key": "fallback-image-secret",
                "model_name": "image-fallback",
                "thinking_level": "medium",
                "image_size": "2K",
                "image_output_format": "png",
                "image_watermark": False,
                "fallback_model_id": None,
                "is_enabled": True,
            },
        )
        primary = model_config_service.create_model_config(
            self.conn,
            actor=self.admin,
            payload={
                "name": "生图主模型",
                "model_type": "image",
                "request_url": "https://images.example.com/v1",
                "api_key": "primary-image-secret",
                "model_name": "image-primary",
                "thinking_level": "medium",
                "image_size": "2K",
                "image_output_format": "png",
                "image_watermark": False,
                "fallback_model_id": fallback["id"],
                "is_enabled": True,
            },
        )

        with patch.object(
            script_sync_service,
            "request_image_generation",
            return_value="https://images.example.com/test.png",
        ) as generate:
            result = model_config_service.test_model_config(
                self.conn,
                actor=self.admin,
                model_id=primary["id"],
            )

        self.assertEqual(result["model_type"], "image")
        self.assertEqual(result["image_url"], "https://images.example.com/test.png")
        self.assertEqual(generate.call_args.kwargs["allow_fallback"], False)
        runtime = generate.call_args.args[1]
        self.assertEqual(runtime["api_key"], "primary-image-secret")
        self.assertNotIn("fallback", runtime)

    def test_failed_model_test_does_not_expose_cli_output(self) -> None:
        primary = self._create_claude_model(name="失败测试模型", model_name="claude-primary")
        process = SimpleNamespace(returncode=1, stdout="provider error: test-secret-key")

        with patch.object(model_config_service, "_claude_test_executable", return_value="/opt/claude"), patch.object(
            model_config_service.subprocess, "run", return_value=process
        ):
            with self.assertRaises(HTTPException) as context:
                model_config_service.test_model_config(
                    self.conn,
                    actor=self.admin,
                    model_id=primary["id"],
                )

        self.assertEqual(context.exception.status_code, 502)
        self.assertNotIn("test-secret-key", context.exception.detail)
        audit = self.conn.execute("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(audit["action"], "model_config.test")
        self.assertEqual(audit["outcome"], "failure")


if __name__ == "__main__":
    unittest.main()
