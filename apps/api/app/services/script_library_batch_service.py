from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

from app.core.config import settings
from app.db.session import get_connection
from app.services.direct_skill_runner import call_direct_model, direct_skill_system_prompt, extract_json_object
from app.services.model_config_service import resolve_runtime_model
from app.services.script_tag_service import CONTROLLED_TAG_VALUES, TAG_TAXONOMY
from app.services.script_knowledge_service import (
    CREATIVE_STAGES,
    FORMULA_CATEGORIES,
    _contains_source_term,
    _formula_content,
    _formula_id,
    _load_json,
    _normalize_formula_card,
    _principle_id,
    _refresh_formula,
    _refresh_principle,
)
BATCH_VERSION = "script-library-batch-v2"
DEFAULT_BATCH_SIZE = 8
PROTECTED_SCRIPT_IDS = frozenset({325, 327})
MODEL_VALIDATION_ATTEMPTS = 3
FORMULA_REFINEMENT_BATCH_SIZE = 8


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _batch_root() -> Path:
    root = settings.data_dir / "script-library" / "batch-initialization"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _ensure_batch_schema(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(script_library_scripts)").fetchall()}
    if "distillation_mode" not in columns:
        conn.execute("ALTER TABLE script_library_scripts ADD COLUMN distillation_mode TEXT NOT NULL DEFAULT 'single'")


def _case_digest(row: sqlite3.Row) -> dict[str, Any]:
    card = _load_json(row["case_card_json"], {})
    return {
        "script_id": int(row["id"]),
        "title": str(row["title"]),
        "tags": {
            "theme": _load_json(row["theme_tags_json"], []),
            "setting": _load_json(row["setting_tags_json"], []),
            "background": _load_json(row["background_tags_json"], []),
            "audience": _load_json(row["audience_tags_json"], []),
        },
        "summary": str(row["summary"] or ""),
        "story_engine": card.get("story_engine", {}),
        "narrative_phases": card.get("narrative_phases", []),
        "audience_payoffs": card.get("audience_payoffs", []),
        "key_observations": card.get("key_observations", []),
        "strengths": card.get("strengths", []),
        "limitations": card.get("limitations", []),
        "source_specific_terms": card.get("source_specific_terms", []),
    }


def prepare_batch_initialization(*, reset_catalog: bool = False) -> dict[str, int]:
    """Put every non-protected source script at the case-card boundary."""
    with get_connection() as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        _ensure_batch_schema(conn)
        protected = ",".join("?" for _ in PROTECTED_SCRIPT_IDS)
        rows = conn.execute(
            f"SELECT id FROM script_library_scripts WHERE id NOT IN ({protected}) ORDER BY id",
            tuple(PROTECTED_SCRIPT_IDS),
        ).fetchall()
        ids = [int(row["id"]) for row in rows]
        if not ids:
            conn.commit()
            return {"scripts": 0, "jobs": 0}
        placeholders = ",".join("?" for _ in ids)
        conn.execute(
            f"UPDATE script_distillation_jobs SET status='canceled', finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE script_id IN ({placeholders}) AND status IN ('queued','running')",
            ids,
        )
        conn.execute(
            f"""
            UPDATE script_library_scripts
            SET distillation_mode='batch_case', status='queued', error_message=NULL,
                summary='', theme_tags_json='[]', setting_tags_json='[]',
                background_tags_json='[]', audience_tags_json='[]', case_card_json='{{}}',
                formulas_json='{{}}', distillation_result_json='{{}}', distillation_version='',
                distillation_stage='queued', distillation_stage_label='等待处理',
                distillation_progress_current=0, distillation_progress_total=0,
                distillation_progress_message='等待案例卡提炼', updated_at=CURRENT_TIMESTAMP
            WHERE id IN ({placeholders})
            """,
            ids,
        )
        if reset_catalog:
            conn.execute(
                f"DELETE FROM script_library_formula_sources WHERE script_id IN ({placeholders})",
                ids,
            )
            conn.execute(
                f"DELETE FROM script_library_principle_observations WHERE script_id IN ({placeholders})",
                ids,
            )
            conn.execute(
                f"DELETE FROM script_library_formula_cards WHERE source_script_ids_json LIKE ? OR origin IN ('script-distillation','luna-v2','manual-ai')",
                [f"%{ids[0]}%"],
            )
            conn.execute(
                "DELETE FROM script_library_formulas WHERE NOT EXISTS (SELECT 1 FROM script_library_formula_sources WHERE formula_id = script_library_formulas.id)"
            )
            conn.execute(
                "DELETE FROM script_library_principles WHERE NOT EXISTS (SELECT 1 FROM script_library_principle_observations WHERE principle_id = script_library_principles.id)"
            )
        jobs = 0
        for script_id in ids:
            row = conn.execute(
                "SELECT id FROM script_distillation_jobs WHERE script_id=? AND status IN ('queued','running')",
                (script_id,),
            ).fetchone()
            if row:
                continue
            conn.execute("INSERT INTO script_distillation_jobs (script_id, status) VALUES (?, 'queued')", (script_id,))
            jobs += 1
        conn.commit()
        return {"scripts": len(ids), "jobs": jobs}


def case_ready_counts() -> dict[str, int]:
    with get_connection() as conn:
        _ensure_batch_schema(conn)
        total = int(conn.execute("SELECT COUNT(*) FROM script_library_scripts WHERE distillation_mode='batch_case'").fetchone()[0])
        complete = int(conn.execute("SELECT COUNT(*) FROM script_library_scripts WHERE distillation_mode='batch_case' AND case_card_json != '{}'").fetchone()[0])
        failed = int(conn.execute("SELECT COUNT(*) FROM script_library_scripts WHERE distillation_mode='batch_case' AND status='failed'").fetchone()[0])
        return {"total": total, "complete": complete, "failed": failed, "remaining": max(0, total - complete)}


def load_case_digests() -> list[dict[str, Any]]:
    with get_connection() as conn:
        _ensure_batch_schema(conn)
        rows = conn.execute(
            "SELECT * FROM script_library_scripts WHERE distillation_mode='batch_case' AND case_card_json != '{}' ORDER BY id"
        ).fetchall()
        return [_case_digest(row) for row in rows]


def _call_batch_stage(
    *,
    skill_name: str,
    task_name: str,
    payload: dict[str, Any],
    runtime: dict[str, Any],
    output_path: Path,
    max_tokens: int,
    output_contract: str,
    validator: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    system_prompt = direct_skill_system_prompt(skill_name, task_contract=task_name)
    fingerprint = hashlib.sha256(
        _json({
            "skill_name": skill_name,
            "system_prompt": system_prompt,
            "output_contract": output_contract,
            "payload": payload,
        }).encode("utf-8")
    ).hexdigest()
    checkpoint = output_path
    if checkpoint.is_file():
        try:
            cached = json.loads(checkpoint.read_text(encoding="utf-8"))
            if cached.get("input_fingerprint") == fingerprint and isinstance(cached.get("result"), dict):
                return validator(cached["result"])
        except (OSError, json.JSONDecodeError, RuntimeError, TypeError, ValueError):
            pass
    prompt = (
        f"执行阶段：{task_name}\n"
        "只返回一个符合输出结构的 JSON 对象，不要返回 Markdown、解释或代码围栏。\n"
        f"输出结构与约束：\n{output_contract}\n\n"
        f"阶段输入：\n{_json(payload)}"
    )
    last_error = ""
    previous: dict[str, Any] | None = None
    for attempt in range(MODEL_VALIDATION_ATTEMPTS):
        request = prompt
        if last_error:
            request += f"\n\n上一次返回未通过校验，只修复下列问题并返回完整 JSON：{last_error}"
            if previous is not None:
                request += f"\n上一次返回：{_json(previous)}"
        try:
            response = call_direct_model(
                system_prompt=system_prompt,
                user_prompt=request,
                runtime={**runtime, "stream": True, "max_tokens": max_tokens},
                log_path=output_path.with_name(f"{output_path.stem}.attempt-{attempt + 1}.log"),
                timeout_seconds=45 * 60,
            )
            previous = extract_json_object(response)
            result = validator(previous)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(_json({"input_fingerprint": fingerprint, "result": result}) + "\n", encoding="utf-8")
            return result
        except Exception as exc:
            last_error = str(exc).strip() or exc.__class__.__name__
    raise RuntimeError(f"{task_name}未通过校验（已重试 {MODEL_VALIDATION_ATTEMPTS - 1} 次）：{last_error}")


FORMULA_COLLECTION_CONTRACT = """顶层只能是 {"formula_candidates": [...]}。
每条候选必须完整返回 candidate_id、formula_id、name、category、stages、usage_scenario、not_applicable、goal、core_formula、conditions、variables、steps、mechanism、observable_checks、failure_modes、rewrite_usage、original_usage、genre_adaptations、source_script_ids、observation_refs。creative_decision、creative_problem 和 expected_effect 由程序补全，不返回。
本阶段是跨批合并前的候选收集：source_script_ids 至少 1 个，formula_id 必须为空字符串。单剧线索只作为临时候选，不会直接入库。"""

FORMULA_FINAL_CONTRACT = """顶层只能是 {"formula_candidates": [...]}。
每条公共公式必须完整返回 candidate_id、formula_id、name、category、stages、usage_scenario、not_applicable、goal、core_formula、conditions、variables、steps、mechanism、observable_checks、failure_modes、rewrite_usage、original_usage、genre_adaptations、source_script_ids、observation_refs。creative_decision、creative_problem 和 expected_effect 由程序补全，不返回。
source_script_ids 至少包含 2 部不同剧本。能被 existing_formulas 完整覆盖时填写对应 formula_id，否则 formula_id 必须为空字符串。只输出已经跨剧本成立的公共公式，丢弃无法合并的单剧线索。"""


def _source_terms_by_script(cases: list[dict[str, Any]]) -> dict[int, list[str]]:
    return {
        int(item["script_id"]): [str(term) for term in item.get("source_specific_terms", []) if str(term).strip()]
        for item in cases
    }


def _validate_formula_batch(
    result: dict[str, Any],
    allowed_ids: set[int],
    source_terms_by_id: dict[int, list[str]],
    *,
    minimum_sources: int,
    existing_formula_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(result, dict) or set(result) != {"formula_candidates"}:
        raise RuntimeError("批量公式顶层只能返回 formula_candidates")
    values = result.get("formula_candidates")
    if not isinstance(values, list):
        raise RuntimeError("批量公式结果缺少 formula_candidates 数组")
    output: list[dict[str, Any]] = []
    candidate_ids: set[str] = set()
    known_formula_ids = existing_formula_ids or set()
    for index, item in enumerate(values, start=1):
        if not isinstance(item, dict):
            raise RuntimeError(f"批量公式候选 {index} 不是对象")
        source_ids = item.get("source_script_ids")
        if not isinstance(source_ids, list):
            raise RuntimeError(f"批量公式候选 {index} 缺少 source_script_ids 数组")
        try:
            normalized_ids = sorted({int(value) for value in source_ids})
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"批量公式候选 {index} 的 source_script_ids 无效") from exc
        if len(normalized_ids) < minimum_sources:
            raise RuntimeError(f"批量公式候选 {index} 至少需要 {minimum_sources} 个来源剧本")
        if any(value not in allowed_ids for value in normalized_ids):
            raise RuntimeError(f"批量公式候选 {index} 引用了输入之外的剧本")
        source_terms = [term for script_id in normalized_ids for term in source_terms_by_id.get(script_id, [])]
        card = _normalize_formula_card(item, forbidden_terms=source_terms, label=f"批量公式候选 {index}")
        candidate_id = str(item.get("candidate_id") or f"B{index:02d}").strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{1,39}", candidate_id):
            raise RuntimeError(f"批量公式候选 {index} 的 candidate_id 无效")
        if candidate_id in candidate_ids:
            raise RuntimeError("批量公式 candidate_id 不能重复")
        candidate_ids.add(candidate_id)
        formula_id = str(item.get("formula_id") or "").strip()
        if formula_id and formula_id not in known_formula_ids:
            raise RuntimeError(f"批量公式候选 {candidate_id} 引用了不存在的 formula_id")
        card["source_script_ids"] = normalized_ids
        card["candidate_id"] = candidate_id
        card["formula_id"] = formula_id
        observation_refs = item.get("observation_refs")
        if not isinstance(observation_refs, list):
            raise RuntimeError(f"批量公式候选 {candidate_id} 缺少 observation_refs 数组")
        card["observation_refs"] = [str(value).strip() for value in observation_refs if str(value).strip()]
        output.append(card)
    return output


def _formula_payload(cases: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "mode": "candidate_collection",
        "cases": cases,
        "formula_categories": list(FORMULA_CATEGORIES),
        "creative_stages": list(CREATIVE_STAGES),
    }


def _active_principle_summaries(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        {
            "principle_id": str(row["id"]),
            "title": str(row["title"]),
            "stages": _load_json(row["stages_json"], []),
            "statement": str(row["statement"]),
            "applies_when": _load_json(row["applies_when_json"], []),
            "fails_or_changes_when": _load_json(row["fails_or_changes_when_json"], []),
            "review_criteria": _load_json(row["review_criteria_json"], []),
        }
        for row in conn.execute(
            "SELECT * FROM script_library_principles WHERE status != 'retired' ORDER BY stages_json, title"
        ).fetchall()
    ]


def _principles_for_formula_stages(
    principles: list[dict[str, Any]],
    stages: tuple[str, ...],
) -> list[dict[str, Any]]:
    stage_set = set(stages)
    return [
        principle
        for principle in principles
        if stage_set.intersection(str(stage) for stage in principle.get("stages", []))
    ]


def _merge_formula_candidates(
    candidates: list[dict[str, Any]],
    runtime: dict[str, Any],
    source_terms_by_id: dict[int, list[str]],
    *,
    include_existing: bool = True,
) -> list[dict[str, Any]]:
    if not candidates:
        return []
    existing: list[dict[str, Any]] = []
    with get_connection() as conn:
        principles = _active_principle_summaries(conn)
        if include_existing:
            existing = [
                {
                    "formula_id": str(row["id"]), "name": str(row["name"]),
                    "category": str(row["category"]), "stages": _load_json(row["stages_json"], []),
                    "creative_decision": str(row["creative_decision"]),
                    "creative_problem": str(row["creative_problem"]),
                    **_load_json(row["content_json"], {}),
                }
                for row in conn.execute("SELECT * FROM script_library_formulas WHERE status != 'retired'").fetchall()
            ]
    merged: list[dict[str, Any]] = []
    merge_root = _batch_root() / "formula-merge"
    merge_groups = sorted({(tuple(item["stages"]), item["category"]) for item in candidates})
    for stages, category in merge_groups:
        group_candidates = [
            item for item in candidates
            if tuple(item["stages"]) == stages and item["category"] == category
        ]
        if not group_candidates:
            continue
        group_existing = [
            item for item in existing
            if tuple(item["stages"]) == stages and item["category"] == category
        ]
        existing_ids = {item["formula_id"] for item in group_existing}
        allowed = {int(value) for item in group_candidates for value in item["source_script_ids"]}
        stage_key = "-".join(stages)
        payload = {
            "mode": "catalog_merge",
            "stages": list(stages),
            "category": category,
            "candidates": group_candidates,
            "existing_formulas": group_existing,
            "existing_principles": _principles_for_formula_stages(principles, stages),
            "instruction": "只在当前创作阶段内，合并使用场景、核心公式、使用方法和生效原因相同的候选，来源剧本取并集。只有至少两部剧本共同支持时才输出。如果候选只是 existing_principles 已覆盖的通用准出要求，不作为公式输出。",
        }
        result = _call_batch_stage(
            skill_name="script-formula-batch-distillation",
            task_name=f"formula_catalog_merge_{stage_key}_{category}",
            payload=payload,
            runtime=runtime,
            output_path=merge_root / f"{stage_key}-{category}.json",
            max_tokens=32000,
            output_contract=FORMULA_FINAL_CONTRACT,
            validator=lambda raw, allowed=allowed, existing_ids=existing_ids: {
                "formula_candidates": _validate_formula_batch(
                    raw,
                    allowed,
                    source_terms_by_id,
                    minimum_sources=2,
                    existing_formula_ids=existing_ids,
                )
            },
        )
        merged.extend(result["formula_candidates"])
    return merged


def distill_formulas(*, batch_size: int = DEFAULT_BATCH_SIZE) -> list[dict[str, Any]]:
    counts = case_ready_counts()
    if counts["total"] == 0:
        raise RuntimeError("没有待初始化的剧本，不能提炼全库公式")
    if counts["remaining"]:
        raise RuntimeError(f"仍有 {counts['remaining']} 部剧本未完成案例卡，不能提前提炼全库公式")
    cases = load_case_digests()
    with get_connection() as conn:
        runtime = resolve_runtime_model(conn, scenario_key="script_library", action_key="formula_curation")
    root = _batch_root() / "formula-batches"
    source_terms_by_id = _source_terms_by_script(cases)
    groups: list[tuple[int, list[dict[str, Any]], set[int]]] = []
    for offset in range(0, len(cases), max(2, batch_size)):
        group = cases[offset:offset + max(2, batch_size)]
        groups.append((
            offset // max(2, batch_size) + 1,
            group,
            {int(item["script_id"]) for item in group},
        ))

    def collect_group(
        batch_number: int,
        group: list[dict[str, Any]],
        allowed: set[int],
    ) -> list[dict[str, Any]]:
        result = _call_batch_stage(
            skill_name="script-formula-batch-distillation",
            task_name=f"formula_batch_{batch_number:03d}",
            payload=_formula_payload(group),
            runtime=runtime,
            output_path=root / f"batch-{batch_number:03d}.json",
            max_tokens=32000,
            output_contract=FORMULA_COLLECTION_CONTRACT,
            validator=lambda raw, allowed=allowed: {
                "formula_candidates": _validate_formula_batch(
                    raw,
                    allowed,
                    source_terms_by_id,
                    minimum_sources=1,
                )
            },
        )
        return result["formula_candidates"]

    parallel_limit = min(
        len(groups),
        max(1, int(getattr(settings, "script_distillation_max_parallel", 3))),
    )
    candidates_by_batch: dict[int, list[dict[str, Any]]] = {}
    failures: list[tuple[int, Exception]] = []
    with ThreadPoolExecutor(max_workers=parallel_limit, thread_name_prefix="formula-batch") as executor:
        futures = {
            executor.submit(collect_group, batch_number, group, allowed): batch_number
            for batch_number, group, allowed in groups
        }
        for future in as_completed(futures):
            batch_number = futures[future]
            try:
                candidates_by_batch[batch_number] = future.result()
            except Exception as exc:
                failures.append((batch_number, exc))
    if failures:
        details = "；".join(
            f"第 {batch_number} 批：{str(exc).strip() or exc.__class__.__name__}"
            for batch_number, exc in sorted(failures)
        )
        raise RuntimeError(f"公式候选批次未全部完成：{details}")

    candidates = [
        candidate
        for batch_number in sorted(candidates_by_batch)
        for candidate in candidates_by_batch[batch_number]
    ]
    merged = _merge_formula_candidates(candidates, runtime, source_terms_by_id)
    with get_connection() as conn:
        _store_formulas(conn, merged)
        conn.commit()
    return merged


def _store_formulas(conn: sqlite3.Connection, formulas: list[dict[str, Any]]) -> None:
    for formula in formulas:
        formula_id = str(formula.get("formula_id") or "").strip() or _formula_id(formula)
        existing = conn.execute("SELECT * FROM script_library_formulas WHERE id=?", (formula_id,)).fetchone()
        revision = int(existing["revision"] or 0) + 1 if existing else 1
        conn.execute(
            """
            INSERT INTO script_library_formulas (
                id, category, name, stages_json, creative_decision, creative_problem,
                applicable_tags_json, source_count, status, origin, revision, content_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'candidate', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET category=excluded.category, name=excluded.name,
                stages_json=excluded.stages_json, creative_decision=excluded.creative_decision,
                creative_problem=excluded.creative_problem, revision=excluded.revision,
                content_json=excluded.content_json, updated_at=CURRENT_TIMESTAMP
            """,
            (
                formula_id, formula["category"], formula["name"], _json(formula["stages"]),
                formula["creative_decision"], formula["creative_problem"], "[]",
                "script-library-batch", revision, _json({**_formula_content(formula), "batch_version": BATCH_VERSION}),
            ),
        )
        action = "improve" if existing else "create"
        for script_id in formula["source_script_ids"]:
            evidence = [f"script:{script_id}"]
            conn.execute(
                """
                INSERT INTO script_library_formula_sources (
                    formula_id, script_id, candidate_id, action, decision_reason,
                    evidence_references_json, contribution_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(formula_id, script_id, candidate_id) DO UPDATE SET
                    action=excluded.action, decision_reason=excluded.decision_reason,
                    evidence_references_json=excluded.evidence_references_json,
                    contribution_json=excluded.contribution_json, updated_at=CURRENT_TIMESTAMP
                """,
                (
                    formula_id,
                    script_id,
                    formula["candidate_id"],
                    action,
                    "跨两部以上剧本验证后建立或完善公共公式",
                    _json(evidence),
                    _json(formula),
                ),
            )
        _refresh_formula(conn, formula_id)
        formula["formula_id"] = formula_id
        for script_id in formula["source_script_ids"]:
            current_row = conn.execute("SELECT formulas_json FROM script_library_scripts WHERE id=?", (script_id,)).fetchone()
            current = _load_json(current_row[0], {}) if current_row else {}
            ids = list(current.get("formula_ids") or [])
            if formula_id not in ids:
                ids.append(formula_id)
            conn.execute("UPDATE script_library_scripts SET formulas_json=? WHERE id=?", (_json({"formula_ids": ids}), script_id))


def _existing_formula_refinement_input(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    source_rows = conn.execute(
        """
        SELECT source.formula_id, source.script_id,
               script.theme_tags_json, script.setting_tags_json,
               script.background_tags_json, script.audience_tags_json
        FROM script_library_formula_sources AS source
        JOIN script_library_scripts AS script ON script.id = source.script_id
        ORDER BY source.formula_id, source.script_id
        """
    ).fetchall()
    source_ids_by_formula: dict[str, set[int]] = {}
    source_tag_counts_by_formula: dict[str, dict[str, int]] = {}
    for source in source_rows:
        formula_id = str(source["formula_id"])
        source_ids_by_formula.setdefault(formula_id, set()).add(int(source["script_id"]))
        tag_counts = source_tag_counts_by_formula.setdefault(formula_id, {})
        for column in (
            "theme_tags_json",
            "setting_tags_json",
            "background_tags_json",
            "audience_tags_json",
        ):
            for tag in {str(tag) for tag in _load_json(source[column], []) if str(tag).strip()}:
                tag_counts[tag] = tag_counts.get(tag, 0) + 1
    output: list[dict[str, Any]] = []
    for row in conn.execute(
        "SELECT * FROM script_library_formulas WHERE status != 'retired' ORDER BY source_count DESC, id"
    ).fetchall():
        formula_id = str(row["id"])
        content = _load_json(row["content_json"], {})
        tag_counts = source_tag_counts_by_formula.get(formula_id, {})
        representative_tags: list[str] = []
        for kind, taxonomy_values in TAG_TAXONOMY.items():
            ranked = sorted(
                (tag for tag in taxonomy_values if tag_counts.get(tag, 0) > 0),
                key=lambda tag: (-tag_counts[tag], taxonomy_values.index(tag)),
            )
            representative_tags.extend(ranked[:2 if kind == "audience" else 3])
        legacy_adaptation_tags: set[str] = set()
        for adaptation in content.get("genre_adaptations", []):
            if not isinstance(adaptation, dict):
                continue
            for raw_tag in adaptation.get("tags", []):
                value = str(raw_tag).strip()
                matches = [value] if value in CONTROLLED_TAG_VALUES else [
                    tag for tag in CONTROLLED_TAG_VALUES if tag in value
                ]
                legacy_adaptation_tags.update(tag for tag in matches if tag_counts.get(tag, 0) > 0)
        for taxonomy_values in TAG_TAXONOMY.values():
            for tag in taxonomy_values:
                if tag in legacy_adaptation_tags and tag not in representative_tags:
                    representative_tags.append(tag)
        output.append({
            **content,
            "formula_id": str(row["id"]),
            "name": str(row["name"]),
            "category": str(row["category"]),
            "stages": _load_json(row["stages_json"], []),
            "creative_decision": str(row["creative_decision"]),
            "creative_problem": str(row["creative_problem"]),
            "applicable_tags": representative_tags,
            "status": str(row["status"]),
            "revision": int(row["revision"] or 1),
            "source_script_ids": sorted(source_ids_by_formula.get(formula_id, set())),
        })
    return output


def _refinement_formula_lineage(formula: dict[str, Any]) -> list[str]:
    lineage: list[str] = []
    for reference in formula.get("observation_refs", []):
        value = str(reference).strip()
        if value.startswith("old:") and value[4:] not in lineage:
            lineage.append(value[4:])
    return lineage


def _refinement_source_ids(formula: dict[str, Any]) -> list[int]:
    return sorted({int(value) for value in formula.get("source_script_ids", [])})


def _refinement_candidate_id(index: int, formula_id: str) -> str:
    digest = hashlib.sha256(formula_id.encode("utf-8")).hexdigest()[:10]
    return f"R{index:02d}_{digest}"


FORMULA_REFINEMENT_CONTRACT = """顶层只能是 {"formula_candidates": [...]}。
本次只重组已有公式，不重新蒸馏原剧。每条必须返回 candidate_id、formula_id、name、category、stages、usage_scenario、not_applicable、goal、core_formula、conditions、variables、steps、mechanism、observable_checks、failure_modes、rewrite_usage、original_usage、genre_adaptations、observation_refs。creative_decision、creative_problem 和 expected_effect 由程序补全，不返回。
仅输出仍属于公式的内容；原则、单剧观察、重复内容和空话不输出。formula_id 留空，observation_refs 填写所支持的 old:<formula_id>。不返回 source_script_ids，来源剧本由程序根据 observation_refs 自动补全。"""


def refine_existing_formula_library(*, batch_size: int = FORMULA_REFINEMENT_BATCH_SIZE) -> list[dict[str, Any]]:
    """Rebuild public formulas from existing cards and source links, never from source scripts."""
    with get_connection() as conn:
        formulas = _existing_formula_refinement_input(conn)
        runtime = resolve_runtime_model(conn, scenario_key="script_library", action_key="formula_curation")
    if not formulas:
        return []
    root = _batch_root() / "formula-refinement-v3"
    old_formula_ids = {str(formula["formula_id"]) for formula in formulas}
    source_ids_by_old_formula = {
        str(formula["formula_id"]): {
            int(script_id)
            for script_id in formula.get("source_script_ids", [])
        }
        for formula in formulas
    }
    tags_by_old_formula = {
        str(formula["formula_id"]): {
            str(tag)
            for tag in formula.get("applicable_tags", [])
            if str(tag).strip()
        }
        for formula in formulas
    }
    groups: list[tuple[int, list[dict[str, Any]], set[int], dict[str, str]]] = []
    for offset in range(0, len(formulas), max(2, batch_size)):
        group = formulas[offset:offset + max(2, batch_size)]
        allowed = {
            int(script_id)
            for formula in group
            for script_id in formula.get("source_script_ids", [])
        }
        numbered_group = [
            {**formula, "required_candidate_id": _refinement_candidate_id(offset + index + 1, str(formula["formula_id"]))}
            for index, formula in enumerate(group)
        ]
        expected_candidate_ids = {
            str(formula["required_candidate_id"]): str(formula["formula_id"])
            for formula in numbered_group
        }
        groups.append((
            offset // max(2, batch_size) + 1,
            numbered_group,
            allowed,
            expected_candidate_ids,
        ))

    def refine_group(
        batch_number: int,
        numbered_group: list[dict[str, Any]],
        allowed: set[int],
        expected_candidate_ids: dict[str, str],
    ) -> list[dict[str, Any]]:
        result = _call_batch_stage(
            skill_name="script-formula-batch-distillation",
            task_name=f"formula_refinement_{batch_number:03d}",
            payload={
                "mode": "refine_existing_formulas",
                "formulas": numbered_group,
                "instruction": "本轮只改写，不合并、不丢弃、不读取原剧。每张旧公式必须且只能输出一张新公式，candidate_id 必须使用 required_candidate_id，observation_refs 只填对应的 old:<formula_id>，不返回 source_script_ids。genre_adaptations.tags 的每一项都必须从该输入公式的 applicable_tags 中逐字复制；多标签必须拆成多个数组元素，不得拼接、概括或造词。横跨阶段时只保留它实际方法和完成标准对应的一个粒度。",
            },
            runtime=runtime,
            output_path=root / "drafts" / f"batch-{batch_number:03d}.json",
            max_tokens=32000,
            output_contract=FORMULA_REFINEMENT_CONTRACT,
            validator=lambda raw, allowed=allowed, old_formula_ids=old_formula_ids, expected_candidate_ids=expected_candidate_ids: {
                "formula_candidates": _validate_refinement_batch(
                    raw,
                    allowed_ids=allowed,
                    old_formula_ids=old_formula_ids,
                    source_ids_by_old_formula=source_ids_by_old_formula,
                    tags_by_old_formula=tags_by_old_formula,
                    expected_candidate_ids=expected_candidate_ids,
                    minimum_sources=1,
                )
            },
        )
        return result["formula_candidates"]

    parallel_limit = min(
        len(groups),
        max(1, int(getattr(settings, "script_distillation_max_parallel", 3))),
    )
    drafts_by_batch: dict[int, list[dict[str, Any]]] = {}
    failures: list[tuple[int, Exception]] = []
    with ThreadPoolExecutor(max_workers=parallel_limit, thread_name_prefix="formula-refinement") as executor:
        futures = {
            executor.submit(refine_group, batch_number, group, allowed, expected_ids): batch_number
            for batch_number, group, allowed, expected_ids in groups
        }
        for future in as_completed(futures):
            batch_number = futures[future]
            try:
                drafts_by_batch[batch_number] = future.result()
            except Exception as exc:
                failures.append((batch_number, exc))
    if failures:
        details = "；".join(
            f"第 {batch_number} 批：{str(exc).strip() or exc.__class__.__name__}"
            for batch_number, exc in sorted(failures)
        )
        raise RuntimeError(f"旧公式卡改写批次未全部完成：{details}")
    drafts = [
        formula
        for batch_number in sorted(drafts_by_batch)
        for formula in drafts_by_batch[batch_number]
    ]
    merged = _merge_refinement_candidates(
        drafts,
        runtime,
        source_ids_by_old_formula,
        tags_by_old_formula,
    )
    _replace_formula_library(merged)
    return merged


def _validate_refinement_batch(
    result: dict[str, Any],
    *,
    allowed_ids: set[int],
    old_formula_ids: set[str],
    source_ids_by_old_formula: dict[str, set[int]],
    tags_by_old_formula: dict[str, set[str]],
    expected_candidate_ids: dict[str, str] | None = None,
    minimum_sources: int = 2,
    expected_stages: tuple[str, ...] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(result, dict) or set(result) != {"formula_candidates"}:
        raise RuntimeError("批量公式顶层只能返回 formula_candidates")
    raw_formulas = result.get("formula_candidates")
    if not isinstance(raw_formulas, list):
        raise RuntimeError("批量公式结果缺少 formula_candidates 数组")
    prepared: list[dict[str, Any]] = []
    tag_errors: list[str] = []
    for index, raw_formula in enumerate(raw_formulas, start=1):
        if not isinstance(raw_formula, dict):
            raise RuntimeError(f"公式候选 {index} 不是对象")
        lineage = _refinement_formula_lineage(raw_formula)
        if not lineage or any(formula_id not in old_formula_ids for formula_id in lineage):
            raise RuntimeError(f"公式候选 {raw_formula.get('candidate_id') or index} 缺少真实的旧公式来源")
        source_ids = set().union(*(source_ids_by_old_formula[formula_id] for formula_id in lineage))
        allowed_tags = set().union(*(tags_by_old_formula[formula_id] for formula_id in lineage))
        for adaptation_index, adaptation in enumerate(raw_formula.get("genre_adaptations", []), start=1):
            if not isinstance(adaptation, dict) or not isinstance(adaptation.get("tags"), list):
                continue
            invalid_tags = [
                str(tag).strip()
                for tag in adaptation["tags"]
                if str(tag).strip() not in CONTROLLED_TAG_VALUES or str(tag).strip() not in allowed_tags
            ]
            if invalid_tags:
                tag_errors.append(
                    f"公式候选 {raw_formula.get('candidate_id') or index} 第 {adaptation_index} 个题材适配"
                    f"使用了无效标签：{'、'.join(invalid_tags)}。"
                    f"只能逐项复制：{'、'.join(sorted(allowed_tags))}"
                )
        prepared.append({**raw_formula, "source_script_ids": sorted(source_ids)})
    if tag_errors:
        raise RuntimeError("；".join(tag_errors))
    formulas = _validate_formula_batch(
        {"formula_candidates": prepared},
        allowed_ids,
        {},
        minimum_sources=minimum_sources,
    )
    seen_old_formula_ids: set[str] = set()
    for formula in formulas:
        if expected_stages is not None and tuple(formula["stages"]) != expected_stages:
            raise RuntimeError(
                f"公式候选 {formula['candidate_id']} 的适用阶段必须为 {'/'.join(expected_stages)}"
            )
        repeated = sorted(seen_old_formula_ids.intersection(_refinement_formula_lineage(formula)))
        if repeated:
            raise RuntimeError(f"旧公式不能被重复拆入多张新公式：{'、'.join(repeated)}")
        seen_old_formula_ids.update(_refinement_formula_lineage(formula))
    if expected_candidate_ids is not None:
        candidate_ids = {str(formula["candidate_id"]) for formula in formulas}
        if candidate_ids != set(expected_candidate_ids):
            missing = sorted(set(expected_candidate_ids).difference(candidate_ids))
            extra = sorted(candidate_ids.difference(expected_candidate_ids))
            raise RuntimeError(f"公式改写必须与旧公式一一对应；缺少：{missing}；多余：{extra}")
        for formula in formulas:
            expected_old_id = expected_candidate_ids[str(formula["candidate_id"])]
            if _refinement_formula_lineage(formula) != [expected_old_id]:
                raise RuntimeError(f"公式候选 {formula['candidate_id']} 必须且只能引用 old:{expected_old_id}")
    covered_ids = set().union(*(_refinement_source_ids(formula) for formula in formulas)) if formulas else set()
    if not covered_ids.issubset(allowed_ids):
        raise RuntimeError("公式重组结果引用了输入之外的剧本")
    for formula in formulas:
        allowed_tags = set().union(*(
            tags_by_old_formula[formula_id]
            for formula_id in _refinement_formula_lineage(formula)
        ))
        used_tags = {
            str(tag)
            for adaptation in formula.get("genre_adaptations", [])
            for tag in adaptation.get("tags", [])
        }
        invalid_tags = sorted(used_tags.difference(allowed_tags))
        if invalid_tags:
            raise RuntimeError(
                f"公式候选 {formula['candidate_id']} 使用了支持案例未覆盖的适配标签："
                f"{'、'.join(invalid_tags)}"
            )
    return formulas


def _merge_refinement_candidates(
    candidates: list[dict[str, Any]],
    runtime: dict[str, Any],
    source_ids_by_old_formula: dict[str, set[int]],
    tags_by_old_formula: dict[str, set[str]],
) -> list[dict[str, Any]]:
    if not candidates:
        return []
    root = _batch_root() / "formula-refinement-v3" / "merge"
    groups = sorted({tuple(item["stages"]) for item in candidates})
    with get_connection() as conn:
        principles = _active_principle_summaries(conn)

    def merge_group(stages: tuple[str, ...]) -> list[dict[str, Any]]:
        stage_candidates = [item for item in candidates if tuple(item["stages"]) == stages]
        stage_old_formula_ids = {
            formula_id
            for item in stage_candidates
            for formula_id in _refinement_formula_lineage(item)
        }
        allowed_ids = {script_id for item in stage_candidates for script_id in _refinement_source_ids(item)}
        stage_key = "-".join(stages)
        result = _call_batch_stage(
            skill_name="script-formula-batch-distillation",
            task_name=f"formula_refinement_merge_{stage_key}",
            payload={
                "mode": "refinement_merge",
                "stages": list(stages),
                "candidates": stage_candidates,
                "existing_principles": _principles_for_formula_stages(principles, stages),
                "instruction": "在同一创作阶段内消除重复公式。核心公式和使用方法相同时合并，observation_refs 使用被合并的全部 old:<formula_id>，不返回 source_script_ids。genre_adaptations.tags 只能使用所引旧公式 applicable_tags 中已有的单个标签。无法与其他候选共同获得两部剧本支持的单案例写法不输出。如果候选只是 existing_principles 已覆盖的通用准出要求，不作为公式输出。candidate_id 使用 M01、M02 格式并保持不重复。",
            },
            runtime=runtime,
            output_path=root / f"{stage_key}.json",
            max_tokens=32000,
            output_contract=FORMULA_REFINEMENT_CONTRACT,
            validator=lambda raw, allowed_ids=allowed_ids: {
                "formula_candidates": _validate_refinement_batch(
                    raw,
                    allowed_ids=allowed_ids,
                    old_formula_ids=stage_old_formula_ids,
                    source_ids_by_old_formula=source_ids_by_old_formula,
                    tags_by_old_formula=tags_by_old_formula,
                    expected_stages=stages,
                )
            },
        )
        return result["formula_candidates"]

    parallel_limit = min(
        len(groups),
        max(1, int(getattr(settings, "script_distillation_max_parallel", 3))),
    )
    merged_by_stage: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    failures: list[tuple[tuple[str, ...], Exception]] = []
    with ThreadPoolExecutor(max_workers=parallel_limit, thread_name_prefix="formula-refinement-merge") as executor:
        futures = {executor.submit(merge_group, stages): stages for stages in groups}
        for future in as_completed(futures):
            stages = futures[future]
            try:
                merged_by_stage[stages] = future.result()
            except Exception as exc:
                failures.append((stages, exc))
    if failures:
        details = "；".join(
            f"{'/'.join(stages)}：{str(exc).strip() or exc.__class__.__name__}"
            for stages, exc in sorted(failures)
        )
        raise RuntimeError(f"公式卡按阶段合并未全部完成：{details}")
    return [
        formula
        for stages in groups
        for formula in merged_by_stage[stages]
    ]


def _replace_formula_library(formulas: list[dict[str, Any]]) -> None:
    with get_connection() as conn:
        old_ids = [
            str(row["id"])
            for row in conn.execute("SELECT id FROM script_library_formulas WHERE status != 'retired'").fetchall()
        ]
        old_sources = [
            dict(row)
            for row in conn.execute("SELECT * FROM script_library_formula_sources").fetchall()
        ]
        sources_by_formula: dict[str, list[dict[str, Any]]] = {}
        for source in old_sources:
            sources_by_formula.setdefault(str(source["formula_id"]), []).append(source)
        conn.execute("UPDATE script_library_formulas SET status='retired', updated_at=CURRENT_TIMESTAMP WHERE status != 'retired'")
        for formula in formulas:
            formula_id = _formula_id(formula)
            formula["formula_id"] = formula_id
            conn.execute(
                """
                INSERT INTO script_library_formulas (
                    id, category, name, stages_json, creative_decision, creative_problem,
                    applicable_tags_json, source_count, status, origin, revision, content_json
                ) VALUES (?, ?, ?, ?, ?, ?, '[]', 0, 'candidate', 'formula-library-refinement', 1, ?)
                ON CONFLICT(id) DO UPDATE SET category=excluded.category, name=excluded.name,
                    stages_json=excluded.stages_json, creative_decision=excluded.creative_decision,
                    creative_problem=excluded.creative_problem, origin=excluded.origin,
                    status=excluded.status,
                    revision=script_library_formulas.revision + 1, content_json=excluded.content_json,
                    updated_at=CURRENT_TIMESTAMP
                """,
                (
                    formula_id,
                    formula["category"],
                    formula["name"],
                    _json(formula["stages"]),
                    formula["usage_scenario"],
                    formula["usage_scenario"],
                    _json({**_formula_content(formula), "batch_version": BATCH_VERSION}),
                ),
            )
            lineage = _refinement_formula_lineage(formula)
            for old_id in lineage:
                for source in sources_by_formula.get(old_id, []):
                    conn.execute(
                        """
                        INSERT INTO script_library_formula_sources (
                            formula_id, script_id, candidate_id, action, decision_reason,
                            evidence_references_json, contribution_json
                        ) VALUES (?, ?, ?, 'improve', ?, ?, ?)
                        ON CONFLICT(formula_id, script_id, candidate_id) DO UPDATE SET
                            action=excluded.action, decision_reason=excluded.decision_reason,
                            evidence_references_json=excluded.evidence_references_json,
                            contribution_json=excluded.contribution_json, updated_at=CURRENT_TIMESTAMP
                        """,
                        (
                            formula_id,
                            int(source["script_id"]),
                            f"refined:{old_id}:{source['candidate_id']}",
                            "基于已有公式卡重新梳理，保留原有案例支持关系",
                            str(source["evidence_references_json"] or "[]"),
                            _json({"old_formula_id": old_id, "old_contribution": _load_json(source["contribution_json"], {})}),
                        ),
                    )
            _refresh_formula(conn, formula_id)
        new_ids = {str(formula["formula_id"]) for formula in formulas}
        for script in conn.execute("SELECT id FROM script_library_scripts").fetchall():
            formula_ids = [
                str(row["formula_id"])
                for row in conn.execute(
                    """
                    SELECT DISTINCT formula_id FROM script_library_formula_sources
                    WHERE script_id=? AND formula_id IN (
                        SELECT id FROM script_library_formulas WHERE status != 'retired'
                    ) ORDER BY formula_id
                    """,
                    (int(script["id"]),),
                ).fetchall()
            ]
            conn.execute(
                "UPDATE script_library_scripts SET formulas_json=? WHERE id=?",
                (_json({"formula_ids": formula_ids}), int(script["id"])),
            )
        conn.commit()
        manifest = {
            "version": BATCH_VERSION,
            "retired_formula_ids": old_ids,
            "active_formula_ids": sorted(new_ids),
        }
        path = _batch_root() / "formula-refinement-v3" / "manifest.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_json(manifest) + "\n", encoding="utf-8")


PRINCIPLE_COLLECTION_CONTRACT = """顶层只能是 {"principle_candidates": [...]}。
每条候选必须返回 candidate_id、principle_id、title、stages、statement、rationale、applies_when、fails_or_changes_when、review_criteria、source_script_ids、related_formula_ids、evidence_references。
本阶段是跨批合并前的候选收集：source_script_ids 至少 1 个，principle_id 必须为空字符串。每条原则只属于一个创作阶段。单剧线索只作为临时候选，不会直接入库。"""

PRINCIPLE_FINAL_CONTRACT = """顶层只能是 {"principle_candidates": [...]}。
每条公共原则必须返回 candidate_id、principle_id、title、stages、statement、rationale、applies_when、fails_or_changes_when、review_criteria、source_script_ids、related_formula_ids、evidence_references。
source_script_ids 至少包含 2 部不同剧本，related_formula_ids 至少包含 2 张真实公式，每条原则只属于一个创作阶段。能被 existing_principles 完整覆盖时填写对应 principle_id，否则 principle_id 必须为空字符串。先合并同阶段的包含关系；下位原则只是上位原则的具体应用时，不单独输出。只输出跨题材且可直接审稿的质量要求，丢弃公式步骤、题材偏好和单剧技巧。"""


def _validate_principles(
    result: dict[str, Any],
    allowed_ids: set[int],
    source_terms_by_id: dict[int, list[str]],
    *,
    minimum_sources: int,
    allowed_formula_ids: set[str],
    minimum_formula_sources: int = 0,
    existing_principle_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(result, dict) or set(result) != {"principle_candidates"}:
        raise RuntimeError("批量原则顶层只能返回 principle_candidates")
    values = result.get("principle_candidates")
    if not isinstance(values, list):
        raise RuntimeError("批量原则结果缺少 principle_candidates 数组")
    output: list[dict[str, Any]] = []
    candidate_ids: set[str] = set()
    known_principle_ids = existing_principle_ids or set()
    for index, item in enumerate(values, start=1):
        if not isinstance(item, dict):
            raise RuntimeError(f"批量原则候选 {index} 不是对象")
        try:
            source_ids = sorted({int(value) for value in item.get("source_script_ids", [])})
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"批量原则候选 {index} 的来源无效") from exc
        if len(source_ids) < minimum_sources or any(value not in allowed_ids for value in source_ids):
            raise RuntimeError(f"批量原则候选 {index} 至少需要 {minimum_sources} 个真实来源剧本")
        stages = item.get("stages")
        if not isinstance(stages, list) or len(stages) != 1 or any(stage not in CREATIVE_STAGES for stage in stages):
            raise RuntimeError(f"批量原则候选 {index} 的创作阶段无效")
        def text(name: str, minimum: int = 20) -> str:
            value = str(item.get(name) or "").strip()
            if len(value) < minimum:
                raise RuntimeError(f"批量原则候选 {index} 的 {name} 内容不足")
            return value
        lists: dict[str, list[str]] = {}
        for name in ("applies_when", "fails_or_changes_when", "review_criteria"):
            value = item.get(name)
            if not isinstance(value, list) or not 1 <= len(value) <= 6 or any(len(str(v).strip()) < 8 for v in value):
                raise RuntimeError(f"批量原则候选 {index} 的 {name} 无效")
            lists[name] = [str(v).strip() for v in value]
        candidate_id = str(item.get("candidate_id") or f"P{index:02d}").strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{1,39}", candidate_id):
            raise RuntimeError(f"批量原则候选 {index} 的 candidate_id 无效")
        if candidate_id in candidate_ids:
            raise RuntimeError("批量原则 candidate_id 不能重复")
        candidate_ids.add(candidate_id)
        principle_id = str(item.get("principle_id") or "").strip()
        if principle_id and principle_id not in known_principle_ids:
            raise RuntimeError(f"批量原则候选 {candidate_id} 引用了不存在的 principle_id")
        related_formula_ids = list(dict.fromkeys(
            str(v).strip() for v in item.get("related_formula_ids", []) if str(v).strip()
        ))
        invalid_formula_ids = [value for value in related_formula_ids if value not in allowed_formula_ids]
        if invalid_formula_ids:
            raise RuntimeError(f"批量原则候选 {candidate_id} 引用了不存在的公式")
        if len(related_formula_ids) < minimum_formula_sources:
            raise RuntimeError(
                f"批量原则候选 {candidate_id} 至少需要 "
                f"{minimum_formula_sources} 张不同公式共同支持"
            )
        evidence_references = [str(v).strip() for v in item.get("evidence_references", []) if str(v).strip()]
        if not evidence_references:
            raise RuntimeError(f"批量原则候选 {candidate_id} 缺少证据引用")
        normalized = {
            "candidate_id": candidate_id,
            "principle_id": principle_id,
            "title": text("title", 4),
            "stages": stages,
            "statement": text("statement"),
            "rationale": text("rationale"),
            **lists,
            "source_script_ids": source_ids,
            "related_formula_ids": related_formula_ids,
            "evidence_references": evidence_references,
        }
        source_terms = [term for script_id in source_ids for term in source_terms_by_id.get(script_id, [])]
        leaked = _contains_source_term(
            [
                normalized["title"],
                normalized["statement"],
                normalized["rationale"],
                normalized["applies_when"],
                normalized["fails_or_changes_when"],
                normalized["review_criteria"],
            ],
            source_terms,
        )
        if leaked:
            raise RuntimeError(f"批量原则候选 {candidate_id} 仍包含原剧专属词：{leaked}")
        output.append(normalized)
    return output


def distill_principles(*, batch_size: int = 20) -> list[dict[str, Any]]:
    cases = load_case_digests()
    if not cases:
        raise RuntimeError("还没有完成案例卡，不能提炼创作原则")
    with get_connection() as conn:
        runtime = resolve_runtime_model(conn, scenario_key="script_library", action_key="formula_curation")
        source_ids_by_formula: dict[str, list[int]] = {}
        for source in conn.execute(
            "SELECT formula_id, script_id FROM script_library_formula_sources ORDER BY formula_id, script_id"
        ).fetchall():
            source_ids_by_formula.setdefault(str(source["formula_id"]), []).append(int(source["script_id"]))
        formula_rows = conn.execute("SELECT * FROM script_library_formulas WHERE status != 'retired'").fetchall()
        formulas = [
            {
                "formula_id": str(row["id"]), "name": str(row["name"]),
                "category": str(row["category"]), "stages": _load_json(row["stages_json"], []),
                "creative_decision": str(row["creative_decision"]),
                "creative_problem": str(row["creative_problem"]),
                "source_script_ids": source_ids_by_formula.get(str(row["id"]), []),
                **_load_json(row["content_json"], {}),
            }
            for row in formula_rows
        ]
        existing_principles = [
            {
                "principle_id": str(row["id"]),
                "title": str(row["title"]),
                "stages": _load_json(row["stages_json"], []),
                "statement": str(row["statement"]),
                "rationale": str(row["rationale"]),
                "applies_when": _load_json(row["applies_when_json"], []),
                "fails_or_changes_when": _load_json(row["fails_or_changes_when_json"], []),
                "review_criteria": _load_json(row["review_criteria_json"], []),
            }
            for row in conn.execute("SELECT * FROM script_library_principles WHERE status != 'retired'").fetchall()
        ]
    allowed_formula_ids = {item["formula_id"] for item in formulas}
    source_terms_by_id = _source_terms_by_script(cases)
    root = _batch_root() / "principle-batches"
    candidates: list[dict[str, Any]] = []
    for offset in range(0, len(cases), max(2, batch_size)):
        group = cases[offset:offset + max(2, batch_size)]
        observations = [
            {
                "script_id": item["script_id"], "tags": item["tags"],
                "key_observations": item["key_observations"],
                "strengths": item["strengths"], "limitations": item["limitations"],
            }
            for item in group
        ]
        allowed = {int(item["script_id"]) for item in group}
        group_formulas = [
            item for item in formulas
            if allowed.intersection(int(value) for value in item["source_script_ids"])
        ]
        group_formula_ids = {item["formula_id"] for item in group_formulas}
        result = _call_batch_stage(
            skill_name="script-principle-batch-distillation",
            task_name=f"principle_batch_{offset // max(2, batch_size) + 1:03d}",
            payload={"observations": observations, "formulas": group_formulas},
            runtime=runtime,
            output_path=root / f"batch-{offset // max(2, batch_size) + 1:03d}.json",
            max_tokens=32000,
            output_contract=PRINCIPLE_COLLECTION_CONTRACT,
            validator=lambda raw, allowed=allowed, group_formula_ids=group_formula_ids: {
                "principle_candidates": _validate_principles(
                    raw,
                    allowed,
                    source_terms_by_id,
                    minimum_sources=1,
                    allowed_formula_ids=group_formula_ids,
                )
            },
        )
        candidates.extend(result["principle_candidates"])
    merged: list[dict[str, Any]] = []
    merge_root = _batch_root() / "principle-merge"
    for stage in CREATIVE_STAGES:
        stage_candidates = [item for item in candidates if item["stages"] == [stage]]
        if not stage_candidates:
            continue
        stage_existing = [item for item in existing_principles if item["stages"] == [stage]]
        existing_ids = {item["principle_id"] for item in stage_existing}
        allowed = {int(value) for item in stage_candidates for value in item["source_script_ids"]}
        result = _call_batch_stage(
            skill_name="script-principle-batch-distillation",
            task_name=f"principle_catalog_merge_{stage}",
            payload={
                "mode": "catalog_merge",
                "stage": stage,
                "candidates": stage_candidates,
                "existing_principles": stage_existing,
                "instruction": "合并同一质量目标的原则，并检查包含关系；下位原则只是上位原则的具体应用时，必须并入上位原则。来源剧本和公式均取并集，只有至少两部剧本、两张公式共同支持时才输出。",
            },
            runtime=runtime,
            output_path=merge_root / f"{stage}.json",
            max_tokens=32000,
            output_contract=PRINCIPLE_FINAL_CONTRACT,
            validator=lambda raw, allowed=allowed, existing_ids=existing_ids: {
                "principle_candidates": _validate_principles(
                    raw,
                    allowed,
                    source_terms_by_id,
                    minimum_sources=2,
                    allowed_formula_ids=allowed_formula_ids,
                    minimum_formula_sources=2,
                    existing_principle_ids=existing_ids,
                )
            },
        )
        merged.extend(result["principle_candidates"])
    with get_connection() as conn:
        _store_principles(conn, merged)
        conn.commit()
    return merged


def _principle_evidence_for_script(references: list[str], script_id: int) -> list[str]:
    pattern = re.compile(rf"^(?:(?:script|observation):)?{script_id}(?:[:/]|$)")
    matched = [
        str(reference).strip()
        for reference in references
        if pattern.search(str(reference).strip())
    ]
    return matched or [f"script:{script_id}"]


def _store_principles(conn: sqlite3.Connection, principles: list[dict[str, Any]]) -> None:
    for principle in principles:
        principle_id = str(principle.get("principle_id") or "").strip() or _principle_id({
            "statement": principle["statement"], "stages": principle["stages"],
            "rationale": principle["rationale"],
            "applies_when": principle["applies_when"],
            "fails_or_changes_when": principle["fails_or_changes_when"],
            "review_criteria": principle["review_criteria"],
        })
        existing = conn.execute("SELECT version FROM script_library_principles WHERE id=?", (principle_id,)).fetchone()
        version = int(existing["version"] or 0) + 1 if existing else 1
        conn.execute(
            """
            INSERT INTO script_library_principles (
                id, title, stages_json, statement, rationale, applies_when_json,
                fails_or_changes_when_json, review_criteria_json, skill_keys_json,
                source_count, status, version, origin
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'candidate', ?, ?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title, stages_json=excluded.stages_json,
                statement=excluded.statement, rationale=excluded.rationale,
                applies_when_json=excluded.applies_when_json,
                fails_or_changes_when_json=excluded.fails_or_changes_when_json,
                review_criteria_json=excluded.review_criteria_json, status='candidate',
                origin=excluded.origin, version=excluded.version,
                updated_at=CURRENT_TIMESTAMP
            """,
            (
                principle_id, principle["title"], _json(principle["stages"]), principle["statement"],
                principle["rationale"], _json(principle["applies_when"]), _json(principle["fails_or_changes_when"]),
                _json(principle["review_criteria"]), _json([f"stage:{stage}" for stage in principle["stages"]]),
                version, "script-library-batch",
            ),
        )
        for script_id in principle["source_script_ids"]:
            local_id = f"batch-{principle_id}-{principle['candidate_id']}-{script_id}"
            observation_id = f"principle-observation-{principle_id}-{script_id}"
            conn.execute(
                """
                INSERT INTO script_library_principle_observations (
                    id, script_id, local_observation_id, principle_id, relation, stages_json,
                    statement, rationale, applies_when_json, fails_or_changes_when_json,
                    review_criteria_json, related_formula_ids_json, evidence_references_json,
                    decision_reason, status
                ) VALUES (?, ?, ?, ?, 'supports', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked')
                ON CONFLICT(id) DO UPDATE SET
                    local_observation_id=excluded.local_observation_id,
                    principle_id=excluded.principle_id, relation=excluded.relation,
                    stages_json=excluded.stages_json, statement=excluded.statement,
                    rationale=excluded.rationale, applies_when_json=excluded.applies_when_json,
                    fails_or_changes_when_json=excluded.fails_or_changes_when_json,
                    review_criteria_json=excluded.review_criteria_json,
                    related_formula_ids_json=excluded.related_formula_ids_json,
                    evidence_references_json=excluded.evidence_references_json,
                    decision_reason=excluded.decision_reason, status=excluded.status,
                    updated_at=CURRENT_TIMESTAMP
                """,
                (
                    observation_id, script_id, local_id, principle_id,
                    _json(principle["stages"]), principle["statement"], principle["rationale"],
                    _json(principle["applies_when"]), _json(principle["fails_or_changes_when"]),
                    _json(principle["review_criteria"]), _json(principle["related_formula_ids"]),
                    _json(_principle_evidence_for_script(principle["evidence_references"], script_id)),
                    "跨两部以上剧本验证后建立公共创作原则",
                ),
            )
        _refresh_principle(conn, principle_id)
        principle["principle_id"] = principle_id


def initialize_script_library(*, batch_size: int = DEFAULT_BATCH_SIZE, reset_catalog: bool = False) -> dict[str, Any]:
    prepared = prepare_batch_initialization(reset_catalog=reset_catalog)
    return {"prepared": prepared, "case_counts": case_ready_counts()}


def finalize_batch_scripts() -> int:
    """Mark the per-script records complete only after global catalogs exist."""
    with get_connection() as conn:
        cursor = conn.execute(
            """
            UPDATE script_library_scripts
            SET status='ready', distillation_stage='completed', distillation_stage_label='已完成',
                distillation_progress_current=distillation_progress_total,
                distillation_progress_message='案例卡、公共公式和创作原则已完成',
                updated_at=CURRENT_TIMESTAMP
            WHERE distillation_mode='batch_case' AND case_card_json!='{}'
            """
        )
        conn.commit()
        return int(cursor.rowcount)


def _batch_counts(conn: sqlite3.Connection) -> tuple[int, int]:
    row = conn.execute(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN case_card_json != '{}' THEN 1 ELSE 0 END) AS complete
        FROM script_library_scripts
        WHERE distillation_mode='batch_case'
        """
    ).fetchone()
    return int(row["total"] or 0), int(row["complete"] or 0)


def ensure_script_library_batch_run(conn: sqlite3.Connection | None = None) -> int | None:
    """Ensure the current batch library has one persisted coordinator run."""
    if conn is None:
        with get_connection() as owned_connection:
            run_id = ensure_script_library_batch_run(owned_connection)
            owned_connection.commit()
            return run_id
    _ensure_batch_schema(conn)
    total, complete = _batch_counts(conn)
    if not total:
        return None
    active = conn.execute(
        """
        SELECT * FROM script_library_batch_runs
        WHERE version=? AND status IN ('queued','running','failed')
        ORDER BY id DESC LIMIT 1
        """,
        (BATCH_VERSION,),
    ).fetchone()
    if active:
        conn.execute(
            """
            UPDATE script_library_batch_runs
            SET target_count=?, case_card_count=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
            """,
            (total, complete, int(active["id"])),
        )
        return int(active["id"])
    latest = conn.execute(
        "SELECT * FROM script_library_batch_runs WHERE version=? ORDER BY id DESC LIMIT 1",
        (BATCH_VERSION,),
    ).fetchone()
    if latest and latest["status"] == "succeeded" and latest["phase"] == "completed" and complete == total:
        return None
    cursor = conn.execute(
        """
        INSERT INTO script_library_batch_runs (
            version, status, phase, target_count, case_card_count
        ) VALUES (?, 'queued', 'case_cards', ?, ?)
        """,
        (BATCH_VERSION, total, complete),
    )
    return int(cursor.lastrowid)


def recover_script_library_batch_runs(conn: sqlite3.Connection | None = None) -> list[int]:
    """Return interrupted coordinator runs to the queue without losing checkpoints."""
    if conn is None:
        with get_connection() as owned_connection:
            run_ids = recover_script_library_batch_runs(owned_connection)
            owned_connection.commit()
            return run_ids
    rows = conn.execute(
        "SELECT id FROM script_library_batch_runs WHERE status IN ('running','failed') ORDER BY id"
    ).fetchall()
    run_ids = [int(row["id"]) for row in rows]
    if run_ids:
        conn.executemany(
            """
            UPDATE script_library_batch_runs
            SET status='queued', updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND status IN ('running','failed')
            """,
            [(run_id,) for run_id in run_ids],
        )
    return run_ids


def queued_script_library_batch_run_ids() -> list[int]:
    """Return explicitly queued batch runs without creating a new full-library run."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id FROM script_library_batch_runs
            WHERE status='queued'
              AND NOT EXISTS (
                  SELECT 1 FROM script_library_batch_runs AS active
                  WHERE active.status='running'
              )
            ORDER BY id LIMIT 1
            """
        ).fetchall()
        return [int(row["id"]) for row in rows]


def _update_batch_script_phase(
    conn: sqlite3.Connection,
    *,
    stage: str,
    label: str,
    message: str,
) -> None:
    conn.execute(
        """
        UPDATE script_library_scripts
        SET status='processing', distillation_stage=?, distillation_stage_label=?,
            distillation_progress_message=?, error_message=NULL,
            updated_at=CURRENT_TIMESTAMP
        WHERE distillation_mode='batch_case' AND case_card_json!='{}'
        """,
        (stage, label, message),
    )


def run_script_library_batch_run(run_id: int) -> None:
    """Advance one persisted run from case cards through formulas and principles."""
    with get_connection() as conn:
        claimed = conn.execute(
            """
            UPDATE script_library_batch_runs
            SET status='running', started_at=COALESCE(started_at, CURRENT_TIMESTAMP),
                error_message=NULL, updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND status='queued'
            """,
            (run_id,),
        )
        if claimed.rowcount != 1:
            return
        row = conn.execute("SELECT phase FROM script_library_batch_runs WHERE id=?", (run_id,)).fetchone()
        phase = str(row["phase"])
        conn.commit()
    try:
        if phase == "case_cards":
            with get_connection() as conn:
                total, complete = _batch_counts(conn)
                conn.execute(
                    """
                    UPDATE script_library_batch_runs
                    SET target_count=?, case_card_count=?, updated_at=CURRENT_TIMESTAMP
                    WHERE id=?
                    """,
                    (total, complete, run_id),
                )
                if complete < total:
                    remaining = total - complete
                    conn.execute(
                        """
                        UPDATE script_library_scripts
                        SET distillation_progress_message=?, updated_at=CURRENT_TIMESTAMP
                        WHERE distillation_mode='batch_case' AND case_card_json!='{}'
                        """,
                        (f"案例卡已完成，等待其余 {remaining} 部剧本",),
                    )
                    conn.execute(
                        "UPDATE script_library_batch_runs SET status='queued', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                        (run_id,),
                    )
                    conn.commit()
                    return
                conn.execute(
                    "UPDATE script_library_batch_runs SET phase='formulas', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (run_id,),
                )
                _update_batch_script_phase(
                    conn,
                    stage="formula_cards",
                    label="提炼公式卡",
                    message="正在从全库案例卡中提炼公共公式",
                )
                conn.commit()
            phase = "formulas"
        if phase == "formulas":
            formulas = distill_formulas()
            with get_connection() as conn:
                conn.execute(
                    """
                    UPDATE script_library_batch_runs
                    SET formula_count=?, phase='principles', updated_at=CURRENT_TIMESTAMP
                    WHERE id=?
                    """,
                    (len(formulas), run_id),
                )
                _update_batch_script_phase(
                    conn,
                    stage="creative_principles",
                    label="提炼创作原则",
                    message="公式卡已完成，正在提炼跨题材创作原则",
                )
                conn.commit()
            phase = "principles"
        if phase == "principles":
            principles = distill_principles()
            finalized = finalize_batch_scripts()
            with get_connection() as conn:
                total, complete = _batch_counts(conn)
                formula_count = int(conn.execute(
                    "SELECT formula_count FROM script_library_batch_runs WHERE id=?", (run_id,)
                ).fetchone()[0])
                conn.execute(
                    """
                    UPDATE script_library_batch_runs
                    SET status='succeeded', phase='completed', target_count=?, case_card_count=?,
                        formula_count=?, principle_count=?, error_message=NULL,
                        finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
                    WHERE id=?
                    """,
                    (total, complete, formula_count, len(principles), run_id),
                )
                conn.commit()
            if finalized != complete:
                raise RuntimeError(f"全库已提炼，但仅有 {finalized}/{complete} 部剧本完成状态更新")
    except Exception as exc:
        error = str(exc).strip() or exc.__class__.__name__
        with get_connection() as conn:
            row = conn.execute("SELECT phase FROM script_library_batch_runs WHERE id=?", (run_id,)).fetchone()
            failed_phase = str(row["phase"] if row else phase)
            labels = {"case_cards": "案例卡", "formulas": "公式卡", "principles": "创作原则"}
            conn.execute(
                """
                UPDATE script_library_batch_runs
                SET status='failed', retry_count=retry_count+1, error_message=?,
                    finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
                WHERE id=?
                """,
                (error, run_id),
            )
            conn.execute(
                """
                UPDATE script_library_scripts
                SET error_message=?, distillation_progress_message=?, updated_at=CURRENT_TIMESTAMP
                WHERE distillation_mode='batch_case' AND case_card_json!='{}'
                """,
                (error, f"{labels.get(failed_phase, '全库知识')}提炼未完成：{error}"),
            )
            conn.commit()
        raise
