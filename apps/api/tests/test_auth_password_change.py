import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.core.security import create_access_token, decode_access_token
from app.db import session
from app.dependencies import current_user
from app.routers.auth import ChangePasswordRequest, change_password
from app.services.auth_service import authenticate_user, create_user, get_user_by_username


class AuthPasswordChangeTest(unittest.TestCase):
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
        self.patches = [patch.object(session, "settings", self.settings)]
        for item in self.patches:
            item.start()
        session.init_db()
        self.conn = session.get_connection()
        create_user(self.conn, username="author", password="old-password", display_name="编剧")
        self.user = get_user_by_username(self.conn, "author")

    def tearDown(self):
        self.conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def test_password_change_updates_password_rotates_session_and_records_audit(self):
        old_token = create_access_token({
            "sub": str(self.user["id"]),
            "username": self.user["username"],
            "role": self.user["role"],
            "ver": self.user["auth_version"],
        })
        result = change_password(
            ChangePasswordRequest(current_password="old-password", new_password="new-password"),
            self.conn,
            self.user,
        )

        self.assertIsNone(authenticate_user(self.conn, "author", "old-password"))
        updated_user = authenticate_user(self.conn, "author", "new-password")
        self.assertIsNotNone(updated_user)
        self.assertEqual(updated_user["auth_version"], 1)
        self.assertEqual(decode_access_token(result["access_token"])["ver"], 1)
        with self.assertRaises(HTTPException) as old_session_error:
            current_user(f"Bearer {old_token}", self.conn)
        self.assertEqual(old_session_error.exception.status_code, 401)
        self.assertEqual(current_user(f"Bearer {result['access_token']}", self.conn)["id"], self.user["id"])
        audit = self.conn.execute("SELECT action, outcome, details_json FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(audit["action"], "auth.password_change")
        self.assertEqual(audit["outcome"], "success")
        self.assertEqual(audit["details_json"], "{}")

    def test_password_change_rejects_incorrect_current_password_without_updating(self):
        with self.assertRaises(HTTPException) as context:
            change_password(
                ChangePasswordRequest(current_password="wrong-password", new_password="new-password"),
                self.conn,
                self.user,
            )

        self.assertEqual(context.exception.status_code, 400)
        self.assertIsNotNone(authenticate_user(self.conn, "author", "old-password"))
        self.assertIsNone(authenticate_user(self.conn, "author", "new-password"))


if __name__ == "__main__":
    unittest.main()
