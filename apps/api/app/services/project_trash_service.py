from __future__ import annotations

import json
import logging
import math
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException, status

from app.core.config import settings
from app.db.session import get_connection
from app.services.agent_runner import cancel_job
from app.services.audit_service import record_system_audit
from app.services.workspace_service import can_manage_project_permissions, project_row_to_public, resolve_workspace, row_task_type, workspace_input_path
from app.services.zdebug_manager import zdebug_manager


TRASH_RETENTION_DAYS = 30
TRASH_CLEANUP_INTERVAL_SECONDS = 60 * 60
logger = logging.getLogger(__name__)


class ProjectPurgeError(RuntimeError):
    pass


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _iso_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _trash_row_to_public(row: sqlite3.Row, *, now: datetime | None = None) -> dict:
    deleted_at = _parse_timestamp(row["deleted_at"])
    purge_at = deleted_at + timedelta(days=TRASH_RETENTION_DAYS)
    remaining_seconds = max(0, (purge_at - (now or _utc_now())).total_seconds())
    return {
        "id": row["id"],
        "name": row["name"],
        "target_region": row["target_region"],
        "task_type": row_task_type(row),
        "deleted_at": _iso_timestamp(deleted_at),
        "purge_at": _iso_timestamp(purge_at),
        "days_remaining": math.ceil(remaining_seconds / 86400),
    }


def list_trashed_projects(
    conn: sqlite3.Connection,
    user: sqlite3.Row,
    *,
    page: int = 1,
    page_size: int = 10,
) -> dict:
    where = ["deleted_at IS NOT NULL"]
    params: list[int] = []
    if user["role"] != "admin":
        where.append("owner_user_id = ?")
        params.append(user["id"])
    where_clause = " AND ".join(where)
    total = conn.execute(
        f"SELECT COUNT(*) AS total FROM projects WHERE {where_clause}",
        params,
    ).fetchone()["total"]
    total_pages = max(1, math.ceil(total / page_size))
    current_page = min(max(1, page), total_pages)
    offset = (current_page - 1) * page_size
    rows = conn.execute(
        f"""
        SELECT * FROM projects
        WHERE {where_clause}
        ORDER BY deleted_at DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        [*params, page_size, offset],
    ).fetchall()
    now = _utc_now()
    return {
        "projects": [_trash_row_to_public(row, now=now) for row in rows],
        "pagination": {
            "page": current_page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
        },
    }


def get_trashed_project_or_404(
    conn: sqlite3.Connection,
    project_id: int,
    user: sqlite3.Row,
) -> sqlite3.Row:
    project = conn.execute(
        "SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL",
        (project_id,),
    ).fetchone()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="回收站中未找到该项目")
    if not can_manage_project_permissions(user, project):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权操作该项目")
    return project


def _project_job_rows(conn: sqlite3.Connection, project_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, status, raw_log_path FROM agent_jobs WHERE project_id = ? ORDER BY id",
        (project_id,),
    ).fetchall()


def _stop_project_jobs(conn: sqlite3.Connection, project_id: int) -> list[sqlite3.Row]:
    jobs = _project_job_rows(conn, project_id)
    for job in jobs:
        if job["status"] in {"queued", "running"}:
            cancel_job(conn, job["id"])
        zdebug_manager.stop_for_job(job["id"])
    return jobs


def move_project_to_trash(conn: sqlite3.Connection, project: sqlite3.Row) -> None:
    _stop_project_jobs(conn, project["id"])
    conn.execute(
        "UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL",
        (project["id"],),
    )


def _workspace_target(workspace_dir: str) -> Path:
    unresolved = settings.agents_dir / workspace_dir
    if unresolved.is_symlink():
        raise ProjectPurgeError("项目工作目录不能是符号链接")
    try:
        target = resolve_workspace(workspace_dir)
    except HTTPException as exc:
        raise ProjectPurgeError("项目工作目录越界，已拒绝删除") from exc
    if target == settings.workspaces_dir.resolve():
        raise ProjectPurgeError("不能删除 workspace 根目录")
    if target.exists() and not target.is_dir():
        raise ProjectPurgeError("项目工作路径不是目录")
    return target


def _managed_upload_from_workspace(conn: sqlite3.Connection, workspace: Path) -> Path | None:
    input_path = workspace_input_path(workspace)
    if not input_path.is_file():
        return None
    try:
        payload = json.loads(input_path.read_text(encoding="utf-8"))
        raw_path = payload.get("project", {}).get("source_file", {}).get("original_path")
    except (OSError, json.JSONDecodeError, AttributeError):
        return None
    if not isinstance(raw_path, str) or not raw_path:
        return None
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = settings.repo_root / candidate
    target = candidate.resolve()
    upload_root = settings.upload_dir.resolve()
    if target == upload_root:
        raise ProjectPurgeError("不能删除上传根目录")
    if not target.is_relative_to(upload_root):
        return None
    if target.exists() and not target.is_file():
        raise ProjectPurgeError("项目上传路径不是文件")
    # 批量任务可能仍需使用同一原始剧本进行重跑；删除旧 workspace 时不能提前删除它。
    try:
        referenced_by_batch = conn.execute(
            "SELECT 1 FROM batch_tasks WHERE source_path = ? LIMIT 1",
            (str(target),),
        ).fetchone()
    except sqlite3.OperationalError:
        referenced_by_batch = None
    if referenced_by_batch:
        return None
    return target


def _project_log_paths(jobs: list[sqlite3.Row]) -> set[Path]:
    log_root = (settings.data_dir / "zdebug" / "jobs").resolve()
    paths: set[Path] = set()
    for job in jobs:
        paths.add((log_root / f"agent_job_{job['id']}.jsonl").resolve())
        raw_path = job["raw_log_path"]
        if not raw_path:
            continue
        recorded = Path(raw_path).expanduser()
        if not recorded.is_absolute():
            recorded = settings.repo_root / recorded
        recorded = recorded.resolve()
        if recorded == log_root or not recorded.is_relative_to(log_root):
            raise ProjectPurgeError("项目运行日志路径越界，已拒绝删除")
        paths.add(recorded)
    for path in paths:
        if path.exists() and not path.is_file():
            raise ProjectPurgeError("项目运行日志路径不是文件")
    return paths


def restore_project(conn: sqlite3.Connection, project: sqlite3.Row) -> dict:
    workspace = _workspace_target(project["workspace_dir"])
    if not workspace.is_dir():
        raise ProjectPurgeError("项目文件已不存在，无法恢复")
    conn.execute(
        "UPDATE projects SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (project["id"],),
    )
    restored = conn.execute("SELECT * FROM projects WHERE id = ?", (project["id"],)).fetchone()
    return project_row_to_public(restored)


def purge_project(conn: sqlite3.Connection, project: sqlite3.Row) -> None:
    if project["deleted_at"] is None:
        raise ProjectPurgeError("只能彻底删除回收站中的项目")

    jobs = _stop_project_jobs(conn, project["id"])
    workspace = _workspace_target(project["workspace_dir"])
    upload = _managed_upload_from_workspace(conn, workspace)
    log_paths = _project_log_paths(jobs)

    try:
        if upload:
            upload.unlink(missing_ok=True)
            upload_parent = upload.parent
            if upload_parent != settings.upload_dir.resolve():
                try:
                    upload_parent.rmdir()
                except OSError:
                    pass
        for log_path in log_paths:
            log_path.unlink(missing_ok=True)
        if workspace.exists():
            shutil.rmtree(workspace)
    except OSError as exc:
        logger.exception("项目资源清理失败: project_id=%s", project["id"])
        raise ProjectPurgeError("项目文件清理失败，请检查文件权限后重试") from exc

    deleted = conn.execute(
        "DELETE FROM projects WHERE id = ? AND deleted_at IS NOT NULL",
        (project["id"],),
    )
    if deleted.rowcount != 1:
        raise ProjectPurgeError("项目状态已变更，未执行彻底删除")


def purge_expired_projects(conn: sqlite3.Connection, *, now: datetime | None = None) -> dict:
    cutoff = (now or _utc_now()) - timedelta(days=TRASH_RETENTION_DAYS)
    cutoff_value = cutoff.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    rows = conn.execute(
        "SELECT * FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY deleted_at, id",
        (cutoff_value,),
    ).fetchall()
    purged_ids: list[int] = []
    failures: list[dict] = []
    for project in rows:
        try:
            purge_project(conn, project)
            record_system_audit(
                conn,
                action="project.purge",
                target_type="project",
                target_id=project["id"],
                target_label=project["name"],
                project_id=int(project["id"]),
                severity="warning",
                details={
                    "purge_mode": "retention_cleanup",
                    "deleted_at": project["deleted_at"],
                    "retention_days": TRASH_RETENTION_DAYS,
                },
            )
            conn.commit()
            purged_ids.append(project["id"])
        except Exception as exc:
            conn.rollback()
            logger.exception("过期项目清理失败: project_id=%s", project["id"])
            failures.append({"project_id": project["id"], "error": str(exc)})
    return {"purged_ids": purged_ids, "failures": failures}


def run_expired_project_cleanup() -> dict:
    with get_connection() as conn:
        return purge_expired_projects(conn)
