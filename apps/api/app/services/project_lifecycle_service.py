from __future__ import annotations

import json
import hashlib
import logging
import sqlite3
import unicodedata
from datetime import datetime, timezone

from fastapi import HTTPException, status

from app.services.agent_runner import active_job_for_project
from app.services.audit_service import record_audit
from app.services.memory_sync_service import get_memory_status
from app.services.preference_summary_service import (
    cancel_preference_summaries_for_reopened_project,
    queue_preference_summary,
)
from app.services.script_library_service import create_archived_project_script
from app.services.workspace_service import (
    TASK_TYPE_HUMANIZE,
    TASK_TYPE_NOVEL,
    TASK_TYPE_REPLICATE,
    TASK_TYPE_REWRITE,
    TASK_TYPE_TRANSLATE,
    load_progress,
    project_row_to_public,
    resolve_workspace,
    review_scorecard_file_for_workspace,
    row_task_type,
    stage_file_for_workspace,
)


PROJECT_STATUS_ACTIVE = "active"
PROJECT_STATUS_COMPLETED = "completed"
DISTILLATION_TASK_TYPES = frozenset({TASK_TYPE_REWRITE, TASK_TYPE_NOVEL, TASK_TYPE_REPLICATE})
# The review contract can emit S+, which is also above A even though the
# product shorthand usually lists A, A+, S and SS.
DISTILLATION_REVIEW_RATINGS = frozenset({"A", "A+", "S", "S+", "SS"})
logger = logging.getLogger(__name__)


def row_project_status(project: sqlite3.Row) -> str:
    return project["status"] if "status" in project.keys() and project["status"] else PROJECT_STATUS_ACTIVE


def ensure_project_editable(project: sqlite3.Row) -> None:
    if row_project_status(project) == PROJECT_STATUS_COMPLETED:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目已归档，请先重新开启")


def _artifact_hash(workspace, stage: str) -> tuple[str, object]:
    artifact_path = workspace / stage_file_for_workspace(workspace, stage)
    if not artifact_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="审稿报告尚未生成")
    return hashlib.sha256(artifact_path.read_bytes()).hexdigest(), artifact_path


def _record_archived_stage(workspace, stage: str, actor: str) -> None:
    """Keep the workspace progress record aligned with the archived project."""
    progress_path = workspace / "1.2-project-progress.json"
    try:
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        stages = progress.get("stages") if isinstance(progress.get("stages"), dict) else {}
        stage_progress = stages.get(stage) if isinstance(stages.get(stage), dict) else {}
        stage_status = str(stage_progress.get("status") or "completed")
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        progress["current_skill"] = stage
        progress["next_skill"] = ""
        progress["status"] = f"{stage}:{stage_status}"
        progress["audit"] = {**(progress.get("audit") if isinstance(progress.get("audit"), dict) else {}), "updated_at": now, "updated_by": actor}
        progress_path.write_text(f"{json.dumps(progress, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("项目归档后无法同步进度记录：stage=%s, error=%s", stage, exc)


def _read_json_object(path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _review_rating(scorecard: dict) -> str:
    conclusion = scorecard.get("总体结论") if isinstance(scorecard.get("总体结论"), dict) else {}
    value = conclusion.get("评级") or conclusion.get("等级") or ""
    return unicodedata.normalize("NFKC", str(value)).strip().upper().replace(" ", "")


def _archived_script_title(workspace, project: sqlite3.Row, scorecard: dict) -> str:
    outline = _read_json_object(workspace / "3.1-outline.json")
    script_info = scorecard.get("剧本信息") if isinstance(scorecard.get("剧本信息"), dict) else {}
    for value in (outline.get("剧本名称"), script_info.get("剧本名称"), project["name"]):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return str(project["name"])


def _queue_archived_script_distillation(
    conn: sqlite3.Connection,
    *,
    project: sqlite3.Row,
    actor: sqlite3.Row,
    workspace,
) -> dict:
    task_type = row_task_type(project)
    if task_type not in DISTILLATION_TASK_TYPES:
        return {"status": "not_applicable", "task_type": task_type}

    scorecard = _read_json_object(workspace / review_scorecard_file_for_workspace(workspace))
    rating = _review_rating(scorecard)
    if rating not in DISTILLATION_REVIEW_RATINGS:
        return {"status": "rating_not_eligible", "task_type": task_type, "rating": rating}

    full_script_path = workspace / stage_file_for_workspace(workspace, "full_generate")
    if not full_script_path.is_file():
        raise RuntimeError(f"未找到完整剧本：{full_script_path}")
    result = create_archived_project_script(
        conn,
        actor=actor,
        project_id=int(project["id"]),
        project_name=str(project["name"]),
        title=_archived_script_title(workspace, project, scorecard),
        filename=full_script_path.name,
        text=full_script_path.read_text(encoding="utf-8"),
    )
    return {
        "status": str(result["queue_status"]),
        "task_type": task_type,
        "rating": rating,
        "script_id": int(result["script"]["id"]),
        "job_id": result["job_id"],
    }


def archive_project(
    conn: sqlite3.Connection,
    *,
    project: sqlite3.Row,
    actor: sqlite3.Row,
    expected_hash: str | None = None,
    job_id: int | None = None,
) -> dict:
    if row_project_status(project) == PROJECT_STATUS_COMPLETED:
        return project_row_to_public(project)
    running = active_job_for_project(conn, project["id"])
    if running:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Agent 任务运行中，暂时不能归档")

    task_type = row_task_type(project)
    stage = (
        "dialogue_translate" if task_type == TASK_TYPE_TRANSLATE
        else "humanizer_zh" if task_type == TASK_TYPE_HUMANIZE
        else "foreign_review"
    )
    workspace = resolve_workspace(project["workspace_dir"])
    artifact_hash, _artifact_path = _artifact_hash(workspace, stage)
    if expected_hash and expected_hash != artifact_hash:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="审稿报告已变化，请刷新后重新归档")

    progress = load_progress(project["workspace_dir"])
    stage_status = progress.get("stages", {}).get(stage, {}).get("status")
    allowed_statuses = {"completed", "approved"} if stage in {"dialogue_translate", "humanizer_zh"} else {"approved"}
    if stage_status not in allowed_statuses:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "请先完成当前交付文件后再归档"
                if stage in {"dialogue_translate", "humanizer_zh"}
                else "请先确认通过的审稿报告后再归档"
            ),
        )

    conn.execute(
        """
        UPDATE projects
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
            completed_by = ?, current_stage = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (actor["id"], stage, project["id"]),
    )
    _record_archived_stage(workspace, stage, str(actor["username"]))
    preference_summary_queued = False
    try:
        queue_preference_summary(conn, project_id=int(project["id"]), user_id=int(actor["id"]))
        preference_summary_queued = True
    except sqlite3.Error as exc:
        # Preference learning is deliberately best-effort: a queue issue must
        # never prevent the user from finishing an already approved project.
        logger.warning("项目归档后的偏好复盘任务入队失败：project_id=%s, error=%s", project["id"], exc)
    conn.execute("SAVEPOINT archive_distillation_queue")
    try:
        distillation = _queue_archived_script_distillation(
            conn,
            project=project,
            actor=actor,
            workspace=workspace,
        )
        conn.execute("RELEASE SAVEPOINT archive_distillation_queue")
    except Exception as exc:
        conn.execute("ROLLBACK TO SAVEPOINT archive_distillation_queue")
        conn.execute("RELEASE SAVEPOINT archive_distillation_queue")
        message = str(exc).strip() or "剧本蒸馏任务入队失败"
        distillation = {"status": "queue_failed", "message": message}
        logger.exception("项目归档后剧本蒸馏任务入队失败：project_id=%s", project["id"])
        record_audit(
            conn,
            actor=actor,
            action="script_library.project_archive.enqueue",
            target_type="project",
            target_id=project["id"],
            target_label=project["name"],
            project_id=int(project["id"]),
            outcome="failure",
            severity="warning",
            details={"message": message},
        )
    record_audit(
        conn,
        actor=actor,
        action="project.archive",
        target_type="project",
        target_id=project["id"],
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "artifact_hash": artifact_hash,
            "stage": stage,
            "quality_contract_version": "agents-new-v1",
            "preference_summary_queued": preference_summary_queued,
            "script_distillation": distillation,
        },
    )
    updated = conn.execute("SELECT * FROM projects WHERE id = ?", (project["id"],)).fetchone()
    return project_row_to_public(updated)


def reopen_project(conn: sqlite3.Connection, *, project: sqlite3.Row, actor: sqlite3.Row) -> dict:
    if row_project_status(project) == PROJECT_STATUS_ACTIVE:
        return project_row_to_public(project)
    completed_at = project["completed_at"] if "completed_at" in project.keys() else None
    conn.execute(
        """
        UPDATE projects
        SET status = 'active', completed_at = NULL, completed_by = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (project["id"],),
    )
    canceled_summary_count = cancel_preference_summaries_for_reopened_project(
        conn,
        project_id=int(project["id"]),
    )
    record_audit(
        conn,
        actor=actor,
        action="project.reopen",
        target_type="project",
        target_id=project["id"],
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "previous_completed_at": completed_at,
            "canceled_preference_summary_count": canceled_summary_count,
        },
    )
    updated = conn.execute("SELECT * FROM projects WHERE id = ?", (project["id"],)).fetchone()
    result = project_row_to_public(updated)
    result["memory"] = get_memory_status(resolve_workspace(project["workspace_dir"]))
    return result
