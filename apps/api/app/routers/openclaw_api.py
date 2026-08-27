from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import re
import sqlite3
from typing import Annotated, Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from app.core.config import settings
from app.db.session import get_db
from app.routers.batch_tasks import parse_batch_task_form
from app.services.auth_service import authenticate_user
from app.services.batch_task_service import create_batch_tasks, dispatch_batch_tasks
from app.services.role_service import BATCH_TASK_PERMISSION, accessible_scenario_keys, require_feature_permission
from app.services.workspace_service import (
    ALLOWED_UPLOAD_SUFFIXES,
    DEFAULT_MATURITY_TARGET,
    MATURITY_TARGET_VALUES,
    list_target_regions,
    list_task_scenarios,
    task_stage_order,
)


router = APIRouter(tags=["openclaw-api"])
basic_auth = HTTPBasic(auto_error=False, realm="OpenClaw Batch API")
IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")


def _is_loopback_request(request: Request) -> bool:
    client = request.client
    host = client.host if client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.lower() == "localhost"


def _require_secure_transport(request: Request) -> None:
    if request.url.scheme == "https" or _is_loopback_request(request):
        return
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OpenClaw 批量任务 API 仅支持 HTTPS 连接")


def _authentication_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="账号或密码不正确",
        headers={"WWW-Authenticate": 'Basic realm="OpenClaw Batch API"'},
    )


def openclaw_api_account(
    request: Request,
    credentials: HTTPBasicCredentials | None = Depends(basic_auth),
    conn: sqlite3.Connection = Depends(get_db),
) -> sqlite3.Row:
    _require_secure_transport(request)
    if not credentials:
        raise _authentication_error()
    username = credentials.username
    password = credentials.password
    if not username.strip() or len(username) > 120 or not password or len(password) > 200:
        raise _authentication_error()
    actor = authenticate_user(conn, username, password)
    if not actor:
        raise _authentication_error()
    require_feature_permission(conn, actor, BATCH_TASK_PERMISSION)
    return actor


def _upload_digest(upload: Any) -> tuple[str, int]:
    file_object = getattr(upload, "file", None)
    if file_object is None or not hasattr(file_object, "seek") or not hasattr(file_object, "read"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="源文件格式不正确")
    digest = hashlib.sha256()
    size = 0
    try:
        file_object.seek(0)
        while chunk := file_object.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    finally:
        file_object.seek(0)
    if size > settings.openclaw_api_max_upload_bytes:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="源文件超过允许大小")
    return digest.hexdigest(), size


def _batch_request_fingerprint(batch_name: str, tasks: list[dict]) -> str:
    fingerprint_tasks: list[dict[str, Any]] = []
    for raw in tasks:
        source_hash, source_size = _upload_digest(raw.get("upload"))
        fields = {key: value for key, value in raw.items() if key not in {"upload", "source_file_key"}}
        fingerprint_tasks.append({
            "fields": fields,
            "source": {
                "filename": str(getattr(raw.get("upload"), "filename", "") or ""),
                "sha256": source_hash,
                "size": source_size,
            },
        })
    payload = json.dumps(
        {"batch_name": batch_name.strip(), "tasks": fingerprint_tasks},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _idempotency_key(value: str | None) -> str:
    normalized = (value or "").strip()
    if not IDEMPOTENCY_KEY_PATTERN.fullmatch(normalized):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请提供 8 至 128 位的 Idempotency-Key",
        )
    return normalized


def _batch_task_options(conn: sqlite3.Connection, actor: sqlite3.Row) -> dict:
    allowed_scenarios = accessible_scenario_keys(conn, actor)
    regions = list_target_regions()
    scenarios = [item for item in list_task_scenarios() if item["key"] in allowed_scenarios]
    return {
        "scenarios": scenarios,
        "regions": regions,
        "stop_after_stages": {
            scenario["key"]: {
                region["key"]: task_stage_order(scenario["key"], region["key"])
                for region in regions
            }
            for scenario in scenarios
        },
        "maturity_targets": [
            {"value": value, "is_default": value == DEFAULT_MATURITY_TARGET}
            for value in MATURITY_TARGET_VALUES
        ],
        "constraints": {
            "max_tasks_per_batch": 100,
            "max_source_file_bytes": settings.openclaw_api_max_upload_bytes,
            "source_file_extensions": sorted(ALLOWED_UPLOAD_SUFFIXES),
        },
    }


@router.get("/openclaw/v1/batch-tasks/options")
def get_openclaw_batch_task_options(
    conn: sqlite3.Connection = Depends(get_db),
    actor: sqlite3.Row = Depends(openclaw_api_account),
) -> dict:
    return _batch_task_options(conn, actor)


@router.post("/openclaw/v1/batch-tasks", status_code=status.HTTP_201_CREATED)
async def post_openclaw_batch_tasks(
    request: Request,
    background_tasks: BackgroundTasks,
    idempotency_key: Annotated[Optional[str], Header(alias="Idempotency-Key")] = None,
    conn: sqlite3.Connection = Depends(get_db),
    actor: sqlite3.Row = Depends(openclaw_api_account),
) -> dict:
    form = None
    try:
        form = await request.form()
        tasks = parse_batch_task_form(form)
        batch_name = str(form.get("batch_name") or "")
        request_key = _idempotency_key(idempotency_key)
        fingerprint = _batch_request_fingerprint(batch_name, tasks)

        # RBAC initialization can write compatibility rows. Complete it before
        # locking the idempotency receipt and batch creation in one transaction.
        if conn.in_transaction:
            conn.commit()
        conn.execute("BEGIN IMMEDIATE")
        try:
            receipt = conn.execute(
                """
                SELECT request_fingerprint, response_json
                FROM openclaw_api_requests
                WHERE user_id = ? AND idempotency_key = ?
                """,
                (actor["id"], request_key),
            ).fetchone()
            if receipt:
                if not hmac.compare_digest(str(receipt["request_fingerprint"]), fingerprint):
                    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Idempotency-Key 已用于不同的批量任务")
                try:
                    replay = json.loads(str(receipt["response_json"]))
                except json.JSONDecodeError as exc:
                    raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="批量任务请求记录损坏") from exc
                conn.commit()
                return replay

            result = create_batch_tasks(
                conn,
                actor=actor,
                batch_name=batch_name,
                tasks=tasks,
                allowed_scenarios=accessible_scenario_keys(conn, actor),
                max_upload_bytes=settings.openclaw_api_max_upload_bytes,
                commit=False,
            )
            conn.execute(
                """
                INSERT INTO openclaw_api_requests (
                    user_id, idempotency_key, request_fingerprint, response_json, batch_id
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    actor["id"],
                    request_key,
                    fingerprint,
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                    result["batch"]["id"],
                ),
            )
            conn.commit()
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise

        background_tasks.add_task(dispatch_batch_tasks)
        return result
    finally:
        close = getattr(form, "close", None) if form is not None else None
        if callable(close):
            await close()
