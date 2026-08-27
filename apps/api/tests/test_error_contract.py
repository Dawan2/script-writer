"""`C1-W1-02` 第 6 节 A 组与 C-4 的自动化验收。

用例编号与实现规格第 6 节一一对应，方法名里的 A-x / C-x 即验收编号。
"""

from __future__ import annotations

import base64
import json
import logging
import re
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from app.core import errors as errors_module
from app.core.errors import (
    APIError,
    allowed_latin_words,
    http_codes,
    register_error_handlers,
    tool_failure_error,
)
from app.core.security import create_access_token, hash_password
from app.db import session
from app.main import bind_audit_request_context
from app.routers import auth as auth_router
from app.routers import batch_tasks as batch_tasks_router
from app.routers import openclaw_api as openclaw_router
from app.routers import projects as projects_router
from app.services import role_service, workspace_service

LATIN_RUN = re.compile(r"[A-Za-z]{2,}")
ENVELOPE_FIELDS = ("code", "category", "retryable", "message", "hint", "traceId")
LEAKED_PASSWORD = "super-secret-value"
INTERNAL_PATH = "/srv/orca/workspaces/secret-project"
REPO_AGENTS_DIR = Path(__file__).resolve().parents[3] / "Agents"


class ContractProbe(BaseModel):
    title: str = Field(min_length=2)


probe_router = APIRouter(prefix="/contract-probe")


@probe_router.get("/conflict")
def probe_conflict() -> dict:
    raise APIError("JOB_ALREADY_FINISHED")


@probe_router.get("/permission")
def probe_permission() -> dict:
    raise APIError("PERMISSION_DENIED")


@probe_router.get("/tool-failure")
def probe_tool_failure() -> dict:
    raise tool_failure_error(
        "DOCUMENT_CONVERT_FAILED",
        root_cause=f"Traceback: converter crashed at {INTERNAL_PATH}/converted.md",
    )


@probe_router.get("/stage-check")
def probe_stage_check() -> dict:
    raise APIError(
        "STAGE_CHECK_FAILED",
        details={"issues": ["第 3 集台词与人物小传冲突", "第 7 集缺少场景标题"]},
        root_cause=json.dumps({"ok": False, "issues": ["第 3 集台词与人物小传冲突"]}, ensure_ascii=False),
    )


@probe_router.get("/boom")
def probe_boom() -> dict:
    raise RuntimeError(f"内部原因：无法读取 {INTERNAL_PATH}")


@probe_router.delete("/only-delete")
def probe_only_delete() -> dict:
    return {"ok": True}


@probe_router.get("/ok")
def probe_ok() -> dict:
    return {"ok": True}


@probe_router.post("/probe")
def probe_validation(payload: ContractProbe) -> dict:
    return {"title": payload.title}


def keys_named_input(value: object) -> int:
    """信封里任何一层都不应出现 `input` 键——那是用户提交的原始值。"""
    if isinstance(value, dict):
        return sum(
            (1 if key == "input" else 0) + keys_named_input(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return sum(keys_named_input(item) for item in value)
    return 0


def latin_runs(text: str) -> list[str]:
    allowed = {word.lower() for word in allowed_latin_words()}
    return [run.group(0) for run in LATIN_RUN.finditer(text) if run.group(0).lower() not in allowed]


class ErrorContractTest(unittest.TestCase):
    maxDiff = None

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=root / "data",
            database_path=root / "data" / "app.db",
            repo_root=root,
            agents_dir=root / "Agents",
            workspaces_dir=root / "Agents" / "workspaces",
            upload_dir=root / "data" / "uploads",
            access_token_expire_minutes=60,
            secret_key="contract-test-secret",
        )
        self.settings.workspaces_dir.mkdir(parents=True)
        region_rules = self.settings.agents_dir / ".claude/config/region-rules.json"
        region_rules.parent.mkdir(parents=True, exist_ok=True)
        region_rules.write_text(
            (REPO_AGENTS_DIR / ".claude/config/region-rules.json").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        self.patches = [
            patch.object(session, "settings", self.settings),
            patch.object(workspace_service, "settings", self.settings),
        ]
        for item in self.patches:
            item.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            """
            INSERT INTO users (id, username, display_name, password_hash, role, auth_version)
            VALUES (1, 'author', '编剧', ?, 'admin', 0)
            """,
            (hash_password("correct-password"),),
        )
        self.conn.execute(
            """
            INSERT INTO users (id, username, display_name, password_hash, role, is_active)
            VALUES (2, 'retired', '停用编剧', 'hash', 'user', 0)
            """
        )
        self.conn.commit()
        role_service.ensure_role_defaults(self.conn)
        self.conn.commit()
        self.user = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()

        self.app = FastAPI()
        self.app.middleware("http")(bind_audit_request_context)
        self.app.include_router(auth_router.router)
        self.app.include_router(projects_router.router)
        self.app.include_router(batch_tasks_router.router)
        self.app.include_router(openclaw_router.router)
        self.app.include_router(probe_router)
        register_error_handlers(self.app)
        self.app.dependency_overrides[session.get_db] = lambda: self.conn
        self.client = TestClient(self.app, base_url="https://api.example.test", raise_server_exceptions=False)
        self.auth_headers = {"authorization": f"Bearer {self.access_token()}"}

    def tearDown(self) -> None:
        self.app.dependency_overrides.clear()
        self.conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def access_token(self, *, version: int = 0, user_id: int = 1, expired: bool = False) -> str:
        if not expired:
            return create_access_token({"sub": str(user_id), "ver": version})
        # 签名合法但 exp 已过：最常见的自然过期，必须被判为"已过期"而非"无法识别"。
        with patch("app.core.security.time.time", return_value=time.time() - 10_000_000):
            return create_access_token({"sub": str(user_id), "ver": version})

    def envelope(self, response) -> dict:
        payload = response.json()
        self.assertIn("error", payload, msg=f"响应体缺少错误信封：{payload}")
        return payload["error"]

    def assert_envelope_shape(self, response) -> dict:
        error = self.envelope(response)
        for field in ENVELOPE_FIELDS:
            self.assertIn(field, error, msg=f"信封缺少字段 {field}：{error}")
        self.assertIsInstance(error["code"], str)
        self.assertTrue(error["code"])
        self.assertIn(error["category"], set(errors_module.allowed_categories()))
        self.assertIsInstance(error["retryable"], bool)
        self.assertTrue(error["message"].strip())
        self.assertTrue(error["hint"].strip())
        self.assertTrue(error["traceId"].strip())
        self.assertNotIn("root_cause", error)
        self.assertIsInstance(response.json()["detail"], str)
        self.assertEqual(response.json()["detail"], error["message"])
        return error

    # A-1 校验失败的响应体不含用户提交的原始值
    def test_a1_validation_failure_never_echoes_submitted_values(self) -> None:
        response = self.client.post("/auth/login", json={"password": LEAKED_PASSWORD})

        self.assertEqual(response.status_code, 422)
        self.assertNotIn(LEAKED_PASSWORD, response.text)
        self.assertEqual(keys_named_input(response.json()), 0)

    # A-2 任意接口的失败响应形状一致
    def test_a2_every_failure_status_shares_the_same_envelope(self) -> None:
        cases = {
            401: lambda: self.client.get("/projects"),
            403: lambda: self.client.get("/contract-probe/permission"),
            404: lambda: self.client.get("/completely/unknown"),
            405: lambda: self.client.get("/contract-probe/only-delete"),
            409: lambda: self.client.get("/contract-probe/conflict"),
            422: lambda: self.client.post("/contract-probe/probe", json={"title": "x"}),
            500: lambda: self.client.get("/contract-probe/boom"),
        }
        for expected_status, call in cases.items():
            with self.subTest(status=expected_status):
                response = call()
                self.assertEqual(response.status_code, expected_status)
                self.assert_envelope_shape(response)

    # A-3 校验失败的文案不含英文与后端原始字段名
    def test_a3_validation_messages_use_chinese_field_labels(self) -> None:
        cases = [
            ("登录", lambda: self.client.post("/auth/login", json={"password": LEAKED_PASSWORD}), "username"),
            (
                "修改密码",
                lambda: self.client.post(
                    "/auth/change-password",
                    json={"current_password": "old-password"},
                    headers=self.auth_headers,
                ),
                "new_password",
            ),
            (
                "新建项目",
                lambda: self.client.post("/projects", data={"target_region": "北美"}, headers=self.auth_headers),
                "project_name",
            ),
            (
                "保存阶段文档",
                lambda: self.client.put(
                    "/projects/1/files/trial_generate",
                    json={"expected_hash": "abc"},
                    headers=self.auth_headers,
                ),
                "content",
            ),
            (
                "批量任务",
                lambda: self.client.post("/batch-tasks/bulk", json={"action": "start"}, headers=self.auth_headers),
                "task_ids",
            ),
        ]
        for label, call, backend_field in cases:
            with self.subTest(entry=label):
                response = call()
                self.assertEqual(response.status_code, 422)
                error = self.assert_envelope_shape(response)
                self.assertEqual(latin_runs(error["message"]), [])
                self.assertEqual(latin_runs(error["hint"]), [])
                self.assertNotIn(backend_field, error["message"])

    # A-4 字段标签查不到时不回落成字段路径
    def test_a4_unlabelled_field_omits_the_label_instead_of_leaking_the_path(self) -> None:
        response = self.client.post("/contract-probe/probe", json={"title": "x"})

        self.assertEqual(response.status_code, 422)
        error = self.envelope(response)
        fields = error["details"]["fields"]
        self.assertEqual([field["path"] for field in fields], ["body.title"])
        self.assertNotIn("label", fields[0])
        self.assertNotIn("body.title", error["message"])
        self.assertNotIn("title", error["message"])

    # A-5 路由不存在、方法不允许、未捕获异常三条路径的文案是中文
    def test_a5_framework_and_unhandled_failures_speak_chinese(self) -> None:
        cases = [
            (404, self.client.get("/completely/unknown")),
            (405, self.client.get("/contract-probe/only-delete")),
            (500, self.client.get("/contract-probe/boom")),
        ]
        for expected_status, response in cases:
            with self.subTest(status=expected_status):
                self.assertEqual(response.status_code, expected_status)
                error = self.envelope(response)
                self.assertEqual(latin_runs(error["message"]), [])
                self.assertEqual(latin_runs(error["hint"]), [])

    # A-7 子进程输出不再进入用户可见文案
    def test_a7_subprocess_output_only_reaches_the_log(self) -> None:
        with self.assertLogs("app.core.errors", level=logging.ERROR) as captured:
            response = self.client.get("/contract-probe/tool-failure")

        self.assertEqual(response.status_code, 400)
        error = self.envelope(response)
        self.assertEqual(error["message"], http_codes()["DOCUMENT_CONVERT_FAILED"]["message"])
        self.assertNotIn(INTERNAL_PATH, response.text)
        self.assertNotIn("Traceback", response.text)
        logged = "\n".join(captured.output)
        self.assertIn(INTERNAL_PATH, logged)
        self.assertIn(error["traceId"], logged)

    # A-8 traceId 在四条出口都存在且与响应头同值
    def test_a8_trace_id_matches_the_response_header_on_every_exit(self) -> None:
        normal = self.client.get("/contract-probe/ok")
        self.assertEqual(normal.status_code, 200)
        self.assertTrue(normal.headers.get("x-request-id"))

        exits = {
            "APIError": self.client.get("/contract-probe/conflict"),
            "校验失败": self.client.post("/contract-probe/probe", json={"title": "x"}),
            "未捕获异常": self.client.get("/contract-probe/boom"),
        }
        for label, response in exits.items():
            with self.subTest(exit=label):
                error = self.envelope(response)
                self.assertEqual(error["traceId"], response.headers.get("x-request-id"))
                self.assertTrue(error["traceId"])

    def test_a8_supplied_request_id_is_reused_on_every_exit(self) -> None:
        supplied = "contract-trace-0001"
        for path in ("/contract-probe/ok", "/contract-probe/conflict", "/contract-probe/boom"):
            with self.subTest(path=path):
                response = self.client.get(path, headers={"x-request-id": supplied})
                self.assertEqual(response.headers.get("x-request-id"), supplied)
                if response.status_code != 200:
                    self.assertEqual(self.envelope(response)["traceId"], supplied)

    # A-9 内部原因不出网、但可用 traceId 关联
    def test_a9_internal_cause_stays_in_the_log_and_shares_the_trace_id(self) -> None:
        with self.assertLogs("app.core.errors", level=logging.ERROR) as captured:
            response = self.client.get("/contract-probe/boom", headers={"x-request-id": "contract-trace-0002"})

        self.assertEqual(response.status_code, 500)
        self.assertNotIn(INTERNAL_PATH, response.text)
        self.assertNotIn("root_cause", response.text)
        error = self.envelope(response)
        self.assertEqual(error["traceId"], "contract-trace-0002")
        logged = "\n".join(captured.output)
        self.assertIn(INTERNAL_PATH, logged)
        self.assertIn("contract-trace-0002", logged)

    # A-10 阶段检查未通过的未通过项经 details.issues 结构化传递
    def test_a10_stage_check_issues_are_structured(self) -> None:
        response = self.client.get("/contract-probe/stage-check")

        self.assertEqual(response.status_code, 409)
        error = self.envelope(response)
        issues = error["details"]["issues"]
        self.assertEqual(issues, ["第 3 集台词与人物小传冲突", "第 7 集缺少场景标题"])
        self.assertTrue(all(isinstance(issue, str) for issue in issues))
        self.assertNotIn("{", error["message"])
        self.assertNotIn("ok", error["message"])

    def test_a10_stage_check_failure_parses_the_check_script_output(self) -> None:
        from app.services.memory_sync_service import _stage_check_failure

        stderr = json.dumps(
            {"ok": False, "stage": "full_generate", "issues": ["第 7 集缺少场景标题"], "next_action": "修复后重试"},
            ensure_ascii=False,
            indent=2,
        )
        failure = _stage_check_failure(stderr, "")

        self.assertEqual(failure.code, "STAGE_CHECK_FAILED")
        self.assertEqual(failure.details, {"issues": ["第 7 集缺少场景标题"]})
        self.assertNotIn("{", failure.message)
        self.assertIn("full_generate", failure.root_cause)

    # A-11 会话的五种失效原因各有独立错误码
    def test_a11_each_session_failure_has_its_own_code(self) -> None:
        expired_token = self.access_token(expired=True)
        cases = {
            "AUTH_REQUIRED": {},
            "SESSION_EXPIRED": {"authorization": f"Bearer {expired_token}"},
            "SESSION_INVALID": {"authorization": "Bearer not.a-real-token"},
            "ACCOUNT_DISABLED": {"authorization": f"Bearer {self.access_token(user_id=2)}"},
            "SESSION_SUPERSEDED": {"authorization": f"Bearer {self.access_token(version=9)}"},
        }
        for expected_code, headers in cases.items():
            with self.subTest(code=expected_code):
                response = self.client.get("/projects", headers=headers)
                self.assertEqual(response.status_code, 401)
                error = self.assert_envelope_shape(response)
                self.assertEqual(error["code"], expected_code)

    def test_a11_expired_signature_is_not_reported_as_unreadable(self) -> None:
        response = self.client.get(
            "/projects",
            headers={"authorization": f"Bearer {self.access_token(expired=True)}"},
        )

        error = self.envelope(response)
        self.assertEqual(error["code"], "SESSION_EXPIRED")
        self.assertNotEqual(error["code"], "SESSION_INVALID")

    # C-4 /openclaw/v1/* 的失败响应仍带字符串 detail，状态码不变
    def openclaw_request(self, *, key: str, password: str = "correct-password", tasks: str | None = None, size: int = 6) -> dict:
        default_tasks = (
            '[{"project_name":"样稿","scenario":"rewrite","stop_after_stage":"trial_generate",'
            '"target_region":"北美","source_file_key":"source_file_0"}]'
        )
        return {
            "data": {"batch_name": "第一批", "tasks": default_tasks if tasks is None else tasks},
            "files": {"source_file_0": ("source.md", b"s" * size, "text/markdown")},
            "headers": {"authorization": _basic_auth("author", password), "idempotency-key": key},
        }

    def test_c4_openclaw_failures_keep_a_string_detail(self) -> None:
        cases = {
            401: lambda: self.client.post(
                "/openclaw/v1/batch-tasks", **self.openclaw_request(key="openclaw-401x", password="wrong-password")
            ),
            422: lambda: self.client.post(
                "/openclaw/v1/batch-tasks", **self.openclaw_request(key="openclaw-422x", tasks="not-json")
            ),
        }
        for expected_status, call in cases.items():
            with self.subTest(status=expected_status):
                response = call()
                self.assertEqual(response.status_code, expected_status)
                self.assert_openclaw_envelope(response)

        with patch.object(openclaw_router.settings, "openclaw_api_max_upload_bytes", 4):
            oversized = self.client.post(
                "/openclaw/v1/batch-tasks", **self.openclaw_request(key="openclaw-413x", size=64)
            )
        self.assertEqual(oversized.status_code, 413)
        self.assert_openclaw_envelope(oversized)

    def assert_openclaw_envelope(self, response) -> dict:
        payload = response.json()
        self.assertIsInstance(payload["detail"], str)
        self.assertTrue(payload["detail"].strip())
        self.assertEqual(payload["error"]["message"], payload["detail"])
        return payload["error"]

    def test_c4_openclaw_conflict_keeps_its_status_and_string_detail(self) -> None:
        self.conn.execute(
            "INSERT INTO batch_task_batches (id, created_by, name) VALUES (99, 1, '第一批')"
        )
        self.conn.commit()
        created = {"batch": {"id": 99, "name": "第一批"}, "tasks": [{"id": 11}]}
        with patch.object(openclaw_router, "create_batch_tasks", return_value=created), patch.object(
            openclaw_router, "dispatch_batch_tasks"
        ):
            first = self.client.post("/openclaw/v1/batch-tasks", **self.openclaw_request(key="openclaw-409x"))
            second = self.client.post(
                "/openclaw/v1/batch-tasks", **self.openclaw_request(key="openclaw-409x", size=12)
            )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 409)
        error = self.assert_openclaw_envelope(second)
        self.assertEqual(error["category"], "conflict")


def _basic_auth(username: str, password: str) -> str:
    value = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {value}"


if __name__ == "__main__":
    unittest.main()
