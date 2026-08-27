from __future__ import annotations

import asyncio
import json
import sqlite3
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.errors import APIError
from app.db.session import get_connection, get_db
from app.dependencies import admin_feature_user, current_user
from app.services.audit_service import record_audit
from app.services.agent_runner import (
    TERMINAL_STATUSES,
    add_event,
    cancel_job,
    create_job,
    get_job_or_404,
    job_regeneration_settings,
    job_has_context_limit_failure,
    list_events,
    prompt_with_regeneration_reference,
    public_job,
    quote_agent_job_credits,
    review_p0_optimization_context,
    review_p0_optimization_prompt,
    resume_failed_continuation_job,
    run_agent_job,
)
from app.services.credit_service import credit_summary, re_reserve_job_credits
from app.services.zdebug_manager import project_job_log_files, zdebug_manager
from app.services.workspace_service import get_project_or_404

router = APIRouter(tags=["agent"])


class AgentJobCreate(BaseModel):
    stage: str = "next"
    target_stage: Optional[str] = None
    prompt: Optional[str] = ""
    user_input: Optional[str] = Field(default="", max_length=20_000)
    dry_run: bool = False
    reference_current_file: Optional[bool] = None
    regenerate_current_file: bool = False
    optimization_scope: Optional[Literal["review_p0"]] = None


@router.post("/projects/{project_id}/agent/jobs", status_code=status.HTTP_201_CREATED)
def post_agent_job(
    project_id: int,
    payload: AgentJobCreate,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    manual_input = (payload.user_input or "").strip()
    target_stage = payload.target_stage or payload.stage
    optimization_context = None
    if payload.optimization_scope == "review_p0":
        if payload.regenerate_current_file or payload.reference_current_file is not None or manual_input:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="一键优化不能与重新生成或手动输入同时使用")
        optimization_context = review_p0_optimization_context(project)
    if payload.regenerate_current_file:
        if payload.reference_current_file is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="重新生成需要明确是否参考当前文件")
        if payload.stage != target_stage:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="重新生成只能处理当前阶段文件")
    prompt = (
        review_p0_optimization_prompt(optimization_context)
        if optimization_context
        else prompt_with_regeneration_reference(
            project,
            target_stage,
            payload.prompt or "",
            payload.reference_current_file,
            regenerate_current_file=payload.regenerate_current_file,
        )
    )
    job = create_job(
        conn,
        project=project,
        user=user,
        stage=payload.stage,
        target_stage=payload.target_stage,
        prompt=prompt,
        # A non-reference regeneration must not inherit the former stage
        # conversation, which can otherwise reintroduce the removed draft.
        force_new_session=payload.regenerate_current_file and payload.reference_current_file is False,
        input_origin="manual" if payload.stage == "chat_edit" or manual_input else "automatic",
        manual_input=manual_input or None,
        dry_run=payload.dry_run,
        regenerate_current_file=payload.regenerate_current_file,
        reference_current_file=payload.reference_current_file,
        optimization_scope=payload.optimization_scope,
    )
    conn.commit()
    background_tasks.add_task(run_agent_job, job["id"])
    return {"job": public_job(job)}


@router.get("/projects/{project_id}/agent/credit-quote")
def get_agent_credit_quote(
    project_id: int,
    stage: str = "next",
    target_stage: Optional[str] = None,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user, required_permission="edit")
    quote = quote_agent_job_credits(
        conn,
        project=project,
        stage=stage,
        target_stage=target_stage,
    )
    summary = credit_summary(conn, user_id=int(user["id"]))
    balance = summary["balance"]
    return {"quote": {
        **quote,
        "balance": balance,
        "managed": summary["managed"],
        "affordable": not summary["managed"] or balance is None or int(balance) >= int(quote["credits"]),
        "concurrency": summary["concurrency"],
    }}


@router.get("/projects/{project_id}/agent/history")
def get_project_agent_history(
    project_id: int,
    stage: Optional[str] = None,
    limit: int = Query(300, ge=1, le=1000),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    where = ["project_id = ?"]
    params: list[object] = [project["id"]]
    if stage:
        where.append("stage = ?")
        params.append(stage)
    params.append(limit)
    messages = conn.execute(
        f"""
        SELECT * FROM agent_messages
        WHERE {' AND '.join(where)}
        ORDER BY id DESC LIMIT ?
        """,
        params,
    ).fetchall()
    jobs = conn.execute(
        "SELECT * FROM agent_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 100",
        (project["id"],),
    ).fetchall()
    return {
        "logical_thread_id": project["claude_session_id"],
        "messages": [
            {
                "id": row["id"],
                "job_id": row["job_id"],
                "stage": row["stage"],
                "role": row["role"],
                "content": row["content"],
                "metadata": json.loads(row["metadata_json"]) if row["metadata_json"] else {},
                "created_at": row["created_at"],
            }
            for row in reversed(messages)
        ],
        "jobs": [public_job(row, include_prompt=False) for row in jobs],
    }


@router.get("/projects/{project_id}/agent/jobs/active")
def get_project_active_agent_job(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    project = get_project_or_404(conn, project_id, user)
    job = conn.execute(
        """
        SELECT * FROM agent_jobs
        WHERE project_id = ? AND status IN ('queued', 'running')
        ORDER BY id DESC LIMIT 1
        """,
        (project["id"],),
    ).fetchone()
    if not job:
        return {"job": None, "events": []}
    return {"job": public_job(job), "events": list_events(conn, job["id"])}


@router.get("/agent/jobs/{job_id}")
def get_agent_job(
    job_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    job = get_job_or_404(conn, job_id, user)
    return {"job": public_job(job)}


@router.post("/agent/jobs/{job_id}/retry", status_code=status.HTTP_201_CREATED)
def post_retry_agent_job(
    job_id: int,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    source = get_job_or_404(conn, job_id, user, required_permission="edit")
    if source["status"] != "failed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="只能重试执行失败的任务")
    project = get_project_or_404(conn, source["project_id"], user, required_permission="edit")
    resumed = resume_failed_continuation_job(
        conn,
        job=source,
        project=project,
        username=str(user["username"]),
    )
    if resumed:
        try:
            re_reserve_job_credits(conn, job_id=int(resumed["id"]))
        except HTTPException:
            cancel_job(conn, int(resumed["id"]))
            raise
        record_audit(
            conn,
            actor=user,
            action="agent_job.retry",
            target_type="agent_job",
            target_id=resumed["id"],
            target_label=f"#{resumed['id']}",
            project_id=int(project["id"]),
            details={"source_job_id": source["id"], "resumed_in_place": True},
        )
        conn.commit()
        background_tasks.add_task(run_agent_job, resumed["id"])
        return {"job": public_job(resumed)}
    regenerate_current_file, reference_current_file = job_regeneration_settings(source)
    job = create_job(
        conn,
        project=project,
        user=user,
        stage=source["stage"],
        target_stage=source["target_stage"],
        prompt=source["prompt"] or "",
        dry_run=bool(source["dry_run"]),
        force_new_session=(
            job_has_context_limit_failure(source)
            or (regenerate_current_file and reference_current_file is False)
        ),
        input_origin="retry",
        retry_of_job_id=int(source["id"]),
        regenerate_current_file=regenerate_current_file,
        reference_current_file=reference_current_file,
        optimization_scope=(source["optimization_scope"] if "optimization_scope" in source.keys() else None),
    )
    record_audit(
        conn,
        actor=user,
        action="agent_job.retry",
        target_type="agent_job",
        target_id=job["id"],
        target_label=f"#{job['id']}",
        project_id=int(project["id"]),
        details={"source_job_id": source["id"], "resumed_in_place": False},
    )
    conn.commit()
    background_tasks.add_task(run_agent_job, job["id"])
    return {"job": public_job(job)}


@router.get("/agent/jobs/{job_id}/events")
def get_agent_events(
    job_id: int,
    after_id: int = Query(0, ge=0),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    job = get_job_or_404(conn, job_id, user)
    return {"job": public_job(job), "events": list_events(conn, job_id, after_id)}


@router.post("/agent/jobs/{job_id}/debug/start")
def post_start_agent_debug(
    job_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(admin_feature_user("jobs")),
) -> dict:
    job = get_job_or_404(conn, job_id, user)
    project = get_project_or_404(conn, job["project_id"], user)
    log_files = project_job_log_files(conn, project=project, current_job_id=job["id"])
    service = zdebug_manager.start_for_job(
        job_id=job["id"],
        project_id=project["id"],
        project_path=settings.agents_dir,
        session_id=job["claude_session_id"],
        log_files=log_files,
    )
    add_event(
        conn,
        job_id,
        "info",
        f"ZDebug 调试日志已{'复用' if service.get('reused') else '启动'}：{service['url']}",
    )
    record_audit(
        conn,
        actor=user,
        action="agent_job.debug.start",
        target_type="agent_job",
        target_id=job_id,
        target_label=f"#{job_id}",
        project_id=int(project["id"]),
        details={"reused": bool(service.get("reused"))},
    )
    return {"debug": service}


@router.get("/agent/jobs/{job_id}/stream")
def stream_agent_events(
    job_id: int,
    after_id: int = Query(0, ge=0),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> StreamingResponse:
    get_job_or_404(conn, job_id, user)

    async def event_stream():
        last_id = after_id
        with get_connection() as stream_conn:
            while True:
                events = list_events(stream_conn, job_id, last_id)
                for event in events:
                    last_id = event["id"]
                    yield "event: agent-event\n"
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

                job = stream_conn.execute("SELECT status FROM agent_jobs WHERE id = ?", (job_id,)).fetchone()
                if not job:
                    yield "event: agent-error\n"
                    yield "data: {\"message\":\"Job not found\"}\n\n"
                    break
                if job["status"] in TERMINAL_STATUSES:
                    yield "event: agent-done\n"
                    yield f"data: {json.dumps({'status': job['status']}, ensure_ascii=False)}\n\n"
                    break
                await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/agent/jobs/{job_id}/cancel")
def post_cancel_agent_job(
    job_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    job = get_job_or_404(conn, job_id, user, required_permission="edit")
    if job["status"] in TERMINAL_STATUSES:
        raise APIError("JOB_ALREADY_FINISHED")
    previous_status = job["status"]
    cancel_job(conn, job_id)
    updated = conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (job_id,)).fetchone()
    record_audit(
        conn,
        actor=user,
        action="agent_job.cancel",
        target_type="agent_job",
        target_id=job_id,
        target_label=f"#{job_id}",
        project_id=int(job["project_id"]),
        details={"previous_status": previous_status, "status": updated["status"]},
        severity="warning",
    )
    return {"job": public_job(updated)}
