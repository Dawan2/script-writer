from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from typing import Callable


SOURCE_INDEX_RE = re.compile(r"^L(\d+)-L(\d+)$")

# The source indexer uses the same limits.  They keep a leaf reader focused on
# a coherent stretch of prose while allowing three independent readers to run.
MAX_SOURCE_BLOCK_CHARS = 54_000
MAX_SOURCE_BLOCK_CHAPTERS = 12
MAX_FINAL_INPUT_CHARS = 130_000
MAX_FINAL_CARDS = 8
MAX_PRIMARY_CHARACTERS = 10
MAX_CARDS_PER_ARC = 4
MAX_ARC_INPUT_CHARS = 88_000
MAX_STORY_ARC_LEVELS = 6
MAX_SEMANTIC_REPAIR_ATTEMPTS = 1
MAX_LEAF_REPAIR_ATTEMPTS = 2
MAX_TARGETED_LEAF_CHAPTERS = 3
MAX_REPAIR_CONTEXT_CHARS = 36_000

FACT_LEDGER_SCHEMA_VERSION = "4.0.0"
STORY_ARC_SCHEMA_VERSION = "1.0.0"
CHECKPOINT_SCHEMA_VERSION = "4.0.0"
CHECKPOINT_ROOT = Path("runtime") / "novel-analysis"


class NovelAnalysisPipelineError(RuntimeError):
    pass


def _read_json(path_value: Path) -> dict:
    try:
        payload = json.loads(path_value.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise NovelAnalysisPipelineError(f"小说整理结果无法读取：{path_value}") from exc
    if not isinstance(payload, dict):
        raise NovelAnalysisPipelineError("小说整理结果必须是 JSON 对象")
    return payload


def _write_json_atomically(path_value: Path, payload: dict) -> None:
    path_value.parent.mkdir(parents=True, exist_ok=True)
    temporary = path_value.with_name(f".{path_value.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path_value)
    finally:
        temporary.unlink(missing_ok=True)


def _json_sha256(payload: object) -> str:
    rendered = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def _source_bounds(value: object) -> tuple[int, int] | None:
    matched = SOURCE_INDEX_RE.fullmatch(str(value or "").strip())
    if not matched:
        return None
    return int(matched.group(1)), int(matched.group(2))


def _source_index(start: int, end: int) -> str:
    return f"L{start}-L{end}"


def _file_sha256(path_value: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path_value.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise NovelAnalysisPipelineError("小说原文不存在或无法读取") from exc
    return digest.hexdigest()


def _resolve_source_path(workspace: Path, relative_path: object) -> Path:
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise NovelAnalysisPipelineError("小说索引缺少原文位置")
    workspace_root = workspace.resolve()
    source_path = (workspace_root / relative_path).resolve()
    try:
        source_path.relative_to(workspace_root)
    except ValueError as exc:
        raise NovelAnalysisPipelineError("小说原文必须位于当前项目目录内") from exc
    return source_path


def _chapters_for_range(source_index: dict, start_line: int, end_line: int, fallback_order: int) -> list[dict]:
    chapter_entries = source_index.get("chapters")
    chapters: list[dict] = []
    if isinstance(chapter_entries, list):
        for raw_chapter in chapter_entries:
            if not isinstance(raw_chapter, dict):
                continue
            try:
                chapter_start = int(raw_chapter.get("start_line") or 0)
                chapter_end = int(raw_chapter.get("end_line") or 0)
            except (TypeError, ValueError):
                continue
            if chapter_end < start_line or chapter_start > end_line or chapter_start < 1 or chapter_end < chapter_start:
                continue
            clipped_start = max(start_line, chapter_start)
            clipped_end = min(end_line, chapter_end)
            title = str(raw_chapter.get("title") or "").strip() or f"第{len(chapters) + 1}章"
            chapters.append({
                "title": title,
                "start_line": clipped_start,
                "end_line": clipped_end,
                "span": _source_index(clipped_start, clipped_end),
            })
    if chapters:
        return chapters
    return [{
        "title": f"第{fallback_order}部分",
        "start_line": start_line,
        "end_line": end_line,
        "span": _source_index(start_line, end_line),
    }]


def _rendered_source_line_chars(line: str, line_number: int) -> int:
    return len(str(line_number)) + 2 + len(line) + 1


def _source_range_chars(lines: list[str], start_line: int, end_line: int) -> int:
    return sum(
        _rendered_source_line_chars(lines[line_number - 1], line_number)
        for line_number in range(start_line, end_line + 1)
    )


def _split_lines_by_source_budget(
    lines: list[str],
    start_line: int,
    end_line: int,
) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    start = start_line
    current_chars = 0
    end = start - 1
    while end < end_line:
        line_number = end + 1
        line_chars = _rendered_source_line_chars(lines[line_number - 1], line_number)
        if line_chars > MAX_SOURCE_BLOCK_CHARS:
            raise NovelAnalysisPipelineError("小说原文存在过长单段，请重新初始化小说解读")
        if end >= start and current_chars + line_chars > MAX_SOURCE_BLOCK_CHARS:
            ranges.append((start, end))
            start = line_number
            current_chars = 0
        current_chars += line_chars
        end = line_number
    if start <= end_line:
        ranges.append((start, end_line))
    return ranges


def _source_range_pieces(
    source_index: dict,
    start_line: int,
    end_line: int,
) -> list[tuple[int, int, bool]]:
    chapters = _chapters_for_range(source_index, start_line, end_line, 1)
    pieces: list[tuple[int, int, bool]] = []
    cursor = start_line
    for chapter in chapters:
        chapter_start = max(cursor, int(chapter["start_line"]))
        chapter_end = min(end_line, int(chapter["end_line"]))
        if chapter_start > end_line:
            break
        if chapter_start > cursor:
            pieces.append((cursor, chapter_start - 1, False))
        if chapter_end >= chapter_start:
            pieces.append((chapter_start, chapter_end, True))
            cursor = chapter_end + 1
    if cursor <= end_line:
        pieces.append((cursor, end_line, False))
    return pieces or [(start_line, end_line, False)]


def _refine_source_ranges(
    *,
    lines: list[str],
    source_index: dict,
    ranges: list[tuple[int, int]],
) -> list[tuple[int, int]]:
    refined: list[tuple[int, int]] = []
    for range_start, range_end in ranges:
        current_start = 0
        current_end = 0
        current_chars = 0
        current_chapter_count = 0

        def flush() -> None:
            nonlocal current_start, current_end, current_chars, current_chapter_count
            if current_start:
                refined.append((current_start, current_end))
            current_start = 0
            current_end = 0
            current_chars = 0
            current_chapter_count = 0

        for piece_start, piece_end, is_chapter in _source_range_pieces(source_index, range_start, range_end):
            piece_chars = _source_range_chars(lines, piece_start, piece_end)
            if piece_chars > MAX_SOURCE_BLOCK_CHARS:
                flush()
                refined.extend(_split_lines_by_source_budget(lines, piece_start, piece_end))
                continue
            exceeds_budget = current_start and current_chars + piece_chars > MAX_SOURCE_BLOCK_CHARS
            exceeds_chapter_limit = current_start and is_chapter and current_chapter_count >= MAX_SOURCE_BLOCK_CHAPTERS
            if exceeds_budget or exceeds_chapter_limit:
                flush()
            if not current_start:
                current_start = piece_start
            current_end = piece_end
            current_chars += piece_chars
            current_chapter_count += int(is_chapter)
        flush()

    expected_start = ranges[0][0] if ranges else 1
    for start_line, end_line in refined:
        if start_line != expected_start or end_line < start_line:
            raise NovelAnalysisPipelineError("小说阅读范围无法按章节安全切分")
        expected_start = end_line + 1
    if ranges and expected_start != ranges[-1][1] + 1:
        raise NovelAnalysisPipelineError("小说阅读范围没有覆盖全文")
    return refined


def build_source_blocks(workspace: Path, source_index: dict) -> list[dict]:
    source_path = _resolve_source_path(workspace, source_index.get("source_file"))
    try:
        source_text = source_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise NovelAnalysisPipelineError("小说原文不存在或无法读取") from exc
    lines = source_text.replace("\r\n", "\n").split("\n")
    total_lines = int(source_index.get("total_lines") or 0)
    if total_lines < 1 or total_lines != len(lines):
        raise NovelAnalysisPipelineError("小说原文与行号索引不一致，请重新初始化")
    raw_batches = source_index.get("suggested_batches")
    if not isinstance(raw_batches, list) or not raw_batches:
        raise NovelAnalysisPipelineError("小说索引没有可执行的阅读范围")

    ranges: list[tuple[int, int]] = []
    expected_start = 1
    for order, batch in enumerate(raw_batches, start=1):
        if not isinstance(batch, dict):
            raise NovelAnalysisPipelineError(f"第 {order} 个阅读范围无效")
        start = int(batch.get("start_line") or 0)
        end = int(batch.get("end_line") or 0)
        if start != expected_start or end < start or end > total_lines:
            raise NovelAnalysisPipelineError("小说阅读范围必须连续覆盖全文且不能越界")
        ranges.append((start, end))
        expected_start = end + 1
    if expected_start != total_lines + 1:
        raise NovelAnalysisPipelineError("小说阅读范围没有覆盖全文")

    ranges = _refine_source_ranges(lines=lines, source_index=source_index, ranges=ranges)
    blocks: list[dict] = []
    for range_start, range_end in ranges:
        start = range_start
        while start <= range_end:
            rendered_lines: list[str] = []
            rendered_chars = 0
            end = start - 1
            while end < range_end:
                line_number = end + 1
                rendered = f"{line_number}: {lines[line_number - 1]}"
                if len(rendered) > MAX_SOURCE_BLOCK_CHARS:
                    raise NovelAnalysisPipelineError("小说原文存在过长单段，请重新初始化小说解读")
                added_chars = len(rendered) + (1 if rendered_lines else 0)
                if rendered_lines and rendered_chars + added_chars > MAX_SOURCE_BLOCK_CHARS:
                    break
                rendered_lines.append(rendered)
                rendered_chars += added_chars
                end = line_number
            if end < start:
                raise NovelAnalysisPipelineError("小说阅读范围无法完整切分")
            block_order = len(blocks) + 1
            blocks.append({
                "id": f"block-{block_order:03d}",
                "order": block_order,
                "start_line": start,
                "end_line": end,
                "source_index": _source_index(start, end),
                "content": "\n".join(rendered_lines),
                "chapters": _chapters_for_range(source_index, start, end, block_order),
            })
            start = end + 1
    return blocks


def _normalize_source_indexes(value: object) -> list[str]:
    if isinstance(value, str):
        values = re.split(r"[；;]", value)
    elif isinstance(value, list):
        values = []
        for item in value:
            if isinstance(item, str):
                values.extend(re.split(r"[；;]", item))
            else:
                return []
    else:
        return []
    return [item.strip() for item in values if item.strip()]


def _as_text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _as_mapping(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _issue(issues: list[str], message: str) -> None:
    if message not in issues:
        issues.append(message)


def _repair_context(
    *,
    prior_issues: list[str] | None,
    prior_semantics: object | None,
) -> str:
    if not prior_issues:
        return ""
    issue_text = "\n".join(f"- {issue}" for issue in prior_issues)
    if not isinstance(prior_semantics, dict):
        return f"\n上一版有以下问题。请修复后重新输出：\n{issue_text}"
    rendered = json.dumps(prior_semantics, ensure_ascii=False, indent=2)
    if len(rendered) > MAX_REPAIR_CONTEXT_CHARS:
        return (
            f"\n上一版有以下问题。请修复后重新输出：\n{issue_text}\n"
            "上一版结果过长，无法作为修复基线；请严格按本次字段与原文范围重新生成。"
        )
    return (
        f"\n上一版有以下问题。只修复这些问题，其他已正确内容保持不变：\n{issue_text}\n"
        f"上一版语义 JSON：\n{rendered}"
    )


def _validate_indexes(
    value: object,
    *,
    start_line: int,
    end_line: int,
    label: str,
    issues: list[str],
    minimum: int = 1,
) -> list[str]:
    indexes = _normalize_source_indexes(value)
    if len(indexes) < minimum:
        _issue(issues, f"{label}至少需要一个有效原文索引")
        return []
    valid: list[str] = []
    for index in indexes:
        bounds = _source_bounds(index)
        if bounds is None:
            _issue(issues, f"{label}原文索引格式无效：{index}")
            continue
        index_start, index_end = bounds
        if index_start < start_line or index_end < index_start or index_end > end_line:
            _issue(issues, f"{label}原文索引超出当前范围：{index}")
            continue
        valid.append(index)
    if len(valid) < minimum:
        _issue(issues, f"{label}没有位于当前范围内的原文索引")
    return valid


def _materialize_text_pairs(
    value: object,
    *,
    keys: tuple[str, str],
    label: str,
    issues: list[str],
) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        _issue(issues, f"{label}必须是数组")
        return []
    output: list[dict] = []
    for index, raw_item in enumerate(value, start=1):
        item = _as_mapping(raw_item)
        first = _as_text(item.get(keys[0]))
        second = _as_text(item.get(keys[1]))
        if not first or not second:
            _issue(issues, f"{label}第 {index} 项内容不完整")
            continue
        output.append({keys[0]: first, keys[1]: second})
    return output


def _materialize_highlights(
    value: object,
    *,
    start_line: int,
    end_line: int,
    label: str,
    issues: list[str],
) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        _issue(issues, f"{label}必须是数组")
        return []
    output: list[dict] = []
    for index, raw_item in enumerate(value, start=1):
        item = _as_mapping(raw_item)
        name = _as_text(item.get("name"))
        source_index = _as_text(item.get("source_index"))
        valid_indexes = _validate_indexes(
            [source_index] if source_index else [],
            start_line=start_line,
            end_line=end_line,
            label=f"{label}第 {index} 项",
            issues=issues,
        )
        if not name or not valid_indexes:
            if not name:
                _issue(issues, f"{label}第 {index} 项名称不能为空")
            continue
        output.append({"name": name, "source_index": valid_indexes[0]})
    return output


def _materialize_world_constraints(
    value: object,
    *,
    start_line: int,
    end_line: int,
    label: str,
    issues: list[str],
) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        _issue(issues, f"{label}必须是数组")
        return []
    output: list[dict] = []
    for index, raw_item in enumerate(value, start=1):
        item = _as_mapping(raw_item)
        rule = _as_text(item.get("rule"))
        dramatic_function = _as_text(item.get("dramatic_function"))
        source_indexes = _validate_indexes(
            item.get("source_indexes"),
            start_line=start_line,
            end_line=end_line,
            label=f"{label}第 {index} 项",
            issues=issues,
        )
        if not rule or not dramatic_function or not source_indexes:
            if not rule or not dramatic_function:
                _issue(issues, f"{label}第 {index} 项内容不完整")
            continue
        output.append({
            "rule": rule,
            "dramatic_function": dramatic_function,
            "source_indexes": source_indexes,
        })
    return output


def _validate_persisted_indexes(
    value: object,
    *,
    start_line: int,
    end_line: int,
    label: str,
    issues: list[str],
) -> None:
    if not isinstance(value, list):
        _issue(issues, f"{label}原文索引必须是数组")
        return
    _validate_indexes(
        value,
        start_line=start_line,
        end_line=end_line,
        label=label,
        issues=issues,
    )


def _validate_persisted_records(
    value: object,
    *,
    required_keys: tuple[str, ...],
    text_keys: tuple[str, ...],
    label: str,
    issues: list[str],
    start_line: int | None = None,
    end_line: int | None = None,
    source_index_key: str | None = None,
) -> None:
    if not isinstance(value, list):
        _issue(issues, f"{label}必须是数组")
        return
    for order, raw_item in enumerate(value, start=1):
        if not isinstance(raw_item, dict) or set(raw_item) != set(required_keys):
            _issue(issues, f"{label}第 {order} 项结构无效")
            continue
        if any(not _as_text(raw_item.get(key)) for key in text_keys):
            _issue(issues, f"{label}第 {order} 项内容不完整")
        if source_index_key is None:
            continue
        assert start_line is not None and end_line is not None
        index_value = raw_item.get(source_index_key)
        if source_index_key == "source_index":
            _validate_indexes(
                [index_value] if _as_text(index_value) else [],
                start_line=start_line,
                end_line=end_line,
                label=f"{label}第 {order} 项",
                issues=issues,
            )
        else:
            _validate_persisted_indexes(
                index_value,
                start_line=start_line,
                end_line=end_line,
                label=f"{label}第 {order} 项",
                issues=issues,
            )


def create_leaf_ledger_skeleton(block: dict) -> dict:
    """Create all invariant fields before a model supplies narrative semantics."""
    chapters: list[dict] = []
    for order, chapter in enumerate(block["chapters"], start=1):
        chapters.append({
            "chapter_id": f"{block['id']}-chapter-{order:03d}",
            "order": order,
            "title": str(chapter["title"]),
            "span": str(chapter["span"]),
            "events": [],
        })
    return {
        "schema_version": FACT_LEDGER_SCHEMA_VERSION,
        "block_id": str(block["id"]),
        "span": str(block["source_index"]),
        "opening_state": "",
        "chapters": chapters,
        "closing_state": "",
    }


def leaf_semantics_prompt(
    *,
    block: dict,
    reading_principles: str,
    prior_issues: list[str] | None = None,
    prior_semantics: object | None = None,
) -> str:
    skeleton = create_leaf_ledger_skeleton(block)
    slots = [
        {"chapter_id": chapter["chapter_id"], "title": chapter["title"], "source_index": chapter["span"]}
        for chapter in skeleton["chapters"]
    ]
    repair_text = _repair_context(
        prior_issues=prior_issues,
        prior_semantics=prior_semantics,
    )
    return f"""你正在阅读长篇小说的一段连续原文。请只提炼原著事实，不做短剧取舍或类型套路补写。

解读原则：
{reading_principles.strip()}

本段的章节标识与原文范围：
{json.dumps(slots, ensure_ascii=False)}

输出要求：
1. 服务已生成固定章节、标题、原文范围和序号。只输出下方 JSON 中的语义字段；不得输出章节标题、范围、序号、ID 或 Markdown。
2. 每个 `chapter_id` 必须恰好出现一次。每章写 1 至多项会改变后续行动的关键事件；一个事件完整写出起因与选择、冲突或转折、结果及后效。没有对应内容的变化、高光或规则数组写空数组。
3. 事件原文索引必须落在所属章节范围内。高光索引覆盖动作、反应和结果。不要写跨章节线索；后续剧情弧步骤会处理跨块关联。
4. 所有叙述使用中文，短而完整；不编造、不评价、不遗漏会影响后续选择、人物变化或伏笔兑现的事实。

只输出此 JSON：
{{
  "opening_state": "",
  "closing_state": "",
  "chapters": [
    {{
      "chapter_id": "上方给出的章节标识",
      "events": [
        {{
          "source_indexes": ["L起始行-L结束行"],
          "cause_and_choice": "",
          "conflict_and_turn": "",
          "result_and_future_effect": "",
          "state_changes": [{{"subject": "", "change": ""}}],
          "information_changes": [{{"content": "", "known_by_and_status": ""}}],
          "highlights": [{{"name": "", "source_index": "L起始行-L结束行"}}],
          "world_constraints": [{{"rule": "", "dramatic_function": "", "source_indexes": ["L起始行-L结束行"]}}]
        }}
      ]
    }}
  ]
}}
{repair_text}

原文：
{str(block.get('content') or '')}
""".strip()


def _materialize_leaf_chapter_events(
    *,
    chapter: dict,
    raw_chapter: object,
    issues: list[str],
) -> list[dict]:
    raw_events = _as_mapping(raw_chapter).get("events")
    if not isinstance(raw_events, list) or not raw_events:
        _issue(issues, f"{chapter['title']}至少需要一个关键事件")
        return []
    bounds = _source_bounds(chapter["span"])
    assert bounds is not None
    start_line, end_line = bounds
    events: list[dict] = []
    for event_order, raw_event in enumerate(raw_events, start=1):
        event = _as_mapping(raw_event)
        prefix = f"{chapter['title']}的事件第 {event_order} 项"
        source_indexes = _validate_indexes(
            event.get("source_indexes"),
            start_line=start_line,
            end_line=end_line,
            label=prefix,
            issues=issues,
        )
        cause_and_choice = _as_text(event.get("cause_and_choice"))
        conflict_and_turn = _as_text(event.get("conflict_and_turn"))
        result_and_future_effect = _as_text(event.get("result_and_future_effect"))
        if not cause_and_choice:
            _issue(issues, f"{prefix}缺少起因与选择")
        if not conflict_and_turn:
            _issue(issues, f"{prefix}缺少冲突或转折")
        if not result_and_future_effect:
            _issue(issues, f"{prefix}缺少结果及后效")
        events.append({
            "event_id": f"{chapter['chapter_id']}-event-{event_order:03d}",
            "source_indexes": source_indexes,
            "cause_and_choice": cause_and_choice,
            "conflict_and_turn": conflict_and_turn,
            "result_and_future_effect": result_and_future_effect,
            "state_changes": _materialize_text_pairs(
                event.get("state_changes"),
                keys=("subject", "change"),
                label=f"{prefix}的人物状态变化",
                issues=issues,
            ),
            "information_changes": _materialize_text_pairs(
                event.get("information_changes"),
                keys=("content", "known_by_and_status"),
                label=f"{prefix}的信息变化",
                issues=issues,
            ),
            "highlights": _materialize_highlights(
                event.get("highlights"),
                start_line=start_line,
                end_line=end_line,
                label=f"{prefix}的高光时刻",
                issues=issues,
            ),
            "world_constraints": _materialize_world_constraints(
                event.get("world_constraints"),
                start_line=start_line,
                end_line=end_line,
                label=f"{prefix}的世界规则",
                issues=issues,
            ),
        })
    return events


def materialize_leaf_ledger(*, block: dict, semantics: object) -> tuple[dict, list[str]]:
    """Apply model semantics onto a deterministic leaf skeleton.

    Unknown fields are deliberately ignored: they cannot corrupt the persisted
    structure.  Missing or false narrative facts remain explicit repair issues.
    """
    issues: list[str] = []
    ledger = create_leaf_ledger_skeleton(block)
    payload = _as_mapping(semantics)
    if not payload:
        return ledger, ["分段阅读没有返回语义内容"]
    opening_state = _as_text(payload.get("opening_state"))
    closing_state = _as_text(payload.get("closing_state"))
    if not opening_state:
        _issue(issues, "本段开场状态不能为空")
    if not closing_state:
        _issue(issues, "本段收束状态不能为空")
    ledger["opening_state"] = opening_state
    ledger["closing_state"] = closing_state

    raw_chapters = payload.get("chapters")
    if not isinstance(raw_chapters, list):
        return ledger, [*issues, "章节语义必须是数组"]
    semantics_by_id: dict[str, dict] = {}
    for index, raw_chapter in enumerate(raw_chapters, start=1):
        chapter = _as_mapping(raw_chapter)
        chapter_id = _as_text(chapter.get("chapter_id"))
        if not chapter_id:
            _issue(issues, f"第 {index} 个章节语义缺少 chapter_id")
            continue
        if chapter_id in semantics_by_id:
            _issue(issues, f"章节语义重复：{chapter_id}")
            continue
        semantics_by_id[chapter_id] = chapter

    expected_ids = [chapter["chapter_id"] for chapter in ledger["chapters"]]
    unknown_ids = sorted(set(semantics_by_id) - set(expected_ids))
    for chapter_id in unknown_ids:
        _issue(issues, f"章节语义引用了当前分段外的章节：{chapter_id}")
    for chapter in ledger["chapters"]:
        chapter_id = chapter["chapter_id"]
        raw_chapter = semantics_by_id.get(chapter_id)
        if raw_chapter is None:
            _issue(issues, f"缺少章节语义：{chapter_id}")
            continue
        chapter["events"] = _materialize_leaf_chapter_events(
            chapter=chapter,
            raw_chapter=raw_chapter,
            issues=issues,
        )
    return ledger, issues


def validate_leaf_ledger(ledger: object, *, block: dict) -> list[str]:
    issues: list[str] = []
    if not isinstance(ledger, dict):
        return ["原著事实卡必须是 JSON 对象"]
    expected = create_leaf_ledger_skeleton(block)
    expected_keys = set(expected)
    if set(ledger) != expected_keys:
        return ["原著事实卡顶层结构无效"]
    if ledger.get("schema_version") != FACT_LEDGER_SCHEMA_VERSION:
        _issue(issues, "原著事实卡版本无效")
    if ledger.get("block_id") != expected["block_id"] or ledger.get("span") != expected["span"]:
        _issue(issues, "原著事实卡不属于当前原文范围")
    if not _as_text(ledger.get("opening_state")):
        _issue(issues, "本段开场状态不能为空")
    if not _as_text(ledger.get("closing_state")):
        _issue(issues, "本段收束状态不能为空")
    chapters = ledger.get("chapters")
    if not isinstance(chapters, list) or len(chapters) != len(expected["chapters"]):
        return [*issues, "原著事实卡必须逐项覆盖当前章节"]
    for chapter, expected_chapter in zip(chapters, expected["chapters"]):
        if not isinstance(chapter, dict):
            _issue(issues, "原著事实卡存在无效章节")
            continue
        if set(chapter) != {"chapter_id", "order", "title", "span", "events"}:
            _issue(issues, f"章节结构无效：{expected_chapter['chapter_id']}")
            continue
        for key in ("chapter_id", "order", "title", "span"):
            if chapter.get(key) != expected_chapter[key]:
                _issue(issues, f"章节固定信息不匹配：{expected_chapter['chapter_id']}")
                break
        events = chapter.get("events")
        if not isinstance(events, list) or not events:
            _issue(issues, f"{expected_chapter['title']}至少需要一个关键事件")
            continue
        bounds = _source_bounds(expected_chapter["span"])
        assert bounds is not None
        for order, event in enumerate(events, start=1):
            if not isinstance(event, dict):
                _issue(issues, f"{expected_chapter['title']}存在无效事件")
                continue
            if set(event) != {
                "event_id",
                "source_indexes",
                "cause_and_choice",
                "conflict_and_turn",
                "result_and_future_effect",
                "state_changes",
                "information_changes",
                "highlights",
                "world_constraints",
            }:
                _issue(issues, f"{expected_chapter['title']}事件结构无效")
                continue
            if event.get("event_id") != f"{expected_chapter['chapter_id']}-event-{order:03d}":
                _issue(issues, f"{expected_chapter['title']}事件序号无效")
            _validate_persisted_indexes(
                event.get("source_indexes"),
                start_line=bounds[0],
                end_line=bounds[1],
                label=f"{expected_chapter['title']}事件第 {order} 项",
                issues=issues,
            )
            for field_name, label in (
                ("cause_and_choice", "起因与选择"),
                ("conflict_and_turn", "冲突或转折"),
                ("result_and_future_effect", "结果及后效"),
            ):
                if not _as_text(event.get(field_name)):
                    _issue(issues, f"{expected_chapter['title']}事件第 {order} 项缺少{label}")
            prefix = f"{expected_chapter['title']}事件第 {order} 项"
            _validate_persisted_records(
                event.get("state_changes"),
                required_keys=("subject", "change"),
                text_keys=("subject", "change"),
                label=f"{prefix}的人物状态变化",
                issues=issues,
            )
            _validate_persisted_records(
                event.get("information_changes"),
                required_keys=("content", "known_by_and_status"),
                text_keys=("content", "known_by_and_status"),
                label=f"{prefix}的信息变化",
                issues=issues,
            )
            _validate_persisted_records(
                event.get("highlights"),
                required_keys=("name", "source_index"),
                text_keys=("name",),
                source_index_key="source_index",
                start_line=bounds[0],
                end_line=bounds[1],
                label=f"{prefix}的高光时刻",
                issues=issues,
            )
            _validate_persisted_records(
                event.get("world_constraints"),
                required_keys=("rule", "dramatic_function", "source_indexes"),
                text_keys=("rule", "dramatic_function"),
                source_index_key="source_indexes",
                start_line=bounds[0],
                end_line=bounds[1],
                label=f"{prefix}的世界规则",
                issues=issues,
            )
    return issues


# Preserve a narrow compatibility surface for code that refers to the old
# internal name.  The persisted contract is the new skeleton-based format.
def validate_event_ledger(ledger: object, *, block: dict) -> list[str]:
    return validate_leaf_ledger(ledger, block=block)


def _leaf_chapter_issue_map(*, block: dict, semantics: object) -> dict[str, list[str]] | None:
    """Return independently repairable chapter issues, or None for a block-level defect."""
    payload = _as_mapping(semantics)
    if not payload or not _as_text(payload.get("opening_state")) or not _as_text(payload.get("closing_state")):
        return None
    raw_chapters = payload.get("chapters")
    skeleton = create_leaf_ledger_skeleton(block)
    if not isinstance(raw_chapters, list) or len(raw_chapters) != len(skeleton["chapters"]):
        return None
    raw_by_id: dict[str, dict] = {}
    for raw_chapter in raw_chapters:
        chapter = _as_mapping(raw_chapter)
        chapter_id = _as_text(chapter.get("chapter_id"))
        if not chapter_id or chapter_id in raw_by_id:
            return None
        raw_by_id[chapter_id] = chapter
    expected_ids = {chapter["chapter_id"] for chapter in skeleton["chapters"]}
    if set(raw_by_id) != expected_ids:
        return None
    chapter_issues: dict[str, list[str]] = {}
    for chapter in skeleton["chapters"]:
        issues: list[str] = []
        _materialize_leaf_chapter_events(
            chapter=chapter,
            raw_chapter=raw_by_id[chapter["chapter_id"]],
            issues=issues,
        )
        if issues:
            chapter_issues[chapter["chapter_id"]] = issues
    return chapter_issues or None


def _chapter_source_excerpt(*, block: dict, chapter: dict) -> str:
    bounds = _source_bounds(chapter["span"])
    assert bounds is not None
    start_line, end_line = bounds
    excerpt: list[str] = []
    for rendered_line in str(block.get("content") or "").splitlines():
        matched = re.match(r"^(\d+):(?: ?)(.*)$", rendered_line)
        if matched and start_line <= int(matched.group(1)) <= end_line:
            excerpt.append(rendered_line)
    return "\n".join(excerpt)


def leaf_chapter_semantics_repair_prompt(
    *,
    block: dict,
    chapter: dict,
    reading_principles: str,
    prior_chapter: dict,
    prior_issues: list[str],
) -> str:
    issue_text = "\n".join(f"- {issue}" for issue in prior_issues)
    prior_text = json.dumps(prior_chapter, ensure_ascii=False, indent=2)
    if len(prior_text) > MAX_REPAIR_CONTEXT_CHARS:
        prior_text = "上一版本章结果过长，已省略；请以本章原文重新提炼。"
    return f"""你正在修复小说事实卡中的单个章节。只处理这一章，不能引用前后章节的原文或事件。

解读原则：
{reading_principles.strip()}

当前章节：
- chapter_id：{chapter['chapter_id']}
- 标题：{chapter['title']}
- 唯一合法原文范围：{chapter['span']}

上一版本章存在的问题：
{issue_text}

上一版本章语义 JSON：
{prior_text}

修复要求：
1. 只输出当前 `chapter_id` 的 `events`。事件索引、高光索引及世界规则索引都必须完全落在 `{chapter['span']}` 内。
2. 若上一版事实实际发生在相邻章节，不得挪用或裁剪索引；从本章原文重新提炼，或删除该事实并保留本章真实的关键变化。
3. 每个事件完整写明起因与选择、冲突或转折、结果及后效；没有对应内容的数组写空数组。
4. 只输出 JSON 对象，不输出 Markdown、解释、标题或其他章节。

只输出此 JSON：
{{
  "chapter_id": "{chapter['chapter_id']}",
  "events": [
    {{
      "source_indexes": ["L起始行-L结束行"],
      "cause_and_choice": "",
      "conflict_and_turn": "",
      "result_and_future_effect": "",
      "state_changes": [{{"subject": "", "change": ""}}],
      "information_changes": [{{"content": "", "known_by_and_status": ""}}],
      "highlights": [{{"name": "", "source_index": "L起始行-L结束行"}}],
      "world_constraints": [{{"rule": "", "dramatic_function": "", "source_indexes": ["L起始行-L结束行"]}}]
    }}
  ]
}}

本章原文：
{_chapter_source_excerpt(block=block, chapter=chapter)}
""".strip()


def _repair_label(label: str, *, attempt: int) -> str:
    return f"{label}-repair" if attempt == 1 else f"{label}-repair-{attempt}"


def _repair_leaf_chapters(
    *,
    block: dict,
    semantics: object,
    chapter_issues: dict[str, list[str]],
    output_path: Path,
    label: str,
    reading_principles: str,
    attempt: int,
    run_model: Callable[[str, str, Path], None],
) -> None:
    repaired_semantics = copy.deepcopy(_as_mapping(semantics))
    raw_chapters = repaired_semantics.get("chapters")
    if not isinstance(raw_chapters, list):
        raise NovelAnalysisPipelineError("分段阅读结果无法定向修复")
    positions: dict[str, int] = {}
    for index, raw_chapter in enumerate(raw_chapters):
        chapter_id = _as_text(_as_mapping(raw_chapter).get("chapter_id"))
        if chapter_id:
            positions[chapter_id] = index
    for chapter in create_leaf_ledger_skeleton(block)["chapters"]:
        chapter_id = chapter["chapter_id"]
        if chapter_id not in chapter_issues:
            continue
        position = positions.get(chapter_id)
        if position is None:
            raise NovelAnalysisPipelineError("分段阅读结果缺少待修复章节")
        repair_path = output_path.with_name(
            f"{output_path.stem}.{chapter_id}.repair-{attempt}.json"
        )
        prior_chapter = _as_mapping(raw_chapters[position])
        run_model(
            leaf_chapter_semantics_repair_prompt(
                block=block,
                chapter=chapter,
                reading_principles=reading_principles,
                prior_chapter=prior_chapter,
                prior_issues=chapter_issues[chapter_id][:12],
            ),
            _repair_label(f"{label}-chapter-{chapter['order']:03d}", attempt=attempt),
            repair_path,
        )
        repaired_chapter = _read_json(repair_path)
        if _as_text(repaired_chapter.get("chapter_id")) != chapter_id:
            raise NovelAnalysisPipelineError(f"{chapter['title']}定向修复返回了错误的章节标识")
        raw_chapters[position] = repaired_chapter
    _write_json_atomically(output_path, repaired_semantics)


def _checkpoint_root(workspace: Path) -> Path:
    return workspace / CHECKPOINT_ROOT


def _checkpoint_manifest_path(workspace: Path) -> Path:
    return _checkpoint_root(workspace) / "read-state.json"


def _checkpoint_ledger_path(workspace: Path, block: dict) -> Path:
    return _checkpoint_root(workspace) / "ledgers" / f"{block['id']}.json"


def _checkpoint_fingerprint(
    *,
    workspace: Path,
    source_index: dict,
    reading_principles: str,
    unit_principles: str,
) -> str:
    source_path = _resolve_source_path(workspace, source_index.get("source_file"))
    return _json_sha256({
        "checkpoint_schema_version": CHECKPOINT_SCHEMA_VERSION,
        "fact_ledger_schema_version": FACT_LEDGER_SCHEMA_VERSION,
        "story_arc_schema_version": STORY_ARC_SCHEMA_VERSION,
        "source_sha256": _file_sha256(source_path),
        "source_index": source_index,
        "reading_principles": reading_principles,
        "unit_principles": unit_principles,
    })


def _load_checkpoint_state(workspace: Path, fingerprint: str) -> dict:
    try:
        payload = _read_json(_checkpoint_manifest_path(workspace))
    except NovelAnalysisPipelineError:
        payload = {}
    if (
        payload.get("schema_version") != CHECKPOINT_SCHEMA_VERSION
        or payload.get("fact_ledger_schema_version") != FACT_LEDGER_SCHEMA_VERSION
        or payload.get("fingerprint") != fingerprint
        or not isinstance(payload.get("blocks"), dict)
    ):
        return {
            "schema_version": CHECKPOINT_SCHEMA_VERSION,
            "fact_ledger_schema_version": FACT_LEDGER_SCHEMA_VERSION,
            "fingerprint": fingerprint,
            "blocks": {},
        }
    return payload


def _load_checkpoint_ledger(*, workspace: Path, state: dict, block: dict) -> dict | None:
    record = state.get("blocks", {}).get(block["id"])
    if not isinstance(record, dict):
        return None
    if (
        record.get("start_line") != block["start_line"]
        or record.get("end_line") != block["end_line"]
        or record.get("source_index") != block["source_index"]
    ):
        return None
    try:
        ledger = _read_json(_checkpoint_ledger_path(workspace, block))
    except NovelAnalysisPipelineError:
        return None
    if record.get("sha256") != _json_sha256(ledger) or validate_leaf_ledger(ledger, block=block):
        return None
    return ledger


def _save_checkpoint_ledger(*, workspace: Path, state: dict, block: dict, ledger: dict) -> None:
    _write_json_atomically(_checkpoint_ledger_path(workspace, block), ledger)
    blocks = state.setdefault("blocks", {})
    blocks[block["id"]] = {
        "start_line": block["start_line"],
        "end_line": block["end_line"],
        "source_index": block["source_index"],
        "sha256": _json_sha256(ledger),
    }
    _write_json_atomically(_checkpoint_manifest_path(workspace), state)


def _checkpoint_ready_leaf_output(
    *,
    output_path: Path,
    block: dict,
    workspace: Path,
    checkpoint_state: dict,
) -> bool:
    try:
        semantics = _read_json(output_path)
        ledger, issues = materialize_leaf_ledger(block=block, semantics=semantics)
    except NovelAnalysisPipelineError:
        return False
    if issues or validate_leaf_ledger(ledger, block=block):
        return False
    _write_json_atomically(output_path, ledger)
    _save_checkpoint_ledger(workspace=workspace, state=checkpoint_state, block=block, ledger=ledger)
    return True


def _finalize_leaf_output(
    *,
    block: dict,
    output_path: Path,
    label: str,
    reading_principles: str,
    run_model: Callable[[str, str, Path], None],
) -> tuple[dict | None, list[str]]:
    issues: list[str] = []
    for attempt in range(MAX_LEAF_REPAIR_ATTEMPTS + 1):
        semantics: dict | None = None
        try:
            semantics = _read_json(output_path)
            ledger, issues = materialize_leaf_ledger(block=block, semantics=semantics)
        except NovelAnalysisPipelineError as exc:
            ledger = None
            issues = [str(exc)]
        if ledger is not None:
            issues = [*issues, *validate_leaf_ledger(ledger, block=block)]
        if not issues:
            return ledger, []
        if attempt >= MAX_LEAF_REPAIR_ATTEMPTS:
            break
        chapter_issues = _leaf_chapter_issue_map(block=block, semantics=semantics)
        if chapter_issues and len(chapter_issues) <= MAX_TARGETED_LEAF_CHAPTERS:
            try:
                _repair_leaf_chapters(
                    block=block,
                    semantics=semantics,
                    chapter_issues=chapter_issues,
                    output_path=output_path,
                    label=label,
                    reading_principles=reading_principles,
                    attempt=attempt + 1,
                    run_model=run_model,
                )
                continue
            except NovelAnalysisPipelineError as exc:
                _issue(issues, str(exc))
        run_model(
            leaf_semantics_prompt(
                block=block,
                reading_principles=reading_principles,
                prior_issues=issues[:12],
                prior_semantics=semantics,
            ),
            _repair_label(label, attempt=attempt + 1),
            output_path,
        )
    return None, issues


def _card_span(card: dict) -> tuple[int, int]:
    bounds = _source_bounds(card.get("span"))
    if bounds is None:
        raise NovelAnalysisPipelineError("剧情卡缺少有效原文范围")
    return bounds


def _card_id(card: dict) -> str:
    value = _as_text(card.get("card_id")) or _as_text(card.get("block_id"))
    if not value:
        raise NovelAnalysisPipelineError("剧情卡缺少标识")
    return value


def _cards_are_contiguous(cards: list[dict]) -> tuple[int, int]:
    if not cards:
        raise NovelAnalysisPipelineError("没有可关联的剧情卡")
    first_start, first_end = _card_span(cards[0])
    previous_end = first_end
    for card in cards[1:]:
        start, end = _card_span(card)
        if start != previous_end + 1:
            raise NovelAnalysisPipelineError("剧情卡必须按原著顺序连续关联")
        previous_end = end
    return first_start, previous_end


def group_story_cards(cards: list[dict]) -> list[list[dict]]:
    groups: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    for card in cards:
        card_chars = len(json.dumps(card, ensure_ascii=False))
        if current and (
            len(current) >= MAX_CARDS_PER_ARC
            or current_chars + card_chars > MAX_ARC_INPUT_CHARS
        ):
            groups.append(current)
            current = []
            current_chars = 0
        current.append(card)
        current_chars += card_chars
    if current:
        groups.append(current)
    # Do not ask a model to summarize one card into itself merely because the
    # total count leaves a remainder of one.
    if len(groups) > 1 and len(groups[-1]) == 1 and len(groups[-2]) > 2:
        candidate = [groups[-2][-1], *groups[-1]]
        if len(json.dumps(candidate, ensure_ascii=False)) <= MAX_ARC_INPUT_CHARS:
            groups[-1].insert(0, groups[-2].pop())
    return groups


def create_story_arc_card_skeleton(*, cards: list[dict], level: int, group_index: int) -> dict:
    start_line, end_line = _cards_are_contiguous(cards)
    return {
        "schema_version": STORY_ARC_SCHEMA_VERSION,
        "card_id": f"arc-{level:02d}-{group_index:03d}",
        "level": level,
        "span": _source_index(start_line, end_line),
        "source_card_ids": [_card_id(card) for card in cards],
        "arcs": [],
        "handoff_state": "",
    }


def _materialize_arc_threads(
    value: object,
    *,
    start_line: int,
    end_line: int,
    label: str,
    issues: list[str],
) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        _issue(issues, f"{label}必须是数组")
        return []
    output: list[dict] = []
    for index, raw_item in enumerate(value, start=1):
        item = _as_mapping(raw_item)
        thread = _as_text(item.get("thread"))
        status_and_effect = _as_text(item.get("status_and_effect"))
        source_indexes = _validate_indexes(
            item.get("source_indexes"),
            start_line=start_line,
            end_line=end_line,
            label=f"{label}第 {index} 项",
            issues=issues,
        )
        if not thread or not status_and_effect or not source_indexes:
            if not thread or not status_and_effect:
                _issue(issues, f"{label}第 {index} 项内容不完整")
            continue
        output.append({
            "thread": thread,
            "status_and_effect": status_and_effect,
            "source_indexes": source_indexes,
        })
    return output


def story_arc_semantics_prompt(
    *,
    cards: list[dict],
    level: int,
    group_index: int,
    reading_principles: str,
    unit_principles: str,
    prior_issues: list[str] | None = None,
    prior_semantics: object | None = None,
) -> str:
    skeleton = create_story_arc_card_skeleton(cards=cards, level=level, group_index=group_index)
    repair_text = _repair_context(
        prior_issues=prior_issues,
        prior_semantics=prior_semantics,
    )
    return f"""请把相邻的原著事实卡提炼为剧情弧摘要卡。原子事实卡会被永久保留，本步骤可以压缩重复表述，但不能把摘要伪装成无损事件账本。

全文解读原则：
{reading_principles.strip()}

剧情单元原则：
{unit_principles.strip()}

本组覆盖原文范围：{skeleton['span']}
本组来源卡：{json.dumps(skeleton['source_card_ids'], ensure_ascii=False)}

要求：
1. 先按原著因果划出一至多个连续剧情弧。每个弧至少写清因果梗概和对主线的新推进，并保留可回溯的原文索引。
2. 提炼人物变化、秘密或证据变化、高光和未解线索。后文推翻前文认知时，保留认知变化，不同时保留互相冲突的结论。
3. 不做短剧删改建议，不编造原著未出现的关系、动机或结果。没有对应内容的数组写空数组。
4. 服务会生成卡片 ID、层级、范围、来源卡和数组对象。只返回语义字段，不输出 Markdown 或固定字段。

只输出此 JSON：
{{
  "arcs": [
    {{
      "source_indexes": ["L起始行-L结束行"],
      "summary": "",
      "mainline_advance": "",
      "key_characters": [{{"name": "", "role_and_change": ""}}],
      "information_changes": [{{"content": "", "effect": ""}}],
      "highlights": [{{"name": "", "source_index": "L起始行-L结束行"}}],
      "unresolved_threads": [{{"thread": "", "status_and_effect": "", "source_indexes": ["L起始行-L结束行"]}}]
    }}
  ],
  "handoff_state": ""
}}
{repair_text}

原著事实卡：
{json.dumps(cards, ensure_ascii=False)}
""".strip()


def materialize_story_arc_card(
    *,
    cards: list[dict],
    level: int,
    group_index: int,
    semantics: object,
) -> tuple[dict, list[str]]:
    issues: list[str] = []
    card = create_story_arc_card_skeleton(cards=cards, level=level, group_index=group_index)
    payload = _as_mapping(semantics)
    if not payload:
        return card, ["剧情弧整理没有返回语义内容"]
    start_line, end_line = _card_span(card)
    handoff_state = _as_text(payload.get("handoff_state"))
    if not handoff_state:
        _issue(issues, "剧情弧收束状态不能为空")
    card["handoff_state"] = handoff_state
    raw_arcs = payload.get("arcs")
    if not isinstance(raw_arcs, list) or not raw_arcs:
        return card, [*issues, "剧情弧至少需要一项"]
    arcs: list[dict] = []
    for order, raw_arc in enumerate(raw_arcs, start=1):
        arc = _as_mapping(raw_arc)
        label = f"剧情弧第 {order} 项"
        source_indexes = _validate_indexes(
            arc.get("source_indexes"),
            start_line=start_line,
            end_line=end_line,
            label=label,
            issues=issues,
        )
        summary = _as_text(arc.get("summary"))
        mainline_advance = _as_text(arc.get("mainline_advance"))
        if not summary:
            _issue(issues, f"{label}梗概不能为空")
        if not mainline_advance:
            _issue(issues, f"{label}主线推进不能为空")
        arcs.append({
            "arc_id": f"{card['card_id']}-arc-{order:03d}",
            "source_indexes": source_indexes,
            "summary": summary,
            "mainline_advance": mainline_advance,
            "key_characters": _materialize_text_pairs(
                arc.get("key_characters"),
                keys=("name", "role_and_change"),
                label=f"{label}的关键人物",
                issues=issues,
            ),
            "information_changes": _materialize_text_pairs(
                arc.get("information_changes"),
                keys=("content", "effect"),
                label=f"{label}的信息变化",
                issues=issues,
            ),
            "highlights": _materialize_highlights(
                arc.get("highlights"),
                start_line=start_line,
                end_line=end_line,
                label=f"{label}的高光时刻",
                issues=issues,
            ),
            "unresolved_threads": _materialize_arc_threads(
                arc.get("unresolved_threads"),
                start_line=start_line,
                end_line=end_line,
                label=f"{label}的未解线索",
                issues=issues,
            ),
        })
    card["arcs"] = arcs
    return card, issues


def validate_story_arc_card(
    *,
    card: object,
    source_cards: list[dict],
    expected_level: int | None = None,
    expected_group_index: int | None = None,
) -> list[str]:
    issues: list[str] = []
    if not isinstance(card, dict):
        return ["剧情弧卡必须是 JSON 对象"]
    expected_keys = {"schema_version", "card_id", "level", "span", "source_card_ids", "arcs", "handoff_state"}
    if set(card) != expected_keys:
        return ["剧情弧卡结构无效"]
    if card.get("schema_version") != STORY_ARC_SCHEMA_VERSION:
        _issue(issues, "剧情弧卡版本无效")
    if not isinstance(card.get("level"), int) or int(card["level"]) < 1:
        _issue(issues, "剧情弧卡层级无效")
    if expected_level is not None and card.get("level") != expected_level:
        _issue(issues, "剧情弧卡层级与当前任务不一致")
    if expected_level is not None and expected_group_index is not None:
        expected_id = f"arc-{expected_level:02d}-{expected_group_index:03d}"
        if card.get("card_id") != expected_id:
            _issue(issues, "剧情弧卡标识与当前任务不一致")
    start_line, end_line = _cards_are_contiguous(source_cards)
    if card.get("span") != _source_index(start_line, end_line):
        _issue(issues, "剧情弧卡原文范围无效")
    if card.get("source_card_ids") != [_card_id(item) for item in source_cards]:
        _issue(issues, "剧情弧卡来源不完整")
    if not _as_text(card.get("handoff_state")):
        _issue(issues, "剧情弧收束状态不能为空")
    arcs = card.get("arcs")
    if not isinstance(arcs, list) or not arcs:
        _issue(issues, "剧情弧至少需要一项")
        return issues
    card_id = _as_text(card.get("card_id"))
    if not card_id:
        _issue(issues, "剧情弧卡标识不能为空")
    for order, arc in enumerate(arcs, start=1):
        if not isinstance(arc, dict):
            _issue(issues, "剧情弧存在无效项")
            continue
        if set(arc) != {
            "arc_id",
            "source_indexes",
            "summary",
            "mainline_advance",
            "key_characters",
            "information_changes",
            "highlights",
            "unresolved_threads",
        }:
            _issue(issues, "剧情弧结构无效")
            continue
        if arc.get("arc_id") != f"{card_id}-arc-{order:03d}":
            _issue(issues, "剧情弧序号无效")
        _validate_persisted_indexes(
            arc.get("source_indexes"),
            start_line=start_line,
            end_line=end_line,
            label=f"剧情弧第 {order} 项",
            issues=issues,
        )
        if not _as_text(arc.get("summary")) or not _as_text(arc.get("mainline_advance")):
            _issue(issues, f"剧情弧第 {order} 项内容不完整")
        prefix = f"剧情弧第 {order} 项"
        _validate_persisted_records(
            arc.get("key_characters"),
            required_keys=("name", "role_and_change"),
            text_keys=("name", "role_and_change"),
            label=f"{prefix}的关键人物",
            issues=issues,
        )
        _validate_persisted_records(
            arc.get("information_changes"),
            required_keys=("content", "effect"),
            text_keys=("content", "effect"),
            label=f"{prefix}的信息变化",
            issues=issues,
        )
        _validate_persisted_records(
            arc.get("highlights"),
            required_keys=("name", "source_index"),
            text_keys=("name",),
            source_index_key="source_index",
            start_line=start_line,
            end_line=end_line,
            label=f"{prefix}的高光时刻",
            issues=issues,
        )
        _validate_persisted_records(
            arc.get("unresolved_threads"),
            required_keys=("thread", "status_and_effect", "source_indexes"),
            text_keys=("thread", "status_and_effect"),
            source_index_key="source_indexes",
            start_line=start_line,
            end_line=end_line,
            label=f"{prefix}的未解线索",
            issues=issues,
        )
    return issues


def _arc_checkpoint_path(workspace: Path, input_hash: str) -> Path:
    return _checkpoint_root(workspace) / "arc-cards" / f"{input_hash}.json"


def _arc_input_hash(
    *,
    cards: list[dict],
    level: int,
    reading_principles: str,
    unit_principles: str,
) -> str:
    return _json_sha256({
        "schema_version": STORY_ARC_SCHEMA_VERSION,
        "level": level,
        "reading_principles": reading_principles,
        "unit_principles": unit_principles,
        "source_cards": cards,
    })


def _load_arc_checkpoint(
    *,
    workspace: Path,
    input_hash: str,
    source_cards: list[dict],
    level: int,
    group_index: int,
) -> dict | None:
    try:
        record = _read_json(_arc_checkpoint_path(workspace, input_hash))
    except NovelAnalysisPipelineError:
        return None
    card = record.get("card")
    if (
        record.get("schema_version") != CHECKPOINT_SCHEMA_VERSION
        or record.get("input_hash") != input_hash
        or not isinstance(card, dict)
        or record.get("card_hash") != _json_sha256(card)
        or validate_story_arc_card(
            card=card,
            source_cards=source_cards,
            expected_level=level,
            expected_group_index=group_index,
        )
    ):
        return None
    return card


def _save_arc_checkpoint(*, workspace: Path, input_hash: str, card: dict) -> None:
    _write_json_atomically(_arc_checkpoint_path(workspace, input_hash), {
        "schema_version": CHECKPOINT_SCHEMA_VERSION,
        "input_hash": input_hash,
        "card_hash": _json_sha256(card),
        "card": card,
    })


def _checkpoint_ready_arc_output(
    *,
    output_path: Path,
    source_cards: list[dict],
    level: int,
    group_index: int,
    workspace: Path,
    input_hash: str,
) -> bool:
    try:
        semantics = _read_json(output_path)
        card, issues = materialize_story_arc_card(
            cards=source_cards,
            level=level,
            group_index=group_index,
            semantics=semantics,
        )
    except NovelAnalysisPipelineError:
        return False
    if issues or validate_story_arc_card(
        card=card,
        source_cards=source_cards,
        expected_level=level,
        expected_group_index=group_index,
    ):
        return False
    _write_json_atomically(output_path, card)
    _save_arc_checkpoint(workspace=workspace, input_hash=input_hash, card=card)
    return True


def _finalize_arc_output(
    *,
    source_cards: list[dict],
    level: int,
    group_index: int,
    output_path: Path,
    label: str,
    reading_principles: str,
    unit_principles: str,
    run_model: Callable[[str, str, Path], None],
) -> tuple[dict | None, list[str]]:
    issues: list[str] = []
    for attempt in range(MAX_SEMANTIC_REPAIR_ATTEMPTS + 1):
        semantics: dict | None = None
        try:
            semantics = _read_json(output_path)
            card, issues = materialize_story_arc_card(
                cards=source_cards,
                level=level,
                group_index=group_index,
                semantics=semantics,
            )
        except NovelAnalysisPipelineError as exc:
            card = None
            issues = [str(exc)]
        if card is not None:
            issues = [
                *issues,
                *validate_story_arc_card(
                    card=card,
                    source_cards=source_cards,
                    expected_level=level,
                    expected_group_index=group_index,
                ),
            ]
        if not issues:
            return card, []
        if attempt >= MAX_SEMANTIC_REPAIR_ATTEMPTS:
            break
        run_model(
            story_arc_semantics_prompt(
                cards=source_cards,
                level=level,
                group_index=group_index,
                reading_principles=reading_principles,
                unit_principles=unit_principles,
                prior_issues=issues[:12],
                prior_semantics=semantics,
            ),
            _repair_label(label, attempt=attempt + 1),
            output_path,
        )
    return None, issues


def _source_title(project: dict) -> str:
    source_script = project.get("source_script") if isinstance(project.get("source_script"), dict) else {}
    return _as_text(
        source_script.get("display_name")
        or source_script.get("original_name")
        or project.get("project_name")
    )


def final_analysis_semantics_prompt(
    *,
    cards: list[dict],
    reading_principles: str,
    unit_principles: str,
    project: dict,
    adaptation_plan: dict,
    preferences: list[str],
    prior_issues: list[str] | None = None,
    prior_semantics: object | None = None,
) -> str:
    requirements = [
        _as_text(project.get("extra_requirements")),
        *(_as_text(item) for item in preferences),
    ]
    requirement_lines = [f"- 小说名称：{_source_title(project)}"] if _source_title(project) else []
    requirement_lines.extend(f"- {item}" for item in requirements if item)
    requirements_text = "\n".join(requirement_lines) or "- 无额外要求"
    repair_text = _repair_context(
        prior_issues=prior_issues,
        prior_semantics=prior_semantics,
    )
    return f"""请依据覆盖全书的剧情弧摘要卡，形成小说改编前的小说解读。先还原原著真实的剧情单元，再向上归纳人物、主线、卖点、世界观和基础信息。

全文解读原则：
{reading_principles.strip()}

剧情单元原则：
{unit_principles.strip()}

项目要求：
{requirements_text}

后续短剧容量：
{json.dumps(adaptation_plan, ensure_ascii=False)}

要求：
1. 剧情单元遵从原著因果与真实节奏。改编建议只供用户决策，不能因建议删除或合并而漏掉原著单元。
2. `characters` 只列全书主要角色，通常为 4 至 7 人，最多 8 人；不因局部出场、传话或单元功能而收录。每人须持续改变主线，并满足以下至少两项：跨 3 个及以上剧情单元发挥作用；作出改变关键因果或核心关系的独立选择；其关系走向或结局是需要兑现的观众问题。承载全书核心伏笔或世界观秘密是强加分项，不是必备条件。决定主线终局的对手或秘密核心人物可作为少量例外。单元 `key_characters` 可包含未列入 `characters` 的局部角色。
3. 高光只记录名称和准确原文索引。关键信息保留会改变人物选择或观众预期的秘密、证据、身份与认知差。
4. 建议删除时写明仍需快速带过的结果；建议合并时用 `merge_target_order` 指向一个建议保留的单元序号。其他建议不填该字段。所有合并等待用户确认。
5. 服务会填充小说名称、固定字段、单元 ID、合并目标 ID 与确认状态。只输出下方语义 JSON，不输出 Markdown、固定 ID 或确认字段。

只输出此 JSON：
{{
  "basic_info": {{"synopsis": "", "genres": [""], "tone": ""}},
  "core_hook": "",
  "main_storyline": "",
  "world": "",
  "characters": [{{"name": "", "profile": ""}}],
  "units": [
    {{
      "name": "",
      "summary": "",
      "mainline_advance": "",
      "key_characters": [{{"name": "", "role_and_change": ""}}],
      "key_information": [""],
      "highlights": [{{"name": "", "source_index": "L起始行-L结束行"}}],
      "recommendation": "保留/删除/合并",
      "merge_target_order": 0,
      "recommendation_reason": ""
    }}
  ]
}}
{repair_text}

剧情弧摘要卡：
{json.dumps(cards, ensure_ascii=False)}
""".strip()


# Keep the historic helper name for callers that only need the prompt.
def final_analysis_prompt(**kwargs: object) -> str:
    return final_analysis_semantics_prompt(**kwargs)  # type: ignore[arg-type]


def _materialize_string_list(value: object, *, label: str, issues: list[str]) -> list[str]:
    if isinstance(value, str):
        raw_values = re.split(r"[、，,；;]", value)
    elif isinstance(value, list):
        raw_values = value
    else:
        _issue(issues, f"{label}必须是数组")
        return []
    values = [_as_text(item) for item in raw_values]
    values = list(dict.fromkeys(value for value in values if value))
    if not values:
        _issue(issues, f"{label}至少需要一项")
    return values


def _coerce_unit_order(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def materialize_final_analysis(
    *,
    semantics: object,
    project: dict,
    total_lines: int,
) -> tuple[dict, list[str]]:
    """Build the user-facing JSON from only model-authored semantic fields."""
    issues: list[str] = []
    payload = _as_mapping(semantics)
    if not payload:
        return {}, ["最终小说解读没有返回语义内容"]
    basic = _as_mapping(payload.get("basic_info"))
    synopsis = _as_text(basic.get("synopsis"))
    tone = _as_text(basic.get("tone"))
    if not synopsis:
        _issue(issues, "小说梗概不能为空")
    if not tone:
        _issue(issues, "基调不能为空")
    genres = _materialize_string_list(basic.get("genres"), label="题材", issues=issues)
    title = _source_title(project) or _as_text(basic.get("novel_title"))
    if not title:
        _issue(issues, "小说名称不能为空")
    core_hook = _as_text(payload.get("core_hook"))
    main_storyline = _as_text(payload.get("main_storyline"))
    world = _as_text(payload.get("world"))
    for value, label in ((core_hook, "核心卖点"), (main_storyline, "故事主线"), (world, "世界观")):
        if not value:
            _issue(issues, f"{label}不能为空")

    raw_characters = payload.get("characters")
    characters: list[dict] = []
    character_names: set[str] = set()
    if not isinstance(raw_characters, list) or not raw_characters:
        _issue(issues, "关键人物至少需要一人")
    else:
        if len(raw_characters) > MAX_PRIMARY_CHARACTERS:
            _issue(issues, f"关键人物最多 {MAX_PRIMARY_CHARACTERS} 人")
        for order, raw_character in enumerate(raw_characters, start=1):
            character = _as_mapping(raw_character)
            name = _as_text(character.get("name"))
            profile = _as_text(character.get("profile"))
            if not name or not profile:
                _issue(issues, f"关键人物第 {order} 项内容不完整")
                continue
            if name in character_names:
                _issue(issues, f"关键人物名称重复：{name}")
                continue
            character_names.add(name)
            characters.append({"人物名称": name, "人物画像": profile})

    raw_units = payload.get("units")
    units: list[dict] = []
    pending_merge_orders: list[int | None] = []
    if not isinstance(raw_units, list) or not raw_units:
        _issue(issues, "剧情单元至少需要一个单元")
    else:
        for order, raw_unit in enumerate(raw_units, start=1):
            unit = _as_mapping(raw_unit)
            label = f"剧情单元第 {order} 项"
            name = _as_text(unit.get("name"))
            summary = _as_text(unit.get("summary"))
            mainline_advance = _as_text(unit.get("mainline_advance"))
            recommendation = _as_text(unit.get("recommendation"))
            recommendation_reason = _as_text(unit.get("recommendation_reason"))
            if not name or not summary or not mainline_advance or not recommendation_reason:
                _issue(issues, f"{label}内容不完整")
            if recommendation not in {"保留", "删除", "合并"}:
                _issue(issues, f"{label}改编建议无效")
            roles = _materialize_text_pairs(
                unit.get("key_characters"),
                keys=("name", "role_and_change"),
                label=f"{label}的关键人物",
                issues=issues,
            )
            if not roles:
                _issue(issues, f"{label}至少需要一名关键人物")
            information = _materialize_string_list(
                unit.get("key_information"),
                label=f"{label}的关键信息",
                issues=issues,
            )
            highlights = _materialize_highlights(
                unit.get("highlights"),
                start_line=1,
                end_line=total_lines,
                label=f"{label}的高光时刻",
                issues=issues,
            )
            if not highlights:
                _issue(issues, f"{label}至少需要一个高光时刻")
            units.append({
                "单元ID": f"unit-{order:03d}",
                "单元名称": name,
                "单元梗概": summary,
                "主线推进": mainline_advance,
                "关键人物": [
                    {"人物名称": role["name"], "单元作用与变化": role["role_and_change"]}
                    for role in roles
                ],
                "关键信息": information,
                "高光时刻": [
                    {"名称": item["name"], "原文索引": item["source_index"]}
                    for item in highlights
                ],
                "改编建议": recommendation,
                "合并目标单元ID": "",
                "已确认合并": False,
                "建议原因": recommendation_reason,
            })
            pending_merge_orders.append(_coerce_unit_order(unit.get("merge_target_order")))

    for order, (unit, target_order) in enumerate(zip(units, pending_merge_orders), start=1):
        recommendation = unit["改编建议"]
        if recommendation != "合并":
            if target_order not in {None, 0}:
                _issue(issues, f"剧情单元第 {order} 项不是建议合并时不能指定合并目标")
            continue
        if target_order is None or target_order < 1 or target_order > len(units):
            _issue(issues, f"剧情单元第 {order} 项建议合并时必须指定有效目标单元序号")
            continue
        target = units[target_order - 1]
        if target_order == order:
            _issue(issues, f"剧情单元第 {order} 项不能合并到自身")
            continue
        if target["改编建议"] != "保留":
            _issue(issues, f"剧情单元第 {order} 项只能并入建议保留的单元")
            continue
        unit["合并目标单元ID"] = target["单元ID"]

    analysis = {
        "基础信息": {"小说名称": title, "小说梗概": synopsis, "题材": genres, "基调": tone},
        "核心卖点": core_hook,
        "故事主线": main_storyline,
        "世界观": world,
        "关键人物": characters,
        "剧情单元": units,
    }
    return analysis, issues


def _cards_need_reduction(cards: list[dict]) -> bool:
    return len(cards) > MAX_FINAL_CARDS or len(json.dumps(cards, ensure_ascii=False)) > MAX_FINAL_INPUT_CHARS


def _prepare_story_arc_cards(
    *,
    workspace: Path,
    work_root: Path,
    cards: list[dict],
    reading_principles: str,
    unit_principles: str,
    run_model: Callable[[str, str, Path], None],
    run_model_batch: Callable[[list[dict]], object] | None,
    notify: Callable[[str, str, dict | None], None],
) -> tuple[list[dict], int]:
    level = 0
    current_cards = cards
    while _cards_need_reduction(current_cards):
        level += 1
        if level > MAX_STORY_ARC_LEVELS:
            raise NovelAnalysisPipelineError("小说剧情弧关联超过安全层级")
        groups = group_story_cards(current_cards)
        if len(groups) >= len(current_cards):
            raise NovelAnalysisPipelineError("小说事实卡无法在安全范围内形成剧情弧")
        level_root = work_root / f"arc-level-{level}"
        level_root.mkdir(parents=True, exist_ok=True)
        reduced: dict[int, dict] = {}
        pending: list[dict] = []
        for group_index, group in enumerate(groups, start=1):
            input_hash = _arc_input_hash(
                cards=group,
                level=level,
                reading_principles=reading_principles,
                unit_principles=unit_principles,
            )
            checkpoint = _load_arc_checkpoint(
                workspace=workspace,
                input_hash=input_hash,
                source_cards=group,
                level=level,
                group_index=group_index,
            )
            if checkpoint is not None:
                reduced[group_index] = checkpoint
                continue
            output_path = level_root / f"group-{group_index:03d}.json"
            pending.append({
                "prompt": story_arc_semantics_prompt(
                    cards=group,
                    level=level,
                    group_index=group_index,
                    reading_principles=reading_principles,
                    unit_principles=unit_principles,
                ),
                "label": f"novel-arc-{level}-{group_index:03d}",
                "output_file": output_path,
                "order": group_index,
                "group_index": group_index,
                "source_cards": group,
                "input_hash": input_hash,
            })
        if pending:
            try:
                if run_model_batch is not None and len(pending) > 1:
                    run_model_batch(pending)
                else:
                    for request in pending:
                        run_model(request["prompt"], request["label"], request["output_file"])
            except Exception:
                for request in pending:
                    _checkpoint_ready_arc_output(
                        output_path=request["output_file"],
                        source_cards=request["source_cards"],
                        level=level,
                        group_index=request["group_index"],
                        workspace=workspace,
                        input_hash=request["input_hash"],
                    )
                raise

            failures: list[tuple[dict, list[str]]] = []
            for request in pending:
                card, issues = _finalize_arc_output(
                    source_cards=request["source_cards"],
                    level=level,
                    group_index=request["group_index"],
                    output_path=request["output_file"],
                    label=request["label"],
                    reading_principles=reading_principles,
                    unit_principles=unit_principles,
                    run_model=run_model,
                )
                if card is None or issues:
                    failures.append((request, issues))
                    continue
                _write_json_atomically(request["output_file"], card)
                _save_arc_checkpoint(workspace=workspace, input_hash=request["input_hash"], card=card)
                reduced[request["group_index"]] = card
            if failures:
                first_request, first_issues = failures[0]
                raise NovelAnalysisPipelineError(
                    f"第 {level} 轮第 {first_request['group_index']} 组剧情弧暂未形成："
                    f"{'；'.join(first_issues[:4])}"
                )
        current_cards = [reduced[index] for index in range(1, len(groups) + 1)]
        notify(
            "novel_arc_progress",
            f"正在提炼全书剧情弧，已完成第 {level} 轮。",
            {"level": level, "card_count": len(current_cards)},
        )
    return current_cards, level


def _generate_final_analysis(
    *,
    workspace: Path,
    work_root: Path,
    cards: list[dict],
    source_index: dict,
    reading_principles: str,
    unit_principles: str,
    project: dict,
    adaptation_plan: dict,
    preferences: list[str],
    run_model: Callable[[str, str, Path], None],
    validate_final: Callable[[Path], list[str]],
) -> None:
    output_path = workspace / "2.1-novel-analysis.json"
    semantics_path = work_root / "final-analysis-semantics.json"
    prior_issues: list[str] | None = None
    prior_semantics: dict | None = None
    attempts = MAX_SEMANTIC_REPAIR_ATTEMPTS + 2
    for attempt in range(attempts):
        label = "novel-analysis-synthesis" if attempt == 0 else "novel-analysis-synthesis-repair"
        run_model(
            final_analysis_semantics_prompt(
                cards=cards,
                reading_principles=reading_principles,
                unit_principles=unit_principles,
                project=project,
                adaptation_plan=adaptation_plan,
                preferences=preferences,
                prior_issues=prior_issues,
                prior_semantics=prior_semantics,
            ),
            label,
            semantics_path,
        )
        try:
            semantics = _read_json(semantics_path)
            prior_semantics = semantics
            analysis, issues = materialize_final_analysis(
                semantics=semantics,
                project=project,
                total_lines=int(source_index["total_lines"]),
            )
        except NovelAnalysisPipelineError as exc:
            analysis = {}
            issues = [str(exc)]
        if issues:
            prior_issues = issues[:12]
            continue
        _write_json_atomically(output_path, analysis)
        validation_issues = validate_final(output_path)
        if not validation_issues:
            return
        prior_issues = validation_issues[:12]
    raise NovelAnalysisPipelineError(
        f"小说解读草稿未通过结构检查：{'；'.join((prior_issues or ['未知问题'])[:8])}"
    )


def prepare_novel_analysis_draft(
    *,
    workspace: Path,
    skill_root: Path,
    job_id: int,
    prepared: dict,
    project: dict,
    preferences: list[str],
    run_model: Callable[[str, str, Path], None],
    validate_final: Callable[[Path], list[str]],
    run_model_batch: Callable[[list[dict]], object] | None = None,
    notify: Callable[[str, str, dict | None], None] | None = None,
) -> dict:
    notify = notify or (lambda _event, _message, _details=None: None)
    source_index = prepared.get("source_index")
    adaptation_plan = prepared.get("adaptation_plan")
    if not isinstance(source_index, dict) or not isinstance(adaptation_plan, dict):
        raise NovelAnalysisPipelineError("小说解读初始化结果不完整")
    try:
        reading_principles = (skill_root / "references" / "小说全文解读原则.md").read_text(encoding="utf-8")
        unit_principles = (skill_root / "references" / "剧情单元提炼原则.md").read_text(encoding="utf-8")
    except OSError as exc:
        raise NovelAnalysisPipelineError("小说解读原则不可用") from exc

    blocks = build_source_blocks(workspace, source_index)
    fingerprint = _checkpoint_fingerprint(
        workspace=workspace,
        source_index=source_index,
        reading_principles=reading_principles,
        unit_principles=unit_principles,
    )
    checkpoint_state = _load_checkpoint_state(workspace, fingerprint)
    work_root = workspace / "runtime" / "jobs" / str(job_id) / "novel-analysis"
    leaf_root = work_root / "leaf-semantics"
    leaf_root.mkdir(parents=True, exist_ok=True)
    ledgers_by_block: dict[str, dict] = {}
    pending_blocks: list[dict] = []
    reused_blocks = 0
    for block in blocks:
        ledger = _load_checkpoint_ledger(workspace=workspace, state=checkpoint_state, block=block)
        if ledger is None:
            pending_blocks.append(block)
            continue
        ledgers_by_block[block["id"]] = ledger
        reused_blocks += 1
        notify(
            "novel_reading_checkpoint",
            f"已复用第 {block['order']}/{len(blocks)} 部分的已核对内容。",
            {"completed": reused_blocks, "total": len(blocks)},
        )

    notify(
        "novel_reading_plan",
        f"正在完整阅读小说，共 {len(blocks)} 部分。",
        {
            "status": "reading",
            "completed": reused_blocks,
            "total": len(blocks),
            "parallel_reading": bool(run_model_batch and len(pending_blocks) > 1),
        },
    )
    requests = [{
        "prompt": leaf_semantics_prompt(block=block, reading_principles=reading_principles),
        "label": f"novel-read-{block['order']:03d}",
        "output_file": leaf_root / f"{block['id']}.json",
        "order": block["order"],
    } for block in pending_blocks]
    if requests:
        try:
            if run_model_batch is not None and len(requests) > 1:
                run_model_batch(requests)
            else:
                for request in requests:
                    run_model(request["prompt"], request["label"], request["output_file"])
        except Exception:
            for block, request in zip(pending_blocks, requests):
                _checkpoint_ready_leaf_output(
                    output_path=request["output_file"],
                    block=block,
                    workspace=workspace,
                    checkpoint_state=checkpoint_state,
                )
            raise

        failures: list[tuple[dict, list[str]]] = []
        for block, request in zip(pending_blocks, requests):
            ledger, issues = _finalize_leaf_output(
                block=block,
                output_path=request["output_file"],
                label=request["label"],
                reading_principles=reading_principles,
                run_model=run_model,
            )
            if ledger is None or issues:
                failures.append((block, issues))
                continue
            _write_json_atomically(request["output_file"], ledger)
            _save_checkpoint_ledger(
                workspace=workspace,
                state=checkpoint_state,
                block=block,
                ledger=ledger,
            )
            ledgers_by_block[block["id"]] = ledger
            notify(
                "novel_reading_progress",
                f"小说内容已核对 {len(ledgers_by_block)}/{len(blocks)}。",
                {"status": "reading", "completed": len(ledgers_by_block), "total": len(blocks)},
            )
        if failures:
            first_block, first_issues = failures[0]
            completed = len(ledgers_by_block)
            notify(
                "novel_reading_failed",
                f"有 {len(failures)} 个部分暂未核对完成，已保存 {completed} 个可复用部分。",
                {
                    "status": "failed",
                    "completed": completed,
                    "current": first_block["order"],
                    "total": len(blocks),
                    "issues": first_issues[:12],
                },
            )
            raise NovelAnalysisPipelineError(
                f"第 {first_block['order']}/{len(blocks)} 部分暂未核对完成："
                f"{'；'.join(first_issues[:4])}；已保存 {completed} 个可复用部分。"
            )

    cards = [ledgers_by_block[block["id"]] for block in blocks]
    cards, story_arc_levels = _prepare_story_arc_cards(
        workspace=workspace,
        work_root=work_root,
        cards=cards,
        reading_principles=reading_principles,
        unit_principles=unit_principles,
        run_model=run_model,
        run_model_batch=run_model_batch,
        notify=notify,
    )
    notify(
        "novel_analysis_synthesis",
        "小说内容已核对完成，正在形成小说解读。",
        {"status": "synthesizing", "block_count": len(blocks), "reused_blocks": reused_blocks},
    )
    _generate_final_analysis(
        workspace=workspace,
        work_root=work_root,
        cards=cards,
        source_index=source_index,
        reading_principles=reading_principles,
        unit_principles=unit_principles,
        project=project,
        adaptation_plan=adaptation_plan,
        preferences=preferences,
        run_model=run_model,
        validate_final=validate_final,
    )
    notify(
        "novel_analysis_prepared",
        "小说全文已阅读完成，正在核对最终解读。",
        {
            "block_count": len(blocks),
            "story_arc_levels": story_arc_levels,
            "reused_blocks": reused_blocks,
        },
    )
    return {
        **prepared,
        "next_action": "小说全文已阅读完成，解读草稿已生成。请核对原著因果、人物变化、剧情单元和改编建议，然后执行检查。",
        "novel_reading": {
            "status": "completed",
            "block_count": len(blocks),
            "story_arc_levels": story_arc_levels,
            "reduction_levels": story_arc_levels,
            "reused_blocks": reused_blocks,
        },
    }
