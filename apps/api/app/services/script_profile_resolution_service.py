from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.direct_skill_runner import call_direct_model, extract_json_object
from app.services.script_tag_service import (
    AUTO_ADAPT_TAG,
    TAG_FIELDS,
    TAG_LABELS,
    normalize_tag_values,
    script_profile_errors,
)


MAX_DIRECT_SOURCE_CHARS = 300_000
MAX_PROFILE_REPAIR_ATTEMPTS = 2


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_source_path(workspace: Path, user_input: dict[str, Any]) -> Path:
    project = user_input.get("project") if isinstance(user_input, dict) else None
    source = project.get("source_script") if isinstance(project, dict) else None
    relative = str(source.get("output_path") or "").strip() if isinstance(source, dict) else ""
    if not relative or Path(relative).is_absolute():
        raise RuntimeError("项目缺少可读取的原始材料")
    resolved = (workspace / relative).resolve()
    if not resolved.is_relative_to(workspace.resolve()) or not resolved.is_file():
        raise RuntimeError("项目原始材料不存在或路径无效")
    return resolved


def _current_profile(
    user_input: dict[str, Any],
) -> tuple[dict[str, list[str]], list[str], frozenset[str]]:
    project = user_input.get("project") if isinstance(user_input, dict) else None
    brief = project.get("distribution_brief") if isinstance(project, dict) else None
    if not isinstance(brief, dict):
        raise RuntimeError("发行配置不存在")
    profile = {field: normalize_tag_values(brief.get(field)) for field in TAG_FIELDS}
    inferred_fields = frozenset(
        field
        for field in brief.get("inferred_fields", [])
        if field in TAG_FIELDS
    ) if isinstance(brief.get("inferred_fields"), list) else frozenset()
    user_selected_fields = frozenset(
        field
        for field, values in profile.items()
        if values and AUTO_ADAPT_TAG not in values and field not in inferred_fields
    )
    validation_profile = {
        field: values or [AUTO_ADAPT_TAG]
        for field, values in profile.items()
    }
    errors = script_profile_errors(
        validation_profile,
        allow_auto=True,
        user_selected_fields=user_selected_fields,
    )
    if errors:
        raise RuntimeError("当前剧本标签不符合要求：" + "；".join(errors))
    pending = [field for field in TAG_FIELDS if not profile[field] or AUTO_ADAPT_TAG in profile[field]]
    return profile, pending, user_selected_fields


def _source_for_resolution(source_text: str) -> tuple[str, bool]:
    if len(source_text) <= MAX_DIRECT_SOURCE_CHARS:
        return source_text, False
    segment_count = 10
    segment_size = MAX_DIRECT_SOURCE_CHARS // segment_count
    last_start = len(source_text) - segment_size
    starts = [round(index * last_start / (segment_count - 1)) for index in range(segment_count)]
    excerpts = [
        f"<片段 {index + 1}，原文字符 {start + 1}-{start + segment_size}>\n"
        f"{source_text[start:start + segment_size]}"
        for index, start in enumerate(starts)
    ]
    return "\n\n".join(excerpts), True


def _system_prompt(agents_dir: Path) -> str:
    principles_path = agents_dir / ".claude" / "skills" / "_shared" / "references" / "剧本设定解析原则.md"
    taxonomy_path = agents_dir / ".claude" / "config" / "script-tag-taxonomy.json"
    principles = principles_path.read_text(encoding="utf-8")
    taxonomy = taxonomy_path.read_text(encoding="utf-8")
    return f"""你只负责补全剧本的受众、主题、背景和设定标签，不执行世界观创作。

{principles}

# 受控标签

{taxonomy}

只返回一个 JSON 对象。键只能是请求中列出的待补全字段，值必须是受控标签字符串数组。不得返回解释、Markdown 或已确定字段。"""


def _user_prompt(
    *,
    user_input: dict[str, Any],
    profile: dict[str, list[str]],
    pending: list[str],
    user_selected_fields: frozenset[str],
    source_text: str,
    source_is_excerpted: bool,
    preferences: list[str],
) -> str:
    project = user_input.get("project") or {}
    context = {
        "任务场景": project.get("task_type"),
        "目标地区": project.get("target_region"),
        "用户要求": project.get("extra_requirements") or "",
        "用户偏好": preferences,
        "用户已选择标签": {
            TAG_LABELS[field]: values
            for field, values in profile.items()
            if field in user_selected_fields
        },
        "其他已确定标签": {
            TAG_LABELS[field]: values
            for field, values in profile.items()
            if field not in pending and field not in user_selected_fields
        },
        "待补全字段": pending,
    }
    source_description = (
        "原始材料超过单次读取范围，以下是覆盖开篇、中段和结局的分布式原文片段"
        if source_is_excerpted else "完整原始材料"
    )
    return f"""请根据{source_description}补全待定标签。已确定标签只能作为约束，不得改写；其中用户选择的标签优先级最高。

项目上下文：
{json.dumps(context, ensure_ascii=False, indent=2)}

原始材料：
<source>
{source_text}
</source>"""


def _validate_model_profile(
    response: str,
    *,
    profile: dict[str, list[str]],
    pending: list[str],
    user_selected_fields: frozenset[str],
) -> dict[str, list[str]]:
    payload = extract_json_object(response)
    unexpected = set(payload).difference(pending)
    if unexpected:
        raise RuntimeError("返回了非待补全或未知字段：" + "、".join(sorted(unexpected)))

    final_profile = {field: list(values) for field, values in profile.items()}
    for field in pending:
        values = normalize_tag_values(payload.get(field))
        if not values:
            raise RuntimeError(f"没有返回{TAG_LABELS[field]}")
        final_profile[field] = values
    errors = script_profile_errors(
        final_profile,
        allow_auto=False,
        user_selected_fields=user_selected_fields,
    )
    if errors:
        raise RuntimeError("；".join(errors))
    return final_profile


def _repair_prompt(base_prompt: str, *, response: str, error: str) -> str:
    return f"""{base_prompt}

# 修复上次输出

上次输出未通过标签校验：{error}

上次输出：
<invalid_output>
{response[:4_000]}
</invalid_output>

请重新判断。必须保留所有已确定标签，用户选择的标签优先级最高。只返回全部待补全字段组成的 JSON 对象。"""


def resolve_automatic_script_profile(
    *,
    workspace: Path,
    agents_dir: Path,
    runtime: dict[str, Any] | None,
    updated_by: str,
    job_id: int,
    stage: str = "world_view",
    preferences: list[str] | None = None,
) -> dict[str, Any]:
    workspace = workspace.resolve()
    input_path = workspace / "1.1-user-input.json"
    user_input = json.loads(input_path.read_text(encoding="utf-8"))
    profile, pending, user_selected_fields = _current_profile(user_input)
    if not pending:
        errors = script_profile_errors(
            profile,
            allow_auto=False,
            user_selected_fields=user_selected_fields,
        )
        if errors:
            raise RuntimeError("当前剧本标签不符合要求：" + "；".join(errors))
        return {
            "status": "not_needed",
            "resolved_fields": [],
            "resolved_labels": [],
            "script_profile": profile,
        }

    source_path = _safe_source_path(workspace, user_input)
    source_text = source_path.read_text(encoding="utf-8")
    source_for_resolution, source_is_excerpted = _source_for_resolution(source_text)

    runtime_config = dict(runtime) if isinstance(runtime, dict) else runtime
    if isinstance(runtime_config, dict):
        # The source can be large and GLM may emit hidden reasoning even for
        # low-effort requests. 4k is not enough to leave room for JSON; keep a
        # bounded but practical budget for this direct Messages call.
        runtime_config["max_tokens"] = min(12_000, max(4_000, int(runtime_config.get("max_tokens") or 12_000)))
        # Tag resolution returns a tiny JSON object. High-effort thinking can
        # consume this deliberately small output budget before any answer text.
        runtime_config["thinking_level"] = "low"
        runtime_config["thinking_budget_tokens"] = 0
        runtime_config["_thinking_override"] = True
    stage_key = str(stage or "world_view").strip() or "world_view"
    log_directory = workspace / "runtime" / "jobs" / str(job_id) / stage_key
    base_prompt = _user_prompt(
        user_input=user_input,
        profile=profile,
        pending=pending,
        user_selected_fields=user_selected_fields,
        source_text=source_for_resolution,
        source_is_excerpted=source_is_excerpted,
        preferences=[str(item).strip() for item in preferences or [] if str(item).strip()],
    )
    request_prompt = base_prompt
    final_profile: dict[str, list[str]] | None = None
    attempt_count = 0
    last_error = ""
    for attempt_index in range(MAX_PROFILE_REPAIR_ATTEMPTS + 1):
        attempt_count = attempt_index + 1
        log_name = (
            "script-profile-model.json"
            if attempt_index == 0 else f"script-profile-model-repair-{attempt_index}.json"
        )
        response = call_direct_model(
            system_prompt=_system_prompt(agents_dir),
            user_prompt=request_prompt,
            runtime=runtime_config,
            log_path=log_directory / log_name,
            timeout_seconds=10 * 60,
        )
        try:
            final_profile = _validate_model_profile(
                response,
                profile=profile,
                pending=pending,
                user_selected_fields=user_selected_fields,
            )
            break
        except RuntimeError as exc:
            last_error = str(exc)
            if attempt_index >= MAX_PROFILE_REPAIR_ATTEMPTS:
                raise RuntimeError(
                    f"标签模型连续 {attempt_count} 次未通过校验：{last_error}"
                ) from exc
            request_prompt = _repair_prompt(base_prompt, response=response, error=last_error)
    if final_profile is None:
        raise RuntimeError("标签模型没有生成可用结果")

    project = user_input["project"]
    brief = project["distribution_brief"]
    for field in pending:
        brief[field] = final_profile[field]
    brief["inferred_fields"] = list(dict.fromkeys([
        *(brief.get("inferred_fields") if isinstance(brief.get("inferred_fields"), list) else []),
        *pending,
    ]))
    resolved_at = _now()
    brief["script_profile_resolution"] = {
        "stage": "project_preprocess",
        "resolved_fields": pending,
        "resolved_at": resolved_at,
        "resolved_by": updated_by,
    }
    user_input["audit"] = {
        **(user_input.get("audit") if isinstance(user_input.get("audit"), dict) else {}),
        "updated_at": resolved_at,
        "updated_by": updated_by,
    }
    temporary = input_path.with_name(f".{input_path.name}.{job_id}.tmp")
    try:
        temporary.write_text(json.dumps(user_input, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(input_path)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "status": "resolved",
        "resolved_fields": pending,
        "resolved_labels": [TAG_LABELS[field] for field in pending],
        "script_profile": final_profile,
        "source_file": str(source_path),
        "source_excerpted": source_is_excerpted,
        "attempt_count": attempt_count,
    }
