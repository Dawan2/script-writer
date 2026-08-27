from __future__ import annotations

import math
import re
import hashlib
from collections import Counter
from typing import Any


FINGERPRINT_FIELDS = (
    ("trigger", "触发"),
    ("function", "因果作用"),
    ("payoff", "剧情回报"),
    ("failure_boundary", "失效边界"),
)

# These words recur in nearly every distilled card but do not identify a causal
# mechanism. Retrieval still uses the complete card for the final model decision.
LOW_SIGNAL_TERMS = frozenset({
    "主角", "对手", "角色", "剧情", "故事", "机制", "场景", "观众", "关系",
    "通过", "利用", "形成", "完成", "推动", "改变", "获得", "出现", "必须",
    "可以", "需要", "如果", "否则", "以及", "同时", "之后", "最后", "让人",
})


def causal_fingerprint(item: dict[str, Any]) -> str:
    """Render the stable causal fields used for retrieval, never source metadata."""
    sections: list[str] = []
    for field, label in FINGERPRINT_FIELDS:
        value = re.sub(r"\s+", " ", str(item.get(field) or "").strip())
        if value:
            sections.append(f"{label}：{value}")
    strategy = re.sub(r"\s+", " ", str(item.get("transferable_strategy") or "").strip())
    if strategy:
        sections.append(f"迁移步骤：{strategy}")
    return "\n".join(sections)


def _masked_text(item: dict[str, Any]) -> str:
    text = "\n".join((str(item.get("name") or ""), causal_fingerprint(item)))
    forbidden = [str(value).strip() for value in item.get("source_specific_terms", [])]
    for term in forbidden:
        if len(term) >= 2:
            text = text.replace(term, " ")
    return text


def _terms(text: str) -> Counter[str]:
    counts: Counter[str] = Counter()
    for word in re.findall(r"[A-Za-z0-9][A-Za-z0-9_-]{1,}|[\u4e00-\u9fff]+", text.lower()):
        if re.fullmatch(r"[\u4e00-\u9fff]+", word):
            # Chinese has no reliable whitespace word boundary here. Character
            # bi/tri-grams preserve mechanism phrases while avoiding one-character noise.
            for width in (2, 3):
                for index in range(len(word) - width + 1):
                    token = word[index:index + width]
                    if token not in LOW_SIGNAL_TERMS:
                        counts[token] += 1
        elif word not in LOW_SIGNAL_TERMS:
            counts[word] += 1
    return counts


def _weighted_vectors(items: list[dict[str, Any]]) -> list[dict[str, float]]:
    term_counts = [_terms(_masked_text(item)) for item in items]
    documents = max(1, len(term_counts))
    document_frequency: Counter[str] = Counter()
    for counts in term_counts:
        document_frequency.update(counts.keys())
    vectors: list[dict[str, float]] = []
    for counts in term_counts:
        vector: dict[str, float] = {}
        for term, count in counts.items():
            idf = math.log((documents + 1) / (document_frequency[term] + 1)) + 1
            vector[term] = (1 + math.log(count)) * idf
        vectors.append(vector)
    return vectors


def _cosine(left: dict[str, float], right: dict[str, float]) -> float:
    if not left or not right:
        return 0.0
    if len(left) > len(right):
        left, right = right, left
    dot = sum(value * right.get(term, 0.0) for term, value in left.items())
    if not dot:
        return 0.0
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    return dot / (left_norm * right_norm) if left_norm and right_norm else 0.0


def rank_mechanism_matches(
    candidate: dict[str, Any],
    catalog: list[dict[str, Any]],
    *,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Return lexical-semantic candidates for adjudication, never an auto-merge."""
    if not catalog or limit <= 0:
        return []
    items = [candidate, *catalog]
    candidate_vector, *catalog_vectors = _weighted_vectors(items)
    ranked = [
        {
            "id": str(card["id"]),
            "score": round(_cosine(candidate_vector, vector), 4),
        }
        for card, vector in zip(catalog, catalog_vectors, strict=True)
    ]
    ranked.sort(key=lambda item: (-float(item["score"]), str(item["id"])))
    return ranked[:limit]


def attach_retrieval_matches(
    candidates: list[dict[str, Any]],
    catalog: list[dict[str, Any]],
    *,
    limit: int = 5,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Attach top matches and return only the catalog cards visible to the model."""
    catalog_by_id = {str(item["id"]): item for item in catalog}
    # Build the TF-IDF vectors once for the complete request. Calling
    # ``rank_mechanism_matches`` independently would recompute document
    # frequencies for every candidate and turns bootstrap retrieval into an
    # accidental O(n^2) operation.
    vectors = _weighted_vectors([*candidates, *catalog])
    candidate_vectors = vectors[: len(candidates)]
    catalog_vectors = vectors[len(candidates):]
    selected_ids: list[str] = []
    enriched: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates):
        ranked = [
            {
                "id": str(card["id"]),
                "score": round(_cosine(candidate_vectors[index], vector), 4),
            }
            for card, vector in zip(catalog, catalog_vectors, strict=True)
        ]
        ranked.sort(key=lambda item: (-float(item["score"]), str(item["id"])))
        matches = ranked[:limit]
        match_ids = [str(item["id"]) for item in matches]
        for mechanism_id in match_ids:
            if mechanism_id not in selected_ids:
                selected_ids.append(mechanism_id)
        enriched.append({
            **candidate,
            "causal_fingerprint": causal_fingerprint(candidate),
            "retrieved_mechanisms": matches,
            "retrieved_mechanism_ids": match_ids,
        })
    return enriched, [catalog_by_id[item] for item in selected_ids]


def retrieval_confidence(
    matches: list[dict[str, Any]],
    *,
    score_threshold: float = 0.72,
    margin_threshold: float = 0.16,
) -> dict[str, Any] | None:
    """Return a conservative auto-reuse decision for an unambiguous match.

    Retrieval is intentionally not a semantic judge. Auto reuse is reserved for
    a strong lexical match with a clear lead over the runner-up; everything else
    remains in the model adjudication queue. Returning the evidence keeps the
    decision auditable and makes threshold tuning possible without changing the
    curation contract.
    """
    if not matches:
        return None
    ranked = sorted(matches, key=lambda item: (-float(item.get("score", 0)), str(item.get("id", ""))))
    top = ranked[0]
    top_score = float(top.get("score", 0))
    second_score = float(ranked[1].get("score", 0)) if len(ranked) > 1 else 0.0
    margin = top_score - second_score
    if top_score < score_threshold or (len(ranked) > 1 and margin < margin_threshold):
        return None
    return {
        "id": str(top["id"]),
        "score": round(top_score, 4),
        "runner_up_score": round(second_score, 4),
        "margin": round(margin, 4),
    }


def candidate_representatives(
    candidates: list[dict[str, Any]],
    *,
    limit: int,
) -> list[dict[str, Any]]:
    """Pick a deterministic, diverse sample for seed-card drafting."""
    if limit <= 0 or len(candidates) <= limit:
        return list(candidates)
    # Farthest-point sampling over every pair of 1,600+ cards is needlessly
    # expensive for bootstrap. Use a deterministic two-pass sampler instead:
    # first cover as many source scripts as possible, then fill the remainder
    # with stable hash buckets. It preserves reproducibility and cross-script
    # diversity without an O(n * limit * vector_size) hot loop.
    by_script: dict[str, list[dict[str, Any]]] = {}
    for item in candidates:
        key = str(item.get("key") or "")
        script_id = key.split("-", 1)[0]
        by_script.setdefault(script_id, []).append(item)
    selected: list[dict[str, Any]] = []
    for script_id in sorted(by_script):
        options = sorted(
            by_script[script_id],
            key=lambda item: hashlib.sha256(str(item.get("key") or "").encode("utf-8")).hexdigest(),
        )
        selected.append(options[0])
        if len(selected) >= limit:
            return selected[:limit]
    selected_keys = {str(item.get("key") or "") for item in selected}
    remaining = [item for item in candidates if str(item.get("key") or "") not in selected_keys]
    remaining.sort(
        key=lambda item: hashlib.sha256(
            f"{item.get('key', '')}\n{causal_fingerprint(item)}".encode("utf-8")
        ).hexdigest()
    )
    selected.extend(remaining[: max(0, limit - len(selected))])
    return selected[:limit]
