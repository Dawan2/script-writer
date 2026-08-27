from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import tempfile
import threading
import unicodedata
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from fastapi import HTTPException, UploadFile, status

from app.core.config import settings
from app.db.session import get_connection
from app.services.direct_skill_runner import (
    call_direct_model,
    direct_skill_system_prompt,
    extract_json_object,
)
from app.services.audit_service import record_audit, record_system_audit
from app.services.mechanism_retrieval import attach_retrieval_matches, causal_fingerprint
from app.services.model_config_service import ensure_persisted_model_snapshot, runtime_from_snapshot
from app.services.script_source_normalization import source_terms_found_in_text
from app.services.script_tag_service import (
    CONTROLLED_TAG_VALUES,
    TAG_LABELS,
    TAG_TAXONOMY,
    script_profile_errors,
    tag_taxonomy,
)
from app.services.script_knowledge_service import (
    CREATIVE_STAGES,
    DISTILLATION_VERSION as KNOWLEDGE_DISTILLATION_VERSION,
    FORMULA_CATEGORIES,
    apply_formula_curation,
    apply_principle_curation,
    cards_for_script,
    delete_card,
    distillation_output_schema as knowledge_distillation_output_schema,
    invoke_formula_curation,
    invoke_principle_curation,
    knowledge_stats,
    list_cards,
    save_distillation as save_knowledge_distillation,
    validate_distillation as validate_knowledge_distillation,
)
from app.services.script_distillation_pipeline import MODEL_RETRY_LIMIT, PIPELINE_VERSION, run_distillation_pipeline


MAX_UPLOAD_BYTES = 30 * 1024 * 1024
ALLOWED_SUFFIXES = {".md", ".markdown", ".txt", ".doc", ".docx", ".pdf"}
DISTILLATION_VERSION = PIPELINE_VERSION
MECHANISM_CURATION_VERSION = "mechanism-library-v2"
MECHANISM_ORIGIN = "mechanism-curator"
MECHANISM_ACTIVATION_MIN_SOURCES = 2
KNOWLEDGE_CURATION_LOCK = threading.Lock()
# Backward-compatible alias for maintenance scripts that imported the old name.
MECHANISM_CURATION_LOCK = KNOWLEDGE_CURATION_LOCK
BOOTSTRAP_MIN_MEANINGFUL_CHARS = 1000
DISTILLATION_MAX_OUTPUT_TOKENS = 24000
DISTILLATION_VALIDATION_ATTEMPTS = MODEL_RETRY_LIMIT + 1
DISTILLATION_REQUEST_TIMEOUT_SECONDS = 15 * 60
# Models occasionally put a formula category in the observation's stage
# field. These are the only unambiguous aliases we repair locally, and only
# after normal validation plus a model repair pass have failed.
DISTILLATION_STAGE_ALIASES = {
    "story_engine": "outline_rewrite",
    "world_rule": "world_view",
    "character_relationship": "character_rewrite",
    "long_arc": "outline_rewrite",
    "episode_structure": "trial_generate",
    "hook_information": "trial_generate",
    "audience_payoff": "full_generate",
    "emotional_progression": "character_rewrite",
    "scene_conflict": "trial_generate",
    "dialogue_action": "full_generate",
}
DEFAULT_SHORT_WRITING_SKILL = Path(
    os.getenv(
        "ORCA_SHORT_WRITING_SKILL_DIR",
        "/Users/zhaor/Documents/04-代码/03-Git/Agent项目学习/drama/short-writing-skill",
    )
)
FULL_SCRIPT_KEY = "vsdw-full-script-library::private-obfuscation::2026-06-02::do-not-use-for-strong-secrecy"
TAG_FIELDS = {
    "theme": "theme_tags_json",
    "setting": "setting_tags_json",
    "background": "background_tags_json",
    "audience": "audience_tags_json",
}
MECHANISM_CONTENT_FIELDS = (
    "function", "trigger", "payoff", "transferable_strategy", "failure_boundary",
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _indexed_source_chunks(indexed_source: str) -> list[tuple[str, str, str]]:
    """Return evidence id, locator and text without relying on model output."""
    pattern = re.compile(
        r"<!--\s*(C\d{4,})\s*\|\s*(.*?)\s*-->\s*\n(.*?)(?=<!--\s*C\d{4,}\s*\||\Z)",
        flags=re.S,
    )
    return [
        (match.group(1), re.sub(r"\s+", " ", match.group(2)).strip(), match.group(3).strip())
        for match in pattern.finditer(indexed_source or "")
    ]


def _distillation_source_anchor(indexed_source: str, *, max_chars: int = 12000) -> str:
    """Build a small, deterministic grounding excerpt for repair requests.

    A failed validation must not ask the model to repair a JSON object from
    memory: the previous object may describe a completely different script.
    The complete source is still used for the first request; this excerpt is
    used on repair so long scripts do not make the second request overflow the
    provider context window.
    """
    chunks = _indexed_source_chunks(indexed_source)
    if not chunks:
        return (indexed_source or "")[:max_chars]
    first_id, first_locator, first_text = chunks[0]
    sections = [f"[{first_id} | {first_locator}]\n{first_text[:4200]}"]
    for chunk_id, locator, content in chunks[1:]:
        if sum(len(item) for item in sections) >= max_chars:
            break
        excerpt = content if len(content) <= 360 else f"{content[:220]}……{content[-120:]}"
        sections.append(f"[{chunk_id} | {locator}]\n{excerpt}")
    rendered = "\n\n".join(sections)
    return rendered[:max_chars]


def _source_character_anchors(indexed_source: str) -> list[str]:
    """Find likely named characters from the source's explicit character block."""
    chunks = _indexed_source_chunks(indexed_source)
    if not chunks:
        return []
    first_text = chunks[0][2]
    character_block = first_text
    marker = re.search(r"人物(?:设定|介绍|小传)\s*[：:]?", first_text)
    if marker:
        character_block = first_text[marker.end():]
    names: list[str] = []
    for line in character_block.splitlines():
        match = re.match(r"\s*([\u4e00-\u9fff]{2,8})\s*[：:]", line)
        if not match:
            continue
        name = match.group(1)
        if name in {"人物设定", "人物介绍", "故事梗概", "原创微短剧", "标签", "集数"}:
            continue
        if name not in names:
            names.append(name)
    return names[:8]


def _assert_distillation_grounding(result: dict[str, Any], indexed_source: str) -> None:
    """Reject a valid-looking JSON object that is actually about another play."""
    anchors = _source_character_anchors(indexed_source)
    if not anchors:
        return
    card = result.get("case_card") if isinstance(result, dict) else None
    if not isinstance(card, dict):
        return
    # Do not count source_specific_terms themselves: a model can copy a list
    # of names while writing the rest of the card about an unrelated story.
    factual_card = {key: value for key, value in card.items() if key != "source_specific_terms"}
    rendered = json.dumps(
        {"summary": result.get("summary"), "case_card": factual_card},
        ensure_ascii=False,
    )
    matched = [name for name in anchors if name in rendered]
    required = 1 if len(anchors) == 1 else 2
    if len(matched) < required:
        raise RuntimeError(
            "蒸馏结果与原文主要人物不一致："
            f"原文人物锚点为「{'、'.join(anchors[:4])}」，结果只回写了「{'、'.join(matched)}」。"
        )


def _load_json(value: str | None, fallback: Any) -> Any:
    try:
        parsed = json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return fallback
    return parsed


def _normalize_tags(values: Any, *, limit: int = 8) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values:
        item = re.sub(r"\s+", " ", str(value or "").strip())[:30]
        if item and item not in result:
            result.append(item)
        if len(result) >= limit:
            break
    return result


def _unique_strings(values: Any, *, limit: int = 200) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values:
        item = str(value or "").strip()
        if item and item not in result:
            result.append(item)
        if len(result) >= limit:
            break
    return result


def _bootstrap_source_error(text: str) -> str | None:
    meaningful_chars = len(re.sub(r"\s+", "", text))
    if meaningful_chars < BOOTSTRAP_MIN_MEANINGFUL_CHARS:
        return (
            f"解码后的有效正文不足 {BOOTSTRAP_MIN_MEANINGFUL_CHARS} 字，"
            "可能仅包含水印或排版残片，无法进行可靠蒸馏"
        )
    return None


def _controlled_tags(kind: str, values: Any, *, require_value: bool = True) -> list[str]:
    limit = 1 if kind == "audience" else 4
    normalized = _normalize_tags(values, limit=limit)
    invalid = [value for value in normalized if value not in TAG_TAXONOMY[kind]]
    if invalid:
        raise RuntimeError(f"{TAG_LABELS[kind]}标签不在受控词表中：{'、'.join(invalid)}")
    if require_value and not normalized:
        raise RuntimeError(f"{TAG_LABELS[kind]}标签不能为空")
    return normalized


def _validate_tag_consistency(tags: dict[str, list[str]]) -> None:
    errors = script_profile_errors(tags, allow_auto=False)
    if errors:
        raise RuntimeError("；".join(errors))


def _required_text(value: Any, *, label: str, minimum: int, maximum: int = 2400) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())[:maximum]
    if len(text) < minimum:
        raise RuntimeError(f"{label}过于简略，至少需要 {minimum} 个字符")
    return text


def _evidence_references(values: Any, valid_chunk_ids: set[str], *, label: str, minimum: int = 1) -> list[str]:
    references = [item for item in _normalize_tags(values, limit=16) if item in valid_chunk_ids]
    if len(references) < min(minimum, len(valid_chunk_ids)):
        raise RuntimeError(f"{label}缺少可回查的原文证据")
    return references


def _has_full_source_coverage(references: list[str], chunk_count: int) -> bool:
    if chunk_count <= 2:
        return len(references) >= chunk_count
    indexes = {int(item[1:]) for item in references if item.startswith("C") and item[1:].isdigit()}
    opening_end = max(1, (chunk_count + 3) // 4)
    ending_start = max(1, (chunk_count * 3 + 3) // 4)
    return (
        any(index <= opening_end for index in indexes)
        and any(opening_end < index < ending_start for index in indexes)
        and any(index >= ending_start for index in indexes)
    )


def _safe_title(value: str, fallback: str) -> str:
    title = re.sub(r"\s+", " ", value.strip()).strip("-_《》 ")[:160]
    return title or fallback[:160] or "未命名剧本"


def _title_without_packaging(value: str) -> str:
    title = unicodedata.normalize("NFKC", str(value or ""))
    title = re.sub(r"^#{1,6}\s*", "", title).strip()
    title = re.sub(
        r"[》】）)]?\s*(?:第\s*)?[0-9一-龥]{1,8}\s*(?:[-—~～至到]\s*[0-9一-龥]{1,8})?\s*集"
        r"(?:\s*[-_—:：]?\s*(?:完整版|原剧本|剧本))?\s*$",
        "",
        title,
        flags=re.IGNORECASE,
    )
    title = re.sub(r"\s*(?:完整版|原剧本)\s*$", "", title, flags=re.IGNORECASE)
    return title.strip("-_《》【】「」“”'\" ")


def _canonical_script_title(value: str) -> str:
    title = _title_without_packaging(value).casefold()
    return re.sub(r"[\s\-_—·:：,，.。《》【】「」“”'\"()（）]+", "", title)


def _decode_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="无法识别文件编码，请转换为 UTF-8 后重试")


def _extract_docx(raw: bytes) -> str:
    import io

    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            document = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Word 文件无法读取") from exc
    root = ElementTree.fromstring(document)
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{namespace}p"):
        parts: list[str] = []
        for node in paragraph.iter():
            if node.tag == f"{namespace}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{namespace}tab":
                parts.append("\t")
            elif node.tag in {f"{namespace}br", f"{namespace}cr"}:
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def extract_script_text(filename: str, raw: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="仅支持 PDF、DOC、DOCX、Markdown 和 TXT 剧本")
    if suffix in {".pdf", ".docx"}:
        text = _extract_with_markdown_converter(filename, raw)
    elif suffix == ".doc":
        text = _extract_legacy_word_document(filename, raw)
    else:
        text = _decode_text(raw)
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text).strip()
    if len(text) < 200:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="剧本正文过短，无法进行有效蒸馏")
    return text


def _extract_with_markdown_converter(filename: str, raw: bytes) -> str:
    """Reuse the project document converter without starting a Claude process."""
    converter = settings.agents_dir / ".claude/skills/project_init/scripts/convert-script-to-md.mjs"
    if not converter.is_file():
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="未找到文档解析工具")
    with tempfile.TemporaryDirectory(prefix="script-library-convert-") as directory:
        root = Path(directory)
        source = root / Path(filename).name
        output = root / "converted.md"
        source.write_bytes(raw)
        node = os.getenv("ORCA_NODE_PATH", "").strip() or "node"
        result = subprocess.run(
            [node, str(converter), "--source", str(source), "--output", str(output)],
            cwd=settings.agents_dir,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        if result.returncode != 0 or not output.is_file():
            detail = (result.stderr or result.stdout or "文档转换失败").strip()
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail[-1000:])
        return output.read_text(encoding="utf-8")


def _extract_legacy_word_document(filename: str, raw: bytes) -> str:
    with tempfile.TemporaryDirectory(prefix="script-library-doc-") as directory:
        root = Path(directory)
        source = root / Path(filename).name
        source.write_bytes(raw)
        textutil = subprocess.run(
            ["textutil", "-convert", "txt", "-stdout", str(source)],
            capture_output=True,
            text=False,
            timeout=120,
            check=False,
        )
        if textutil.returncode == 0 and textutil.stdout:
            return _decode_text(textutil.stdout)
        soffice = os.getenv("ORCA_SOFFICE_PATH", "").strip() or "soffice"
        converted = subprocess.run(
            [soffice, "--headless", "--convert-to", "txt:Text", "--outdir", str(root), str(source)],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        output = root / f"{source.stem}.txt"
        if converted.returncode == 0 and output.is_file():
            return output.read_text(encoding="utf-8", errors="replace")
        detail = converted.stderr or textutil.stderr.decode("utf-8", errors="replace") or "DOC 文件无法读取"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(detail)[-1000:])


def _guess_title(filename: str, text: str) -> str:
    fallback = _title_without_packaging(Path(filename).stem)
    for line in text.splitlines()[:30]:
        candidate = re.sub(r"^#{1,6}\s*", "", line).strip()
        if not candidate or len(candidate) > 80:
            continue
        if re.match(r"^(?:第\s*[0-9一-龥]+\s*集|人物|梗概|正文|编剧)", candidate):
            continue
        return _safe_title(_title_without_packaging(candidate), fallback)
    return _safe_title(fallback, "未命名剧本")


def _episode_count(text: str) -> int | None:
    matches = re.findall(r"(?:^|\n)\s*(?:#{1,6}\s*)?第\s*([0-9]{1,4}|[一-龥]{1,8})\s*集", text)
    numeric = [int(value) for value in matches if value.isdigit()]
    if numeric:
        return max(numeric)
    return len(set(matches)) or None


def _source_directory() -> Path:
    directory = settings.data_dir / "script-library" / "sources"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _work_directory(job_id: int) -> Path:
    directory = settings.data_dir / "script-library" / "jobs" / str(job_id)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _write_source(source_sha256: str, text: str) -> Path:
    path = _source_directory() / f"{source_sha256}.md"
    if not path.exists():
        path.write_text(text + "\n", encoding="utf-8")
    return path


def _chunk_script(text: str, max_chars: int = 3600) -> list[dict[str, Any]]:
    heading = re.compile(r"^\s*(?:#{1,6}\s*)?(?:第\s*[0-9一-龥]+\s*集(?:\s*[-—：:].*)?|第\s*[0-9一-龥]+\s*场(?:\s*[-—：:].*)?|【[^】]{1,60}】)\s*$")
    chunks: list[dict[str, Any]] = []
    start = 0
    buffer: list[str] = []
    buffer_length = 0
    locator = "开篇"

    def flush(end: int) -> None:
        nonlocal start, buffer, buffer_length
        content = "\n".join(buffer).strip()
        if content:
            chunks.append({
                "chunk_index": len(chunks) + 1,
                "locator": locator[:120],
                "start_char": start,
                "end_char": end,
                "content": content,
            })
        buffer = []
        buffer_length = 0
        start = end

    cursor = 0
    for line in text.splitlines(keepends=True):
        plain = line.rstrip("\n")
        if heading.match(plain) and buffer_length >= 800:
            flush(cursor)
        if heading.match(plain):
            locator = re.sub(r"^#{1,6}\s*", "", plain).strip()
        if buffer and buffer_length + len(line) > max_chars:
            flush(cursor)
        if not buffer:
            start = cursor
        buffer.append(plain)
        buffer_length += len(line)
        cursor += len(line)
    flush(len(text))
    return chunks


def _replace_chunks(conn: sqlite3.Connection, script_id: int, text: str) -> int:
    chunks = _chunk_script(text)
    conn.execute("DELETE FROM script_library_source_chunks WHERE script_id = ?", (script_id,))
    conn.executemany(
        """
        INSERT INTO script_library_source_chunks (
            script_id, chunk_index, locator, start_char, end_char, content
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (script_id, item["chunk_index"], item["locator"], item["start_char"], item["end_char"], item["content"])
            for item in chunks
        ],
    )
    return len(chunks)


def create_uploaded_script(conn: sqlite3.Connection, *, actor: sqlite3.Row, upload: UploadFile) -> dict[str, Any]:
    filename = Path(upload.filename or "").name
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="仅支持 PDF、DOC、DOCX、Markdown 和 TXT 剧本")
    raw = upload.file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="单个剧本不能超过 30 MB")
    text = extract_script_text(filename, raw)
    source_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
    existing = conn.execute(
        "SELECT * FROM script_library_scripts WHERE source_sha256 = ?", (source_sha256,)
    ).fetchone()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"「{existing['title']}」已在剧本库中")
    title = _guess_title(filename, text)
    canonical_title = _canonical_script_title(title)
    same_title = next(
        (
            row
            for row in conn.execute("SELECT id, title FROM script_library_scripts ORDER BY id DESC").fetchall()
            if _canonical_script_title(str(row["title"])) == canonical_title
        ),
        None,
    )
    if same_title:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"「{same_title['title']}」已在剧本库中")
    source_path = _write_source(source_sha256, text)
    cursor = conn.execute(
        """
        INSERT INTO script_library_scripts (
            title, source_type, source_label, original_filename, source_file_path,
            source_sha256, chars, episode_count, status, created_by
        ) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, 'queued', ?)
        """,
        (
            title,
            "管理后台上传",
            filename,
            str(source_path),
            source_sha256,
            len(text),
            _episode_count(text),
            actor["id"],
        ),
    )
    script_id = int(cursor.lastrowid)
    _replace_chunks(conn, script_id, text)
    job_cursor = conn.execute(
        "INSERT INTO script_distillation_jobs (script_id, requested_by) VALUES (?, ?)",
        (script_id, actor["id"]),
    )
    job_id = int(job_cursor.lastrowid)
    record_audit(
        conn,
        actor=actor,
        action="script_library.upload",
        target_type="script_library_script",
        target_id=script_id,
        target_label=title,
        details={"filename": filename, "chars": len(text), "job_id": job_id},
    )
    return {"script": get_script(conn, script_id), "job_id": job_id}


def create_archived_project_script(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    project_id: int,
    project_name: str,
    title: str,
    filename: str,
    text: str,
) -> dict[str, Any]:
    normalized_text = str(text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    normalized_text = re.sub(r"[ \t]+\n", "\n", normalized_text)
    normalized_text = re.sub(r"\n{4,}", "\n\n\n", normalized_text).strip()
    if len(normalized_text) < 200:
        raise RuntimeError("完整剧本正文过短，无法开始剧本蒸馏")

    source_sha256 = hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()
    existing = conn.execute(
        "SELECT * FROM script_library_scripts WHERE source_sha256 = ?",
        (source_sha256,),
    ).fetchone()
    if existing:
        active_job = conn.execute(
            """
            SELECT id FROM script_distillation_jobs
            WHERE script_id = ? AND status IN ('queued', 'running')
            ORDER BY id DESC LIMIT 1
            """,
            (int(existing["id"]),),
        ).fetchone()
        if active_job:
            return {
                "script": get_script(conn, int(existing["id"])),
                "job_id": int(active_job["id"]),
                "queue_status": "already_queued",
            }
        if str(existing["status"]) == "ready":
            return {
                "script": get_script(conn, int(existing["id"])),
                "job_id": None,
                "queue_status": "already_distilled",
            }
        retried = retry_distillation(conn, actor=actor, script_id=int(existing["id"]))
        return {**retried, "queue_status": "requeued"}

    safe_title = _safe_title(_title_without_packaging(title), project_name)
    safe_filename = Path(filename).name or f"{safe_title}.md"
    source_path = _write_source(source_sha256, normalized_text)
    cursor = conn.execute(
        """
        INSERT INTO script_library_scripts (
            title, source_type, source_label, original_filename, source_file_path,
            source_sha256, chars, episode_count, status, created_by, source_project_id
        ) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        """,
        (
            safe_title,
            f"项目归档 · {project_name}",
            safe_filename,
            str(source_path),
            source_sha256,
            len(normalized_text),
            _episode_count(normalized_text),
            actor["id"],
            project_id,
        ),
    )
    script_id = int(cursor.lastrowid)
    _replace_chunks(conn, script_id, normalized_text)
    job_cursor = conn.execute(
        "INSERT INTO script_distillation_jobs (script_id, requested_by) VALUES (?, ?)",
        (script_id, actor["id"]),
    )
    job_id = int(job_cursor.lastrowid)
    record_audit(
        conn,
        actor=actor,
        action="script_library.project_archive.enqueue",
        target_type="script_library_script",
        target_id=script_id,
        target_label=safe_title,
        project_id=project_id,
        details={"filename": safe_filename, "chars": len(normalized_text), "job_id": job_id},
    )
    return {
        "script": get_script(conn, script_id),
        "job_id": job_id,
        "queue_status": "queued",
    }


def _public_script(row: sqlite3.Row, *, include_detail: bool = False) -> dict[str, Any]:
    source_unusable = str(row["error_message"] or "").startswith("解码后的")
    progress_current = int(row["distillation_progress_current"] or 0)
    progress_total = int(row["distillation_progress_total"] or 0)
    progress_percent = 100 if row["status"] == "ready" else (
        min(99, round(progress_current * 100 / progress_total)) if progress_total else 0
    )
    source_project_id = (
        int(row["source_project_id"])
        if "source_project_id" in row.keys() and row["source_project_id"] is not None
        else None
    )
    source_label = str(row["source_label"] or "")
    project_archive_source = source_project_id is not None or source_label.startswith("项目归档 · ")
    payload = {
        "id": int(row["id"]),
        "title": str(row["title"]),
        "source_type": "project_archive" if project_archive_source else str(row["source_type"]),
        "source_label": source_label,
        "source_project_id": source_project_id,
        "original_filename": str(row["original_filename"]),
        "chars": int(row["chars"] or 0),
        "episode_count": int(row["episode_count"]) if row["episode_count"] is not None else None,
        "status": str(row["status"]),
        "summary": str(row["summary"] or ""),
        "tags": {
            "theme": _load_json(row["theme_tags_json"], []),
            "setting": _load_json(row["setting_tags_json"], []),
            "background": _load_json(row["background_tags_json"], []),
            "audience": _load_json(row["audience_tags_json"], []),
        },
        "distillation_version": str(row["distillation_version"] or ""),
        "error_message": row["error_message"],
        "retryable": str(row["status"]) == "failed" and not source_unusable,
        "distillation_progress": {
            "stage": str(row["distillation_stage"] or "queued"),
            "label": str(row["distillation_stage_label"] or "等待处理"),
            "current": progress_current,
            "total": progress_total,
            "percent": progress_percent,
            "message": str(row["distillation_progress_message"] or ""),
        },
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if include_detail:
        payload["case_card"] = _load_json(row["case_card_json"], {})
        payload["formulas"] = _load_json(row["formulas_json"], {})
        payload["distillation_result"] = _load_json(row["distillation_result_json"], {})
    return payload


def get_script(conn: sqlite3.Connection, script_id: int, *, include_legacy: bool = True) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM script_library_scripts WHERE id = ?", (script_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="剧本不存在")
    payload = _public_script(row, include_detail=True)
    payload["source_index"] = [
        {
            "id": f"C{int(item['chunk_index']):04d}",
            "locator": item["locator"],
            "start_char": int(item["start_char"]),
            "end_char": int(item["end_char"]),
            "preview": str(item["content"])[:220],
        }
        for item in conn.execute(
            "SELECT * FROM script_library_source_chunks WHERE script_id = ? ORDER BY chunk_index LIMIT 200",
            (script_id,),
        ).fetchall()
    ]
    formula_cards, principle_cards = cards_for_script(conn, script_id)
    if include_legacy and not formula_cards and not principle_cards:
        legacy_cards = [
            _public_formula_card(conn, item)
            for item in conn.execute(
                """
                SELECT * FROM script_library_formula_cards
                WHERE status != 'retired'
                  AND EXISTS (SELECT 1 FROM json_each(source_script_ids_json) WHERE CAST(value AS INTEGER) = ?)
                ORDER BY formula_type, status, source_count DESC, title
                """,
                (script_id,),
            ).fetchall()
        ]
        formula_cards = [card for card in legacy_cards if card["formula_type"] != "mechanism"]
        principle_cards = [card for card in legacy_cards if card["formula_type"] == "mechanism"]
    payload["formula_cards"] = formula_cards
    payload["principle_cards"] = principle_cards
    return payload


def list_scripts(
    conn: sqlite3.Connection,
    *,
    query: str = "",
    script_status: str = "",
    theme: str = "",
    setting: str = "",
    background: str = "",
    audience: str = "",
    page: int = 1,
    page_size: int = 30,
    include_legacy: bool = True,
) -> dict[str, Any]:
    # Status is a facet rather than part of the status-count scope: the
    # dropdown should show how many records each status would reveal under
    # the current search and tag filters.
    base_conditions: list[str] = []
    base_params: list[Any] = []
    if query.strip():
        token = f"%{query.strip()}%"
        base_conditions.append("(title LIKE ? OR summary LIKE ? OR source_label LIKE ?)")
        base_params.extend([token, token, token])
    for kind, value in (("theme", theme), ("setting", setting), ("background", background), ("audience", audience)):
        if value:
            column = TAG_FIELDS[kind]
            base_conditions.append(f"EXISTS (SELECT 1 FROM json_each({column}) WHERE value = ?)")
            base_params.append(value)
    conditions = [*base_conditions]
    params = [*base_params]
    if script_status:
        conditions.append("status = ?")
        params.append(script_status)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    total = int(conn.execute(f"SELECT COUNT(*) FROM script_library_scripts {where}", params).fetchone()[0])
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"SELECT * FROM script_library_scripts {where} ORDER BY id DESC LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    all_tags = {kind: [] for kind in TAG_FIELDS}
    for row in conn.execute(
        "SELECT theme_tags_json, setting_tags_json, background_tags_json, audience_tags_json FROM script_library_scripts WHERE status = 'ready'"
    ).fetchall():
        for kind, column in TAG_FIELDS.items():
            for value in _load_json(row[column], []):
                if value not in all_tags[kind]:
                    all_tags[kind].append(value)
    for values in all_tags.values():
        values.sort()
    stats_row = conn.execute(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
               SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS processing,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM script_library_scripts
        """
    ).fetchone()
    base_where = f"WHERE {' AND '.join(base_conditions)}" if base_conditions else ""
    status_count_rows = conn.execute(
        f"SELECT status, COUNT(*) AS count FROM script_library_scripts {base_where} GROUP BY status",
        base_params,
    ).fetchall()
    status_counts = {status: 0 for status in ("queued", "processing", "ready", "failed")}
    for row in status_count_rows:
        status_counts[str(row["status"])] = int(row["count"] or 0)
    status_counts["all"] = sum(status_counts.values())
    knowledge = knowledge_stats(conn, include_legacy=include_legacy)
    return {
        "scripts": [_public_script(row) for row in rows],
        "pagination": {"page": page, "page_size": page_size, "total": total, "total_pages": max(1, (total + page_size - 1) // page_size)},
        "facets": all_tags,
        "taxonomy": tag_taxonomy(),
        "stats": {
            "total": int(stats_row["total"] or 0),
            "ready": int(stats_row["ready"] or 0),
            "processing": int(stats_row["processing"] or 0),
            "failed": int(stats_row["failed"] or 0),
            "status_counts": status_counts,
            "formula_cards": knowledge["formula_cards"],
            "principle_cards": knowledge["principle_cards"],
            "formula_counts": knowledge["formula_counts"],
        },
    }


def _script_tag_facets(conn: sqlite3.Connection, *, formula_script_ids: set[int] | None = None) -> dict[str, list[str]]:
    all_tags = {kind: [] for kind in TAG_FIELDS}
    rows = conn.execute(
        "SELECT id, theme_tags_json, setting_tags_json, background_tags_json, audience_tags_json "
        "FROM script_library_scripts WHERE status = 'ready'"
    ).fetchall()
    for row in rows:
        if formula_script_ids is not None and int(row["id"]) not in formula_script_ids:
            continue
        for kind, column in TAG_FIELDS.items():
            for value in _load_json(row[column], []):
                if value not in all_tags[kind]:
                    all_tags[kind].append(value)
    for values in all_tags.values():
        values.sort()
    return all_tags


def list_formula_cards(
    conn: sqlite3.Connection,
    *,
    formula_type: str = "",
    card_kind: str = "",
    stage: str = "",
    verification_status: str = "",
    query: str = "",
    theme: str = "",
    setting: str = "",
    background: str = "",
    audience: str = "",
    page: int = 1,
    page_size: int = 30,
    include_legacy: bool = True,
) -> dict[str, Any]:
    # The current catalog keeps formulas and principles in separate tables.
    # Keep this function name for the existing router while returning the new
    # public contract; legacy mechanism cards are intentionally no longer used
    # by new distillation jobs.
    if card_kind in {"formula", "principle"} or not formula_type or formula_type in {
        "story_engine", "world_rule", "character_relationship", "long_arc",
        "episode_structure", "hook_information", "audience_payoff",
        "emotional_progression", "scene_conflict", "dialogue_action",
    }:
        current = list_cards(
            conn,
            card_kind=card_kind or "formula",
            category=formula_type if formula_type in {
                "story_engine", "world_rule", "character_relationship", "long_arc",
                "episode_structure", "hook_information", "audience_payoff",
                "emotional_progression", "scene_conflict", "dialogue_action",
            } else "",
            query=query,
            stage=stage,
            verification_status=verification_status,
            theme=theme,
            setting=setting,
            background=background,
            audience=audience,
            page=page,
            page_size=page_size,
        )
        # Compatibility for installations that still contain pre-v3 cards. A
        # fresh library has no rows here, and new jobs never write this table.
        # Maintenance callers may opt into the old one-script cards; the admin
        # UI leaves them out so they cannot be mistaken for reusable formulas.
        if include_legacy and current["pagination"]["total"] == 0:
            legacy_kind = "mechanism" if card_kind == "principle" else "nonmechanism"
            legacy_condition = "formula_type = 'mechanism'" if legacy_kind == "mechanism" else "formula_type != 'mechanism'"
            legacy_rows = conn.execute(
                f"SELECT * FROM script_library_formula_cards WHERE status != 'retired' AND {legacy_condition} ORDER BY status, source_count DESC, title"
            ).fetchall()
            if legacy_rows:
                legacy_cards = []
                for row in legacy_rows:
                    card = _public_formula_card(conn, row)
                    legacy_cards.append({
                        **card,
                        "card_kind": "principle" if legacy_kind == "mechanism" else "formula",
                        "category": "principle" if legacy_kind == "mechanism" else str(card["formula_type"]),
                        "formula_type": str(card["formula_type"]),
                        "stages": [],
                        "creative_decision": "",
                        "revision": int(card.get("content", {}).get("revision") or 1),
                    })
                current["formulas"] = legacy_cards
                current["cards"] = legacy_cards
                current["pagination"] = {
                    **current["pagination"],
                    "total": len(legacy_cards),
                    "total_pages": max(1, (len(legacy_cards) + page_size - 1) // page_size),
                }
        return current
    conditions = ["f.status != 'retired'"]
    params: list[Any] = []
    if card_kind == "formula":
        conditions.append("f.formula_type != 'mechanism'")
    elif card_kind == "principle":
        conditions.append("f.formula_type = 'mechanism'")
    if formula_type:
        conditions.append("f.formula_type = ?")
        params.append(formula_type)
    if query.strip():
        conditions.append(
            "(f.title LIKE ? OR f.description LIKE ? OR EXISTS ("
            "SELECT 1 FROM json_each(f.source_script_ids_json) AS source_id "
            "JOIN script_library_scripts AS source_script ON source_script.id = CAST(source_id.value AS INTEGER) "
            "WHERE source_script.title LIKE ? OR source_script.source_label LIKE ?))"
        )
        token = f"%{query.strip()}%"
        params.extend([token, token, token, token])
    for kind, value in (("theme", theme), ("setting", setting), ("background", background), ("audience", audience)):
        if value:
            column = TAG_FIELDS[kind]
            conditions.append(
                "EXISTS ("
                "SELECT 1 FROM json_each(f.source_script_ids_json) AS source_id "
                "JOIN script_library_scripts AS source_script "
                "ON source_script.id = CAST(source_id.value AS INTEGER) "
                "WHERE source_script.status = 'ready' "
                f"AND EXISTS (SELECT 1 FROM json_each(source_script.{column}) WHERE value = ?)"
                ")"
            )
            params.append(value)
    where = " AND ".join(conditions)
    total = int(conn.execute(f"SELECT COUNT(*) FROM script_library_formula_cards AS f WHERE {where}", params).fetchone()[0])
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"SELECT f.* FROM script_library_formula_cards AS f WHERE {where} "
        "ORDER BY f.status, f.source_count DESC, f.title LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    formula_script_ids: set[int] = set()
    facet_rows = conn.execute(
        f"SELECT f.source_script_ids_json FROM script_library_formula_cards AS f WHERE {where}", params
    ).fetchall()
    for row in facet_rows:
        formula_script_ids.update(
            int(value) for value in _load_json(row["source_script_ids_json"], []) if str(value).isdigit()
        )
    return {
        "formulas": [_public_formula_card(conn, row) for row in rows],
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": max(1, (total + page_size - 1) // page_size),
        },
        "facets": _script_tag_facets(conn, formula_script_ids=formula_script_ids or None),
        "taxonomy": tag_taxonomy(),
    }


def _public_formula_card(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    source_script_ids = _load_json(row["source_script_ids_json"], [])
    source_script_ids = [int(value) for value in source_script_ids if str(value).isdigit()]
    return {
        "id": row["id"],
        "formula_type": row["formula_type"],
        "title": row["title"],
        "description": row["description"],
        "applicable_tags": _load_json(row["applicable_tags_json"], []),
        "source_script_ids": source_script_ids,
        "source_count": int(row["source_count"]),
        "status": row["status"],
        "origin": row["origin"],
        "source_script_titles": [
            str(source["title"])
            for source in conn.execute(
                "SELECT title FROM script_library_scripts "
                "WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) "
                "ORDER BY title",
                (row["source_script_ids_json"],),
            ).fetchall()
        ],
        "source_scripts": [
            {"id": int(source["id"]), "title": str(source["title"])}
            for source in conn.execute(
                "SELECT id, title FROM script_library_scripts "
                "WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) "
                "ORDER BY title",
                (row["source_script_ids_json"],),
            ).fetchall()
        ],
        "content": _load_json(row["content_json"], {}),
    }


def delete_formula_card(conn: sqlite3.Connection, *, actor: sqlite3.Row, formula_id: str) -> None:
    new_card = conn.execute(
        "SELECT id, name AS title, source_count FROM script_library_formulas WHERE id = ?",
        (formula_id,),
    ).fetchone()
    if new_card:
        details = delete_card(conn, formula_id)
        record_audit(
            conn,
            actor=actor,
            action="script_library.card.delete",
            target_type="script_library_knowledge_card",
            target_id=formula_id,
            target_label=str(new_card["title"]),
            details=details,
        )
        return
    new_principle = conn.execute(
        "SELECT id, title, source_count FROM script_library_principles WHERE id = ?",
        (formula_id,),
    ).fetchone()
    if new_principle:
        details = delete_card(conn, formula_id)
        record_audit(
            conn,
            actor=actor,
            action="script_library.card.delete",
            target_type="script_library_knowledge_card",
            target_id=formula_id,
            target_label=str(new_principle["title"]),
            details=details,
        )
        return
    row = conn.execute(
        "SELECT * FROM script_library_formula_cards WHERE id = ? AND status != 'retired'",
        (formula_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="公式卡或创作原则不存在")
    conn.execute(
        "DELETE FROM script_library_formula_cards WHERE id = ?",
        (formula_id,),
    )
    record_audit(
        conn,
        actor=actor,
        action="script_library.formula.delete",
        target_type="script_library_formula_card",
        target_id=formula_id,
        target_label=str(row["title"]),
        details={"formula_type": str(row["formula_type"]), "source_count": int(row["source_count"] or 0)},
    )


def search_source_chunks(conn: sqlite3.Connection, *, script_id: int, query: str = "") -> dict[str, Any]:
    get_script(conn, script_id)
    params: list[Any] = [script_id]
    condition = "script_id = ?"
    if query.strip():
        condition += " AND (content LIKE ? OR locator LIKE ?)"
        token = f"%{query.strip()}%"
        params.extend([token, token])
    rows = conn.execute(
        f"SELECT * FROM script_library_source_chunks WHERE {condition} ORDER BY chunk_index LIMIT 30",
        params,
    ).fetchall()
    return {
        "chunks": [
            {
                "id": f"C{int(row['chunk_index']):04d}",
                "locator": row["locator"],
                "start_char": int(row["start_char"]),
                "end_char": int(row["end_char"]),
                "content": row["content"],
            }
            for row in rows
        ]
    }


def update_script_metadata(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    script_id: int,
    title: str | None,
    tags: dict[str, list[str]] | None,
) -> dict[str, Any]:
    current = conn.execute("SELECT * FROM script_library_scripts WHERE id = ?", (script_id,)).fetchone()
    if not current:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="剧本不存在")
    assignments: list[str] = []
    params: list[Any] = []
    if title is not None:
        assignments.append("title = ?")
        params.append(_safe_title(title, str(current["title"])))
    if tags is not None:
        normalized_tags = {
            kind: _load_json(current[column], [])
            for kind, column in TAG_FIELDS.items()
        }
        for kind, column in TAG_FIELDS.items():
            if kind in tags:
                try:
                    values = _controlled_tags(kind, tags[kind])
                except RuntimeError as exc:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
                normalized_tags[kind] = values
                assignments.append(f"{column} = ?")
                params.append(_json(values))
        try:
            _validate_tag_consistency(normalized_tags)
        except RuntimeError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if assignments:
        conn.execute(
            f"UPDATE script_library_scripts SET {', '.join(assignments)}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [*params, script_id],
        )
        if tags is not None:
            _refresh_linked_mechanism_tags(conn, script_id=script_id)
            from app.services.script_knowledge_service import refresh_script_links

            refresh_script_links(conn, script_id)
        record_audit(
            conn,
            actor=actor,
            action="script_library.metadata.update",
            target_type="script_library_script",
            target_id=script_id,
            target_label=str(current["title"]),
            details={"fields": [item.split(" =", 1)[0] for item in assignments]},
        )
    return get_script(conn, script_id)


def delete_script(conn: sqlite3.Connection, *, actor: sqlite3.Row, script_id: int) -> None:
    row = conn.execute("SELECT * FROM script_library_scripts WHERE id = ?", (script_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="剧本不存在")
    if row["status"] == "processing":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="剧本正在蒸馏，暂时无法删除")
    source_path = Path(str(row["source_file_path"]))
    # Detach the new formula/principle relationships before the source script
    # is removed, so shared cards recalculate their evidence counts and tags.
    from app.services.script_knowledge_service import detach_script

    detach_script(conn, script_id)
    formula_rows = conn.execute("SELECT * FROM script_library_formula_cards").fetchall()
    for formula in formula_rows:
        source_ids = [int(value) for value in _load_json(formula["source_script_ids_json"], []) if str(value).isdigit()]
        if script_id not in source_ids:
            continue
        remaining = [value for value in source_ids if value != script_id]
        if not remaining:
            conn.execute("DELETE FROM script_library_formula_cards WHERE id = ?", (formula["id"],))
        else:
            if formula["formula_type"] == "mechanism":
                content = _load_json(formula["content_json"], {})
                content["evidence"] = [
                    item for item in content.get("evidence", [])
                    if isinstance(item, dict) and int(item.get("script_id") or 0) != script_id
                ]
                content["curation_history"] = [
                    item for item in content.get("curation_history", [])
                    if isinstance(item, dict) and int(item.get("script_id") or 0) != script_id
                ]
                conn.execute(
                    """
                    UPDATE script_library_formula_cards
                    SET applicable_tags_json = ?, source_script_ids_json = ?, source_count = ?,
                        status = ?, content_json = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (
                        _json(_applicable_tags_for_scripts(conn, remaining)), _json(remaining), len(remaining),
                        "active" if len(remaining) >= MECHANISM_ACTIVATION_MIN_SOURCES else "candidate", _json(content), formula["id"],
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE script_library_formula_cards
                    SET source_script_ids_json = ?, source_count = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (_json(remaining), len(remaining), formula["id"]),
                )
    conn.execute("DELETE FROM script_library_scripts WHERE id = ?", (script_id,))
    record_audit(
        conn,
        actor=actor,
        action="script_library.delete",
        target_type="script_library_script",
        target_id=script_id,
        target_label=str(row["title"]),
    )
    duplicate = conn.execute(
        "SELECT 1 FROM script_library_scripts WHERE source_file_path = ? LIMIT 1", (str(source_path),)
    ).fetchone()
    if not duplicate and source_path.is_relative_to(settings.data_dir):
        source_path.unlink(missing_ok=True)


def retry_distillation(conn: sqlite3.Connection, *, actor: sqlite3.Row, script_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM script_library_scripts WHERE id = ?", (script_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="剧本不存在")
    if row["source_type"] == "short-writing-skill":
        source_path = Path(str(row["source_file_path"]))
        try:
            source_text = source_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="原文文件无法读取，请重新导入") from exc
        source_error = _bootstrap_source_error(source_text)
        if source_error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=source_error)
    active = conn.execute(
        "SELECT id FROM script_distillation_jobs WHERE script_id = ? AND status IN ('queued', 'running')",
        (script_id,),
    ).fetchone()
    if active:
        return {"script": get_script(conn, script_id), "job_id": int(active["id"])}
    cursor = conn.execute(
        "INSERT INTO script_distillation_jobs (script_id, requested_by) VALUES (?, ?)",
        (script_id, actor["id"]),
    )
    conn.execute(
        """
        UPDATE script_library_scripts
        SET status = 'queued', error_message = NULL,
            distillation_stage = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN distillation_stage ELSE 'queued' END,
            distillation_stage_label = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN distillation_stage_label ELSE '等待处理' END,
            distillation_progress_current = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN distillation_progress_current ELSE 0 END,
            distillation_progress_total = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN distillation_progress_total ELSE 0 END,
            distillation_progress_message = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN '将从已完成阶段继续处理' ELSE '等待处理' END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (script_id,),
    )
    return {"script": get_script(conn, script_id), "job_id": int(cursor.lastrowid)}


def _distillation_template() -> dict[str, Any]:
    return {
        "summary": "",
        "tags": {"theme": [], "setting": [], "background": [], "audience": []},
        "formulas": {"core": "", "world": "", "gratification": ""},
        "case_card": {
            "logline": "",
            "story_overview": "",
            "audience_emotion": "",
            "type_promise": "",
            "main_relationship": "",
            "central_conflict": "",
            "opening_pressure": "",
            "protagonist_tool": "",
            "protagonist_arc": "",
            "relationship_arc": "",
            "plot_engine": "",
            "first3_model": "",
            "first10_model": "",
            "midgame_upgrade": "",
            "ending_payoff": "",
            "character_arcs": [],
            "key_turning_points": [],
            "mechanisms": [],
            "signature_elements": [],
            "source_specific_terms": [],
            "originality_boundary": "",
            "evidence_references": [],
        },
    }


def distillation_output_schema() -> dict[str, Any]:
    return knowledge_distillation_output_schema()


def _legacy_distillation_output_schema() -> dict[str, Any]:
    evidence = {
        "type": "array",
        "items": {"type": "string", "pattern": "^C[0-9]{4,}$"},
        "minItems": 1,
        "maxItems": 16,
    }

    def text(minimum: int, maximum: int = 2400) -> dict[str, Any]:
        return {"type": "string", "minLength": minimum, "maxLength": maximum}

    def strict_object(properties: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        }

    tag_properties = {
        kind: {
            "type": "array",
            "items": {"type": "string", "enum": list(options)},
            "minItems": 1,
            "maxItems": 1 if kind == "audience" else 4,
        }
        for kind, options in TAG_TAXONOMY.items()
    }
    character_arc = strict_object({
        "name": text(1, 40),
        "role": text(4, 120),
        "initial_state": text(12, 360),
        "desire": text(12, 360),
        "leverage": text(8, 360),
        "turning_point": text(16, 480),
        "final_state": text(12, 360),
        "evidence_references": evidence,
    })
    turning_point = strict_object({
        "phase": text(2, 40),
        "event": text(20, 600),
        "story_change": text(20, 600),
        "evidence_references": evidence,
    })
    mechanism = strict_object({
        "name": text(4, 80),
        "function": text(20, 600),
        "trigger": text(16, 600),
        "payoff": text(16, 600),
        "transferable_strategy": text(30, 800),
        "failure_boundary": text(20, 600),
        "evidence_references": evidence,
    })
    case_card = strict_object({
        "logline": text(40, 360),
        "story_overview": text(200, 1800),
        "audience_emotion": text(30, 480),
        "type_promise": text(40, 600),
        "main_relationship": text(30, 600),
        "central_conflict": text(50, 800),
        "opening_pressure": text(50, 800),
        "protagonist_tool": text(30, 600),
        "protagonist_arc": text(80, 1200),
        "relationship_arc": text(80, 1200),
        "plot_engine": text(80, 1200),
        "first3_model": text(100, 1400),
        "first10_model": text(140, 1800),
        "midgame_upgrade": text(70, 1200),
        "ending_payoff": text(70, 1200),
        "character_arcs": {"type": "array", "items": character_arc, "minItems": 2, "maxItems": 8},
        "key_turning_points": {"type": "array", "items": turning_point, "minItems": 4, "maxItems": 8},
        "mechanisms": {"type": "array", "items": mechanism, "minItems": 3, "maxItems": 6},
        "signature_elements": {"type": "array", "items": text(4, 120), "minItems": 3, "maxItems": 8},
        "source_specific_terms": {"type": "array", "items": text(2, 30), "minItems": 4, "maxItems": 12},
        "originality_boundary": text(60, 1000),
        "evidence_references": evidence,
    })
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **strict_object({
            "summary": text(120, 1200),
            "tags": strict_object(tag_properties),
            "formulas": strict_object({
                "core": text(80, 1200),
                "world": text(80, 1200),
                "gratification": text(80, 1200),
            }),
            "case_card": case_card,
        }),
    }


def _validate_distillation(
    payload: Any,
    valid_chunk_ids: set[str],
    *,
    source_text: str = "",
) -> dict[str, Any]:
    if isinstance(payload, dict) and ("formula_candidates" in payload or payload.get("schema_version") == "1.0.0"):
        return validate_knowledge_distillation(payload, valid_chunk_ids, source_text=source_text)
    if not isinstance(payload, dict):
        raise RuntimeError("蒸馏结果不是有效对象")
    tags = payload.get("tags")
    formulas = payload.get("formulas")
    card = payload.get("case_card")
    if not isinstance(tags, dict) or not isinstance(formulas, dict) or not isinstance(card, dict):
        raise RuntimeError("蒸馏结果缺少标签、公式或案例卡")
    normalized_tags = {kind: _controlled_tags(kind, tags.get(kind)) for kind in TAG_FIELDS}
    _validate_tag_consistency(normalized_tags)
    normalized_formulas = {
        "core": _required_text(formulas.get("core"), label="内核公式", minimum=80, maximum=1200),
        "world": _required_text(formulas.get("world"), label="世界观公式", minimum=80, maximum=1200),
        "gratification": _required_text(formulas.get("gratification"), label="爽点公式", minimum=80, maximum=1200),
    }
    field_rules = {
        "logline": ("一句话内核", 40, 360),
        "story_overview": ("故事全貌", 200, 1800),
        "audience_emotion": ("受众情绪", 30, 480),
        "type_promise": ("类型承诺", 40, 600),
        "main_relationship": ("核心关系", 30, 600),
        "central_conflict": ("中心冲突", 50, 800),
        "opening_pressure": ("开局压力", 50, 800),
        "protagonist_tool": ("主角工具", 30, 600),
        "protagonist_arc": ("主角弧光", 80, 1200),
        "relationship_arc": ("关系弧光", 80, 1200),
        "plot_engine": ("情节引擎", 80, 1200),
        "first3_model": ("前三集模型", 100, 1400),
        "first10_model": ("前十集模型", 140, 1800),
        "midgame_upgrade": ("中段升级", 70, 1200),
        "ending_payoff": ("终局回报", 70, 1200),
        "originality_boundary": ("原创边界", 60, 1000),
    }
    normalized_card = {
        field: _required_text(card.get(field), label=label, minimum=minimum, maximum=maximum)
        for field, (label, minimum, maximum) in field_rules.items()
    }

    raw_characters = card.get("character_arcs")
    if not isinstance(raw_characters, list) or len(raw_characters) < 2:
        raise RuntimeError("案例卡至少需要两个具体人物弧光")
    normalized_characters: list[dict[str, Any]] = []
    character_rules = {
        "name": ("人物姓名", 1, 40), "role": ("人物功能", 4, 120),
        "initial_state": ("人物初始状态", 12, 360), "desire": ("人物欲望", 12, 360),
        "leverage": ("人物筹码", 8, 360), "turning_point": ("人物转折", 16, 480),
        "final_state": ("人物终局状态", 12, 360),
    }
    for index, item in enumerate(raw_characters[:8], start=1):
        if not isinstance(item, dict):
            raise RuntimeError(f"第 {index} 个人物弧光格式错误")
        normalized = {
            field: _required_text(item.get(field), label=label, minimum=minimum, maximum=maximum)
            for field, (label, minimum, maximum) in character_rules.items()
        }
        normalized["evidence_references"] = _evidence_references(
            item.get("evidence_references"), valid_chunk_ids, label=f"第 {index} 个人物弧光"
        )
        normalized_characters.append(normalized)
    normalized_card["character_arcs"] = normalized_characters

    raw_turns = card.get("key_turning_points")
    if not isinstance(raw_turns, list) or len(raw_turns) < 4:
        raise RuntimeError("案例卡至少需要四个关键转折")
    normalized_turns: list[dict[str, Any]] = []
    for index, item in enumerate(raw_turns[:8], start=1):
        if not isinstance(item, dict):
            raise RuntimeError(f"第 {index} 个关键转折格式错误")
        normalized_turns.append({
            "phase": _required_text(item.get("phase"), label="转折阶段", minimum=2, maximum=40),
            "event": _required_text(item.get("event"), label="转折事件", minimum=20, maximum=600),
            "story_change": _required_text(item.get("story_change"), label="转折后变化", minimum=20, maximum=600),
            "evidence_references": _evidence_references(
                item.get("evidence_references"), valid_chunk_ids, label=f"第 {index} 个关键转折"
            ),
        })
    normalized_card["key_turning_points"] = normalized_turns

    raw_mechanisms = card.get("mechanisms")
    if not isinstance(raw_mechanisms, list) or len(raw_mechanisms) < 3:
        raise RuntimeError("案例卡至少需要三个可迁移机制")
    normalized_mechanisms: list[dict[str, Any]] = []
    mechanism_rules = {
        "name": ("机制名称", 4, 80), "function": ("机制功能", 20, 600),
        "trigger": ("机制触发", 16, 600), "payoff": ("机制回报", 16, 600),
        "transferable_strategy": ("迁移策略", 30, 800), "failure_boundary": ("失效边界", 20, 600),
    }
    for index, item in enumerate(raw_mechanisms[:6], start=1):
        if not isinstance(item, dict):
            raise RuntimeError(f"第 {index} 个可迁移机制格式错误")
        normalized = {
            field: _required_text(item.get(field), label=label, minimum=minimum, maximum=maximum)
            for field, (label, minimum, maximum) in mechanism_rules.items()
        }
        normalized["evidence_references"] = _evidence_references(
            item.get("evidence_references"), valid_chunk_ids, label=f"第 {index} 个可迁移机制"
        )
        normalized_mechanisms.append(normalized)
    normalized_card["mechanisms"] = normalized_mechanisms

    normalized_card["signature_elements"] = _normalize_tags(card.get("signature_elements"), limit=8)
    if len(normalized_card["signature_elements"]) < 3:
        raise RuntimeError("案例卡至少需要三个辨识性元素")
    source_terms = _normalize_tags(card.get("source_specific_terms"), limit=12)
    required_terms = 4 if len(source_text) >= 1000 else 1
    if source_text:
        source_terms = source_terms_found_in_text(source_terms, source_text, limit=12)
    if len(source_terms) < required_terms:
        raise RuntimeError("案例卡缺少可从原文回查的专属词")
    normalized_card["source_specific_terms"] = source_terms
    top_evidence = _evidence_references(
        card.get("evidence_references"), valid_chunk_ids, label="案例卡", minimum=5
    )
    if not _has_full_source_coverage(top_evidence, len(valid_chunk_ids)):
        raise RuntimeError("案例卡证据未覆盖开篇、中段和收束")
    normalized_card["evidence_references"] = top_evidence
    summary = _required_text(payload.get("summary"), label="剧本摘要", minimum=120, maximum=1200)
    return {"summary": summary, "tags": normalized_tags, "formulas": normalized_formulas, "case_card": normalized_card}


def _mechanism_candidates(script_id: int, result: dict[str, Any]) -> list[dict[str, Any]]:
    tags = result["tags"]
    applicable_tags = [
        *tags["theme"], *tags["setting"], *tags["background"], *tags["audience"],
    ]
    source_specific_terms = _unique_strings(result["case_card"].get("source_specific_terms"), limit=24)
    return [
        {
            "key": f"M{index:02d}",
            "script_id": script_id,
            "name": mechanism["name"],
            **{field: mechanism[field] for field in MECHANISM_CONTENT_FIELDS},
            "evidence_references": mechanism["evidence_references"],
            "applicable_tags": applicable_tags,
            "source_specific_terms": source_specific_terms,
            "causal_fingerprint": causal_fingerprint(mechanism),
        }
        for index, mechanism in enumerate(result["case_card"]["mechanisms"], start=1)
    ]


def _mechanism_catalog(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT * FROM script_library_formula_cards
        WHERE formula_type = 'mechanism' AND status != 'retired'
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, source_count DESC, title
        """
    ).fetchall()
    catalog: list[dict[str, Any]] = []
    for row in rows:
        content = _load_json(row["content_json"], {})
        card = {
            "id": str(row["id"]),
            "title": str(row["title"]),
            "description": str(row["description"]),
            "status": str(row["status"]),
            "source_count": int(row["source_count"] or 0),
            "applicable_tags": _load_json(row["applicable_tags_json"], []),
            **{field: str(content.get(field) or "") for field in MECHANISM_CONTENT_FIELDS},
        }
        card["causal_fingerprint"] = str(content.get("causal_fingerprint") or causal_fingerprint(card))
        catalog.append(card)
    return catalog


def mechanism_curation_prompt(
    *,
    catalog_path: Path,
    candidates_path: Path,
    output_path: Path,
    catalog_size: int,
) -> str:
    return f"""
你要把新剧本的“单剧机制证据”合并进一个少而精、可跨题材复用的创作机制库。

现有创作机制：{catalog_path}
本次单剧机制证据：{candidates_path}
结果文件：{output_path}

判定原则：
1. 按“触发条件→因果过程→剧情回报→失效边界”判断是否是同一机制，不按人名、道具、时代或题材名词判断。
2. 现有创作机制文件只包含系统为每条候选检索到的前置匹配。候选中的 retrieved_mechanism_ids 是该候选允许复用或优化的机制 ID；不要编造 ID，也不要因为标签不同而新建。
3. 现有机制已能无扭曲地解释候选机制时选 reuse；标签和来源由系统自动追加，不要因题材不同而新建。
4. 核心因果相同，但新案例补充了可复用步骤、回报或失效边界时选 improve，保留原 mechanism_id，用更概括、更准确的完整内容更新它。
   improve 必须兼容原机制已有的核心因果和适用条件，只能扩展边界或提高准确性；如果必须改写核心因果才能容纳新案例，应选 create。
5. 只有候选机制的因果结构无法被任一现有机制覆盖时才选 create。create 只会进入单本候选池，需获得第二部独立剧本的同构证据才会成为已验证机制。当前已有 {catalog_size} 条，数量不是目标，覆盖边界和辨识度才是目标。
6. 多个候选属于同一机制时，放在同一个 operation 的 candidate_keys 中；此时选用的 mechanism_id 必须同时出现在这些候选各自的 retrieved_mechanism_ids 中。每个候选 key 必须且只能出现一次。
7. 机制名和正文不得包含原剧人名、地名、组织名或专属道具；不得把一个特定场景换词后冒充通用机制。
8. reuse 只填 candidate_keys、action、mechanism_id、reason。improve 和 create 还必须填 title、function、trigger、payoff、transferable_strategy、failure_boundary。create 的 mechanism_id 留空。
9. 直接覆盖结果文件中已初始化的 JSON，不得修改其他文件，不得输出 Markdown。

结果结构固定为：
{{"operations":[{{"candidate_keys":["M01"],"action":"reuse|improve|create","mechanism_id":"","reason":"","title":"","function":"","trigger":"","payoff":"","transferable_strategy":"","failure_boundary":""}}]}}
""".strip()


def _validate_mechanism_curation(
    payload: Any,
    *,
    candidate_keys: set[str],
    existing_ids: set[str],
    allowed_existing_by_candidate: dict[str, set[str]] | None = None,
    forbidden_terms: set[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict) or not isinstance(payload.get("operations"), list):
        raise RuntimeError("创作机制精炼结果格式错误")
    operations = payload["operations"]
    if not operations:
        raise RuntimeError("创作机制精炼结果不能为空")
    seen_candidates: set[str] = set()
    seen_existing_targets: set[str] = set()
    normalized: list[dict[str, Any]] = []
    mechanism_rules = {
        "title": ("机制名称", 4, 80),
        "function": ("机制功能", 20, 600),
        "trigger": ("机制触发", 16, 600),
        "payoff": ("机制回报", 16, 600),
        "transferable_strategy": ("迁移策略", 30, 800),
        "failure_boundary": ("失效边界", 20, 600),
    }
    for index, item in enumerate(operations, start=1):
        if not isinstance(item, dict):
            raise RuntimeError(f"第 {index} 个创作机制操作格式错误")
        keys = _unique_strings(item.get("candidate_keys"), limit=len(candidate_keys))
        if not keys or any(key not in candidate_keys for key in keys):
            raise RuntimeError(f"第 {index} 个创作机制操作引用了无效候选")
        duplicate = seen_candidates.intersection(keys)
        if duplicate:
            raise RuntimeError(f"创作机制候选被重复处理：{'、'.join(sorted(duplicate))}")
        seen_candidates.update(keys)
        action = str(item.get("action") or "").strip().lower()
        if action not in {"reuse", "improve", "create"}:
            raise RuntimeError(f"第 {index} 个创作机制操作类型无效")
        mechanism_id = str(item.get("mechanism_id") or "").strip()
        if action in {"reuse", "improve"}:
            if mechanism_id not in existing_ids:
                raise RuntimeError(f"第 {index} 个操作未匹配到有效的现有机制")
            if allowed_existing_by_candidate is not None:
                allowed_for_operation = set.intersection(
                    *(allowed_existing_by_candidate.get(key, set()) for key in keys)
                )
                if mechanism_id not in allowed_for_operation:
                    raise RuntimeError(f"第 {index} 个操作未匹配到候选的检索机制")
            if mechanism_id in seen_existing_targets:
                raise RuntimeError(f"现有机制 {mechanism_id} 应在同一个操作中合并所有候选")
            seen_existing_targets.add(mechanism_id)
        elif mechanism_id:
            raise RuntimeError("新建创作机制时 mechanism_id 必须留空")
        operation = {
            "candidate_keys": keys,
            "action": action,
            "mechanism_id": mechanism_id,
            "reason": _required_text(item.get("reason"), label="机制判定理由", minimum=8, maximum=500),
        }
        if action in {"improve", "create"}:
            operation.update({
                field: _required_text(item.get(field), label=label, minimum=minimum, maximum=maximum)
                for field, (label, minimum, maximum) in mechanism_rules.items()
            })
            rendered = "\n".join(str(operation[field]) for field in mechanism_rules).lower()
            leaked_terms = [
                term for term in (forbidden_terms or set())
                if (
                    len(term.strip()) >= 2
                    and term.strip() not in CONTROLLED_TAG_VALUES
                    and term.strip().lower() in rendered
                )
            ]
            if leaked_terms:
                raise RuntimeError(f"公共机制中残留原剧专属词：{'、'.join(sorted(leaked_terms))}")
        normalized.append(operation)
    missing = candidate_keys.difference(seen_candidates)
    if missing:
        raise RuntimeError(f"创作机制候选未完成判定：{'、'.join(sorted(missing))}")
    return {"operations": normalized}


def _coalesce_mechanism_operations(payload: Any) -> dict[str, Any]:
    """Normalize split model operations before the strict curation gate.

    A model may describe one existing mechanism in multiple operations even
    though the contract asks for one operation per target. Merge only existing
    targets; create operations stay independent so the model cannot silently
    collapse genuinely different new mechanisms. The validator below still
    checks candidate ownership, retrieval authorization, and content quality.
    """
    operations = payload.get("operations") if isinstance(payload, dict) else None
    if not isinstance(operations, list):
        return payload
    merged: list[Any] = []
    by_existing_id: dict[str, dict[str, Any]] = {}
    for raw in operations:
        if not isinstance(raw, dict):
            merged.append(raw)
            continue
        action = str(raw.get("action") or "").strip().lower()
        mechanism_id = str(raw.get("mechanism_id") or "").strip()
        if action == "create" and mechanism_id:
            # New IDs are content-addressed by the service. Model-invented IDs
            # carry no business meaning and should not invalidate good work.
            merged.append({**raw, "mechanism_id": ""})
            continue
        if action not in {"reuse", "improve"} or not mechanism_id:
            merged.append(raw)
            continue
        current = by_existing_id.get(mechanism_id)
        if current is None:
            current = {**raw, "candidate_keys": list(raw.get("candidate_keys") or [])}
            by_existing_id[mechanism_id] = current
            merged.append(current)
            continue
        current["candidate_keys"] = [
            *current.get("candidate_keys", []),
            *list(raw.get("candidate_keys") or []),
        ]
        reasons = [str(current.get("reason") or "").strip(), str(raw.get("reason") or "").strip()]
        current["reason"] = "；".join(reason for reason in reasons if reason)
        if action == "improve" and current.get("action") != "improve":
            current.update({key: value for key, value in raw.items() if key not in {"candidate_keys", "reason"}})
        elif action == "improve":
            current_length = sum(len(str(current.get(key) or "")) for key in MECHANISM_CONTENT_FIELDS)
            raw_length = sum(len(str(raw.get(key) or "")) for key in MECHANISM_CONTENT_FIELDS)
            if raw_length > current_length:
                current.update({key: value for key, value in raw.items() if key not in {"candidate_keys", "reason"}})
    return {"operations": merged}


def _load_mechanism_curation_checkpoint(
    *,
    job_id: int,
    script_id: int,
    conn: sqlite3.Connection,
    catalog_payload: dict[str, Any],
    candidates_payload: dict[str, Any],
    candidates: list[dict[str, Any]],
    enriched_candidates: list[dict[str, Any]],
    retrieved_catalog: list[dict[str, Any]],
    forbidden_terms: set[str],
) -> dict[str, Any] | None:
    for source_job_id in _checkpoint_job_ids(
        conn,
        script_id=script_id,
        current_job_id=job_id,
    ):
        directory = _work_directory(source_job_id)
        try:
            prior_catalog = json.loads((directory / "mechanism-catalog.json").read_text(encoding="utf-8"))
            prior_candidates = json.loads((directory / "mechanism-candidates.json").read_text(encoding="utf-8"))
            if prior_catalog != catalog_payload or prior_candidates != candidates_payload:
                continue
            raw = extract_json_object((directory / "mechanism-decisions.json").read_text(encoding="utf-8"))
            validated = _validate_mechanism_curation(
                _coalesce_mechanism_operations(raw),
                candidate_keys={item["key"] for item in candidates},
                existing_ids={item["id"] for item in retrieved_catalog},
                allowed_existing_by_candidate={
                    item["key"]: set(item["retrieved_mechanism_ids"])
                    for item in enriched_candidates
                },
                forbidden_terms=forbidden_terms,
            )
        except (OSError, RuntimeError, json.JSONDecodeError):
            continue
        current_directory = _work_directory(job_id)
        (current_directory / "mechanism-decisions.json").write_text(
            _json(validated) + "\n",
            encoding="utf-8",
        )
        (current_directory / "mechanism-checkpoint.json").write_text(
            _json({
                "version": MECHANISM_CURATION_VERSION,
                "script_id": script_id,
                "source_job_id": source_job_id,
            }) + "\n",
            encoding="utf-8",
        )
        return validated
    return None


def _invoke_mechanism_curation(
    job_id: int,
    script: sqlite3.Row,
    result: dict[str, Any],
    conn: sqlite3.Connection,
    model_runtime: dict[str, Any] | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    directory = _work_directory(job_id)
    catalog_path = directory / "mechanism-catalog.json"
    candidates_path = directory / "mechanism-candidates.json"
    output_path = directory / "mechanism-decisions.json"
    log_path = directory / "mechanism-curation.log"
    catalog = _mechanism_catalog(conn)
    candidates = _mechanism_candidates(int(script["id"]), result)
    enriched_candidates, retrieved_catalog = attach_retrieval_matches(candidates, catalog, limit=5)
    catalog_payload = {"total_catalog_size": len(catalog), "mechanisms": retrieved_catalog}
    candidates_payload = {"candidates": enriched_candidates}
    catalog_path.write_text(_json(catalog_payload) + "\n", encoding="utf-8")
    candidates_path.write_text(_json(candidates_payload) + "\n", encoding="utf-8")
    checkpoint = _load_mechanism_curation_checkpoint(
        job_id=job_id,
        script_id=int(script["id"]),
        conn=conn,
        catalog_payload=catalog_payload,
        candidates_payload=candidates_payload,
        candidates=candidates,
        enriched_candidates=enriched_candidates,
        retrieved_catalog=retrieved_catalog,
        forbidden_terms=set(result["case_card"].get("source_specific_terms") or []),
    )
    if checkpoint is not None:
        return checkpoint, candidates
    mechanism_system = direct_skill_system_prompt("script-distillation")
    mechanism_prompt = f"""当前只做剧本蒸馏后的创作机制归档，不重新生成案例卡。请阅读下面的本剧机制候选和历史机制检索结果，为每个候选选择 reuse、improve 或 create，并只返回 JSON 对象 {{\"operations\": [...]}}。

规则：同一个已有机制可以承接多个候选；只有候选与历史机制在触发、因果和回报上确实一致时才 reuse；可以在已有机制上补充有效边界时 improve；没有可解释的历史机制才 create。公共机制不得残留本剧人名、地名、组织名、道具名或连续剧情。

历史机制检索结果：
{_json({"total_catalog_size": len(catalog), "mechanisms": retrieved_catalog})}

本剧候选：
{_json({"candidates": enriched_candidates})}

返回字段要求：每项必须包含 candidate_keys、action、mechanism_id、reason；improve/create 还必须包含 title、function、trigger、payoff、transferable_strategy、failure_boundary。create 的 mechanism_id 必须是空字符串，新 ID 由服务端生成，不得自行编号。没有历史机制时只能 create，不要返回候选之外的 candidate_keys。"""
    mechanism_runtime = dict(model_runtime) if isinstance(model_runtime, dict) else model_runtime
    if isinstance(mechanism_runtime, dict):
        mechanism_runtime["stream"] = True
        try:
            mechanism_runtime["max_tokens"] = min(max(2048, int(mechanism_runtime.get("max_tokens") or 12000)), 12000)
        except (TypeError, ValueError):
            mechanism_runtime["max_tokens"] = 12000
    last_error = ""
    validated = None
    for attempt in range(MODEL_RETRY_LIMIT + 1):
        current_prompt = mechanism_prompt
        if last_error:
            current_prompt += f"\n上一次调用未通过校验，请根据错误信息修复并返回完整 JSON：{last_error}"
        try:
            response = call_direct_model(
                system_prompt=mechanism_system,
                user_prompt=current_prompt,
                runtime=mechanism_runtime,
                log_path=log_path.with_name(f"{log_path.stem}-attempt-{attempt + 1}{log_path.suffix}"),
                timeout_seconds=30 * 60,
            )
            output_path.with_name(f"{output_path.stem}-attempt-{attempt + 1}.txt").write_text(response, encoding="utf-8")
            raw = extract_json_object(response)
            validated = _validate_mechanism_curation(
                _coalesce_mechanism_operations(raw),
                candidate_keys={item["key"] for item in candidates},
                existing_ids={item["id"] for item in retrieved_catalog},
                allowed_existing_by_candidate={
                    item["key"]: set(item["retrieved_mechanism_ids"])
                    for item in enriched_candidates
                },
                forbidden_terms=set(result["case_card"].get("source_specific_terms") or []),
            )
            break
        except Exception as exc:
            last_error = str(exc).strip() or exc.__class__.__name__
    if validated is None:
        raise RuntimeError(f"创作机制归档结果未通过校验（已重试 {MODEL_RETRY_LIMIT} 次）：{last_error}")
    output_path.write_text(_json(validated) + "\n", encoding="utf-8")
    (directory / "mechanism-checkpoint.json").write_text(
        _json({
            "version": MECHANISM_CURATION_VERSION,
            "script_id": int(script["id"]),
            "source_job_id": job_id,
        }) + "\n",
        encoding="utf-8",
    )
    return validated, candidates


def _applicable_tags_for_scripts(conn: sqlite3.Connection, script_ids: list[int]) -> list[str]:
    if not script_ids:
        return []
    placeholders = ",".join("?" for _ in script_ids)
    rows = conn.execute(
        f"""
        SELECT theme_tags_json, setting_tags_json, background_tags_json, audience_tags_json
        FROM script_library_scripts WHERE id IN ({placeholders})
        """,
        script_ids,
    ).fetchall()
    selected: set[str] = set()
    for row in rows:
        for column in TAG_FIELDS.values():
            selected.update(_unique_strings(_load_json(row[column], [])))
    ordered: list[str] = []
    for kind in TAG_FIELDS:
        ordered.extend(value for value in TAG_TAXONOMY[kind] if value in selected and value not in ordered)
    return ordered


def _refresh_linked_mechanism_tags(conn: sqlite3.Connection, *, script_id: int) -> None:
    rows = conn.execute(
        "SELECT id, source_script_ids_json FROM script_library_formula_cards WHERE formula_type = 'mechanism'"
    ).fetchall()
    for row in rows:
        source_ids = [
            int(value) for value in _load_json(row["source_script_ids_json"], [])
            if str(value).isdigit()
        ]
        if script_id not in source_ids:
            continue
        conn.execute(
            """
            UPDATE script_library_formula_cards
            SET applicable_tags_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            """,
            (_json(_applicable_tags_for_scripts(conn, source_ids)), row["id"]),
        )


def _mechanism_card_id(operation: dict[str, Any]) -> str:
    signature = "\n".join(str(operation[field]) for field in ("title", *MECHANISM_CONTENT_FIELDS))
    return f"mechanism-{hashlib.sha256(signature.encode('utf-8')).hexdigest()[:16]}"


def _mechanism_evidence(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "script_id": int(candidate["script_id"]),
        "candidate_key": str(candidate["key"]),
        "source_name": str(candidate["name"]),
        "evidence_references": list(candidate["evidence_references"]),
    }


def _detach_script_from_mechanisms(
    conn: sqlite3.Connection,
    *,
    script_id: int,
    preserve_ids: set[str],
) -> None:
    rows = conn.execute(
        "SELECT * FROM script_library_formula_cards WHERE formula_type = 'mechanism'"
    ).fetchall()
    for row in rows:
        source_ids = [
            int(value) for value in _load_json(row["source_script_ids_json"], [])
            if str(value).isdigit()
        ]
        if script_id not in source_ids:
            continue
        remaining = [value for value in source_ids if value != script_id]
        if not remaining and str(row["id"]) not in preserve_ids:
            conn.execute("DELETE FROM script_library_formula_cards WHERE id = ?", (row["id"],))
            continue
        content = _load_json(row["content_json"], {})
        evidence = [
            item for item in content.get("evidence", [])
            if isinstance(item, dict) and int(item.get("script_id") or 0) != script_id
        ]
        content["evidence"] = evidence
        content["curation_history"] = [
            item for item in content.get("curation_history", [])
            if isinstance(item, dict) and int(item.get("script_id") or 0) != script_id
        ]
        conn.execute(
            """
            UPDATE script_library_formula_cards
            SET applicable_tags_json = ?, source_script_ids_json = ?, source_count = ?,
                status = ?, content_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                _json(_applicable_tags_for_scripts(conn, remaining)), _json(remaining), len(remaining),
                "active" if len(remaining) >= MECHANISM_ACTIVATION_MIN_SOURCES else "candidate", _json(content), row["id"],
            ),
        )


def _apply_mechanism_curation(
    conn: sqlite3.Connection,
    *,
    script_id: int,
    curation: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    candidate_by_key = {item["key"]: item for item in candidates}
    preserve_ids = {
        operation["mechanism_id"]
        for operation in curation["operations"]
        if operation["action"] in {"reuse", "improve"}
    }
    _detach_script_from_mechanisms(conn, script_id=script_id, preserve_ids=preserve_ids)
    action_counts = {"reuse": 0, "improve": 0, "create": 0}
    mechanism_ids: list[str] = []
    for operation in curation["operations"]:
        action = operation["action"]
        mechanism_id = operation["mechanism_id"] if action != "create" else _mechanism_card_id(operation)
        row = conn.execute(
            "SELECT * FROM script_library_formula_cards WHERE id = ? AND formula_type = 'mechanism'",
            (mechanism_id,),
        ).fetchone()
        if action in {"reuse", "improve"} and not row:
            raise RuntimeError(f"待更新的创作机制不存在：{mechanism_id}")

        source_ids = [] if not row else [
            int(value) for value in _load_json(row["source_script_ids_json"], [])
            if str(value).isdigit()
        ]
        if script_id not in source_ids:
            source_ids.append(script_id)
        content = {} if not row else _load_json(row["content_json"], {})
        evidence = [item for item in content.get("evidence", []) if isinstance(item, dict)]
        evidence.extend(_mechanism_evidence(candidate_by_key[key]) for key in operation["candidate_keys"])
        history = [item for item in content.get("curation_history", []) if isinstance(item, dict)]
        history.append({
            "script_id": script_id,
            "action": action,
            "candidate_keys": list(operation["candidate_keys"]),
            "reason": operation["reason"],
        })

        if action == "reuse":
            title = str(row["title"])
            description = str(row["description"])
            fields = {field: str(content.get(field) or "") for field in MECHANISM_CONTENT_FIELDS}
            revision = int(content.get("revision") or 1)
        else:
            title = operation["title"]
            description = operation["function"]
            fields = {field: operation[field] for field in MECHANISM_CONTENT_FIELDS}
            revision = int(content.get("revision") or 0) + 1
        new_content = {
            **fields,
            "causal_fingerprint": causal_fingerprint({"name": title, **fields}),
            "evidence": evidence,
            "curation_history": history,
            "revision": revision,
            "curation_version": MECHANISM_CURATION_VERSION,
        }
        status_value = "active" if len(source_ids) >= MECHANISM_ACTIVATION_MIN_SOURCES else "candidate"
        conn.execute(
            """
            INSERT INTO script_library_formula_cards (
                id, formula_type, title, description, applicable_tags_json,
                source_script_ids_json, source_count, status, origin, content_json
            ) VALUES (?, 'mechanism', ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title, description = excluded.description,
                applicable_tags_json = excluded.applicable_tags_json,
                source_script_ids_json = excluded.source_script_ids_json,
                source_count = excluded.source_count, status = excluded.status,
                origin = excluded.origin, content_json = excluded.content_json,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                mechanism_id, title, description,
                _json(_applicable_tags_for_scripts(conn, source_ids)), _json(source_ids), len(source_ids),
                status_value, MECHANISM_ORIGIN, _json(new_content),
            ),
        )
        action_counts[action] += 1
        mechanism_ids.append(mechanism_id)
    return {"actions": action_counts, "mechanism_ids": mechanism_ids}


def _checkpoint_job_ids(
    conn: sqlite3.Connection,
    *,
    script_id: int,
    current_job_id: int,
    limit: int = 5,
) -> list[int]:
    previous = conn.execute(
        """
        SELECT id FROM script_distillation_jobs
        WHERE script_id = ? AND id < ? AND status IN ('failed', 'canceled')
        ORDER BY id DESC LIMIT ?
        """,
        (script_id, current_job_id, max(1, limit)),
    ).fetchall()
    return [current_job_id, *(int(row["id"]) for row in previous)]


def _legacy_result_checkpoint(
    *,
    job_ids: list[int],
) -> tuple[dict[str, Any], int, str] | None:
    """Find a pre-staged result that can be repaired instead of re-reading all stages."""
    for source_job_id in job_ids:
        directory = _work_directory(source_job_id)
        result_path = directory / "result.json"
        if not result_path.is_file() or (directory / "pipeline.json").is_file():
            continue
        try:
            raw = extract_json_object(result_path.read_text(encoding="utf-8"))
        except (OSError, RuntimeError, json.JSONDecodeError):
            continue
        return raw, source_job_id, ""
    return None


def _indexed_source(conn: sqlite3.Connection, script_id: int) -> tuple[str, set[str]]:
    rows = conn.execute(
        "SELECT * FROM script_library_source_chunks WHERE script_id = ? ORDER BY chunk_index", (script_id,)
    ).fetchall()
    valid: set[str] = set()
    sections: list[str] = []
    for row in rows:
        chunk_id = f"C{int(row['chunk_index']):04d}"
        valid.add(chunk_id)
        sections.append(f"\n<!-- {chunk_id} | {row['locator']} -->\n{row['content']}")
    return "\n".join(sections).strip() + "\n", valid


def _pipeline_source_chunks(conn: sqlite3.Connection, script_id: int) -> list[dict[str, str]]:
    return [
        {
            "id": f"C{int(row['chunk_index']):04d}",
            "locator": str(row["locator"]),
            "raw_content": str(row["content"]),
            "content": str(row["content"]),
        }
        for row in conn.execute(
            "SELECT * FROM script_library_source_chunks WHERE script_id = ? ORDER BY chunk_index",
            (script_id,),
        ).fetchall()
    ]


def _indexed_source_content_hash(conn: sqlite3.Connection, script_id: int) -> str:
    rows = conn.execute(
        "SELECT content FROM script_library_source_chunks WHERE script_id = ? ORDER BY chunk_index",
        (script_id,),
    ).fetchall()
    return hashlib.sha256("\n\n".join(str(row["content"]) for row in rows).encode("utf-8")).hexdigest()


def _write_distillation_checkpoint(
    *,
    job_id: int,
    source_job_id: int,
    script: sqlite3.Row,
    indexed_source: str,
    result: dict[str, Any],
) -> None:
    directory = _work_directory(job_id)
    (directory / "indexed-source.md").write_text(indexed_source, encoding="utf-8")
    (directory / "result.json").write_text(_json(result) + "\n", encoding="utf-8")
    (directory / "distillation-checkpoint.json").write_text(
        _json({
            "version": DISTILLATION_VERSION,
            "script_id": int(script["id"]),
            "source_sha256": str(script["source_sha256"]),
            "source_job_id": source_job_id,
        }) + "\n",
        encoding="utf-8",
    )


def _load_distillation_checkpoint(
    job_id: int,
    script: sqlite3.Row,
    conn: sqlite3.Connection,
) -> tuple[dict[str, Any], int] | None:
    indexed_source, valid_chunk_ids = _indexed_source(conn, int(script["id"]))
    indexed_content_sha256 = _indexed_source_content_hash(conn, int(script["id"]))
    for source_job_id in _checkpoint_job_ids(
        conn,
        script_id=int(script["id"]),
        current_job_id=job_id,
    ):
        path = _work_directory(source_job_id) / "result.json"
        if not path.is_file():
            continue
        try:
            raw = extract_json_object(path.read_text(encoding="utf-8"))
            try:
                result = validate_knowledge_distillation(
                    raw,
                    valid_chunk_ids,
                    source_text=indexed_source,
                    expected_title=str(script["title"]),
                    expected_sha256=indexed_content_sha256,
                )
                _assert_distillation_grounding(result, indexed_source)
            except RuntimeError:
                # Keep genuinely old checkpoints readable. A new three-layer
                # result must not bypass the grounding gate through the legacy
                # validator when its content is about another script.
                if isinstance(raw, dict) and (
                    raw.get("schema_version") == "1.0.0" or "formula_candidates" in raw
                ):
                    raise
                result = _validate_distillation(raw, valid_chunk_ids, source_text=indexed_source)
        except (OSError, RuntimeError, json.JSONDecodeError):
            continue
        _write_distillation_checkpoint(
            job_id=job_id,
            source_job_id=source_job_id,
            script=script,
            indexed_source=indexed_source,
            result=result,
        )
        return result, source_job_id
    return None


def distillation_prompt(source_path: Path, *, output_path: Path | None = None) -> str:
    delivery = (
        f"直接覆盖 {output_path} 中已初始化的 JSON，不得修改其他文件，不得输出 Markdown。"
        if output_path
        else "最终只输出符合给定 JSON Schema 的对象。"
    )
    return f"""
你要把一部短剧完整蒸馏为一张案例卡、零到少量公式候选和原则观察。必须从头到尾阅读带 C0001 证据编号的原文，不能只看简介或开头。

原文路径：{source_path}
受控标签词表：
{json.dumps(tag_taxonomy(), ensure_ascii=False, indent=2)}

案例卡记录本剧事实和原文证据；公式候选必须对应创作阶段和具体创作决策，包含条件、变量、步骤、生效原因、检查项、失效边界、改写用法、新创作用法和题材适配；原则只保留待审核观察，不能直接发布。不要为了凑数量生成公式，没有价值时填写 no_formula_reason。{delivery}
    """.strip()


def direct_distillation_prompt(
    *,
    title: str,
    indexed_source: str,
    schema: dict[str, Any],
    source_sha256: str = "",
    chunk_count: int = 0,
    repair: str = "",
    previous_result: dict[str, Any] | None = None,
) -> str:
    schema_text = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    source_block = ""
    source_bytes = len((indexed_source or "").encode("utf-8"))
    use_full_source = previous_result is None and (not repair or source_bytes <= 120000)
    if use_full_source:
        source_block = f"""原文（必须从头到尾阅读）：
<indexed_source>
{indexed_source}
</indexed_source>"""
    else:
        anchor = _distillation_source_anchor(indexed_source)
        names = _source_character_anchors(indexed_source)
        source_block = f"""原文证据锚点（修复时以此为准；上一次 JSON 与这里冲突时必须丢弃上一次事实）：
<source_anchor>
{anchor}
</source_anchor>
原文主要人物锚点：{'、'.join(names) if names else '未能从原文结构中自动提取，请逐字依据证据锚点'}

{'长文本修复请求只提供了分段锚点；不得把未出现在锚点中的人物、事件或设定当作事实。' if previous_result is None else ''}
"""
        if previous_result is not None:
            source_block += f"""上一次模型返回的完整 JSON（只把它当作字段结构参考，不得沿用与原文冲突的人名、项目名、关系或剧情）：

<previous_result>
{json.dumps(previous_result, ensure_ascii=False, separators=(",", ":"))}
</previous_result>"""
        else:
            source_block += "原文证据锚点用于重新生成完整结果。只根据锚点和已编号证据作答，不得引用其他剧本。"
    repair_block = (
        f"\n上一次结果未通过确定性校验，请只修复这些问题后重新返回完整 JSON：\n{repair}\n"
        if repair else ""
    )
    stages = "、".join(CREATIVE_STAGES)
    categories = "、".join(FORMULA_CATEGORIES)
    return f"""请执行“{title}”的单剧蒸馏。证据编号是原文中的唯一回查依据。

这是后台持久化所需的 JSON Schema。只返回一个符合该 Schema 的 JSON 对象，不要返回 Markdown、解释、代码围栏或额外字段：
{schema_text}

原文标题：{title}
原文元数据（必须原样写入 source）：content_sha256={source_sha256}，chunk_count={chunk_count}
{source_block}

直接执行约束：
1. 本次是独立知识处理任务，不要使用编剧项目的 CLAUDE.md、用户偏好或其他 skill。
2. 按独立剧本蒸馏 Skill 的原则完成标签、案例卡、公式候选和创作原则观察；所有标签必须来自受控词表。
3. 不能把原剧本的前置分类当作答案，背景按全剧主要戏剧任务判断。
4. 所有事实和机制都必须能用 C0001 格式证据回查；公式必须去除原剧专名并可迁移。
5. `stage` 和 `stages` 是“使用这条写法的创作阶段”，只能从以下列表选择：{stages}。
6. `category` 是公式分类，只能从以下列表选择：{categories}。`emotional_progression` 等公式分类绝不能填写到 `stage` 或 `stages`；二者不是同一组枚举。
7. 只返回完整对象，不能省略字段，也不能把“待定”写成空的必填字段。
8. 如果这是校验修复请求，先用原文证据锚点核对主角、关系和主要事件；不得把另一部剧的内容改写进来，也不得为了通过校验编造原文没有的专名。
{repair_block}""".strip()


def _distillation_runtime(
    model_runtime: dict[str, Any] | None,
    *,
    source_chars: int = 0,
) -> dict[str, Any] | None:
    """Tune the direct request without changing the administrator's model choice."""
    if not isinstance(model_runtime, dict):
        return model_runtime
    runtime = dict(model_runtime)
    try:
        configured_max_tokens = int(runtime.get("max_tokens") or DISTILLATION_MAX_OUTPUT_TOKENS)
    except (TypeError, ValueError):
        configured_max_tokens = DISTILLATION_MAX_OUTPUT_TOKENS
    runtime["max_tokens"] = min(max(4096, configured_max_tokens), DISTILLATION_MAX_OUTPUT_TOKENS)
    if source_chars >= 50000:
        # A 90k-character script plus the skill and schema can exceed the
        # gateway's practical context/latency budget. This task is extraction,
        # so keep the request streaming and use a small reasoning budget for
        # every long source, rather than spending minutes on hidden reasoning.
        runtime["thinking_level"] = "low"
        runtime["thinking_budget_tokens"] = 0
        runtime["max_tokens"] = min(runtime["max_tokens"], 16000)
    # Streaming prevents a gateway from timing out while the model is thinking
    # over a long script. Providers that ignore this flag are handled by the
    # direct runner's normal JSON-envelope fallback.
    runtime["stream"] = True
    return runtime


def _repair_stage_aliases(payload: dict[str, Any]) -> list[dict[str, str]]:
    """Repair only an exact formula-category/stage mix-up as a last resort."""
    changes: list[dict[str, str]] = []
    repaired = json.loads(json.dumps(payload, ensure_ascii=False))
    sections: list[tuple[str, list[Any], str]] = [
        ("case_card.key_observations", repaired.get("case_card", {}).get("key_observations", []), "stage"),
        ("formula_candidates", repaired.get("formula_candidates", []), "stages"),
        ("principle_observations", repaired.get("principle_observations", []), "stages"),
    ]
    for section_name, items, field in sections:
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            values = item.get(field)
            if field == "stage":
                values = [values]
            if not isinstance(values, list):
                continue
            changed_values = []
            changed = False
            for value in values:
                replacement = DISTILLATION_STAGE_ALIASES.get(str(value))
                if replacement:
                    changes.append({
                        "field": f"{section_name}[{index}].{field}",
                        "from": str(value),
                        "to": replacement,
                    })
                    changed_values.append(replacement)
                    changed = True
                else:
                    changed_values.append(value)
            if changed:
                item[field] = changed_values[0] if field == "stage" else changed_values
    if not changes:
        return []
    payload.clear()
    payload.update(repaired)
    return changes


def _write_distillation_repair_log(directory: Path, changes: list[dict[str, str]]) -> None:
    (directory / "distillation-repair.json").write_text(
        _json({
            "kind": "controlled_stage_alias",
            "message": "模型把公式分类写入创作阶段字段，服务端按固定映射修复；其他未知值仍会失败。",
            "changes": changes,
        }) + "\n",
        encoding="utf-8",
    )


# 兼容旧维护脚本保留。后台任务入口统一使用 run_distillation_pipeline，
# 不再从这里发起整部原文的一次性模型请求。
def _invoke_distillation(
    job_id: int,
    script: sqlite3.Row,
    conn: sqlite3.Connection,
    model_runtime: dict[str, Any] | None,
    *,
    previous_result: dict[str, Any] | None = None,
    repair_error: str = "",
) -> dict[str, Any]:
    directory = _work_directory(job_id)
    source_path = directory / "indexed-source.md"
    output_path = directory / "result.json"
    log_path = directory / "run.log"
    indexed_source, valid_chunk_ids = _indexed_source(conn, int(script["id"]))
    source_rows = conn.execute(
        "SELECT content FROM script_library_source_chunks WHERE script_id = ? ORDER BY chunk_index",
        (int(script["id"]),),
    ).fetchall()
    indexed_content_sha256 = hashlib.sha256(
        "\n\n".join(str(row["content"]) for row in source_rows).encode("utf-8")
    ).hexdigest()
    source_path.write_text(indexed_source, encoding="utf-8")
    output_path.write_text(_json({}) + "\n", encoding="utf-8")
    runtime = _distillation_runtime(model_runtime, source_chars=len(indexed_source.encode("utf-8")))
    if isinstance(runtime, dict):
        (directory / "request-config.json").write_text(
            _json({
                "model": runtime.get("model_name"),
                "thinking_level": runtime.get("thinking_level"),
                "thinking_budget_tokens": runtime.get("thinking_budget_tokens"),
                "max_tokens": runtime.get("max_tokens"),
                "stream": runtime.get("stream"),
                "source_bytes": len(indexed_source.encode("utf-8")),
            }) + "\n",
            encoding="utf-8",
        )
    system_prompt = direct_skill_system_prompt(
        "script-distillation",
        task_contract="single_script_distillation",
        supporting_skills=(
            "script-case-card",
            "script-formula-distillation",
            "script-principle-distillation",
        ),
    )
    schema = knowledge_distillation_output_schema()
    prompt = direct_distillation_prompt(
        title=str(script["title"]),
        indexed_source=indexed_source,
        schema=schema,
        source_sha256=indexed_content_sha256,
        chunk_count=len(valid_chunk_ids),
        repair=repair_error,
        previous_result=previous_result,
    )
    last_error = ""
    for attempt in range(DISTILLATION_VALIDATION_ATTEMPTS):
        try:
            response = call_direct_model(
                system_prompt=system_prompt,
                user_prompt=prompt,
                runtime=runtime,
                log_path=log_path,
                timeout_seconds=DISTILLATION_REQUEST_TIMEOUT_SECONDS,
            )
            output_path.write_text(response, encoding="utf-8")
            raw = extract_json_object(response)
            try:
                result = validate_knowledge_distillation(
                    raw,
                    valid_chunk_ids,
                    source_text=indexed_source,
                    expected_title=str(script["title"]),
                    expected_sha256=indexed_content_sha256,
                )
                _assert_distillation_grounding(result, indexed_source)
            except (RuntimeError, json.JSONDecodeError) as validation_error:
                last_error = str(validation_error)
                if attempt < DISTILLATION_VALIDATION_ATTEMPTS - 1:
                    # The repair request contains the previous JSON instead of
                    # the entire script, which keeps a failed validation cheap.
                    # If the model described another script, retaining its
                    # JSON biases the next answer toward the wrong facts. A
                    # grounding failure therefore starts from the source
                    # again; structural errors can safely reuse the object.
                    prior = None if any(token in last_error for token in ("原文中无法回查", "主要人物不一致")) else raw
                    prompt = direct_distillation_prompt(
                        title=str(script["title"]),
                        indexed_source=indexed_source,
                        schema=schema,
                        source_sha256=indexed_content_sha256,
                        chunk_count=len(valid_chunk_ids),
                        repair=last_error,
                        previous_result=prior,
                    )
                    continue
                changes = _repair_stage_aliases(raw)
                if not changes:
                    raise
                result = validate_knowledge_distillation(
                    raw,
                    valid_chunk_ids,
                    source_text=indexed_source,
                    expected_title=str(script["title"]),
                    expected_sha256=indexed_content_sha256,
                )
                _assert_distillation_grounding(result, indexed_source)
                _write_distillation_repair_log(directory, changes)
            _write_distillation_checkpoint(
                job_id=job_id,
                source_job_id=job_id,
                script=script,
                indexed_source=indexed_source,
                result=result,
            )
            (directory / "pipeline.json").write_text(
                _json({
                    "version": PIPELINE_VERSION,
                    "job_id": job_id,
                    "script_id": int(script["id"]),
                    "source_sha256": indexed_content_sha256,
                    "chunk_count": len(valid_chunk_ids),
                    "completed": True,
                    "compatibility_repair": previous_result is not None,
                }) + "\n",
                encoding="utf-8",
            )
            return result
        except (RuntimeError, json.JSONDecodeError) as exc:
            last_error = str(exc)
            if attempt < DISTILLATION_VALIDATION_ATTEMPTS - 1:
                # Transport errors do not have a previous JSON object to
                # repair; retry with the same compact contract. The direct
                # runner handles transient HTTP retries and configured
                # fallback models.
                if "蒸馏结果未通过校验" not in last_error:
                    prompt = direct_distillation_prompt(
                        title=str(script["title"]),
                        indexed_source=indexed_source,
                        schema=schema,
                        source_sha256=indexed_content_sha256,
                        chunk_count=len(valid_chunk_ids),
                        repair=last_error,
                    )
                continue
    raise RuntimeError(f"蒸馏结果未通过校验（已重试 {MODEL_RETRY_LIMIT} 次）：{last_error}")


def _save_distillation(
    conn: sqlite3.Connection,
    script: sqlite3.Row,
    result: dict[str, Any],
    *,
    version: str = DISTILLATION_VERSION,
    formula_origin: str = "manual-ai",
) -> None:
    if "formula_candidates" in result and "schema_version" in result:
        save_knowledge_distillation(conn, script, result)
        return
    tags = result["tags"]
    conn.execute(
        """
        UPDATE script_library_scripts
        SET status = 'ready', summary = ?, theme_tags_json = ?, setting_tags_json = ?,
            background_tags_json = ?, audience_tags_json = ?, case_card_json = ?, formulas_json = ?,
            distillation_version = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            result["summary"], _json(tags["theme"]), _json(tags["setting"]),
            _json(tags["background"]), _json(tags["audience"]), _json(result["case_card"]),
            _json(result["formulas"]), version, script["id"],
        ),
    )
    all_tags = [*tags["theme"], *tags["setting"], *tags["background"], *tags["audience"]]
    labels = {"core": "剧本内核", "world": "世界观", "gratification": "爽点"}
    card_prefix = re.sub(r"[^a-z0-9-]+", "-", formula_origin.lower()).strip("-") or "distilled"
    conn.execute(
        """
        DELETE FROM script_library_formula_cards
        WHERE status = 'candidate' AND formula_type != 'mechanism' AND source_script_ids_json = ?
        """,
        (_json([int(script["id"])]),),
    )
    for formula_type, description in result["formulas"].items():
        card_id = f"{card_prefix}-{script['id']}-{formula_type}"
        conn.execute(
            """
            INSERT INTO script_library_formula_cards (
                id, formula_type, title, description, applicable_tags_json,
                source_script_ids_json, source_count, status, origin, content_json
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 'candidate', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title, description = excluded.description,
                applicable_tags_json = excluded.applicable_tags_json,
                source_script_ids_json = excluded.source_script_ids_json,
                source_count = 1, status = 'candidate', origin = excluded.origin,
                content_json = excluded.content_json, updated_at = CURRENT_TIMESTAMP
            """,
            (
                card_id, formula_type, f"{script['title']} · {labels[formula_type]}", description,
                _json(all_tags), _json([int(script["id"])]), formula_origin,
                _json({"formula": description, "distillation_version": version}),
            ),
        )


def _save_batch_case_card(
    conn: sqlite3.Connection,
    script: sqlite3.Row,
    result: dict[str, Any],
) -> None:
    """Persist the per-script boundary of the batch library initialization.

    Batch initialization deliberately stops after facts, tags and the case
    card.  Formulas and principles are created later from multiple case cards;
    saving them here would recreate the old one-script-one-card problem.
    """
    tags = result.get("tags") or {}
    conn.execute(
        """
        UPDATE script_library_scripts
        SET status = 'processing', summary = ?, theme_tags_json = ?, setting_tags_json = ?,
            background_tags_json = ?, audience_tags_json = ?, case_card_json = ?,
            formulas_json = '{}', distillation_result_json = ?, distillation_version = ?,
            distillation_stage = 'case_card', distillation_stage_label = '案例卡已完成',
            distillation_progress_current = distillation_progress_total,
            distillation_progress_message = '等待全库公式和创作原则整理',
            error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            str(result.get("summary") or ""),
            _json(tags.get("theme") or []),
            _json(tags.get("setting") or []),
            _json(tags.get("background") or []),
            _json(tags.get("audience") or []),
            _json(result.get("case_card") or {}),
            _json(result),
            DISTILLATION_VERSION,
            int(script["id"]),
        ),
    )


def _claim_job(conn: sqlite3.Connection, job_id: int) -> sqlite3.Row | None:
    parallel_limit = max(1, int(getattr(settings, "script_distillation_max_parallel", 3)))
    result = conn.execute(
        """
        UPDATE script_distillation_jobs
        SET status = 'running', started_at = CURRENT_TIMESTAMP, error_message = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
          AND NOT EXISTS (
              SELECT 1 FROM script_distillation_jobs AS active
              WHERE active.status = 'running'
              GROUP BY active.status
              HAVING COUNT(*) >= ?
          )
        """,
        (job_id, parallel_limit),
    )
    if result.rowcount != 1:
        return None
    conn.execute(
        """
        UPDATE script_library_scripts SET status = 'processing', error_message = NULL,
            distillation_stage = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN distillation_stage ELSE 'source_facts' END,
            distillation_stage_label = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN distillation_stage_label ELSE '读取原文' END,
            distillation_progress_message = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN '正在继续已完成阶段' ELSE '正在准备原文证据' END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = (SELECT script_id FROM script_distillation_jobs WHERE id = ?)
        """,
        (job_id,),
    )
    return conn.execute("SELECT * FROM script_distillation_jobs WHERE id = ?", (job_id,)).fetchone()


def run_script_distillation_job(job_id: int, *, _already_claimed: bool = False) -> None:
    with get_connection() as conn:
        job = (
            conn.execute("SELECT * FROM script_distillation_jobs WHERE id = ? AND status = 'running'", (job_id,)).fetchone()
            if _already_claimed
            else _claim_job(conn, job_id)
        )
        if not job:
            return
        job = ensure_persisted_model_snapshot(
            conn,
            table_name="script_distillation_jobs",
            row=job,
            route_keys=(("script_library", "distill"), ("script_library", "formula_curation")),
        )
        script = conn.execute("SELECT * FROM script_library_scripts WHERE id = ?", (job["script_id"],)).fetchone()
        batch_case_only = str(script["distillation_mode"] or "single") == "batch_case"
        model_runtime = runtime_from_snapshot(
            job["model_config_snapshot_json"], scenario_key="script_library", action_key="distill"
        )
        curation_runtime = runtime_from_snapshot(
            job["model_config_snapshot_json"], scenario_key="script_library", action_key="formula_curation"
        ) or model_runtime
        conn.commit()
        try:
            previous_job_ids = [
                item
                for item in _checkpoint_job_ids(
                    conn,
                    script_id=int(script["id"]),
                    current_job_id=job_id,
                )
                if item != job_id
            ]
            work_dir = _work_directory(job_id)
            previous_work_dirs = [_work_directory(item) for item in previous_job_ids]
            legacy_checkpoint = _legacy_result_checkpoint(job_ids=[job_id, *previous_job_ids])
            if legacy_checkpoint is not None and not batch_case_only:
                legacy_result, legacy_job_id, _ = legacy_checkpoint
                source_rows = conn.execute(
                    "SELECT content FROM script_library_source_chunks WHERE script_id = ? ORDER BY chunk_index",
                    (int(script["id"]),),
                ).fetchall()
                indexed_source, valid_chunk_ids = _indexed_source(conn, int(script["id"]))
                indexed_sha256 = hashlib.sha256(
                    "\n\n".join(str(row["content"]) for row in source_rows).encode("utf-8")
                ).hexdigest()
                try:
                    result = validate_knowledge_distillation(
                        legacy_result,
                        valid_chunk_ids,
                        source_text=indexed_source,
                        expected_title=str(script["title"]),
                        expected_sha256=indexed_sha256,
                    )
                    _assert_distillation_grounding(result, indexed_source)
                    _write_distillation_checkpoint(
                        job_id=job_id,
                        source_job_id=legacy_job_id,
                        script=script,
                        indexed_source=indexed_source,
                        result=result,
                    )
                    (work_dir / "pipeline.json").write_text(
                        _json({
                            "version": PIPELINE_VERSION,
                            "job_id": job_id,
                            "script_id": int(script["id"]),
                            "source_sha256": indexed_sha256,
                            "chunk_count": len(valid_chunk_ids),
                            "completed": True,
                            "compatibility_checkpoint": True,
                        }) + "\n",
                        encoding="utf-8",
                    )
                except (RuntimeError, json.JSONDecodeError):
                    legacy_job = conn.execute(
                        "SELECT error_message FROM script_distillation_jobs WHERE id = ?",
                        (legacy_job_id,),
                    ).fetchone()
                    result = _invoke_distillation(
                        job_id,
                        script,
                        conn,
                        model_runtime,
                        previous_result=legacy_result,
                        repair_error=str(legacy_job["error_message"] or "") if legacy_job else "",
                    )
            else:
                result = run_distillation_pipeline(
                    conn=conn,
                    job_id=job_id,
                    script=script,
                    indexed_chunks=_pipeline_source_chunks(conn, int(script["id"])),
                    model_runtime=model_runtime,
                    work_dir=work_dir,
                    previous_work_dirs=previous_work_dirs,
                    case_only=batch_case_only,
                )
            if batch_case_only:
                with KNOWLEDGE_CURATION_LOCK:
                    conn.execute("SAVEPOINT batch_case_write")
                    try:
                        _save_batch_case_card(conn, script, result)
                        conn.execute("RELEASE SAVEPOINT batch_case_write")
                    except Exception:
                        conn.execute("ROLLBACK TO SAVEPOINT batch_case_write")
                        conn.execute("RELEASE SAVEPOINT batch_case_write")
                        raise
                    conn.execute(
                        """
                        UPDATE script_distillation_jobs
                        SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (job_id,),
                    )
                    record_system_audit(
                        conn,
                        action="script_library.distillation.case_card_succeeded",
                        target_type="script_library_script",
                        target_id=script["id"],
                        target_label=script["title"],
                        details={"job_id": job_id, "mode": "batch_case"},
                    )
                    conn.commit()
                return
            # Retrieval and catalog mutation share one lock so concurrent jobs
            # cannot all make decisions against the same stale formula catalog.
            with KNOWLEDGE_CURATION_LOCK:
                formula_curation = invoke_formula_curation(
                    conn=conn,
                    result=result,
                    work_dir=work_dir,
                    model_runtime=curation_runtime,
                    previous_work_dirs=previous_work_dirs,
                )
                principle_curation = invoke_principle_curation(
                    conn=conn,
                    result=result,
                    work_dir=work_dir,
                    model_runtime=curation_runtime,
                    previous_work_dirs=previous_work_dirs,
                )
                conn.execute("SAVEPOINT distillation_write")
                try:
                    _save_distillation(conn, script, result)
                    formula_summary = apply_formula_curation(
                        conn,
                        script_id=int(script["id"]),
                        result=result,
                        curation=formula_curation,
                    )
                    principle_summary = apply_principle_curation(
                        conn,
                        script_id=int(script["id"]),
                        result=result,
                        curation=principle_curation,
                        candidate_to_formula=formula_summary["candidate_to_formula"],
                    )
                    conn.execute(
                        """
                        UPDATE script_library_scripts
                        SET distillation_version = ?, distillation_stage = 'completed',
                            distillation_stage_label = '已完成',
                            distillation_progress_current = distillation_progress_total,
                            distillation_progress_message = '案例卡、公式卡和创作原则已完成归档',
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (DISTILLATION_VERSION, int(script["id"])),
                    )
                    conn.execute("RELEASE SAVEPOINT distillation_write")
                except Exception:
                    conn.execute("ROLLBACK TO SAVEPOINT distillation_write")
                    conn.execute("RELEASE SAVEPOINT distillation_write")
                    raise
                conn.execute(
                    """
                    UPDATE script_distillation_jobs
                    SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (job_id,),
                )
                record_system_audit(
                    conn,
                    action="script_library.distillation.succeeded",
                    target_type="script_library_script",
                    target_id=script["id"],
                    target_label=script["title"],
                    details={
                        "job_id": job_id,
                        "version": DISTILLATION_VERSION,
                        "distillation_checkpoint_source_job_ids": previous_job_ids,
                        "formula_curation": formula_summary,
                        "principle_curation": principle_summary,
                    },
                )
                conn.commit()
        except Exception as exc:
            message = str(exc).strip()[-1500:] or "蒸馏失败"
            conn.execute(
                """
                UPDATE script_distillation_jobs
                SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?
                """,
                (message, job_id),
            )
            conn.execute(
                """
                UPDATE script_library_scripts
                SET status = 'failed', error_message = ?,
                    distillation_progress_message = CASE
                        WHEN distillation_stage_label != '' THEN distillation_stage_label || '未完成：' || ?
                        ELSE '蒸馏未完成：' || ?
                    END,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?
                """,
                (message, message, message, script["id"]),
            )
            record_system_audit(
                conn,
                action="script_library.distillation.failed",
                target_type="script_library_script",
                target_id=script["id"],
                target_label=script["title"],
                outcome="failure",
                severity="warning",
                details={"job_id": job_id, "message": message},
            )
        conn.commit()


def queued_distillation_job_ids(limit: int | None = None) -> list[int]:
    with get_connection() as conn:
        parallel_limit = max(1, int(getattr(settings, "script_distillation_max_parallel", 3)))
        running = int(conn.execute("SELECT COUNT(*) FROM script_distillation_jobs WHERE status = 'running'").fetchone()[0])
        available = max(0, parallel_limit - running)
        if limit is not None:
            available = min(available, max(0, int(limit)))
        if not available:
            return []
        return [
            int(row["id"])
            for row in conn.execute("SELECT id FROM script_distillation_jobs WHERE status = 'queued' ORDER BY id LIMIT ?", (available,)).fetchall()
        ]


def recover_distillation_jobs(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE script_distillation_jobs SET status = 'queued', started_at = NULL,
            updated_at = CURRENT_TIMESTAMP WHERE status = 'running'
        """
    )
    conn.execute(
        """
        UPDATE script_library_scripts SET status = 'queued',
            distillation_stage = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN distillation_stage ELSE 'queued' END,
            distillation_stage_label = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN distillation_stage_label ELSE '等待处理' END,
            distillation_progress_message = CASE
                WHEN COALESCE(distillation_progress_total, 0) > 0
                     AND distillation_stage NOT IN ('queued', 'completed')
                THEN '上次处理已中断，将从已完成阶段继续' ELSE '上次处理已中断，等待继续' END,
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'processing' AND EXISTS (
            SELECT 1 FROM script_distillation_jobs AS job
            WHERE job.script_id = script_library_scripts.id AND job.status = 'queued'
        )
        """
    )


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
    return rows


def _decrypt_source(path: Path) -> str:
    environment = dict(os.environ)
    environment["VSDW_FULL_SCRIPT_KEY"] = FULL_SCRIPT_KEY
    result = subprocess.run(
        [
            "openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "20000", "-md", "sha256",
            "-in", str(path), "-pass", "env:VSDW_FULL_SCRIPT_KEY",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    if result.returncode != 0:
        raise RuntimeError(f"无法解密首批剧本：{path.name}")
    text = result.stdout.decode("utf-8", errors="ignore")
    if "## 正文" in text:
        text = text.split("## 正文", 1)[1]
    return text.strip()


def import_short_writing_skill(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    source_root: Path | None = None,
) -> dict[str, Any]:
    root = (source_root or DEFAULT_SHORT_WRITING_SKILL).expanduser().resolve()
    manifest_path = root / "assets/library/script_manifest.jsonl"
    if not manifest_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到首批剧本资料")
    manifest = _read_jsonl(manifest_path)
    full_manifest = {str(item.get("id")): item for item in _read_jsonl(root / "assets/full-scripts/manifest.jsonl")}
    imported = 0
    skipped = 0
    queued = 0
    for item in manifest:
        script_key = str(item.get("id") or "")
        full_key = f"fs{script_key.removeprefix('s')}"
        full_item = full_manifest.get(full_key)
        if not full_item:
            skipped += 1
            continue
        source_hash = str(full_item.get("plaintext_sha256") or "")
        existing = conn.execute("SELECT id FROM script_library_scripts WHERE source_sha256 = ?", (source_hash,)).fetchone()
        if existing:
            skipped += 1
            continue
        text = _decrypt_source(root / "assets/full-scripts" / str(full_item["filename"]))
        actual_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        stored_hash = source_hash if source_hash else actual_hash
        source_path = _write_source(stored_hash, text)
        category = str(item.get("category") or "未分类")
        source_error = _bootstrap_source_error(text)
        can_distill = source_error is None
        cursor = conn.execute(
            """
            INSERT INTO script_library_scripts (
                title, source_type, source_label, original_filename, source_file_path,
                source_sha256, chars, episode_count, status, error_message, created_by
            ) VALUES (?, 'short-writing-skill', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(item.get("title") or "未命名剧本"), str(item.get("source_label") or category),
                Path(str(item.get("source_label") or item.get("title") or "script.md")).name,
                str(source_path), stored_hash, len(text), item.get("episode_count"),
                "queued" if can_distill else "failed",
                source_error,
                actor["id"],
            ),
        )
        script_id = int(cursor.lastrowid)
        _replace_chunks(conn, script_id, text)
        if can_distill:
            conn.execute(
                "INSERT INTO script_distillation_jobs (script_id, requested_by) VALUES (?, ?)",
                (script_id, actor["id"]),
            )
            queued += 1
        imported += 1
    record_audit(
        conn,
        actor=actor,
        action="script_library.bootstrap.import",
        target_type="script_library",
        target_label="首版剧本库",
        details={"imported": imported, "skipped": skipped, "queued": queued, "source": str(root)},
    )
    return {"imported": imported, "skipped": skipped, "queued": queued, "formula_cards": 0, "total": len(manifest)}
