import json
import sqlite3
import tempfile
import unittest
from contextlib import nullcontext
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from unittest.mock import patch

from fastapi import HTTPException

from app.core.config import LOCAL_SCRIPT_SYNC_INTERNAL_TOKEN, LOCAL_SCRIPT_SYNC_WEB_BASE_URL
from app.db import session
from app.routers import admin as admin_router
from app.services import script_sync_service, workspace_service


class ScriptSyncServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.agents_dir = self.root / "Agents"
        self.workspaces_dir = self.agents_dir / "workspaces"
        self.workspaces_dir.mkdir(parents=True)
        self.settings = SimpleNamespace(
            data_dir=self.root / "data",
            database_path=self.root / "data" / "app.db",
            repo_root=self.root,
            agents_dir=self.agents_dir,
            workspaces_dir=self.workspaces_dir,
            lark_cli_command="lark-cli",
            script_sync_max_parallel=1,
            script_sync_execution_lease_seconds=900,
            internal_web_base_url="http://127.0.0.1:3000",
            script_sync_internal_token="test-internal-token",
        )
        self.patches = [
            patch.object(session, "settings", self.settings),
            patch.object(workspace_service, "settings", self.settings),
            patch.object(script_sync_service, "settings", self.settings),
            patch.object(
                script_sync_service,
                "distribution_brief_for_project",
                return_value={"brief": {"target_episode_count": 12}},
            ),
        ]
        for item in self.patches:
            item.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'admin', '管理员', 'hash', 'admin')"
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (2, 'author', '创建人', 'hash', 'user')"
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (3, 'editor', '修改人', 'hash', 'user')"
        )
        self.admin = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()

    def tearDown(self):
        self.conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def create_project(self, project_id: int, *, task_type: str, review_status: str, report_exists: bool = True, english_title: str = ""):
        workspace_name = f"script-{project_id}"
        workspace = self.workspaces_dir / workspace_name
        (workspace / "output").mkdir(parents=True)
        if report_exists:
            (workspace / "output" / "审稿报告.md").write_text("# 审稿报告\n", encoding="utf-8")
        (workspace / "3.1-outline.json").write_text(
            json.dumps({"剧本名称": f"中文剧本{project_id}", "英文剧本名称": english_title, "故事梗概": "故事梗概"}, ensure_ascii=False),
            encoding="utf-8",
        )
        (workspace / "review-scorecard.json").write_text(
            json.dumps(
                {
                    "总体结论": {"评级": "A"},
                    "剧本信息": {"剧本名称": f"评分卡剧本{project_id}", "题材": ["悬疑"], "剧本标签": ["追查", "反转"], "剧情梗概": "评分卡梗概"},
                    "卖点拆解": [{"卖点": "核心冲突", "观众为什么看": "悬念持续升级", "是否兑现": "已兑现"}],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (workspace / "1.2-project-progress.json").write_text(
            json.dumps(
                {
                    "stages": {"foreign_review": {"status": review_status}},
                    "audit": {"updated_by": "editor", "updated_at": "2026-08-03 12:34:56"},
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
            ) VALUES (?, 2, ?, ?, '北美', ?, 'foreign_review', 'active', 'session', '2026-08-01 10:00:00', '2026-08-03 12:34:56')
            """,
            (project_id, f"项目{project_id}", f"workspaces/{workspace_name}", task_type),
        )
        self.conn.execute(
            """
            INSERT INTO audit_logs (actor_user_id, actor_username, action, target_type, target_id, target_label, project_id, details_json)
            VALUES (2, 'author', 'project.create', 'project', ?, ?, ?, '{}')
            """,
            (str(project_id), f"项目{project_id}", project_id),
        )

    def configure_title_mapping(self):
        self.conn.execute(
            """
            INSERT INTO script_sync_config (id, base_url, base_token, table_id, table_name, fields_json, verified_at, updated_by)
            VALUES (1, 'https://example.feishu.cn/base/app', 'app_token', 'tbl_scripts', '剧本表', '[]', '2026-08-03 12:00:00', 1)
            """
        )
        self.conn.execute(
            """
            INSERT INTO script_sync_mappings (source_key, source_label, target_field_id, target_field_name, target_field_type)
            VALUES ('script_name', '剧本名称', 'fld_title', '剧本名称', 'text')
            """
        )

    def test_list_only_includes_adaptation_tasks_with_completed_review(self):
        self.create_project(1, task_type="rewrite", review_status="approved", english_title="English Title")
        self.create_project(2, task_type="novel", review_status="completed")
        self.create_project(3, task_type="review", review_status="approved")
        self.create_project(4, task_type="translate", review_status="completed")
        self.create_project(5, task_type="rewrite", review_status="running")
        self.create_project(6, task_type="novel", review_status="approved", report_exists=False)
        self.create_project(7, task_type="replicate", review_status="approved")
        self.conn.commit()

        result = script_sync_service.list_script_sync_scripts(self.conn)

        self.assertEqual([script["project_id"] for script in result["scripts"]], [7, 2, 1])
        self.assertEqual({script["scenario"] for script in result["scripts"]}, {"rewrite", "novel", "replicate"})
        self.assertEqual(result["scripts"][-1]["script_name"], "中文剧本1（English Title）")
        self.assertEqual(result["scripts"][-1]["creator"], "创建人")
        self.assertEqual(result["scripts"][-1]["last_modifier"], "修改人")
        self.assertTrue(all(script["sync_status"] == script_sync_service.SYNC_STATUS_PENDING for script in result["scripts"]))

    def test_list_keeps_supported_scenario_filters_when_empty(self):
        result = script_sync_service.list_script_sync_scripts(self.conn)

        self.assertEqual(result["scripts"], [])
        self.assertEqual(result["filters"]["scenarios"], ["rewrite", "novel", "replicate"])

    def test_sync_fields_and_source_do_not_include_selling_points(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.conn.commit()
        project = self.conn.execute(
            "SELECT projects.*, users.display_name AS owner_display_name FROM projects JOIN users ON users.id = projects.owner_user_id WHERE projects.id = 1"
        ).fetchone()
        source = script_sync_service._project_sync_source(self.conn, project)

        self.assertIsNotNone(source)
        self.assertNotIn("selling_points", {field["key"] for field in script_sync_service.system_sync_fields()})
        self.assertNotIn("selling_points", source["values"])
        self.assertEqual(source["values"]["data_source"], "自动同步")

    def test_data_source_is_a_single_select_with_manual_option(self):
        field = {item["key"]: item for item in script_sync_service.system_sync_fields()}["data_source"]

        self.assertEqual(field, {"key": "data_source", "label": "剧本来源", "kind": "select"})
        self.assertEqual(
            script_sync_service._auto_create_field(field),
            {
                "type": "select",
                "name": "剧本来源",
                "multiple": False,
                "options": [
                    {"name": "自动同步", "hue": "Blue", "lightness": "Lighter"},
                    {"name": "手动添加", "hue": "Gray", "lightness": "Lighter"},
                ],
            },
        )
        self.assertTrue(script_sync_service._field_is_compatible(field, {"type": "select", "multiple": False, "writable": True}))
        self.assertFalse(script_sync_service._field_is_compatible(field, {"type": "select", "multiple": True, "writable": True}))
        self.assertFalse(script_sync_service._field_is_compatible(field, {"type": "text", "multiple": False, "writable": True}))
        self.assertEqual(
            script_sync_service._field_value("自动同步", spec=field, target={"type": "select", "multiple": False}),
            "自动同步",
        )

    def test_sync_fields_include_cover_image_attachment(self):
        fields = {field["key"]: field for field in script_sync_service.system_sync_fields()}

        self.assertEqual(fields["cover_image"], {"key": "cover_image", "label": "封面图", "kind": "attachment"})

    def test_cover_image_prompt_includes_title_synopsis_and_distribution_context(self):
        prompt = script_sync_service._cover_image_prompt(
            "中文剧本（English Title）",
            "雨夜里，姐妹共同追查一宗旧案。",
            target_region="北美",
            target_countries=["美国", "加拿大"],
            target_locale="en-US",
        )

        self.assertIn("中文剧本（English Title）", prompt)
        self.assertIn("雨夜里，姐妹共同追查一宗旧案。", prompt)
        self.assertIn("目标区域：北美", prompt)
        self.assertIn("发行国家/地区：美国、加拿大", prompt)
        self.assertIn("主交付语言：en-US", prompt)
        self.assertIn("目标发行地（仅用于确定受众与视觉语境", prompt)
        self.assertIn("市场信息只能影响视觉策略", prompt)
        self.assertIn("标题中的中英文、括号和标点均属于标题本身", prompt)
        self.assertIn("除此之外", prompt)

    def test_distribution_context_is_included_in_source_hash(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.conn.commit()
        project = self.conn.execute(
            "SELECT projects.*, users.display_name AS owner_display_name FROM projects JOIN users ON users.id = projects.owner_user_id WHERE projects.id = 1"
        ).fetchone()

        with patch.object(
            script_sync_service,
            "distribution_brief_for_project",
            return_value={
                "target_region": "北美",
                "brief": {"target_episode_count": 12, "target_countries": ["美国"], "target_locale": "en-US"},
            },
        ):
            us_source = script_sync_service._project_sync_source(self.conn, project)
        with patch.object(
            script_sync_service,
            "distribution_brief_for_project",
            return_value={
                "target_region": "北美",
                "brief": {"target_episode_count": 12, "target_countries": ["加拿大"], "target_locale": "en-CA"},
            },
        ):
            canada_source = script_sync_service._project_sync_source(self.conn, project)

        self.assertEqual(
            us_source["cover_context"],
            {"target_region": "北美", "target_countries": ["美国"], "target_locale": "en-US"},
        )
        self.assertNotEqual(us_source["source_hash"], canada_source["source_hash"])

    def test_rewrite_sync_hash_uses_full_script_as_trial_source(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        workspace = self.workspaces_dir / "script-1"
        full_path = workspace / workspace_service.stage_file_for_workspace(workspace, "full_generate")
        trial_path = workspace / workspace_service.stage_file_for_workspace(workspace, "trial_generate")
        full_path.write_text("# 完整剧本\n", encoding="utf-8")
        trial_path.write_text("# 历史试稿\n", encoding="utf-8")

        before = script_sync_service._source_hashes(workspace, "rewrite")
        trial_path.write_text("# 不再作为改写同步来源\n", encoding="utf-8")
        after_trial_change = script_sync_service._source_hashes(workspace, "rewrite")
        full_path.write_text("# 完整剧本已修改\n", encoding="utf-8")
        after_full_change = script_sync_service._source_hashes(workspace, "rewrite")

        self.assertEqual(before, after_trial_change)
        self.assertNotEqual(after_trial_change, after_full_change)

    def test_novel_sync_hash_still_tracks_standalone_trial(self):
        self.create_project(1, task_type="novel", review_status="approved")
        workspace = self.workspaces_dir / "script-1"
        trial_path = workspace / workspace_service.stage_file_for_workspace(workspace, "trial_generate")
        trial_path.write_text("# 第一版试稿\n", encoding="utf-8")

        before = script_sync_service._source_hashes(workspace, "novel")
        trial_path.write_text("# 第二版试稿\n", encoding="utf-8")

        self.assertNotEqual(before, script_sync_service._source_hashes(workspace, "novel"))

    def test_completed_dialogue_translation_is_the_only_script_sync_source(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        workspace = self.workspaces_dir / "script-1"
        progress_path = workspace / "1.2-project-progress.json"
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        progress["stages"]["dialogue_translate"] = {"status": "completed"}
        progress_path.write_text(json.dumps(progress, ensure_ascii=False), encoding="utf-8")
        dialogue_path = workspace / workspace_service.stage_file_for_workspace(workspace, "dialogue_translate")
        full_path = workspace / workspace_service.stage_file_for_workspace(workspace, "full_generate")
        dialogue_path.write_text("# 台词译稿\n", encoding="utf-8")
        full_path.write_text("# 完整剧本\n", encoding="utf-8")

        before = script_sync_service._source_hashes(workspace, "rewrite")
        full_path.write_text("# 不再作为同步来源的完整剧本\n", encoding="utf-8")
        after_full_change = script_sync_service._source_hashes(workspace, "rewrite")
        dialogue_path.write_text("# 已更新的台词译稿\n", encoding="utf-8")
        after_dialogue_change = script_sync_service._source_hashes(workspace, "rewrite")

        self.assertEqual(before, after_full_change)
        self.assertNotEqual(after_full_change, after_dialogue_change)

    def test_attachment_url_selects_translated_trial_and_full_exports(self):
        self.assertEqual(
            script_sync_service._attachment_download_url(
                1,
                "trial_script",
                use_dialogue_translation=True,
            ),
            f"{self.settings.internal_web_base_url}/api/internal/script-sync/projects/1/attachments/trial_script?use_dialogue_translation=1",
        )
        self.assertEqual(
            script_sync_service._attachment_download_url(
                1,
                "full_script",
                use_dialogue_translation=True,
            ),
            f"{self.settings.internal_web_base_url}/api/internal/script-sync/projects/1/attachments/full_script?use_dialogue_translation=1",
        )
        self.assertNotIn(
            "use_dialogue_translation",
            script_sync_service._attachment_download_url(
                1,
                "review_report",
                use_dialogue_translation=True,
            ),
        )

    def test_attachment_batch_selects_translation_only_after_stage_is_completed(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.create_project(2, task_type="rewrite", review_status="approved")
        translated_workspace = self.workspaces_dir / "script-1"
        progress_path = translated_workspace / "1.2-project-progress.json"
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        progress["stages"]["dialogue_translate"] = {"status": "completed"}
        progress_path.write_text(json.dumps(progress, ensure_ascii=False), encoding="utf-8")
        dialogue_path = translated_workspace / workspace_service.stage_file_for_workspace(
            translated_workspace,
            "dialogue_translate",
        )
        dialogue_path.write_text("# 已完成的台词译稿\n", encoding="utf-8")
        in_progress_workspace = self.workspaces_dir / "script-2"
        in_progress_path = in_progress_workspace / "1.2-project-progress.json"
        in_progress = json.loads(in_progress_path.read_text(encoding="utf-8"))
        in_progress["stages"]["dialogue_translate"] = {"status": "running"}
        in_progress_path.write_text(json.dumps(in_progress, ensure_ascii=False), encoding="utf-8")
        (in_progress_workspace / workspace_service.stage_file_for_workspace(
            in_progress_workspace,
            "dialogue_translate",
        )).write_text("# 尚未完成的台词译稿\n", encoding="utf-8")
        self.configure_title_mapping()
        self.conn.executemany(
            """
            INSERT INTO script_sync_mappings (
                source_key, source_label, target_field_id, target_field_name, target_field_type
            ) VALUES (?, ?, ?, ?, 'attachment')
            """,
            [
                ("trial_script", "剧本一卡", "fld_trial", "剧本一卡"),
                ("full_script", "剧本正文", "fld_full", "剧本正文"),
            ],
        )
        self.conn.commit()

        def download(_project_id, _source_key, destination, **_kwargs):
            destination.write_bytes(b"PK\x03\x04valid-docx")

        with patch.object(script_sync_service, "_download_sync_attachment", side_effect=download) as download_attachment:
            script_sync_service._download_sync_attachments(self.conn, project_id=1)
            translated_calls = download_attachment.call_args_list.copy()
            download_attachment.reset_mock()
            script_sync_service._download_sync_attachments(self.conn, project_id=2)
            original_calls = download_attachment.call_args_list.copy()

        self.assertEqual(
            [call.kwargs["use_dialogue_translation"] for call in translated_calls],
            [True, True],
        )
        self.assertEqual(
            [call.kwargs["use_dialogue_translation"] for call in original_calls],
            [False, False],
        )

    def test_cover_image_request_uses_ark_images_api(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"data": [{"url": "https://images.example/cover.png"}]}'

        with patch.object(script_sync_service, "urlopen", return_value=Response()) as open_url:
            image_url = script_sync_service._request_cover_image("封面提示词", "test-api-key")

        request = open_url.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, f"{script_sync_service.COVER_IMAGE_BASE_URL}/images/generations")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-api-key")
        self.assertEqual(payload["model"], script_sync_service.COVER_IMAGE_MODEL)
        self.assertEqual(payload["prompt"], "封面提示词")
        self.assertEqual(payload["size"], "2K")
        self.assertEqual(payload["output_format"], "png")
        self.assertEqual(payload["response_format"], "url")
        self.assertFalse(payload["watermark"])
        self.assertEqual(image_url, "https://images.example/cover.png")

    def test_image_generation_can_disable_the_configured_fallback(self):
        primary = {
            "model_type": "image",
            "request_url": "https://images.example.com/v1",
            "api_key": "primary-image-key",
            "model_name": "image-primary",
            "image_size": "2K",
            "image_output_format": "png",
            "image_watermark": False,
            "fallback": {
                "model_type": "image",
                "request_url": "https://fallback-images.example.com/v1",
                "api_key": "fallback-image-key",
                "model_name": "image-fallback",
                "image_size": "2K",
                "image_output_format": "png",
                "image_watermark": False,
            },
        }

        with patch.object(script_sync_service, "urlopen", side_effect=RuntimeError("upstream unavailable")) as open_url:
            with self.assertRaises(script_sync_service.ScriptSyncError):
                script_sync_service.request_image_generation("测试图片", primary, allow_fallback=False)

        self.assertEqual(open_url.call_count, 1)
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "https://images.example.com/v1/images/generations")
        self.assertEqual(request.get_header("Authorization"), "Bearer primary-image-key")

    def test_legacy_selling_points_mapping_does_not_affect_config_hash(self):
        self.configure_title_mapping()
        config = self.conn.execute("SELECT * FROM script_sync_config WHERE id = 1").fetchone()
        baseline_hash = script_sync_service._config_hash(config, script_sync_service._mapping_rows(self.conn))
        self.conn.execute(
            """
            INSERT INTO script_sync_mappings (source_key, source_label, target_field_id, target_field_name, target_field_type)
            VALUES ('selling_points', '核心卖点', 'fld_selling_points', '核心卖点', 'text')
            """
        )

        mappings = script_sync_service._mapping_rows(self.conn)

        self.assertNotIn("selling_points", mappings)
        self.assertEqual(script_sync_service._config_hash(config, mappings), baseline_hash)

    def test_init_db_migrates_sync_records_to_allow_ignored_status(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.conn.execute("DROP TABLE script_sync_records")
        self.conn.execute(
            """
            CREATE TABLE script_sync_records (
                project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                base_record_id TEXT,
                target_key TEXT NOT NULL DEFAULT '',
                source_hash TEXT NOT NULL DEFAULT '',
                config_hash TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'synced', 'needs_update', 'failed')),
                synced_at TEXT,
                last_attempt_at TEXT,
                last_error TEXT,
                attachment_tokens_json TEXT NOT NULL DEFAULT '{}',
                synced_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self.conn.execute(
            "INSERT INTO script_sync_records (project_id, status) VALUES (1, 'synced')"
        )
        self.conn.commit()

        session.init_db()

        table = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'script_sync_records'"
        ).fetchone()
        record = self.conn.execute("SELECT status FROM script_sync_records WHERE project_id = 1").fetchone()
        self.conn.execute("UPDATE script_sync_records SET status = 'ignored' WHERE project_id = 1")

        self.assertIn("'ignored'", table["sql"].lower())
        self.assertEqual(record["status"], script_sync_service.SYNC_STATUS_SYNCED)

    def test_init_db_maps_existing_data_source_field(self):
        self.conn.execute(
            """
            INSERT INTO script_sync_config (id, base_url, base_token, table_id, table_name, fields_json, verified_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                1,
                "https://example.feishu.cn/base/app",
                "app_token",
                "tbl_scripts",
                "剧本表",
                json.dumps([
                    {"id": "fld_title", "name": "剧本名称", "type": "text", "multiple": False, "writable": True},
                    {"id": "fld_source", "name": "剧本来源", "type": "select", "multiple": False, "writable": True},
                ], ensure_ascii=False),
                "2026-08-03 12:00:00",
                1,
            ),
        )
        self.conn.commit()

        session.init_db()

        mapping = self.conn.execute(
            "SELECT * FROM script_sync_mappings WHERE source_key = 'data_source'"
        ).fetchone()
        self.assertEqual(mapping["source_label"], "剧本来源")
        self.assertEqual(mapping["target_field_id"], "fld_source")
        self.assertEqual(mapping["target_field_type"], "select")

    def test_synced_record_becomes_needs_update_when_source_changes(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()
        project = self.conn.execute(
            "SELECT projects.*, users.display_name AS owner_display_name FROM projects JOIN users ON users.id = projects.owner_user_id WHERE projects.id = 1"
        ).fetchone()
        source = script_sync_service._project_sync_source(self.conn, project)
        self.assertIsNotNone(source)
        config = self.conn.execute("SELECT * FROM script_sync_config WHERE id = 1").fetchone()
        mappings = script_sync_service._mapping_rows(self.conn)
        script_sync_service._upsert_sync_record(
            self.conn,
            project_id=1,
            base_record_id="rec_existing",
            target_key=script_sync_service._target_key(config),
            source_hash=source["source_hash"],
            config_hash=script_sync_service._config_hash(config, mappings),
            status_value=script_sync_service.SYNC_STATUS_SYNCED,
            actor_id=1,
        )
        self.conn.commit()

        synced = script_sync_service.list_script_sync_scripts(self.conn)["scripts"]
        self.assertEqual(synced[0]["sync_status"], script_sync_service.SYNC_STATUS_SYNCED)

        outline_path = self.workspaces_dir / "script-1" / "3.1-outline.json"
        outline = json.loads(outline_path.read_text(encoding="utf-8"))
        outline["故事梗概"] = "已修改的故事梗概"
        outline_path.write_text(json.dumps(outline, ensure_ascii=False), encoding="utf-8")

        changed = script_sync_service.list_script_sync_scripts(self.conn)["scripts"]
        self.assertEqual(changed[0]["sync_status"], script_sync_service.SYNC_STATUS_NEEDS_UPDATE)

    def test_ignored_script_stays_ignored_and_cannot_be_synced(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()

        result = admin_router.post_ignore_script_sync_project(1, conn=self.conn, actor=self.admin)["sync"]
        record = self.conn.execute("SELECT status, last_error FROM script_sync_records WHERE project_id = 1").fetchone()
        ignored_scripts = script_sync_service.list_script_sync_scripts(
            self.conn,
            sync_statuses={script_sync_service.SYNC_STATUS_IGNORED},
        )["scripts"]
        outline_path = self.workspaces_dir / "script-1" / "3.1-outline.json"
        outline = json.loads(outline_path.read_text(encoding="utf-8"))
        outline["故事梗概"] = "已修改的故事梗概"
        outline_path.write_text(json.dumps(outline, ensure_ascii=False), encoding="utf-8")

        self.assertEqual(result["status"], script_sync_service.SYNC_STATUS_IGNORED)
        self.assertEqual(record["status"], script_sync_service.SYNC_STATUS_IGNORED)
        self.assertIsNone(record["last_error"])
        self.assertEqual([script["project_id"] for script in ignored_scripts], [1])
        self.assertEqual(
            script_sync_service.list_script_sync_scripts(self.conn)["scripts"][0]["sync_status"],
            script_sync_service.SYNC_STATUS_IGNORED,
        )

        with patch.object(script_sync_service, "_base_command") as base_command:
            with self.assertRaisesRegex(script_sync_service.ScriptSyncError, "已被忽略"):
                script_sync_service.sync_project_to_base(
                    self.conn,
                    actor=self.admin,
                    project_id=1,
                    attachments={},
                )
        base_command.assert_not_called()

        script_sync_service.mark_project_sync_failed(
            self.conn,
            actor=self.admin,
            project_id=1,
            message="附件导出失败",
        )
        self.assertEqual(
            self.conn.execute("SELECT status FROM script_sync_records WHERE project_id = 1").fetchone()["status"],
            script_sync_service.SYNC_STATUS_IGNORED,
        )

    def test_sync_submission_persists_every_selected_project_before_work_starts(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.create_project(2, task_type="novel", review_status="completed")
        self.configure_title_mapping()
        self.conn.commit()

        submitted = script_sync_service.enqueue_script_sync_jobs(
            self.conn,
            actor=self.admin,
            project_ids=[1, 2],
        )
        active = script_sync_service.list_active_script_sync_jobs(self.conn)
        repeated = script_sync_service.enqueue_script_sync_jobs(
            self.conn,
            actor=self.admin,
            project_ids=[1, 2],
        )

        self.assertEqual(submitted["queued_project_ids"], [1, 2])
        self.assertEqual([job["project_id"] for job in active["jobs"]], [1, 2])
        self.assertEqual(repeated["queued_project_ids"], [])
        self.assertEqual(repeated["already_active_project_ids"], [1, 2])
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) AS count FROM script_sync_jobs").fetchone()["count"],
            2,
        )

    def test_running_sync_job_is_requeued_for_service_recovery(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.conn.execute(
            """
            INSERT INTO script_sync_jobs (project_id, requested_by, status, execution_owner, execution_lease_expires_at)
            VALUES (1, 1, 'running', 'previous-process', '2099-01-01T00:00:00Z')
            """
        )
        self.conn.commit()

        recovered = script_sync_service.recover_script_sync_jobs(self.conn, force=True)

        self.assertEqual(recovered, [1])
        self.assertEqual(
            self.conn.execute("SELECT status FROM script_sync_jobs WHERE id = 1").fetchone()["status"],
            script_sync_service.SCRIPT_SYNC_JOB_STATUS_QUEUED,
        )

    def test_sync_worker_finishes_persisted_job_without_a_browser_request(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()
        submitted = script_sync_service.enqueue_script_sync_jobs(self.conn, actor=self.admin, project_ids=[1])
        job_id = submitted["jobs"][0]["id"]
        self.assertEqual(script_sync_service.schedule_script_sync_jobs(self.conn), [job_id])
        work_directory = self.root / "sync-job"
        work_directory.mkdir()

        with patch.object(script_sync_service, "get_connection", side_effect=lambda: nullcontext(self.conn)), patch.object(
            script_sync_service,
            "_download_sync_attachments",
            return_value=(work_directory, {}),
        ) as download_attachments, patch.object(
            script_sync_service,
            "sync_project_to_base",
            return_value={"status": "synced"},
        ) as sync_project, patch.object(script_sync_service, "dispatch_script_sync_jobs"):
            script_sync_service.run_script_sync_job(job_id)

        job = self.conn.execute("SELECT status, last_error FROM script_sync_jobs WHERE id = ?", (job_id,)).fetchone()
        self.assertEqual(job["status"], script_sync_service.SCRIPT_SYNC_JOB_STATUS_SUCCEEDED)
        self.assertIsNone(job["last_error"])
        download_attachments.assert_called_once_with(self.conn, project_id=1)
        self.assertIs(sync_project.call_args.args[0], self.conn)
        self.assertEqual(sync_project.call_args.kwargs["actor"]["id"], self.admin["id"])
        self.assertEqual(sync_project.call_args.kwargs["project_id"], 1)
        self.assertEqual(sync_project.call_args.kwargs["attachments"], {})

    def test_sync_worker_releases_snapshot_write_before_exporting_attachments(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()
        submitted = script_sync_service.enqueue_script_sync_jobs(self.conn, actor=self.admin, project_ids=[1])
        job_id = submitted["jobs"][0]["id"]
        self.assertEqual(script_sync_service.schedule_script_sync_jobs(self.conn), [job_id])
        work_directory = self.root / "sync-job-transaction"
        work_directory.mkdir()

        def persist_snapshot(conn, *, table_name, row, route_keys):
            self.assertEqual(table_name, "script_sync_jobs")
            self.assertEqual(tuple(route_keys), (("script_sync", "cover_image"),))
            conn.execute(
                "UPDATE script_sync_jobs SET model_config_snapshot_json = ? WHERE id = ?",
                ('{"routes": {}}', row["id"]),
            )
            return conn.execute("SELECT * FROM script_sync_jobs WHERE id = ?", (row["id"],)).fetchone()

        def download_attachments(conn, *, project_id):
            self.assertEqual(project_id, 1)
            self.assertFalse(conn.in_transaction)
            return work_directory, {}

        with patch.object(script_sync_service, "get_connection", side_effect=lambda: nullcontext(self.conn)), patch.object(
            script_sync_service,
            "ensure_persisted_model_snapshot",
            side_effect=persist_snapshot,
        ), patch.object(
            script_sync_service,
            "_download_sync_attachments",
            side_effect=download_attachments,
        ), patch.object(
            script_sync_service,
            "sync_project_to_base",
            return_value={"status": "synced"},
        ), patch.object(script_sync_service, "dispatch_script_sync_jobs"):
            script_sync_service.run_script_sync_job(job_id)

        job = self.conn.execute("SELECT status FROM script_sync_jobs WHERE id = ?", (job_id,)).fetchone()
        self.assertEqual(job["status"], script_sync_service.SCRIPT_SYNC_JOB_STATUS_SUCCEEDED)

    def test_sync_rejects_ineligible_scene_before_calling_feishu(self):
        self.create_project(1, task_type="review", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()
        with patch.object(script_sync_service, "_base_command") as base_command:
            with self.assertRaisesRegex(script_sync_service.ScriptSyncError, "不属于可同步范围"):
                script_sync_service.sync_project_to_base(
                    self.conn,
                    actor=self.admin,
                    project_id=1,
                    attachments={},
                )
        base_command.assert_not_called()

    def test_link_test_marks_permission_denied_target_as_reachable_and_requests_authorization(self):
        with patch.object(
            script_sync_service,
            "_resolve_base_url",
            side_effect=script_sync_service.LarkCliError("permission denied", code=131006),
        ), patch.object(script_sync_service, "_user_identity_ready", return_value=False), patch.object(
            script_sync_service, "begin_script_sync_authorization", return_value="https://auth.example"
        ):
            result = script_sync_service.test_script_sync_target(self.conn, url="https://example.feishu.cn/wiki/token")

        self.assertTrue(result["reachable"])
        self.assertFalse(result["authorized"])
        self.assertEqual(result["authorization_url"], "https://auth.example")
        self.assertIn("授权", result["message"])

    def test_link_test_requests_authorization_for_missing_wiki_scope(self):
        with patch.object(
            script_sync_service,
            "_resolve_base_url",
            side_effect=script_sync_service.LarkCliError(
                "unauthorized: user authorization does not cover the required scope(s): wiki:node:read"
            ),
        ), patch.object(script_sync_service, "_user_identity_ready", return_value=True), patch.object(
            script_sync_service, "begin_script_sync_authorization", return_value="https://auth.example"
        ):
            result = script_sync_service.test_script_sync_target(self.conn, url="https://example.feishu.cn/wiki/token")

        self.assertTrue(result["reachable"])
        self.assertFalse(result["authorized"])
        self.assertEqual(result["authorization_url"], "https://auth.example")

    def test_authorization_requests_base_and_wiki_domains(self):
        response = {
            "verification_url": "https://auth.example",
            "device_code": "device-code",
        }
        with patch.object(script_sync_service, "_run_lark_cli", return_value=response) as run_cli:
            authorization_url = script_sync_service.begin_script_sync_authorization(self.conn)

        self.assertEqual(authorization_url, "https://auth.example")
        run_cli.assert_called_once_with(
            ["auth", "login", "--domain", "base", "--domain", "wiki", "--no-wait", "--json"]
        )

    def test_completed_authorization_clears_pending_session_when_cli_reports_completion_late(self):
        script_sync_service._store_authorization(
            self.conn,
            verification_url="https://auth.example",
            device_code="device-code",
        )
        with patch.object(
            script_sync_service,
            "_run_lark_cli",
            side_effect=[
                script_sync_service.LarkCliError("飞书连接未完成"),
                {"identities": {"user": {"status": "ready", "available": True, "verified": True}}},
            ],
        ):
            result = script_sync_service.complete_script_sync_authorization(self.conn)

        row = self.conn.execute("SELECT authorization_url, authorization_device_code FROM script_sync_config WHERE id = 1").fetchone()
        self.assertTrue(result["authorized"])
        self.assertIsNone(row["authorization_url"])
        self.assertIsNone(row["authorization_device_code"])

    def test_link_test_auto_maps_same_named_writable_fields(self):
        fields = [
            {"id": "fld_title", "name": "剧本名称", "type": "text", "multiple": False, "writable": True},
            {"id": "fld_source", "name": "剧本来源", "type": "select", "multiple": False, "writable": True},
            {"id": "fld_cover", "name": "封面图", "type": "attachment", "multiple": False, "writable": True},
            {"id": "fld_report", "name": "审稿报告", "type": "attachment", "multiple": False, "writable": True},
            {"id": "fld_readonly", "name": "同步时间", "type": "formula", "multiple": False, "writable": False},
        ]
        with patch.object(
            script_sync_service,
            "_resolve_base_url",
            return_value=("app_token", {"id": "tbl_scripts", "name": "剧本表"}, fields),
        ):
            result = script_sync_service.test_script_sync_target(self.conn, url="https://example.feishu.cn/wiki/token")

        mappings = {item["source_key"]: item for item in result["mappings"]}
        self.assertTrue(result["reachable"])
        self.assertTrue(result["authorized"])
        self.assertEqual(mappings["script_name"]["target_field_id"], "fld_title")
        self.assertEqual(mappings["data_source"]["target_field_id"], "fld_source")
        self.assertEqual(mappings["cover_image"]["target_field_id"], "fld_cover")
        self.assertEqual(mappings["review_report"]["target_field_id"], "fld_report")
        self.assertIsNone(mappings["sync_time"]["target_field_id"])

    def test_sync_without_cover_mapping_does_not_generate_cover_image(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()

        def base_command(action, _arguments, **_kwargs):
            if action == "+field-list":
                return {"data": {"items": [{"field_id": "fld_title", "field_name": "剧本名称", "type": "text"}]}}
            if action == "+record-list":
                return {"data": {"fields": ["剧本名称"], "data": [], "record_id_list": []}}
            if action == "+record-upsert":
                return {"data": {"record_id": "rec_new", "created": True}}
            self.fail(f"unexpected Feishu command: {action}")

        with patch.object(script_sync_service, "_base_command", side_effect=base_command), patch.object(
            script_sync_service, "_generate_cover_image"
        ) as generate_cover:
            result = script_sync_service.sync_project_to_base(
                self.conn,
                actor=self.admin,
                project_id=1,
                attachments={},
            )

        self.assertEqual(result["record_id"], "rec_new")
        generate_cover.assert_not_called()

    def test_attachment_download_retries_invalid_word_response(self):
        class Response:
            def __init__(self, content: bytes):
                self.content = content

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size: int):
                return self.content

        destination = self.root / "full-script.docx"
        with patch.object(
            script_sync_service,
            "urlopen",
            side_effect=[Response(b"temporarily unavailable"), Response(b"PK\x03\x04valid-docx")],
        ) as open_url, patch.object(script_sync_service.time, "sleep") as sleep:
            script_sync_service._download_sync_attachment(1, "full_script", destination)

        self.assertEqual(destination.read_bytes(), b"PK\x03\x04valid-docx")
        self.assertEqual(open_url.call_count, 2)
        sleep.assert_called_once_with(2.0)

    def test_attachment_download_retries_server_error_until_export_is_ready(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size: int):
                return b"PK\x03\x04valid-docx"

        error = HTTPError(
            "http://example.test/export",
            500,
            "Internal Server Error",
            None,
            BytesIO('{"detail":"Word 文档正在准备中"}'.encode("utf-8")),
        )
        destination = self.root / "full-script.docx"
        with patch.object(script_sync_service, "urlopen", side_effect=[error, Response()]) as open_url, patch.object(
            script_sync_service.time, "sleep"
        ) as sleep:
            script_sync_service._download_sync_attachment(1, "full_script", destination)

        self.assertEqual(destination.read_bytes(), b"PK\x03\x04valid-docx")
        self.assertEqual(open_url.call_count, 2)
        sleep.assert_called_once_with(2.0)

    def test_attachment_download_keeps_upstream_error_detail(self):
        errors = [
            HTTPError(
                "http://example.test/export",
                500,
                "Internal Server Error",
                None,
                BytesIO('{"detail":"完本 Word 正在生成，请稍后重试"}'.encode("utf-8")),
            )
            for _ in script_sync_service.ATTACHMENT_DOWNLOAD_RETRY_DELAYS
        ]
        destination = self.root / "full-script.docx"
        with patch.object(script_sync_service, "urlopen", side_effect=errors), patch.object(
            script_sync_service.time, "sleep"
        ):
            with self.assertRaisesRegex(script_sync_service.ScriptSyncError, "完本 Word 正在生成"):
                script_sync_service._download_sync_attachment(1, "full_script", destination)

    def test_attachment_export_uses_local_defaults_when_enabled(self):
        self.settings.internal_web_base_url = ""
        self.settings.script_sync_internal_token = ""
        self.settings.script_sync_local_mode = True

        base_url, token = script_sync_service._attachment_export_configuration()

        self.assertEqual(base_url, LOCAL_SCRIPT_SYNC_WEB_BASE_URL)
        self.assertEqual(token, LOCAL_SCRIPT_SYNC_INTERNAL_TOKEN)
        self.assertEqual(
            script_sync_service._attachment_download_url(1, "full_script"),
            f"{LOCAL_SCRIPT_SYNC_WEB_BASE_URL}/api/internal/script-sync/projects/1/attachments/full_script",
        )

    def test_attachment_export_requires_configuration_outside_local_mode(self):
        self.settings.internal_web_base_url = ""
        self.settings.script_sync_internal_token = ""
        self.settings.script_sync_local_mode = False

        with self.assertRaisesRegex(script_sync_service.ScriptSyncError, "尚未配置"):
            script_sync_service._attachment_download_url(1, "full_script")

    def test_attachment_download_reports_invalid_word_response_after_retries(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size: int):
                return b"not-a-docx"

        destination = self.root / "full-script.docx"
        with patch.object(script_sync_service, "urlopen", return_value=Response()), patch.object(
            script_sync_service.time, "sleep"
        ) as sleep:
            with self.assertRaisesRegex(script_sync_service.ScriptSyncError, "未返回有效的 Word 文档"):
                script_sync_service._download_sync_attachment(1, "full_script", destination)

        self.assertFalse(destination.exists())
        self.assertEqual(sleep.call_count, 3)

    def test_sync_writes_automatic_data_source_to_single_select_field(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.execute(
            """
            INSERT INTO script_sync_mappings (source_key, source_label, target_field_id, target_field_name, target_field_type)
            VALUES ('data_source', '剧本来源', 'fld_source', '剧本来源', 'select')
            """
        )
        self.conn.commit()

        def base_command(action, arguments, **_kwargs):
            if action == "+field-list":
                return {
                    "data": {
                        "items": [
                            {"field_id": "fld_title", "field_name": "剧本名称", "type": "text"},
                            {
                                "field_id": "fld_source",
                                "field_name": "剧本来源",
                                "type": "select",
                                "property": {"multiple": False},
                            },
                        ]
                    }
                }
            if action == "+record-list":
                return {"data": {"fields": ["剧本名称"], "data": [], "record_id_list": []}}
            if action == "+record-upsert":
                values = json.loads(arguments[arguments.index("--json") + 1])
                self.assertEqual(values["fld_title"], "中文剧本1")
                self.assertEqual(values["fld_source"], "自动同步")
                return {"data": {"record_id": "rec_new", "created": True}}
            self.fail(f"unexpected Feishu command: {action}")

        result = None
        with patch.object(script_sync_service, "_base_command", side_effect=base_command):
            result = script_sync_service.sync_project_to_base(
                self.conn,
                actor=self.admin,
                project_id=1,
                attachments={},
            )

        self.assertEqual(result["record_id"], "rec_new")

    def test_sync_generates_uploads_and_cleans_up_cover_image(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.execute(
            """
            INSERT INTO script_sync_mappings (source_key, source_label, target_field_id, target_field_name, target_field_type)
            VALUES ('cover_image', '封面图', 'fld_cover', '封面图', 'attachment')
            """
        )
        self.conn.commit()
        cover_directory = self.root / "data" / "generated-cover"
        cover_directory.mkdir(parents=True)
        cover_path = cover_directory / "cover-image.png"
        cover_path.write_bytes(b"\\x89PNG\\r\\n\\x1a\\ncover")

        def base_command(action, arguments, **_kwargs):
            if action == "+field-list":
                return {
                    "data": {
                        "items": [
                            {"field_id": "fld_title", "field_name": "剧本名称", "type": "text"},
                            {"field_id": "fld_cover", "field_name": "封面图", "type": "attachment"},
                        ]
                    }
                }
            if action == "+record-list":
                return {"data": {"fields": ["剧本名称"], "data": [], "record_id_list": []}}
            if action == "+record-upsert":
                return {"data": {"record_id": "rec_new", "created": True}}
            if action == "+record-upload-attachment":
                self.assertEqual(arguments[arguments.index("--field-id") + 1], "fld_cover")
                self.assertEqual(arguments[arguments.index("--file") + 1], "data/generated-cover/cover-image.png")
                return {"data": {"file_token": "file_cover"}}
            self.fail(f"unexpected Feishu command: {action}")

        with patch.object(script_sync_service, "_generate_cover_image", return_value=(cover_path, cover_directory)) as generate_cover, patch.object(
            script_sync_service, "_base_command", side_effect=base_command
        ):
            result = script_sync_service.sync_project_to_base(
                self.conn,
                actor=self.admin,
                project_id=1,
                attachments={},
            )

        record = self.conn.execute("SELECT attachment_tokens_json FROM script_sync_records WHERE project_id = 1").fetchone()
        self.assertEqual(result["record_id"], "rec_new")
        generate_cover.assert_called_once()
        self.assertEqual(json.loads(record["attachment_tokens_json"]), {"cover_image": ["file_cover"]})
        self.assertFalse(cover_directory.exists())

    def test_field_validation_failure_is_recorded_as_sync_failure(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()
        with patch.object(
            script_sync_service,
            "_base_command",
            side_effect=script_sync_service.LarkCliError("permission denied", code=131006),
        ):
            with self.assertRaisesRegex(script_sync_service.LarkCliError, "permission denied"):
                script_sync_service.sync_project_to_base(
                    self.conn,
                    actor=self.admin,
                    project_id=1,
                    attachments={},
                )

        record = self.conn.execute("SELECT status, last_error FROM script_sync_records WHERE project_id = 1").fetchone()
        self.assertEqual(record["status"], script_sync_service.SYNC_STATUS_FAILED)
        self.assertIn("permission denied", record["last_error"])

    def test_sync_upserts_eligible_script_with_feishu_cli(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()
        record_list_results = iter(
            [
                {"data": {"fields": ["剧本名称"], "data": [], "record_id_list": []}},
                {"data": {"fields": ["剧本名称"], "data": [["中文剧本1"]], "record_id_list": ["rec_new"]}},
            ]
        )

        def base_command(action, _arguments, **_kwargs):
            if action == "+field-list":
                return {"data": {"items": [{"field_id": "fld_title", "field_name": "剧本名称", "type": "text"}]}}
            if action == "+record-list":
                return next(record_list_results)
            if action == "+record-upsert":
                return {"data": {"record": {"create": {"剧本名称": "中文剧本1"}}, "created": True}}
            self.fail(f"unexpected Feishu command: {action}")

        with patch.object(script_sync_service, "_base_command", side_effect=base_command) as mocked:
            result = script_sync_service.sync_project_to_base(
                self.conn,
                actor=self.admin,
                project_id=1,
                attachments={},
            )

        self.assertEqual(result["record_id"], "rec_new")
        self.assertEqual(result["status"], script_sync_service.SYNC_STATUS_SYNCED)
        record = self.conn.execute("SELECT * FROM script_sync_records WHERE project_id = 1").fetchone()
        self.assertEqual(record["status"], script_sync_service.SYNC_STATUS_SYNCED)
        self.assertEqual(record["base_record_id"], "rec_new")
        self.assertEqual(
            [call.args[0] for call in mocked.call_args_list],
            ["+field-list", "+record-list", "+record-upsert", "+record-list"],
        )

    def test_sync_retries_title_lookup_until_created_record_is_visible(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()
        record_list_results = iter(
            [
                {"data": {"fields": ["剧本名称"], "data": [], "record_id_list": []}},
                {"data": {"fields": ["剧本名称"], "data": [], "record_id_list": []}},
                {"data": {"fields": ["剧本名称"], "data": [], "record_id_list": []}},
                {"data": {"fields": ["剧本名称"], "data": [["中文剧本1"]], "record_id_list": ["rec_new"]}},
            ]
        )

        def base_command(action, _arguments, **_kwargs):
            if action == "+field-list":
                return {"data": {"items": [{"field_id": "fld_title", "field_name": "剧本名称", "type": "text"}]}}
            if action == "+record-list":
                return next(record_list_results)
            if action == "+record-upsert":
                return {"data": {"record": {"create": {"剧本名称": "中文剧本1"}}, "created": True}}
            self.fail(f"unexpected Feishu command: {action}")

        with patch.object(script_sync_service, "_base_command", side_effect=base_command) as mocked, patch.object(
            script_sync_service.time, "sleep"
        ) as sleep:
            result = script_sync_service.sync_project_to_base(
                self.conn,
                actor=self.admin,
                project_id=1,
                attachments={},
            )

        self.assertEqual(result["record_id"], "rec_new")
        self.assertEqual(
            [call.args[0] for call in mocked.call_args_list],
            ["+field-list", "+record-list", "+record-upsert", "+record-list", "+record-list", "+record-list"],
        )
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.5, 1.0])

    def test_sync_reuses_exactly_one_matching_title_record(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        self.conn.commit()

        def base_command(action, arguments, **_kwargs):
            if action == "+field-list":
                return {"data": {"items": [{"field_id": "fld_title", "field_name": "剧本名称", "type": "text"}]}}
            if action == "+record-list":
                return {
                    "data": {
                        "fields": ["剧本名称"],
                        "data": [["中文剧本1"]],
                        "record_id_list": ["rec_existing"],
                    }
                }
            if action == "+record-upsert":
                self.assertIn("--record-id", arguments)
                self.assertEqual(arguments[arguments.index("--record-id") + 1], "rec_existing")
                return {"data": {"record": {"update": {"剧本名称": "中文剧本1"}}, "updated": True}}
            self.fail(f"unexpected Feishu command: {action}")

        with patch.object(script_sync_service, "_base_command", side_effect=base_command):
            result = script_sync_service.sync_project_to_base(
                self.conn,
                actor=self.admin,
                project_id=1,
                attachments={},
            )

        self.assertEqual(result["record_id"], "rec_existing")

    def test_sync_recreates_deleted_base_record(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        project = self.conn.execute(
            "SELECT projects.*, users.display_name AS owner_display_name FROM projects JOIN users ON users.id = projects.owner_user_id WHERE projects.id = 1"
        ).fetchone()
        source = script_sync_service._project_sync_source(self.conn, project)
        config = self.conn.execute("SELECT * FROM script_sync_config WHERE id = 1").fetchone()
        mappings = script_sync_service._mapping_rows(self.conn)
        script_sync_service._upsert_sync_record(
            self.conn,
            project_id=1,
            base_record_id="rec_deleted",
            target_key=script_sync_service._target_key(config),
            source_hash=source["source_hash"],
            config_hash=script_sync_service._config_hash(config, mappings),
            status_value=script_sync_service.SYNC_STATUS_SYNCED,
            actor_id=1,
        )
        self.conn.commit()

        def base_command(action, arguments, **_kwargs):
            if action == "+field-list":
                return {"data": {"items": [{"field_id": "fld_title", "field_name": "剧本名称", "type": "text"}]}}
            if action == "+record-get":
                self.assertIn("rec_deleted", arguments)
                return {"data": {"record_not_found": ["rec_deleted"]}}
            if action == "+record-upsert":
                self.assertNotIn("--record-id", arguments)
                return {"data": {"record_id": "rec_recreated", "created": True}}
            self.fail(f"unexpected Feishu command: {action}")

        with patch.object(script_sync_service, "_base_command", side_effect=base_command) as mocked:
            result = script_sync_service.sync_project_to_base(
                self.conn,
                actor=self.admin,
                project_id=1,
                attachments={},
            )

        record = self.conn.execute("SELECT * FROM script_sync_records WHERE project_id = 1").fetchone()
        self.assertEqual(result["record_id"], "rec_recreated")
        self.assertEqual(record["status"], script_sync_service.SYNC_STATUS_SYNCED)
        self.assertEqual(record["base_record_id"], "rec_recreated")
        self.assertEqual([call.args[0] for call in mocked.call_args_list], ["+field-list", "+record-get", "+record-upsert"])

    def test_sync_recreates_record_when_it_is_deleted_after_the_existence_check(self):
        self.create_project(1, task_type="rewrite", review_status="approved")
        self.configure_title_mapping()
        project = self.conn.execute(
            "SELECT projects.*, users.display_name AS owner_display_name FROM projects JOIN users ON users.id = projects.owner_user_id WHERE projects.id = 1"
        ).fetchone()
        source = script_sync_service._project_sync_source(self.conn, project)
        config = self.conn.execute("SELECT * FROM script_sync_config WHERE id = 1").fetchone()
        mappings = script_sync_service._mapping_rows(self.conn)
        script_sync_service._upsert_sync_record(
            self.conn,
            project_id=1,
            base_record_id="rec_deleted",
            target_key=script_sync_service._target_key(config),
            source_hash=source["source_hash"],
            config_hash=script_sync_service._config_hash(config, mappings),
            status_value=script_sync_service.SYNC_STATUS_SYNCED,
            actor_id=1,
        )
        self.conn.commit()
        upsert_calls = 0

        def base_command(action, arguments, **_kwargs):
            nonlocal upsert_calls
            if action == "+field-list":
                return {"data": {"items": [{"field_id": "fld_title", "field_name": "剧本名称", "type": "text"}]}}
            if action == "+record-get":
                return {"data": {"record_id_list": ["rec_deleted"]}}
            if action == "+record-upsert":
                upsert_calls += 1
                if upsert_calls == 1:
                    self.assertIn("--record-id", arguments)
                    raise script_sync_service.LarkCliError("request failed", code=125404)
                self.assertNotIn("--record-id", arguments)
                return {"data": {"record_id": "rec_recreated", "created": True}}
            self.fail(f"unexpected Feishu command: {action}")

        with patch.object(script_sync_service, "_base_command", side_effect=base_command):
            result = script_sync_service.sync_project_to_base(
                self.conn,
                actor=self.admin,
                project_id=1,
                attachments={},
            )

        self.assertEqual(result["record_id"], "rec_recreated")
        self.assertEqual(
            self.conn.execute("SELECT base_record_id FROM script_sync_records WHERE project_id = 1").fetchone()["base_record_id"],
            "rec_recreated",
        )

    def test_sync_route_commits_failure_state_before_returning_error(self):
        class Connection:
            committed = False

            def commit(self):
                self.committed = True

        connection = Connection()
        with patch.object(admin_router, "save_sync_uploads", return_value=(self.root, {})), patch.object(
            admin_router, "cleanup_sync_uploads"
        ), patch.object(
            admin_router,
            "sync_project_to_base",
            side_effect=script_sync_service.ScriptSyncError("附件上传失败"),
        ):
            with self.assertRaisesRegex(HTTPException, "附件上传失败"):
                admin_router.post_script_sync_project(1, files=[], conn=connection, actor=self.admin)

        self.assertTrue(connection.committed)


if __name__ == "__main__":
    unittest.main()
