from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Header, HTTPException, status

from app.services.agent_runner import AgentExecutionError, execute_novel_analysis_tool


router = APIRouter(prefix="/internal/agent-tools", tags=["internal-agent-tools"])


def _novel_analysis_next_action(error: AgentExecutionError) -> str:
    configured = error.details.get("next_action") if isinstance(error.details, dict) else None
    if isinstance(configured, str) and configured.strip():
        return configured.strip()
    if error.retryable:
        return "重新调用‘完整阅读小说’。"
    return "重新执行小说解读。"


@router.post("/novel-analysis/prepare")
def prepare_novel_analysis(
    tool_token: Optional[str] = Header(default=None, alias="x-agent-tool-token"),
) -> dict:
    if not tool_token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "message": "当前任务无法调用小说全文阅读。",
            "next_action": "请重新执行小说解读。",
        })
    try:
        return execute_novel_analysis_tool(tool_token)
    except AgentExecutionError as exc:
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE if exc.retryable else status.HTTP_409_CONFLICT
        raise HTTPException(status_code=status_code, detail={
            "message": exc.user_message,
            "next_action": _novel_analysis_next_action(exc),
        }) from exc
