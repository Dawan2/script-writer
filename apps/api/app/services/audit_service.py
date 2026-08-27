from __future__ import annotations

import hashlib
import json
import sqlite3
from contextvars import ContextVar, Token
from typing import Any


_audit_context: ContextVar[dict[str, str]] = ContextVar("audit_context", default={})


def set_audit_context(*, request_id: str, source: str) -> Token:
    return _audit_context.set({"request_id": request_id, "source": source})


def reset_audit_context(token: Token) -> None:
    _audit_context.reset(token)


def content_fingerprint(value: str | bytes | None) -> dict[str, int | str] | None:
    if value is None:
        return None
    raw = value.encode("utf-8") if isinstance(value, str) else value
    return {"sha256": hashlib.sha256(raw).hexdigest(), "length": len(raw)}


def _row_value(row: sqlite3.Row | dict[str, Any] | None, key: str) -> Any:
    if row is None:
        return None
    try:
        return row[key]
    except (IndexError, KeyError):
        return None


def _audit_columns(conn: sqlite3.Connection) -> set[str]:
    try:
        return {row["name"] for row in conn.execute("PRAGMA table_info(audit_logs)").fetchall()}
    except sqlite3.OperationalError:
        return set()


def record_audit(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row | dict[str, Any] | None,
    action: str,
    target_type: str,
    target_id: str | int | None = None,
    target_label: str | None = None,
    details: dict[str, Any] | None = None,
    project_id: int | None = None,
    outcome: str = "success",
    source: str | None = None,
    severity: str = "info",
    request_id: str | None = None,
    parent_event_id: int | None = None,
) -> int | None:
    """Append one business audit event without persisting sensitive source content."""
    columns = _audit_columns(conn)
    if not columns:
        # Some focused unit tests intentionally use a minimal pre-migration schema.
        return None

    context = _audit_context.get()
    actor_id = _row_value(actor, "id")
    actor_username = str(_row_value(actor, "username") or "系统")
    values: dict[str, Any] = {
        "actor_user_id": actor_id,
        "actor_username": actor_username,
        "action": action,
        "target_type": target_type,
        "target_id": str(target_id) if target_id is not None else None,
        "target_label": target_label,
        "details_json": json.dumps(details or {}, ensure_ascii=False, separators=(",", ":"), default=str),
        "project_id": project_id,
        "outcome": outcome,
        "source": source or context.get("source") or ("system" if actor is None else "api"),
        "severity": severity,
        "request_id": request_id or context.get("request_id"),
        "parent_event_id": parent_event_id,
    }
    insert_columns = [name for name in values if name in columns]
    cursor = conn.execute(
        f"INSERT INTO audit_logs ({', '.join(insert_columns)}) VALUES ({', '.join('?' for _ in insert_columns)})",
        [values[name] for name in insert_columns],
    )
    return int(cursor.lastrowid) if cursor.lastrowid is not None else None


def record_system_audit(
    conn: sqlite3.Connection,
    *,
    action: str,
    target_type: str,
    target_id: str | int | None = None,
    target_label: str | None = None,
    details: dict[str, Any] | None = None,
    project_id: int | None = None,
    outcome: str = "success",
    severity: str = "info",
    parent_event_id: int | None = None,
) -> int | None:
    return record_audit(
        conn,
        actor=None,
        action=action,
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        details=details,
        project_id=project_id,
        outcome=outcome,
        source="system",
        severity=severity,
        parent_event_id=parent_event_id,
    )


def audit_row_to_public(row: sqlite3.Row) -> dict:
    try:
        details = json.loads(row["details_json"] or "{}")
    except json.JSONDecodeError:
        details = {}
    return {
        "id": row["id"],
        "actor_user_id": row["actor_user_id"],
        "actor_username": row["actor_username"],
        "action": row["action"],
        "target_type": row["target_type"],
        "target_id": row["target_id"],
        "target_label": row["target_label"],
        "details": details,
        "project_id": row["project_id"] if "project_id" in row.keys() else None,
        "outcome": row["outcome"] if "outcome" in row.keys() else "success",
        "source": row["source"] if "source" in row.keys() else "api",
        "severity": row["severity"] if "severity" in row.keys() else "info",
        "request_id": row["request_id"] if "request_id" in row.keys() else None,
        "parent_event_id": row["parent_event_id"] if "parent_event_id" in row.keys() else None,
        "created_at": row["created_at"],
    }
