import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.db import session
from app.services import workspace_service


class ProjectPermissionsTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=root / "data",
            database_path=root / "data" / "app.db",
            repo_root=root,
            agents_dir=root / "Agents",
            workspaces_dir=root / "Agents" / "workspaces",
            upload_dir=root / "data" / "uploads",
        )
        self.settings.workspaces_dir.mkdir(parents=True)
        self.patches = [
            patch.object(session, "settings", self.settings),
            patch.object(workspace_service, "settings", self.settings),
        ]
        for item in self.patches:
            item.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.executemany(
            """
            INSERT INTO users (id, username, display_name, password_hash, role)
            VALUES (?, ?, ?, 'hash', ?)
            """,
            [
                (1, "owner", "所有者", "user"),
                (2, "viewer", "查看者", "user"),
                (3, "editor", "编辑者", "user"),
                (4, "outsider", "未授权用户", "user"),
                (5, "admin", "管理员", "admin"),
                (6, "disabled", "停用用户", "user"),
            ],
        )
        self.conn.execute("UPDATE users SET is_active = 0 WHERE id = 6")
        self.conn.execute(
            """
            INSERT INTO projects (id, owner_user_id, name, workspace_dir, claude_session_id)
            VALUES (1, 1, '共享项目', 'workspaces/shared-project', 'project-session')
            """
        )
        self.project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        self.owner = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        self.viewer = self.conn.execute("SELECT * FROM users WHERE id = 2").fetchone()
        self.editor = self.conn.execute("SELECT * FROM users WHERE id = 3").fetchone()
        self.outsider = self.conn.execute("SELECT * FROM users WHERE id = 4").fetchone()
        self.admin = self.conn.execute("SELECT * FROM users WHERE id = 5").fetchone()
        self.disabled = self.conn.execute("SELECT * FROM users WHERE id = 6").fetchone()

    def tearDown(self):
        self.conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def test_membership_controls_project_visibility_and_edits(self):
        workspace_service.set_project_member_permission(
            self.conn,
            self.project,
            self.viewer["id"],
            "view",
            self.owner,
        )
        workspace_service.set_project_member_permission(
            self.conn,
            self.project,
            self.editor["id"],
            "edit",
            self.owner,
        )

        viewer_projects = workspace_service.list_projects(self.conn, self.viewer)
        editor_projects = workspace_service.list_projects(self.conn, self.editor)
        outsider_projects = workspace_service.list_projects(self.conn, self.outsider)

        self.assertEqual([(item["id"], item["access_level"]) for item in viewer_projects], [(1, "view")])
        self.assertEqual([(item["id"], item["access_level"]) for item in editor_projects], [(1, "edit")])
        self.assertEqual(outsider_projects, [])

        self.assertEqual(workspace_service.get_project_or_404(self.conn, 1, self.viewer)["id"], 1)
        self.assertEqual(
            workspace_service.get_project_or_404(self.conn, 1, self.editor, required_permission="edit")["id"],
            1,
        )
        with self.assertRaises(HTTPException) as view_edit_error:
            workspace_service.get_project_or_404(self.conn, 1, self.viewer, required_permission="edit")
        self.assertEqual(view_edit_error.exception.status_code, 403)
        with self.assertRaises(HTTPException) as edit_manage_error:
            workspace_service.get_project_or_404(self.conn, 1, self.editor, required_permission="manage")
        self.assertEqual(edit_manage_error.exception.status_code, 403)

    def test_members_can_be_listed_changed_and_removed(self):
        workspace_service.set_project_member_permission(
            self.conn,
            self.project,
            self.viewer["id"],
            "view",
            self.owner,
        )
        members = workspace_service.list_project_members(self.conn, self.project)
        self.assertEqual(
            [(item["display_name"], item["access_level"]) for item in members["members"]],
            [("所有者", "owner"), ("查看者", "view")],
        )
        self.assertNotIn("available_users", members)

        updated = workspace_service.set_project_member_permission(
            self.conn,
            self.project,
            self.viewer["id"],
            "edit",
            self.owner,
        )
        self.assertTrue(updated["changed"])
        self.assertEqual(updated["previous_permission"], "view")
        self.assertEqual(updated["member"]["access_level"], "edit")

        removed = workspace_service.remove_project_member_permission(self.conn, self.project, self.viewer["id"])
        self.assertEqual(removed["display_name"], "查看者")
        self.assertEqual(workspace_service.list_projects(self.conn, self.viewer), [])

    def test_member_can_be_added_by_exact_username(self):
        result = workspace_service.set_project_member_permission_by_username(
            self.conn,
            self.project,
            "editor",
            "edit",
            self.owner,
        )

        self.assertTrue(result["changed"])
        self.assertEqual(result["member"]["id"], self.editor["id"])
        self.assertEqual(result["member"]["access_level"], "edit")

    def test_username_add_updates_an_existing_member(self):
        workspace_service.set_project_member_permission_by_username(
            self.conn,
            self.project,
            "viewer",
            "view",
            self.owner,
        )

        result = workspace_service.set_project_member_permission_by_username(
            self.conn,
            self.project,
            "viewer",
            "edit",
            self.owner,
        )

        self.assertEqual(result["previous_permission"], "view")
        self.assertEqual(result["member"]["access_level"], "edit")

    def test_username_add_does_not_reveal_unavailable_accounts(self):
        for username in ("missing", "disabled", "admin", "owner"):
            with self.subTest(username=username), self.assertRaises(HTTPException) as error:
                workspace_service.set_project_member_permission_by_username(
                    self.conn,
                    self.project,
                    username,
                    "view",
                    self.owner,
                )
            self.assertEqual(error.exception.status_code, 404)
            self.assertEqual(error.exception.detail, "未找到可添加的用户，请确认账号填写正确")

    def test_id_update_cannot_add_or_enumerate_unlisted_users(self):
        with self.assertRaises(HTTPException) as error:
            workspace_service.update_project_member_permission(
                self.conn,
                self.project,
                self.editor["id"],
                "edit",
                self.owner,
            )

        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(error.exception.detail, "该成员已不在项目中，请刷新后重试")


if __name__ == "__main__":
    unittest.main()
