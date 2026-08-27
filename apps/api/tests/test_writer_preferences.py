import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.db import session
from app.services.auth_service import create_user
from app.services.system_agent_evolution_service import list_all_user_preferences
from app.services.writer_preference_service import (
    compile_writer_preference_context,
    create_writer_preference,
    delete_writer_preference,
    ensure_agent_preference_snapshot,
    export_writer_preferences,
    import_writer_preferences,
    list_writer_preferences,
    materialize_agent_preference_snapshot,
    promote_writer_preferences_to_system,
    reorder_writer_preferences,
    remove_system_writer_preferences,
    update_writer_preference,
)


class WriterPreferenceTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name) / "data"
        self.settings_patch = patch.object(
            session,
            "settings",
            SimpleNamespace(data_dir=self.data_dir, database_path=self.data_dir / "app.db"),
        )
        self.settings_patch.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'owner', '主编', 'hash')"
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash) VALUES (2, 'other', '其他用户', 'hash')"
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, claude_session_id
            ) VALUES (1, 1, '测试项目', 'workspaces/test', '北美', 'rewrite', 'foreign_review', 'project-session')
            """
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.settings_patch.stop()
        self.temp_dir.cleanup()

    def _create_job(self, job_id: int, *, user_id: int = 1):
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, prompt, status,
                claude_session_id, logical_thread_id, dry_run
            ) VALUES (?, 1, ?, 'foreign_review', 'foreign_review', '', 'queued', ?, 'thread', 0)
            """,
            (job_id, user_id, f"session-{job_id}"),
        )
        return self.conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (job_id,)).fetchone()

    def test_manual_crud_reorder_and_user_isolation(self):
        first = create_writer_preference(
            self.conn,
            user_id=1,
            content="所有阶段都避免说教式对白",
            scopes=["global"],
        )
        second = create_writer_preference(
            self.conn,
            user_id=1,
            content="审稿必须引用具体集数",
            scopes=["trial_generate", "dialogue_translate", "foreign_review"],
        )
        ai_suggestion = create_writer_preference(
            self.conn,
            user_id=1,
            content="AI 推断建议",
            scopes=["foreign_review"],
            source="ai",
        )
        create_writer_preference(
            self.conn,
            user_id=2,
            content="其他用户规则",
            scopes=["global"],
        )

        owner_list = list_writer_preferences(self.conn, 1)
        self.assertEqual(
            [item["id"] for item in owner_list["preferences"]],
            [first["preference"]["id"], second["preference"]["id"], ai_suggestion["preference"]["id"]],
        )
        self.assertNotIn("其他用户规则", [item["content"] for item in owner_list["preferences"]])
        self.assertEqual(owner_list["profile_revision"], 3)
        self.assertEqual(second["preference"]["scopes"], ["trial_generate", "dialogue_translate", "foreign_review"])
        self.assertFalse(ai_suggestion["preference"]["enabled"])

        updated = update_writer_preference(
            self.conn,
            user_id=1,
            preference_id=second["preference"]["id"],
            enabled=False,
        )
        self.assertFalse(updated["preference"]["enabled"])
        self.assertEqual(updated["preference"]["version"], 2)

        reordered = reorder_writer_preferences(
            self.conn,
            user_id=1,
            ordered_ids=[
                second["preference"]["id"],
                first["preference"]["id"],
                ai_suggestion["preference"]["id"],
            ],
        )
        self.assertEqual(reordered["preferences"][0]["id"], second["preference"]["id"])

        deleted = delete_writer_preference(
            self.conn,
            user_id=1,
            preference_id=first["preference"]["id"],
        )
        self.assertTrue(deleted["ok"])
        self.assertEqual(len(list_writer_preferences(self.conn, 1)["preferences"]), 2)

    def test_compile_merges_stage_before_global_and_ignores_disabled_or_other_stage(self):
        global_item = create_writer_preference(
            self.conn,
            user_id=1,
            content="全局规则",
            scopes=["global"],
        )["preference"]
        stage_item = create_writer_preference(
            self.conn,
            user_id=1,
            content="审稿阶段规则",
            scopes=["foreign_review"],
        )["preference"]
        create_writer_preference(
            self.conn,
            user_id=1,
            content="梗概阶段规则",
            scopes=["outline_rewrite"],
        )
        create_writer_preference(
            self.conn,
            user_id=1,
            content="已停用规则",
            scopes=["foreign_review"],
            enabled=False,
        )

        context = compile_writer_preference_context(self.conn, user_id=1, stage="foreign_review", job_id=7)

        self.assertEqual(
            [item["id"] for item in context["effective_preferences"]],
            [stage_item["id"], global_item["id"]],
        )
        self.assertEqual(context["stage_preferences"][0]["layer"], "stage")
        self.assertEqual(context["global_preferences"][0]["layer"], "global")
        self.assertNotIn("已停用规则", [item["content"] for item in context["effective_preferences"]])

    def test_export_import_preserves_portable_fields_and_supports_append_or_replace(self):
        create_writer_preference(
            self.conn,
            user_id=1,
            content="全局规则",
            scopes=["global"],
        )
        create_writer_preference(
            self.conn,
            user_id=1,
            content="审稿规则",
            scopes=["foreign_review"],
            enabled=False,
            source="ai",
        )

        backup = export_writer_preferences(self.conn, user_id=1)
        self.assertEqual(backup["schema_version"], "1.0")
        self.assertIn("exported_at", backup)
        self.assertEqual(
            backup["preferences"],
            [
                {"content": "全局规则", "scopes": ["global"], "enabled": True},
                {"content": "审稿规则", "scopes": ["foreign_review"], "enabled": False},
            ],
        )

        appended = import_writer_preferences(
            self.conn,
            user_id=2,
            schema_version=backup["schema_version"],
            preferences=backup["preferences"],
            mode="append",
        )
        self.assertEqual(appended["imported_count"], 2)
        imported_profile = list_writer_preferences(self.conn, 2)
        self.assertEqual([item["content"] for item in imported_profile["preferences"]], ["全局规则", "审稿规则"])
        self.assertEqual([item["source"] for item in imported_profile["preferences"]], ["manual", "manual"])
        self.assertEqual([item["enabled"] for item in imported_profile["preferences"]], [True, False])

        duplicate = import_writer_preferences(
            self.conn,
            user_id=2,
            schema_version=backup["schema_version"],
            preferences=backup["preferences"],
            mode="append",
        )
        self.assertEqual(duplicate["imported_count"], 0)
        self.assertEqual(duplicate["skipped_duplicate_count"], 2)

        create_writer_preference(
            self.conn,
            user_id=2,
            content="临时规则",
            scopes=["outline_rewrite"],
        )
        replaced = import_writer_preferences(
            self.conn,
            user_id=2,
            schema_version=backup["schema_version"],
            preferences=[backup["preferences"][1]],
            mode="replace",
        )
        self.assertEqual(replaced["imported_count"], 1)
        self.assertEqual(replaced["removed_count"], 3)
        replaced_profile = list_writer_preferences(self.conn, 2)
        self.assertEqual([item["content"] for item in replaced_profile["preferences"]], ["审稿规则"])

    def test_import_validates_all_preferences_before_replacing_existing_profile(self):
        create_writer_preference(
            self.conn,
            user_id=1,
            content="保留规则",
            scopes=["global"],
        )

        with self.assertRaisesRegex(HTTPException, "不支持的偏好范围"):
            import_writer_preferences(
                self.conn,
                user_id=1,
                schema_version="1.0",
                preferences=[
                    {"content": "可用规则", "scopes": ["foreign_review"], "enabled": True},
                    {"content": "无效规则", "scopes": ["unknown_scope"], "enabled": True},
                ],
                mode="replace",
            )

        profile = list_writer_preferences(self.conn, 1)
        self.assertEqual([item["content"] for item in profile["preferences"]], ["保留规则"])

    def test_system_preferences_reference_existing_users_and_enable_for_new_users(self):
        source = create_writer_preference(
            self.conn,
            user_id=1,
            content="审稿结论必须给出具体正文证据",
            scopes=["foreign_review"],
        )["preference"]
        promoted = promote_writer_preferences_to_system(self.conn, preference_ids=[source["id"]])
        system_preference_id = promoted["created_system_preference_ids"][0]

        self.assertEqual(promoted["affected_user_count"], 2)
        admin_rows = [item for item in list_all_user_preferences(self.conn) if item["id"] == source["id"]]
        self.assertEqual(len(admin_rows), 1)
        self.assertTrue(admin_rows[0]["is_system_preference"])
        self.assertEqual(admin_rows[0]["system_preference_id"], system_preference_id)
        self.assertTrue(admin_rows[0]["can_edit_system_preference"])

        source_profile = list_writer_preferences(self.conn, 1)
        self.assertEqual(len(source_profile["preferences"]), 1)
        source_system_preference = source_profile["preferences"][0]
        self.assertTrue(source_system_preference["is_system_preference"])
        self.assertTrue(source_system_preference["can_edit_system_preference"])
        self.assertNotIn(source["id"], [item["id"] for item in source_profile["preferences"]])
        source_context = compile_writer_preference_context(self.conn, user_id=1, stage="foreign_review", job_id=99)
        self.assertNotIn(source["content"], [item["content"] for item in source_context["effective_preferences"]])
        self.assertEqual(export_writer_preferences(self.conn, user_id=1)["preferences"], [])
        with self.assertRaises(HTTPException) as source_update_error:
            update_writer_preference(
                self.conn,
                user_id=1,
                preference_id=source["id"],
                enabled=False,
            )
        self.assertEqual(source_update_error.exception.status_code, 404)

        updated_content = "审稿结论必须逐条对应正文中的具体证据"
        updated = update_writer_preference(
            self.conn,
            user_id=1,
            preference_id=source_system_preference["id"],
            content=updated_content,
            scopes=["trial_generate", "foreign_review"],
        )
        self.assertTrue(updated["preference"]["is_system_preference"])
        self.assertTrue(updated["preference"]["can_edit_system_preference"])
        self.assertEqual(updated["preference"]["content"], updated_content)
        self.assertEqual(updated["preference"]["scopes"], ["trial_generate", "foreign_review"])
        source_row = self.conn.execute(
            "SELECT content, version FROM writer_preferences WHERE id = ?",
            (source["id"],),
        ).fetchone()
        self.assertEqual(source_row["content"], updated_content)
        self.assertEqual(source_row["version"], updated["preference"]["version"])
        enabled_source = update_writer_preference(
            self.conn,
            user_id=1,
            preference_id=source_system_preference["id"],
            enabled=True,
        )
        self.assertTrue(enabled_source["preference"]["enabled"])
        source_context = compile_writer_preference_context(self.conn, user_id=1, stage="foreign_review", job_id=100)
        self.assertIn(updated_content, [item["content"] for item in source_context["effective_preferences"]])

        old_profile = list_writer_preferences(self.conn, 2)
        old_system_preference = next(item for item in old_profile["preferences"] if item["is_system_preference"])
        self.assertEqual(old_system_preference["id"], -system_preference_id)
        self.assertEqual(old_system_preference["system_preference_id"], system_preference_id)
        self.assertFalse(old_system_preference["enabled"])
        self.assertFalse(old_system_preference["can_edit_system_preference"])
        self.assertEqual(old_system_preference["content"], updated_content)
        self.assertEqual(old_system_preference["scopes"], ["trial_generate", "foreign_review"])

        old_job = self._create_job(12, user_id=2)
        old_snapshot = ensure_agent_preference_snapshot(self.conn, job=old_job)
        self.assertNotIn(updated_content, [item["content"] for item in old_snapshot["effective_preferences"]])
        self.conn.execute("UPDATE agent_jobs SET status = 'succeeded' WHERE id = ?", (old_job["id"],))
        enabled_old = update_writer_preference(
            self.conn,
            user_id=2,
            preference_id=old_system_preference["id"],
            enabled=True,
        )
        self.assertTrue(enabled_old["preference"]["enabled"])
        enabled_old_job = self._create_job(14, user_id=2)
        enabled_old_snapshot = ensure_agent_preference_snapshot(self.conn, job=enabled_old_job)
        self.assertIn(updated_content, [item["content"] for item in enabled_old_snapshot["effective_preferences"]])
        self.conn.execute("UPDATE agent_jobs SET status = 'succeeded' WHERE id = ?", (enabled_old_job["id"],))
        disabled_old = update_writer_preference(
            self.conn,
            user_id=2,
            preference_id=old_system_preference["id"],
            enabled=False,
        )
        self.assertFalse(disabled_old["preference"]["enabled"])
        disabled_old_job = self._create_job(15, user_id=2)
        disabled_old_snapshot = ensure_agent_preference_snapshot(self.conn, job=disabled_old_job)
        self.assertNotIn(updated_content, [item["content"] for item in disabled_old_snapshot["effective_preferences"]])
        self.conn.execute("UPDATE agent_jobs SET status = 'succeeded' WHERE id = ?", (disabled_old_job["id"],))
        with self.assertRaises(HTTPException) as delete_error:
            delete_writer_preference(
                self.conn,
                user_id=2,
                preference_id=old_system_preference["id"],
            )
        self.assertEqual(delete_error.exception.status_code, 404)
        with self.assertRaises(HTTPException) as unauthorized_system_update_error:
            update_writer_preference(
                self.conn,
                user_id=2,
                preference_id=old_system_preference["id"],
                content="其他用户不能修改系统偏好",
            )
        self.assertEqual(unauthorized_system_update_error.exception.status_code, 404)

        new_user = create_user(self.conn, username="new-author", password="password", display_name="新作者")
        new_profile = list_writer_preferences(self.conn, int(new_user["id"]))
        new_system_preference = next(item for item in new_profile["preferences"] if item["is_system_preference"])
        self.assertTrue(new_system_preference["enabled"])
        self.assertFalse(new_system_preference["can_edit_system_preference"])
        self.assertEqual(new_system_preference["content"], updated_content)

        new_job = self._create_job(13, user_id=int(new_user["id"]))
        new_snapshot = ensure_agent_preference_snapshot(self.conn, job=new_job)
        snapshot_preference = next(item for item in new_snapshot["effective_preferences"] if item["content"] == updated_content)
        self.assertTrue(snapshot_preference["is_system_preference"])
        self.assertEqual(snapshot_preference["system_preference_id"], system_preference_id)

        removed = remove_system_writer_preferences(self.conn, system_preference_ids=[system_preference_id])
        self.assertEqual(removed["removed_system_preference_ids"], [system_preference_id])
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) AS count FROM user_system_writer_preference_refs WHERE system_preference_id = ?",
                (system_preference_id,),
            ).fetchone()["count"],
            0,
        )
        self.assertFalse(any(item["is_system_preference"] for item in list_writer_preferences(self.conn, 2)["preferences"]))
        restored_admin_rows = [item for item in list_all_user_preferences(self.conn) if item["id"] == source["id"]]
        self.assertEqual(len(restored_admin_rows), 1)
        self.assertFalse(restored_admin_rows[0]["is_system_preference"])

    def test_system_preferences_are_visible_without_a_materialized_user_reference(self):
        source = create_writer_preference(
            self.conn,
            user_id=1,
            content="试稿对白需要避免重复解释",
            scopes=["trial_generate"],
        )["preference"]
        promoted = promote_writer_preferences_to_system(self.conn, preference_ids=[source["id"]])
        system_preference_id = promoted["created_system_preference_ids"][0]

        self.conn.execute(
            "DELETE FROM user_system_writer_preference_refs WHERE user_id = ? AND system_preference_id = ?",
            (2, system_preference_id),
        )

        profile = list_writer_preferences(self.conn, 2)
        system_preference = next(
            item for item in profile["preferences"] if item["system_preference_id"] == system_preference_id
        )
        self.assertTrue(system_preference["is_system_preference"])
        self.assertFalse(system_preference["enabled"])
        self.assertEqual(system_preference["content"], source["content"])

        context = compile_writer_preference_context(self.conn, user_id=2, stage="trial_generate", job_id=47)
        self.assertNotIn(source["content"], [item["content"] for item in context["effective_preferences"]])

        enabled = update_writer_preference(
            self.conn,
            user_id=2,
            preference_id=system_preference["id"],
            enabled=True,
        )
        self.assertTrue(enabled["preference"]["enabled"])
        self.assertEqual(
            self.conn.execute(
                "SELECT enabled FROM user_system_writer_preference_refs WHERE user_id = ? AND system_preference_id = ?",
                (2, system_preference_id),
            ).fetchone()["enabled"],
            1,
        )
        enabled_context = compile_writer_preference_context(self.conn, user_id=2, stage="trial_generate", job_id=48)
        self.assertIn(source["content"], [item["content"] for item in enabled_context["effective_preferences"]])

    def test_job_snapshot_is_immutable_and_node_tool_validates_python_hash(self):
        preference = create_writer_preference(
            self.conn,
            user_id=1,
            content="审稿必须引用具体集数",
            scopes=["foreign_review"],
        )["preference"]
        first_job = self._create_job(10)
        first_snapshot = ensure_agent_preference_snapshot(self.conn, job=first_job)
        self.assertEqual(first_snapshot["effective_preferences"][0]["content"], "审稿必须引用具体集数")

        update_writer_preference(
            self.conn,
            user_id=1,
            preference_id=preference["id"],
            content="审稿必须引用具体行号",
        )
        repeated_snapshot = ensure_agent_preference_snapshot(self.conn, job=first_job)
        self.assertEqual(repeated_snapshot["profile_revision"], first_snapshot["profile_revision"])
        self.assertEqual(repeated_snapshot["effective_preferences"][0]["content"], "审稿必须引用具体集数")

        self.conn.execute("UPDATE agent_jobs SET status = 'succeeded' WHERE id = 10")
        second_job = self._create_job(11)
        second_snapshot = ensure_agent_preference_snapshot(self.conn, job=second_job)
        self.assertGreater(second_snapshot["profile_revision"], first_snapshot["profile_revision"])
        self.assertEqual(second_snapshot["effective_preferences"][0]["content"], "审稿必须引用具体行号")

        workspace = Path(self.temp_dir.name) / "workspace"
        preference_path, materialized = materialize_agent_preference_snapshot(
            self.conn,
            job=second_job,
            workspace=workspace,
        )
        self.assertTrue(preference_path.is_file())
        self.assertEqual(materialized["snapshot_sha256"], second_snapshot["snapshot_sha256"])
        self.assertEqual(materialized["effective_preferences"][0]["content"], "审稿必须引用具体行号")


if __name__ == "__main__":
    unittest.main()
