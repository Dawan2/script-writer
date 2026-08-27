from __future__ import annotations

import json
import os
import subprocess

from fastapi import HTTPException, status

from app.core.config import settings
from app.services.workspace_service import TASK_TYPE_NOVEL, resolve_workspace, row_task_type


def _tool_message(raw: str, fallback: str) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return fallback
    message = payload.get("message") if isinstance(payload, dict) else None
    return message.strip() if isinstance(message, str) and message.strip() else fallback


def assert_novel_analysis_admission(project: dict) -> dict:
    """Reject oversized novels before a job, credit reservation, or Agent session exists."""
    if row_task_type(project) != TASK_TYPE_NOVEL:
        return {"allowed": True}

    workspace = resolve_workspace(str(project["workspace_dir"]))
    tool = settings.agents_dir / ".claude/skills/novel_analysis/scripts/check-novel-length.mjs"
    if not tool.is_file():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="小说字数校验暂不可用，请稍后再试。",
        )

    try:
        result = subprocess.run(
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
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="小说字数校验超时，请稍后再试。",
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="小说字数校验暂不可用，请稍后再试。",
        ) from exc

    if result.returncode != 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_tool_message(result.stderr or result.stdout, "小说原文暂时无法读取，请检查后重试。"),
        )

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="小说字数校验返回异常，请稍后再试。",
        ) from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("allowed"), bool):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="小说字数校验返回异常，请稍后再试。",
        )
    if not payload["allowed"]:
        message = payload.get("message")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=message if isinstance(message, str) and message.strip() else "小说字数超过解析范围。",
        )
    return payload
