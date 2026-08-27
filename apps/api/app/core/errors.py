"""服务端统一错误契约：错误信封、注册表读取与四条失败出口的异常处理器。

信封字段与约束见 `docs/iteration/cycle-01/W2-C1-W1-02-实现规格.md` 第 2 节，
错误码与文案的唯一出处是同目录的 `error_codes.json`。
"""

from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request
from starlette.responses import Response

from app.core.time_utils import UtcJSONResponse
from app.core.validation_messages import field_label, validation_reason
from app.services.audit_service import current_request_id

REGISTRY_PATH = Path(__file__).with_name("error_codes.json")
REQUEST_ID_HEADER = "x-request-id"
ROOT_CAUSE_LIMIT = 2000

logger = logging.getLogger(__name__)
_LATIN_RUN = re.compile(r"[A-Za-z]{2,}")
_CJK = re.compile(r"[\u4e00-\u9fff]")


@lru_cache(maxsize=1)
def load_registry() -> dict[str, Any]:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def http_codes() -> dict[str, dict[str, Any]]:
    return load_registry()["http_codes"]


def allowed_categories() -> list[str]:
    return list(load_registry()["categories"])


def allowed_latin_words() -> list[str]:
    return list(load_registry()["allowed_latin_words"])


def is_user_facing_text(text: str) -> bool:
    """带中文的文案才当作能直接给用户看；其余按注册表文案处理。"""
    return bool(text.strip()) and bool(_CJK.search(text))


def contains_disallowed_latin(text: str) -> bool:
    """允许清单之外的拉丁字母串一律视为没有汉化的文案。"""
    allowed = {word.lower() for word in allowed_latin_words()}
    return any(run.group(0).lower() not in allowed for run in _LATIN_RUN.finditer(text))


def fallback_code(status_code: int) -> str:
    table = load_registry()["status_fallback"]
    return table.get(str(status_code)) or table["500"]


class APIError(HTTPException):
    """带错误码的失败。

    继承 `HTTPException`，因此现有 `except HTTPException` 的调用点与直接调用
    依赖函数的测试都不需要改动；`detail` 保持为用户可读的中文字符串。
    """

    def __init__(
        self,
        code: str,
        *,
        status_code: Optional[int] = None,
        message: Optional[str] = None,
        hint: Optional[str] = None,
        category: Optional[str] = None,
        retryable: Optional[bool] = None,
        details: Optional[dict[str, Any]] = None,
        root_cause: Any = None,
        headers: Optional[dict[str, str]] = None,
    ) -> None:
        entry = http_codes().get(code)
        if entry is None:
            raise KeyError(f"错误码未登记在 error_codes.json：{code}")
        resolved_message = message.strip() if isinstance(message, str) and message.strip() else entry["message"]
        super().__init__(
            status_code=status_code or int(entry["status"]),
            detail=resolved_message,
            headers=headers,
        )
        self.code = code
        self.category = category or entry["category"]
        self.retryable = bool(entry["retryable"]) if retryable is None else bool(retryable)
        self.message = resolved_message
        self.hint = hint if isinstance(hint, str) and hint.strip() else entry["hint"]
        self.details = details or {}
        self.root_cause = _clip_root_cause(root_cause)


def _clip_root_cause(value: Any) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    return text.strip()[-ROOT_CAUSE_LIMIT:]


def unknown_stage_error(stage: Any = None) -> APIError:
    """`Unknown stage` 的唯一抛错入口，避免下一处新增时再复制一遍文案。"""
    return APIError("STAGE_UNKNOWN", root_cause=f"stage={stage}" if stage is not None else None)


def stage_file_missing_error(stage: Any = None) -> APIError:
    """`Stage file not found` 的唯一抛错入口。"""
    return APIError("STAGE_FILE_MISSING", root_cause=f"stage={stage}" if stage is not None else None)


def tool_failure_error(code: str, *, root_cause: Any = None, details: Optional[dict[str, Any]] = None) -> APIError:
    """子进程失败：原始输出只进 `root_cause`，用户看到的是注册表文案。"""
    return APIError(code, root_cause=root_cause, details=details)


def request_trace_id(request: Optional[Request]) -> str:
    """四条出口取同一个追踪号：中间件绑定的号优先，其次审计上下文。"""
    if request is not None:
        bound = getattr(request.state, "request_id", None)
        if isinstance(bound, str) and bound:
            return bound
    from_context = current_request_id()
    if from_context:
        return from_context
    if request is not None:
        from_header = (request.headers.get(REQUEST_ID_HEADER) or "").strip()
        if from_header:
            return from_header[:128]
    return uuid4().hex


def _envelope_response(
    *,
    status_code: int,
    code: str,
    category: str,
    retryable: bool,
    message: str,
    hint: str,
    trace_id: str,
    details: Optional[dict[str, Any]] = None,
    detail_mirror: Any = None,
    headers: Optional[dict[str, str]] = None,
) -> Response:
    error: dict[str, Any] = {
        "code": code,
        "category": category,
        "retryable": retryable,
        "message": message,
        "hint": hint,
        "traceId": trace_id,
    }
    if details:
        error["details"] = details
    body = {"error": error, "detail": message if detail_mirror is None else detail_mirror}
    response_headers = dict(headers or {})
    response_headers[REQUEST_ID_HEADER] = trace_id
    return UtcJSONResponse(status_code=status_code, content=body, headers=response_headers)


def _log_root_cause(trace_id: str, code: str, root_cause: str) -> None:
    if root_cause:
        logger.error("失败内部原因 trace_id=%s code=%s root_cause=%s", trace_id, code, root_cause)


async def api_error_handler(request: Request, exc: APIError) -> Response:
    trace_id = request_trace_id(request)
    _log_root_cause(trace_id, exc.code, exc.root_cause)
    return _envelope_response(
        status_code=exc.status_code,
        code=exc.code,
        category=exc.category,
        retryable=exc.retryable,
        message=exc.message,
        hint=exc.hint,
        trace_id=trace_id,
        details=exc.details,
        headers=exc.headers,
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> Response:
    """把仍在使用 `HTTPException` 的抛错点、以及框架自带的 404 / 405 收进同一个信封。"""
    code = fallback_code(exc.status_code)
    entry = http_codes()[code]
    detail = exc.detail
    if isinstance(detail, str) and _CJK.search(detail):
        message = detail.strip()
        detail_mirror = None
    elif isinstance(detail, str):
        # 框架自带的英文文案（`Not Found`、`Method Not Allowed`）不再送到用户眼前。
        message = entry["message"]
        detail_mirror = None
    else:
        # 机器接口按结构化 `detail` 约定消费，形状保持不变。
        message = _machine_detail_message(detail) or entry["message"]
        detail_mirror = detail
    return _envelope_response(
        status_code=exc.status_code,
        code=code,
        category=entry["category"],
        retryable=bool(entry["retryable"]),
        message=message,
        hint=entry["hint"],
        trace_id=request_trace_id(request),
        detail_mirror=detail_mirror,
        headers=getattr(exc, "headers", None),
    )


def _machine_detail_message(detail: Any) -> str:
    if isinstance(detail, dict):
        candidate = detail.get("message")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def _validation_fields(errors: list[Any]) -> list[dict[str, str]]:
    """只取 `loc` 与错误类型；用户提交的原始值在构造侧就不进入内存。"""
    fields: list[dict[str, str]] = []
    for item in errors:
        if not isinstance(item, dict):
            continue
        location = item.get("loc")
        parts = [str(part) for part in location] if isinstance(location, (list, tuple)) else []
        field: dict[str, str] = {
            "path": ".".join(parts),
            "reason": validation_reason(str(item.get("type") or ""), item.get("ctx")),
        }
        label = field_label(parts)
        if label:
            field["label"] = label
        fields.append(field)
    return fields


def _validation_message(fields: list[dict[str, str]], fallback: str) -> str:
    labelled = [f'“{field["label"]}”{field["reason"]}' for field in fields if field.get("label")]
    if not labelled:
        return fallback
    return "；".join(dict.fromkeys(labelled)) + "。"


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> Response:
    code = load_registry()["validation_code"]
    entry = http_codes()[code]
    fields = _validation_fields(list(exc.errors()))
    return _envelope_response(
        status_code=int(entry["status"]),
        code=code,
        category=entry["category"],
        retryable=bool(entry["retryable"]),
        message=_validation_message(fields, entry["message"]),
        hint=entry["hint"],
        trace_id=request_trace_id(request),
        details={"fields": fields} if fields else None,
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> Response:
    code = fallback_code(500)
    entry = http_codes()[code]
    trace_id = request_trace_id(request)
    logger.exception("未捕获异常 trace_id=%s path=%s", trace_id, request.url.path)
    return _envelope_response(
        status_code=int(entry["status"]),
        code=code,
        category=entry["category"],
        retryable=bool(entry["retryable"]),
        message=entry["message"],
        hint=entry["hint"],
        trace_id=trace_id,
    )


def register_error_handlers(app: Any) -> None:
    app.add_exception_handler(APIError, api_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
