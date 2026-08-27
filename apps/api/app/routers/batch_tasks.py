from __future__ import annotations

import json
import sqlite3
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.db.session import get_db
from app.dependencies import permission_user
from app.services.batch_task_service import (
    create_batch_tasks,
    delete_batch_task,
    dispatch_batch_tasks,
    list_batch_tasks,
    pause_batch_task,
    rerun_batch_task,
    start_all_batch_tasks,
    start_batch_task,
)
from app.services.workspace_service import list_target_regions, list_task_scenarios
from app.services.role_service import BATCH_TASK_PERMISSION, accessible_scenario_keys


router = APIRouter(prefix="/batch-tasks", tags=["batch-tasks"])


class BatchTaskBulkAction(BaseModel):
    action: Literal["start", "pause", "rerun", "delete"]
    task_ids: list[int] = Field(min_length=1, max_length=100)


def parse_batch_task_form(form: object) -> list[dict]:
    raw_tasks = getattr(form, "get", lambda _key: None)("tasks")
    if not isinstance(raw_tasks, str):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="任务数据格式不正确")
    try:
        tasks = json.loads(raw_tasks)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="任务数据格式不正确") from exc
    if not isinstance(tasks, list):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="任务数据格式不正确")
    valid_regions = {item["key"] for item in list_target_regions()}
    parsed: list[dict] = []
    for index, value in enumerate(tasks, start=1):
        if not isinstance(value, dict):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"第 {index} 条任务格式不正确")
        region = str(value.get("target_region") or "").strip()
        if region not in valid_regions:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"第 {index} 条任务的目标地区不可用")
        file_key = str(value.get("source_file_key") or "")
        upload = getattr(form, "get", lambda _key: None)(file_key)
        if not file_key or not hasattr(upload, "filename"):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"第 {index} 条任务缺少原始剧本文件")
        parsed.append({**value, "upload": upload})
    return parsed


def _allowed_scenarios(conn: sqlite3.Connection, actor: sqlite3.Row) -> set[str]:
    return accessible_scenario_keys(conn, actor)


@router.get("/scenarios")
def get_batch_task_scenarios(
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    allowed_scenarios = _allowed_scenarios(conn, actor)
    return {
        "scenarios": [item for item in list_task_scenarios() if item["key"] in allowed_scenarios],
        "regions": list_target_regions(),
    }


@router.get("")
def get_batch_tasks(
    scenario: Optional[str] = None,
    task_status: Optional[str] = None,
    query: Optional[str] = None,
    limit: int = 200,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    return list_batch_tasks(
        conn,
        scenario=scenario,
        status_value=task_status,
        query=query,
        limit=limit,
        allowed_scenarios=_allowed_scenarios(conn, actor),
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def post_batch_tasks(
    request: Request,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    form = await request.form()
    tasks = parse_batch_task_form(form)
    result = create_batch_tasks(
        conn,
        actor=actor,
        batch_name=str(form.get("batch_name") or ""),
        tasks=tasks,
        allowed_scenarios=_allowed_scenarios(conn, actor),
    )
    background_tasks.add_task(dispatch_batch_tasks)
    return result


@router.post("/start-all")
def post_start_all_batch_tasks(
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    updated = start_all_batch_tasks(conn, actor=actor, allowed_scenarios=_allowed_scenarios(conn, actor))
    background_tasks.add_task(dispatch_batch_tasks)
    return {"updated": updated}


@router.post("/bulk")
def post_batch_task_bulk_action(
    payload: BatchTaskBulkAction,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    handlers = {
        "start": start_batch_task,
        "pause": pause_batch_task,
        "rerun": rerun_batch_task,
    }
    updated = 0
    failures: list[dict] = []
    for task_id in dict.fromkeys(payload.task_ids):
        try:
            if payload.action == "delete":
                delete_batch_task(conn, task_id=task_id, actor=actor, allowed_scenarios=_allowed_scenarios(conn, actor))
            else:
                handlers[payload.action](
                    conn,
                    task_id=task_id,
                    actor=actor,
                    allowed_scenarios=_allowed_scenarios(conn, actor),
                )
            updated += 1
        except HTTPException as exc:
            failures.append({"task_id": task_id, "message": str(exc.detail)})
    background_tasks.add_task(dispatch_batch_tasks)
    return {"updated": updated, "failures": failures}


@router.post("/{task_id}/start")
def post_start_batch_task(
    task_id: int,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    task = start_batch_task(conn, task_id=task_id, actor=actor, allowed_scenarios=_allowed_scenarios(conn, actor))
    background_tasks.add_task(dispatch_batch_tasks)
    return {"task": task}


@router.post("/{task_id}/pause")
def post_pause_batch_task(
    task_id: int,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    task = pause_batch_task(conn, task_id=task_id, actor=actor, allowed_scenarios=_allowed_scenarios(conn, actor))
    background_tasks.add_task(dispatch_batch_tasks)
    return {"task": task}


@router.post("/{task_id}/rerun")
def post_rerun_batch_task(
    task_id: int,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    task = rerun_batch_task(conn, task_id=task_id, actor=actor, allowed_scenarios=_allowed_scenarios(conn, actor))
    background_tasks.add_task(dispatch_batch_tasks)
    return {"task": task}


@router.delete("/{task_id}")
def delete_batch_task_route(
    task_id: int,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(permission_user(BATCH_TASK_PERMISSION)),
) -> dict:
    delete_batch_task(conn, task_id=task_id, actor=actor, allowed_scenarios=_allowed_scenarios(conn, actor))
    background_tasks.add_task(dispatch_batch_tasks)
    return {"ok": True}
