from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.core.config import settings


DIRECT_SKILL_ROOT = settings.agents_dir / "skills"
DEFAULT_TIMEOUT_SECONDS = 30 * 60
API_PROTOCOLS = frozenset({"openai", "anthropic"})
TRANSIENT_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504, 529})
TRANSIENT_RETRY_DELAYS_SECONDS = (2.0, 5.0)


def _safe_skill_path(skill_name: str) -> Path:
    name = str(skill_name or "").strip()
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise ValueError("技能名称无效")
    root = (DIRECT_SKILL_ROOT / name).resolve()
    if not root.is_relative_to(DIRECT_SKILL_ROOT.resolve()):
        raise ValueError("技能路径越界")
    return root


@lru_cache(maxsize=32)
def _load_direct_skill(skill_name: str, excluded_references: tuple[str, ...]) -> str:
    """Load a standalone skill as the system contract for a direct model call."""
    root = _safe_skill_path(skill_name)
    skill_file = root / "SKILL.md"
    if not skill_file.is_file():
        raise RuntimeError(f"独立技能不存在：{skill_name}")
    sections = [f"<skill name=\"{skill_name}\">\n{skill_file.read_text(encoding='utf-8')}\n</skill>"]
    references = root / "references"
    if references.is_dir():
        for path in sorted(references.iterdir(), key=lambda item: item.name):
            if path.name in excluded_references:
                continue
            if path.is_file() and path.suffix.lower() in {".md", ".json", ".json5"}:
                sections.append(
                    f"<skill_reference name=\"{path.name}\">\n{path.read_text(encoding='utf-8')}\n</skill_reference>"
                )
    return "\n\n".join(sections)


def load_direct_skill(skill_name: str, *, exclude_references: tuple[str, ...] = ()) -> str:
    """Load a skill, optionally omitting references duplicated in the request."""
    excluded = tuple(sorted({str(item) for item in exclude_references if str(item).strip()}))
    return _load_direct_skill(skill_name, excluded)


def direct_skill_system_prompt(
    skill_name: str,
    *,
    task_contract: str = "",
    exclude_references: tuple[str, ...] = (),
    supporting_skills: tuple[str, ...] = (),
) -> str:
    task_override = ""
    if task_contract.strip():
        task_override = f"""

本次调用的具体任务模式是：{task_contract.strip()}
任务模式中的输入字段、输出字段和返回格式，以当前用户请求为准。Skill 中针对“单剧蒸馏结果”的输出结构只适用于单剧蒸馏模式；在其他任务模式下，不要强行返回完整的单剧蒸馏 JSON。仍然必须保留 Skill 对证据边界、去重、可迁移性和候选状态的约束。"""
    supporting_contract = ""
    unique_supporting = tuple(dict.fromkeys(
        name.strip() for name in supporting_skills if name.strip() and name.strip() != skill_name
    ))
    if unique_supporting:
        loaded = "\n\n".join(load_direct_skill(name) for name in unique_supporting)
        supporting_contract = f"""

本次任务同时产生多个分阶段结果。以下分阶段 Skill 的业务规范和硬性输出要求同等生效：
{loaded}"""
    return f"""你正在执行一个独立的后台知识处理能力：{skill_name}。

以下内容是该能力的唯一业务规范。它与剧本编写 Agent、项目工作区和任何其他 Claude Code 场景无关，不要引入其他系统提示词、项目偏好或编剧流程。

{load_direct_skill(skill_name, exclude_references=exclude_references)}{supporting_contract}

本次调用由服务端直接提供全部输入，不提供文件系统、命令行、浏览器或其他工具。涉及工具调用的步骤，改为在当前对话中完成同等的确定性工作；不得声称已经调用了无法使用的工具。严格遵守技能中的输出结构、证据边界和校验要求。{task_override}""".strip()


def _completion_url(request_url: str, protocol: str) -> str:
    base = str(request_url or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("独立模型未配置请求地址")
    if protocol == "anthropic":
        if base.endswith("/messages"):
            return base
        # Providers commonly document either the origin or an Anthropic
        # `/v1` base URL. Avoid producing `/v1/v1/messages` for the latter.
        return f"{base}/messages" if base.endswith("/v1") else f"{base}/v1/messages"
    return base if base.endswith("/chat/completions") else f"{base}/chat/completions"


def _api_protocol(runtime: dict[str, Any]) -> str:
    configured = str(runtime.get("api_protocol") or "").strip().lower()
    if configured:
        if configured not in API_PROTOCOLS:
            raise RuntimeError("独立模型调用协议无效")
        return configured
    # Standalone callers historically supplied an OpenAI-compatible runtime
    # without model_type. Persisted Claude Code configurations use Anthropic's
    # Messages protocol when called directly by a peripheral capability.
    return "anthropic" if runtime.get("model_type") == "claude_code" else "openai"


def _thinking_parameters(runtime: dict[str, Any]) -> dict[str, Any]:
    level = str(runtime.get("thinking_level") or "medium").lower()
    model = str(runtime.get("model_name") or "").lower()
    if level == "low":
        return {}
    params: dict[str, Any] = {"reasoning_effort": "high" if level in {"xhigh", "max"} else level}
    if "minimax" in model:
        params["reasoning_split"] = True
    return params


def _request_body(
    *,
    protocol: str,
    system_prompt: str,
    user_prompt: str,
    runtime: dict[str, Any],
) -> dict[str, Any]:
    model = str(runtime.get("model_name") or "").strip()
    try:
        max_tokens = max(256, int(runtime.get("max_tokens") or 32000))
    except (TypeError, ValueError):
        max_tokens = 32000
    stream = bool(runtime.get("stream"))
    if protocol == "anthropic":
        body = {
            "model": model,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
            "max_tokens": max_tokens,
        }
        level = str(runtime.get("thinking_level") or "medium").lower()
        if level != "low":
            budgets = {"medium": 4096, "high": 8192, "xhigh": 12288, "max": 16384}
            configured_budget = runtime.get("thinking_budget_tokens")
            try:
                budget = max(1024, int(configured_budget)) if configured_budget else budgets.get(level, 8192)
            except (TypeError, ValueError):
                budget = budgets.get(level, 8192)
            # Some providers treat `budget_tokens` as an output-token floor and
            # can spend the whole `max_tokens` on hidden reasoning. Reserve room
            # for the requested answer even when a stage lowers `max_tokens`.
            budget = min(budget, max(1_024, max_tokens - 256))
            body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        else:
            # Match the provider's documented Messages example: omit optional
            # thinking controls for a low-effort extraction request.
            body["temperature"] = 0.15
        if stream:
            body["stream"] = True
        return body
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.15,
        "max_tokens": max_tokens,
        **_thinking_parameters(runtime),
    }
    if stream:
        body["stream"] = True
    return body


def _stream_response_text(response) -> str:
    """Collect text deltas from Anthropic/OpenAI-compatible SSE responses."""
    raw_lines: list[str] = []
    text_parts: list[str] = []
    saw_sse = False
    stop_reason = ""
    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
        raw_lines.append(line)
        if not line.startswith("data:"):
            continue
        saw_sse = True
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") in {"message_stop", "response.completed"}:
            break
        if event.get("type") == "message_delta":
            delta = event.get("delta")
            if isinstance(delta, dict):
                stop_reason = str(delta.get("stop_reason") or stop_reason)
        delta = event.get("delta")
        if isinstance(delta, dict) and isinstance(delta.get("text"), str):
            text_parts.append(delta["text"])
            continue
        choices = event.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            choice = choices[0]
            choice_delta = choice.get("delta")
            if isinstance(choice_delta, dict) and isinstance(choice_delta.get("content"), str):
                text_parts.append(choice_delta["content"])
            elif isinstance(choice.get("text"), str):
                text_parts.append(choice["text"])
            continue
        content = event.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    text_parts.append(item["text"])
    text = "".join(text_parts).strip()
    if saw_sse and stop_reason == "max_tokens":
        raise RuntimeError("模型输出达到上限，未返回完整 JSON 正文")
    if saw_sse and not text:
        raise RuntimeError("模型只返回了思考内容，未返回 JSON 正文")
    return text or "".join(raw_lines).strip()


def _fallback_with_overrides(
    fallback: dict[str, Any],
    runtime: dict[str, Any],
) -> dict[str, Any]:
    """Keep the configured fallback settings while carrying stage overrides.

    Extraction stages explicitly disable thinking. That override must reach
    every fallback model; otherwise a fallback can spend its whole output
    budget on hidden reasoning and never emit the requested JSON.
    """
    child = dict(fallback)
    for key in ("stream",):
        if key in runtime:
            child[key] = runtime[key]
    # A stage may explicitly disable thinking for extraction.  Otherwise the
    # fallback keeps its own configured thinking level instead of inheriting
    # the primary provider's setting.
    if runtime.get("_thinking_override"):
        for key in ("thinking_level", "thinking_budget_tokens"):
            if key in runtime:
                child[key] = runtime[key]
    try:
        requested_tokens = max(int(runtime.get("max_tokens") or 0), int(child.get("max_tokens") or 0))
    except (TypeError, ValueError):
        requested_tokens = 0
    if str(child.get("thinking_level") or "").lower() != "low":
        requested_tokens = max(requested_tokens, 32000)
    if requested_tokens:
        child["max_tokens"] = requested_tokens
    if isinstance(child.get("fallback"), dict):
        child["fallback"] = _fallback_with_overrides(child["fallback"], runtime)
    return child


def _content_from_response(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise RuntimeError("模型返回不是 JSON 对象")
    finish_reason = str(payload.get("stop_reason") or "").strip().lower()
    choices = payload.get("choices")
    if not finish_reason and isinstance(choices, list) and choices and isinstance(choices[0], dict):
        finish_reason = str(choices[0].get("finish_reason") or "").strip().lower()
    if finish_reason in {"max_tokens", "length"}:
        raise RuntimeError("模型输出达到上限，未返回完整正文")

    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = [item.get("text", "") for item in content if isinstance(item, dict) and isinstance(item.get("text"), str)]
            if parts:
                return "".join(parts).strip()
    anthropic_content = payload.get("content")
    if isinstance(anthropic_content, list):
        parts = [
            item.get("text", "")
            for item in anthropic_content
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
        ]
        if parts:
            return "".join(parts).strip()
    for key in ("output_text", "text", "content"):
        if isinstance(payload.get(key), str):
            return str(payload[key]).strip()
    raise RuntimeError("模型返回中没有可读取的文本内容")


def extract_json_object(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(text or "").strip(), flags=re.IGNORECASE)
    decoder = json.JSONDecoder()
    for index, char in enumerate(cleaned):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(cleaned[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError("模型返回中没有可解析的 JSON 对象")


def call_direct_model(
    *,
    system_prompt: str,
    user_prompt: str,
    runtime: dict[str, Any] | None,
    log_path: Path,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    _allow_fallback: bool = True,
) -> str:
    config = runtime or {}
    protocol = _api_protocol(config)
    url = _completion_url(str(config.get("request_url") or ""), protocol)
    api_key = str(config.get("api_key") or "").strip()
    if not api_key:
        raise RuntimeError("独立模型未配置 API Key")
    model = str(config.get("model_name") or "").strip()
    if not model:
        raise RuntimeError("独立模型未配置模型名称")
    body = _request_body(
        protocol=protocol,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        runtime=config,
    )
    headers = {
        "Accept": "text/event-stream, application/json" if config.get("stream") else "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key.removeprefix('Bearer ').strip()}",
    }
    if protocol == "anthropic":
        headers.update({"x-api-key": api_key.removeprefix("Bearer ").strip(), "anthropic-version": "2023-06-01"})
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    response_text = ""
    status_code = 0
    attempts: list[dict[str, Any]] = []

    def write_log() -> None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(
            json.dumps(
                {
                    "url": url,
                    "protocol": protocol,
                    "model": model,
                    "stream": bool(config.get("stream")),
                    "max_tokens": body.get("max_tokens"),
                    "status": status_code,
                    "response": response_text,
                    "attempt_count": len(attempts),
                    "attempts": attempts,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def call_fallback_or_raise(error: RuntimeError) -> str:
        fallback = config.get("fallback")
        if _allow_fallback and isinstance(fallback, dict):
            fallback_runtime = _fallback_with_overrides(fallback, config)
            fallback_log = log_path.with_name(f"{log_path.stem}-fallback{log_path.suffix}")
            try:
                return call_direct_model(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    runtime=fallback_runtime,
                    log_path=fallback_log,
                    timeout_seconds=timeout_seconds,
                    _allow_fallback=True,
                )
            except RuntimeError as fallback_error:
                raise RuntimeError(f"{error}；兜底模型也失败：{fallback_error}") from fallback_error
        raise error

    for attempt_index in range(len(TRANSIENT_RETRY_DELAYS_SECONDS) + 1):
        response_text = ""
        status_code = 0
        try:
            with urllib.request.urlopen(request, timeout=max(30, int(timeout_seconds))) as response:
                status_code = int(response.status)
                if config.get("stream"):
                    response_text = _stream_response_text(response)
                else:
                    response_text = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            status_code = int(exc.code)
            response_text = exc.read().decode("utf-8", errors="replace")
            retryable = status_code in TRANSIENT_HTTP_STATUSES
            attempts.append({
                "attempt": attempt_index + 1,
                "status": status_code,
                "retryable": retryable,
                "error": f"HTTP {status_code}",
            })
            write_log()
            if retryable and attempt_index < len(TRANSIENT_RETRY_DELAYS_SECONDS):
                time.sleep(TRANSIENT_RETRY_DELAYS_SECONDS[attempt_index])
                continue
            error = RuntimeError(f"独立模型请求失败（HTTP {status_code}）：{response_text[-1200:]}")
            try:
                return call_fallback_or_raise(error)
            except RuntimeError as final_error:
                raise final_error from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            attempts.append({
                "attempt": attempt_index + 1,
                "status": 0,
                "retryable": True,
                "error": str(exc),
            })
            write_log()
            if attempt_index < len(TRANSIENT_RETRY_DELAYS_SECONDS):
                time.sleep(TRANSIENT_RETRY_DELAYS_SECONDS[attempt_index])
                continue
            error = RuntimeError(f"独立模型请求失败：{exc}")
            try:
                return call_fallback_or_raise(error)
            except RuntimeError as final_error:
                raise final_error from exc
        except RuntimeError as exc:
            attempts.append({
                "attempt": attempt_index + 1,
                "status": status_code,
                "retryable": False,
                "error": str(exc),
            })
            write_log()
            return call_fallback_or_raise(RuntimeError(f"独立模型返回无效：{exc}"))
        attempts.append({
            "attempt": attempt_index + 1,
            "status": status_code,
            "retryable": False,
            "error": "",
        })
        write_log()
        break
    if config.get("stream"):
        # A streaming provider returns the model text directly after SSE
        # assembly. Some compatible gateways ignore `stream` and return the
        # normal envelope, so support both forms.
        try:
            streamed_payload = json.loads(response_text)
        except json.JSONDecodeError:
            return response_text.strip()
        if isinstance(streamed_payload, dict) and (
            isinstance(streamed_payload.get("choices"), list)
            or isinstance(streamed_payload.get("content"), list)
        ):
            try:
                return _content_from_response(streamed_payload)
            except RuntimeError as exc:
                return call_fallback_or_raise(RuntimeError(f"独立模型返回无效：{exc}"))
        return response_text.strip()
    try:
        payload = json.loads(response_text)
    except json.JSONDecodeError as exc:
        try:
            return call_fallback_or_raise(RuntimeError("独立模型返回不是合法 JSON"))
        except RuntimeError as final_error:
            raise final_error from exc
    try:
        return _content_from_response(payload)
    except RuntimeError as exc:
        return call_fallback_or_raise(RuntimeError(f"独立模型返回无效：{exc}"))
