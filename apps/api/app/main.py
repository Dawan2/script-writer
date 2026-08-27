from __future__ import annotations

import asyncio
import contextlib
import logging
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.time_utils import UtcJSONResponse
from app.db.session import get_connection, init_db
from app.routers import admin, agent, auth, batch_tasks, credits, internal_agent_tools, notifications, openclaw_api, preferences, projects
from app.services.agent_runner import cleanup_running_agent_processes, recover_interrupted_agent_jobs, run_agent_job
from app.services.agent_evolution_service import backfill_evolution_reviews
from app.services.audit_service import record_system_audit, reset_audit_context, set_audit_context
from app.services.batch_task_service import dispatch_batch_tasks
from app.services.credit_service import grant_due_plan_credits
from app.services.project_trash_service import TRASH_CLEANUP_INTERVAL_SECONDS, run_expired_project_cleanup
from app.services.preference_summary_service import (
    queued_preference_summary_job_ids,
    run_preference_summary_job,
)
from app.services.script_sync_service import dispatch_script_sync_jobs
from app.services.script_library_service import (
    queued_distillation_job_ids,
    recover_distillation_jobs,
    run_script_distillation_job,
)
from app.services.script_library_batch_service import (
    queued_script_library_batch_run_ids,
    recover_script_library_batch_runs,
    run_script_library_batch_run,
)
from app.services.system_agent_evolution_service import (
    run_system_evolution_analysis,
    run_system_evolution_execution,
)
from app.services.zdebug_manager import zdebug_manager


app = FastAPI(
    title="虎鲸｜剧本出海工作站 API",
    version="0.1.0",
    default_response_class=UtcJSONResponse,
)
logger = logging.getLogger(__name__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def bind_audit_request_context(request: Request, call_next):
    request_id = (request.headers.get("x-request-id") or uuid4().hex)[:128]
    source = "openclaw" if request.url.path.startswith("/openclaw/") else "web" if request.headers.get("x-audit-source") == "web" else "api"
    token = set_audit_context(request_id=request_id, source=source)
    try:
        response = await call_next(request)
    finally:
        reset_audit_context(token)
    response.headers["x-request-id"] = request_id
    return response


async def trash_cleanup_loop() -> None:
    while True:
        await asyncio.sleep(TRASH_CLEANUP_INTERVAL_SECONDS)
        try:
            await asyncio.to_thread(run_expired_project_cleanup)
        except Exception:
            logger.exception("回收站周期清理执行失败")


def schedule_background_recovery_task(app_instance: FastAPI, runner: object, job_id: int) -> None:
    task = asyncio.create_task(asyncio.to_thread(runner, job_id))
    app_instance.state.background_recovery_tasks.add(task)
    task.add_done_callback(app_instance.state.background_recovery_tasks.discard)


async def agent_job_recovery_loop(app_instance: FastAPI) -> None:
    """Resume jobs whose previous process disappeared after its lease expires."""
    poll_seconds = max(5, int(settings.agent_job_recovery_poll_seconds))
    while True:
        await asyncio.sleep(poll_seconds)
        try:
            job_ids = await asyncio.to_thread(recover_interrupted_agent_jobs)
            for job_id in job_ids:
                schedule_background_recovery_task(app_instance, run_agent_job, job_id)
        except Exception:
            logger.exception("Agent 任务恢复扫描失败")


async def batch_task_scheduler_loop() -> None:
    """Keep persisted batch work moving after API restarts and delayed auto-retries."""
    poll_seconds = max(5, int(settings.batch_task_scheduler_poll_seconds))
    while True:
        await asyncio.sleep(poll_seconds)
        try:
            await asyncio.to_thread(dispatch_batch_tasks)
        except Exception:
            logger.exception("批量任务调度扫描失败")


async def script_sync_scheduler_loop() -> None:
    """Keep persisted script sync work running independently from browser requests."""
    poll_seconds = max(5, int(getattr(settings, "script_sync_scheduler_poll_seconds", 10)))
    while True:
        await asyncio.sleep(poll_seconds)
        try:
            await asyncio.to_thread(dispatch_script_sync_jobs)
        except Exception:
            logger.exception("剧本同步调度扫描失败")


async def preference_summary_scheduler_loop(app_instance: FastAPI) -> None:
    """Run archive-only preference summaries outside every normal writing flow."""
    poll_seconds = max(10, int(getattr(settings, "preference_summary_scheduler_poll_seconds", 20)))
    while True:
        await asyncio.sleep(poll_seconds)
        try:
            summary_job_ids = await asyncio.to_thread(queued_preference_summary_job_ids)
            for summary_job_id in summary_job_ids:
                schedule_background_recovery_task(app_instance, run_preference_summary_job, summary_job_id)
        except Exception:
            logger.exception("创作偏好复盘调度扫描失败")


async def script_distillation_scheduler_loop(app_instance: FastAPI) -> None:
    poll_seconds = max(5, int(getattr(settings, "script_distillation_scheduler_poll_seconds", 10)))
    while True:
        await asyncio.sleep(poll_seconds)
        try:
            for job_id in await asyncio.to_thread(queued_distillation_job_ids):
                schedule_background_recovery_task(app_instance, run_script_distillation_job, job_id)
            for run_id in await asyncio.to_thread(queued_script_library_batch_run_ids):
                schedule_background_recovery_task(app_instance, run_script_library_batch_run, run_id)
        except Exception:
            logger.exception("剧本蒸馏调度扫描失败")


def dispatch_due_plan_credits() -> int:
    """Issue today's paid-plan allocation once and preserve an audit trail."""
    with get_connection() as conn:
        issued = grant_due_plan_credits(conn)
        for account in issued:
            record_system_audit(
                conn,
                action="credits.plan.grant",
                target_type="user",
                target_id=account["user_id"],
                target_label=account["username"],
                details={
                    "plan_code": account["plan"]["code"],
                    "credits": account["plan"]["allowance"],
                    "balance": account["balance"],
                    "grant_key": account["plan_grant"]["grant_key"],
                    "automatic": True,
                    "expires_at": account["plan_term"]["expires_at"],
                },
            )
    return len(issued)


async def credit_plan_grant_loop() -> None:
    """Catch the first scan after Shanghai midnight and service restarts."""
    poll_seconds = max(10, int(settings.credit_plan_grant_poll_seconds))
    while True:
        await asyncio.sleep(poll_seconds)
        try:
            issued = await asyncio.to_thread(dispatch_due_plan_credits)
            if issued:
                logger.info("已自动发放 %s 个套餐的当日创作额度", issued)
        except Exception:
            logger.exception("套餐额度自动发放扫描失败")


def resume_background_jobs() -> list[tuple[object, int]]:
    with get_connection() as conn:
        agent_job_ids = recover_interrupted_agent_jobs(conn)
        conn.execute(
            """
            UPDATE preference_summary_jobs
            SET status = 'queued', started_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE status = 'running'
            """
        )
        analysis_rows = conn.execute(
            "SELECT id FROM system_agent_evolution_runs WHERE status IN ('queued', 'analyzing') ORDER BY id"
        ).fetchall()
        conn.execute(
            """
            UPDATE system_agent_evolution_runs
            SET status = 'queued', updated_at = CURRENT_TIMESTAMP
            WHERE status = 'analyzing'
            """
        )
        execution_rows = conn.execute(
            "SELECT id FROM system_agent_evolution_runs WHERE status = 'applying' ORDER BY id"
        ).fetchall()
    return [
        *((run_agent_job, job_id) for job_id in agent_job_ids),
        *((run_system_evolution_analysis, int(row["id"])) for row in analysis_rows),
        *((run_system_evolution_execution, int(row["id"])) for row in execution_rows),
    ]


@app.on_event("startup")
async def on_startup() -> None:
    init_db()
    with get_connection() as conn:
        recover_distillation_jobs(conn)
        recover_script_library_batch_runs(conn)
    run_expired_project_cleanup()
    with get_connection() as conn:
        backfill_evolution_reviews(conn, settings.agents_dir)
    app.state.background_recovery_tasks = set()
    for runner, job_id in resume_background_jobs():
        schedule_background_recovery_task(app, runner, job_id)
    dispatch_batch_tasks(recovering_after_restart=True)
    dispatch_script_sync_jobs(recovering_after_restart=True)
    issued = dispatch_due_plan_credits()
    if issued:
        logger.info("启动时已自动发放 %s 个套餐的当日创作额度", issued)
    app.state.agent_job_recovery_task = asyncio.create_task(agent_job_recovery_loop(app))
    app.state.batch_task_scheduler_task = asyncio.create_task(batch_task_scheduler_loop())
    app.state.script_sync_scheduler_task = asyncio.create_task(script_sync_scheduler_loop())
    app.state.preference_summary_scheduler_task = asyncio.create_task(preference_summary_scheduler_loop(app))
    app.state.script_distillation_scheduler_task = asyncio.create_task(script_distillation_scheduler_loop(app))
    app.state.credit_plan_grant_task = asyncio.create_task(credit_plan_grant_loop())
    app.state.trash_cleanup_task = asyncio.create_task(trash_cleanup_loop())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    recovery_task = getattr(app.state, "agent_job_recovery_task", None)
    if recovery_task:
        recovery_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await recovery_task
    batch_scheduler_task = getattr(app.state, "batch_task_scheduler_task", None)
    if batch_scheduler_task:
        batch_scheduler_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await batch_scheduler_task
    script_sync_scheduler_task = getattr(app.state, "script_sync_scheduler_task", None)
    if script_sync_scheduler_task:
        script_sync_scheduler_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await script_sync_scheduler_task
    preference_summary_scheduler_task = getattr(app.state, "preference_summary_scheduler_task", None)
    if preference_summary_scheduler_task:
        preference_summary_scheduler_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await preference_summary_scheduler_task
    script_distillation_scheduler_task = getattr(app.state, "script_distillation_scheduler_task", None)
    if script_distillation_scheduler_task:
        script_distillation_scheduler_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await script_distillation_scheduler_task
    credit_plan_grant_task = getattr(app.state, "credit_plan_grant_task", None)
    if credit_plan_grant_task:
        credit_plan_grant_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await credit_plan_grant_task
    cleanup_task = getattr(app.state, "trash_cleanup_task", None)
    if cleanup_task:
        cleanup_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cleanup_task
    cleanup_running_agent_processes()
    zdebug_manager.cleanup()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "orca-script-workbench-api"}


app.include_router(auth.router)
app.include_router(preferences.router)
app.include_router(projects.router)
app.include_router(agent.router)
app.include_router(credits.router)
app.include_router(batch_tasks.router)
app.include_router(openclaw_api.router)
app.include_router(notifications.router)
app.include_router(admin.router)
app.include_router(internal_agent_tools.router)
