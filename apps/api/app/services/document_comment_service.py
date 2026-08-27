from __future__ import annotations

import sqlite3
import re
from difflib import SequenceMatcher
from typing import Any

from fastapi import HTTPException, status

from app.services.audit_service import content_fingerprint, record_audit


SYSTEM_COMMENT_USERNAME = "__system_comment__"


def _author(row: sqlite3.Row) -> dict[str, Any]:
    return {"id": int(row["author_id"]), "display_name": str(row["author_name"])}


def _thread_to_public(conn: sqlite3.Connection, thread: sqlite3.Row) -> dict[str, Any]:
    messages = conn.execute(
        """
        SELECT
            messages.id,
            messages.content,
            messages.is_root,
            messages.created_at,
            users.id AS author_id,
            users.display_name AS author_name
        FROM document_comment_messages AS messages
        JOIN users ON users.id = messages.created_by
        WHERE messages.thread_id = ?
        ORDER BY messages.id
        """,
        (thread["id"],),
    ).fetchall()
    return {
        "id": int(thread["id"]),
        "stage": str(thread["stage"]),
        "anchor": {
            "start": int(thread["anchor_start"]),
            "end": int(thread["anchor_end"]),
            "text": str(thread["anchor_text"]),
            "prefix": str(thread["anchor_prefix"] or ""),
            "suffix": str(thread["anchor_suffix"] or ""),
            "preview_start": thread["preview_start"],
            "preview_end": thread["preview_end"],
        },
        "created_by": _author(thread),
        "created_at": str(thread["created_at"]),
        "updated_at": str(thread["updated_at"]),
        "messages": [
            {
                "id": int(message["id"]),
                "content": str(message["content"]),
                "is_root": bool(message["is_root"]),
                "author": _author(message),
                "created_at": str(message["created_at"]),
            }
            for message in messages
        ],
    }


def list_document_comments(conn: sqlite3.Connection, project_id: int, stage: str) -> list[dict[str, Any]]:
    threads = conn.execute(
        """
        SELECT
            threads.*,
            users.id AS author_id,
            users.display_name AS author_name
        FROM document_comment_threads AS threads
        JOIN users ON users.id = threads.created_by
        WHERE threads.project_id = ? AND threads.stage = ?
        ORDER BY threads.created_at, threads.id
        """,
        (project_id, stage),
    ).fetchall()
    return [_thread_to_public(conn, thread) for thread in threads]


def _thread_or_404(conn: sqlite3.Connection, project_id: int, stage: str, thread_id: int) -> sqlite3.Row:
    thread = conn.execute(
        """
        SELECT
            threads.*,
            users.id AS author_id,
            users.display_name AS author_name
        FROM document_comment_threads AS threads
        JOIN users ON users.id = threads.created_by
        WHERE threads.id = ? AND threads.project_id = ? AND threads.stage = ?
        """,
        (thread_id, project_id, stage),
    ).fetchone()
    if not thread:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到该评论")
    return thread


def create_document_comment(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    stage: str,
    user: sqlite3.Row,
    anchor_start: int,
    anchor_end: int,
    anchor_text: str,
    anchor_prefix: str,
    anchor_suffix: str,
    preview_start: int | None,
    preview_end: int | None,
    content: str,
) -> dict[str, Any]:
    cursor = conn.execute(
        """
        INSERT INTO document_comment_threads (
            project_id, stage, anchor_start, anchor_end, anchor_text, anchor_prefix, anchor_suffix,
            preview_start, preview_end, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            stage,
            anchor_start,
            anchor_end,
            anchor_text,
            anchor_prefix,
            anchor_suffix,
            preview_start,
            preview_end,
            int(user["id"]),
        ),
    )
    thread_id = int(cursor.lastrowid)
    conn.execute(
        """
        INSERT INTO document_comment_messages (thread_id, content, created_by, is_root)
        VALUES (?, ?, ?, 1)
        """,
        (thread_id, content, int(user["id"])),
    )
    thread = _thread_or_404(conn, project_id, stage, thread_id)
    record_audit(
        conn,
        actor=user,
        action="document_comment.create",
        target_type="project_document_comment",
        target_id=thread_id,
        target_label=stage,
        project_id=project_id,
        details={
            "stage": stage,
            "anchor": content_fingerprint(anchor_text),
            "comment": content_fingerprint(content),
        },
    )
    return _thread_to_public(conn, thread)


def ensure_system_comment_author(conn: sqlite3.Connection) -> sqlite3.Row:
    existing = conn.execute(
        "SELECT * FROM users WHERE is_system = 1 AND username LIKE ? ORDER BY id LIMIT 1",
        (f"{SYSTEM_COMMENT_USERNAME}%",),
    ).fetchone()
    if existing:
        return existing
    suffix = 0
    while True:
        username = SYSTEM_COMMENT_USERNAME if suffix == 0 else f"{SYSTEM_COMMENT_USERNAME}_{suffix}"
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO users (username, display_name, password_hash, role, is_active, is_system)
            VALUES (?, '系统', 'disabled', 'user', 0, 1)
            """,
            (username,),
        )
        if cursor.rowcount:
            return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        suffix += 1


def _changed_after_line_indexes(before: str, after: str) -> list[int]:
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    changed: set[int] = set()
    for tag, _a_start, _a_end, b_start, b_end in SequenceMatcher(
        None, before_lines, after_lines, autojunk=False
    ).get_opcodes():
        if tag == "equal":
            continue
        if b_start < b_end:
            changed.update(range(b_start, b_end))
        elif after_lines:
            changed.add(min(b_start, len(after_lines) - 1))
    return sorted(changed)


def _episode_anchor_ranges(content: str, changed_lines: list[int]) -> list[tuple[int, int]]:
    lines = content.splitlines(keepends=True)
    if not lines or not changed_lines:
        return []
    starts: list[int] = []
    offset = 0
    line_offsets: list[int] = []
    for line in lines:
        line_offsets.append(offset)
        if line.lstrip().startswith("#") and re.match(r"^#{1,6}\s*第\s*\d+\s*集", line.strip()):
            starts.append(len(line_offsets) - 1)
        offset += len(line)

    groups: dict[int, list[int]] = {}
    for line_index in changed_lines:
        episode_start = max((start for start in starts if start <= line_index), default=-1)
        groups.setdefault(episode_start, []).append(line_index)

    anchors: list[tuple[int, int]] = []
    for episode_start, indexes in groups.items():
        candidates = [*indexes, episode_start] if episode_start >= 0 else indexes
        anchor_line = next(
            (index for index in candidates if 0 <= index < len(lines) and lines[index].strip()),
            None,
        )
        if anchor_line is None:
            continue
        raw = lines[anchor_line].rstrip("\r\n")
        leading = len(raw) - len(raw.lstrip())
        start = line_offsets[anchor_line] + leading
        end = start + len(raw.strip())
        if end > start:
            anchors.append((start, end))
    return anchors


def create_system_revision_comments(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    stage: str,
    source_job_id: int,
    before: str,
    after: str,
    issue_titles: list[str],
) -> list[dict[str, Any]]:
    """Create one idempotent system comment per changed screenplay episode."""
    if before == after or not after:
        return []
    existing = conn.execute(
        "SELECT COUNT(*) AS count FROM document_comment_threads WHERE source_job_id = ?",
        (source_job_id,),
    ).fetchone()
    if existing and int(existing["count"]) > 0:
        return []

    author = ensure_system_comment_author(conn)
    issue_count = len([title for title in issue_titles if title and title.strip()])
    message = (
        f"已根据本轮 {issue_count} 项 P0 建议调整此处相关内容。"
        if issue_count > 1
        else "已根据本轮 P0 建议调整此处相关内容。"
    )
    created: list[dict[str, Any]] = []
    for anchor_start, anchor_end in _episode_anchor_ranges(
        after, _changed_after_line_indexes(before, after)
    ):
        anchor_text = after[anchor_start:anchor_end]
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO document_comment_threads (
                project_id, stage, anchor_start, anchor_end, anchor_text, anchor_prefix,
                anchor_suffix, preview_start, preview_end, source_job_id, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            """,
            (
                project_id,
                stage,
                anchor_start,
                anchor_end,
                anchor_text,
                after[max(0, anchor_start - 120):anchor_start],
                after[anchor_end:anchor_end + 120],
                source_job_id,
                int(author["id"]),
            ),
        )
        if not cursor.rowcount:
            continue
        thread_id = int(cursor.lastrowid)
        conn.execute(
            """
            INSERT INTO document_comment_messages (thread_id, content, created_by, is_root)
            VALUES (?, ?, ?, 1)
            """,
            (thread_id, message, int(author["id"])),
        )
        created.append(_thread_to_public(conn, _thread_or_404(conn, project_id, stage, thread_id)))
    return created


def add_document_comment_reply(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    stage: str,
    thread_id: int,
    user: sqlite3.Row,
    content: str,
) -> dict[str, Any]:
    _thread_or_404(conn, project_id, stage, thread_id)
    conn.execute(
        """
        INSERT INTO document_comment_messages (thread_id, content, created_by)
        VALUES (?, ?, ?)
        """,
        (thread_id, content, int(user["id"])),
    )
    conn.execute(
        "UPDATE document_comment_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (thread_id,),
    )
    thread = _thread_or_404(conn, project_id, stage, thread_id)
    record_audit(
        conn,
        actor=user,
        action="document_comment.reply",
        target_type="project_document_comment",
        target_id=thread_id,
        target_label=stage,
        project_id=project_id,
        details={"stage": stage, "comment": content_fingerprint(content)},
    )
    return _thread_to_public(conn, thread)


def delete_document_comment_message(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    stage: str,
    thread_id: int,
    message_id: int,
    user: sqlite3.Row,
) -> dict[str, Any]:
    _thread_or_404(conn, project_id, stage, thread_id)
    message = conn.execute(
        """
        SELECT id, content, created_by, is_root
        FROM document_comment_messages
        WHERE id = ? AND thread_id = ?
        """,
        (message_id, thread_id),
    ).fetchone()
    if not message:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到该评论内容")
    if int(message["created_by"]) != int(user["id"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="只能删除自己发布的评论")

    conn.execute("DELETE FROM document_comment_messages WHERE id = ?", (message_id,))
    remaining_messages = conn.execute(
        "SELECT COUNT(*) AS count FROM document_comment_messages WHERE thread_id = ?",
        (thread_id,),
    ).fetchone()
    thread_deleted = int(remaining_messages["count"]) == 0
    if thread_deleted:
        conn.execute("DELETE FROM document_comment_threads WHERE id = ?", (thread_id,))
    else:
        conn.execute(
            "UPDATE document_comment_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (thread_id,),
        )
    record_audit(
        conn,
        actor=user,
        action="document_comment.delete",
        target_type="project_document_comment",
        target_id=thread_id,
        target_label=stage,
        project_id=project_id,
        details={
            "stage": stage,
            "thread_deleted": thread_deleted,
            "comment": content_fingerprint(str(message["content"])),
        },
    )
    return {"thread_id": thread_id, "message_id": message_id, "thread_deleted": thread_deleted}
