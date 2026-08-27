from __future__ import annotations

import hashlib
import sqlite3
from urllib.parse import quote
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from app.core.errors import stage_file_missing_error, unknown_stage_error
from app.db.session import get_db
from app.dependencies import current_user
from app.services.agent_runner import active_job_for_project, create_job, run_agent_job
from app.services.audit_service import content_fingerprint, record_audit
from app.services.credit_service import (
    ensure_concurrent_job_capacity,
    ensure_sufficient_credits,
    quote_for_stages,
)
from app.services.document_comment_service import (
    add_document_comment_reply,
    create_document_comment,
    delete_document_comment_message,
    list_document_comments,
)
from app.services.agent_evolution_service import list_evolution_reviews
from app.services.memory_sync_service import get_memory_status
from app.services.project_trash_service import (
    ProjectPurgeError,
    get_trashed_project_or_404,
    list_trashed_projects,
    move_project_to_trash,
    purge_project,
    restore_project,
)
from app.services.project_lifecycle_service import (
    PROJECT_STATUS_COMPLETED,
    archive_project,
    ensure_project_editable,
    reopen_project,
    row_project_status,
)
from app.services.role_service import require_scenario_permission
from app.services.script_tag_service import TAG_FIELDS, tag_taxonomy
from app.services.workspace_service import (
    STAGE_FILES,
    TASK_TYPE_HUMANIZE,
    TASK_TYPE_NOVEL,
    TASK_TYPE_REVIEW,
    TASK_TYPE_TRANSLATE,
    DEFAULT_MATURITY_TARGET,
    approve_new_stage,
    create_project_from_upload,
    dialogue_script_delivery_for_project,
    distribution_brief_for_project,
    files_for_project,
    full_script_delivery_for_project,
    get_project_or_404,
    initialization_for_project,
    list_file_versions,
    list_target_regions,
    list_projects,
    list_project_members,
    project_row_to_public,
    read_file_version,
    read_stage_file,
    rename_project_script_title,
    remove_project_member_permission,
    normalize_task_type,
    reinitialize_project,
    resolve_workspace,
    restore_file_version,
    set_project_member_permission_by_username,
    source_attachment_for_project,
    stage_file_for_workspace,
    stage_delivery_in_progress,
    trial_script_delivery_for_project,
    update_distribution_brief,
    update_project_member_permission,
    write_stage_file,
)

router = APIRouter(prefix="/projects", tags=["projects"])

MaturityTarget = Literal[
    "全年龄段影片，适合所有人",
    "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
    "R限制级影片，允许大量血腥暴力、性爱画面、持续粗口、毒品描写",
    "NC-17 ，成人级影片，允许露骨性爱、极端血腥",
]


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    pinned: Optional[bool] = None


class FileUpdate(BaseModel):
    content: str
    expected_hash: Optional[str] = None


class DocumentCommentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    anchor_start: int = Field(ge=0)
    anchor_end: int = Field(ge=0)
    anchor_text: str = Field(min_length=1, max_length=4000)
    anchor_prefix: str = Field(default="", max_length=240)
    anchor_suffix: str = Field(default="", max_length=240)
    preview_start: int | None = Field(default=None, ge=0)
    preview_end: int | None = Field(default=None, ge=0)
    content: str = Field(min_length=1, max_length=4000)


class DocumentCommentReply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=4000)


class OutlineTitleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=80)
    english_title: Optional[str] = Field(default=None, max_length=80)
    expected_hash: str = Field(min_length=64, max_length=64)


class FileVersionRestore(BaseModel):
    expected_hash: str = Field(min_length=64, max_length=64)


class ArtifactDownloadAudit(BaseModel):
    format: Literal["markdown", "docx", "pdf", "delivery_docx"]


class StageApproval(BaseModel):
    expected_hash: Optional[str] = None
    job_id: Optional[int] = None


class ProjectArchive(BaseModel):
    expected_hash: Optional[str] = None
    job_id: Optional[int] = None


class ProjectMemberPermissionUpdate(BaseModel):
    permission: Literal["view", "edit"]


class ProjectMemberPermissionCreate(ProjectMemberPermissionUpdate):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=2, max_length=40)


class DistributionBriefUpdate(BaseModel):
    episode_duration: Optional[str] = Field(default=None, max_length=100)
    target_episode_count: Optional[int] = None
    maturity_target: Optional[MaturityTarget] = None
    theme: Optional[list[str]] = None
    setting: Optional[list[str]] = None
    background: Optional[list[str]] = None
    audience: Optional[list[str]] = None
    confirmed: bool = False
    expected_hash: Optional[str] = None


class ProjectReinitialize(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_name: Optional[str] = Field(default=None, max_length=200)
    target_region: Optional[str] = Field(default=None, max_length=40)
    extra_requirements: Optional[str] = Field(default=None, max_length=20000)
    episode_duration: Optional[str] = Field(default=None, max_length=100)
    target_episode_count: Optional[int] = Field(default=None, ge=1, le=1000)
    maturity_target: Optional[MaturityTarget] = None
    theme: Optional[list[str]] = None
    setting: Optional[list[str]] = None
    background: Optional[list[str]] = None
    audience: Optional[list[str]] = None
    expected_hash: str = Field(min_length=64, max_length=64)


def _brief_audit_snapshot(snapshot: dict) -> dict:
    brief = snapshot.get("brief") if isinstance(snapshot.get("brief"), dict) else {}
    result = {
        key: brief.get(key)
        for key in (
            "status",
            "target_countries",
            "target_locale",
            "market_deliverables",
            "episode_duration",
            "target_episode_count",
            "maturity_target",
            *TAG_FIELDS,
        )
        if key in brief
    }
    result["extra_requirements"] = content_fingerprint(str(snapshot.get("extra_requirements") or ""))
    result["content_hash"] = snapshot.get("content_hash")
    result["target_region"] = snapshot.get("target_region")
    return result


def _initialization_audit_snapshot(initialization: dict) -> dict:
    source = initialization.get("source") if isinstance(initialization.get("source"), dict) else {}
    brief = initialization.get("brief") if isinstance(initialization.get("brief"), dict) else {}
    return {
        "project_name": initialization.get("project_name"),
        "target_region": initialization.get("target_region"),
        "task_type": initialization.get("task_type"),
        "config_hash": initialization.get("config_hash"),
        "source_sha256": source.get("sha256"),
        "extra_requirements": content_fingerprint(str(initialization.get("extra_requirements") or "")),
        "script_profile": {field: brief.get(field) for field in TAG_FIELDS if field in brief},
    }


def _approved_stage_snapshots(conn: sqlite3.Connection, project_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT stage, artifact_hash, quality_contract_version, memory_revision, job_id
        FROM stage_approvals WHERE project_id = ? ORDER BY id
        """,
        (project_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _record_artifact_download(
    conn: sqlite3.Connection,
    *,
    project: sqlite3.Row,
    user: sqlite3.Row,
    stage: str,
    export_format: str,
) -> None:
    workspace = resolve_workspace(project["workspace_dir"])
    file_path = workspace / stage_file_for_workspace(workspace, stage)
    if not file_path.exists():
        raise stage_file_missing_error(stage)
    record_audit(
        conn,
        actor=user,
        action="artifact.download",
        target_type="project_document",
        target_id=f"{project['id']}:{stage}",
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "stage": stage,
            "format": export_format,
            "file_name": file_path.name,
            "content_sha256": hashlib.sha256(file_path.read_bytes()).hexdigest(),
        },
    )


@router.get("")
def get_projects(
    query: Optional[str] = None,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    return {"projects": list_projects(conn, user, query)}


@router.post("")
def create_project(
    background_tasks: BackgroundTasks,
    project_name: str = Form(...),
    target_region: str = Form(...),
    episode_duration: str = Form(""),
    target_episode_count: Optional[int] = Form(None),
    maturity_target: MaturityTarget = Form(DEFAULT_MATURITY_TARGET),
    theme: str = Form(""),
    setting: str = Form(""),
    background: str = Form(""),
    audience: str = Form(""),
    extra_requirements: str = Form(""),
    task_type: str = Form("rewrite"),
    source_file: UploadFile = File(...),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    task_type = normalize_task_type(task_type)
    require_scenario_permission(conn, user, task_type)
    if task_type in {TASK_TYPE_REVIEW, TASK_TYPE_TRANSLATE, TASK_TYPE_HUMANIZE, TASK_TYPE_NOVEL}:
        ensure_concurrent_job_capacity(conn, user_id=int(user["id"]))
        initial_stage = (
            "foreign_review" if task_type == TASK_TYPE_REVIEW
            else "dialogue_translate" if task_type == TASK_TYPE_TRANSLATE
            else "humanizer_zh"
            if task_type == TASK_TYPE_HUMANIZE
            else "novel_analysis"
        )
        quote = quote_for_stages(conn, [initial_stage])
        ensure_sufficient_credits(conn, user_id=int(user["id"]), amount=int(quote["credits"]))
    optional_brief = {
        field: value
        for field, value in {
            "episode_duration": episode_duration,
            "target_episode_count": target_episode_count,
            "maturity_target": maturity_target,
            "theme": theme,
            "setting": setting,
            "background": background,
            "audience": audience,
        }.items()
        if value not in (None, "")
    }
    project = create_project_from_upload(
        conn,
        user=user,
        project_name=project_name,
        target_region=target_region,
        distribution_brief=optional_brief,
        extra_requirements=extra_requirements,
        task_type=task_type,
        upload=source_file,
    )
    source_name = (source_file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    record_audit(
        conn,
        actor=user,
        action="project.create",
        target_type="project",
        target_id=project["id"],
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "task_type": project["task_type"],
            "target_region": project.get("target_region") or target_region,
            "source_file": {"name": source_name, "content_type": source_file.content_type},
            "distribution_brief_fields": sorted(optional_brief),
            "extra_requirements": content_fingerprint(extra_requirements),
        },
    )
    if project["task_type"] in {TASK_TYPE_REVIEW, TASK_TYPE_TRANSLATE, TASK_TYPE_HUMANIZE, TASK_TYPE_NOVEL}:
        row = get_project_or_404(conn, project["id"], user)
        workspace = resolve_workspace(row["workspace_dir"])
        start_stage = (
            "foreign_review" if project["task_type"] == TASK_TYPE_REVIEW
            else "dialogue_translate" if project["task_type"] == TASK_TYPE_TRANSLATE
            else "humanizer_zh"
            if project["task_type"] == TASK_TYPE_HUMANIZE
            else "novel_analysis"
        )
        report_path = workspace / stage_file_for_workspace(workspace, start_stage)
        brief = distribution_brief_for_project(row)["brief"]
        if brief.get("status") == "complete" and not report_path.exists() and not active_job_for_project(conn, row["id"]):
            job = create_job(
                conn,
                project=row,
                user=user,
                stage=start_stage,
                prompt=extra_requirements,
            )
            conn.commit()
            background_tasks.add_task(run_agent_job, job["id"])
    return {"project": project}


@router.get("/regions")
def get_target_regions(user=Depends(current_user)) -> dict:
    return {"regions": list_target_regions()}


@router.get("/script-tags")
def get_script_tags(user=Depends(current_user)) -> dict:
    return {"taxonomy": tag_taxonomy()}


@router.get("/trash")
def get_project_trash(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=50),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    return list_trashed_projects(conn, user, page=page, page_size=page_size)


@router.get("/{project_id}/distribution-brief")
def get_project_distribution_brief(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"distribution_brief": distribution_brief_for_project(project)}


@router.get("/{project_id}/initialization")
def get_project_initialization(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"initialization": initialization_for_project(project)}


@router.post("/{project_id}/reinitialize")
def post_project_reinitialize(
    project_id: int,
    payload: ProjectReinitialize,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    ensure_project_editable(project)
    if active_job_for_project(conn, project_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Agent 任务运行中，不能重新初始化")
    before_initialization = initialization_for_project(project)
    invalidated_approvals = _approved_stage_snapshots(conn, project_id)
    values = payload.model_dump(exclude={"expected_hash"}, exclude_unset=True)
    result = reinitialize_project(
        conn,
        project,
        user,
        values,
        expected_hash=payload.expected_hash,
    )
    record_audit(
        conn,
        actor=user,
        action="project.reinitialize",
        target_type="project",
        target_id=project_id,
        target_label=result["initialization"]["project_name"],
        project_id=project_id,
        details={
            "before": _initialization_audit_snapshot(before_initialization),
            "after": _initialization_audit_snapshot(result["initialization"]),
            "invalidated_stages": result["invalidated_stages"],
        },
    )
    if invalidated_approvals:
        record_audit(
            conn,
            actor=user,
            action="stage.approval.invalidate",
            target_type="project",
            target_id=project_id,
            target_label=result["initialization"]["project_name"],
            project_id=project_id,
            details={"reason": "project.reinitialize", "approvals": invalidated_approvals},
        )
    return result


@router.put("/{project_id}/distribution-brief")
def put_project_distribution_brief(
    project_id: int,
    payload: DistributionBriefUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    ensure_project_editable(project)
    if active_job_for_project(conn, project_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Agent 任务运行中，不能修改发行任务书")
    before_brief = distribution_brief_for_project(project)
    invalidated_approvals = _approved_stage_snapshots(conn, project_id)
    values = payload.model_dump(exclude={"confirmed", "expected_hash"}, exclude_none=True)
    result = update_distribution_brief(
        conn,
        project,
        user,
        values,
        confirmed=payload.confirmed,
        expected_hash=payload.expected_hash,
    )
    if result.get("changed"):
        record_audit(
            conn,
            actor=user,
            action="project.distribution_brief.update",
            target_type="project",
            target_id=project_id,
            target_label=project["name"],
            project_id=project_id,
            details={
                "before": _brief_audit_snapshot(before_brief),
                "after": _brief_audit_snapshot(result),
                "confirmed": payload.confirmed,
                "invalidated_stages": result["invalidated_stages"],
            },
        )
        if invalidated_approvals:
            record_audit(
                conn,
                actor=user,
                action="stage.approval.invalidate",
                target_type="project",
                target_id=project_id,
                target_label=project["name"],
                project_id=project_id,
                details={"reason": "project.distribution_brief.update", "approvals": invalidated_approvals},
            )
    return {"distribution_brief": result}


@router.post("/trash/{project_id}/restore")
def restore_trashed_project(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_trashed_project_or_404(conn, project_id, user)
    try:
        restored = restore_project(conn, project)
    except ProjectPurgeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    record_audit(
        conn,
        actor=user,
        action="project.restore",
        target_type="project",
        target_id=project_id,
        target_label=project["name"],
        project_id=project_id,
        details={"deleted_at": project["deleted_at"]},
    )
    return {"project": restored}


@router.delete("/trash/{project_id}")
def permanently_delete_trashed_project(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_trashed_project_or_404(conn, project_id, user)
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
        actor=user,
        action="project.purge",
        target_type="project",
        target_id=project_id,
        target_label=project["name"],
        project_id=project_id,
        details=details,
        severity="warning",
    )
    return {"ok": True}


@router.get("/{project_id}/members")
def get_project_members(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="manage")
    return list_project_members(conn, project)


@router.put("/{project_id}/members")
def put_project_member_permission_by_username(
    project_id: int,
    payload: ProjectMemberPermissionCreate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="manage")
    result = set_project_member_permission_by_username(
        conn,
        project,
        payload.username,
        payload.permission,
        user,
    )
    if result["changed"]:
        member = result["member"]
        record_audit(
            conn,
            actor=user,
            action="project.permission.grant" if result["previous_permission"] is None else "project.permission.update",
            target_type="project_permission",
            target_id=f"{project_id}:{member['id']}",
            target_label=project["name"],
            project_id=project_id,
            details={
                "project_id": project_id,
                "user_id": member["id"],
                "username": member.get("username"),
                "display_name": member.get("display_name"),
                "previous_permission": result["previous_permission"],
                "permission": payload.permission,
            },
        )
    return {"member": result["member"]}


@router.put("/{project_id}/members/{user_id}")
def put_project_member_permission(
    project_id: int,
    user_id: int,
    payload: ProjectMemberPermissionUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="manage")
    result = update_project_member_permission(conn, project, user_id, payload.permission, user)
    if result["changed"]:
        member = result["member"]
        record_audit(
            conn,
            actor=user,
            action="project.permission.grant" if result["previous_permission"] is None else "project.permission.update",
            target_type="project_permission",
            target_id=f"{project_id}:{user_id}",
            target_label=project["name"],
            project_id=project_id,
            details={
                "project_id": project_id,
                "user_id": user_id,
                "username": member.get("username"),
                "display_name": member.get("display_name"),
                "previous_permission": result["previous_permission"],
                "permission": payload.permission,
            },
        )
    return {"member": result["member"]}


@router.delete("/{project_id}/members/{user_id}")
def delete_project_member_permission(
    project_id: int,
    user_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="manage")
    member = remove_project_member_permission(conn, project, user_id)
    record_audit(
        conn,
        actor=user,
        action="project.permission.revoke",
        target_type="project_permission",
        target_id=f"{project_id}:{user_id}",
        target_label=project["name"],
        project_id=project_id,
        details={
            "project_id": project_id,
            "user_id": user_id,
            "username": member.get("username"),
            "display_name": member.get("display_name"),
            "permission": member["access_level"],
        },
    )
    return {"ok": True}


@router.patch("/{project_id}")
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    ensure_project_editable(project)
    if payload.name is not None and payload.name != project["name"]:
        conn.execute("UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (payload.name, project_id))
        record_audit(
            conn,
            actor=user,
            action="project.rename",
            target_type="project",
            target_id=project_id,
            target_label=payload.name,
            project_id=project_id,
            details={"before": {"name": project["name"]}, "after": {"name": payload.name}},
        )
    if payload.pinned is not None:
        conn.execute(
            "UPDATE projects SET pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (1 if payload.pinned else 0, project_id),
        )
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return {"project": project_row_to_public(row)}


@router.delete("/{project_id}")
def delete_project(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="manage")
    active_jobs = [
        int(row["id"])
        for row in conn.execute(
            "SELECT id FROM agent_jobs WHERE project_id = ? AND status IN ('queued', 'running') ORDER BY id",
            (project_id,),
        ).fetchall()
    ]
    move_project_to_trash(conn, project)
    if not project["deleted_at"]:
        record_audit(
            conn,
            actor=user,
            action="project.trash",
            target_type="project",
            target_id=project_id,
            target_label=project["name"],
            project_id=project_id,
            details={"canceled_agent_job_ids": active_jobs},
            severity="warning",
        )
    return {"ok": True}


@router.get("/{project_id}/files")
def get_project_files(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"files": files_for_project(project)}


@router.get("/{project_id}/source/download")
def download_project_source(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> FileResponse:
    project = get_project_or_404(conn, project_id, user)
    file_path, file_name = source_attachment_for_project(project)
    record_audit(
        conn,
        actor=user,
        action="source.download",
        target_type="project_source",
        target_id=project_id,
        target_label=project["name"],
        project_id=project_id,
        details={"file_name": file_name, "content_sha256": hashlib.sha256(file_path.read_bytes()).hexdigest()},
    )
    return FileResponse(file_path, filename=file_name, media_type="application/octet-stream")


@router.get("/{project_id}/full-script-delivery")
def get_full_script_delivery(
    project_id: int,
    scope: Literal["full", "trial"] = Query(default="full"),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"delivery": full_script_delivery_for_project(project, scope=scope)}


@router.get("/{project_id}/trial-script-delivery")
def get_trial_script_delivery(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"delivery": trial_script_delivery_for_project(project)}


@router.get("/{project_id}/dialogue-script-delivery")
def get_dialogue_script_delivery(
    project_id: int,
    scope: Literal["full", "trial"] = Query(default="full"),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"delivery": dialogue_script_delivery_for_project(project, scope=scope)}


@router.get("/{project_id}/files/{stage}")
def get_project_file(
    project_id: int,
    stage: str,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"file": read_stage_file(project, stage)}


@router.get("/{project_id}/files/{stage}/versions")
def get_project_file_versions(
    project_id: int,
    stage: str,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"history": list_file_versions(conn, project, stage)}


@router.get("/{project_id}/files/{stage}/versions/{version_id}")
def get_project_file_version(
    project_id: int,
    stage: str,
    version_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"version": read_file_version(conn, project, stage, version_id)}


@router.post("/{project_id}/files/{stage}/versions/{version_id}/restore")
def restore_project_file_version(
    project_id: int,
    stage: str,
    version_id: int,
    payload: FileVersionRestore,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    file = restore_file_version(
        conn,
        project,
        user,
        stage,
        version_id,
        payload.expected_hash,
    )
    return {"file": file}


@router.get("/{project_id}/files/{stage}/download")
def download_project_file(
    project_id: int,
    stage: str,
    audit: bool = Query(default=True),
    format: Literal["markdown", "docx", "pdf", "delivery_docx"] = Query(default="markdown"),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> Response:
    project = get_project_or_404(conn, project_id, user)
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    if stage_delivery_in_progress(project, stage):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该阶段正在生成，完成后可以下载")
    workspace = resolve_workspace(project["workspace_dir"])
    file_path = workspace / stage_file_for_workspace(workspace, stage)
    if not file_path.exists():
        raise stage_file_missing_error(stage)
    if audit:
        _record_artifact_download(
            conn,
            project=project,
            user=user,
            stage=stage,
            export_format=format,
        )
    if stage in {"trial_generate", "full_generate", "dialogue_translate"}:
        document = read_stage_file(project, stage)
        return Response(
            content=document["content"],
            media_type="text/markdown",
            headers={"content-disposition": f"attachment; filename*=utf-8''{quote(file_path.name)}"},
        )
    return FileResponse(
        file_path,
        filename=file_path.name,
        media_type="application/json" if stage in {"world_view", "novel_analysis"} else "text/markdown; charset=utf-8",
    )


@router.post("/{project_id}/files/{stage}/download-audit")
def record_project_file_download(
    project_id: int,
    stage: str,
    payload: ArtifactDownloadAudit,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    _record_artifact_download(
        conn,
        project=project,
        user=user,
        stage=stage,
        export_format=payload.format,
    )
    return {"ok": True}


@router.put("/{project_id}/files/{stage}")
def put_project_file(
    project_id: int,
    stage: str,
    payload: FileUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    return {"file": write_stage_file(conn, project, user, stage, payload.content, payload.expected_hash)}


def _comment_content_or_422(value: str) -> str:
    content = value.strip()
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="评论内容不能为空")
    return content


@router.get("/{project_id}/files/{stage}/comments")
def get_document_comments(
    project_id: int,
    stage: str,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    get_project_or_404(conn, project_id, user)
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    return {"comments": list_document_comments(conn, project_id, stage)}


@router.post("/{project_id}/files/{stage}/comments")
def post_document_comment(
    project_id: int,
    stage: str,
    payload: DocumentCommentCreate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    get_project_or_404(conn, project_id, user)
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    if payload.anchor_end <= payload.anchor_start:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="评论位置无效")
    if payload.preview_end is not None and payload.preview_start is not None and payload.preview_end <= payload.preview_start:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="评论位置无效")
    return {
        "comment": create_document_comment(
            conn,
            project_id=project_id,
            stage=stage,
            user=user,
            anchor_start=payload.anchor_start,
            anchor_end=payload.anchor_end,
            anchor_text=payload.anchor_text,
            anchor_prefix=payload.anchor_prefix,
            anchor_suffix=payload.anchor_suffix,
            preview_start=payload.preview_start,
            preview_end=payload.preview_end,
            content=_comment_content_or_422(payload.content),
        )
    }


@router.post("/{project_id}/files/{stage}/comments/{thread_id}/replies")
def post_document_comment_reply(
    project_id: int,
    stage: str,
    thread_id: int,
    payload: DocumentCommentReply,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    get_project_or_404(conn, project_id, user)
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    return {
        "comment": add_document_comment_reply(
            conn,
            project_id=project_id,
            stage=stage,
            thread_id=thread_id,
            user=user,
            content=_comment_content_or_422(payload.content),
        )
    }


@router.delete("/{project_id}/files/{stage}/comments/{thread_id}/messages/{message_id}")
def delete_document_comment(
    project_id: int,
    stage: str,
    thread_id: int,
    message_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    get_project_or_404(conn, project_id, user)
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    return {
        "result": delete_document_comment_message(
            conn,
            project_id=project_id,
            stage=stage,
            thread_id=thread_id,
            message_id=message_id,
            user=user,
        )
    }


@router.put("/{project_id}/outline-title")
def put_project_outline_title(
    project_id: int,
    payload: OutlineTitleUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    ensure_project_editable(project)
    if active_job_for_project(conn, project_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="当前项目正在处理内容，完成后再同步剧本名称")
    return rename_project_script_title(
        conn,
        project=project,
        user=user,
        title=payload.title,
        english_title=payload.english_title or "",
        expected_hash=payload.expected_hash,
    )


@router.post("/{project_id}/archive")
def archive_completed_project(
    project_id: int,
    payload: ProjectArchive,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    result = archive_project(
        conn,
        project=project,
        actor=user,
        expected_hash=payload.expected_hash,
        job_id=payload.job_id,
    )
    return {"project": result}


@router.post("/{project_id}/reopen")
def reopen_completed_project(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    return {"project": reopen_project(conn, project=project, actor=user)}


@router.get("/{project_id}/memory")
def get_project_memory(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"memory": get_memory_status(resolve_workspace(project["workspace_dir"]))}


@router.get("/{project_id}/evolution-reviews")
def get_project_evolution_reviews(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    return {"reviews": list_evolution_reviews(conn, project["id"])}


@router.post("/{project_id}/stages/{stage}/approve")
def approve_project_stage(
    project_id: int,
    stage: str,
    payload: StageApproval,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    ensure_project_editable(project)
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    if stage_delivery_in_progress(project, stage):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该阶段正在生成，完成后再进行确认")
    workspace = resolve_workspace(project["workspace_dir"])
    artifact_path = workspace / stage_file_for_workspace(workspace, stage)
    if not artifact_path.exists():
        raise stage_file_missing_error(stage)
    artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    if payload.expected_hash and payload.expected_hash != artifact_hash:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="文档内容已变化，请刷新后重新确认")
    if stage not in {"trial_generate", "foreign_review"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="当前阶段不需要人工确认")
    quality_contract_version = "agents-new-v1"
    existing_approval = conn.execute(
        """
        SELECT * FROM stage_approvals
        WHERE project_id = ? AND stage = ? AND artifact_hash = ?
          AND quality_contract_version = ?
        ORDER BY id DESC LIMIT 1
        """,
        (project_id, stage, artifact_hash, quality_contract_version),
    ).fetchone()
    approval = approve_new_stage(workspace, stage=stage, actor=user["username"], artifact_hash=artifact_hash)
    if approval.get("quality_contract_version") != quality_contract_version:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="质量契约在审批期间已变更，请重新确认")
    if existing_approval:
        approval["idempotent"] = True
    else:
        conn.execute(
            """
            INSERT INTO stage_approvals (
                project_id, stage, artifact_hash, quality_contract_version,
                memory_revision, approved_by, job_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                stage,
                approval["artifact_hash"],
                approval["quality_contract_version"],
                approval["memory"].get("revision"),
                user["id"],
                approval.get("job_id"),
            ),
        )
    conn.execute(
        "UPDATE projects SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (stage, project_id),
    )
    record_audit(
        conn,
        actor=user,
        action="stage.approve",
        target_type="project_stage",
        target_id=f"{project_id}:{stage}",
        target_label=project["name"],
        project_id=project_id,
        details={
            "stage": stage,
            "artifact_hash": approval["artifact_hash"],
            "quality_contract_version": approval["quality_contract_version"],
            "memory_revision": approval["memory"].get("revision"),
            "job_id": approval.get("job_id"),
            "idempotent": bool(existing_approval),
        },
    )
    return {"approval": approval}
