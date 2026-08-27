from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from fastapi import HTTPException, status

from app.core.config import settings
from app.db.session import get_connection
from app.services.agent_runner import (
    TERMINAL_STATUSES,
    cancel_job,
    create_job,
    job_has_context_limit_failure,
    resume_failed_continuation_job,
    run_agent_job,
)
from app.services.audit_service import content_fingerprint, record_audit, record_system_audit
from app.services.credit_service import re_reserve_job_credits
from app.services.memory_sync_service import document_sync_pending
from app.services.workspace_service import (
    DEFAULT_MATURITY_TARGET,
    MATURITY_TARGET_VALUES,
    approve_new_stage,
    create_project_from_source_path,
    list_task_scenarios,
    load_progress,
    normalize_task_type,
    project_stage_label,
    resolve_workspace,
    save_upload,
    stage_file_for_workspace,
    task_stage_order,
)


BATCH_EXECUTION_OWNER = f"batch-{uuid.uuid4()}"
BATCH_RUNNING_TASK_IDS: set[int] = set()
BATCH_RUNNING_TASKS_LOCK = threading.Lock()
BATCH_TERMINAL_STATUSES = frozenset({"succeeded", "failed"})
HUMAN_APPROVAL_STAGES = frozenset({"trial_generate", "foreign_review"})
DEFAULT_STOP_AFTER_STAGES = {
    "rewrite": "trial_generate",
    "novel": "trial_generate",
    "replicate": "trial_generate",
    "review": "foreign_review",
    "translate": "dialogue_translate",
    "humanize": "humanizer_zh",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _public_timestamp(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if value.endswith("Z") or "+" in value[10:]:
        return value
    return f"{value.replace(' ', 'T')}Z"


def _row_value(row: sqlite3.Row | dict, key: str, default: Any = None) -> Any:
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


def max_parallel_tasks() -> int:
    # 批量任务是后台挂机能力，任何环境变量都不能突破产品约束的两个并行槽位。
    return min(2, max(1, int(settings.batch_task_max_parallel)))


def _scenario_map() -> dict[str, dict]:
    return {scenario["key"]: scenario for scenario in list_task_scenarios()}


def _task_input(row: sqlite3.Row | dict) -> dict:
    try:
        payload = json.loads(str(_row_value(row, "input_json", "{}") or "{}"))
    except json.JSONDecodeError:
        payload = {}
    return payload if isinstance(payload, dict) else {}


def _error_message(error: BaseException | object) -> str:
    if isinstance(error, HTTPException):
        detail = error.detail
        return detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)
    value = str(error).strip()
    return value or "任务处理失败"


def _source_path(value: str) -> Path:
    candidate = Path(value).expanduser().resolve()
    upload_root = settings.upload_dir.resolve()
    if candidate == upload_root or not candidate.is_relative_to(upload_root):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="源文件路径无效")
    if not candidate.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="源文件已不存在，无法重新执行")
    return candidate


def _default_stop_after_stage(scenario: str, target_region: str) -> str:
    stages = task_stage_order(scenario, target_region)
    preferred = DEFAULT_STOP_AFTER_STAGES.get(scenario)
    if preferred in stages:
        return preferred
    return stages[-1] if stages else ""


def _stop_after_stage(raw: dict[str, Any], scenario: str, target_region: str) -> str:
    stages = task_stage_order(scenario, target_region)
    requested = str(raw.get("stop_after_stage") or "").strip()
    if not requested:
        return _default_stop_after_stage(scenario, target_region)
    if requested not in stages:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请选择该场景可运行的暂停步骤")
    return requested


def _normalize_input(raw: dict[str, Any], *, source_path: Path, source_name: str) -> dict:
    scenario = normalize_task_type(str(raw.get("scenario") or raw.get("task_type") or ""))
    project_name = str(raw.get("project_name") or raw.get("name") or "").strip()
    if not project_name:
        project_name = Path(source_name).stem.strip()
    if not project_name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="任务名称不能为空")
    target_region = str(raw.get("target_region") or "").strip()
    if not target_region:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请选择目标地区")

    def text(key: str) -> str:
        return str(raw.get(key) or "").strip()

    count_raw = raw.get("target_episode_count")
    try:
        episode_count = int(count_raw) if count_raw not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="目标集数应为正整数") from None
    if episode_count is not None and episode_count < 1:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="目标集数应为正整数")
    stop_after_stage = _stop_after_stage(raw, scenario, target_region)
    maturity_target = text("maturity_target") or DEFAULT_MATURITY_TARGET
    if maturity_target not in MATURITY_TARGET_VALUES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请选择有效的目标分级")

    input_data = {
        "project_name": project_name[:200],
        "scenario": scenario,
        "stop_after_stage": stop_after_stage,
        "target_region": target_region[:40],
        "source_path": str(source_path),
        "source_name": source_name[:300],
    }
    optional_values = {
        "episode_duration": text("episode_duration")[:100],
        "target_episode_count": episode_count,
        "maturity_target": maturity_target,
        "extra_requirements": text("extra_requirements")[:20000],
    }
    return {
        **input_data,
        **{field: value for field, value in optional_values.items() if value not in (None, "")},
    }


def _distribution_brief(input_data: dict) -> dict:
    return {
        field: input_data[field]
        for field in (
            "episode_duration",
            "target_episode_count",
            "maturity_target",
        )
        if input_data.get(field) not in (None, "")
    }


def _insert_task(
    conn: sqlite3.Connection,
    *,
    batch_id: int,
    actor: sqlite3.Row,
    input_data: dict,
) -> sqlite3.Row:
    stages = task_stage_order(input_data["scenario"], input_data["target_region"])
    conn.execute(
        """
        INSERT INTO batch_tasks (
            batch_id, created_by, scenario, current_stage, stop_after_stage, source_path, input_json,
            status, max_retries, next_attempt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        """,
        (
            batch_id,
            actor["id"],
            input_data["scenario"],
            stages[0] if stages else None,
            input_data["stop_after_stage"],
            input_data["source_path"],
            json.dumps(input_data, ensure_ascii=False, separators=(",", ":")),
            max(0, int(settings.batch_task_auto_retry_limit)),
            utc_now_iso(),
        ),
    )
    return conn.execute("SELECT * FROM batch_tasks WHERE id = last_insert_rowid()").fetchone()


def _create_project_for_task(
    conn: sqlite3.Connection,
    *,
    task: sqlite3.Row,
    actor: sqlite3.Row,
) -> int:
    input_data = _task_input(task)
    source = _source_path(str(task["source_path"]))
    project = create_project_from_source_path(
        conn,
        user=actor,
        project_name=input_data["project_name"],
        target_region=input_data["target_region"],
        extra_requirements=str(input_data.get("extra_requirements") or ""),
        task_type=input_data["scenario"],
        source_path=source,
        source_title=Path(str(input_data.get("source_name") or "")).stem.strip() or input_data["project_name"],
        distribution_brief=_distribution_brief(input_data),
    )
    return int(project["id"])


def create_batch_tasks(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    batch_name: str,
    tasks: Iterable[dict[str, Any]],
    allowed_scenarios: set[str] | None = None,
    max_upload_bytes: int | None = None,
    commit: bool = True,
) -> dict:
    entries = list(tasks)
    if not entries:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请至少录入一条任务")
    if len(entries) > 100:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="单批最多录入 100 条任务")

    name = batch_name.strip()[:120] if batch_name else ""
    if not name:
        name = f"批量任务 {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    conn.execute(
        "INSERT INTO batch_task_batches (created_by, name) VALUES (?, ?)",
        (actor["id"], name),
    )
    batch_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    created_ids: list[int] = []
    saved_uploads: list[Path] = []

    try:
        for raw in entries:
            upload = raw.get("upload")
            if upload is None:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="每条任务都需要源文件")
            source_name = str(getattr(upload, "filename", "") or "源文件")
            source_path = save_upload(upload, actor["id"], max_bytes=max_upload_bytes)
            saved_uploads.append(source_path)
            input_data = _normalize_input(raw, source_path=source_path, source_name=source_name)
            if allowed_scenarios is not None and input_data["scenario"] not in allowed_scenarios:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="你没有使用该场景创建批量任务的权限")
            task = _insert_task(conn, batch_id=batch_id, actor=actor, input_data=input_data)
            created_ids.append(int(task["id"]))
    except Exception:
        for source_path in saved_uploads:
            source_path.unlink(missing_ok=True)
        raise

    record_audit(
        conn,
        actor=actor,
        action="batch_task.create",
        target_type="batch_task_batch",
        target_id=batch_id,
        target_label=name,
        details={
            "task_count": len(created_ids),
            "task_ids": created_ids,
            "scenarios": sorted({str(item.get("scenario") or "") for item in entries if item.get("scenario")}),
        },
    )
    if commit:
        conn.commit()
    rows = [_get_task_row(conn, task_id) for task_id in created_ids]
    return {
        "batch": {"id": batch_id, "name": name},
        "tasks": [_public_task(row) for row in rows if row],
    }


TASK_SELECT = """
    SELECT
        task.*, batch.name AS batch_name,
        creator.display_name AS creator_name,
        project.name AS project_name, project.workspace_dir AS project_workspace_dir,
        project.deleted_at AS project_deleted_at, project.status AS project_status,
        project.target_region AS project_target_region
    FROM batch_tasks AS task
    JOIN batch_task_batches AS batch ON batch.id = task.batch_id
    JOIN users AS creator ON creator.id = task.created_by
    LEFT JOIN projects AS project ON project.id = task.project_id
"""


def _get_task_row(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row | None:
    return conn.execute(f"{TASK_SELECT} WHERE task.id = ?", (task_id,)).fetchone()


def get_batch_task_or_404(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row:
    task = _get_task_row(conn, task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到批量任务")
    return task


def _duration_seconds(row: sqlite3.Row | dict) -> int | None:
    if not _timestamp(_row_value(row, "started_at")):
        return None
    elapsed = int(_row_value(row, "run_duration_seconds", 0) or 0)
    if _row_value(row, "status") != "running":
        return max(0, elapsed)
    active_start = _timestamp(_row_value(row, "active_started_at")) or _timestamp(_row_value(row, "started_at"))
    if not active_start:
        return max(0, elapsed)
    return max(0, elapsed + int((datetime.now(timezone.utc) - active_start).total_seconds()))


def _result_text(row: sqlite3.Row | dict) -> str:
    status_value = str(_row_value(row, "status", ""))
    if status_value == "succeeded":
        return "全部阶段已完成"
    if status_value == "failed":
        retries = int(_row_value(row, "retry_count", 0) or 0)
        max_retries = int(_row_value(row, "max_retries", 0) or 0)
        message = str(_row_value(row, "last_error") or "当前阶段未完成")
        if max_retries and retries >= max_retries:
            return f"已自动重试 {retries} 次仍未完成，可继续当前阶段：{message}"
        return f"可继续当前阶段：{message}"
    if status_value == "paused":
        return str(_row_value(row, "last_error") or "已暂停，启动后会从当前阶段继续")
    if status_value == "queued" and not _row_value(row, "project_id"):
        return "等待准备工作台项目"
    if status_value == "queued" and _row_value(row, "last_error") and int(_row_value(row, "retry_count", 0) or 0) > 0:
        retries = int(_row_value(row, "retry_count", 0) or 0)
        max_retries = int(_row_value(row, "max_retries", 0) or 0)
        return f"第 {retries}/{max_retries} 次自动重试已重新排队，将从当前阶段继续"
    if status_value == "queued":
        return "等待执行"
    return "正在执行当前阶段"


def _public_task(row: sqlite3.Row | dict) -> dict:
    input_data = _task_input(row)
    scenario = _scenario_map().get(str(_row_value(row, "scenario") or ""), {})
    stage_key = str(_row_value(row, "current_stage") or "")
    stage = next((item for item in scenario.get("stages", []) if item["key"] == stage_key), None)
    stop_after_key = str(_row_value(row, "stop_after_stage") or "")
    stop_after_stage = next((item for item in scenario.get("stages", []) if item["key"] == stop_after_key), None)
    return {
        "id": int(_row_value(row, "id")),
        "batch_id": int(_row_value(row, "batch_id")),
        "batch_name": _row_value(row, "batch_name"),
        "creator_name": _row_value(row, "creator_name") or "未知用户",
        "project_id": _row_value(row, "project_id"),
        "project_name": _row_value(row, "project_name") or input_data.get("project_name") or "未命名任务",
        "project_deleted": bool(_row_value(row, "project_deleted_at")),
        "scenario": {
            "key": _row_value(row, "scenario"),
            "name": scenario.get("name", _row_value(row, "scenario")),
        },
        "phase": {
            "key": stage_key or None,
            "name": stage.get("name") if stage else stage_key or "准备中",
            "file_name": stage.get("file_name") if stage else None,
        },
        "pause_at": {
            "key": stop_after_key or None,
            "name": stop_after_stage.get("name") if stop_after_stage else "全部阶段",
            "file_name": stop_after_stage.get("file_name") if stop_after_stage else None,
        },
        "status": _row_value(row, "status"),
        "result": _result_text(row),
        "duration_seconds": _duration_seconds(row),
        "started_at": _public_timestamp(_row_value(row, "started_at")),
        "finished_at": _public_timestamp(_row_value(row, "finished_at")),
        "created_at": _public_timestamp(_row_value(row, "created_at")),
        "retry_count": int(_row_value(row, "retry_count", 0) or 0),
        "max_retries": int(_row_value(row, "max_retries", 0) or 0),
        "run_count": int(_row_value(row, "run_count", 1) or 1),
        "last_error": _row_value(row, "last_error"),
    }


def list_batch_tasks(
    conn: sqlite3.Connection,
    *,
    scenario: str | None = None,
    status_value: str | None = None,
    query: str | None = None,
    limit: int = 200,
    allowed_scenarios: set[str] | None = None,
) -> dict:
    where: list[str] = []
    params: list[Any] = []
    if scenario:
        if allowed_scenarios is not None and scenario not in allowed_scenarios:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="你没有查看该场景批量任务的权限")
        where.append("task.scenario = ?")
        params.append(scenario)
    elif allowed_scenarios is not None:
        if not allowed_scenarios:
            where.append("1 = 0")
        else:
            placeholders = ", ".join("?" for _ in allowed_scenarios)
            where.append(f"task.scenario IN ({placeholders})")
            params.extend(sorted(allowed_scenarios))
    if status_value:
        where.append("task.status = ?")
        params.append(status_value)
    if query and query.strip():
        where.append("(COALESCE(project.name, '') LIKE ? OR task.input_json LIKE ?)")
        value = f"%{query.strip()}%"
        params.extend([value, value])
    sql = TASK_SELECT
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY CASE task.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END, task.updated_at DESC, task.id DESC LIMIT ?"
    rows = conn.execute(sql, [*params, min(500, max(1, limit))]).fetchall()
    return {
        "tasks": [_public_task(row) for row in rows],
        "scenarios": [
            item for item in list_task_scenarios()
            if allowed_scenarios is None or item["key"] in allowed_scenarios
        ],
        "max_parallel": max_parallel_tasks(),
    }


def _task_is_due(task: sqlite3.Row | dict) -> bool:
    due = _timestamp(_row_value(task, "next_attempt_at"))
    return due is None or due <= datetime.now(timezone.utc)


def schedule_batch_tasks(conn: sqlite3.Connection | None = None) -> list[int]:
    """Claim queue slots atomically; callers start one worker thread per returned task."""
    if conn is None:
        with get_connection() as owned_connection:
            return schedule_batch_tasks(owned_connection)

    conn.execute("BEGIN IMMEDIATE")
    running = int(conn.execute("SELECT COUNT(*) AS count FROM batch_tasks WHERE status = 'running'").fetchone()["count"])
    slots = max_parallel_tasks() - running
    if slots <= 0:
        conn.commit()
        return []
    rows = conn.execute(
        """
        SELECT * FROM batch_tasks
        WHERE status = 'queued'
        ORDER BY julianday(COALESCE(next_attempt_at, created_at)) ASC, id ASC
        """
    ).fetchall()
    task_ids: list[int] = []
    for task in rows:
        if len(task_ids) >= slots:
            break
        if not _task_is_due(task):
            continue
        updated = conn.execute(
            """
            UPDATE batch_tasks
            SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                active_started_at = CURRENT_TIMESTAMP,
                execution_owner = NULL, execution_lease_expires_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'queued'
            """,
            (task["id"],),
        )
        if updated.rowcount:
            task_ids.append(int(task["id"]))
            project_id = _row_value(task, "project_id")
            record_system_audit(
                conn,
                action="batch_task.started",
                target_type="batch_task",
                target_id=task["id"],
                target_label=f"批量任务 #{task['id']}",
                project_id=int(project_id) if project_id is not None else None,
                details={
                    "requested_by_user_id": _row_value(task, "created_by"),
                    "previous_status": "queued",
                    "current_stage": _row_value(task, "current_stage"),
                },
            )
    conn.commit()
    return task_ids


def _lease_expiry() -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=max(30, int(settings.agent_execution_lease_seconds)))).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _has_active_lease(task: sqlite3.Row | dict) -> bool:
    owner = str(_row_value(task, "execution_owner", "") or "").strip()
    expiry = _timestamp(_row_value(task, "execution_lease_expires_at"))
    return bool(owner and expiry and expiry > datetime.now(timezone.utc))


def _claim_task_execution(conn: sqlite3.Connection, task_id: int) -> bool:
    now = utc_now_iso()
    result = conn.execute(
        """
        UPDATE batch_tasks
        SET execution_owner = ?, execution_lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
          AND (
              execution_owner IS NULL OR execution_owner = ? OR execution_lease_expires_at IS NULL
              OR execution_lease_expires_at <= ?
          )
        """,
        (BATCH_EXECUTION_OWNER, _lease_expiry(), task_id, BATCH_EXECUTION_OWNER, now),
    )
    conn.commit()
    return result.rowcount == 1


def _renew_task_execution_lease(task_id: int, stop: threading.Event) -> None:
    interval = max(5, min(30, max(30, int(settings.agent_execution_lease_seconds)) // 3))
    while not stop.wait(interval):
        try:
            with get_connection() as conn:
                result = conn.execute(
                    """
                    UPDATE batch_tasks
                    SET execution_lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'running' AND execution_owner = ?
                    """,
                    (_lease_expiry(), task_id, BATCH_EXECUTION_OWNER),
                )
                if result.rowcount != 1:
                    return
        except Exception:
            # The next scheduler pass will recover a task after its current lease expires.
            return


def _release_task_execution(conn: sqlite3.Connection, task_id: int) -> None:
    conn.execute(
        """
        UPDATE batch_tasks
        SET execution_owner = NULL, execution_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND execution_owner = ?
        """,
        (task_id, BATCH_EXECUTION_OWNER),
    )
    conn.commit()


def _batch_stage_completion_action(stage: str, stage_status: object) -> str:
    """Return whether a completed batch job may advance under the current contract."""
    if stage in HUMAN_APPROVAL_STAGES:
        if stage_status == "approved":
            return "advance"
        if stage_status == "awaiting_approval":
            return "awaiting_approval"
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{stage} 当前状态为 {stage_status or 'unknown'}，尚未完成用户确认",
        )
    if stage_status != "completed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{stage} 当前状态为 {stage_status or 'unknown'}，尚未完成交付检查",
        )
    return "advance"


def _batch_should_auto_approve_stage(
    *,
    stage: str,
    stage_status: object,
    stop_after_stage: str,
    stages: list[str],
) -> bool:
    if stage not in HUMAN_APPROVAL_STAGES or stage_status != "awaiting_approval":
        return False
    try:
        return stages.index(stage) < stages.index(stop_after_stage)
    except ValueError:
        return False


def _auto_approve_batch_stage(
    conn: sqlite3.Connection,
    *,
    task: sqlite3.Row,
    project: sqlite3.Row,
    actor: sqlite3.Row,
    stage: str,
    stop_after_stage: str,
    job_id: int,
) -> None:
    workspace = resolve_workspace(str(project["workspace_dir"]))
    artifact_path = workspace / stage_file_for_workspace(workspace, stage)
    if not artifact_path.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="待确认阶段的交付文件不存在")
    artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    approval = approve_new_stage(
        workspace,
        stage=stage,
        actor=str(actor["username"]),
        artifact_hash=artifact_hash,
    )
    quality_contract_version = str(approval.get("quality_contract_version") or "")
    if not quality_contract_version:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="阶段确认结果不完整")
    existing_approval = conn.execute(
        """
        SELECT 1 FROM stage_approvals
        WHERE project_id = ? AND stage = ? AND artifact_hash = ?
          AND quality_contract_version = ?
        LIMIT 1
        """,
        (project["id"], stage, artifact_hash, quality_contract_version),
    ).fetchone()
    if not existing_approval:
        memory = approval.get("memory") if isinstance(approval.get("memory"), dict) else {}
        conn.execute(
            """
            INSERT INTO stage_approvals (
                project_id, stage, artifact_hash, quality_contract_version,
                memory_revision, approved_by, job_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project["id"],
                stage,
                artifact_hash,
                quality_contract_version,
                memory.get("revision"),
                actor["id"],
                job_id,
            ),
        )
    conn.execute(
        "UPDATE projects SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (stage, project["id"]),
    )
    record_system_audit(
        conn,
        action="batch_task.stage.auto_approve",
        target_type="project_stage",
        target_id=f"{project['id']}:{stage}",
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "batch_task_id": task["id"],
            "job_id": job_id,
            "stage": stage,
            "stop_after_stage": stop_after_stage,
            "requested_by_user_id": actor["id"],
        },
    )
    conn.commit()


def _batch_novel_recommendation_tool_message(raw: str, fallback: str) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip() or fallback
    message = payload.get("message") if isinstance(payload, dict) else None
    return message.strip() if isinstance(message, str) and message.strip() else fallback


def _accept_novel_analysis_recommendations(project: sqlite3.Row | dict) -> dict:
    workspace = resolve_workspace(str(project["workspace_dir"]))
    tool = settings.agents_dir / ".claude/skills/novel_analysis/scripts/accept-novel-analysis-recommendations.mjs"
    if not tool.is_file():
        raise RuntimeError("批量小说解读确认工具不可用")
    try:
        process = subprocess.run(
            [
                os.getenv("ORCA_NODE_PATH", "").strip() or "node",
                str(tool),
                "--workspace",
                str(workspace),
            ],
            cwd=settings.agents_dir,
            check=False,
            text=True,
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("批量小说解读确认超时") from exc
    except OSError as exc:
        raise RuntimeError("批量小说解读确认工具暂不可用") from exc
    if process.returncode != 0:
        detail = _batch_novel_recommendation_tool_message(
            process.stderr or process.stdout,
            "批量小说解读确认失败",
        )
        raise RuntimeError(f"批量小说解读确认失败：{detail}")
    try:
        payload = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("批量小说解读确认工具返回无效结果") from exc
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError("批量小说解读确认工具未完成")
    return payload


def _pause_for_stage_approval(
    conn: sqlite3.Connection,
    *,
    task: sqlite3.Row,
    project: sqlite3.Row,
    actor: sqlite3.Row,
    stage: str,
    job_id: int,
) -> None:
    stage_name = project_stage_label(project, stage)
    message = f"{stage_name}已生成，等待用户确认后再继续。"
    conn.execute(
        """
        UPDATE batch_tasks
        SET status = 'paused', current_job_id = ?, last_job_id = ?, next_attempt_at = NULL,
            last_error = ?, execution_owner = NULL, execution_lease_expires_at = NULL,
            run_duration_seconds = COALESCE(run_duration_seconds, 0) + COALESCE(MAX(0, CAST(
                (julianday(CURRENT_TIMESTAMP) - julianday(COALESCE(active_started_at, started_at))) * 86400
                AS INTEGER
            )), 0), active_started_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
        """,
        (job_id, job_id, message, task["id"]),
    )
    record_system_audit(
        conn,
        action="batch_task.awaiting_approval",
        target_type="project_stage",
        target_id=f"{project['id']}:{stage}",
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "batch_task_id": task["id"],
            "job_id": job_id,
            "stage": stage,
            "requested_by_user_id": actor["id"],
        },
    )
    conn.commit()


def _pause_after_stop_stage(
    conn: sqlite3.Connection,
    *,
    task: sqlite3.Row,
    project: sqlite3.Row,
    actor: sqlite3.Row,
    stage: str,
    next_stage: str,
    job_id: int,
) -> None:
    stage_name = project_stage_label(project, stage)
    next_stage_name = project_stage_label(project, next_stage)
    message = f"{stage_name}已生成，已按设置暂停。继续后将从{next_stage_name}开始。"
    conn.execute(
        """
        UPDATE batch_tasks
        SET status = 'paused', current_stage = ?, current_job_id = NULL, last_job_id = ?,
            next_attempt_at = NULL, last_error = ?, execution_owner = NULL,
            execution_lease_expires_at = NULL,
            run_duration_seconds = COALESCE(run_duration_seconds, 0) + COALESCE(MAX(0, CAST(
                (julianday(CURRENT_TIMESTAMP) - julianday(COALESCE(active_started_at, started_at))) * 86400
                AS INTEGER
            )), 0), active_started_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
        """,
        (next_stage, job_id, message, task["id"]),
    )
    record_system_audit(
        conn,
        action="batch_task.stop_after_stage",
        target_type="project_stage",
        target_id=f"{project['id']}:{stage}",
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "batch_task_id": task["id"],
            "job_id": job_id,
            "stage": stage,
            "next_stage": next_stage,
            "requested_by_user_id": actor["id"],
        },
    )
    conn.commit()


def _queue_retry(
    conn: sqlite3.Connection,
    *,
    task: sqlite3.Row,
    error: BaseException | object,
    retryable: bool,
    job_id: int | None = None,
) -> None:
    current = conn.execute("SELECT * FROM batch_tasks WHERE id = ?", (task["id"],)).fetchone()
    if not current or current["status"] != "running":
        return
    message = _error_message(error)
    retries = int(current["retry_count"] or 0)
    max_retries = int(current["max_retries"] or 0)
    if retryable and retries < max_retries:
        delay_seconds = min(60, 5 * (2 ** retries))
        retry_at = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)
        next_retry = retry_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        conn.execute(
            """
            UPDATE batch_tasks
            SET status = 'queued', current_job_id = COALESCE(?, current_job_id),
                last_job_id = COALESCE(?, last_job_id),
                retry_count = ?, next_attempt_at = ?, last_error = ?,
                execution_owner = NULL, execution_lease_expires_at = NULL,
                run_duration_seconds = COALESCE(run_duration_seconds, 0) + COALESCE(MAX(0, CAST(
                    (julianday(CURRENT_TIMESTAMP) - julianday(COALESCE(active_started_at, started_at))) * 86400
                    AS INTEGER
                )), 0), active_started_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'
            """,
            (job_id, job_id, retries + 1, next_retry, message, current["id"]),
        )
    else:
        conn.execute(
            """
            UPDATE batch_tasks
            SET status = 'failed', current_job_id = COALESCE(?, current_job_id),
                last_job_id = COALESCE(?, last_job_id),
                last_error = ?, finished_at = CURRENT_TIMESTAMP, next_attempt_at = NULL,
                execution_owner = NULL, execution_lease_expires_at = NULL,
                run_duration_seconds = COALESCE(run_duration_seconds, 0) + COALESCE(MAX(0, CAST(
                    (julianday(CURRENT_TIMESTAMP) - julianday(COALESCE(active_started_at, started_at))) * 86400
                    AS INTEGER
                )), 0), active_started_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'
            """,
            (job_id, job_id, message, current["id"]),
        )
    next_status = "queued" if retryable and retries < max_retries else "failed"
    project_id = _row_value(current, "project_id")
    record_system_audit(
        conn,
        action="batch_task.retry_scheduled" if next_status == "queued" else "batch_task.failed",
        target_type="batch_task",
        target_id=current["id"],
        target_label=f"批量任务 #{current['id']}",
        project_id=int(project_id) if project_id is not None else None,
        outcome="failure",
        severity="warning",
        details={
            "job_id": job_id,
            "previous_retry_count": retries,
            "retry_count": retries + 1 if next_status == "queued" else retries,
            "max_retries": max_retries,
            "next_status": next_status,
            "error": content_fingerprint(message),
        },
    )
    conn.commit()


def _complete_stage(
    conn: sqlite3.Connection,
    *,
    task: sqlite3.Row,
    project: sqlite3.Row,
    actor: sqlite3.Row,
    stage: str,
    job_id: int,
) -> bool:
    try:
        progress = load_progress(project["workspace_dir"])
        stage_progress = progress.get("stages", {}).get(stage, {})
        stage_status = stage_progress.get("status") if isinstance(stage_progress, dict) else None
        stages = task_stage_order(str(task["scenario"]), str(_row_value(project, "target_region", "") or ""))
        stop_after_stage = str(_row_value(task, "stop_after_stage") or "")
        has_pending_document_sync = stage == "trial_generate" and document_sync_pending(stage_progress)
        should_auto_approve = (
            not has_pending_document_sync
            and _batch_should_auto_approve_stage(
                stage=stage,
                stage_status=stage_status,
                stop_after_stage=stop_after_stage,
                stages=stages,
            )
        )
        action = (
            "advance"
            if has_pending_document_sync or should_auto_approve
            else _batch_stage_completion_action(stage, stage_status)
        )
        if should_auto_approve:
            _auto_approve_batch_stage(
                conn,
                task=task,
                project=project,
                actor=actor,
                stage=stage,
                stop_after_stage=stop_after_stage,
                job_id=job_id,
            )
        recommendation_result = (
            _accept_novel_analysis_recommendations(project)
            if stage == "novel_analysis" and action == "advance"
            else None
        )
    except Exception as exc:
        _queue_retry(conn, task=task, error=f"阶段状态检查失败：{_error_message(exc)}", retryable=True, job_id=job_id)
        return False

    if recommendation_result and recommendation_result.get("changed"):
        record_system_audit(
            conn,
            action="batch_task.novel_analysis.recommendations_accepted",
            target_type="project_stage",
            target_id=f"{project['id']}:novel_analysis",
            target_label=project["name"],
            project_id=int(project["id"]),
            details={
                "batch_task_id": task["id"],
                "job_id": job_id,
                "deleted_unit_count": recommendation_result.get("deleted_unit_count", 0),
                "newly_confirmed_merge_count": recommendation_result.get("newly_confirmed_merge_count", 0),
                "remaining_unit_count": recommendation_result.get("remaining_unit_count", 0),
                "requested_by_user_id": actor["id"],
            },
        )

    if action == "awaiting_approval":
        _pause_for_stage_approval(conn, task=task, project=project, actor=actor, stage=stage, job_id=job_id)
        return False

    next_index = stages.index(stage) + 1 if stage in stages else len(stages)
    if stage == stop_after_stage and stage not in HUMAN_APPROVAL_STAGES and next_index < len(stages):
        _pause_after_stop_stage(
            conn,
            task=task,
            project=project,
            actor=actor,
            stage=stage,
            next_stage=stages[next_index],
            job_id=job_id,
        )
        return False
    if next_index < len(stages):
        conn.execute(
            """
            UPDATE batch_tasks
            SET current_stage = ?, current_job_id = NULL, last_job_id = ?,
                next_attempt_at = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'
            """,
            (stages[next_index], job_id, utc_now_iso(), task["id"]),
        )
        record_system_audit(
            conn,
            action="batch_task.stage.advance",
            target_type="project_stage",
            target_id=f"{project['id']}:{stage}",
            target_label=project["name"],
            project_id=int(project["id"]),
            details={
                "batch_task_id": task["id"],
                "job_id": job_id,
                "stage": stage,
                "next_stage": stages[next_index],
                "requested_by_user_id": actor["id"],
            },
        )
        conn.commit()
        return True

    conn.execute(
        """
        UPDATE batch_tasks
        SET status = 'succeeded', current_job_id = NULL, last_job_id = ?, retry_count = 0,
            next_attempt_at = NULL, last_error = NULL, finished_at = CURRENT_TIMESTAMP,
            execution_owner = NULL, execution_lease_expires_at = NULL,
            run_duration_seconds = COALESCE(run_duration_seconds, 0) + COALESCE(MAX(0, CAST(
                (julianday(CURRENT_TIMESTAMP) - julianday(COALESCE(active_started_at, started_at))) * 86400
                AS INTEGER
            )), 0), active_started_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
        """,
        (job_id, task["id"]),
    )
    record_system_audit(
        conn,
        action="batch_task.complete",
        target_type="batch_task",
        target_id=task["id"],
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "job_id": job_id,
            "requested_by_user_id": actor["id"],
        },
    )
    conn.commit()
    return False


def _create_stage_job(
    conn: sqlite3.Connection,
    *,
    task: sqlite3.Row,
    project: sqlite3.Row,
    actor: sqlite3.Row,
    stage: str,
) -> sqlite3.Row:
    previous_job = None
    if task["last_job_id"]:
        previous_job = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (task["last_job_id"],)).fetchone()
    input_data = _task_input(task)
    job = create_job(
        conn,
        project=project,
        user=actor,
        stage=stage,
        prompt=str(input_data.get("extra_requirements") or ""),
        force_new_session=bool(previous_job and job_has_context_limit_failure(previous_job)),
        input_origin="batch_auto_retry" if int(task["retry_count"] or 0) else "batch",
        retry_of_job_id=int(previous_job["id"]) if previous_job and int(task["retry_count"] or 0) else None,
        audit_source="system",
    )
    conn.execute(
        "UPDATE batch_tasks SET current_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
        (job["id"], task["id"]),
    )
    conn.commit()
    return job


def _resume_interrupted_stage_job(
    conn: sqlite3.Connection,
    *,
    task: sqlite3.Row,
    project: sqlite3.Row,
    actor: sqlite3.Row,
    job: sqlite3.Row,
) -> sqlite3.Row | None:
    """Reuse a verified screenplay checkpoint; otherwise retry only this stage."""
    if job["status"] not in {"failed", "canceled"}:
        return job

    resumed = resume_failed_continuation_job(
        conn,
        job=job,
        project=project,
        username=str(actor["username"]),
    )
    if resumed:
        try:
            re_reserve_job_credits(conn, job_id=int(resumed["id"]))
        except HTTPException:
            cancel_job(conn, int(resumed["id"]))
            raise
        run_agent_job(int(resumed["id"]))
        return conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (resumed["id"],)).fetchone()

    conn.execute(
        """
        UPDATE batch_tasks
        SET current_job_id = NULL, last_job_id = COALESCE(current_job_id, last_job_id),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
        """,
        (task["id"],),
    )
    conn.commit()
    return None


def _run_task_pipeline(conn: sqlite3.Connection, task_id: int) -> None:
    while True:
        task = get_batch_task_or_404(conn, task_id)
        if task["status"] != "running":
            return
        actor = conn.execute("SELECT * FROM users WHERE id = ?", (task["created_by"],)).fetchone()
        if not actor:
            _queue_retry(conn, task=task, error="创建该批次的用户不存在", retryable=False)
            return
        if not task["project_id"]:
            try:
                project_id = _create_project_for_task(conn, task=task, actor=actor)
                conn.execute(
                    "UPDATE batch_tasks SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (project_id, task["id"]),
                )
                project = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
                if project:
                    record_system_audit(
                        conn,
                        action="project.create",
                        target_type="project",
                        target_id=project_id,
                        target_label=project["name"],
                        project_id=project_id,
                        details={
                            "creation_mode": "batch_task",
                            "batch_task_id": task["id"],
                            "requested_by_user_id": actor["id"],
                            "task_type": project["task_type"],
                            "target_region": _row_value(project, "target_region"),
                        },
                    )
                conn.commit()
            except Exception as exc:
                _queue_retry(conn, task=task, error=f"项目准备失败：{_error_message(exc)}", retryable=True)
                return
            continue
        if task["project_deleted_at"]:
            _queue_retry(conn, task=task, error="关联的工作台项目已删除，请使用重跑创建新项目", retryable=False)
            return
        project = conn.execute("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL", (task["project_id"],)).fetchone()
        if not project:
            _queue_retry(conn, task=task, error="关联的工作台项目不存在", retryable=False)
            return
        stage = str(task["current_stage"] or "")
        if stage not in task_stage_order(str(task["scenario"]), str(_row_value(project, "target_region", "") or "")):
            _queue_retry(conn, task=task, error="当前阶段不属于所选场景", retryable=False)
            return

        job = None
        if task["current_job_id"]:
            job = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (task["current_job_id"],)).fetchone()
        if not job and task["last_job_id"]:
            previous_job = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (task["last_job_id"],)).fetchone()
            if previous_job and previous_job["status"] in {"failed", "canceled"}:
                job = previous_job
        if job and job["status"] in {"failed", "canceled"}:
            job = _resume_interrupted_stage_job(
                conn,
                task=task,
                project=project,
                actor=actor,
                job=job,
            )
        if not job:
            try:
                job = _create_stage_job(conn, task=task, project=project, actor=actor, stage=stage)
            except Exception as exc:
                _queue_retry(conn, task=task, error=exc, retryable=True)
                return
            run_agent_job(int(job["id"]))
            job = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (job["id"],)).fetchone()
        if not job:
            _queue_retry(conn, task=task, error="阶段任务未能创建", retryable=True)
            return
        if job["status"] in {"queued", "running"}:
            # 仅发生在服务恢复时：原 Agent 仍有有效执行租约，等待其自身恢复完成。
            return
        if job["status"] == "succeeded":
            if not _complete_stage(conn, task=task, project=project, actor=actor, stage=stage, job_id=int(job["id"])):
                return
            continue
        if job["status"] == "canceled":
            latest = get_batch_task_or_404(conn, task_id)
            if latest["status"] == "paused":
                return
            _queue_retry(conn, task=task, error="阶段执行被取消，正在重新安排", retryable=True, job_id=int(job["id"]))
            return
        _queue_retry(
            conn,
            task=task,
            error=str(job["error_message"] or "阶段执行失败"),
            retryable=True,
            job_id=int(job["id"]),
        )
        return


def run_batch_task(task_id: int) -> None:
    with BATCH_RUNNING_TASKS_LOCK:
        if task_id in BATCH_RUNNING_TASK_IDS:
            return
        BATCH_RUNNING_TASK_IDS.add(task_id)
    try:
        with get_connection() as conn:
            if not _claim_task_execution(conn, task_id):
                return
            stop_heartbeat = threading.Event()
            heartbeat = threading.Thread(
                target=_renew_task_execution_lease,
                args=(task_id, stop_heartbeat),
                daemon=True,
            )
            heartbeat.start()
            try:
                _run_task_pipeline(conn, task_id)
            finally:
                stop_heartbeat.set()
                heartbeat.join(timeout=1)
                _release_task_execution(conn, task_id)
    finally:
        with BATCH_RUNNING_TASKS_LOCK:
            BATCH_RUNNING_TASK_IDS.discard(task_id)
        dispatch_batch_tasks()


def _start_batch_task_thread(task_id: int) -> None:
    thread = threading.Thread(target=run_batch_task, args=(task_id,), daemon=True, name=f"batch-task-{task_id}")
    thread.start()


def recover_batch_tasks(conn: sqlite3.Connection | None = None, *, force: bool = False) -> list[int]:
    """Return abandoned tasks whose runner can be resumed safely after restart."""
    if conn is None:
        with get_connection() as owned_connection:
            return recover_batch_tasks(owned_connection, force=force)
    rows = conn.execute("SELECT * FROM batch_tasks WHERE status = 'running' ORDER BY id").fetchall()
    resumable: list[int] = []
    for task in rows:
        if _has_active_lease(task) and not force:
            continue
        if force:
            conn.execute(
                """
                UPDATE batch_tasks
                SET execution_owner = NULL, execution_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'running'
                """,
                (task["id"],),
            )
        job = None
        if task["current_job_id"]:
            job = conn.execute("SELECT status FROM agent_jobs WHERE id = ?", (task["current_job_id"],)).fetchone()
        if job and job["status"] in {"queued", "running"}:
            continue
        conn.execute(
            """
            UPDATE batch_tasks
            SET execution_owner = NULL, execution_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'
            """,
            (task["id"],),
        )
        resumable.append(int(task["id"]))
    conn.commit()
    return resumable


def dispatch_batch_tasks(*, recovering_after_restart: bool = False) -> list[int]:
    """Resume interrupted work, then fill the remaining global queue slots."""
    resume_ids = recover_batch_tasks(force=recovering_after_restart)
    queued_ids = schedule_batch_tasks()
    task_ids = list(dict.fromkeys([*resume_ids, *queued_ids]))
    for task_id in task_ids:
        _start_batch_task_thread(task_id)
    return task_ids


def _require_allowed_task_scenario(task: sqlite3.Row, allowed_scenarios: set[str] | None) -> None:
    if allowed_scenarios is not None and str(task["scenario"]) not in allowed_scenarios:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="你没有操作该场景批量任务的权限")


def start_batch_task(
    conn: sqlite3.Connection,
    *,
    task_id: int,
    actor: sqlite3.Row,
    allowed_scenarios: set[str] | None = None,
) -> dict:
    task = get_batch_task_or_404(conn, task_id)
    _require_allowed_task_scenario(task, allowed_scenarios)
    if task["status"] == "succeeded":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="已完成的任务请使用重跑")
    conn.execute(
        """
        UPDATE batch_tasks
        SET status = 'queued', last_job_id = COALESCE(current_job_id, last_job_id),
            retry_count = 0, finished_at = NULL, next_attempt_at = ?, last_error = NULL,
            execution_owner = NULL, execution_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('queued', 'paused', 'failed')
        """,
        (utc_now_iso(), task_id),
    )
    action = "batch_task.resume" if task["status"] in {"paused", "failed"} else "batch_task.start"
    project_id = _row_value(task, "project_id")
    record_audit(
        conn,
        actor=actor,
        action=action,
        target_type="batch_task",
        target_id=task_id,
        target_label=task["project_name"],
        project_id=int(project_id) if project_id is not None else None,
        details={"previous_status": task["status"]},
    )
    conn.commit()
    return _public_task(get_batch_task_or_404(conn, task_id))


def pause_batch_task(
    conn: sqlite3.Connection,
    *,
    task_id: int,
    actor: sqlite3.Row,
    allowed_scenarios: set[str] | None = None,
) -> dict:
    task = get_batch_task_or_404(conn, task_id)
    _require_allowed_task_scenario(task, allowed_scenarios)
    if task["status"] in BATCH_TERMINAL_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="已结束的任务不能暂停")
    if task["current_job_id"]:
        job = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (task["current_job_id"],)).fetchone()
        if job and job["status"] not in TERMINAL_STATUSES:
            cancel_job(conn, int(job["id"]))
    conn.execute(
        """
        UPDATE batch_tasks
        SET status = 'paused', next_attempt_at = NULL, execution_owner = NULL,
            execution_lease_expires_at = NULL,
            run_duration_seconds = COALESCE(run_duration_seconds, 0) + CASE WHEN status = 'running' THEN COALESCE(MAX(0, CAST(
                (julianday(CURRENT_TIMESTAMP) - julianday(COALESCE(active_started_at, started_at))) * 86400
                AS INTEGER
            )), 0) ELSE 0 END,
            active_started_at = CASE WHEN status = 'running' THEN NULL ELSE active_started_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('queued', 'running', 'paused')
        """,
        (task_id,),
    )
    project_id = _row_value(task, "project_id")
    record_audit(
        conn,
        actor=actor,
        action="batch_task.pause",
        target_type="batch_task",
        target_id=task_id,
        target_label=task["project_name"],
        project_id=int(project_id) if project_id is not None else None,
        severity="warning",
        details={"previous_status": task["status"], "current_job_id": task["current_job_id"]},
    )
    conn.commit()
    return _public_task(get_batch_task_or_404(conn, task_id))


def rerun_batch_task(
    conn: sqlite3.Connection,
    *,
    task_id: int,
    actor: sqlite3.Row,
    allowed_scenarios: set[str] | None = None,
) -> dict:
    task = get_batch_task_or_404(conn, task_id)
    _require_allowed_task_scenario(task, allowed_scenarios)
    if task["status"] == "running":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="请先暂停正在执行的任务，再重新执行")
    input_data = _task_input(task)
    stages = task_stage_order(str(input_data["scenario"]), str(input_data.get("target_region") or ""))
    conn.execute(
        """
        UPDATE batch_tasks
        SET project_id = NULL, current_stage = ?, status = 'queued', current_job_id = NULL,
            last_job_id = NULL, retry_count = 0, next_attempt_at = ?, last_error = NULL,
            started_at = NULL, finished_at = NULL, run_duration_seconds = 0,
            active_started_at = NULL, execution_owner = NULL,
            execution_lease_expires_at = NULL, run_count = run_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (stages[0] if stages else None, utc_now_iso(), task_id),
    )
    record_audit(
        conn,
        actor=actor,
        action="batch_task.rerun",
        target_type="batch_task",
        target_id=task_id,
        target_label=input_data.get("project_name"),
        project_id=int(task["project_id"]) if task["project_id"] is not None else None,
        details={"previous_project_id": task["project_id"], "previous_status": task["status"]},
    )
    conn.commit()
    return _public_task(get_batch_task_or_404(conn, task_id))


def delete_batch_task(
    conn: sqlite3.Connection,
    *,
    task_id: int,
    actor: sqlite3.Row,
    allowed_scenarios: set[str] | None = None,
) -> None:
    task = get_batch_task_or_404(conn, task_id)
    _require_allowed_task_scenario(task, allowed_scenarios)
    if task["current_job_id"]:
        job = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (task["current_job_id"],)).fetchone()
        if job and job["status"] not in TERMINAL_STATUSES:
            cancel_job(conn, int(job["id"]))
    conn.execute("DELETE FROM batch_tasks WHERE id = ?", (task_id,))
    record_audit(
        conn,
        actor=actor,
        action="batch_task.delete",
        target_type="batch_task",
        target_id=task_id,
        target_label=task["project_name"],
        project_id=int(task["project_id"]) if task["project_id"] is not None else None,
        details={"project_id": task["project_id"], "workspace_retained": True},
        severity="warning",
    )
    conn.commit()


def start_all_batch_tasks(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    allowed_scenarios: set[str] | None = None,
) -> int:
    scenario_clause = ""
    scenario_params: list[Any] = []
    if allowed_scenarios is not None:
        if not allowed_scenarios:
            return 0
        placeholders = ", ".join("?" for _ in allowed_scenarios)
        scenario_clause = f" AND scenario IN ({placeholders})"
        scenario_params = sorted(allowed_scenarios)
    result = conn.execute(
        f"""
        UPDATE batch_tasks
        SET status = 'queued',
            last_job_id = CASE WHEN status IN ('paused', 'failed') THEN COALESCE(current_job_id, last_job_id) ELSE last_job_id END,
            retry_count = CASE WHEN status IN ('paused', 'failed') THEN 0 ELSE retry_count END,
            next_attempt_at = ?, last_error = NULL,
            execution_owner = NULL, execution_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'paused', 'failed'){scenario_clause}
        """,
        [utc_now_iso(), *scenario_params],
    )
    record_audit(
        conn,
        actor=actor,
        action="batch_task.start_all",
        target_type="batch_task",
        target_label="全部批量任务",
        details={"updated": result.rowcount},
    )
    conn.commit()
    return result.rowcount
