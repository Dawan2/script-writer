from __future__ import annotations

import base64
import sqlite3
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.security import hash_password
from app.db.session import get_db
from app.routers import openclaw_api


def _basic_auth(username: str, password: str) -> str:
    value = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {value}"


class OpenClawBatchApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(
            """
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                is_active INTEGER NOT NULL DEFAULT 1,
                auth_version INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE openclaw_api_requests (
                user_id INTEGER NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_fingerprint TEXT NOT NULL,
                response_json TEXT NOT NULL,
                batch_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, idempotency_key)
            );
            CREATE TABLE audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_user_id INTEGER,
                actor_username TEXT,
                action TEXT,
                target_type TEXT,
                target_id TEXT,
                target_label TEXT,
                details_json TEXT,
                outcome TEXT,
                source TEXT,
                severity TEXT,
                request_id TEXT,
                parent_event_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        self.conn.execute(
            """
            INSERT INTO users (id, username, display_name, password_hash, role)
            VALUES (1, 'author', '编剧', ?, 'admin')
            """,
            (hash_password("correct-password"),),
        )
        self.conn.execute(
            """
            INSERT INTO users (id, username, display_name, password_hash, role)
            VALUES (2, 'viewer', '只读用户', ?, 'user')
            """,
            (hash_password("viewer-password"),),
        )
        self.app = FastAPI()
        self.app.include_router(openclaw_api.router)
        self.app.dependency_overrides[get_db] = lambda: self.conn

    def tearDown(self) -> None:
        self.app.dependency_overrides.clear()
        self.conn.close()

    def _request(self, *, password: str = "correct-password", key: str = "openclaw-20260806-001") -> dict:
        return {
            "data": {
                "batch_name": "第一批",
                "tasks": '[{"project_name":"样稿","scenario":"rewrite","stop_after_stage":"trial_generate","target_region":"北美","source_file_key":"source_file_0"}]',
            },
            "files": {"source_file_0": ("source.md", b"source", "text/markdown")},
            "headers": {
                "authorization": _basic_auth("author", password),
                "idempotency-key": key,
            },
        }

    def test_authenticated_account_creates_and_replays_its_own_batch(self) -> None:
        created = {"batch": {"id": 99, "name": "第一批"}, "tasks": [{"id": 11}]}
        with patch.object(openclaw_api, "create_batch_tasks", return_value=created) as create, patch.object(
            openclaw_api, "dispatch_batch_tasks"
        ) as dispatch, TestClient(self.app, base_url="https://api.example.test") as client:
            first = client.post("/openclaw/v1/batch-tasks", **self._request())
            second = client.post("/openclaw/v1/batch-tasks", **self._request())

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(first.json(), created)
        self.assertEqual(second.json(), created)
        self.assertEqual(create.call_count, 1)
        self.assertEqual(create.call_args.kwargs["actor"]["id"], 1)
        self.assertIn("rewrite", create.call_args.kwargs["allowed_scenarios"])
        self.assertEqual(dispatch.call_count, 1)
        receipt = self.conn.execute("SELECT user_id FROM openclaw_api_requests").fetchone()
        self.assertEqual(receipt["user_id"], 1)

    def test_invalid_password_is_rejected_before_creating_tasks(self) -> None:
        with patch.object(openclaw_api, "create_batch_tasks") as create, TestClient(
            self.app, base_url="https://api.example.test"
        ) as client:
            response = client.post("/openclaw/v1/batch-tasks", **self._request(password="wrong-password"))

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "账号或密码不正确")
        create.assert_not_called()

    def test_account_without_batch_task_permission_is_rejected(self) -> None:
        request = self._request()
        request["headers"]["authorization"] = _basic_auth("viewer", "viewer-password")
        with patch.object(openclaw_api, "create_batch_tasks") as create, TestClient(
            self.app, base_url="https://api.example.test"
        ) as client:
            response = client.post("/openclaw/v1/batch-tasks", **request)

        self.assertEqual(response.status_code, 403)
        create.assert_not_called()

    def test_remote_http_transport_is_rejected(self) -> None:
        with patch.object(openclaw_api, "create_batch_tasks") as create, TestClient(self.app) as client:
            response = client.post("/openclaw/v1/batch-tasks", **self._request())

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "OpenClaw 批量任务 API 仅支持 HTTPS 连接")
        create.assert_not_called()

    def test_options_require_the_same_account_authentication(self) -> None:
        with TestClient(self.app, base_url="https://api.example.test") as client:
            response = client.get(
                "/openclaw/v1/batch-tasks/options",
                headers={"authorization": _basic_auth("author", "correct-password")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["scenarios"])
        self.assertIn("constraints", response.json())


if __name__ == "__main__":
    unittest.main()
