from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.db.session import get_connection
from app.services.audit_service import record_system_audit
from app.services.mechanism_retrieval import (
    attach_retrieval_matches,
    candidate_representatives,
    causal_fingerprint,
    retrieval_confidence,
)
from app.services.script_library_service import (
    CONTROLLED_TAG_VALUES,
    DEFAULT_SHORT_WRITING_SKILL,
    MECHANISM_ACTIVATION_MIN_SOURCES,
    MECHANISM_CONTENT_FIELDS,
    MECHANISM_CURATION_VERSION,
    MECHANISM_ORIGIN,
    _applicable_tags_for_scripts,
    _coalesce_mechanism_operations,
    _json,
    _load_json,
    _mechanism_card_id,
    _mechanism_candidates,
    _mechanism_evidence,
    _required_text,
    _validate_mechanism_curation,
)


DEFAULT_CODEX_BIN = Path("/Applications/ChatGPT.app/Contents/Resources/codex")
MAX_WORKERS = 3
SEED_SAMPLE_SIZE = 180
SEED_BATCH_SIZE = 36
ROUTING_BATCH_SIZE = 96
RETRIEVAL_LIMIT = 4
# Only a strong lead in the local lexical distribution bypasses model
# adjudication. Absolute cosine scores are low for Chinese cards because the
# same causal idea is often phrased with different words, so both a minimum
# score and a margin over the runner-up are required. A false reuse pollutes
# every later script-generation request that consults the public library.
AUTO_REUSE_SCORE_THRESHOLD = 0.018
AUTO_REUSE_MARGIN_THRESHOLD = 0.002
SEED_MAX_GROUPS = 8
INTERMEDIATE_MAX_GROUPS = 36
FINAL_MAX_GROUPS = 72
FINAL_DIRECT_INPUT_LIMIT = 180


CONTENT_RULES = {
    "title": ("机制名称", 4, 80),
    "function": ("机制功能", 20, 600),
    "trigger": ("机制触发", 16, 600),
    "payoff": ("机制回报", 16, 600),
    "transferable_strategy": ("迁移策略", 30, 800),
    "failure_boundary": ("失效边界", 20, 600),
}


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
    return rows


def _raw_candidates(limit: int = 0) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    candidates: list[dict[str, Any]] = []
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM script_library_scripts WHERE status = 'ready' ORDER BY id"
        ).fetchall()
        for row in rows:
            result = {
                "tags": {
                    "theme": _load_json(row["theme_tags_json"], []),
                    "setting": _load_json(row["setting_tags_json"], []),
                    "background": _load_json(row["background_tags_json"], []),
                    "audience": _load_json(row["audience_tags_json"], []),
                },
                "case_card": _load_json(row["case_card_json"], {}),
            }
            for candidate in _mechanism_candidates(int(row["id"]), result):
                candidate["key"] = f"S{int(row['id']):06d}-{candidate['key']}"
                candidates.append(candidate)
                if limit and len(candidates) >= limit:
                    break
            if limit and len(candidates) >= limit:
                break
    return candidates, {str(candidate["key"]): candidate for candidate in candidates}


def _candidate_digest(candidate_by_key: dict[str, dict[str, Any]]) -> str:
    payload = [candidate_by_key[key] for key in sorted(candidate_by_key)]
    return hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()


def _batches(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[index:index + size] for index in range(0, len(items), size)]


def _text_schema(minimum: int, maximum: int) -> dict[str, Any]:
    return {"type": "string", "minLength": minimum, "maxLength": maximum}


def _group_schema(max_groups: int) -> dict[str, Any]:
    properties = {
        field: _text_schema(minimum, maximum)
        for field, (_, minimum, maximum) in CONTENT_RULES.items()
    }
    properties["member_keys"] = {
        "type": "array",
        "items": {"type": "string"},
        "minItems": 1,
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["groups"],
        "properties": {
            "groups": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": list(properties),
                    "properties": properties,
                },
                "minItems": 1,
                "maxItems": max_groups,
            }
        },
    }


def _operation_schema() -> dict[str, Any]:
    properties: dict[str, Any] = {
        "candidate_keys": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "action": {"type": "string", "enum": ["reuse", "improve", "create"]},
        "mechanism_id": {"type": "string", "maxLength": 120},
        "reason": _text_schema(8, 500),
    }
    properties.update({field: _text_schema(0, maximum) for field, (_, _, maximum) in CONTENT_RULES.items()})
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["operations"],
        "properties": {
            "operations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": list(properties),
                    "properties": properties,
                },
                "minItems": 1,
            }
        },
    }


def _group_prompt(
    *,
    input_path: Path,
    output_path: Path,
    max_groups: int,
    final_stage: bool,
    legacy_path: Path | None,
) -> str:
    """Compatibility wrapper for the two group-drafting prompts.

    Older dry-run tooling called one generic group prompt. Keeping this small
    adapter avoids making those callers understand the seed/consolidation
    distinction while all production paths use the more specific prompts.
    """
    if final_stage:
        prompt = _consolidation_prompt(input_path, output_path, final_stage=True)
    else:
        prompt = _seed_prompt(input_path, output_path)
    return (
        f"{prompt}\n\n额外约束：最多输出 {max_groups} 组。"
        "Codex CLI 会自动将响应保存到结果文件；不得调用 Write、apply_patch 或 shell。"
    )


def _model_command(
    *,
    codex_bin: Path,
    model: str,
    effort: str,
    schema_path: Path,
    result_path: Path,
    prompt: str,
) -> list[str]:
    return [
        str(codex_bin), "-a", "never", "-s", "read-only", "-m", model,
        "-c", f"model_reasoning_effort={effort}", "exec", "--ephemeral", "--ignore-rules",
        "-C", str(settings.repo_root), "--output-schema", str(schema_path), "-o", str(result_path), prompt,
    ]


def _run_model(
    *,
    work_dir: Path,
    input_payload: dict[str, Any],
    prompt: str,
    schema_path: Path,
    codex_bin: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    attempts: int,
    reuse_results: bool,
) -> tuple[dict[str, Any], float]:
    started = time.monotonic()
    work_dir.mkdir(parents=True, exist_ok=True)
    input_path = work_dir / "input.json"
    result_path = work_dir / "result.json"
    input_digest_path = work_dir / "input.sha256"
    log_path = work_dir / "run.log"
    serialized_input = _json(input_payload) + "\n"
    input_digest = hashlib.sha256(serialized_input.encode("utf-8")).hexdigest()
    input_path.write_text(serialized_input, encoding="utf-8")
    last_error = ""
    if reuse_results and result_path.is_file():
        try:
            previous_digest = input_digest_path.read_text(encoding="ascii").strip()
            if previous_digest == input_digest:
                parsed = json.loads(result_path.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    return parsed, time.monotonic() - started
        except (OSError, ValueError):
            pass
    for _ in range(attempts):
        try:
            result_path.unlink(missing_ok=True)
            retry_prompt = prompt if not last_error else f"{prompt}\n\n上一轮未通过验收：{last_error}。请完整修正。"
            completed = subprocess.run(
                _model_command(
                    codex_bin=codex_bin,
                    model=model,
                    effort=effort,
                    schema_path=schema_path,
                    result_path=result_path,
                    prompt=retry_prompt,
                ),
                cwd=settings.repo_root,
                env=dict(os.environ),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
            log_path.write_text(completed.stdout, encoding="utf-8")
            if completed.returncode != 0:
                raise RuntimeError(f"Codex CLI 退出码 {completed.returncode}")
            parsed = json.loads(result_path.read_text(encoding="utf-8"))
            if not isinstance(parsed, dict):
                raise RuntimeError("模型结果不是 JSON 对象")
            input_digest_path.write_text(input_digest, encoding="ascii")
            return parsed, time.monotonic() - started
        except subprocess.TimeoutExpired:
            last_error = "模型运行超时，请直接完成结构化结果"
        except (OSError, ValueError, RuntimeError) as exc:
            last_error = str(exc).strip() or exc.__class__.__name__
    raise RuntimeError(last_error)


def _compact_card(item: dict[str, Any], *, include_tags: bool = True) -> dict[str, Any]:
    def shortened(value: Any, limit: int) -> str:
        return " ".join(str(value or "").split())[:limit]

    result = {
        "key": str(item["key"]),
        "title": shortened(item.get("title") or item.get("name"), 80),
        "function": shortened(item.get("function"), 180),
        "trigger": shortened(item.get("trigger"), 180),
        "payoff": shortened(item.get("payoff"), 180),
        "transferable_strategy": shortened(item.get("transferable_strategy"), 220),
        "failure_boundary": shortened(item.get("failure_boundary"), 180),
    }
    if include_tags:
        result["applicable_tags"] = list(item.get("applicable_tags") or [])[:8]
    return result


def _validate_card(raw: dict[str, Any], *, source_terms: set[str] | None = None) -> dict[str, Any]:
    card = {
        field: _required_text(raw.get(field), label=label, minimum=minimum, maximum=maximum)
        for field, (label, minimum, maximum) in CONTENT_RULES.items()
    }
    rendered = "\n".join(card.values()).lower()
    leaked = [
        term for term in (source_terms or set())
        if len(term) >= 2 and term not in CONTROLLED_TAG_VALUES and term.lower() in rendered
    ]
    if leaked:
        raise RuntimeError(f"公共机制残留原剧专属词：{'、'.join(sorted(leaked)[:12])}")
    return card


def _validate_seed_groups(payload: dict[str, Any], *, items: list[dict[str, Any]], max_groups: int) -> list[dict[str, Any]]:
    groups = payload.get("groups")
    if not isinstance(groups, list) or not groups or len(groups) > max_groups:
        raise RuntimeError(f"种子机制应为 1-{max_groups} 组")
    item_by_key = {str(item["key"]): item for item in items}
    normalized: list[dict[str, Any]] = []
    titles: set[str] = set()
    for index, raw in enumerate(groups, start=1):
        if not isinstance(raw, dict):
            raise RuntimeError(f"第 {index} 个种子机制格式错误")
        # A representative can legitimately support multiple mechanisms. Keep
        # only keys from this batch so a model copying a key from another batch
        # cannot poison the whole bootstrap run; a seed still needs at least
        # one valid supporting example.
        members = list(dict.fromkeys(
            str(key).strip()
            for key in raw.get("member_keys") or []
            if str(key).strip() in item_by_key
        ))
        if not members:
            continue
        terms = {
            str(term).strip()
            for key in members
            for term in item_by_key[key].get("source_specific_terms", [])
            if str(term).strip()
        }
        card = _validate_card(raw, source_terms=terms)
        if card["title"] in titles:
            raise RuntimeError(f"种子机制名称重复：{card['title']}")
        titles.add(card["title"])
        normalized.append({"key": f"seed-{len(normalized) + 1:03d}", **card, "source_keys": []})
    if not normalized:
        raise RuntimeError("种子机制没有引用任何当前批次的有效样本")
    return normalized


def _validate_covering_groups(
    payload: dict[str, Any],
    *,
    items: list[dict[str, Any]],
    max_groups: int,
) -> list[dict[str, Any]]:
    groups = payload.get("groups")
    if not isinstance(groups, list) or not groups or len(groups) > max_groups:
        raise RuntimeError(f"机制收敛结果应为 1-{max_groups} 组")
    item_by_key = {str(item["key"]): item for item in items}
    seen: set[str] = set()
    titles: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(groups, start=1):
        if not isinstance(raw, dict):
            raise RuntimeError(f"第 {index} 个机制组格式错误")
        members = list(dict.fromkeys(str(key).strip() for key in raw.get("member_keys") or [] if str(key).strip()))
        if not members or any(key not in item_by_key for key in members):
            raise RuntimeError(f"第 {index} 个机制组引用了无效 key")
        if seen.intersection(members):
            raise RuntimeError("机制组包含重复成员")
        seen.update(members)
        card = _validate_card(raw)
        if card["title"] in titles:
            raise RuntimeError(f"机制名称重复：{card['title']}")
        titles.add(card["title"])
        normalized.append({
            "key": f"group-{len(normalized) + 1:03d}",
            **card,
            "source_keys": [
                source_key
                for member in members
                for source_key in item_by_key[member]["source_keys"]
            ],
        })
    missing = set(item_by_key).difference(seen)
    if missing:
        raise RuntimeError(f"机制收敛遗漏 {len(missing)} 个成员")
    return normalized


def _seed_prompt(input_path: Path, output_path: Path) -> str:
    return f"""
你要为短剧创作机制库拟定第一批“种子机制”。

代表性案例机制：{input_path}
结果文件：{output_path}

这些只是从大量案例卡中挑出的代表，不是待逐条归档的全集。请提出 1-8 条边界清晰、可跨题材复用的种子机制；只保留你能明确说清“触发条件→因果过程→剧情回报→失效边界”的机制。

规则：
1. member_keys 只标出支持该种子机制的代表案例；不要求覆盖全部输入，也不要强行把无关案例并入。
2. 忽略人名、朝代、职业、道具和具体场景，抽取可迁移的因果结构。
3. title、function、trigger、payoff、transferable_strategy、failure_boundary 都必须是可直接指导创作的抽象表述，不得出现原剧专有人名、地名、组织名或专属道具。
4. 标签只用于判断样本覆盖面，不得把题材、背景或受众直接写成机制。
5. 最终只返回符合结构化约束的 JSON。Codex CLI 会自动保存结果；不得调用 Write、apply_patch 或 shell，不得输出 Markdown。
""".strip()


def _consolidation_prompt(input_path: Path, output_path: Path, *, final_stage: bool) -> str:
    target = "这是首版机制库的全局定稿。建议形成 30-60 条，不为数量强行合并。" if final_stage else "这是定稿前的压缩阶段；只合并因果结构明确同构的机制。"
    return f"""
你要把已有的创作机制草卡收敛为少而精、可跨题材复用的公共机制库。

待收敛草卡：{input_path}
结果文件：{output_path}
{target}

规则：
1. 机制按“触发条件→因果过程→剧情回报→失效边界”判断同构，不按题材、时代、职业、道具或场景外衣判断。
2. 每个输入 key 必须且只能出现在一个 group.member_keys 中；不能丢失任何已有证据。
3. 仅当同一失效边界能够兼容时才合并。边界不同且会改变可用条件时必须保留为不同机制。
4. title、function、trigger、payoff、transferable_strategy、failure_boundary 必须是抽象、可执行的公共知识，不得残留原剧专属词。
5. 最终只返回符合结构化约束的 JSON。Codex CLI 会自动保存结果；不得调用 Write、apply_patch 或 shell，不得输出 Markdown。
""".strip()


def _routing_prompt(input_path: Path, output_path: Path, *, catalog_size: int) -> str:
    return f"""
你要把历史剧本案例卡中的单剧机制归档到一个公共创作机制库。系统已经根据因果指纹为每条候选检索出最相关的公共机制，而不是让你遍历全库。

检索到的公共机制与本批候选机制：{input_path}
结果文件：{output_path}

判定规则：
1. 依据“触发条件→因果过程→剧情回报→失效边界”判定，不依据人名、道具、时代、题材或标签。
2. 每条候选的 retrieved_mechanism_ids 是允许 reuse 或 improve 的机制 ID。若多个候选合并到同一既有机制，该 ID 必须出现在它们每一条的 retrieved_mechanism_ids 中。
3. 既有机制可无扭曲地解释候选时选 reuse；新案例补充了可复用步骤、回报或失效边界时选 improve。improve 必须保留既有机制的核心因果。
4. 只有当前 {catalog_size} 条机制都无法覆盖该因果结构时才选 create。create 进入候选池，不代表它已经被多个剧本验证。
5. 每个 candidate_key 必须且只能归入一个 operation。相同机制的候选应放进同一个 operation。
6. create 或 improve 的六项机制正文必须抽象、可执行，不得包含原剧专有人名、地名、组织名、专属道具或具体桥段顺序。
7. reuse 的 title、function、trigger、payoff、transferable_strategy、failure_boundary 填空字符串；improve 和 create 填完整正文。
8. 最终只返回符合结构化约束的 JSON。Codex CLI 会自动保存结果；不得调用 Write、apply_patch 或 shell，不得输出 Markdown。
""".strip()


def _run_seed_batch(
    *,
    batch: list[dict[str, Any]],
    work_dir: Path,
    schema_path: Path,
    codex_bin: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    attempts: int,
    reuse_results: bool,
) -> tuple[list[dict[str, Any]], float]:
    input_path = work_dir / "input.json"
    output_path = work_dir / "result.json"
    payload, elapsed = _run_model(
        work_dir=work_dir,
        input_payload={"representatives": [_compact_card(item) for item in batch]},
        prompt=_seed_prompt(input_path, output_path),
        schema_path=schema_path,
        codex_bin=codex_bin,
        model=model,
        effort=effort,
        timeout_seconds=timeout_seconds,
        attempts=attempts,
        reuse_results=reuse_results,
    )
    return _validate_seed_groups(payload, items=batch, max_groups=SEED_MAX_GROUPS), elapsed


def _run_routing_batch(
    *,
    batch: list[dict[str, Any]],
    catalog: list[dict[str, Any]],
    work_dir: Path,
    schema_path: Path,
    codex_bin: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    attempts: int,
    reuse_results: bool,
) -> tuple[dict[str, Any], float]:
    enriched, retrieved_catalog = attach_retrieval_matches(batch, catalog, limit=RETRIEVAL_LIMIT)
    input_path = work_dir / "input.json"
    output_path = work_dir / "result.json"
    payload, elapsed = _run_model(
        work_dir=work_dir,
        input_payload={
            "catalog": [_compact_card(item, include_tags=False) | {"id": item["id"], "status": item["status"]} for item in retrieved_catalog],
            "candidates": [
                _compact_card(item) | {
                    "causal_fingerprint": str(item["causal_fingerprint"])[:1000],
                    "retrieved_mechanisms": item["retrieved_mechanisms"],
                    "retrieved_mechanism_ids": item["retrieved_mechanism_ids"],
                }
                for item in enriched
            ],
        },
        prompt=_routing_prompt(input_path, output_path, catalog_size=len(catalog)),
        schema_path=schema_path,
        codex_bin=codex_bin,
        model=model,
        effort=effort,
        timeout_seconds=timeout_seconds,
        attempts=attempts,
        reuse_results=reuse_results,
    )
    source_terms = {
        str(term).strip()
        for item in batch
        for term in item.get("source_specific_terms", [])
        if str(term).strip()
    }
    validated = _validate_mechanism_curation(
        _coalesce_routing_operations(payload),
        candidate_keys={str(item["key"]) for item in batch},
        existing_ids={str(item["id"]) for item in retrieved_catalog},
        allowed_existing_by_candidate={
            str(item["key"]): set(item["retrieved_mechanism_ids"])
            for item in enriched
        },
        forbidden_terms=source_terms,
    )
    return validated, elapsed


def _coalesce_routing_operations(payload: dict[str, Any]) -> dict[str, Any]:
    """Merge a model's split operations that target the same existing card.

    The public contract requires one operation per existing mechanism inside a
    batch. Models occasionally emit one operation per paragraph despite that
    instruction. Coalescing is deterministic: candidate keys and reasons are
    combined, and an ``improve`` action wins over ``reuse`` so no proposed
    generalization is silently discarded. Candidate-to-mechanism authorization
    is still checked by ``_validate_mechanism_curation`` afterwards.
    """
    return _coalesce_mechanism_operations(payload)


def _seed_catalog(
    *,
    candidates: list[dict[str, Any]],
    work_root: Path,
    group_schema_path: Path,
    codex_bin: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    attempts: int,
    workers: int,
    reuse_results: bool,
) -> list[dict[str, Any]]:
    representatives = candidate_representatives(candidates, limit=min(SEED_SAMPLE_SIZE, len(candidates)))
    batches = _batches(representatives, SEED_BATCH_SIZE)
    seed_groups_by_batch: dict[int, list[dict[str, Any]]] = {}
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="mechanism-seed") as executor:
        futures = {
            executor.submit(
                _run_seed_batch,
                batch=batch,
                work_dir=work_root / "seed" / f"batch-{index:03d}",
                schema_path=group_schema_path,
                codex_bin=codex_bin,
                model=model,
                effort=effort,
                timeout_seconds=timeout_seconds,
                attempts=attempts,
                reuse_results=reuse_results,
            ): index
            for index, batch in enumerate(batches, start=1)
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            index = futures[future]
            groups, elapsed = future.result()
            seed_groups_by_batch[index] = groups
            print(f"种子机制 [{completed}/{len(batches)}] 第 {index} 批得到 {len(groups)} 条 ({elapsed:.1f}s)", flush=True)
    seeds = [
        {**group, "key": f"seed-{index:03d}", "source_keys": []}
        for index, group in enumerate(
            (group for batch_index in sorted(seed_groups_by_batch) for group in seed_groups_by_batch[batch_index]),
            start=1,
        )
    ]
    if len(seeds) == 1:
        return seeds
    final_dir = work_root / "seed-final"
    payload, elapsed = _run_model(
        work_dir=final_dir,
        input_payload={"cards": [_compact_card(item, include_tags=False) for item in seeds]},
        prompt=_consolidation_prompt(final_dir / "input.json", final_dir / "result.json", final_stage=False),
        schema_path=group_schema_path,
        codex_bin=codex_bin,
        model=model,
        effort=effort,
        timeout_seconds=timeout_seconds,
        attempts=attempts,
        reuse_results=reuse_results,
    )
    merged = _validate_covering_groups(payload, items=seeds, max_groups=FINAL_MAX_GROUPS)
    for index, card in enumerate(merged, start=1):
        card["key"] = f"seed-{index:03d}"
        card["source_keys"] = []
    print(f"种子机制全局定稿：{len(merged)} 条 ({elapsed:.1f}s)", flush=True)
    return merged


def _route_candidates(
    *,
    candidates: list[dict[str, Any]],
    catalog: list[dict[str, Any]],
    work_root: Path,
    operation_schema_path: Path,
    codex_bin: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    attempts: int,
    workers: int,
    reuse_results: bool,
) -> list[dict[str, Any]]:
    enriched, _ = attach_retrieval_matches(candidates, catalog, limit=RETRIEVAL_LIMIT)
    auto_groups: dict[str, list[dict[str, Any]]] = {}
    adjudication_candidates: list[dict[str, Any]] = []
    for item in enriched:
        decision = retrieval_confidence(
            item["retrieved_mechanisms"],
            score_threshold=AUTO_REUSE_SCORE_THRESHOLD,
            margin_threshold=AUTO_REUSE_MARGIN_THRESHOLD,
        )
        if decision:
            auto_groups.setdefault(decision["id"], []).append({**item, "auto_match": decision})
        else:
            adjudication_candidates.append(item)

    auto_operations = [
        {
            "candidate_keys": [str(item["key"]) for item in members],
            "action": "reuse",
            "mechanism_id": mechanism_id,
            "reason": (
                f"检索指纹高置信命中现有机制（最高相似度 {max(float(item['auto_match']['score']) for item in members):.2f}，"
                f"与次高结果至少相差 {min(float(item['auto_match']['margin']) for item in members):.2f}），进入待复用队列。"
            ),
            "title": "",
            "function": "",
            "trigger": "",
            "payoff": "",
            "transferable_strategy": "",
            "failure_boundary": "",
        }
        for mechanism_id, members in sorted(auto_groups.items())
    ]
    print(
        f"检索预归档：{sum(len(items) for items in auto_groups.values())} 条高置信复用，"
        f"{len(adjudication_candidates)} 条进入模型裁决。",
        flush=True,
    )
    if not adjudication_candidates:
        return auto_operations

    batches = _batches(adjudication_candidates, ROUTING_BATCH_SIZE)
    routed_by_batch: dict[int, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="mechanism-route") as executor:
        futures = {
            executor.submit(
                _run_routing_batch,
                batch=batch,
                catalog=catalog,
                work_dir=work_root / "routing" / f"batch-{index:03d}",
                schema_path=operation_schema_path,
                codex_bin=codex_bin,
                model=model,
                effort=effort,
                timeout_seconds=timeout_seconds,
                attempts=attempts,
                reuse_results=reuse_results,
            ): index
            for index, batch in enumerate(batches, start=1)
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            index = futures[future]
            result, elapsed = future.result()
            routed_by_batch[index] = result
            actions = {kind: 0 for kind in ("reuse", "improve", "create")}
            for operation in result["operations"]:
                actions[operation["action"]] += len(operation["candidate_keys"])
            print(
                f"归档 [{completed}/{len(batches)}] 第 {index} 批："
                f"复用 {actions['reuse']}，优化 {actions['improve']}，候选 {actions['create']} ({elapsed:.1f}s)",
                flush=True,
            )
    model_operations = [
        operation
        for index in sorted(routed_by_batch)
        for operation in routed_by_batch[index]["operations"]
    ]
    return auto_operations + model_operations


def _draft_cards(
    *,
    seed_cards: list[dict[str, Any]],
    operations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    drafts = {
        str(card["key"]): {**card, "source_keys": []}
        for card in seed_cards
    }
    improvements: dict[str, list[dict[str, Any]]] = {}
    next_create = 1
    for operation in operations:
        action = operation["action"]
        if action in {"reuse", "improve"}:
            draft = drafts.get(str(operation["mechanism_id"]))
            if not draft:
                raise RuntimeError(f"归档操作引用了未知种子机制：{operation['mechanism_id']}")
            draft["source_keys"].extend(operation["candidate_keys"])
            if action == "improve":
                improvements.setdefault(str(operation["mechanism_id"]), []).append(operation)
            continue
        card = _validate_card(operation)
        drafts[f"novel-{next_create:03d}"] = {
            "key": f"novel-{next_create:03d}",
            **card,
            "source_keys": list(operation["candidate_keys"]),
        }
        next_create += 1

    for mechanism_id, candidates in improvements.items():
        # Do not repeatedly overwrite a seed with the arrival order of parallel
        # routing batches. The most broadly supported proposed expansion becomes
        # the draft sent to the global quality pass.
        best = max(candidates, key=lambda item: (len(item["candidate_keys"]), len(item["reason"])))
        drafts[mechanism_id].update(_validate_card(best))
    return [card for card in drafts.values() if card["source_keys"]]


def _reduce_drafts(
    *,
    cards: list[dict[str, Any]],
    work_root: Path,
    group_schema_path: Path,
    codex_bin: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    attempts: int,
    workers: int,
    reuse_results: bool,
) -> list[dict[str, Any]]:
    current = cards
    round_index = 1
    while len(current) > FINAL_DIRECT_INPUT_LIMIT:
        batches = _batches(current, 60)
        grouped_by_batch: dict[int, list[dict[str, Any]]] = {}
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="mechanism-compact") as executor:
            futures = {
                executor.submit(
                    _run_model,
                    work_dir=work_root / f"compact-{round_index:02d}" / f"batch-{index:03d}",
                    input_payload={"cards": [_compact_card(item, include_tags=False) for item in batch]},
                    prompt=_consolidation_prompt(
                        work_root / f"compact-{round_index:02d}" / f"batch-{index:03d}" / "input.json",
                        work_root / f"compact-{round_index:02d}" / f"batch-{index:03d}" / "result.json",
                        final_stage=False,
                    ),
                    schema_path=group_schema_path,
                    codex_bin=codex_bin,
                    model=model,
                    effort=effort,
                    timeout_seconds=timeout_seconds,
                    attempts=attempts,
                    reuse_results=reuse_results,
                ): (index, batch)
                for index, batch in enumerate(batches, start=1)
            }
            for completed, future in enumerate(as_completed(futures), start=1):
                index, batch = futures[future]
                payload, elapsed = future.result()
                grouped_by_batch[index] = _validate_covering_groups(
                    payload, items=batch, max_groups=INTERMEDIATE_MAX_GROUPS
                )
                print(f"草卡压缩 [{completed}/{len(batches)}] 第 {index} 批完成 ({elapsed:.1f}s)", flush=True)
        current = [card for index in sorted(grouped_by_batch) for card in grouped_by_batch[index]]
        for index, card in enumerate(current, start=1):
            card["key"] = f"compact-{round_index:02d}-{index:03d}"
        round_index += 1

    final_dir = work_root / "final"
    payload, elapsed = _run_model(
        work_dir=final_dir,
        input_payload={"cards": [_compact_card(item, include_tags=False) for item in current]},
        prompt=_consolidation_prompt(final_dir / "input.json", final_dir / "result.json", final_stage=True),
        schema_path=group_schema_path,
        codex_bin=codex_bin,
        model=model,
        effort=effort,
        timeout_seconds=timeout_seconds,
        attempts=attempts,
        reuse_results=reuse_results,
    )
    final_cards = _validate_covering_groups(payload, items=current, max_groups=FINAL_MAX_GROUPS)
    print(f"公共机制全局定稿：{len(final_cards)} 条 ({elapsed:.1f}s)", flush=True)
    return final_cards


def _save_mechanism_library(
    groups: list[dict[str, Any]],
    *,
    candidate_by_key: dict[str, dict[str, Any]],
    source_digest: str,
    model: str,
    seed_effort: str,
    routing_effort: str,
    replace: bool,
) -> None:
    _, current_candidates = _raw_candidates()
    if _candidate_digest(current_candidates) != source_digest:
        raise RuntimeError("归档期间案例卡发生变化，为避免覆盖新结果，本次未写入机制库")
    with get_connection() as conn:
        existing = int(conn.execute(
            "SELECT COUNT(*) FROM script_library_formula_cards WHERE formula_type = 'mechanism'"
        ).fetchone()[0])
        if existing and not replace:
            raise RuntimeError("机制库已有内容；如需用历史初始化结果覆盖，请显式传入 --replace")
        if replace:
            conn.execute("DELETE FROM script_library_formula_cards WHERE formula_type = 'mechanism'")
        for group in groups:
            candidates = [candidate_by_key[key] for key in group["source_keys"]]
            script_ids = list(dict.fromkeys(int(candidate["script_id"]) for candidate in candidates))
            card = {field: group[field] for field in CONTENT_RULES}
            mechanism_id = _mechanism_card_id(card)
            content = {
                **{field: group[field] for field in MECHANISM_CONTENT_FIELDS},
                "causal_fingerprint": causal_fingerprint(card),
                "evidence": [_mechanism_evidence(candidate) for candidate in candidates],
                "curation_history": [{
                    "action": "historical_initialize",
                    "candidate_count": len(candidates),
                    "source_count": len(script_ids),
                }],
                "revision": 1,
                "curation_version": MECHANISM_CURATION_VERSION,
            }
            conn.execute(
                """
                INSERT INTO script_library_formula_cards (
                    id, formula_type, title, description, applicable_tags_json,
                    source_script_ids_json, source_count, status, origin, content_json
                ) VALUES (?, 'mechanism', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mechanism_id, group["title"], group["function"],
                    _json(_applicable_tags_for_scripts(conn, script_ids)), _json(script_ids), len(script_ids),
                    "active" if len(script_ids) >= MECHANISM_ACTIVATION_MIN_SOURCES else "candidate",
                    MECHANISM_ORIGIN, _json(content),
                ),
            )
        record_system_audit(
            conn,
            action="script_library.mechanisms.initialized",
            target_type="script_library",
            target_label="创作机制库",
            details={
                "mechanism_count": len(groups),
                "candidate_count": len(candidate_by_key),
                "model": model,
                "seed_effort": seed_effort,
                "routing_effort": routing_effort,
                "version": MECHANISM_CURATION_VERSION,
            },
        )
        conn.commit()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="基于既有案例卡初始化检索驱动的创作机制库。")
    parser.add_argument("--codex-bin", type=Path, default=DEFAULT_CODEX_BIN)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--seed-effort", default="max", choices=("low", "medium", "high", "xhigh", "max"))
    parser.add_argument("--routing-effort", default="high", choices=("low", "medium", "high", "xhigh", "max"))
    parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--limit", type=int, default=0, help="仅用于小样本演练，必须与 --dry-run 一起使用。")
    parser.add_argument("--reuse-results", action="store_true")
    parser.add_argument("--replace", action="store_true", help="显式覆盖已有创作机制库。")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit and not args.dry_run:
        raise SystemExit("--limit 仅用于小样本演练，必须与 --dry-run 一起使用。")
    codex_bin = args.codex_bin.expanduser().resolve()
    if not codex_bin.is_file():
        raise SystemExit(f"未找到 Codex CLI：{codex_bin}")
    workers = max(1, min(int(args.workers), MAX_WORKERS))
    attempts = max(1, min(int(args.attempts), 4))
    work_root = settings.data_dir / "script-library" / "mechanism-bootstrap-v2"
    work_root.mkdir(parents=True, exist_ok=True)
    group_schema_path = work_root / "schema-groups.json"
    operation_schema_path = work_root / "schema-routing.json"
    group_schema_path.write_text(json.dumps(_group_schema(FINAL_MAX_GROUPS), ensure_ascii=False, indent=2), encoding="utf-8")
    operation_schema_path.write_text(json.dumps(_operation_schema(), ensure_ascii=False, indent=2), encoding="utf-8")

    candidates, candidate_by_key = _raw_candidates(max(0, int(args.limit)))
    if not candidates:
        raise SystemExit("没有可用于初始化的已完成案例卡机制。")
    print(f"读取 {len(candidates)} 条案例卡机制；并发上限 {workers}。", flush=True)
    source_digest = _candidate_digest(candidate_by_key)
    seed_cards = _seed_catalog(
        candidates=candidates,
        work_root=work_root,
        group_schema_path=group_schema_path,
        codex_bin=codex_bin,
        model=args.model,
        effort=args.seed_effort,
        timeout_seconds=max(60, int(args.timeout_seconds)),
        attempts=attempts,
        workers=workers,
        reuse_results=bool(args.reuse_results),
    )
    catalog = [{"id": card["key"], "status": "seed", **card} for card in seed_cards]
    operations = _route_candidates(
        candidates=candidates,
        catalog=catalog,
        work_root=work_root,
        operation_schema_path=operation_schema_path,
        codex_bin=codex_bin,
        model=args.model,
        effort=args.routing_effort,
        timeout_seconds=max(60, int(args.timeout_seconds)),
        attempts=attempts,
        workers=workers,
        reuse_results=bool(args.reuse_results),
    )
    drafts = _draft_cards(seed_cards=seed_cards, operations=operations)
    if not drafts:
        raise RuntimeError("归档后没有获得任何机制草卡")
    final_cards = _reduce_drafts(
        cards=drafts,
        work_root=work_root,
        group_schema_path=group_schema_path,
        codex_bin=codex_bin,
        model=args.model,
        effort=args.seed_effort,
        timeout_seconds=max(60, int(args.timeout_seconds)),
        attempts=attempts,
        workers=workers,
        reuse_results=bool(args.reuse_results),
    )
    covered = [key for card in final_cards for key in card["source_keys"]]
    if set(covered) != set(candidate_by_key) or len(covered) != len(set(covered)):
        raise RuntimeError(f"最终机制库覆盖异常：{len(set(covered))}/{len(candidate_by_key)}")
    output_path = work_root / "curated-mechanisms.json"
    output_path.write_text(_json({"mechanisms": final_cards}) + "\n", encoding="utf-8")
    print(f"机制库构建完成：{len(final_cards)} 条公共机制，覆盖 {len(covered)} 条案例卡机制。", flush=True)
    if not args.dry_run:
        _save_mechanism_library(
            final_cards,
            candidate_by_key=candidate_by_key,
            source_digest=source_digest,
            model=args.model,
            seed_effort=args.seed_effort,
            routing_effort=args.routing_effort,
            replace=bool(args.replace),
        )
        print("创作机制库已写入数据库。", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
