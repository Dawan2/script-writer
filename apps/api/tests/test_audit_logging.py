import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.db import session
from app.routers import auth, projects
from app.services import admin_service
from app.services.audit_service import content_fingerprint, record_audit, record_system_audit, reset_audit_context, set_audit_context


class AuditLoggingTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=root / "data",
            database_path=root / "data" / "app.db",
        )
        self.settings_patch = patch.object(session, "settings", self.settings)
        self.settings_patch.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'admin', '管理员', 'hash', 'admin')"
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (2, 'writer', '编剧', 'hash', 'user')"
        )
        self.conn.execute(
            """
            INSERT INTO projects (id, owner_user_id, name, workspace_dir, claude_session_id)
            VALUES (7, 2, '审计项目', 'workspaces/audit-project', 'project-session')
            """
        )
        self.admin = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        self.writer = self.conn.execute("SELECT * FROM users WHERE id = 2").fetchone()
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.settings_patch.stop()
        self.temp_dir.cleanup()

    def test_schema_context_and_filters_are_available(self):
        columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(audit_logs)").fetchall()}
        self.assertTrue({"project_id", "outcome", "source", "severity", "request_id", "parent_event_id"}.issubset(columns))

        context = set_audit_context(request_id="web-request-1", source="web")
        try:
            record_audit(
                self.conn,
                actor=self.writer,
                action="project.rename",
                target_type="project",
                target_id=7,
                target_label="审计项目（新）",
                project_id=7,
                details={"before": {"name": "审计项目"}, "after": {"name": "审计项目（新）"}},
            )
        finally:
            reset_audit_context(context)
        record_system_audit(
            self.conn,
            action="agent_job.failed",
            target_type="agent_job",
            target_id=42,
            target_label="#42",
            project_id=7,
            outcome="failure",
            severity="warning",
            details={"error": content_fingerprint("不应保存的错误原文")},
        )
        self.conn.commit()

        web_logs = admin_service.list_audit_logs(self.conn, project_id=7, source="web")
        self.assertEqual([item["action"] for item in web_logs["logs"]], ["project.rename"])
        self.assertEqual(web_logs["logs"][0]["request_id"], "web-request-1")
        failed_logs = admin_service.list_audit_logs(self.conn, project_id=7, outcome="failure")
        self.assertEqual([item["action"] for item in failed_logs["logs"]], ["agent_job.failed"])
        persisted = self.conn.execute("SELECT details_json FROM audit_logs WHERE action = 'agent_job.failed'").fetchone()[0]
        self.assertNotIn("不应保存的错误原文", persisted)
        self.assertEqual(json.loads(persisted)["error"]["length"], len("不应保存的错误原文".encode("utf-8")))

    def test_failed_login_and_project_pinning_do_not_create_audit_entries(self):
        before = self.conn.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0]
        with patch.object(auth, "authenticate_user", return_value=None):
            with self.assertRaises(HTTPException) as failure:
                auth.login(auth.LoginRequest(username="writer", password="not-the-password"), conn=self.conn)
        self.assertEqual(failure.exception.status_code, 401)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0], before)

        with patch.object(auth, "authenticate_user", return_value=self.writer), patch.object(auth, "create_access_token", return_value="token"):
            auth.login(auth.LoginRequest(username="writer", password="correct-password"), conn=self.conn)
        self.assertEqual(
            self.conn.execute("SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()[0],
            "auth.login",
        )
        after_login = self.conn.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0]

        projects.update_project(
            7,
            projects.ProjectUpdate(pinned=True),
            conn=self.conn,
            user=self.writer,
        )
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0], after_login)

        projects.update_project(
            7,
            projects.ProjectUpdate(name="审计项目（新）"),
            conn=self.conn,
            user=self.writer,
        )
        self.assertEqual(
            self.conn.execute("SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()[0],
            "project.rename",
        )


if __name__ == "__main__":
    unittest.main()
