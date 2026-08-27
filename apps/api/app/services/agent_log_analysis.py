from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable


INFRA_RESULT_RE = re.compile(
    r"(?:API Error:\s*429|model[_\s-]?cooldown|cooling down|concurrent[_\s-]?sessions|"
    r"并发\s*Session\s*超限|Session ID .* already in use|child_session_capacity|"
    r"context[_\s-]?limit|context window|上下文长度超过|timeout|超时)",
    re.IGNORECASE,
)
QUALITY_RESULT_RE = re.compile(
    r"(?:quality[_\s-]?gate|(?:dialogue|narrative|quality)[_\s-]?review[_\s-]?no[_\s-]?progress|"
    r"retry_exhausted|needs_revision|CREATIVE_BODY_|质量检查|未通过|人工复核|停止重复修复)",
    re.IGNORECASE,
)
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
SKIPPED_REPEAT_TOOLS = {"TodoWrite"}
CONTENT_KEYS = {"content", "new_string", "old_string", "cell_source"}
NON_SEMANTIC_ARGUMENT_KEYS = {"description", "timeout", "run_in_background"}


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:20]


def _text_content(value: object) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    parts = []
    for item in value:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            parts.append(str(item.get("text") or item.get("content") or json.dumps(item, ensure_ascii=False)))
    return "\n".join(parts)


def _normalize_path(value: object, roots: Iterable[Path]) -> str:
    text = str(value or "").replace("\\", "/")
    for root in roots:
        root_text = str(root.resolve()).replace("\\", "/").rstrip("/")
        if root_text:
            text = text.replace(root_text, "<repo>" if root_text.endswith("Agents") is False else "<agents>")
    text = re.sub(r"(?:<repo>/Agents|<agents>)?/workspaces/[^/\s\"']+", "<workspace>", text)
    text = re.sub(r"/[^\s\"']+/workspaces/[^/\s\"']+", "<workspace>", text)
    return text


def _normalize_command(value: object, roots: Iterable[Path]) -> str:
    text = _normalize_path(value, roots)
    text = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{20,}\b", "<id>", text, flags=re.IGNORECASE)
    text = re.sub(r"(--job-id(?:=|\s+))[\"']?\d+[\"']?", r"\1<job_id>", text)
    text = re.sub(r"(--session-id(?:=|\s+))[\"']?[^\s\"']+[\"']?", r"\1<session_id>", text)
    return re.sub(r"\s+", " ", text).strip()


def _normalized_value(key: str, value: object, roots: Iterable[Path]) -> object:
    if key in CONTENT_KEYS and isinstance(value, str):
        return {"sha256": _digest(value), "chars": len(value)}
    if isinstance(value, dict):
        return {
            name: _normalized_value(name, child, roots)
            for name, child in sorted(value.items())
            if name not in NON_SEMANTIC_ARGUMENT_KEYS
        }
    if isinstance(value, list):
        return [_normalized_value(key, child, roots) for child in value]
    if isinstance(value, str):
        if key in {"command", "cmd"}:
            return _normalize_command(value, roots)
        if key in {"file_path", "path", "notebook_path", "cwd"} or "/" in value or "\\" in value:
            return _normalize_path(value, roots)
        if key in {"job_id", "session_id"}:
            return f"<{key}>"
    return value


def _normalized_arguments(tool_name: str, tool_input: dict, roots: Iterable[Path]) -> str:
    normalized = _normalized_value("", tool_input, roots)
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))[:2000]


def _episode_range(value: str) -> str | None:
    range_match = re.search(r"--range(?:=|\s+)[\"']?(\d+)\s*[-:]\s*(\d+)", value)
    if not range_match:
        range_match = re.search(r"(?:full-batches/)?0*(\d+)-0*(\d+)\.md\b", value)
    if not range_match:
        return None
    start, end = int(range_match.group(1)), int(range_match.group(2))
    return f"episode_range:{start}-{end}"


def _operation_name(tool_name: str, tool_input: dict) -> str:
    command = str(tool_input.get("command") or tool_input.get("cmd") or "")
    if tool_name in {"Bash", "Shell"}:
        draft = re.search(r"full-draft-tool\.mjs[\"']?\s+(init|status|validate|audit|assemble)\b", command)
        if draft:
            return f"full_draft.{draft.group(1)}"
        memory = re.search(r"memory-tool\.mjs[\"']?\s+(\w[\w-]*)\b", command)
        if memory:
            return f"memory.{memory.group(1)}"
        initialize = re.search(r"init-([\w-]+)\.mjs", command)
        if initialize:
            return f"stage_init.{initialize.group(1)}"
        validate = re.search(r"validate-([\w-]+)\.mjs", command)
        if validate:
            return f"stage_validate.{validate.group(1)}"
        # Historical jobs retain their original command names in ZDebug logs.
        prepare = re.search(r"prepare-([\w-]+)\.mjs", command)
        if prepare:
            return f"stage_prepare.{prepare.group(1)}"
        finalize = re.search(r"finalize-([\w-]+)\.mjs", command)
        if finalize:
            return f"stage_finalize.{finalize.group(1)}"
        npm = re.search(r"\bnpm\s+run\s+([\w:-]+)", command)
        if npm:
            return f"npm.{npm.group(1)}"
    return tool_name.lower()


def _operation_target(tool_name: str, tool_input: dict, roots: Iterable[Path]) -> str:
    command = str(tool_input.get("command") or tool_input.get("cmd") or "")
    range_target = _episode_range(command)
    if range_target:
        return range_target
    file_value = (
        tool_input.get("file_path")
        or tool_input.get("notebook_path")
        or tool_input.get("path")
        or ""
    )
    normalized_file = _normalize_path(file_value, roots)
    range_target = _episode_range(normalized_file)
    if range_target:
        return range_target
    if normalized_file:
        return normalized_file
    if "full-draft-tool.mjs" in command and "assemble" in command:
        return "artifact:99-剧本稿.md"
    return _normalize_command(command, roots)[:500] or "<none>"


def _is_observed_write(tool_name: str, tool_input: dict) -> bool:
    if tool_name in WRITE_TOOLS:
        return True
    if tool_name not in {"Bash", "Shell"}:
        return False
    command = str(tool_input.get("command") or tool_input.get("cmd") or "")
    if re.search(r"full-draft-tool\.mjs[\"']?\s+(?:init|status|validate|audit|assemble)\b", command):
        return False
    return bool(re.search(
        r"(?:write_text|writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|"
        r"\b(?:sed|perl)\s+[^\n]*-i\b|(?:^|\s)(?:>|>>|\|\s*tee(?:\s+-a)?)\s*)",
        command,
        re.IGNORECASE,
    ))


def _result_code(content: str, explicit_error: bool) -> str:
    if INFRA_RESULT_RE.search(content):
        return "INFRA_ERROR"
    if QUALITY_RESULT_RE.search(content):
        return "QUALITY_GATE"
    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        status = str(payload.get("status") or "").lower()
        if status in {"failed", "needs_revision", "review_required", "retry_exhausted"} and (
            "report" in payload or "quality_report" in payload or "batch" in payload
        ):
            return "QUALITY_GATE"
    if not explicit_error:
        return "OK"
    if re.search(r"File has not been read yet", content, re.IGNORECASE):
        return "EDIT_BEFORE_READ"
    if re.search(r"String to replace not found|old_string.*not found", content, re.IGNORECASE):
        return "EDIT_MATCH_MISSING"
    if re.search(r"No such file|File does not exist|ENOENT", content, re.IGNORECASE):
        return "MISSING_FILE"
    return "TOOL_ERROR"


def _iter_tool_uses(payload: dict) -> list[dict]:
    if payload.get("type") != "assistant":
        return []
    content = (payload.get("message") or {}).get("content") or []
    return [
        item for item in content
        if isinstance(item, dict) and item.get("type") == "tool_use" and item.get("name")
    ]


def _iter_tool_results(payload: dict) -> list[dict]:
    if payload.get("type") != "user":
        return []
    content = (payload.get("message") or {}).get("content") or []
    return [
        item for item in content
        if isinstance(item, dict) and item.get("type") == "tool_result" and item.get("tool_use_id")
    ]


def _analyze_log(path: Path, job_id: int, roots: Iterable[Path]) -> tuple[list[dict], int]:
    calls: list[dict] = []
    calls_by_id: dict[str, dict] = {}
    target_writes: dict[str, list[str]] = defaultdict(list)
    line_number = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line_number += 1
            try:
                payload = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            for item in _iter_tool_uses(payload):
                name = str(item["name"])
                tool_input = item.get("input") if isinstance(item.get("input"), dict) else {}
                arguments = _normalized_arguments(name, tool_input, roots)
                target = _operation_target(name, tool_input, roots)
                observed_writes = list(target_writes.get(target, []))
                observed_state = "\n".join(observed_writes) or "unobserved"
                call = {
                    "id": str(item.get("id") or f"line-{line_number}-{len(calls)}"),
                    "job_id": job_id,
                    "call_line": line_number,
                    "result_line": None,
                    "tool": name,
                    "operation": _operation_name(name, tool_input),
                    "target": target,
                    "normalized_arguments": arguments,
                    "arguments_hash": _digest(arguments),
                    "input_content_hash": _digest(f"{arguments}\n{observed_state}"),
                    "input_hash_source": "normalized_arguments+observed_target_writes",
                    "observed_write_hashes": observed_writes,
                    "observed_write": _is_observed_write(name, tool_input),
                    "result_code": "MISSING_RESULT",
                    "result_hash": None,
                }
                calls.append(call)
                calls_by_id[call["id"]] = call
            for item in _iter_tool_results(payload):
                call = calls_by_id.get(str(item["tool_use_id"]))
                if not call:
                    continue
                content = _text_content(item.get("content"))
                call["result_line"] = line_number
                call["result_code"] = _result_code(content, item.get("is_error") is True)
                call["result_hash"] = _digest(content)
                if call["observed_write"] and call["result_code"] == "OK":
                    target_writes[call["target"]].append(
                        _digest(f"{call['arguments_hash']}\n{call['result_hash']}")
                    )
    return calls, line_number


def _repeat_class(previous: dict, current: dict) -> str:
    if previous["result_code"] == "INFRA_ERROR":
        return "infra_retry"
    if previous["input_content_hash"] != current["input_content_hash"]:
        return "repair_retry"
    if previous["result_code"] == current["result_code"] == "OK":
        return "cached_repeat"
    return "blind_retry"


def scan_semantic_operations(
    jobs: list[sqlite3.Row], *, repo_root: Path, agents_dir: Path
) -> tuple[dict, list[dict]]:
    roots = (repo_root, agents_dir)
    tool_counts: Counter[str] = Counter()
    classification_counts: Counter[str] = Counter()
    scanned_bytes = 0
    scanned_logs = 0
    raw_refs = []
    repeat_events = []
    fan_out_events = []

    for job in jobs:
        raw_path = job["raw_log_path"] if "raw_log_path" in job.keys() else None
        if not raw_path:
            continue
        path = Path(raw_path)
        if not path.is_file():
            continue
        job_id = int(job["id"])
        calls, line_count = _analyze_log(path, job_id, roots)
        scanned_logs += 1
        scanned_bytes += path.stat().st_size
        raw_refs.append({
            "ref": f"raw_log:{job_id}",
            "job_ref": f"job:{job_id}",
            "tool_calls": len(calls),
            "line_count": line_count,
        })
        tool_counts.update(call["tool"] for call in calls)

        previous_by_signature: dict[tuple[str, str, str], dict] = {}
        for call in calls:
            if call["tool"] in SKIPPED_REPEAT_TOOLS:
                continue
            signature = (call["operation"], call["target"], call["arguments_hash"])
            previous = previous_by_signature.get(signature)
            if previous:
                classification = _repeat_class(previous, call)
                previous_writes = previous["observed_write_hashes"]
                current_writes = call["observed_write_hashes"]
                intervening_writes = (
                    current_writes[len(previous_writes):]
                    if current_writes[:len(previous_writes)] == previous_writes
                    else current_writes
                )
                classification_counts[classification] += 1
                repeat_events.append({
                    "classification": classification,
                    "operation": call["operation"],
                    "tool": call["tool"],
                    "target": call["target"],
                    "normalized_arguments": call["normalized_arguments"],
                    "input_content_hash": call["input_content_hash"],
                    "result_code": call["result_code"],
                    "result_hash": call["result_hash"],
                    "intervening_write_hashes": intervening_writes,
                    "previous_call_line": previous["call_line"],
                    "call_line": call["call_line"],
                    "result_line": call["result_line"],
                    "evidence_refs": [f"raw_log:{job_id}", f"job:{job_id}"],
                })
            previous_by_signature[signature] = call

        by_operation: dict[str, list[dict]] = defaultdict(list)
        for call in calls:
            if call["tool"] not in SKIPPED_REPEAT_TOOLS:
                by_operation[call["operation"]].append(call)
        for operation, operation_calls in by_operation.items():
            targets = sorted({call["target"] for call in operation_calls})
            if len(targets) < 3 or not all(target.startswith("episode_range:") for target in targets):
                continue
            classification_counts["fan_out"] += 1
            fan_out_events.append({
                "classification": "fan_out",
                "operation": operation,
                "call_count": len(operation_calls),
                "distinct_target_count": len(targets),
                "targets": targets[:30],
                "call_lines": [call["call_line"] for call in operation_calls[:50]],
                "evidence_refs": [f"raw_log:{job_id}", f"job:{job_id}"],
            })

    compacted: dict[tuple[str, str, str], dict] = {}
    for item in repeat_events:
        key = (item["classification"], item["operation"], item["target"])
        pattern = compacted.get(key)
        occurrence = {
            "previous_call_line": item["previous_call_line"],
            "call_line": item["call_line"],
            "result_line": item["result_line"],
            "input_content_hash": item["input_content_hash"],
            "result_code": item["result_code"],
            "result_hash": item["result_hash"],
            "intervening_write_hashes": item["intervening_write_hashes"],
            "evidence_refs": item["evidence_refs"],
        }
        if not pattern:
            pattern = {
                "classification": item["classification"],
                "operation": item["operation"],
                "tool": item["tool"],
                "target": item["target"],
                "normalized_arguments": item["normalized_arguments"],
                "count": 0,
                "occurrences": [],
                "evidence_refs": [],
            }
            compacted[key] = pattern
        pattern["count"] += 1
        if len(pattern["occurrences"]) < 20:
            pattern["occurrences"].append(occurrence)
        for evidence_ref in item["evidence_refs"]:
            if evidence_ref not in pattern["evidence_refs"]:
                pattern["evidence_refs"].append(evidence_ref)

    repeated = sorted(
        [*compacted.values(), *fan_out_events],
        key=lambda item: (
            {"blind_retry": 0, "infra_retry": 1, "cached_repeat": 2, "repair_retry": 3, "fan_out": 4}.get(
                item["classification"], 9
            ),
            item.get("operation", ""),
            -item.get("count", item.get("call_count", 0)),
        ),
    )[:200]
    return {
        "analysis_version": "2.0.0",
        "scanned_log_count": scanned_logs,
        "scanned_bytes": scanned_bytes,
        "tool_counts": dict(tool_counts.most_common(50)),
        "classification_counts": dict(classification_counts),
        "raw_logs": raw_refs,
    }, repeated
