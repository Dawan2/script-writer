from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status

from app.services.direct_skill_runner import (
    call_direct_model,
    direct_skill_system_prompt,
    extract_json_object,
)
from app.services.mechanism_retrieval import attach_retrieval_matches
from app.services.script_source_normalization import (
    source_lookup_key,
    source_term_display,
    source_terms_found_in_text,
)
from app.services.script_tag_service import (
    CONTROLLED_TAG_VALUES,
    TAG_LABELS,
    TAG_TAXONOMY,
    script_profile_errors,
    tag_taxonomy,
)


DISTILLATION_VERSION = "script-library-v5"
FORMULA_CURATION_VERSION = "formula-library-v3"
PRINCIPLE_CURATION_VERSION = "principle-library-v3"
FORMULA_ACTIVATION_MIN_SOURCES = 2
CURATION_MAX_OUTPUT_TOKENS = 12000
# One initial request plus at most two repair requests for every cataloging
# task.  This is deliberately independent from transport-level retries.
MODEL_RETRY_LIMIT = 2
CURATION_VALIDATION_ATTEMPTS = MODEL_RETRY_LIMIT + 1

FORMULA_CATEGORIES = (
    "story_engine",
    "world_rule",
    "character_relationship",
    "long_arc",
    "episode_structure",
    "hook_information",
    "audience_payoff",
    "emotional_progression",
    "scene_conflict",
    "dialogue_action",
)
FORMULA_CATEGORY_ALIASES = {
    "worldbuilding": "world_rule",
    "world_building": "world_rule",
}
CREATIVE_STAGES = (
    "global",
    "novel_analysis",
    "world_view",
    "outline_rewrite",
    "character_rewrite",
    "trial_generate",
    "full_generate",
    "dialogue_translate",
    "foreign_review",
)
PRINCIPLE_RELATIONS = frozenset({"supports", "bounds", "counters", "proposes"})
GENERIC_SOURCE_TERMS = frozenset({
    "主角", "对手", "人物", "角色", "公司", "集团", "城市", "学校", "医院",
    "婚礼", "证据", "项目", "关系", "选择权", "真相", "家族", "团队",
})
FORMULA_CARD_FIELDS = (
    "name",
    "category",
    "stages",
    "usage_scenario",
    "not_applicable",
    "creative_decision",
    "creative_problem",
    "goal",
    "core_formula",
    "conditions",
    "variables",
    "steps",
    "mechanism",
    "expected_effect",
    "observable_checks",
    "failure_modes",
    "rewrite_usage",
    "original_usage",
    "genre_adaptations",
)


def _normalize_formula_stages(value: Any, *, label: str) -> list[str]:
    stages = _strings(value, label=label, minimum=1, maximum=2, item_minimum=4)
    invalid = [stage for stage in stages if stage not in CREATIVE_STAGES or stage == "global"]
    if invalid:
        raise RuntimeError(
            f"{label}使用了无效创作阶段：{'、'.join(invalid)}。"
            "公式不得使用 global，也不能用公式分类代替阶段"
        )
    if len(stages) > 1 and set(stages) != {"trial_generate", "full_generate"}:
        raise RuntimeError(f"{label}横跨了不同创作粒度；只有剧本试稿与剧本完稿可以共用一张公式")
    return stages


def _normalize_usage_scenario(item: dict[str, Any], *, label: str) -> str:
    scenario = _text(item.get("usage_scenario"), label=f"{label}使用场景", minimum=16, maximum=300)
    if "?" in scenario or "？" in scenario:
        raise RuntimeError(f"{label}使用场景应说明当前任务和目标变化，不能写成问题")
    for field, field_label in (("creative_decision", "创作决策"), ("creative_problem", "写作问题")):
        compatible = _text(item.get(field), label=f"{label}{field_label}", minimum=16, maximum=600)
        if compatible != scenario:
            raise RuntimeError(f"{label}{field_label}是兼容字段，必须与使用场景完全一致")
    return scenario


def _normalize_core_formula(value: Any, *, label: str) -> str:
    return _text(value, label=f"{label}核心公式", minimum=16, maximum=800)


def _normalize_formula_list(
    value: Any,
    *,
    label: str,
    minimum: int,
    maximum: int,
    item_minimum: int = 6,
) -> list[str]:
    """Keep concise Chinese bullets while rejecting fragments too short to carry meaning."""
    return _strings(value, label=label, minimum=minimum, maximum=maximum, item_minimum=item_minimum)


def _curation_runtime(model_runtime: dict[str, Any] | None) -> dict[str, Any] | None:
    """Use streaming for the small catalog decisions as well as distillation."""
    if not isinstance(model_runtime, dict):
        return model_runtime
    runtime = dict(model_runtime)
    try:
        configured = int(runtime.get("max_tokens") or CURATION_MAX_OUTPUT_TOKENS)
    except (TypeError, ValueError):
        configured = CURATION_MAX_OUTPUT_TOKENS
    runtime["max_tokens"] = min(max(2048, configured), CURATION_MAX_OUTPUT_TOKENS)
    runtime["stream"] = True
    return runtime


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _load_json(value: str | None, fallback: Any) -> Any:
    try:
        parsed = json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return fallback
    return parsed


def _text(value: Any, *, label: str, minimum: int, maximum: int = 2400) -> str:
    result = re.sub(r"\s+", " ", str(value or "").strip())[:maximum]
    if len(result) < minimum:
        raise RuntimeError(f"{label}过于简略，至少需要 {minimum} 个字符")
    return result


def _strings(
    value: Any,
    *,
    label: str,
    minimum: int = 0,
    maximum: int = 20,
    item_minimum: int = 2,
) -> list[str]:
    if not isinstance(value, list):
        raise RuntimeError(f"{label}必须是数组")
    result: list[str] = []
    for raw in value[:maximum]:
        item = re.sub(r"\s+", " ", str(raw or "").strip())[:600]
        if len(item) < item_minimum:
            raise RuntimeError(f"{label}存在过于简略的内容")
        if item not in result:
            result.append(item)
    if len(result) < minimum:
        raise RuntimeError(f"{label}至少需要 {minimum} 项")
    return result


def _records(value: Any, *, label: str, minimum: int = 0, maximum: int = 20) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise RuntimeError(f"{label}必须是数组")
    if len(value) < minimum:
        raise RuntimeError(f"{label}至少需要 {minimum} 项")
    if len(value) > maximum:
        raise RuntimeError(f"{label}最多允许 {maximum} 项")
    if any(not isinstance(item, dict) for item in value):
        raise RuntimeError(f"{label}包含无效对象")
    return value


def _evidence(value: Any, valid_ids: set[str], *, label: str, minimum: int = 1) -> list[str]:
    references = _strings(value, label=label, minimum=minimum, maximum=24, item_minimum=5)
    invalid = [item for item in references if not re.fullmatch(r"C\d{4,}", item) or item not in valid_ids]
    if invalid:
        raise RuntimeError(f"{label}包含无效原文索引：{'、'.join(invalid)}")
    return references


def _has_full_coverage(references: list[str], count: int) -> bool:
    if count <= 2:
        return len(references) >= count
    indexes = {int(item[1:]) for item in references}
    opening_end = max(1, (count + 3) // 4)
    ending_start = max(opening_end + 2, (count * 3 + 3) // 4)
    return (
        any(index <= opening_end for index in indexes)
        and any(opening_end < index < ending_start for index in indexes)
        and any(index >= ending_start for index in indexes)
    )


def _controlled_tags(kind: str, value: Any) -> list[str]:
    limits = {"theme": (1, 3), "setting": (1, 4), "background": (1, 3), "audience": (1, 1)}
    minimum, maximum = limits[kind]
    values = _strings(value, label=f"{TAG_LABELS[kind]}标签", minimum=minimum, maximum=maximum)
    invalid = [item for item in values if item not in TAG_TAXONOMY[kind]]
    if invalid:
        raise RuntimeError(f"{TAG_LABELS[kind]}标签不在受控词表中：{'、'.join(invalid)}")
    return values


def _strict_object(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _schema_text(minimum: int, maximum: int = 2400) -> dict[str, Any]:
    return {"type": "string", "minLength": minimum, "maxLength": maximum}


def _schema_array(items: dict[str, Any], minimum: int, maximum: int) -> dict[str, Any]:
    return {"type": "array", "items": items, "minItems": minimum, "maxItems": maximum}


def distillation_output_schema() -> dict[str, Any]:
    evidence = _schema_array({"type": "string", "pattern": "^C[0-9]{4,}$"}, 1, 24)
    short_list = lambda minimum=1, maximum=8: _schema_array(_schema_text(2, 600), minimum, maximum)
    tag_properties = {
        kind: _schema_array(
            {"type": "string", "enum": list(values)},
            1,
            1 if kind == "audience" else (3 if kind in {"theme", "background"} else 4),
        )
        for kind, values in TAG_TAXONOMY.items()
    }
    world_rule = _strict_object({
        "rule": _schema_text(10, 500),
        "resource_or_limit": _schema_text(10, 500),
        "violation_cost": _schema_text(10, 500),
        "story_function": _schema_text(10, 500),
        "evidence_references": evidence,
    })
    character = _strict_object({
        "name": _schema_text(1, 40),
        "dramatic_function": _schema_text(8, 300),
        "desire": _schema_text(8, 400),
        "fear_need_or_misbelief": _schema_text(8, 400),
        "leverage": _schema_text(8, 400),
        "secret_or_unknown": _schema_text(8, 400),
        "initial_state": _schema_text(8, 500),
        "turning_action": _schema_text(12, 500),
        "final_state": _schema_text(8, 500),
        "evidence_references": evidence,
    })
    relationship = _strict_object({
        "parties": short_list(2, 4),
        "initial_power": _schema_text(12, 700),
        "debt_or_misunderstanding": _schema_text(12, 700),
        "change_chain": _schema_text(12, 700),
        "final_state": _schema_text(12, 700),
        "evidence_references": evidence,
    })
    phase = _strict_object({
        "phase": _schema_text(2, 40),
        "goal": _schema_text(12, 700),
        "opposition": _schema_text(12, 700),
        "irreversible_change": _schema_text(12, 700),
        "audience_return": _schema_text(12, 700),
        "evidence_references": evidence,
    })
    payoff = _strict_object({
        "payoff_type": _schema_text(1, 40),
        "setup": _schema_text(10, 600),
        "pressure": _schema_text(10, 600),
        "release": _schema_text(10, 600),
        "story_consequence": _schema_text(10, 600),
        "evidence_references": evidence,
    })
    observation = _strict_object({
        "observation_id": {"type": "string", "pattern": "^O[0-9]{2,}$"},
        "stage": {"type": "string", "enum": list(CREATIVE_STAGES)},
        "creative_problem": _schema_text(16, 800),
        "setup": _schema_text(16, 800),
        "author_choice": _schema_text(16, 800),
        "story_change": _schema_text(16, 800),
        "audience_effect_hypothesis": _schema_text(16, 800),
        "tradeoff_or_boundary": _schema_text(16, 800),
        "evidence_references": evidence,
    })
    case_card = _strict_object({
        "logline": _schema_text(30, 420),
        "audience_promise": _schema_text(24, 600),
        "story_engine": _strict_object({
            "initial_situation": _schema_text(16, 700),
            "protagonist_goal": _schema_text(16, 700),
            "main_resistance": _schema_text(16, 700),
            "stakes": _schema_text(16, 700),
            "repeatable_conflict_loop": _schema_text(16, 700),
            "ending_change": _schema_text(16, 700),
        }),
        "world_rules": _schema_array(world_rule, 0, 6),
        "characters": _schema_array(character, 2, 8),
        "relationship_dynamics": _schema_array(relationship, 1, 8),
        "narrative_phases": _schema_array(phase, 3, 8),
        "audience_payoffs": _schema_array(payoff, 2, 8),
        "key_observations": _schema_array(observation, 3, 10),
        "strengths": short_list(1, 8),
        "limitations": short_list(1, 8),
        "source_specific_terms": short_list(1, 16),
        "evidence_references": evidence,
    })
    catalog_decision = _strict_object({
        "action": {"type": "string", "enum": ["unresolved"]},
        "target_id": {"type": "string", "maxLength": 0},
        "reason": _schema_text(12, 600),
    })
    adaptation = _strict_object({
        "tags": short_list(1, 8),
        "difference": _schema_text(16, 600),
        "usage_adjustment": _schema_text(16, 600),
        "boundary_adjustment": _schema_text(16, 600),
    })
    formula = _strict_object({
        "candidate_id": {"type": "string", "pattern": "^F[0-9]{2,}$"},
        "category": {"type": "string", "enum": list(FORMULA_CATEGORIES)},
        "name": _schema_text(4, 80),
        "stages": _schema_array({"type": "string", "enum": [stage for stage in CREATIVE_STAGES if stage != "global"]}, 1, 2),
        "usage_scenario": _schema_text(16, 300),
        "not_applicable": short_list(1, 6),
        "creative_decision": _schema_text(16, 300),
        "creative_problem": _schema_text(16, 600),
        "goal": _schema_text(16, 600),
        "core_formula": _schema_text(16, 800),
        "conditions": short_list(1, 6),
        "variables": short_list(2, 10),
        "steps": short_list(2, 8),
        "mechanism": _schema_text(24, 800),
        "expected_effect": _schema_text(16, 600),
        "observable_checks": short_list(1, 6),
        "failure_modes": short_list(1, 6),
        "rewrite_usage": _schema_text(24, 800),
        "original_usage": _schema_text(24, 800),
        "genre_adaptations": _schema_array(adaptation, 1, 6),
        "applicable_tags": short_list(1, 8),
        "observation_refs": short_list(1, 10),
        "evidence_references": evidence,
        "catalog_decision": catalog_decision,
        "maturity": {"type": "string", "enum": ["single_case"]},
    })
    principle = _strict_object({
        "observation_id": {"type": "string", "pattern": "^P[0-9]{2,}$"},
        "stages": _schema_array({"type": "string", "enum": list(CREATIVE_STAGES)}, 1, 4),
        "statement": _schema_text(20, 500),
        "relation": {"type": "string", "enum": sorted(PRINCIPLE_RELATIONS)},
        "rationale": _schema_text(20, 700),
        "applies_when": short_list(1, 6),
        "fails_or_changes_when": short_list(1, 6),
        "review_criteria": short_list(1, 6),
        "related_formula_candidate_ids": short_list(0, 8),
        "evidence_references": evidence,
        "catalog_decision": catalog_decision,
        "status": {"type": "string", "enum": ["candidate_only"]},
    })
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **_strict_object({
            "schema_version": {"type": "string", "enum": ["1.0.0"]},
            "source": _strict_object({
                "title": _schema_text(1, 160),
                "content_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                "chunk_count": {"type": "integer", "minimum": 1},
            }),
            "summary": _schema_text(80, 1600),
            "tags": _strict_object(tag_properties),
            "case_card": case_card,
            "formula_candidates": _schema_array(formula, 0, 8),
            "no_formula_reason": _schema_text(0, 600),
            "principle_observations": _schema_array(principle, 0, 6),
            "no_principle_reason": _schema_text(0, 600),
            "quality_review": _strict_object({
                "full_source_read": {"type": "boolean", "const": True},
                "facts_and_hypotheses_separated": {"type": "boolean", "const": True},
                "formula_deidentified": {"type": "boolean", "const": True},
                "principles_kept_as_candidates": {"type": "boolean", "const": True},
                "known_unknowns": short_list(0, 8),
            }),
        }),
    }


def distillation_stage_schema(stage: str) -> dict[str, Any]:
    """Return the smallest persisted output contract needed by one stage."""
    properties = distillation_output_schema()["properties"]
    fields = {
        "case_card": ("summary", "tags", "case_card"),
        "formula": ("formula_candidates", "no_formula_reason"),
        "principle": ("principle_observations", "no_principle_reason"),
    }.get(stage)
    if fields is None:
        raise ValueError(f"未知蒸馏阶段：{stage}")
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **_strict_object({field: properties[field] for field in fields}),
    }


def _normalize_case_card(
    card: Any,
    valid_ids: set[str],
    source_text: str,
    *,
    allowed_source_terms: list[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(card, dict):
        raise RuntimeError("蒸馏结果缺少案例卡")
    engine = card.get("story_engine")
    if not isinstance(engine, dict):
        raise RuntimeError("案例卡缺少故事运行方式")
    normalized: dict[str, Any] = {
        "logline": _text(card.get("logline"), label="一句话故事", minimum=30, maximum=420),
        "audience_promise": _text(card.get("audience_promise"), label="观众期待", minimum=24, maximum=600),
        "story_engine": {
            field: _text(engine.get(field), label=f"故事运行方式.{field}", minimum=16, maximum=700)
            for field in (
                "initial_situation",
                "protagonist_goal",
                "main_resistance",
                "stakes",
                "repeatable_conflict_loop",
                "ending_change",
            )
        },
    }
    normalized["world_rules"] = []
    for index, item in enumerate(_records(card.get("world_rules"), label="世界规则", maximum=6), start=1):
        normalized["world_rules"].append({
            field: _text(item.get(field), label=f"第 {index} 条世界规则.{field}", minimum=10, maximum=500)
            for field in ("rule", "resource_or_limit", "violation_cost", "story_function")
        } | {"evidence_references": _evidence(item.get("evidence_references"), valid_ids, label=f"第 {index} 条世界规则证据")})
    normalized["characters"] = []
    for index, item in enumerate(_records(card.get("characters"), label="主要人物", minimum=2, maximum=8), start=1):
        result = {"name": _text(item.get("name"), label=f"第 {index} 个人物姓名", minimum=1, maximum=40)}
        for field in (
            "dramatic_function",
            "desire",
            "fear_need_or_misbelief",
            "leverage",
            "secret_or_unknown",
            "initial_state",
            "turning_action",
            "final_state",
        ):
            minimum = 12 if field == "turning_action" else 8
            result[field] = _text(item.get(field), label=f"第 {index} 个人物.{field}", minimum=minimum, maximum=600)
        result["evidence_references"] = _evidence(item.get("evidence_references"), valid_ids, label=f"第 {index} 个人物证据")
        normalized["characters"].append(result)
    normalized["relationship_dynamics"] = []
    for index, item in enumerate(_records(card.get("relationship_dynamics"), label="关系变化", minimum=1, maximum=8), start=1):
        result = {"parties": _strings(item.get("parties"), label=f"第 {index} 组关系人物", minimum=2, maximum=4, item_minimum=1)}
        for field in ("initial_power", "debt_or_misunderstanding", "change_chain", "final_state"):
            result[field] = _text(item.get(field), label=f"第 {index} 组关系.{field}", minimum=12, maximum=700)
        result["evidence_references"] = _evidence(item.get("evidence_references"), valid_ids, label=f"第 {index} 组关系证据")
        normalized["relationship_dynamics"].append(result)
    normalized["narrative_phases"] = []
    for index, item in enumerate(_records(card.get("narrative_phases"), label="叙事阶段", minimum=3, maximum=8), start=1):
        result = {"phase": _text(item.get("phase"), label=f"第 {index} 个叙事阶段", minimum=2, maximum=40)}
        for field in ("goal", "opposition", "irreversible_change", "audience_return"):
            result[field] = _text(item.get(field), label=f"第 {index} 个叙事阶段.{field}", minimum=12, maximum=700)
        result["evidence_references"] = _evidence(item.get("evidence_references"), valid_ids, label=f"第 {index} 个叙事阶段证据")
        normalized["narrative_phases"].append(result)
    normalized["audience_payoffs"] = []
    for index, item in enumerate(_records(card.get("audience_payoffs"), label="观众回报", minimum=2, maximum=8), start=1):
        result = {"payoff_type": _text(item.get("payoff_type"), label=f"第 {index} 个观众回报类型", minimum=1, maximum=40)}
        for field in ("setup", "pressure", "release", "story_consequence"):
            result[field] = _text(item.get(field), label=f"第 {index} 个观众回报.{field}", minimum=10, maximum=600)
        result["evidence_references"] = _evidence(item.get("evidence_references"), valid_ids, label=f"第 {index} 个观众回报证据")
        normalized["audience_payoffs"].append(result)
    normalized["key_observations"] = []
    observation_ids: set[str] = set()
    for index, item in enumerate(_records(card.get("key_observations"), label="关键写法观察", minimum=3, maximum=10), start=1):
        observation_id = str(item.get("observation_id") or "").strip()
        if not re.fullmatch(r"O\d{2,}", observation_id) or observation_id in observation_ids:
            raise RuntimeError(f"第 {index} 条关键写法观察 ID 无效或重复")
        stage = str(item.get("stage") or "").strip()
        if stage not in CREATIVE_STAGES:
            raise RuntimeError(
                f"第 {index} 条关键写法观察的创作阶段无效：{stage}。"
                f"只能使用：{'、'.join(CREATIVE_STAGES)}；公式分类不能填在这里"
            )
        result = {"observation_id": observation_id, "stage": stage}
        for field in (
            "creative_problem",
            "setup",
            "author_choice",
            "story_change",
            "audience_effect_hypothesis",
            "tradeoff_or_boundary",
        ):
            result[field] = _text(item.get(field), label=f"关键写法观察 {observation_id}.{field}", minimum=16, maximum=800)
        result["evidence_references"] = _evidence(item.get("evidence_references"), valid_ids, label=f"关键写法观察 {observation_id} 证据")
        observation_ids.add(observation_id)
        normalized["key_observations"].append(result)
    normalized["strengths"] = _strings(card.get("strengths"), label="案例卡优势", minimum=1, maximum=8, item_minimum=8)
    normalized["limitations"] = _strings(card.get("limitations"), label="案例卡局限", minimum=1, maximum=8, item_minimum=8)
    required_terms = 4 if len(re.sub(r"\s+", "", source_text)) >= 1000 else 1
    requested_terms = _strings(card.get("source_specific_terms"), label="原文专属词", maximum=16)
    valid_candidates = source_terms_found_in_text(
        allowed_source_terms if allowed_source_terms is not None else requested_terms,
        source_text,
        limit=16,
    )
    allowed_by_key = {source_lookup_key(term): term for term in valid_candidates}
    source_terms: list[str] = []
    for requested in requested_terms:
        key = source_lookup_key(requested)
        matched = allowed_by_key.get(key)
        if matched and matched not in source_terms:
            source_terms.append(source_term_display(matched))
    if allowed_source_terms is not None:
        for candidate in valid_candidates:
            if candidate not in source_terms:
                source_terms.append(candidate)
            if len(source_terms) >= required_terms:
                break
    if len(source_terms) < required_terms:
        invalid = [term for term in requested_terms if source_lookup_key(term) not in allowed_by_key]
        detail = f"，无法回查：{'、'.join(invalid)}" if invalid else ""
        raise RuntimeError(f"案例卡至少需要 {required_terms} 个可回查的原文专属词{detail}")
    normalized["source_specific_terms"] = source_terms[:16]
    references = _evidence(
        card.get("evidence_references"),
        valid_ids,
        label="案例卡总证据",
        minimum=min(5, len(valid_ids)),
    )
    if not _has_full_coverage(references, len(valid_ids)):
        raise RuntimeError("案例卡证据未覆盖开篇、中段和收束")
    normalized["evidence_references"] = references
    return normalized


def _contains_source_term(values: list[Any], source_terms: list[str]) -> str:
    rendered = _json(values)
    for term in source_terms:
        if len(term) >= 2 and term not in CONTROLLED_TAG_VALUES and term not in GENERIC_SOURCE_TERMS and term in rendered:
            return term
    return ""


def _formula_deidentification_values(result: dict[str, Any]) -> list[Any]:
    """Keep reusable adaptation tags while checking all formula prose for source leakage."""
    values = [result[field] for field in FORMULA_CARD_FIELDS if field != "genre_adaptations"]
    values.extend(
        {
            "difference": adaptation.get("difference"),
            "usage_adjustment": adaptation.get("usage_adjustment"),
            "boundary_adjustment": adaptation.get("boundary_adjustment"),
        }
        for adaptation in result.get("genre_adaptations", [])
        if isinstance(adaptation, dict)
    )
    return values


def _normalize_adaptations(value: Any, *, tags: set[str], label: str) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(_records(value, label=f"{label}题材适配", minimum=1, maximum=6), start=1):
        adaptation_tags = _strings(item.get("tags"), label=f"{label}第 {index} 个题材适配标签", minimum=1, maximum=8)
        invalid = [tag for tag in adaptation_tags if tag not in tags]
        if invalid:
            raise RuntimeError(f"{label}题材适配使用了本剧之外的标签：{'、'.join(invalid)}")
        normalized.append({
            "tags": adaptation_tags,
            "difference": _text(item.get("difference"), label=f"{label}题材差异", minimum=8, maximum=600),
            "usage_adjustment": _text(item.get("usage_adjustment"), label=f"{label}用法调整", minimum=8, maximum=600),
            "boundary_adjustment": _text(item.get("boundary_adjustment"), label=f"{label}边界调整", minimum=8, maximum=600),
        })
    return normalized


def _normalize_formula_candidate(
    item: dict[str, Any],
    *,
    valid_ids: set[str],
    script_tags: set[str],
    observation_ids: set[str],
    observation_evidence: dict[str, set[str]],
    source_terms: list[str],
) -> dict[str, Any]:
    candidate_id = str(item.get("candidate_id") or "").strip()
    if not re.fullmatch(r"F\d{2,}", candidate_id):
        raise RuntimeError("公式候选 ID 应使用 F01 格式")
    category = str(item.get("category") or "").strip()
    if category not in FORMULA_CATEGORIES:
        raise RuntimeError(f"公式候选 {candidate_id} 的分类无效")
    label = f"公式候选 {candidate_id}"
    stages = _normalize_formula_stages(item.get("stages"), label=f"{label}创作阶段")
    usage_scenario = _normalize_usage_scenario(item, label=label)
    goal = _text(item.get("goal"), label=f"{label}目标", minimum=16, maximum=600)
    expected_effect = _text(item.get("expected_effect"), label=f"{label}预期结果", minimum=16, maximum=600)
    if expected_effect != goal:
        raise RuntimeError(f"{label}预期结果是兼容字段，必须与创作目标完全一致")
    result: dict[str, Any] = {
        "candidate_id": candidate_id,
        "category": category,
        "name": _text(item.get("name"), label=f"公式候选 {candidate_id} 名称", minimum=4, maximum=80),
        "stages": stages,
        "usage_scenario": usage_scenario,
        "not_applicable": _normalize_formula_list(item.get("not_applicable"), label=f"{label}不适用情况", minimum=1, maximum=6),
        "creative_decision": usage_scenario,
        "creative_problem": usage_scenario,
        "goal": goal,
        "core_formula": _normalize_core_formula(item.get("core_formula"), label=label),
        "conditions": _normalize_formula_list(item.get("conditions"), label=f"公式候选 {candidate_id} 使用条件", minimum=1, maximum=6),
        "variables": _strings(item.get("variables"), label=f"公式候选 {candidate_id} 可替换内容", minimum=2, maximum=10),
        "steps": _normalize_formula_list(item.get("steps"), label=f"公式候选 {candidate_id} 执行步骤", minimum=2, maximum=8),
        "mechanism": _text(item.get("mechanism"), label=f"公式候选 {candidate_id} 生效原因", minimum=24, maximum=800),
        "expected_effect": goal,
        "observable_checks": _normalize_formula_list(item.get("observable_checks"), label=f"公式候选 {candidate_id} 检查项", minimum=1, maximum=6),
        "failure_modes": _normalize_formula_list(item.get("failure_modes"), label=f"公式候选 {candidate_id} 失效边界", minimum=1, maximum=6),
        "rewrite_usage": _text(item.get("rewrite_usage"), label=f"公式候选 {candidate_id} 改写用法", minimum=24, maximum=800),
        "original_usage": _text(item.get("original_usage"), label=f"公式候选 {candidate_id} 新创作用法", minimum=24, maximum=800),
        "genre_adaptations": _normalize_adaptations(item.get("genre_adaptations"), tags=script_tags, label=f"公式候选 {candidate_id}"),
    }
    applicable_tags = _strings(item.get("applicable_tags"), label=f"公式候选 {candidate_id} 适用标签", minimum=1, maximum=8)
    if any(tag not in script_tags for tag in applicable_tags):
        raise RuntimeError(f"公式候选 {candidate_id} 使用了本剧之外的适用标签")
    result["applicable_tags"] = applicable_tags
    observation_refs = _strings(item.get("observation_refs"), label=f"公式候选 {candidate_id} 观察引用", minimum=1, maximum=10)
    if any(reference not in observation_ids for reference in observation_refs):
        raise RuntimeError(f"公式候选 {candidate_id} 引用了不存在的关键写法观察")
    result["observation_refs"] = observation_refs
    result["evidence_references"] = _evidence(item.get("evidence_references"), valid_ids, label=f"公式候选 {candidate_id} 原文证据")
    linked_evidence = set().union(*(observation_evidence.get(reference, set()) for reference in observation_refs))
    if not set(result["evidence_references"]).intersection(linked_evidence):
        raise RuntimeError(f"公式候选 {candidate_id} 的证据与关联观察没有交集")
    decision = item.get("catalog_decision")
    if not isinstance(decision, dict) or decision.get("action") != "unresolved" or str(decision.get("target_id") or ""):
        raise RuntimeError(f"公式候选 {candidate_id} 在单剧蒸馏阶段只能保留 unresolved")
    result["catalog_decision"] = {
        "action": "unresolved",
        "target_id": "",
        "reason": _text(decision.get("reason"), label=f"公式候选 {candidate_id} 待归档原因", minimum=12, maximum=600),
    }
    if item.get("maturity") != "single_case":
        raise RuntimeError(f"公式候选 {candidate_id} 必须保持 single_case")
    result["maturity"] = "single_case"
    leaked = _contains_source_term(_formula_deidentification_values(result), source_terms)
    if leaked:
        raise RuntimeError(f"公式候选 {candidate_id} 仍包含原剧专属词：{leaked}")
    return result


def _normalize_principle_observation(
    item: dict[str, Any],
    *,
    valid_ids: set[str],
    formula_ids: set[str],
    source_terms: list[str],
) -> dict[str, Any]:
    observation_id = str(item.get("observation_id") or "").strip()
    if not re.fullmatch(r"P\d{2,}", observation_id):
        raise RuntimeError("原则观察 ID 应使用 P01 格式")
    stages = _strings(item.get("stages"), label=f"原则观察 {observation_id} 创作阶段", minimum=1, maximum=4, item_minimum=4)
    if any(stage not in CREATIVE_STAGES for stage in stages):
        invalid = [stage for stage in stages if stage not in CREATIVE_STAGES]
        raise RuntimeError(
            f"原则观察 {observation_id} 使用了无效创作阶段：{'、'.join(invalid)}。"
            f"只能使用：{'、'.join(CREATIVE_STAGES)}；公式分类不能填在 stages"
        )
    relation = str(item.get("relation") or "").strip()
    if relation not in PRINCIPLE_RELATIONS:
        raise RuntimeError(f"原则观察 {observation_id} 的关系无效")
    result = {
        "observation_id": observation_id,
        "stages": stages,
        "statement": _text(item.get("statement"), label=f"原则观察 {observation_id} 原则原文", minimum=20, maximum=500),
        "relation": relation,
        "rationale": _text(item.get("rationale"), label=f"原则观察 {observation_id} 成立原因", minimum=20, maximum=700),
        "applies_when": _strings(item.get("applies_when"), label=f"原则观察 {observation_id} 适用条件", minimum=1, maximum=6, item_minimum=8),
        "fails_or_changes_when": _strings(item.get("fails_or_changes_when"), label=f"原则观察 {observation_id} 例外边界", minimum=1, maximum=6, item_minimum=8),
        "review_criteria": _strings(item.get("review_criteria"), label=f"原则观察 {observation_id} 审核标准", minimum=1, maximum=6, item_minimum=8),
    }
    related = _strings(item.get("related_formula_candidate_ids"), label=f"原则观察 {observation_id} 相关公式", maximum=8)
    if any(formula_id not in formula_ids for formula_id in related):
        raise RuntimeError(f"原则观察 {observation_id} 引用了不存在的公式候选")
    result["related_formula_candidate_ids"] = related
    result["evidence_references"] = _evidence(item.get("evidence_references"), valid_ids, label=f"原则观察 {observation_id} 原文证据")
    decision = item.get("catalog_decision")
    if not isinstance(decision, dict) or decision.get("action") != "unresolved" or str(decision.get("target_id") or ""):
        raise RuntimeError(f"原则观察 {observation_id} 在单剧蒸馏阶段只能保留 unresolved")
    result["catalog_decision"] = {
        "action": "unresolved",
        "target_id": "",
        "reason": _text(decision.get("reason"), label=f"原则观察 {observation_id} 待归档原因", minimum=12, maximum=600),
    }
    if item.get("status") != "candidate_only":
        raise RuntimeError(f"原则观察 {observation_id} 必须保持 candidate_only")
    result["status"] = "candidate_only"
    leaked = _contains_source_term([
        result["statement"],
        result["rationale"],
        result["applies_when"],
        result["fails_or_changes_when"],
        result["review_criteria"],
    ], source_terms)
    if leaked:
        raise RuntimeError(f"原则观察 {observation_id} 仍包含原剧专属词：{leaked}")
    return result


def validate_case_card_stage(
    payload: Any,
    valid_chunk_ids: set[str],
    *,
    source_text: str,
    allowed_source_terms: list[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("案例卡阶段返回的不是有效对象")
    tags_value = payload.get("tags")
    if not isinstance(tags_value, dict):
        raise RuntimeError("案例卡阶段缺少剧本标签")
    tags = {
        kind: _controlled_tags(kind, tags_value.get(kind))
        for kind in ("theme", "setting", "background", "audience")
    }
    errors = script_profile_errors(tags, allow_auto=False)
    if errors:
        raise RuntimeError("；".join(errors))
    return {
        "summary": _text(payload.get("summary"), label="剧本摘要", minimum=80, maximum=1600),
        "tags": tags,
        "case_card": _normalize_case_card(
            payload.get("case_card"),
            valid_chunk_ids,
            source_text,
            allowed_source_terms=allowed_source_terms,
        ),
    }


def validate_formula_stage(
    payload: Any,
    case_stage: dict[str, Any],
    valid_chunk_ids: set[str],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("公式阶段返回的不是有效对象")
    case_card = case_stage["case_card"]
    script_tags = {value for values in case_stage["tags"].values() for value in values}
    observation_ids = {item["observation_id"] for item in case_card["key_observations"]}
    observation_evidence = {
        item["observation_id"]: set(item["evidence_references"])
        for item in case_card["key_observations"]
    }
    formulas = [
        _normalize_formula_candidate(
            item,
            valid_ids=valid_chunk_ids,
            script_tags=script_tags,
            observation_ids=observation_ids,
            observation_evidence=observation_evidence,
            source_terms=case_card["source_specific_terms"],
        )
        for item in _records(payload.get("formula_candidates"), label="公式候选", maximum=8)
    ]
    ids = [item["candidate_id"] for item in formulas]
    if len(ids) != len(set(ids)):
        raise RuntimeError("公式候选 ID 不能重复")
    reason = str(payload.get("no_formula_reason") or "").strip()
    if not formulas:
        reason = _text(reason, label="无公式候选原因", minimum=20, maximum=600)
    return {"formula_candidates": formulas, "no_formula_reason": reason}


def validate_principle_stage(
    payload: Any,
    case_stage: dict[str, Any],
    formula_stage: dict[str, Any],
    valid_chunk_ids: set[str],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("原则阶段返回的不是有效对象")
    formula_ids = {item["candidate_id"] for item in formula_stage["formula_candidates"]}
    source_terms = case_stage["case_card"]["source_specific_terms"]
    principles = [
        _normalize_principle_observation(
            item,
            valid_ids=valid_chunk_ids,
            formula_ids=formula_ids,
            source_terms=source_terms,
        )
        for item in _records(payload.get("principle_observations"), label="原则观察", maximum=6)
    ]
    ids = [item["observation_id"] for item in principles]
    if len(ids) != len(set(ids)):
        raise RuntimeError("原则观察 ID 不能重复")
    reason = str(payload.get("no_principle_reason") or "").strip()
    if not principles:
        reason = _text(reason, label="无原则观察原因", minimum=20, maximum=600)
    return {"principle_observations": principles, "no_principle_reason": reason}


def validate_distillation(
    payload: Any,
    valid_chunk_ids: set[str],
    *,
    source_text: str = "",
    expected_title: str = "",
    expected_sha256: str = "",
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("蒸馏结果不是有效对象")
    if payload.get("schema_version") != "1.0.0":
        raise RuntimeError("蒸馏结果版本无效")
    source = payload.get("source")
    if not isinstance(source, dict):
        raise RuntimeError("蒸馏结果缺少原文信息")
    source_title = _text(source.get("title"), label="原文标题", minimum=1, maximum=160)
    if expected_title and source_title != expected_title:
        raise RuntimeError("蒸馏结果对应的剧本名称不一致")
    source_sha256 = str(source.get("content_sha256") or "").strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", source_sha256):
        raise RuntimeError("原文摘要格式无效")
    if source_text:
        indexed_contents = re.findall(
            r"<!--\s*C\d{4,}\s*\|.*?-->\s*\n(.*?)(?=<!--\s*C\d{4,}\s*\||\Z)",
            source_text,
            flags=re.S,
        )
        canonical_source = "\n\n".join(item.strip() for item in indexed_contents) if indexed_contents else source_text
        actual_sha256 = hashlib.sha256(canonical_source.encode("utf-8")).hexdigest()
        if source_sha256 != actual_sha256:
            raise RuntimeError("蒸馏结果中的原文摘要与当前原文不一致")
    if expected_sha256 and source_sha256 != expected_sha256:
        raise RuntimeError("蒸馏结果对应的原文摘要不一致")
    if int(source.get("chunk_count") or 0) != len(valid_chunk_ids):
        raise RuntimeError("蒸馏结果对应的原文证据块数量不一致")
    tags_value = payload.get("tags")
    if not isinstance(tags_value, dict):
        raise RuntimeError("蒸馏结果缺少剧本标签")
    tags = {kind: _controlled_tags(kind, tags_value.get(kind)) for kind in ("theme", "setting", "background", "audience")}
    tag_errors = script_profile_errors(tags, allow_auto=False)
    if tag_errors:
        raise RuntimeError("；".join(tag_errors))
    case_card = _normalize_case_card(payload.get("case_card"), valid_chunk_ids, source_text)
    script_tags = set(value for values in tags.values() for value in values)
    observation_ids = {item["observation_id"] for item in case_card["key_observations"]}
    observation_evidence = {
        item["observation_id"]: set(item["evidence_references"])
        for item in case_card["key_observations"]
    }
    source_terms = case_card["source_specific_terms"]
    formula_values = _records(payload.get("formula_candidates"), label="公式候选", maximum=8)
    formulas = [
        _normalize_formula_candidate(
            item,
            valid_ids=valid_chunk_ids,
            script_tags=script_tags,
            observation_ids=observation_ids,
            observation_evidence=observation_evidence,
            source_terms=source_terms,
        )
        for item in formula_values
    ]
    formula_ids = [item["candidate_id"] for item in formulas]
    if len(formula_ids) != len(set(formula_ids)):
        raise RuntimeError("公式候选 ID 不能重复")
    no_formula_reason = str(payload.get("no_formula_reason") or "").strip()
    if not formulas:
        no_formula_reason = _text(no_formula_reason, label="无公式候选原因", minimum=20, maximum=600)
    principle_values = _records(payload.get("principle_observations"), label="原则观察", maximum=6)
    principles = [
        _normalize_principle_observation(
            item,
            valid_ids=valid_chunk_ids,
            formula_ids=set(formula_ids),
            source_terms=source_terms,
        )
        for item in principle_values
    ]
    principle_ids = [item["observation_id"] for item in principles]
    if len(principle_ids) != len(set(principle_ids)):
        raise RuntimeError("原则观察 ID 不能重复")
    no_principle_reason = str(payload.get("no_principle_reason") or "").strip()
    if not principles:
        no_principle_reason = _text(no_principle_reason, label="无原则观察原因", minimum=20, maximum=600)
    review = payload.get("quality_review")
    if not isinstance(review, dict):
        raise RuntimeError("蒸馏结果缺少质量检查")
    for field in (
        "full_source_read",
        "facts_and_hypotheses_separated",
        "formula_deidentified",
        "principles_kept_as_candidates",
    ):
        if review.get(field) is not True:
            raise RuntimeError(f"质量检查 {field} 未通过")
    return {
        "schema_version": "1.0.0",
        "source": {
            "title": expected_title or source_title,
            "content_sha256": source_sha256,
            "chunk_count": len(valid_chunk_ids),
        },
        "summary": _text(payload.get("summary"), label="剧本摘要", minimum=80, maximum=1600),
        "tags": tags,
        "case_card": case_card,
        "formula_candidates": formulas,
        "no_formula_reason": no_formula_reason,
        "principle_observations": principles,
        "no_principle_reason": no_principle_reason,
        "quality_review": {
            "full_source_read": True,
            "facts_and_hypotheses_separated": True,
            "formula_deidentified": True,
            "principles_kept_as_candidates": True,
            "known_unknowns": _strings(review.get("known_unknowns"), label="已知未知项", maximum=8, item_minimum=6),
        },
    }


def _formula_retrieval_item(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        **candidate,
        "function": f"{candidate['name']}。{candidate.get('usage_scenario') or candidate['creative_decision']}",
        "trigger": "；".join(candidate["conditions"]),
        "payoff": candidate["goal"],
        "transferable_strategy": "；".join(candidate["steps"]),
        "failure_boundary": "；".join([*candidate.get("not_applicable", []), *candidate["failure_modes"]]),
    }


def _formula_catalog(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM script_library_formulas WHERE status != 'retired' ORDER BY source_count DESC, id"
    ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        content = _load_json(row["content_json"], {})
        result.append(_formula_retrieval_item({
            "id": str(row["id"]),
            "name": str(row["name"]),
            "category": str(row["category"]),
            "stages": _load_json(row["stages_json"], []),
            "creative_decision": str(row["creative_decision"]),
            "creative_problem": str(row["creative_problem"]),
            **content,
            "source_count": int(row["source_count"] or 0),
            "status": str(row["status"]),
        }))
    return result


def _normalize_formula_card(item: dict[str, Any], *, forbidden_terms: list[str], label: str) -> dict[str, Any]:
    raw_category = str(item.get("category") or "").strip()
    category = FORMULA_CATEGORY_ALIASES.get(raw_category, raw_category)
    if category not in FORMULA_CATEGORIES:
        raise RuntimeError(f"{label}的公式分类无效，只能使用：{'、'.join(FORMULA_CATEGORIES)}")
    stages = _normalize_formula_stages(item.get("stages"), label=f"{label}创作阶段")
    compatibility_input = {
        **item,
        "creative_decision": item.get("usage_scenario"),
        "creative_problem": item.get("usage_scenario"),
    }
    usage_scenario = _normalize_usage_scenario(compatibility_input, label=label)
    goal = _text(item.get("goal"), label=f"{label}目标", minimum=16, maximum=600)
    result = {
        "name": _text(item.get("name"), label=f"{label}名称", minimum=4, maximum=80),
        "category": category,
        "stages": stages,
        "usage_scenario": usage_scenario,
        "not_applicable": _normalize_formula_list(item.get("not_applicable"), label=f"{label}不适用情况", minimum=1, maximum=8),
        "creative_decision": usage_scenario,
        "creative_problem": usage_scenario,
        "goal": goal,
        "core_formula": _normalize_core_formula(item.get("core_formula"), label=label),
        "conditions": _normalize_formula_list(item.get("conditions"), label=f"{label}使用条件", minimum=1, maximum=8),
        "variables": _strings(item.get("variables"), label=f"{label}可替换内容", minimum=2, maximum=12),
        "steps": _normalize_formula_list(item.get("steps"), label=f"{label}执行步骤", minimum=2, maximum=10),
        "mechanism": _text(item.get("mechanism"), label=f"{label}生效原因", minimum=24, maximum=1000),
        "expected_effect": goal,
        "observable_checks": _normalize_formula_list(item.get("observable_checks"), label=f"{label}检查项", minimum=1, maximum=8),
        "failure_modes": _normalize_formula_list(item.get("failure_modes"), label=f"{label}失效边界", minimum=1, maximum=8),
        "rewrite_usage": _text(item.get("rewrite_usage"), label=f"{label}改写用法", minimum=24, maximum=1000),
        "original_usage": _text(item.get("original_usage"), label=f"{label}新创作用法", minimum=24, maximum=1000),
    }
    adaptations = _records(item.get("genre_adaptations"), label=f"{label}题材适配", minimum=1, maximum=12)
    result["genre_adaptations"] = []
    for index, adaptation in enumerate(adaptations, start=1):
        adaptation_tags = _strings(
            adaptation.get("tags"),
            label=f"{label}第 {index} 个适配标签",
            minimum=1,
            maximum=8,
        )
        invalid_tags = [tag for tag in adaptation_tags if tag not in CONTROLLED_TAG_VALUES]
        if invalid_tags:
            raise RuntimeError(f"{label}第 {index} 个题材适配使用了标签体系之外的内容：{'、'.join(invalid_tags)}")
        result["genre_adaptations"].append({
            "tags": adaptation_tags,
            "difference": _text(adaptation.get("difference"), label=f"{label}第 {index} 个题材差异", minimum=8, maximum=600),
            "usage_adjustment": _text(adaptation.get("usage_adjustment"), label=f"{label}第 {index} 个用法调整", minimum=8, maximum=600),
            "boundary_adjustment": _text(adaptation.get("boundary_adjustment"), label=f"{label}第 {index} 个边界调整", minimum=8, maximum=600),
        })
    leaked = _contains_source_term(_formula_deidentification_values(result), forbidden_terms)
    if leaked:
        raise RuntimeError(f"{label}仍包含原剧专属词：{leaked}")
    return result


def _validate_formula_curation(
    payload: Any,
    *,
    candidates: list[dict[str, Any]],
    retrieved_by_candidate: dict[str, set[str]],
    existing_ids: set[str],
    forbidden_terms: list[str],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("公式归档结果不是有效对象")
    operations = _records(payload.get("operations"), label="公式归档操作", maximum=max(1, len(candidates)))
    candidate_by_id = {item["candidate_id"]: item for item in candidates}
    seen: set[str] = set()
    existing_targets: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(operations, start=1):
        candidate_ids = _strings(item.get("candidate_ids"), label=f"第 {index} 个公式归档操作候选", minimum=1, maximum=8)
        invalid = [candidate_id for candidate_id in candidate_ids if candidate_id not in candidate_by_id]
        if invalid:
            raise RuntimeError(f"第 {index} 个公式归档操作引用了无效候选")
        if seen.intersection(candidate_ids):
            raise RuntimeError("同一个公式候选不能重复归档")
        seen.update(candidate_ids)
        action = str(item.get("action") or "").strip().lower()
        if action not in {"reuse", "improve", "create"}:
            raise RuntimeError(f"第 {index} 个公式归档操作类型无效")
        formula_id = str(item.get("formula_id") or "").strip()
        if action in {"reuse", "improve"}:
            if formula_id not in existing_ids:
                raise RuntimeError(f"第 {index} 个公式归档操作未匹配到已有公式")
            allowed = set.intersection(*(retrieved_by_candidate.get(candidate_id, set()) for candidate_id in candidate_ids))
            if formula_id not in allowed:
                raise RuntimeError(f"第 {index} 个公式归档操作引用了检索结果之外的公式")
            if formula_id in existing_targets:
                raise RuntimeError("同一张已有公式应在一个操作中处理全部候选")
            existing_targets.add(formula_id)
        elif formula_id:
            raise RuntimeError("新增公式时 formula_id 必须为空")
        categories = {candidate_by_id[candidate_id]["category"] for candidate_id in candidate_ids}
        if len(categories) != 1:
            raise RuntimeError("不同分类的公式候选不能合并")
        operation: dict[str, Any] = {
            "candidate_ids": candidate_ids,
            "action": action,
            "formula_id": formula_id,
            "reason": _text(item.get("reason"), label=f"第 {index} 个公式归档理由", minimum=12, maximum=600),
        }
        if action in {"improve", "create"}:
            # Persisted checkpoints store the normalized card under `card`,
            # while the model request returns its fields at operation level.
            # Accept both shapes so a retry can reuse a successful call.
            card_input = item
            if isinstance(item.get("card"), dict):
                card_input = {**item, **item["card"]}
            operation["card"] = _normalize_formula_card(card_input, forbidden_terms=forbidden_terms, label=f"第 {index} 张公共公式")
            if operation["card"]["category"] not in categories:
                raise RuntimeError("公共公式分类与来源候选不一致")
        normalized.append(operation)
    missing = set(candidate_by_id).difference(seen)
    if missing:
        raise RuntimeError(f"公式候选未完成归档：{'、'.join(sorted(missing))}")
    return {"operations": normalized}


def _curation_checkpoint(
    *,
    input_path: Path,
    output_path: Path,
    input_payload: dict[str, Any],
    validator,
    previous_work_dirs: list[Path] | None = None,
) -> dict[str, Any] | None:
    directories = [input_path.parent, *(previous_work_dirs or [])]
    for directory in directories:
        candidate_input = directory / input_path.name
        candidate_output = directory / output_path.name
        if not candidate_input.is_file() or not candidate_output.is_file():
            continue
        try:
            if json.loads(candidate_input.read_text(encoding="utf-8")) != input_payload:
                continue
            validated = validator(extract_json_object(candidate_output.read_text(encoding="utf-8")))
        except (OSError, RuntimeError, json.JSONDecodeError):
            continue
        if candidate_output != output_path:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate_input, input_path)
            shutil.copy2(candidate_output, output_path)
        return validated
    return None


def _curation_failure_path(output_path: Path) -> Path:
    return output_path.with_name(f"{output_path.stem}.failure.json")


def _curation_input_fingerprint(input_payload: dict[str, Any]) -> str:
    return hashlib.sha256(_json(input_payload).encode("utf-8")).hexdigest()


def _load_curation_failure(
    *,
    output_path: Path,
    input_payload: dict[str, Any],
    task_name: str,
    previous_work_dirs: list[Path] | None = None,
) -> str:
    fingerprint = _curation_input_fingerprint(input_payload)
    paths = [
        _curation_failure_path(output_path),
        *((directory / _curation_failure_path(output_path).name) for directory in (previous_work_dirs or [])),
    ]
    for path in paths:
        if not path.is_file():
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict):
            continue
        if value.get("task_name") != task_name or value.get("input_fingerprint") != fingerprint:
            continue
        error = str(value.get("error") or "").strip()
        if error:
            return error
    return ""


def _write_curation_failure(
    *,
    output_path: Path,
    input_payload: dict[str, Any],
    task_name: str,
    error: str,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _write_value = {
        "task_name": task_name,
        "input_fingerprint": _curation_input_fingerprint(input_payload),
        "error": error,
        "retry_limit": MODEL_RETRY_LIMIT,
    }
    output = _curation_failure_path(output_path)
    output.write_text(_json(_write_value) + "\n", encoding="utf-8")


def invoke_formula_curation(
    *,
    conn: sqlite3.Connection,
    result: dict[str, Any],
    work_dir: Path,
    model_runtime: dict[str, Any] | None,
    previous_work_dirs: list[Path] | None = None,
) -> dict[str, Any]:
    candidates = result["formula_candidates"]
    if not candidates:
        return {"operations": []}
    catalog = _formula_catalog(conn)
    retrieval_candidates = [_formula_retrieval_item(item) for item in candidates]
    enriched, retrieved_catalog = attach_retrieval_matches(retrieval_candidates, catalog, limit=5)
    retrieved_by_candidate = {
        item["candidate_id"]: set(item["retrieved_mechanism_ids"])
        for item in enriched
    }
    public_candidates = [{key: value for key, value in item.items() if key not in {"function", "trigger", "payoff", "transferable_strategy", "failure_boundary"}} for item in enriched]
    public_catalog = [{key: value for key, value in item.items() if key not in {"function", "trigger", "payoff", "transferable_strategy", "failure_boundary"}} for item in retrieved_catalog]
    input_payload = {
        "curation_version": FORMULA_CURATION_VERSION,
        "candidates": public_candidates,
        "retrieved_formulas": public_catalog,
    }
    input_path = work_dir / "formula-curation-input.json"
    output_path = work_dir / "formula-curation-result.json"
    validate = lambda payload: _validate_formula_curation(
        payload,
        candidates=candidates,
        retrieved_by_candidate=retrieved_by_candidate,
        existing_ids={item["id"] for item in public_catalog},
        forbidden_terms=result["case_card"]["source_specific_terms"],
    )
    checkpoint = _curation_checkpoint(
        input_path=input_path,
        output_path=output_path,
        input_payload=input_payload,
        validator=validate,
        previous_work_dirs=previous_work_dirs,
    )
    if checkpoint is not None:
        return checkpoint
    input_path.write_text(_json(input_payload) + "\n", encoding="utf-8")
    prompt = f"""当前执行单剧蒸馏的公式归档。不要重新分析原剧，也不要生成案例卡或创作原则。请先比较创作阶段和抽象粒度，再比较使用场景、核心公式、使用方法、生效原因、完成标准和失效边界，为全部候选选择 reuse、improve 或 create，只返回 JSON 对象 {{\"operations\": [...]}}。

候选和检索到的公共公式：
{json.dumps(input_payload, ensure_ascii=False, indent=2)}

要求：
1. 每个 candidate_id 必须且只能出现一次；创作粒度、核心因果和使用方法相同的候选才可以放在同一操作。
2. 题材、背景或受众不同，优先补充同一张公式的 genre_adaptations，不得仅因标签不同新增公式。
3. reuse/improve 只能引用对应候选 retrieved_mechanism_ids 中的 formula_id；create 的 formula_id 必须为空。
4. reuse 只返回 candidate_ids、action、formula_id、reason。
5. improve/create 还必须返回 name、category、stages、usage_scenario、not_applicable、goal、core_formula、conditions、variables、steps、mechanism、observable_checks、failure_modes、rewrite_usage、original_usage、genre_adaptations。creative_decision、creative_problem 和 expected_effect 由程序补全，不返回。
6. 仅阅读适用阶段、usage_scenario 和 name 就应能判断是否调用。一张公式只服务一个创作粒度；只有试稿与完稿可在方法一致时共用。
7. 改写用法必须服从原剧主线和已确定事实；新创作用法必须说明怎样产生原创内容。
"""
    last_error = _load_curation_failure(
        output_path=output_path,
        input_payload=input_payload,
        task_name="formula_catalog_curation",
        previous_work_dirs=previous_work_dirs,
    )
    for attempt in range(CURATION_VALIDATION_ATTEMPTS):
        current_prompt = prompt
        if last_error:
            current_prompt += f"\n上一次返回未通过确定性校验，请只修复这些问题后重新返回完整 JSON：{last_error}"
        try:
            response = call_direct_model(
                system_prompt=direct_skill_system_prompt(
                    "script-formula-curation",
                    task_contract="formula_catalog_curation",
                ),
                user_prompt=current_prompt,
                runtime=_curation_runtime(model_runtime),
                log_path=work_dir / f"formula-curation-attempt-{attempt + 1}.log",
                timeout_seconds=30 * 60,
            )
            output_path.with_name(f"formula-curation-attempt-{attempt + 1}.txt").write_text(response, encoding="utf-8")
            validated = validate(extract_json_object(response))
        except Exception as exc:
            last_error = str(exc).strip() or exc.__class__.__name__
            continue
        output_path.write_text(_json(validated) + "\n", encoding="utf-8")
        _curation_failure_path(output_path).unlink(missing_ok=True)
        return validated
    _write_curation_failure(
        output_path=output_path,
        input_payload=input_payload,
        task_name="formula_catalog_curation",
        error=last_error,
    )
    raise RuntimeError(f"公式归档结果未通过校验（已重试 {MODEL_RETRY_LIMIT} 次）：{last_error}")


def _formula_id(card: dict[str, Any]) -> str:
    signature = _json({
        "category": card["category"],
        "stages": card["stages"],
        "usage_scenario": card["usage_scenario"],
        "core_formula": card["core_formula"],
        "steps": card["steps"],
    })
    return f"formula-{hashlib.sha256(signature.encode('utf-8')).hexdigest()[:20]}"


def _formula_content(card: dict[str, Any]) -> dict[str, Any]:
    return {key: card[key] for key in FORMULA_CARD_FIELDS if key not in {"name", "category", "stages", "creative_decision", "creative_problem"}}


def _refresh_formula(conn: sqlite3.Connection, formula_id: str) -> None:
    row = conn.execute(
        "SELECT id, content_json FROM script_library_formulas WHERE id = ?",
        (formula_id,),
    ).fetchone()
    if not row:
        return
    sources = conn.execute(
        "SELECT DISTINCT script_id FROM script_library_formula_sources WHERE formula_id = ? ORDER BY script_id",
        (formula_id,),
    ).fetchall()
    script_ids = [int(item["script_id"]) for item in sources]
    if not script_ids:
        conn.execute("DELETE FROM script_library_formulas WHERE id = ?", (formula_id,))
        return
    selected: set[str] = set()
    content = _load_json(row["content_json"], {})
    for adaptation in content.get("genre_adaptations", []):
        if isinstance(adaptation, dict):
            selected.update(
                str(tag)
                for tag in adaptation.get("tags", [])
                if str(tag) in CONTROLLED_TAG_VALUES
            )
    if not selected:
        placeholders = ",".join("?" for _ in script_ids)
        scripts = conn.execute(
            f"SELECT theme_tags_json, setting_tags_json, background_tags_json, audience_tags_json FROM script_library_scripts WHERE id IN ({placeholders})",
            script_ids,
        ).fetchall()
        for script in scripts:
            for column in ("theme_tags_json", "setting_tags_json", "background_tags_json", "audience_tags_json"):
                selected.update(_load_json(script[column], []))
    ordered = [tag for values in TAG_TAXONOMY.values() for tag in values if tag in selected]
    conn.execute(
        """
        UPDATE script_library_formulas
        SET applicable_tags_json = ?, source_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            _json(ordered),
            len(script_ids),
            "active" if len(script_ids) >= FORMULA_ACTIVATION_MIN_SOURCES else "candidate",
            formula_id,
        ),
    )


def apply_formula_curation(
    conn: sqlite3.Connection,
    *,
    script_id: int,
    result: dict[str, Any],
    curation: dict[str, Any],
) -> dict[str, Any]:
    candidates = {item["candidate_id"]: item for item in result["formula_candidates"]}
    targets = {item["formula_id"] for item in curation["operations"] if item["action"] in {"reuse", "improve"}}
    previous = {
        str(row["formula_id"])
        for row in conn.execute(
            "SELECT DISTINCT formula_id FROM script_library_formula_sources WHERE script_id = ?",
            (script_id,),
        ).fetchall()
    }
    conn.execute("DELETE FROM script_library_formula_sources WHERE script_id = ?", (script_id,))
    for formula_id in previous.difference(targets):
        _refresh_formula(conn, formula_id)
    action_counts = {"reuse": 0, "improve": 0, "create": 0}
    formula_ids: list[str] = []
    candidate_to_formula: dict[str, str] = {}
    for operation in curation["operations"]:
        action = operation["action"]
        card = operation.get("card")
        formula_id = operation["formula_id"] if action != "create" else _formula_id(card)
        existing = conn.execute("SELECT * FROM script_library_formulas WHERE id = ?", (formula_id,)).fetchone()
        if action in {"reuse", "improve"} and not existing:
            raise RuntimeError(f"待更新的公共公式不存在：{formula_id}")
        if action in {"improve", "create"}:
            revision = int(existing["revision"] or 0) + 1 if existing else 1
            conn.execute(
                """
                INSERT INTO script_library_formulas (
                    id, category, name, stages_json, creative_decision, creative_problem,
                    status, origin, revision, content_json
                ) VALUES (?, ?, ?, ?, ?, ?, 'candidate', 'script-distillation', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    category = excluded.category, name = excluded.name, stages_json = excluded.stages_json,
                    creative_decision = excluded.creative_decision, creative_problem = excluded.creative_problem,
                    revision = excluded.revision, content_json = excluded.content_json,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    formula_id,
                    card["category"],
                    card["name"],
                    _json(card["stages"]),
                    card["creative_decision"],
                    card["creative_problem"],
                    revision,
                    _json({**_formula_content(card), "curation_version": FORMULA_CURATION_VERSION}),
                ),
            )
        elif existing:
            # Reuse keeps the public formula stable while adding the new
            # script's tag-specific usage notes as evidence for later review.
            existing_content = _load_json(existing["content_json"], {})
            adaptations = list(existing_content.get("genre_adaptations") or [])
            for candidate_id in operation["candidate_ids"]:
                for adaptation in candidates[candidate_id].get("genre_adaptations", []):
                    signature = _json(adaptation)
                    if not any(_json(item) == signature for item in adaptations if isinstance(item, dict)):
                        adaptations.append(adaptation)
            if adaptations != list(existing_content.get("genre_adaptations") or []):
                existing_content["genre_adaptations"] = adaptations
                conn.execute(
                    "UPDATE script_library_formulas SET content_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (_json(existing_content), formula_id),
                )
        for candidate_id in operation["candidate_ids"]:
            candidate = candidates[candidate_id]
            conn.execute(
                """
                INSERT INTO script_library_formula_sources (
                    formula_id, script_id, candidate_id, action, decision_reason,
                    evidence_references_json, contribution_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(formula_id, script_id, candidate_id) DO UPDATE SET
                    action = excluded.action, decision_reason = excluded.decision_reason,
                    evidence_references_json = excluded.evidence_references_json,
                    contribution_json = excluded.contribution_json, updated_at = CURRENT_TIMESTAMP
                """,
                (
                    formula_id,
                    script_id,
                    candidate_id,
                    action,
                    operation["reason"],
                    _json(candidate["evidence_references"]),
                    _json(candidate),
                ),
            )
            candidate_to_formula[candidate_id] = formula_id
        _refresh_formula(conn, formula_id)
        action_counts[action] += 1
        if formula_id not in formula_ids:
            formula_ids.append(formula_id)
    return {"actions": action_counts, "formula_ids": formula_ids, "candidate_to_formula": candidate_to_formula}


def _principle_catalog(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM script_library_principles WHERE status != 'retired' ORDER BY source_count DESC, id"
    ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "name": str(row["title"]),
            "stages": _load_json(row["stages_json"], []),
            "statement": str(row["statement"]),
            "rationale": str(row["rationale"]),
            "applies_when": _load_json(row["applies_when_json"], []),
            "fails_or_changes_when": _load_json(row["fails_or_changes_when_json"], []),
            "review_criteria": _load_json(row["review_criteria_json"], []),
            "source_count": int(row["source_count"] or 0),
            "status": str(row["status"]),
            "function": str(row["statement"]),
            "trigger": "；".join(_load_json(row["applies_when_json"], [])),
            "payoff": str(row["rationale"]),
            "transferable_strategy": "；".join(_load_json(row["review_criteria_json"], [])),
            "failure_boundary": "；".join(_load_json(row["fails_or_changes_when_json"], [])),
        }
        for row in rows
    ]


def _principle_stage_matches(observation: dict[str, Any], principle: dict[str, Any]) -> bool:
    observation_stages = {str(item) for item in observation.get("stages", []) if str(item).strip()}
    principle_stages = {str(item) for item in principle.get("stages", []) if str(item).strip()}
    if not observation_stages or not principle_stages:
        return False
    return "global" in observation_stages or "global" in principle_stages or bool(
        observation_stages.intersection(principle_stages)
    )


def _prepare_principle_curation_input(
    observations: list[dict[str, Any]],
    catalog: list[dict[str, Any]],
    *,
    limit: int = 5,
) -> tuple[dict[str, Any], dict[str, set[str]]]:
    """Give every observation exactly the principle cards it is allowed to select."""
    public_observations: list[dict[str, Any]] = []
    retrieved_by_observation: dict[str, set[str]] = {}
    for observation in observations:
        retrieval_item = {
            **observation,
            "name": observation["statement"],
            "function": observation["statement"],
            "trigger": "；".join(observation["applies_when"]),
            "payoff": observation["rationale"],
            "transferable_strategy": "；".join(observation["review_criteria"]),
            "failure_boundary": "；".join(observation["fails_or_changes_when"]),
        }
        stage_catalog = [item for item in catalog if _principle_stage_matches(observation, item)]
        enriched, retrieved_catalog = attach_retrieval_matches([retrieval_item], stage_catalog, limit=limit)
        retrieved_ids = [str(item) for item in enriched[0]["retrieved_mechanism_ids"]]
        observation_id = str(observation["observation_id"])
        retrieved_by_observation[observation_id] = set(retrieved_ids)
        public_observations.append({
            **observation,
            "retrieved_principle_ids": retrieved_ids,
            "retrieved_principles": [
                {
                    key: value
                    for key, value in item.items()
                    if key not in {"function", "trigger", "payoff", "transferable_strategy", "failure_boundary"}
                }
                for item in retrieved_catalog
            ],
        })
    return {
        "curation_version": PRINCIPLE_CURATION_VERSION,
        "observations": public_observations,
    }, retrieved_by_observation


def _validate_principle_curation(
    payload: Any,
    *,
    observations: list[dict[str, Any]],
    retrieved_by_observation: dict[str, set[str]],
    existing_ids: set[str],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("原则整理结果不是有效对象")
    operations = _records(payload.get("operations"), label="原则整理操作", maximum=max(1, len(observations)))
    observation_by_id = {item["observation_id"]: item for item in observations}
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(operations, start=1):
        observation_ids = _strings(item.get("observation_ids"), label=f"第 {index} 个原则整理操作观察", minimum=1, maximum=6)
        if any(item_id not in observation_by_id for item_id in observation_ids):
            raise RuntimeError(f"第 {index} 个原则整理操作引用了无效观察")
        if seen.intersection(observation_ids):
            raise RuntimeError("同一条原则观察不能重复整理")
        seen.update(observation_ids)
        action = str(item.get("action") or "").strip().lower()
        if action not in {"support", "bound", "counter", "propose"}:
            raise RuntimeError(f"第 {index} 个原则整理操作类型无效")
        principle_id = str(item.get("principle_id") or "").strip()
        if action != "propose":
            if principle_id not in existing_ids:
                raise RuntimeError(f"第 {index} 个原则整理操作未匹配到已有原则")
            allowed = set.intersection(*(retrieved_by_observation.get(item_id, set()) for item_id in observation_ids))
            if principle_id not in allowed:
                observation_label = "、".join(observation_ids)
                if not allowed:
                    raise RuntimeError(
                        f"第 {index} 个原则整理操作的观察 {observation_label} 没有共同的已有原则候选；"
                        "请拆分这些观察，或在它们确实是同一条新原则时改用 propose 并清空 principle_id"
                    )
                raise RuntimeError(
                    f"第 {index} 个原则整理操作中，观察 {observation_label} 选择了不在其候选范围内的 "
                    f"{principle_id}；只能选择 {'、'.join(sorted(allowed))}，若都不覆盖则改用 propose 并清空 principle_id"
                )
        elif principle_id:
            raise RuntimeError("新增原则候选时 principle_id 必须为空")
        operation = {
            "observation_ids": observation_ids,
            "action": action,
            "principle_id": principle_id,
            "reason": _text(item.get("reason"), label=f"第 {index} 个原则整理理由", minimum=12, maximum=600),
        }
        if action == "propose":
            operation["title"] = _text(item.get("title"), label=f"第 {index} 个原则候选名称", minimum=4, maximum=80)
        normalized.append(operation)
    missing = set(observation_by_id).difference(seen)
    if missing:
        raise RuntimeError(f"原则观察未完成整理：{'、'.join(sorted(missing))}")
    return {"operations": normalized}


def invoke_principle_curation(
    *,
    conn: sqlite3.Connection,
    result: dict[str, Any],
    work_dir: Path,
    model_runtime: dict[str, Any] | None,
    previous_work_dirs: list[Path] | None = None,
) -> dict[str, Any]:
    observations = result["principle_observations"]
    if not observations:
        return {"operations": []}
    catalog = _principle_catalog(conn)
    input_payload, retrieved_by_observation = _prepare_principle_curation_input(observations, catalog)
    visible_principle_ids = set().union(*retrieved_by_observation.values()) if retrieved_by_observation else set()
    input_path = work_dir / "principle-curation-input.json"
    output_path = work_dir / "principle-curation-result.json"
    validate = lambda payload: _validate_principle_curation(
        payload,
        observations=observations,
        retrieved_by_observation=retrieved_by_observation,
        existing_ids=visible_principle_ids,
    )
    checkpoint = _curation_checkpoint(
        input_path=input_path,
        output_path=output_path,
        input_payload=input_payload,
        validator=validate,
        previous_work_dirs=previous_work_dirs,
    )
    if checkpoint is not None:
        return checkpoint
    input_path.write_text(_json(input_payload) + "\n", encoding="utf-8")
    prompt = f"""当前执行单剧蒸馏的创作原则整理。不要重新分析原剧，也不要生成案例卡或公式。请把每条原则观察与检索到的已有原则比较，只返回 JSON 对象 {{\"operations\": [...]}}。

原则观察和检索结果：
{json.dumps(input_payload, ensure_ascii=False, indent=2)}

要求：
1. 每个 observation_id 必须且只能出现一次；说明同一条原则的观察可以放进同一个操作。
2. 已有原则准确覆盖时用 support；补充适用条件或失效边界时用 bound；构成反例时用 counter；没有已有原则可以解释时用 propose。
3. support、bound、counter 只能引用对应观察 retrieved_principle_ids 中的 principle_id；不得借用其他观察的候选。propose 的 principle_id 必须为空，并补充简短 title。
4. 单剧只能增加支持、边界、反例或待审核候选，不得把候选标记为正式原则，也不得自动改写已有原则。
5. 原则是跨题材的阶段质量要求，不要把公开羞辱、倒计时等具体写法直接命名为原则。
"""
    last_error = _load_curation_failure(
        output_path=output_path,
        input_payload=input_payload,
        task_name="principle_catalog_curation",
        previous_work_dirs=previous_work_dirs,
    )
    for attempt in range(CURATION_VALIDATION_ATTEMPTS):
        current_prompt = prompt
        if last_error:
            current_prompt += f"\n上一次返回未通过确定性校验，请只修复这些问题后重新返回完整 JSON：{last_error}"
        try:
            response = call_direct_model(
                system_prompt=direct_skill_system_prompt(
                    "script-principle-curation",
                    task_contract="principle_catalog_curation",
                ),
                user_prompt=current_prompt,
                runtime=_curation_runtime(model_runtime),
                log_path=work_dir / f"principle-curation-attempt-{attempt + 1}.log",
                timeout_seconds=30 * 60,
            )
            output_path.with_name(f"principle-curation-attempt-{attempt + 1}.txt").write_text(response, encoding="utf-8")
            validated = validate(extract_json_object(response))
        except Exception as exc:
            last_error = str(exc).strip() or exc.__class__.__name__
            continue
        output_path.write_text(_json(validated) + "\n", encoding="utf-8")
        _curation_failure_path(output_path).unlink(missing_ok=True)
        return validated
    _write_curation_failure(
        output_path=output_path,
        input_payload=input_payload,
        task_name="principle_catalog_curation",
        error=last_error,
    )
    raise RuntimeError(f"创作原则整理结果未通过校验（已重试 {MODEL_RETRY_LIMIT} 次）：{last_error}")


def _principle_id(observation: dict[str, Any]) -> str:
    signature = _json({
        "stages": observation["stages"],
        "statement": observation["statement"],
        "rationale": observation["rationale"],
    })
    return f"principle-{hashlib.sha256(signature.encode('utf-8')).hexdigest()[:20]}"


def _refresh_principle(conn: sqlite3.Connection, principle_id: str) -> None:
    row = conn.execute("SELECT id FROM script_library_principles WHERE id = ?", (principle_id,)).fetchone()
    if not row:
        return
    count = int(conn.execute(
        "SELECT COUNT(DISTINCT script_id) FROM script_library_principle_observations WHERE principle_id = ? AND status != 'rejected'",
        (principle_id,),
    ).fetchone()[0])
    if not count:
        conn.execute("DELETE FROM script_library_principles WHERE id = ? AND status = 'candidate'", (principle_id,))
        return
    conn.execute(
        "UPDATE script_library_principles SET source_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (count, principle_id),
    )


def apply_principle_curation(
    conn: sqlite3.Connection,
    *,
    script_id: int,
    result: dict[str, Any],
    curation: dict[str, Any],
    candidate_to_formula: dict[str, str],
) -> dict[str, Any]:
    observations = {item["observation_id"]: item for item in result["principle_observations"]}
    previous = {
        str(row["principle_id"])
        for row in conn.execute(
            "SELECT DISTINCT principle_id FROM script_library_principle_observations WHERE script_id = ? AND principle_id IS NOT NULL",
            (script_id,),
        ).fetchall()
    }
    conn.execute("DELETE FROM script_library_principle_observations WHERE script_id = ?", (script_id,))
    action_counts = {"support": 0, "bound": 0, "counter": 0, "propose": 0}
    principle_ids: list[str] = []
    for operation in curation["operations"]:
        action = operation["action"]
        representative = observations[operation["observation_ids"][0]]
        principle_id = operation["principle_id"] if action != "propose" else _principle_id(representative)
        if action == "propose":
            conn.execute(
                """
                INSERT INTO script_library_principles (
                    id, title, stages_json, statement, rationale, applies_when_json,
                    fails_or_changes_when_json, review_criteria_json, status, origin
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 'script-distillation')
                ON CONFLICT(id) DO NOTHING
                """,
                (
                    principle_id,
                    operation["title"],
                    _json(representative["stages"]),
                    representative["statement"],
                    representative["rationale"],
                    _json(representative["applies_when"]),
                    _json(representative["fails_or_changes_when"]),
                    _json(representative["review_criteria"]),
                ),
            )
        elif not conn.execute("SELECT id FROM script_library_principles WHERE id = ?", (principle_id,)).fetchone():
            raise RuntimeError(f"待关联的创作原则不存在：{principle_id}")
        relation = {"support": "supports", "bound": "bounds", "counter": "counters", "propose": "proposes"}[action]
        for observation_id in operation["observation_ids"]:
            observation = observations[observation_id]
            related_formula_ids = [
                candidate_to_formula[item]
                for item in observation["related_formula_candidate_ids"]
                if item in candidate_to_formula
            ]
            row_id = f"principle-observation-{script_id}-{observation_id}"
            conn.execute(
                """
                INSERT INTO script_library_principle_observations (
                    id, script_id, local_observation_id, principle_id, relation, stages_json,
                    statement, rationale, applies_when_json, fails_or_changes_when_json,
                    review_criteria_json, related_formula_ids_json, evidence_references_json,
                    decision_reason, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row_id,
                    script_id,
                    observation_id,
                    principle_id,
                    relation,
                    _json(observation["stages"]),
                    observation["statement"],
                    observation["rationale"],
                    _json(observation["applies_when"]),
                    _json(observation["fails_or_changes_when"]),
                    _json(observation["review_criteria"]),
                    _json(related_formula_ids),
                    _json(observation["evidence_references"]),
                    operation["reason"],
                    "pending" if action in {"bound", "counter", "propose"} else "linked",
                ),
            )
        _refresh_principle(conn, principle_id)
        action_counts[action] += 1
        if principle_id not in principle_ids:
            principle_ids.append(principle_id)
    for principle_id in previous.difference(principle_ids):
        _refresh_principle(conn, principle_id)
    return {"actions": action_counts, "principle_ids": principle_ids}


def save_distillation(conn: sqlite3.Connection, script: sqlite3.Row, result: dict[str, Any]) -> None:
    tags = result["tags"]
    conn.execute(
        """
        UPDATE script_library_scripts
        SET status = 'ready', summary = ?, theme_tags_json = ?, setting_tags_json = ?,
            background_tags_json = ?, audience_tags_json = ?, case_card_json = ?,
            formulas_json = ?, distillation_result_json = ?, distillation_version = ?,
            error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            result["summary"],
            _json(tags["theme"]),
            _json(tags["setting"]),
            _json(tags["background"]),
            _json(tags["audience"]),
            _json(result["case_card"]),
            _json(result["formula_candidates"]),
            _json(result),
            DISTILLATION_VERSION,
            int(script["id"]),
        ),
    )


def _source_titles(conn: sqlite3.Connection, script_ids: list[int]) -> list[str]:
    if not script_ids:
        return []
    placeholders = ",".join("?" for _ in script_ids)
    return [
        str(row["title"])
        for row in conn.execute(
            f"SELECT title FROM script_library_scripts WHERE id IN ({placeholders}) ORDER BY title",
            script_ids,
        ).fetchall()
    ]


def _source_scripts(conn: sqlite3.Connection, script_ids: list[int]) -> list[dict[str, Any]]:
    """Return the explicit formula-to-script relation for admin consumers."""
    if not script_ids:
        return []
    placeholders = ",".join("?" for _ in script_ids)
    return [
        {"id": int(row["id"]), "title": str(row["title"])}
        for row in conn.execute(
            f"SELECT id, title FROM script_library_scripts WHERE id IN ({placeholders}) ORDER BY title",
            script_ids,
        ).fetchall()
    ]


def public_formula(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    sources = conn.execute(
        "SELECT DISTINCT script_id FROM script_library_formula_sources WHERE formula_id = ? ORDER BY script_id",
        (row["id"],),
    ).fetchall()
    script_ids = [int(item["script_id"]) for item in sources]
    content = _load_json(row["content_json"], {})
    usage_scenario = str(content.get("usage_scenario") or row["creative_decision"] or row["creative_problem"])
    evidence_by_script: dict[int, set[str]] = {}
    for source in conn.execute(
        "SELECT script_id, evidence_references_json FROM script_library_formula_sources WHERE formula_id = ? ORDER BY script_id",
        (row["id"],),
    ).fetchall():
        script_id = int(source["script_id"])
        evidence_by_script.setdefault(script_id, set()).update(
            str(reference)
            for reference in _load_json(source["evidence_references_json"], [])
            if str(reference).strip()
        )
    evidence = [
        {"script_id": script_id, "evidence_references": sorted(references)}
        for script_id, references in sorted(evidence_by_script.items())
    ]
    return {
        "id": str(row["id"]),
        "card_kind": "formula",
        "category": str(row["category"]),
        "title": str(row["name"]),
        "description": usage_scenario,
        "stages": _load_json(row["stages_json"], []),
        "usage_scenario": usage_scenario,
        "not_applicable": content.get("not_applicable") or [],
        "core_formula": str(content.get("core_formula") or ""),
        "usage_guidance": content.get("steps") or [],
        "completion_criteria": content.get("observable_checks") or [],
        "creative_decision": usage_scenario,
        "applicable_tags": _load_json(row["applicable_tags_json"], []),
        "source_script_ids": script_ids,
        "source_count": len(script_ids),
        "source_script_titles": _source_titles(conn, script_ids),
        "source_scripts": _source_scripts(conn, script_ids),
        "status": str(row["status"]),
        "origin": str(row["origin"]),
        "revision": int(row["revision"] or 1),
        "content": {
            **content,
            "usage_scenario": usage_scenario,
            "not_applicable": content.get("not_applicable") or [],
            "core_formula": str(content.get("core_formula") or ""),
            "evidence": evidence,
        },
    }


def public_principle(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    sources = conn.execute(
        "SELECT DISTINCT script_id FROM script_library_principle_observations WHERE principle_id = ? AND status != 'rejected' ORDER BY script_id",
        (row["id"],),
    ).fetchall()
    script_ids = [int(item["script_id"]) for item in sources]
    observations = [
        {
            "id": str(observation["id"]),
            "script_id": int(observation["script_id"]),
            "local_observation_id": str(observation["local_observation_id"]),
            "relation": str(observation["relation"]),
            "stages": _load_json(observation["stages_json"], []),
            "statement": str(observation["statement"]),
            "rationale": str(observation["rationale"]),
            "applies_when": _load_json(observation["applies_when_json"], []),
            "fails_or_changes_when": _load_json(observation["fails_or_changes_when_json"], []),
            "review_criteria": _load_json(observation["review_criteria_json"], []),
            "related_formula_ids": _load_json(observation["related_formula_ids_json"], []),
            "evidence_references": _load_json(observation["evidence_references_json"], []),
            "decision_reason": str(observation["decision_reason"] or ""),
        }
        for observation in conn.execute(
            "SELECT * FROM script_library_principle_observations WHERE principle_id = ? ORDER BY script_id, id",
            (row["id"],),
        ).fetchall()
    ]
    return {
        "id": str(row["id"]),
        "card_kind": "principle",
        "category": "principle",
        "title": str(row["title"]),
        "description": str(row["statement"]),
        "stages": _load_json(row["stages_json"], []),
        "creative_decision": "",
        "applicable_tags": [],
        "source_script_ids": script_ids,
        "source_count": len(script_ids),
        "source_script_titles": _source_titles(conn, script_ids),
        "source_scripts": _source_scripts(conn, script_ids),
        "status": str(row["status"]),
        "origin": str(row["origin"]),
        "revision": int(row["version"] or 1),
        "content": {
            "statement": str(row["statement"]),
            "rationale": str(row["rationale"]),
            "applies_when": _load_json(row["applies_when_json"], []),
            "fails_or_changes_when": _load_json(row["fails_or_changes_when_json"], []),
            "review_criteria": _load_json(row["review_criteria_json"], []),
            "skill_keys": _load_json(row["skill_keys_json"], []),
            "observations": observations,
        },
    }


def cards_for_script(conn: sqlite3.Connection, script_id: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    formulas = [
        public_formula(conn, row)
        for row in conn.execute(
            """
            SELECT formula.* FROM script_library_formulas AS formula
            WHERE formula.status != 'retired' AND EXISTS (
                SELECT 1 FROM script_library_formula_sources AS source
                WHERE source.formula_id = formula.id AND source.script_id = ?
            )
            ORDER BY formula.category, formula.name
            """,
            (script_id,),
        ).fetchall()
    ]
    principles = [
        public_principle(conn, row)
        for row in conn.execute(
            """
            SELECT principle.* FROM script_library_principles AS principle
            WHERE principle.status != 'retired' AND EXISTS (
                SELECT 1 FROM script_library_principle_observations AS observation
                WHERE observation.principle_id = principle.id AND observation.script_id = ?
            )
            ORDER BY principle.status, principle.title
            """,
            (script_id,),
        ).fetchall()
    ]
    return formulas, principles


def knowledge_stats(conn: sqlite3.Connection, *, include_legacy: bool = True) -> dict[str, Any]:
    counts = {category: 0 for category in FORMULA_CATEGORIES}
    for row in conn.execute(
        "SELECT category, COUNT(*) AS count FROM script_library_formulas WHERE status != 'retired' GROUP BY category"
    ).fetchall():
        counts[str(row["category"])] = int(row["count"] or 0)
    legacy_formula_count = int(conn.execute(
        "SELECT COUNT(*) FROM script_library_formula_cards WHERE formula_type != 'mechanism' AND status != 'retired'"
    ).fetchone()[0]) if include_legacy else 0
    legacy_principle_count = int(conn.execute(
        "SELECT COUNT(*) FROM script_library_formula_cards WHERE formula_type = 'mechanism' AND status != 'retired'"
    ).fetchone()[0]) if include_legacy else 0
    return {
        "formula_cards": sum(counts.values()) + legacy_formula_count,
        "principle_cards": int(conn.execute(
            "SELECT COUNT(*) FROM script_library_principles WHERE status != 'retired'"
        ).fetchone()[0]) + legacy_principle_count,
        # Keep the retired key in the response for old clients; new clients
        # use the ten explicit formula categories above.
        "formula_counts": {
            **counts,
            "mechanism": int(conn.execute(
                "SELECT COUNT(*) FROM script_library_formula_cards WHERE formula_type = 'mechanism' AND status != 'retired'"
            ).fetchone()[0]) if include_legacy else 0,
        },
    }


def _formula_tag_facets(conn: sqlite3.Connection) -> dict[str, list[str]]:
    used: set[str] = set()
    for row in conn.execute(
        "SELECT applicable_tags_json FROM script_library_formulas WHERE status != 'retired'"
    ).fetchall():
        used.update(_load_json(row["applicable_tags_json"], []))
    return {kind: [tag for tag in values if tag in used] for kind, values in TAG_TAXONOMY.items()}


def _card_filter_counts(
    conn: sqlite3.Connection,
    *,
    table: str,
    alias: str,
    base_conditions: list[str],
    base_params: list[Any],
    stage: str,
    verification_status: str,
) -> dict[str, dict[str, int]]:
    """Return linked counts for the stage and verification facets.

    Each facet ignores its own selected value while retaining the other
    facet's value. This lets the UI explain the result size before a user
    changes the selection, including options that would currently be empty.
    """

    def count(where_conditions: list[str], params: list[Any]) -> int:
        where = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""
        return int(conn.execute(f"SELECT COUNT(*) FROM {table} AS {alias} {where}", params).fetchone()[0])

    status_conditions = [*base_conditions]
    status_params = [*base_params]
    if stage:
        status_conditions.append(f"EXISTS (SELECT 1 FROM json_each({alias}.stages_json) WHERE value = ?)")
        status_params.append(stage)
    status_counts = {status: 0 for status in ("candidate", "active")}
    status_where = f"WHERE {' AND '.join(status_conditions)}" if status_conditions else ""
    for row in conn.execute(
        f"SELECT {alias}.status AS status, COUNT(*) AS count FROM {table} AS {alias} {status_where} GROUP BY {alias}.status",
        status_params,
    ).fetchall():
        status_counts[str(row["status"])] = int(row["count"] or 0)
    status_counts["all"] = count(status_conditions, status_params)

    stage_conditions = [*base_conditions]
    stage_params = [*base_params]
    if verification_status:
        stage_conditions.append(f"{alias}.status = ?")
        stage_params.append(verification_status)
    stage_counts = {stage_value: 0 for stage_value in CREATIVE_STAGES}
    stage_where = f"WHERE {' AND '.join(stage_conditions)}" if stage_conditions else ""
    for row in conn.execute(
        f"SELECT stage_value.value AS stage, COUNT(DISTINCT {alias}.id) AS count "
        f"FROM {table} AS {alias} CROSS JOIN json_each({alias}.stages_json) AS stage_value "
        f"{stage_where} GROUP BY stage_value.value",
        stage_params,
    ).fetchall():
        stage_name = str(row["stage"])
        if stage_name in stage_counts:
            stage_counts[stage_name] = int(row["count"] or 0)
    stage_counts["all"] = count(stage_conditions, stage_params)
    return {"stage": stage_counts, "status": status_counts}


def list_cards(
    conn: sqlite3.Connection,
    *,
    card_kind: str,
    category: str = "",
    query: str = "",
    stage: str = "",
    verification_status: str = "",
    theme: str = "",
    setting: str = "",
    background: str = "",
    audience: str = "",
    page: int = 1,
    page_size: int = 30,
) -> dict[str, Any]:
    offset = (page - 1) * page_size
    if card_kind == "principle":
        base_conditions = ["p.status != 'retired'"]
        base_params: list[Any] = []
        if query.strip():
            base_conditions.append("(p.title LIKE ? OR p.statement LIKE ? OR p.rationale LIKE ?)")
            token = f"%{query.strip()}%"
            base_params.extend([token, token, token])
        conditions = [*base_conditions]
        params = [*base_params]
        if stage:
            conditions.append("EXISTS (SELECT 1 FROM json_each(p.stages_json) WHERE value = ?)")
            params.append(stage)
        if verification_status:
            conditions.append("p.status = ?")
            params.append(verification_status)
        where = " AND ".join(conditions)
        total = int(conn.execute(f"SELECT COUNT(*) FROM script_library_principles AS p WHERE {where}", params).fetchone()[0])
        rows = conn.execute(
            f"SELECT p.* FROM script_library_principles AS p WHERE {where} ORDER BY p.status, p.source_count DESC, p.title LIMIT ? OFFSET ?",
            [*params, page_size, offset],
        ).fetchall()
        cards = [public_principle(conn, row) for row in rows]
        facets = {kind: [] for kind in ("theme", "setting", "background", "audience")}
        filter_counts = _card_filter_counts(
            conn,
            table="script_library_principles",
            alias="p",
            base_conditions=base_conditions,
            base_params=base_params,
            stage=stage,
            verification_status=verification_status,
        )
    else:
        base_conditions = ["f.status != 'retired'"]
        base_params = []
        if category:
            base_conditions.append("f.category = ?")
            base_params.append(category)
        if query.strip():
            base_conditions.append("(f.name LIKE ? OR f.creative_decision LIKE ? OR f.creative_problem LIKE ? OR json_extract(f.content_json, '$.usage_scenario') LIKE ?)")
            token = f"%{query.strip()}%"
            base_params.extend([token, token, token, token])
        for tag in (theme, setting, background, audience):
            if tag:
                base_conditions.append("EXISTS (SELECT 1 FROM json_each(f.applicable_tags_json) WHERE value = ?)")
                base_params.append(tag)
        conditions = [*base_conditions]
        params = [*base_params]
        if stage:
            conditions.append("EXISTS (SELECT 1 FROM json_each(f.stages_json) WHERE value = ?)")
            params.append(stage)
        if verification_status:
            conditions.append("f.status = ?")
            params.append(verification_status)
        where = " AND ".join(conditions)
        total = int(conn.execute(f"SELECT COUNT(*) FROM script_library_formulas AS f WHERE {where}", params).fetchone()[0])
        rows = conn.execute(
            f"SELECT f.* FROM script_library_formulas AS f WHERE {where} ORDER BY f.status, f.source_count DESC, f.name LIMIT ? OFFSET ?",
            [*params, page_size, offset],
        ).fetchall()
        cards = [public_formula(conn, row) for row in rows]
        facets = _formula_tag_facets(conn)
        filter_counts = _card_filter_counts(
            conn,
            table="script_library_formulas",
            alias="f",
            base_conditions=base_conditions,
            base_params=base_params,
            stage=stage,
            verification_status=verification_status,
        )
    return {
        "cards": cards,
        "formulas": cards,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": max(1, (total + page_size - 1) // page_size),
        },
        "facets": facets,
        "filter_counts": filter_counts,
        "taxonomy": tag_taxonomy(),
    }


def refresh_script_links(conn: sqlite3.Connection, script_id: int) -> None:
    formula_ids = [
        str(row["formula_id"])
        for row in conn.execute(
            "SELECT DISTINCT formula_id FROM script_library_formula_sources WHERE script_id = ?",
            (script_id,),
        ).fetchall()
    ]
    for formula_id in formula_ids:
        _refresh_formula(conn, formula_id)


def detach_script(conn: sqlite3.Connection, script_id: int) -> None:
    formula_ids = [
        str(row["formula_id"])
        for row in conn.execute(
            "SELECT DISTINCT formula_id FROM script_library_formula_sources WHERE script_id = ?",
            (script_id,),
        ).fetchall()
    ]
    principle_ids = [
        str(row["principle_id"])
        for row in conn.execute(
            "SELECT DISTINCT principle_id FROM script_library_principle_observations WHERE script_id = ? AND principle_id IS NOT NULL",
            (script_id,),
        ).fetchall()
    ]
    conn.execute("DELETE FROM script_library_formula_sources WHERE script_id = ?", (script_id,))
    conn.execute("DELETE FROM script_library_principle_observations WHERE script_id = ?", (script_id,))
    for formula_id in formula_ids:
        _refresh_formula(conn, formula_id)
    for principle_id in principle_ids:
        _refresh_principle(conn, principle_id)


def delete_card(conn: sqlite3.Connection, card_id: str) -> dict[str, Any]:
    formula = conn.execute("SELECT * FROM script_library_formulas WHERE id = ?", (card_id,)).fetchone()
    if formula:
        conn.execute("DELETE FROM script_library_formulas WHERE id = ?", (card_id,))
        return {"card_kind": "formula", "title": str(formula["name"]), "source_count": int(formula["source_count"] or 0)}
    principle = conn.execute("SELECT * FROM script_library_principles WHERE id = ?", (card_id,)).fetchone()
    if principle:
        conn.execute("DELETE FROM script_library_principles WHERE id = ?", (card_id,))
        return {"card_kind": "principle", "title": str(principle["title"]), "source_count": int(principle["source_count"] or 0)}
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="公式卡或创作原则不存在")
