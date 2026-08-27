from __future__ import annotations

import json
import logging
import math
import os
import shutil
import sqlite3
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status

from app.core.config import settings
from app.core.security import hash_password
from app.services.agent_runner import cancel_job, create_job, public_job
from app.services.audit_service import audit_row_to_public, record_audit
from app.services.project_lifecycle_service import (
    PROJECT_STATUS_ACTIVE,
    PROJECT_STATUS_COMPLETED,
    archive_project,
    row_project_status,
)
from app.services.project_trash_service import ProjectPurgeError, move_project_to_trash, purge_project, restore_project
from app.services.region_admin_service import load_region_config
from app.services.role_service import (
    ROLE_CODE_SYSTEM_ADMIN,
    assign_legacy_role,
    require_manage_user_account,
    replace_user_roles,
    roles_for_user_ids,
)
from app.services.workspace_service import (
    TASK_SCENARIOS,
    TASK_TYPES,
    project_row_to_public,
    resolve_workspace,
    row_task_type,
    stage_file_for_workspace,
)


logger = logging.getLogger(__name__)
SHANGHAI = ZoneInfo("Asia/Shanghai")
PERIOD_DAYS = {"7d": 7, "30d": 30}
DELETED_ACTOR_USERNAME = "__deleted_user__"
AGENT_STAGES = ["novel_analysis", "world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review", "humanizer_zh"]
DASHBOARD_STAGES = ["project_init", *AGENT_STAGES]


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _public_admin_user(row: sqlite3.Row, roles: list[dict] | None = None) -> dict:
    keys = set(row.keys())
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "roles": roles or [],
        "role_ids": [int(role["id"]) for role in (roles or [])],
        "is_active": bool(row["is_active"]),
        "project_count": row["project_count"] if "project_count" in keys else 0,
        "completed_project_count": row["completed_project_count"] if "completed_project_count" in keys else 0,
        "job_count": row["job_count"] if "job_count" in keys else 0,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_admin_users(conn: sqlite3.Connection, query: str | None = None) -> list[dict]:
    params: list[object] = []
    where = ["COALESCE(users.is_system, 0) = 0"]
    if query:
        where.append("(users.username LIKE ? OR users.display_name LIKE ?)")
        value = f"%{query.strip()}%"
        params.extend([value, value])
    rows = conn.execute(
        f"""
        SELECT users.*,
               COUNT(DISTINCT projects.id) AS project_count,
               COUNT(DISTINCT CASE WHEN projects.status = 'completed' AND projects.deleted_at IS NULL THEN projects.id END)
                   AS completed_project_count,
               COUNT(DISTINCT agent_jobs.id) AS job_count
        FROM users
        LEFT JOIN projects ON projects.owner_user_id = users.id
        LEFT JOIN agent_jobs ON agent_jobs.user_id = users.id
        WHERE {' AND '.join(where)}
        GROUP BY users.id
        ORDER BY CASE users.role WHEN 'admin' THEN 0 ELSE 1 END, users.created_at, users.id
        """,
        params,
    ).fetchall()
    role_map = roles_for_user_ids(conn, [int(row["id"]) for row in rows])
    return [_public_admin_user(row, role_map.get(int(row["id"]), [])) for row in rows]


def get_admin_user_or_404(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row:
    user = conn.execute(
        "SELECT * FROM users WHERE id = ? AND COALESCE(is_system, 0) = 0",
        (user_id,),
    ).fetchone()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
    return user


def update_admin_user(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    target: sqlite3.Row,
    display_name: str | None = None,
    role: str | None = None,
    role_ids: list[int] | None = None,
    password: str | None = None,
) -> dict:
    changes: dict[str, object] = {}
    if display_name is not None:
        next_name = display_name.strip()
        if not next_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="显示名称不能为空")
        if next_name != target["display_name"]:
            conn.execute("UPDATE users SET display_name = ? WHERE id = ?", (next_name, target["id"]))
            changes["display_name"] = {"before": target["display_name"], "after": next_name}
    if role_ids is not None:
        assigned_roles = replace_user_roles(conn, actor=actor, target=target, role_ids=role_ids)
        changes["roles"] = {"role_ids": [int(item["id"]) for item in assigned_roles]}
    elif role is not None and role != target["role"]:
        assigned_roles = assign_legacy_role(conn, actor=actor, target=target, role=role)
        changes["roles"] = {"role_ids": [int(item["id"]) for item in assigned_roles]}
    if password is not None:
        require_manage_user_account(conn, actor, target)
        if len(password) < 8:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="密码至少需要 8 个字符")
        conn.execute(
            "UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?",
            (hash_password(password), target["id"]),
        )
        changes["password_reset"] = True
    if changes:
        conn.execute("UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (target["id"],))
        record_audit(
            conn,
            actor=actor,
            action="user.update",
            target_type="user",
            target_id=target["id"],
            target_label=target["username"],
            details=changes,
        )
    row = conn.execute(
        """
        SELECT users.*,
               (SELECT COUNT(*) FROM projects WHERE owner_user_id = users.id) AS project_count,
               (SELECT COUNT(*) FROM projects WHERE owner_user_id = users.id AND status = 'completed' AND deleted_at IS NULL)
                   AS completed_project_count,
               (SELECT COUNT(*) FROM agent_jobs WHERE user_id = users.id) AS job_count
        FROM users WHERE users.id = ?
        """,
        (target["id"],),
    ).fetchone()
    role_map = roles_for_user_ids(conn, [int(target["id"])])
    return _public_admin_user(row, role_map.get(int(target["id"]), []))


def _ensure_deleted_actor(conn: sqlite3.Connection) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM users WHERE username = ?", (DELETED_ACTOR_USERNAME,)).fetchone()
    if row:
        return row
    conn.execute(
        """
        INSERT INTO users (username, display_name, password_hash, role, is_active, is_system)
        VALUES (?, '已删除用户', 'disabled', 'user', 0, 1)
        """,
        (DELETED_ACTOR_USERNAME,),
    )
    return conn.execute("SELECT * FROM users WHERE username = ?", (DELETED_ACTOR_USERNAME,)).fetchone()


def delete_admin_user(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    target: sqlite3.Row,
    transfer_to_user_id: int | None,
) -> dict:
    if target["id"] == actor["id"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="不能删除当前登录账号")
    require_manage_user_account(conn, actor, target)
    target_roles = roles_for_user_ids(conn, [int(target["id"])]).get(int(target["id"]), [])
    if any(role["code"] == ROLE_CODE_SYSTEM_ADMIN for role in target_roles):
        admin_count = conn.execute(
            """
            SELECT COUNT(DISTINCT users.id)
            FROM users
            JOIN user_roles ON user_roles.user_id = users.id
            JOIN roles ON roles.id = user_roles.role_id
            WHERE roles.code = ?
              AND users.is_active = 1
              AND COALESCE(users.is_system, 0) = 0
            """,
            (ROLE_CODE_SYSTEM_ADMIN,),
        ).fetchone()[0]
        if admin_count <= 1:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="不能删除最后一个管理员")

    project_count = conn.execute("SELECT COUNT(*) FROM projects WHERE owner_user_id = ?", (target["id"],)).fetchone()[0]
    transfer_user = None
    if project_count:
        if transfer_to_user_id is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请选择项目接收人")
        transfer_user = conn.execute(
            """
            SELECT * FROM users
            WHERE id = ? AND id != ? AND is_active = 1 AND COALESCE(is_system, 0) = 0
            """,
            (transfer_to_user_id, target["id"]),
        ).fetchone()
        if not transfer_user:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目接收人无效")

    active_jobs = conn.execute(
        """
        SELECT COUNT(*) FROM agent_jobs
        WHERE status IN ('queued', 'running')
          AND (user_id = ? OR project_id IN (SELECT id FROM projects WHERE owner_user_id = ?))
        """,
        (target["id"], target["id"]),
    ).fetchone()[0]
    if active_jobs:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该用户仍有运行中的 Agent 任务，请先结束任务")

    upload_dir = settings.upload_dir / str(target["id"])
    quarantine: Path | None = None
    if upload_dir.exists():
        quarantine_root = settings.data_dir / ".user-delete-quarantine"
        quarantine_root.mkdir(parents=True, exist_ok=True)
        quarantine = quarantine_root / f"{target['id']}-{uuid.uuid4().hex}"
        os.replace(upload_dir, quarantine)

    try:
        deleted_actor = _ensure_deleted_actor(conn)
        if transfer_user:
            conn.execute(
                "UPDATE projects SET owner_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ?",
                (transfer_user["id"], target["id"]),
            )
        for table, column in (
            ("agent_jobs", "user_id"),
            ("file_versions", "edited_by"),
            ("stage_approvals", "approved_by"),
            ("artifact_changes", "edited_by"),
        ):
            conn.execute(f"UPDATE {table} SET {column} = ? WHERE {column} = ?", (deleted_actor["id"], target["id"]))
        conn.execute("UPDATE agent_evolution_reviews SET reviewed_by = NULL WHERE reviewed_by = ?", (target["id"],))
        conn.execute(
            "UPDATE system_agent_evolution_runs SET triggered_by = ? WHERE triggered_by = ?",
            (deleted_actor["id"], target["id"]),
        )
        conn.execute(
            "UPDATE system_agent_evolution_runs SET reviewed_by = NULL WHERE reviewed_by = ?",
            (target["id"],),
        )
        conn.execute("UPDATE projects SET completed_by = NULL WHERE completed_by = ?", (target["id"],))
        record_audit(
            conn,
            actor=actor,
            action="user.delete",
            target_type="user",
            target_id=target["id"],
            target_label=target["username"],
            details={
                "display_name": target["display_name"],
                "role": target["role"],
                "project_count": project_count,
                "transferred_to_user_id": transfer_user["id"] if transfer_user else None,
                "transferred_to_username": transfer_user["username"] if transfer_user else None,
            },
        )
        deleted = conn.execute("DELETE FROM users WHERE id = ?", (target["id"],))
        if deleted.rowcount != 1:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="用户状态已变化，请刷新后重试")
        conn.commit()
    except Exception:
        conn.rollback()
        if quarantine and quarantine.exists() and not upload_dir.exists():
            os.replace(quarantine, upload_dir)
        raise

    if quarantine and quarantine.exists():
        try:
            shutil.rmtree(quarantine)
        except OSError:
            logger.exception("已删除用户的上传文件清理失败: user_id=%s", target["id"])
    return {"ok": True, "transferred_projects": project_count}


def _admin_project_row(row: sqlite3.Row) -> dict:
    result = project_row_to_public(row)
    keys = set(row.keys())
    result.update({
        "owner_username": row["owner_username"],
        "owner_display_name": row["owner_display_name"],
        "job_count": row["job_count"] if "job_count" in keys else 0,
        "failed_job_count": row["failed_job_count"] if "failed_job_count" in keys else 0,
        "deleted_at": row["deleted_at"],
        "lifecycle_status": "trash" if row["deleted_at"] else row_project_status(row),
    })
    return result


def list_admin_projects(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    lifecycle: str = "all",
    task_type: str | None = None,
    region: str | None = None,
    owner_user_id: int | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict:
    where = ["1 = 1"]
    params: list[object] = []
    if query:
        where.append("(projects.name LIKE ? OR users.username LIKE ? OR users.display_name LIKE ?)")
        value = f"%{query.strip()}%"
        params.extend([value, value, value])
    if lifecycle == "trash":
        where.append("projects.deleted_at IS NOT NULL")
    elif lifecycle in {PROJECT_STATUS_ACTIVE, PROJECT_STATUS_COMPLETED}:
        where.extend(["projects.deleted_at IS NULL", "projects.status = ?"])
        params.append(lifecycle)
    elif lifecycle == "all":
        pass
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="无效的项目状态")
    if task_type:
        where.append("projects.task_type = ?")
        params.append(task_type)
    if region:
        where.append("projects.target_region = ?")
        params.append(region)
    if owner_user_id:
        where.append("projects.owner_user_id = ?")
        params.append(owner_user_id)
    where_sql = " AND ".join(where)
    total = conn.execute(
        f"SELECT COUNT(*) FROM projects JOIN users ON users.id = projects.owner_user_id WHERE {where_sql}",
        params,
    ).fetchone()[0]
    total_pages = max(1, math.ceil(total / page_size))
    current_page = min(page, total_pages)
    rows = conn.execute(
        f"""
        SELECT projects.*, users.username AS owner_username, users.display_name AS owner_display_name,
               EXISTS (
                   SELECT 1 FROM agent_jobs active
                   WHERE active.project_id = projects.id AND active.status IN ('queued', 'running')
               ) AS has_running_agent,
               (SELECT COUNT(*) FROM agent_jobs jobs WHERE jobs.project_id = projects.id) AS job_count,
               (SELECT COUNT(*) FROM agent_jobs jobs WHERE jobs.project_id = projects.id AND jobs.status = 'failed')
                   AS failed_job_count
        FROM projects
        JOIN users ON users.id = projects.owner_user_id
        WHERE {where_sql}
        ORDER BY projects.deleted_at IS NOT NULL, projects.updated_at DESC, projects.id DESC
        LIMIT ? OFFSET ?
        """,
        [*params, page_size, (current_page - 1) * page_size],
    ).fetchall()
    return {
        "projects": [_admin_project_row(row) for row in rows],
        "pagination": {"page": current_page, "page_size": page_size, "total": total, "total_pages": total_pages},
    }


def update_admin_project(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    project: sqlite3.Row,
    name: str | None = None,
    owner_user_id: int | None = None,
    target_region: str | None = None,
) -> dict:
    changes: dict[str, object] = {}
    if name is not None:
        next_name = name.strip()
        if not next_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目名称不能为空")
        if next_name != project["name"]:
            conn.execute("UPDATE projects SET name = ? WHERE id = ?", (next_name, project["id"]))
            changes["name"] = {"before": project["name"], "after": next_name}
    if owner_user_id is not None and owner_user_id != project["owner_user_id"]:
        owner = conn.execute(
            "SELECT * FROM users WHERE id = ? AND is_active = 1 AND COALESCE(is_system, 0) = 0",
            (owner_user_id,),
        ).fetchone()
        if not owner:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目负责人无效")
        conn.execute("UPDATE projects SET owner_user_id = ? WHERE id = ?", (owner_user_id, project["id"]))
        changes["owner_user_id"] = {"before": project["owner_user_id"], "after": owner_user_id}
    if target_region is not None and target_region != project["target_region"]:
        config, _digest = load_region_config()
        if target_region not in config.regions:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="目标地区不存在")
        conn.execute("UPDATE projects SET target_region = ? WHERE id = ?", (target_region, project["id"]))
        changes["target_region"] = {"before": project["target_region"], "after": target_region}
    if changes:
        conn.execute("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (project["id"],))
        record_audit(
            conn,
            actor=actor,
            action="project.update",
            target_type="project",
            target_id=project["id"],
            target_label=next_name if name is not None and name.strip() else project["name"],
            project_id=int(project["id"]),
            details=changes,
        )
    row = conn.execute(
        """
        SELECT projects.*, users.username AS owner_username, users.display_name AS owner_display_name,
               EXISTS (SELECT 1 FROM agent_jobs WHERE project_id = projects.id AND status IN ('queued', 'running'))
                   AS has_running_agent,
               (SELECT COUNT(*) FROM agent_jobs WHERE project_id = projects.id) AS job_count,
               (SELECT COUNT(*) FROM agent_jobs WHERE project_id = projects.id AND status = 'failed') AS failed_job_count
        FROM projects JOIN users ON users.id = projects.owner_user_id
        WHERE projects.id = ?
        """,
        (project["id"],),
    ).fetchone()
    return _admin_project_row(row)


def trash_admin_project(conn: sqlite3.Connection, *, actor: sqlite3.Row, project: sqlite3.Row) -> None:
    if project["deleted_at"]:
        return
    active_jobs = [
        int(row["id"])
        for row in conn.execute(
            "SELECT id FROM agent_jobs WHERE project_id = ? AND status IN ('queued', 'running') ORDER BY id",
            (project["id"],),
        ).fetchall()
    ]
    move_project_to_trash(conn, project)
    record_audit(
        conn,
        actor=actor,
        action="project.trash",
        target_type="project",
        target_id=project["id"],
        target_label=project["name"],
        project_id=int(project["id"]),
        severity="warning",
        details={"canceled_agent_job_ids": active_jobs},
    )


def bulk_admin_project_action(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    action: str,
    project_ids: list[int],
) -> dict:
    """Apply one lifecycle action to each selected project and report stale rows."""
    succeeded: list[int] = []
    failed: list[dict[str, object]] = []

    for project_id in project_ids:
        project = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not project:
            failed.append({"project_id": project_id, "message": "项目不存在或状态已变化"})
            continue
        if project["deleted_at"]:
            failed.append({"project_id": project_id, "message": "回收站中的项目不能执行此操作"})
            continue

        try:
            if action == "archive":
                archive_project(conn, project=project, actor=actor)
            elif action == "trash":
                trash_admin_project(conn, actor=actor, project=project)
            else:
                raise ValueError(f"Unsupported bulk project action: {action}")
        except HTTPException as exc:
            failed.append({"project_id": project_id, "message": str(exc.detail)})
        except Exception:
            logger.exception("批量项目操作失败: action=%s project_id=%s", action, project_id)
            failed.append({"project_id": project_id, "message": "操作未完成，请稍后重试"})
        else:
            succeeded.append(project_id)

    return {"succeeded": succeeded, "failed": failed}


def restore_admin_project(conn: sqlite3.Connection, *, actor: sqlite3.Row, project: sqlite3.Row) -> dict:
    try:
        restored = restore_project(conn, project)
    except ProjectPurgeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    record_audit(
        conn,
        actor=actor,
        action="project.restore",
        target_type="project",
        target_id=project["id"],
        target_label=project["name"],
        project_id=int(project["id"]),
        details={"deleted_at": project["deleted_at"]},
    )
    return restored


def purge_admin_project(conn: sqlite3.Connection, *, actor: sqlite3.Row, project: sqlite3.Row) -> None:
    details = {
        "workspace_dir": project["workspace_dir"],
        "owner_user_id": project["owner_user_id"],
        "deleted_at": project["deleted_at"],
    }
    try:
        purge_project(conn, project)
    except ProjectPurgeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    record_audit(
        conn,
        actor=actor,
        action="project.purge",
        target_type="project",
        target_id=project["id"],
        target_label=project["name"],
        project_id=int(project["id"]),
        details=details,
        severity="warning",
    )


def list_admin_jobs(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    job_status: str | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict:
    where = ["1 = 1"]
    params: list[object] = []
    if query:
        where.append("(projects.name LIKE ? OR users.username LIKE ? OR CAST(agent_jobs.id AS TEXT) = ?)")
        value = f"%{query.strip()}%"
        params.extend([value, value, query.strip()])
    if job_status:
        where.append("agent_jobs.status = ?")
        params.append(job_status)
    where_sql = " AND ".join(where)
    total = conn.execute(
        f"""
        SELECT COUNT(*) FROM agent_jobs
        JOIN projects ON projects.id = agent_jobs.project_id
        JOIN users ON users.id = agent_jobs.user_id
        WHERE {where_sql}
        """,
        params,
    ).fetchone()[0]
    total_pages = max(1, math.ceil(total / page_size))
    current_page = min(page, total_pages)
    rows = conn.execute(
        f"""
        SELECT agent_jobs.*, projects.name AS project_name, projects.status AS project_status,
               projects.deleted_at AS project_deleted_at,
               users.username AS requested_by_username,
               CASE WHEN agent_jobs.started_at IS NOT NULL AND agent_jobs.finished_at IS NOT NULL
                    THEN ROUND((julianday(agent_jobs.finished_at) - julianday(agent_jobs.started_at)) * 86400)
               END AS duration_seconds
        FROM agent_jobs
        JOIN projects ON projects.id = agent_jobs.project_id
        JOIN users ON users.id = agent_jobs.user_id
        WHERE {where_sql}
        ORDER BY agent_jobs.id DESC
        LIMIT ? OFFSET ?
        """,
        [*params, page_size, (current_page - 1) * page_size],
    ).fetchall()
    jobs = []
    for row in rows:
        item = public_job(row)
        item.update({
            "project_name": row["project_name"],
            "project_status": row["project_status"],
            "project_deleted_at": row["project_deleted_at"],
            "requested_by_username": row["requested_by_username"],
            "duration_seconds": row["duration_seconds"],
        })
        jobs.append(item)
    return {
        "jobs": jobs,
        "pagination": {"page": current_page, "page_size": page_size, "total": total, "total_pages": total_pages},
    }


def retry_admin_job(conn: sqlite3.Connection, *, actor: sqlite3.Row, job_id: int) -> sqlite3.Row:
    source = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (job_id,)).fetchone()
    if not source:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent 任务不存在")
    if source["status"] not in {"failed", "canceled"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="只能重试失败或已取消的任务")
    project = conn.execute("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL", (source["project_id"],)).fetchone()
    if not project:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目已删除，无法重试")
    job = create_job(
        conn,
        project=project,
        user=actor,
        stage=source["stage"],
        target_stage=source["target_stage"],
        prompt=source["prompt"] or "",
        dry_run=bool(source["dry_run"]),
        input_origin="retry",
        retry_of_job_id=int(source["id"]),
    )
    record_audit(
        conn,
        actor=actor,
        action="agent_job.retry",
        target_type="agent_job",
        target_id=job["id"],
        target_label=f"#{job['id']}",
        project_id=int(source["project_id"]),
        details={"source_job_id": source["id"], "project_id": source["project_id"]},
    )
    return job


def cancel_admin_job(conn: sqlite3.Connection, *, actor: sqlite3.Row, job_id: int) -> dict:
    job = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (job_id,)).fetchone()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent 任务不存在")
    if job["status"] not in {"queued", "running"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Agent 任务已结束")
    cancel_job(conn, job_id)
    record_audit(
        conn,
        actor=actor,
        action="agent_job.cancel",
        target_type="agent_job",
        target_id=job_id,
        target_label=f"#{job_id}",
        project_id=int(job["project_id"]),
        severity="warning",
        details={"project_id": job["project_id"]},
    )
    updated = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (job_id,)).fetchone()
    return public_job(updated)


def _result_token_usage(raw: dict) -> dict[str, int] | None:
    model_usage = raw.get("modelUsage")
    if isinstance(model_usage, dict) and model_usage:
        rows = [value for value in model_usage.values() if isinstance(value, dict)]
        if rows:
            return {
                "input": sum(int(row.get("inputTokens") or 0) for row in rows),
                "cached_input": sum(int(row.get("cacheReadInputTokens") or 0) for row in rows),
                "cache_creation": sum(int(row.get("cacheCreationInputTokens") or 0) for row in rows),
                "output": sum(int(row.get("outputTokens") or 0) for row in rows),
            }
    usage = raw.get("usage")
    if not isinstance(usage, dict):
        return None
    return {
        "input": int(usage.get("input_tokens") or 0),
        "cached_input": int(usage.get("cache_read_input_tokens") or 0),
        "cache_creation": int(usage.get("cache_creation_input_tokens") or 0),
        "output": int(usage.get("output_tokens") or 0),
    }


def _nonnegative_float(value: object) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _result_usage_metrics(raw: dict) -> dict | None:
    usage = _result_token_usage(raw)
    if usage is None:
        return None
    cost_usd = _nonnegative_float(raw.get("total_cost_usd"))
    if cost_usd is None:
        model_usage = raw.get("modelUsage")
        if isinstance(model_usage, dict):
            recorded_costs = [
                cost
                for row in model_usage.values()
                if isinstance(row, dict)
                if (cost := _nonnegative_float(row.get("costUSD"))) is not None
            ]
            if recorded_costs:
                cost_usd = sum(recorded_costs)
    return {
        "usage": usage,
        "tokens": sum(usage.values()),
        "cost_usd": cost_usd,
    }


def _result_usage_metrics_from_log(path_value: str | None) -> dict | None:
    if not path_value:
        return None
    try:
        path = Path(path_value).resolve()
        path.relative_to(settings.data_dir.resolve())
        if not path.is_file():
            return None
        with path.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - 512 * 1024))
            tail = handle.read().decode("utf-8", errors="replace")
    except (OSError, ValueError):
        return None
    for line in reversed(tail.splitlines()):
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        if raw.get("type") == "result":
            return _result_usage_metrics(raw)
    return None


def _job_usage_metrics(conn: sqlite3.Connection, jobs: list[sqlite3.Row]) -> dict[int, dict]:
    """Load the final metering record without changing live task data.

    A finished CLI result is the closest available source of truth for token
    usage and billed cost. Older rows may only retain that result in zdebug.
    We deliberately do not invent a model price for records that lack it.
    """

    job_ids = [int(job["id"]) for job in jobs]
    metrics_by_job: dict[int, dict] = {}
    if job_ids:
        placeholders = ",".join("?" for _ in job_ids)
        events = conn.execute(
            f"""
            SELECT job_id, raw_json FROM agent_events
            WHERE job_id IN ({placeholders})
              AND event_type = 'result'
              AND raw_json IS NOT NULL
            ORDER BY job_id, seq DESC, id DESC
            """,
            job_ids,
        ).fetchall()
        for event in events:
            if int(event["job_id"]) in metrics_by_job:
                continue
            try:
                raw = json.loads(event["raw_json"])
            except (TypeError, json.JSONDecodeError):
                continue
            if raw.get("type") != "result":
                continue
            metrics = _result_usage_metrics(raw)
            if metrics is not None:
                metrics_by_job[int(event["job_id"])] = metrics

    for job in jobs:
        job_id = int(job["id"])
        persisted = metrics_by_job.get(job_id)
        if persisted and persisted["cost_usd"] is not None:
            continue
        archived = _result_usage_metrics_from_log(job["raw_log_path"])
        if archived is None:
            continue
        if persisted is None:
            metrics_by_job[job_id] = archived
        elif archived["cost_usd"] is not None:
            metrics_by_job[job_id] = {**persisted, "cost_usd": archived["cost_usd"]}
    return metrics_by_job


def _p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * 0.95) - 1)]


def _job_duration_seconds(job: sqlite3.Row) -> float | None:
    started = _parse_timestamp(job["started_at"])
    finished = _parse_timestamp(job["finished_at"])
    if not started or not finished or finished < started:
        return None
    return (finished - started).total_seconds()


def _successful_job_duration_seconds(job: sqlite3.Row) -> float | None:
    if job["status"] != "succeeded":
        return None
    return _job_duration_seconds(job)


def _local_day_start(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=SHANGHAI).astimezone(timezone.utc)


def _timestamp_in_window(value: str | None, start: datetime, end: datetime) -> bool:
    parsed = _parse_timestamp(value)
    return bool(parsed and start <= parsed < end)


def _dashboard_window(
    period: str,
    start_date: str | None,
    end_date: str | None,
    now: datetime,
) -> tuple[datetime, datetime]:
    custom = period == "custom" or start_date is not None or end_date is not None
    if custom:
        if not start_date or not end_date:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请选择完整的开始和结束日期")
        try:
            start_day = date.fromisoformat(start_date)
            end_day = date.fromisoformat(end_date)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="日期格式无效") from exc
        if start_day > end_day:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="开始日期不能晚于结束日期")
        if (end_day - start_day).days >= 366:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="时间区间不能超过一年")
        start = _local_day_start(start_day)
        end = _local_day_start(end_day + timedelta(days=1))
    else:
        local_now = now.astimezone(SHANGHAI)
        today = local_now.date()
        if period == "today":
            start = _local_day_start(today)
            end = now
        elif period == "yesterday":
            start = _local_day_start(today - timedelta(days=1))
            end = _local_day_start(today)
        elif period in PERIOD_DAYS:
            start = _local_day_start(today - timedelta(days=PERIOD_DAYS[period] - 1))
            end = now
        else:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="无效的时间范围")
    return start, end


def _trend_window(period: str, start: datetime, end: datetime, now: datetime) -> tuple[datetime, datetime]:
    local_now = now.astimezone(SHANGHAI)
    if period == "yesterday":
        end_day = local_now.date() - timedelta(days=1)
    else:
        end_day = (end - timedelta(microseconds=1)).astimezone(SHANGHAI).date()
    if period in {"today", "yesterday", "7d"}:
        start_day = end_day - timedelta(days=6)
    else:
        start_day = start.astimezone(SHANGHAI).date()
    return _local_day_start(start_day), _local_day_start(end_day + timedelta(days=1))


def _audit_details(row: sqlite3.Row) -> dict:
    try:
        details = json.loads(row["details_json"] or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return details if isinstance(details, dict) else {}


def _audit_stage(row: sqlite3.Row) -> str | None:
    stage = _audit_details(row).get("stage")
    if isinstance(stage, str) and stage in DASHBOARD_STAGES:
        return stage
    target_id = str(row["target_id"] or "")
    if ":" in target_id:
        candidate = target_id.rsplit(":", 1)[-1]
        if candidate in DASHBOARD_STAGES:
            return candidate
    return None


def _safe_progress(project: sqlite3.Row) -> tuple[dict, Path | None]:
    try:
        workspace = resolve_workspace(project["workspace_dir"])
        progress_path = workspace / "1.2-project-progress.json"
        progress = json.loads(progress_path.read_text(encoding="utf-8")) if progress_path.is_file() else {}
        return progress, workspace
    except (OSError, json.JSONDecodeError, HTTPException):
        return {}, None


def dashboard_data(
    conn: sqlite3.Connection,
    *,
    period: str = "30d",
    operator_user_id: int | None = None,
    task_type: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """Build the dashboard from existing operational records only.

    The selected user is an operator, not a project owner. Project creation is
    attributed to its audit actor, with the original owner as a legacy fallback.
    """

    now = datetime.now(timezone.utc)
    start, end = _dashboard_window(period, start_date, end_date, now)
    trend_start, trend_end = _trend_window(period, start, end, now)

    users = conn.execute(
        "SELECT * FROM users WHERE COALESCE(is_system, 0) = 0 ORDER BY created_at, id"
    ).fetchall()
    user_ids = {int(user["id"]) for user in users}
    if operator_user_id is not None and operator_user_id not in user_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="用户筛选条件无效")
    if task_type is not None and task_type not in TASK_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="场景筛选条件无效")
    selected_users = [user for user in users if operator_user_id is None or user["id"] == operator_user_id]
    dashboard_stages = (
        DASHBOARD_STAGES
        if task_type is None
        else ["project_init", *TASK_SCENARIOS[task_type]["stage_order"]]
    )
    agent_stages = [stage for stage in dashboard_stages if stage in AGENT_STAGES]

    projects = [
        project
        for project in conn.execute("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY id").fetchall()
        if task_type is None or row_task_type(project) == task_type
    ]
    project_ids = {int(project["id"]) for project in projects}
    jobs = [
        job for job in conn.execute("SELECT * FROM agent_jobs ORDER BY id").fetchall()
        if int(job["project_id"]) in project_ids
    ]
    changes = [
        row for row in conn.execute("SELECT * FROM artifact_changes ORDER BY id").fetchall()
        if int(row["project_id"]) in project_ids
    ]
    manual_edits = [
        row for row in conn.execute(
            "SELECT * FROM audit_logs WHERE action = 'document.edit' AND project_id IS NOT NULL ORDER BY id"
        ).fetchall()
        if int(row["project_id"]) in project_ids
    ]
    project_creators: dict[int, int] = {}
    for row in conn.execute(
        "SELECT project_id, actor_user_id FROM audit_logs WHERE action = 'project.create' AND project_id IS NOT NULL ORDER BY id"
    ).fetchall():
        if int(row["project_id"]) not in project_ids or row["actor_user_id"] is None:
            continue
        project_creators.setdefault(int(row["project_id"]), int(row["actor_user_id"]))

    def operator_matches(user_id: int | None) -> bool:
        return operator_user_id is None or user_id == operator_user_id

    def project_creator_id(project: sqlite3.Row) -> int:
        return project_creators.get(int(project["id"]), int(project["owner_user_id"]))

    created_projects = [
        project for project in projects
        if operator_matches(project_creator_id(project))
        and _timestamp_in_window(project["created_at"], start, end)
    ]
    operation_jobs = [
        job for job in jobs
        if operator_matches(int(job["user_id"]))
        and _timestamp_in_window(job["created_at"], start, end)
    ]
    usage_jobs = [
        job for job in jobs
        if operator_matches(int(job["user_id"]))
        and _timestamp_in_window(job["finished_at"] or job["updated_at"] or job["created_at"], start, end)
    ]
    period_changes = [
        row for row in changes
        if operator_matches(int(row["edited_by"]))
        and _timestamp_in_window(row["created_at"], start, end)
    ]
    period_manual_edits = [
        row for row in manual_edits
        if operator_matches(row["actor_user_id"])
        and _timestamp_in_window(row["created_at"], start, end)
    ]

    usage_by_job = _job_usage_metrics(conn, usage_jobs)
    jobs_by_project: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for job in jobs:
        jobs_by_project[int(job["project_id"])].append(job)

    def pipeline_durations_in(window_start: datetime, window_end: datetime) -> list[tuple[datetime, float]]:
        durations: list[tuple[datetime, float]] = []
        for project in projects:
            project_jobs = jobs_by_project[int(project["id"])]
            final_jobs = [
                (finished_at, job)
                for job in project_jobs
                if job["status"] == "succeeded"
                and (job["target_stage"] or job["stage"]) == "foreign_review"
                and operator_matches(int(job["user_id"]))
                if (finished_at := _parse_timestamp(job["finished_at"])) is not None
            ]
            if not final_jobs:
                continue
            completed_at, _final_job = max(final_jobs, key=lambda item: item[0])
            if not window_start <= completed_at < window_end:
                continue

            # A successful overseas review is the end of a screenplay run.
            # Failed and canceled rows often represent a timeout/recovery window,
            # not actual model execution, so they are deliberately excluded.
            duration = sum(
                value for job in project_jobs
                if _parse_timestamp(job["finished_at"])
                and _parse_timestamp(job["finished_at"]) <= completed_at
                if (value := _successful_job_duration_seconds(job)) is not None
            )
            durations.append((completed_at, duration))
        return durations

    pipeline_durations = pipeline_durations_in(start, end)

    operations: list[dict] = []
    for job in operation_jobs:
        stage = str(job["target_stage"] or job["stage"] or "")
        if stage not in dashboard_stages:
            continue
        kind = "conversation" if job["stage"] == "chat_edit" else "regenerate" if job["retry_of_job_id"] else "automatic"
        operations.append({
            "project_id": int(job["project_id"]),
            "user_id": int(job["user_id"]),
            "stage": stage,
            "kind": kind,
            "created_at": _parse_timestamp(job["created_at"]),
        })
    for row in period_manual_edits:
        stage = _audit_stage(row)
        if not stage or stage not in dashboard_stages or row["actor_user_id"] is None:
            continue
        operations.append({
            "project_id": int(row["project_id"]),
            "user_id": int(row["actor_user_id"]),
            "stage": stage,
            "kind": "manual_edit",
            "created_at": _parse_timestamp(row["created_at"]),
        })

    scope_project_ids = {
        int(project["id"]) for project in created_projects
    } | {
        int(job["project_id"]) for job in operation_jobs
    } | {
        int(job["project_id"]) for job in usage_jobs
    } | {
        int(row["project_id"]) for row in period_changes
    } | {
        int(row["project_id"]) for row in period_manual_edits
    }
    scoped_projects = [project for project in projects if int(project["id"]) in scope_project_ids]

    funnel = Counter({stage: 0 for stage in dashboard_stages})
    for project in scoped_projects:
        progress, workspace = _safe_progress(project)
        stage_progress = progress.get("stages") if isinstance(progress.get("stages"), dict) else {}
        for stage in dashboard_stages:
            status_value = stage_progress.get(stage, {}).get("status") if isinstance(stage_progress.get(stage), dict) else None
            exists = bool(workspace and (workspace / stage_file_for_workspace(workspace, stage)).is_file())
            if exists and status_value not in {"pending", "queued", "running", "in_progress"}:
                funnel[stage] += 1

    stage_operation_counts = Counter(operation["stage"] for operation in operations)
    stage_operation_breakdown = Counter((operation["stage"], operation["kind"]) for operation in operations)

    stage_metrics: list[dict] = []
    for stage in agent_stages:
        stage_jobs = [job for job in usage_jobs if (job["target_stage"] or job["stage"]) == stage]
        durations = [value for job in stage_jobs if (value := _successful_job_duration_seconds(job)) is not None]
        metering = [usage_by_job[int(job["id"])] for job in stage_jobs if int(job["id"]) in usage_by_job]
        token_values = [float(item["tokens"]) for item in metering]
        cost_values = [float(item["cost_usd"]) for item in metering if item["cost_usd"] is not None]
        stage_metrics.append({
            "key": stage,
            "job_count": len(stage_jobs),
            "metered_job_count": len(token_values),
            "costed_job_count": len(cost_values),
            "total_tokens": int(sum(token_values)),
            "p95_tokens": round(_p95(token_values) or 0),
            "total_cost_usd": round(sum(cost_values), 6),
            "p95_cost_usd": round(_p95(cost_values) or 0, 6),
            "total_duration_seconds": round(sum(durations), 1),
            "p95_duration_seconds": round(_p95(durations) or 0, 1),
        })

    all_token_values = [float(item["tokens"]) for item in usage_by_job.values()]
    total_tokens = int(sum(all_token_values))
    cost_values = [float(item["cost_usd"]) for item in usage_by_job.values() if item["cost_usd"] is not None]
    total_cost = round(sum(cost_values), 6)
    stage_usage_jobs = [job for job in usage_jobs if (job["target_stage"] or job["stage"]) in agent_stages]
    stage_metering = [usage_by_job[int(job["id"])] for job in stage_usage_jobs if int(job["id"]) in usage_by_job]
    stage_token_values = [float(item["tokens"]) for item in stage_metering]
    stage_cost_values = [float(item["cost_usd"]) for item in stage_metering if item["cost_usd"] is not None]
    duration_values = [
        value for job in stage_usage_jobs
        if (value := _successful_job_duration_seconds(job)) is not None
    ]

    trend_changes = [
        row for row in changes
        if operator_matches(int(row["edited_by"]))
        and _timestamp_in_window(row["created_at"], trend_start, trend_end)
    ]
    trend_created_projects = [
        project for project in projects
        if operator_matches(project_creator_id(project))
        and _timestamp_in_window(project["created_at"], trend_start, trend_end)
    ]
    trend_jobs = [
        job for job in jobs
        if operator_matches(int(job["user_id"]))
        and _timestamp_in_window(job["created_at"], trend_start, trend_end)
    ]
    trend_manual_edits = [
        row for row in manual_edits
        if operator_matches(row["actor_user_id"])
        and _timestamp_in_window(row["created_at"], trend_start, trend_end)
    ]
    trend_usage_jobs = [
        job for job in jobs
        if operator_matches(int(job["user_id"]))
        and _timestamp_in_window(job["finished_at"] or job["updated_at"] or job["created_at"], trend_start, trend_end)
    ]
    trend_usage_by_job = _job_usage_metrics(conn, trend_usage_jobs)
    scripts_by_day: dict[str, set[int]] = defaultdict(set)
    writers_by_day: dict[str, set[int]] = defaultdict(set)
    tokens_by_day: Counter[str] = Counter()
    cost_by_day: Counter[str] = Counter()
    duration_by_day: dict[str, list[float]] = defaultdict(list)
    for project in trend_created_projects:
        timestamp = _parse_timestamp(project["created_at"])
        if timestamp:
            key = timestamp.astimezone(SHANGHAI).date().isoformat()
            scripts_by_day[key].add(int(project["id"]))
            writers_by_day[key].add(project_creator_id(project))
    for row in trend_changes:
        timestamp = _parse_timestamp(row["created_at"])
        if timestamp:
            scripts_by_day[timestamp.astimezone(SHANGHAI).date().isoformat()].add(int(row["project_id"]))
            writers_by_day[timestamp.astimezone(SHANGHAI).date().isoformat()].add(int(row["edited_by"]))
    for job in trend_jobs:
        timestamp = _parse_timestamp(job["created_at"])
        if timestamp:
            key = timestamp.astimezone(SHANGHAI).date().isoformat()
            scripts_by_day[key].add(int(job["project_id"]))
            writers_by_day[key].add(int(job["user_id"]))
    for row in trend_manual_edits:
        timestamp = _parse_timestamp(row["created_at"])
        if timestamp:
            key = timestamp.astimezone(SHANGHAI).date().isoformat()
            scripts_by_day[key].add(int(row["project_id"]))
            if row["actor_user_id"] is not None:
                writers_by_day[key].add(int(row["actor_user_id"]))
    for job in trend_usage_jobs:
        timestamp = _parse_timestamp(job["finished_at"] or job["updated_at"] or job["created_at"])
        if not timestamp:
            continue
        key = timestamp.astimezone(SHANGHAI).date().isoformat()
        metrics = trend_usage_by_job.get(int(job["id"]))
        if metrics:
            tokens_by_day[key] += int(metrics["tokens"])
            if metrics["cost_usd"] is not None:
                cost_by_day[key] += float(metrics["cost_usd"])
    for completed_at, duration in pipeline_durations_in(trend_start, trend_end):
        key = completed_at.astimezone(SHANGHAI).date().isoformat()
        duration_by_day[key].append(duration)

    preferences = conn.execute(
        "SELECT * FROM writer_preferences WHERE enabled = 1 ORDER BY created_at, id"
    ).fetchall()
    preferences = [
        preference for preference in preferences
        if operator_matches(int(preference["user_id"]))
    ]
    preference_created_by_day: Counter[str] = Counter()
    for preference in preferences:
        created_at = _parse_timestamp(preference["created_at"])
        if created_at:
            preference_created_by_day[created_at.astimezone(SHANGHAI).date().isoformat()] += 1

    trend: list[dict] = []
    preference_running_total = sum(
        count for day, count in preference_created_by_day.items()
        if day < trend_start.astimezone(SHANGHAI).date().isoformat()
    )
    cursor = trend_start.astimezone(SHANGHAI).date()
    trend_last_day = (trend_end - timedelta(microseconds=1)).astimezone(SHANGHAI).date()
    while cursor <= trend_last_day:
        key = cursor.isoformat()
        preference_running_total += preference_created_by_day[key]
        trend.append({
            "date": key,
            "label": cursor.strftime("%m-%d"),
            "scripts": len(scripts_by_day[key]),
            "writers": len(writers_by_day[key]),
            "preferences": preference_running_total,
            "script_duration_p95_seconds": round(_p95(duration_by_day[key]) or 0, 1),
            "tokens": int(tokens_by_day[key]),
            "cost_usd": round(cost_by_day[key], 6),
        })
        cursor += timedelta(days=1)

    people_project_ids: dict[int, set[int]] = defaultdict(set)
    people_operation_counts: Counter[int] = Counter()
    for project in created_projects:
        people_project_ids[project_creator_id(project)].add(int(project["id"]))
    for row in period_changes:
        people_project_ids[int(row["edited_by"])].add(int(row["project_id"]))
    for operation in operations:
        people_project_ids[int(operation["user_id"])].add(int(operation["project_id"]))
        people_operation_counts[int(operation["user_id"])] += 1
    for job in usage_jobs:
        people_project_ids[int(job["user_id"])].add(int(job["project_id"]))
    people_tokens: Counter[int] = Counter()
    people_costs: Counter[int] = Counter()
    for job in usage_jobs:
        metrics = usage_by_job.get(int(job["id"]))
        if not metrics:
            continue
        user_id = int(job["user_id"])
        people_tokens[user_id] += int(metrics["tokens"])
        if metrics["cost_usd"] is not None:
            people_costs[user_id] += float(metrics["cost_usd"])
    people = [
        {
            "id": int(user["id"]),
            "name": user["display_name"],
            "username": user["username"],
            "task_count": len(people_project_ids[int(user["id"])]),
            "operation_count": int(people_operation_counts[int(user["id"])]),
            "tokens": int(people_tokens[int(user["id"])]),
            "cost_usd": round(people_costs[int(user["id"])], 6),
        }
        for user in selected_users
    ]
    people.sort(key=lambda item: (item["operation_count"], item["tokens"], item["task_count"]), reverse=True)

    return {
        "generated_at": now.isoformat(),
        "filters": {
            "period": "custom" if start_date or end_date else period,
            "timezone": "Asia/Shanghai",
            "operator_user_id": operator_user_id,
            "task_type": task_type,
            "start_date": start.astimezone(SHANGHAI).date().isoformat(),
            "end_date": (end - timedelta(microseconds=1)).astimezone(SHANGHAI).date().isoformat(),
            "trend_start_date": trend_start.astimezone(SHANGHAI).date().isoformat(),
            "trend_end_date": (trend_end - timedelta(microseconds=1)).astimezone(SHANGHAI).date().isoformat(),
        },
        "summary": {
            "scripts_total": len(created_projects),
            "writers_total": len(selected_users),
            "preferences_total": len(preferences),
            "script_duration_p95_seconds": round(_p95([duration for _completed_at, duration in pipeline_durations]) or 0, 1),
            "completed_pipeline_count": len(pipeline_durations),
            "tokens_total": total_tokens,
            "cost_usd_total": total_cost,
            "metered_job_count": len(usage_by_job),
            "costed_job_count": len(cost_values),
        },
        "trend": trend,
        "execution": {
            "aggregate": {
                "total_tokens": int(sum(stage_token_values)),
                "p95_tokens": int(sum(metric["p95_tokens"] for metric in stage_metrics)),
                "total_cost_usd": round(sum(stage_cost_values), 6),
                "p95_cost_usd": round(sum(metric["p95_cost_usd"] for metric in stage_metrics), 6),
                "total_duration_seconds": round(sum(duration_values), 1),
                "p95_duration_seconds": round(sum(metric["p95_duration_seconds"] for metric in stage_metrics), 1),
            },
            "stage_metrics": stage_metrics,
            "funnel": [{"key": stage, "value": funnel[stage]} for stage in dashboard_stages],
            "operations": {
                "total": len(operations),
                "by_stage": [{"key": stage, "value": stage_operation_counts[stage]} for stage in dashboard_stages],
                "by_stage_kind": [
                    {"stage": stage, "key": kind, "value": stage_operation_breakdown[(stage, kind)]}
                    for stage in dashboard_stages
                    for kind in ("automatic", "manual_edit", "conversation", "regenerate")
                ],
            },
        },
        "people": people,
    }


def list_audit_logs(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    action: str | None = None,
    project_id: int | None = None,
    outcome: str | None = None,
    source: str | None = None,
    page: int = 1,
    page_size: int = 30,
) -> dict:
    where = ["1 = 1"]
    params: list[object] = []
    if query:
        where.append("(actor_username LIKE ? OR target_label LIKE ? OR target_id LIKE ? OR CAST(project_id AS TEXT) LIKE ?)")
        value = f"%{query.strip()}%"
        params.extend([value, value, value, value])
    if action:
        where.append("action = ?")
        params.append(action)
    if project_id is not None:
        where.append("project_id = ?")
        params.append(project_id)
    if outcome:
        where.append("outcome = ?")
        params.append(outcome)
    if source:
        where.append("source = ?")
        params.append(source)
    where_sql = " AND ".join(where)
    total = conn.execute(f"SELECT COUNT(*) FROM audit_logs WHERE {where_sql}", params).fetchone()[0]
    total_pages = max(1, math.ceil(total / page_size))
    current_page = min(page, total_pages)
    rows = conn.execute(
        f"""
        SELECT * FROM audit_logs WHERE {where_sql}
        ORDER BY id DESC LIMIT ? OFFSET ?
        """,
        [*params, page_size, (current_page - 1) * page_size],
    ).fetchall()
    return {
        "logs": [audit_row_to_public(row) for row in rows],
        "pagination": {"page": current_page, "page_size": page_size, "total": total, "total_pages": total_pages},
    }
