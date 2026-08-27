from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Any, Callable

from app.services.direct_skill_runner import (
    call_direct_model,
    direct_skill_system_prompt,
    extract_json_object,
)
from app.services.script_knowledge_service import (
    CREATIVE_STAGES,
    distillation_stage_schema,
    validate_case_card_stage,
    validate_distillation,
    validate_formula_stage,
    validate_principle_stage,
)
from app.services.script_tag_service import tag_taxonomy
from app.services.script_source_normalization import model_readable_source, source_terms_found_in_text


PIPELINE_VERSION = "script-distillation-pipeline-v4"
SOURCE_PREPARATION_VERSION = "pdf-source-v2"
EVIDENCE_BATCH_MAX_CHARS = 36000
EVIDENCE_BATCH_MAX_CHUNKS = 10
CONSOLIDATION_INPUT_MAX_CHARS = 90000
# A model task gets one initial request and at most two repair requests.  Keep
# this limit in the pipeline instead of relying on provider-specific retries.
MODEL_RETRY_LIMIT = 2
STAGE_VALIDATION_ATTEMPTS = MODEL_RETRY_LIMIT + 1
STAGE_REQUEST_TIMEOUT_SECONDS = 15 * 60

STAGE_LABELS = {
    "source_facts": "读取原文",
    "fact_index": "整理全剧事实",
    "case_card": "整理案例卡",
    "formula": "提炼公式候选",
    "principle": "提炼创作原则",
    "review": "检查蒸馏结果",
    "catalog": "归档知识",
}


def _json(value: Any, *, indent: int | None = None) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":") if indent is None else None, indent=indent)


def _strict_object(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _text_schema(minimum: int = 1, maximum: int = 800) -> dict[str, Any]:
    return {"type": "string", "minLength": minimum, "maxLength": maximum}


def _array_schema(items: dict[str, Any], minimum: int = 0, maximum: int = 20) -> dict[str, Any]:
    return {"type": "array", "items": items, "minItems": minimum, "maxItems": maximum}


EVIDENCE_REFS_SCHEMA = _array_schema({"type": "string", "pattern": "^C[0-9]{4,}$"}, 1, 16)
STRING_LIST_SCHEMA = _array_schema(_text_schema(1, 500), 0, 16)

SEGMENT_FACT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **_strict_object({
        "covered_chunk_ids": _array_schema({"type": "string", "pattern": "^C[0-9]{4,}$"}, 1, 20),
        "characters": _array_schema(_strict_object({
            "name": _text_schema(1, 40),
            "actions": _array_schema(_text_schema(4, 400), 1, 8),
            "goals_or_pressure": _text_schema(2, 500),
            "resources_or_information": _text_schema(2, 500),
            "state_change": _text_schema(2, 500),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 0, 16),
        "events": _array_schema(_strict_object({
            "event": _text_schema(6, 600),
            "cause": _text_schema(2, 500),
            "consequence": _text_schema(2, 500),
            "characters": _array_schema(_text_schema(1, 40), 0, 8),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 1, 24),
        "relationships": _array_schema(_strict_object({
            "parties": _array_schema(_text_schema(1, 40), 2, 4),
            "change": _text_schema(4, 500),
            "trigger": _text_schema(4, 500),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 0, 12),
        "world_rules": _array_schema(_strict_object({
            "rule": _text_schema(4, 500),
            "effect_or_cost": _text_schema(4, 500),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 0, 10),
        "payoff_beats": _array_schema(_strict_object({
            "beat": _text_schema(4, 500),
            "function": _text_schema(4, 500),
            "story_change": _text_schema(4, 500),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 0, 12),
        "craft_observations": _array_schema(_strict_object({
            "creative_problem": _text_schema(8, 600),
            "setup": _text_schema(8, 600),
            "author_choice": _text_schema(8, 600),
            "story_change": _text_schema(8, 600),
            "audience_effect_hypothesis": _text_schema(8, 600),
            "boundary": _text_schema(8, 600),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 0, 10),
        "source_terms": _array_schema(_text_schema(1, 80), 0, 20),
        "open_questions": STRING_LIST_SCHEMA,
    }),
}

FACT_INDEX_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **_strict_object({
        "covered_chunk_ids": _array_schema({"type": "string", "pattern": "^C[0-9]{4,}$"}, 1, 5000),
        "story_summary": _text_schema(40, 1600),
        "chronology": _array_schema(_strict_object({
            "phase": _text_schema(2, 40),
            "event": _text_schema(8, 700),
            "cause": _text_schema(4, 600),
            "consequence": _text_schema(4, 600),
            "characters": _array_schema(_text_schema(1, 40), 0, 8),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 3, 40),
        "characters": _array_schema(_strict_object({
            "name": _text_schema(1, 40),
            "dramatic_role": _text_schema(4, 400),
            "desire": _text_schema(4, 500),
            "pressure_or_misbelief": _text_schema(4, 500),
            "resources_and_information": _text_schema(4, 500),
            "opening_state": _text_schema(4, 500),
            "decisive_actions": _array_schema(_text_schema(4, 500), 1, 8),
            "ending_state": _text_schema(4, 500),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 2, 16),
        "relationships": _array_schema(_strict_object({
            "parties": _array_schema(_text_schema(1, 40), 2, 4),
            "opening_state": _text_schema(4, 500),
            "change_chain": _text_schema(8, 800),
            "ending_state": _text_schema(4, 500),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 1, 16),
        "world_rules": _array_schema(_strict_object({
            "rule": _text_schema(4, 500),
            "resource_or_limit": _text_schema(4, 500),
            "violation_cost": _text_schema(4, 500),
            "story_function": _text_schema(4, 500),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 0, 12),
        "payoff_chains": _array_schema(_strict_object({
            "payoff_type": _text_schema(1, 40),
            "setup": _text_schema(4, 600),
            "pressure": _text_schema(4, 600),
            "release": _text_schema(4, 600),
            "story_consequence": _text_schema(4, 600),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 2, 16),
        "craft_observations": _array_schema(_strict_object({
            "fact_id": {"type": "string", "pattern": "^E[0-9]{2,}$"},
            "creative_problem": _text_schema(8, 600),
            "setup": _text_schema(8, 600),
            "author_choice": _text_schema(8, 600),
            "story_change": _text_schema(8, 600),
            "audience_effect_hypothesis": _text_schema(8, 600),
            "boundary": _text_schema(8, 600),
            "evidence_references": EVIDENCE_REFS_SCHEMA,
        }), 3, 20),
        "source_terms": _array_schema(_text_schema(1, 80), 1, 30),
        "open_questions": STRING_LIST_SCHEMA,
    }),
}

REVIEW_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **_strict_object({
        "approved": {"type": "boolean"},
        "summary": _text_schema(8, 500),
        "issues": _array_schema(_strict_object({
            "stage": {"type": "string", "enum": ["case_card", "formula", "principle"]},
            "problem": _text_schema(8, 600),
            "repair_instruction": _text_schema(8, 600),
            "evidence_references": _array_schema({"type": "string", "pattern": "^C[0-9]{4,}$"}, 0, 12),
        }), 0, 8),
    }),
}


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_json(value, indent=2) + "\n", encoding="utf-8")


def _checkpoint_fingerprint(task_name: str, payload: dict[str, Any]) -> str:
    value = _json({"pipeline_version": PIPELINE_VERSION, "task_name": task_name, "payload": payload})
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _checkpoint_fingerprint_path(path: Path) -> Path:
    return path.with_name(f"{path.stem}.input.sha256")


def _failure_checkpoint_path(path: Path) -> Path:
    return path.with_name(f"{path.stem}.failure.json")


def _load_stage_failure(
    work_dir: Path,
    previous_work_dirs: list[Path],
    relative: Path,
    *,
    task_name: str,
    payload: dict[str, Any],
) -> str:
    """Return the last failed-call error for an identical stage input.

    A new job must be able to tell the model why the previous job stopped.  We
    only reuse an error when the input fingerprint is identical; stale errors
    from another source or another stage would bias the repair request.
    """
    fingerprint = _checkpoint_fingerprint(task_name, payload)
    target = _failure_checkpoint_path(work_dir / relative)
    candidates = [target, *(_failure_checkpoint_path(directory / relative) for directory in previous_work_dirs)]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            value = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict) or value.get("task_name") != task_name:
            continue
        if value.get("input_fingerprint") != fingerprint:
            continue
        error = str(value.get("error") or "").strip()
        if error:
            return error
    return ""


def _restore_failure_checkpoints(work_dir: Path, previous_work_dirs: list[Path]) -> None:
    """Bring failure notes into a new retry directory without overwriting it."""
    work_dir.mkdir(parents=True, exist_ok=True)
    for directory in previous_work_dirs:
        if not directory.is_dir():
            continue
        for source in directory.rglob("*.failure.json"):
            try:
                relative = source.relative_to(directory)
                target = work_dir / relative
                if not target.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
            except (OSError, ValueError):
                continue


def _load_completed_pipeline_result(
    work_dir: Path,
    previous_work_dirs: list[Path],
    *,
    validator: Callable[[Any], dict[str, Any]],
    source_sha256: str,
    chunk_count: int,
) -> dict[str, Any] | None:
    """Reuse a fully validated pipeline result when only cataloging failed.

    The staged pipeline writes ``pipeline.json`` before formula/principle
    cataloging.  If cataloging fails, reading the source and all stages again
    is unnecessary; this checkpoint is the continuation boundary.
    """
    target_dir = work_dir
    directories = [work_dir, *previous_work_dirs]
    for directory in directories:
        result_path = directory / "result.json"
        metadata_path = directory / "pipeline.json"
        if not result_path.is_file() or not metadata_path.is_file():
            continue
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict):
                continue
            if metadata.get("version") != PIPELINE_VERSION or metadata.get("completed") is not True:
                continue
            if str(metadata.get("source_sha256") or "") != source_sha256:
                continue
            if int(metadata.get("chunk_count") or 0) != chunk_count:
                continue
            result = validator(_load_json(result_path))
        except (OSError, RuntimeError, json.JSONDecodeError, TypeError, ValueError):
            continue
        if directory != target_dir:
            target_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(result_path, target_dir / "result.json")
            shutil.copy2(metadata_path, target_dir / "pipeline.json")
        return result
    return None


def _fact_index_schema(*, require_full_coverage: bool, source_term_minimum: int = 1) -> dict[str, Any]:
    schema = json.loads(json.dumps(FACT_INDEX_SCHEMA))
    properties = schema["properties"]
    properties["chronology"]["minItems"] = 3 if require_full_coverage else 1
    properties["characters"]["minItems"] = 2 if require_full_coverage else 1
    properties["payoff_chains"]["minItems"] = 2 if require_full_coverage else 1
    properties["craft_observations"]["minItems"] = 3 if require_full_coverage else 1
    properties["source_terms"]["minItems"] = source_term_minimum if require_full_coverage else 1
    return schema


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"检查点不是 JSON 对象：{path.name}")
    return value


def _clean_text(value: Any, *, label: str, minimum: int = 1, maximum: int = 1600) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())[:maximum]
    if len(text) < minimum:
        raise RuntimeError(f"{label}过于简略")
    return text


def _string_list(
    value: Any,
    *,
    label: str,
    minimum: int = 0,
    maximum: int = 30,
    item_minimum: int = 1,
) -> list[str]:
    if not isinstance(value, list):
        raise RuntimeError(f"{label}必须是数组")
    result: list[str] = []
    for raw in value[:maximum]:
        item = re.sub(r"\s+", " ", str(raw or "").strip())[:800]
        if len(item) < item_minimum:
            raise RuntimeError(f"{label}存在过于简略的内容")
        if item not in result:
            result.append(item)
    if len(result) < minimum:
        raise RuntimeError(f"{label}至少需要 {minimum} 项")
    return result


def _records(value: Any, *, label: str, minimum: int = 0, maximum: int = 40) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise RuntimeError(f"{label}必须是对象数组")
    if not minimum <= len(value) <= maximum:
        raise RuntimeError(f"{label}数量应在 {minimum}-{maximum} 项之间")
    return value


def _evidence(value: Any, valid_ids: set[str], *, label: str, minimum: int = 1) -> list[str]:
    refs = _string_list(value, label=label, minimum=minimum, maximum=24, item_minimum=5)
    invalid = [item for item in refs if item not in valid_ids]
    if invalid:
        raise RuntimeError(f"{label}包含无效证据：{'、'.join(invalid)}")
    return refs


def _validate_segment_facts(payload: Any, expected_ids: list[str]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("分段事实不是有效对象")
    valid_ids = set(expected_ids)
    covered = _string_list(payload.get("covered_chunk_ids"), label="已读证据块", minimum=1, maximum=50)
    if covered != expected_ids:
        raise RuntimeError("分段事实没有按顺序覆盖本次提供的全部证据块")
    result: dict[str, Any] = {"covered_chunk_ids": covered}
    specs = {
        "characters": (0, 16, ("name", "goals_or_pressure", "resources_or_information", "state_change")),
        "events": (1, 24, ("event", "cause", "consequence")),
        "relationships": (0, 12, ("change", "trigger")),
        "world_rules": (0, 10, ("rule", "effect_or_cost")),
        "payoff_beats": (0, 12, ("beat", "function", "story_change")),
        "craft_observations": (
            0,
            10,
            ("creative_problem", "setup", "author_choice", "story_change", "audience_effect_hypothesis", "boundary"),
        ),
    }
    for field, (minimum, maximum, text_fields) in specs.items():
        items = []
        for index, item in enumerate(_records(payload.get(field), label=field, minimum=minimum, maximum=maximum), start=1):
            normalized = {name: _clean_text(item.get(name), label=f"{field}[{index}].{name}", minimum=1, maximum=800) for name in text_fields}
            if field == "characters":
                normalized["actions"] = _string_list(item.get("actions"), label=f"{field}[{index}].actions", minimum=1, maximum=8, item_minimum=2)
            if field == "events":
                normalized["characters"] = _string_list(item.get("characters"), label=f"{field}[{index}].characters", maximum=8)
            if field == "relationships":
                normalized["parties"] = _string_list(item.get("parties"), label=f"{field}[{index}].parties", minimum=2, maximum=4)
            normalized["evidence_references"] = _evidence(item.get("evidence_references"), valid_ids, label=f"{field}[{index}]证据")
            items.append(normalized)
        result[field] = items
    result["source_terms"] = _string_list(payload.get("source_terms"), label="原文专名", maximum=20)
    result["open_questions"] = _string_list(payload.get("open_questions"), label="疑点", maximum=16)
    return result


def _validate_fact_index(
    payload: Any,
    expected_ids: set[str],
    *,
    require_full_coverage: bool,
    source_term_minimum: int = 1,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("全剧事实索引不是有效对象")
    covered = _string_list(payload.get("covered_chunk_ids"), label="事实索引证据范围", minimum=1, maximum=5000)
    if set(covered) != expected_ids or len(covered) != len(expected_ids):
        raise RuntimeError("事实索引没有覆盖输入中的全部证据块")
    ordered = sorted(covered, key=lambda item: int(item[1:]))
    if covered != ordered:
        raise RuntimeError("事实索引的证据编号没有按原文顺序排列")
    result: dict[str, Any] = {
        "covered_chunk_ids": covered,
        "story_summary": _clean_text(payload.get("story_summary"), label="事实摘要", minimum=40),
    }
    text_specs = {
        "chronology": (3 if require_full_coverage else 1, 40, ("phase", "event", "cause", "consequence")),
        "characters": (2 if require_full_coverage else 1, 16, ("name", "dramatic_role", "desire", "pressure_or_misbelief", "resources_and_information", "opening_state", "ending_state")),
        "relationships": (1, 16, ("opening_state", "change_chain", "ending_state")),
        "world_rules": (0, 12, ("rule", "resource_or_limit", "violation_cost", "story_function")),
        "payoff_chains": (2 if require_full_coverage else 1, 16, ("payoff_type", "setup", "pressure", "release", "story_consequence")),
        "craft_observations": (3 if require_full_coverage else 1, 20, ("creative_problem", "setup", "author_choice", "story_change", "audience_effect_hypothesis", "boundary")),
    }
    for field, (minimum, maximum, fields) in text_specs.items():
        values = []
        for index, item in enumerate(_records(payload.get(field), label=field, minimum=minimum, maximum=maximum), start=1):
            normalized = {name: _clean_text(item.get(name), label=f"{field}[{index}].{name}", minimum=1, maximum=1000) for name in fields}
            if field in {"chronology", "characters"}:
                normalized["characters" if field == "chronology" else "decisive_actions"] = _string_list(
                    item.get("characters" if field == "chronology" else "decisive_actions"),
                    label=f"{field}[{index}]列表",
                    minimum=0 if field == "chronology" else 1,
                    maximum=8,
                    item_minimum=1,
                )
            if field == "relationships":
                normalized["parties"] = _string_list(item.get("parties"), label=f"{field}[{index}].parties", minimum=2, maximum=4)
            if field == "craft_observations":
                normalized["fact_id"] = f"E{index:02d}"
            normalized["evidence_references"] = _evidence(item.get("evidence_references"), expected_ids, label=f"{field}[{index}]证据")
            values.append(normalized)
        result[field] = values
    minimum_terms = source_term_minimum if require_full_coverage else 1
    result["source_terms"] = _string_list(payload.get("source_terms"), label="事实索引原文专名", minimum=minimum_terms, maximum=30)
    result["open_questions"] = _string_list(payload.get("open_questions"), label="事实索引疑点", maximum=16)
    if require_full_coverage:
        referenced = {
            ref
            for field in ("chronology", "characters", "relationships", "world_rules", "payoff_chains", "craft_observations")
            for item in result[field]
            for ref in item["evidence_references"]
        }
        indexes = {int(item[1:]) for item in referenced}
        count = len(expected_ids)
        if count >= 3 and not (any(index <= max(1, count // 4) for index in indexes) and any(count // 4 < index < max(3, count * 3 // 4) for index in indexes) and any(index >= max(2, count * 3 // 4) for index in indexes)):
            raise RuntimeError("全剧事实索引的内容证据没有覆盖开篇、中段和结局")
    return result


def _validate_review(payload: Any, valid_ids: set[str]) -> dict[str, Any]:
    if not isinstance(payload, dict) or not isinstance(payload.get("approved"), bool):
        raise RuntimeError("审稿结论缺少 approved")
    issues = []
    for index, item in enumerate(_records(payload.get("issues"), label="审稿问题", maximum=8), start=1):
        stage = str(item.get("stage") or "")
        if stage not in {"case_card", "formula", "principle"}:
            raise RuntimeError(f"第 {index} 条审稿问题的返修阶段无效")
        issues.append({
            "stage": stage,
            "problem": _clean_text(item.get("problem"), label=f"第 {index} 条问题", minimum=8, maximum=600),
            "repair_instruction": _clean_text(item.get("repair_instruction"), label=f"第 {index} 条修复要求", minimum=8, maximum=600),
            "evidence_references": _evidence(item.get("evidence_references"), valid_ids, label=f"第 {index} 条问题证据", minimum=0),
        })
    approved = bool(payload["approved"])
    if approved and issues:
        raise RuntimeError("审稿通过时不能同时返回阻断问题")
    if not approved and not issues:
        raise RuntimeError("审稿不通过时必须说明需要返修的问题")
    return {
        "approved": approved,
        "summary": _clean_text(payload.get("summary"), label="审稿摘要", minimum=8, maximum=500),
        "issues": issues,
    }


def _stage_runtime(model_runtime: dict[str, Any] | None, *, max_tokens: int, extraction: bool = False) -> dict[str, Any] | None:
    if not isinstance(model_runtime, dict):
        return model_runtime
    runtime = dict(model_runtime)
    runtime["stream"] = True
    runtime["max_tokens"] = max_tokens
    if extraction:
        runtime["thinking_level"] = "low"
        runtime["thinking_budget_tokens"] = 0
        runtime["_thinking_override"] = True
    return runtime


def _call_stage(
    *,
    skill_name: str,
    task_name: str,
    payload: dict[str, Any],
    schema: dict[str, Any],
    validator: Callable[[Any], dict[str, Any]],
    runtime: dict[str, Any] | None,
    output_path: Path,
    max_tokens: int,
    extraction: bool = False,
    repair_notes: list[dict[str, Any]] | None = None,
    retry_error: str = "",
) -> dict[str, Any]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not retry_error:
        failure_path = _failure_checkpoint_path(output_path)
        if failure_path.is_file():
            try:
                failure = json.loads(failure_path.read_text(encoding="utf-8"))
                if (
                    isinstance(failure, dict)
                    and failure.get("task_name") == task_name
                    and failure.get("input_fingerprint") == _checkpoint_fingerprint(task_name, payload)
                ):
                    retry_error = str(failure.get("error") or "").strip()
            except (OSError, json.JSONDecodeError):
                pass
    system_prompt = direct_skill_system_prompt(skill_name, task_contract=task_name)
    input_text = _json(payload)
    schema_text = _json(schema)
    prompt = (
        f"执行阶段：{task_name}\n"
        "只返回一个符合 JSON Schema 的 JSON 对象，不要返回 Markdown、解释或代码围栏。\n"
        f"JSON Schema：\n{schema_text}\n\n"
        f"阶段输入：\n{input_text}"
    )
    if extraction:
        prompt += (
            "\n\n这是分段事实提取。`covered_chunk_ids` 必须是 JSON 字符串数组，"
            "只能逐字复制本次输入的 chunk_ids，不能改成对象、字符串或数组包对象；"
            "所有 evidence_references 也必须是 JSON 字符串数组。"
        )
    if repair_notes:
        prompt += f"\n\n上一次审稿要求本阶段返修：\n{_json(repair_notes)}"
    if retry_error:
        prompt += (
            "\n\n上一次任务在本阶段失败。请根据下面的错误信息修复后重新返回完整对象，"
            "不要跳过本阶段，也不要修改输入事实：\n"
            f"{retry_error}\n"
        )
    last_error = ""
    previous: dict[str, Any] | None = None
    for attempt in range(STAGE_VALIDATION_ATTEMPTS):
        request_prompt = prompt
        if attempt and last_error:
            request_prompt += (
                "\n\n上一次返回未通过确定性校验。只修复下列问题并返回完整对象：\n"
                f"{last_error}\n"
            )
            if previous is not None:
                request_prompt += f"上一次返回：\n{_json(previous)}"
        try:
            response = call_direct_model(
                system_prompt=system_prompt,
                user_prompt=request_prompt,
                runtime=_stage_runtime(runtime, max_tokens=max_tokens, extraction=extraction),
                log_path=output_path.with_name(f"{output_path.stem}.attempt-{attempt + 1}.log"),
                timeout_seconds=STAGE_REQUEST_TIMEOUT_SECONDS,
            )
            output_path.with_name(f"{output_path.stem}.attempt-{attempt + 1}.txt").write_text(response, encoding="utf-8")
            previous = extract_json_object(response)
            result = validator(previous)
            _write_json(output_path, result)
            _checkpoint_fingerprint_path(output_path).write_text(
                _checkpoint_fingerprint(task_name, payload) + "\n",
                encoding="utf-8",
            )
            _failure_checkpoint_path(output_path).unlink(missing_ok=True)
            return result
        except Exception as exc:
            last_error = str(exc).strip() or exc.__class__.__name__
    _write_json(
        _failure_checkpoint_path(output_path),
        {
            "task_name": task_name,
            "input_fingerprint": _checkpoint_fingerprint(task_name, payload),
            "error": last_error,
            "retry_limit": MODEL_RETRY_LIMIT,
        },
    )
    raise RuntimeError(f"{task_name}未通过校验（已重试 {MODEL_RETRY_LIMIT} 次）：{last_error}")


def _chunk_batches(indexed_chunks: list[dict[str, str]]) -> list[list[dict[str, str]]]:
    batches: list[list[dict[str, str]]] = []
    current: list[dict[str, str]] = []
    size = 0
    for chunk in indexed_chunks:
        chunk_size = len(chunk["content"])
        if current and (size + chunk_size > EVIDENCE_BATCH_MAX_CHARS or len(current) >= EVIDENCE_BATCH_MAX_CHUNKS):
            batches.append(current)
            current = []
            size = 0
        current.append(chunk)
        size += chunk_size
    if current:
        batches.append(current)
    return batches


def _checkpoint_candidates(work_dir: Path, previous_work_dirs: list[Path], relative: Path) -> list[Path]:
    return [work_dir / relative, *(directory / relative for directory in previous_work_dirs)]


def _load_checkpoint(
    work_dir: Path,
    previous_work_dirs: list[Path],
    relative: Path,
    validator: Callable[[Any], dict[str, Any]],
    *,
    fingerprint: str,
) -> dict[str, Any] | None:
    target = work_dir / relative
    for candidate in _checkpoint_candidates(work_dir, previous_work_dirs, relative):
        if not candidate.is_file():
            continue
        try:
            stored_fingerprint = _checkpoint_fingerprint_path(candidate).read_text(encoding="utf-8").strip()
            if stored_fingerprint != fingerprint:
                continue
            value = validator(_load_json(candidate))
        except (OSError, RuntimeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            continue
        if candidate != target:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate, target)
            _checkpoint_fingerprint_path(target).write_text(fingerprint + "\n", encoding="utf-8")
        return value
    return None


def _set_progress(
    conn: sqlite3.Connection,
    *,
    script_id: int,
    stage: str,
    completed: int,
    total: int,
    message: str,
) -> None:
    conn.execute(
        """
        UPDATE script_library_scripts
        SET distillation_stage = ?, distillation_stage_label = ?,
            distillation_progress_current = ?, distillation_progress_total = ?,
            distillation_progress_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (stage, STAGE_LABELS[stage], completed, total, message, script_id),
    )
    conn.commit()


def _consolidate_facts(
    *,
    inputs: list[dict[str, Any]],
    runtime: dict[str, Any] | None,
    work_dir: Path,
    previous_work_dirs: list[Path],
    all_chunk_ids: set[str],
    source_term_minimum: int,
) -> dict[str, Any]:
    nodes = inputs
    round_index = 1
    while len(nodes) > 1 and len(_json(nodes)) > CONSOLIDATION_INPUT_MAX_CHARS:
        groups: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        current_size = 0
        for node in nodes:
            size = len(_json(node))
            if current and current_size + size > CONSOLIDATION_INPUT_MAX_CHARS:
                groups.append(current)
                current = []
                current_size = 0
            current.append(node)
            current_size += size
        if current:
            groups.append(current)
        if len(groups) >= len(nodes):
            groups = [nodes[index:index + 2] for index in range(0, len(nodes), 2)]
        next_nodes: list[dict[str, Any]] = []
        for group_index, group in enumerate(groups, start=1):
            covered = {item for node in group for item in node["covered_chunk_ids"]}
            relative = Path("facts") / f"round-{round_index:02d}-part-{group_index:02d}.json"
            stage_payload = {
                "source_preparation_version": SOURCE_PREPARATION_VERSION,
                "partial": True,
                "fact_records": group,
            }
            result = _load_checkpoint(
                work_dir,
                previous_work_dirs,
                relative,
                lambda value, covered=covered: _validate_fact_index(value, covered, require_full_coverage=False),
                fingerprint=_checkpoint_fingerprint("partial_fact_consolidation", stage_payload),
            )
            if result is None:
                result = _call_stage(
                    skill_name="script-fact-consolidation",
                    task_name="partial_fact_consolidation",
                    payload=stage_payload,
                    schema=_fact_index_schema(require_full_coverage=False),
                    validator=lambda value, covered=covered: _validate_fact_index(value, covered, require_full_coverage=False),
                    runtime=runtime,
                    output_path=work_dir / relative,
                    max_tokens=12000,
                    extraction=True,
                )
            next_nodes.append(result)
        nodes = next_nodes
        round_index += 1

    final_relative = Path("facts.json")
    final_payload = {
        "source_preparation_version": SOURCE_PREPARATION_VERSION,
        "partial": False,
        "fact_records": nodes,
    }
    result = _load_checkpoint(
        work_dir,
        previous_work_dirs,
        final_relative,
        lambda value: _validate_fact_index(
            value,
            all_chunk_ids,
            require_full_coverage=True,
            source_term_minimum=source_term_minimum,
        ),
        fingerprint=_checkpoint_fingerprint("full_fact_consolidation", final_payload),
    )
    if result is not None:
        return result
    return _call_stage(
        skill_name="script-fact-consolidation",
        task_name="full_fact_consolidation",
        payload=final_payload,
        schema=_fact_index_schema(
            require_full_coverage=True,
            source_term_minimum=source_term_minimum,
        ),
        validator=lambda value: _validate_fact_index(
            value,
            all_chunk_ids,
            require_full_coverage=True,
            source_term_minimum=source_term_minimum,
        ),
        runtime=runtime,
        output_path=work_dir / final_relative,
        max_tokens=14000,
        extraction=True,
    )


def run_distillation_pipeline(
    *,
    conn: sqlite3.Connection,
    job_id: int,
    script: sqlite3.Row,
    indexed_chunks: list[dict[str, str]],
    model_runtime: dict[str, Any] | None,
    work_dir: Path,
    previous_work_dirs: list[Path],
    case_only: bool = False,
) -> dict[str, Any]:
    if not indexed_chunks:
        raise RuntimeError("剧本没有可读取的原文证据块")
    work_dir.mkdir(parents=True, exist_ok=True)
    _restore_failure_checkpoints(work_dir, previous_work_dirs)
    script_id = int(script["id"])
    all_chunk_ids = {chunk["id"] for chunk in indexed_chunks}
    canonical_source = "\n\n".join(chunk["raw_content"] for chunk in indexed_chunks)
    source_sha256 = hashlib.sha256(canonical_source.encode("utf-8")).hexdigest()
    source_term_minimum = 4 if len(re.sub(r"\s+", "", canonical_source)) >= 1000 else 1
    indexed_source = "\n\n".join(
        f"<!-- {chunk['id']} | {chunk['locator']} -->\n{chunk['raw_content']}" for chunk in indexed_chunks
    ) + "\n"
    (work_dir / "indexed-source.md").write_text(indexed_source, encoding="utf-8")
    model_chunks = [
        {**chunk, "content": model_readable_source(chunk["content"])}
        for chunk in indexed_chunks
    ]
    batches = _chunk_batches(model_chunks)
    total_steps = len(batches) + 6
    cached_pipeline_result = _load_completed_pipeline_result(
        work_dir,
        previous_work_dirs,
        validator=lambda value: validate_distillation(
            value,
            all_chunk_ids,
            source_text=indexed_source,
            expected_title=str(script["title"]),
            expected_sha256=source_sha256,
        ),
        source_sha256=source_sha256,
        chunk_count=len(all_chunk_ids),
    )
    if cached_pipeline_result is not None:
        _set_progress(
            conn,
            script_id=script_id,
            stage="catalog",
            completed=len(batches) + 5,
            total=total_steps,
            message="已复用完成的蒸馏结果，继续归档知识",
        )
        return cached_pipeline_result
    segment_results: list[dict[str, Any]] = []

    for index, batch in enumerate(batches, start=1):
        ids = [chunk["id"] for chunk in batch]
        relative = Path("evidence") / f"part-{index:03d}.json"
        _set_progress(
            conn,
            script_id=script_id,
            stage="source_facts",
            completed=index - 1,
            total=total_steps,
            message=f"正在阅读原文第 {index}/{len(batches)} 段",
        )
        result = _load_checkpoint(
            work_dir,
            previous_work_dirs,
            relative,
            lambda value, ids=ids: _validate_segment_facts(value, ids),
            fingerprint=_checkpoint_fingerprint(
                "segment_evidence_extraction",
                {
                    "source_preparation_version": SOURCE_PREPARATION_VERSION,
                    "title": str(script["title"]),
                    "chunk_ids": ids,
                    "evidence": "\n\n".join(
                        f"<!-- {chunk['id']} | {chunk['locator']} -->\n{chunk['content']}" for chunk in batch
                    ),
                },
            ),
        )
        if result is None:
            evidence_text = "\n\n".join(
                f"<!-- {chunk['id']} | {chunk['locator']} -->\n{chunk['content']}" for chunk in batch
            )
            result = _call_stage(
                skill_name="script-evidence-extraction",
                task_name="segment_evidence_extraction",
                payload={
                    "source_preparation_version": SOURCE_PREPARATION_VERSION,
                    "title": str(script["title"]),
                    "chunk_ids": ids,
                    "evidence": evidence_text,
                },
                schema=SEGMENT_FACT_SCHEMA,
                validator=lambda value, ids=ids: _validate_segment_facts(value, ids),
                runtime=model_runtime,
                output_path=work_dir / relative,
                max_tokens=9000,
                extraction=True,
            )
        segment_results.append(result)

    _set_progress(
        conn,
        script_id=script_id,
        stage="fact_index",
        completed=len(batches),
        total=total_steps,
        message="正在合并人物、事件和关系事实",
    )
    facts = _consolidate_facts(
        inputs=segment_results,
        runtime=model_runtime,
        work_dir=work_dir,
        previous_work_dirs=previous_work_dirs,
        all_chunk_ids=all_chunk_ids,
        source_term_minimum=source_term_minimum,
    )
    case_fact_index = {
        **facts,
        "source_terms": source_terms_found_in_text(facts["source_terms"], indexed_source),
    }

    def run_case(
        repair_notes: list[dict[str, Any]] | None = None,
        *,
        force: bool = False,
    ) -> dict[str, Any]:
        relative = Path("case-card.json")
        stage_payload = {
            "title": str(script["title"]),
            "tag_taxonomy": tag_taxonomy(),
            "fact_index": case_fact_index,
        }
        if not repair_notes and not force:
            cached = _load_checkpoint(
                work_dir,
                previous_work_dirs,
                relative,
                lambda value: validate_case_card_stage(
                    value,
                    all_chunk_ids,
                    source_text=indexed_source,
                    allowed_source_terms=case_fact_index["source_terms"],
                ),
                fingerprint=_checkpoint_fingerprint("case_card_and_tags", stage_payload),
            )
            if cached is not None:
                return cached
        return _call_stage(
            skill_name="script-case-card",
            task_name="case_card_and_tags",
            payload=stage_payload,
            schema=distillation_stage_schema("case_card"),
            validator=lambda value: validate_case_card_stage(
                value,
                all_chunk_ids,
                source_text=indexed_source,
                allowed_source_terms=case_fact_index["source_terms"],
            ),
            runtime=model_runtime,
            output_path=work_dir / relative,
            max_tokens=15000,
            repair_notes=repair_notes,
        )

    def run_formula(
        case_stage: dict[str, Any],
        repair_notes: list[dict[str, Any]] | None = None,
        *,
        force: bool = False,
    ) -> dict[str, Any]:
        relative = Path("formulas.json")
        stage_payload = {"fact_index": facts, **case_stage}
        if not repair_notes and not force:
            cached = _load_checkpoint(
                work_dir,
                previous_work_dirs,
                relative,
                lambda value: validate_formula_stage(value, case_stage, all_chunk_ids),
                fingerprint=_checkpoint_fingerprint("formula_candidate_distillation", stage_payload),
            )
            if cached is not None:
                return cached
        return _call_stage(
            skill_name="script-formula-distillation",
            task_name="formula_candidate_distillation",
            payload=stage_payload,
            schema=distillation_stage_schema("formula"),
            validator=lambda value: validate_formula_stage(value, case_stage, all_chunk_ids),
            runtime=model_runtime,
            output_path=work_dir / relative,
            max_tokens=15000,
            repair_notes=repair_notes,
        )

    def run_principle(
        case_stage: dict[str, Any],
        formula_stage: dict[str, Any],
        repair_notes: list[dict[str, Any]] | None = None,
        *,
        force: bool = False,
    ) -> dict[str, Any]:
        relative = Path("principles.json")
        stage_payload = {"case_card": case_stage["case_card"], "formula_stage": formula_stage}
        if not repair_notes and not force:
            cached = _load_checkpoint(
                work_dir,
                previous_work_dirs,
                relative,
                lambda value: validate_principle_stage(value, case_stage, formula_stage, all_chunk_ids),
                fingerprint=_checkpoint_fingerprint("principle_observation_distillation", stage_payload),
            )
            if cached is not None:
                return cached
        return _call_stage(
            skill_name="script-principle-distillation",
            task_name="principle_observation_distillation",
            payload=stage_payload,
            schema=distillation_stage_schema("principle"),
            validator=lambda value: validate_principle_stage(value, case_stage, formula_stage, all_chunk_ids),
            runtime=model_runtime,
            output_path=work_dir / relative,
            max_tokens=9000,
            repair_notes=repair_notes,
        )

    def assemble(
        case_stage: dict[str, Any],
        formula_stage: dict[str, Any],
        principle_stage: dict[str, Any],
    ) -> dict[str, Any]:
        raw = {
            "schema_version": "1.0.0",
            "source": {
                "title": str(script["title"]),
                "content_sha256": source_sha256,
                "chunk_count": len(all_chunk_ids),
            },
            **case_stage,
            **formula_stage,
            **principle_stage,
            "quality_review": {
                "full_source_read": True,
                "facts_and_hypotheses_separated": True,
                "formula_deidentified": True,
                "principles_kept_as_candidates": True,
                "known_unknowns": facts["open_questions"],
            },
        }
        return validate_distillation(
            raw,
            all_chunk_ids,
            source_text=indexed_source,
            expected_title=str(script["title"]),
            expected_sha256=source_sha256,
        )

    _set_progress(conn, script_id=script_id, stage="case_card", completed=len(batches) + 1, total=total_steps, message="正在生成标签和案例卡")
    case_stage = run_case()
    if case_only:
        # Full-source facts and the case card are the per-script initialization
        # boundary. Formula and principle abstraction is intentionally deferred
        # to the batch catalog phase, where multiple scripts can be compared.
        return {
            "schema_version": "batch-case-v1",
            "source": {
                "title": str(script["title"]),
                "content_sha256": source_sha256,
                "chunk_count": len(all_chunk_ids),
            },
            "summary": case_stage["summary"],
            "tags": case_stage["tags"],
            "case_card": case_stage["case_card"],
            "fact_index": facts,
        }
    _set_progress(conn, script_id=script_id, stage="formula", completed=len(batches) + 2, total=total_steps, message="正在提炼可复用公式")
    formula_stage = run_formula(case_stage)
    _set_progress(conn, script_id=script_id, stage="principle", completed=len(batches) + 3, total=total_steps, message="正在提炼创作原则")
    principle_stage = run_principle(case_stage, formula_stage)
    result = assemble(case_stage, formula_stage, principle_stage)

    def review_payload() -> dict[str, Any]:
        return {"fact_index": facts, "distillation_result": result}

    def run_review(review_index: int) -> dict[str, Any]:
        return _call_stage(
            skill_name="script-distillation-review",
            task_name="final_distillation_review",
            payload=review_payload(),
            schema=REVIEW_SCHEMA,
            validator=lambda value: _validate_review(value, all_chunk_ids),
            runtime=model_runtime,
            output_path=work_dir / f"review-{review_index}.json",
            max_tokens=5000,
        )

    _set_progress(conn, script_id=script_id, stage="review", completed=len(batches) + 4, total=total_steps, message="正在检查事实与知识抽象")
    cached_review = _load_checkpoint(
        work_dir,
        previous_work_dirs,
        Path("review.json"),
        lambda value: _validate_review(value, all_chunk_ids),
        fingerprint=_checkpoint_fingerprint("final_distillation_review", review_payload()),
    )
    review = cached_review if cached_review and cached_review["approved"] else run_review(1)
    if not review["approved"]:
        order = {"case_card": 0, "formula": 1, "principle": 2}
        earliest = min((item["stage"] for item in review["issues"]), key=lambda item: order[item])
        notes_by_stage = {
            stage: [item for item in review["issues"] if item["stage"] == stage]
            for stage in order
        }
        if earliest == "case_card":
            case_stage = run_case(notes_by_stage["case_card"], force=True)
            formula_stage = run_formula(case_stage, notes_by_stage["formula"] or None, force=True)
            principle_stage = run_principle(
                case_stage,
                formula_stage,
                notes_by_stage["principle"] or None,
                force=True,
            )
        elif earliest == "formula":
            formula_stage = run_formula(case_stage, notes_by_stage["formula"], force=True)
            principle_stage = run_principle(
                case_stage,
                formula_stage,
                notes_by_stage["principle"] or None,
                force=True,
            )
        else:
            principle_stage = run_principle(
                case_stage,
                formula_stage,
                notes_by_stage["principle"],
                force=True,
            )
        result = assemble(case_stage, formula_stage, principle_stage)
        review = run_review(2)
        if not review["approved"]:
            issue_text = "；".join(item["problem"] for item in review["issues"])
            raise RuntimeError(f"最终审稿未通过：{issue_text}")
    _write_json(work_dir / "review.json", review)
    _checkpoint_fingerprint_path(work_dir / "review.json").write_text(
        _checkpoint_fingerprint("final_distillation_review", review_payload()) + "\n",
        encoding="utf-8",
    )
    _write_json(work_dir / "result.json", result)
    _write_json(work_dir / "pipeline.json", {
        "version": PIPELINE_VERSION,
        "job_id": job_id,
        "script_id": script_id,
        "source_sha256": source_sha256,
        "chunk_count": len(all_chunk_ids),
        "evidence_batch_count": len(batches),
        "completed": True,
    })
    _set_progress(conn, script_id=script_id, stage="catalog", completed=len(batches) + 5, total=total_steps, message="正在关联公式和创作原则")
    return result
