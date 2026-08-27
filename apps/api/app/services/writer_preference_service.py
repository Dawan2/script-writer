from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, status


WRITER_PREFERENCE_SCOPES = [
    {"key": "global", "name": "全局创作观", "description": "所有创作与审稿阶段都应继承的长期原则"},
    {"key": "novel_analysis", "name": "小说解读", "description": "原著理解、人物转变、剧情单元和高光提炼偏好"},
    {"key": "world_view", "name": "世界观构建", "description": "改编世界、关键概念和本地化外壳的偏好"},
    {"key": "outline_rewrite", "name": "梗概创作", "description": "故事结构、节奏骨架与本土化改编偏好"},
    {"key": "character_rewrite", "name": "人物塑造", "description": "人物关系、动机、口吻与成长弧偏好"},
    {"key": "trial_generate", "name": "试稿创作", "description": "试稿节奏、场景、对白与钩子偏好"},
    {"key": "full_generate", "name": "全稿创作", "description": "完整剧本的延续、批次生成与风格偏好"},
    {"key": "dialogue_translate", "name": "台词翻译", "description": "台词本土化、人物声音与字幕可读性偏好"},
    {"key": "foreign_review", "name": "AI 审稿", "description": "审稿关注点、证据要求与报告表达偏好"},
    {"key": "humanizer_zh", "name": "剧本润色", "description": "对白自然度、叙述节奏与表达克制偏好"},
]
CREATIVE_STAGES = {item["key"] for item in WRITER_PREFERENCE_SCOPES if item["key"] != "global"}
ALLOWED_SCOPES = {item["key"] for item in WRITER_PREFERENCE_SCOPES}
MAX_PREFERENCE_CONTENT_CHARS = 2_000
MAX_PREFERENCES_PER_USER = 200
# Keep long-term preferences useful without turning routine generation into a
# large-context workflow. Stage-specific rules still take precedence.
MAX_COMPILED_CONTEXT_CHARS = 6_000
PREFERENCE_EXPORT_SCHEMA_VERSION = "1.0"
PREFERENCE_IMPORT_MODES = {"append", "replace"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_content(content: str) -> str:
    value = content.strip()
    if not value:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="偏好内容不能为空")
    if len(value) > MAX_PREFERENCE_CONTENT_CHARS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"单条偏好不能超过 {MAX_PREFERENCE_CONTENT_CHARS} 个字符",
        )
    return value


def normalize_scopes(scopes: list[str]) -> list[str]:
    result = list(dict.fromkeys(str(scope).strip() for scope in scopes if str(scope).strip()))
    invalid = [scope for scope in result if scope not in ALLOWED_SCOPES]
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"不支持的偏好范围：{'、'.join(invalid)}",
        )
    if not result:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="至少选择一个适用范围")
    if "global" in result and len(result) > 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="全局创作观不能与指定阶段同时选择",
        )
    scope_order = {item["key"]: index for index, item in enumerate(WRITER_PREFERENCE_SCOPES)}
    return sorted(result, key=lambda scope: scope_order[scope])


def get_profile_revision(conn: sqlite3.Connection, user_id: int) -> int:
    row = conn.execute(
        "SELECT revision FROM writer_preference_profiles WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    return int(row["revision"] if row else 0)


def _bump_profile_revision(conn: sqlite3.Connection, user_id: int) -> int:
    conn.execute(
        "INSERT OR IGNORE INTO writer_preference_profiles (user_id, revision) VALUES (?, 0)",
        (user_id,),
    )
    conn.execute(
        """
        UPDATE writer_preference_profiles
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
        """,
        (user_id,),
    )
    return get_profile_revision(conn, user_id)


def _preference_scopes(conn: sqlite3.Connection, preference_ids: list[int]) -> dict[int, list[str]]:
    if not preference_ids:
        return {}
    placeholders = ",".join("?" for _ in preference_ids)
    rows = conn.execute(
        f"""
        SELECT preference_id, scope
        FROM writer_preference_scopes
        WHERE preference_id IN ({placeholders})
        ORDER BY preference_id, scope
        """,
        preference_ids,
    ).fetchall()
    result: dict[int, list[str]] = {preference_id: [] for preference_id in preference_ids}
    for row in rows:
        result[int(row["preference_id"])].append(row["scope"])
    scope_order = {item["key"]: index for index, item in enumerate(WRITER_PREFERENCE_SCOPES)}
    for scopes in result.values():
        scopes.sort(key=lambda scope: scope_order[scope])
    return result


def _public_preference(
    row: sqlite3.Row,
    scopes: list[str],
    *,
    enabled: bool | None = None,
    position: int | None = None,
    is_system_preference: bool = False,
    public_id: int | None = None,
    system_preference_id: int | None = None,
    can_edit_system_preference: bool = False,
) -> dict:
    evidence = None
    if row["evidence_json"]:
        try:
            evidence = json.loads(row["evidence_json"])
        except json.JSONDecodeError:
            evidence = None
    return {
        "id": int(row["id"] if public_id is None else public_id),
        "content": row["content"],
        "scopes": scopes,
        "source": row["source"],
        "enabled": bool(row["enabled"]) if enabled is None else bool(enabled),
        "position": int(row["position"]) if position is None else position,
        "version": row["version"],
        "evidence": evidence,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "is_system_preference": is_system_preference,
        "system_preference_id": system_preference_id,
        "can_edit_system_preference": can_edit_system_preference,
    }


def _system_preference_scopes(conn: sqlite3.Connection, preference_ids: list[int]) -> dict[int, list[str]]:
    if not preference_ids:
        return {}
    placeholders = ",".join("?" for _ in preference_ids)
    rows = conn.execute(
        f"""
        SELECT system_preference_id, scope
        FROM system_writer_preference_scopes
        WHERE system_preference_id IN ({placeholders})
        ORDER BY system_preference_id, scope
        """,
        preference_ids,
    ).fetchall()
    result: dict[int, list[str]] = {preference_id: [] for preference_id in preference_ids}
    for row in rows:
        result[int(row["system_preference_id"])].append(row["scope"])
    scope_order = {item["key"]: index for index, item in enumerate(WRITER_PREFERENCE_SCOPES)}
    for scopes in result.values():
        scopes.sort(key=lambda scope: scope_order[scope])
    return result


def list_owned_writer_preferences(
    conn: sqlite3.Connection,
    user_id: int,
    *,
    include_system_sources: bool = False,
) -> list[dict]:
    source_filter = "" if include_system_sources else """
          AND NOT EXISTS (
              SELECT 1 FROM system_writer_preferences
              WHERE source_preference_id = writer_preference.id
          )
    """
    rows = conn.execute(
        f"""
        SELECT writer_preference.* FROM writer_preferences AS writer_preference
        WHERE writer_preference.user_id = ?
        {source_filter}
        ORDER BY writer_preference.position, writer_preference.id
        """,
        (user_id,),
    ).fetchall()
    scope_map = _preference_scopes(conn, [int(row["id"]) for row in rows])
    return [_public_preference(row, scope_map.get(int(row["id"]), [])) for row in rows]


def list_system_writer_preferences(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM system_writer_preferences ORDER BY created_at, id"
    ).fetchall()
    scope_map = _system_preference_scopes(conn, [int(row["id"]) for row in rows])
    return [
        _public_preference(
            row,
            scope_map.get(int(row["id"]), []),
            enabled=True,
            position=index,
            is_system_preference=True,
            system_preference_id=int(row["id"]),
        )
        for index, row in enumerate(rows)
    ]


def list_writer_preferences(conn: sqlite3.Connection, user_id: int) -> dict:
    preferences = list_owned_writer_preferences(conn, user_id)
    system_start_position = len(preferences)
    system_rows = conn.execute(
        """
        SELECT
            system_preference.*,
            preference_ref.enabled AS reference_enabled,
            CASE WHEN source_preference.user_id = ? THEN 1 ELSE 0 END AS can_edit_system_preference
        FROM system_writer_preferences AS system_preference
        LEFT JOIN user_system_writer_preference_refs AS preference_ref
          ON preference_ref.system_preference_id = system_preference.id
         AND preference_ref.user_id = ?
        LEFT JOIN writer_preferences AS source_preference
          ON source_preference.id = system_preference.source_preference_id
        ORDER BY system_preference.created_at, system_preference.id
        """,
        (user_id, user_id),
    ).fetchall()
    scope_map = _system_preference_scopes(conn, [int(row["id"]) for row in system_rows])
    preferences.extend(
        _public_preference(
            row,
            scope_map.get(int(row["id"]), []),
            enabled=bool(row["reference_enabled"]),
            position=system_start_position + index,
            is_system_preference=True,
            public_id=-int(row["id"]),
            system_preference_id=int(row["id"]),
            can_edit_system_preference=bool(row["can_edit_system_preference"]),
        )
        for index, row in enumerate(system_rows)
    )
    return {
        "profile_revision": get_profile_revision(conn, user_id),
        "scopes": WRITER_PREFERENCE_SCOPES,
        "preferences": preferences,
        "limits": {
            "max_items": MAX_PREFERENCES_PER_USER,
            "max_content_chars": MAX_PREFERENCE_CONTENT_CHARS,
            "max_context_chars": MAX_COMPILED_CONTEXT_CHARS,
        },
    }


def _bump_profile_revisions(conn: sqlite3.Connection, user_ids: list[int]) -> dict[int, int]:
    revisions: dict[int, int] = {}
    for user_id in dict.fromkeys(user_ids):
        revisions[user_id] = _bump_profile_revision(conn, user_id)
    return revisions


def initialize_system_writer_preferences_for_user(conn: sqlite3.Connection, *, user_id: int) -> dict:
    system_rows = conn.execute(
        "SELECT id FROM system_writer_preferences ORDER BY id"
    ).fetchall()
    linked_count = 0
    for row in system_rows:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO user_system_writer_preference_refs (
                user_id, system_preference_id, enabled
            ) VALUES (?, ?, 1)
            """,
            (user_id, row["id"]),
        )
        linked_count += max(0, cursor.rowcount)
    return {
        "linked_count": linked_count,
        "profile_revision": _bump_profile_revision(conn, user_id) if linked_count else get_profile_revision(conn, user_id),
    }


def promote_writer_preferences_to_system(
    conn: sqlite3.Connection,
    *,
    preference_ids: list[int],
) -> dict:
    selected_ids = list(dict.fromkeys(preference_ids))
    if not selected_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="至少选择一条创作偏好")
    placeholders = ",".join("?" for _ in selected_ids)
    rows = conn.execute(
        f"""
        SELECT * FROM writer_preferences
        WHERE id IN ({placeholders})
        ORDER BY id
        """,
        selected_ids,
    ).fetchall()
    row_map = {int(row["id"]): row for row in rows}
    missing_ids = [preference_id for preference_id in selected_ids if preference_id not in row_map]
    if missing_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到部分创作偏好")

    existing_rows = conn.execute(
        f"""
        SELECT id, source_preference_id
        FROM system_writer_preferences
        WHERE source_preference_id IN ({placeholders})
        """,
        selected_ids,
    ).fetchall()
    existing_by_source = {int(row["source_preference_id"]): int(row["id"]) for row in existing_rows}
    created_system_ids: list[int] = []
    existing_system_ids: list[int] = []
    for preference_id in selected_ids:
        existing_id = existing_by_source.get(preference_id)
        if existing_id is not None:
            existing_system_ids.append(existing_id)
            continue
        row = row_map[preference_id]
        conn.execute(
            """
            INSERT INTO system_writer_preferences (
                source_preference_id, content, source, version, evidence_json
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (row["id"], row["content"], row["source"], row["version"], row["evidence_json"]),
        )
        system_preference_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        scopes = _preference_scopes(conn, [preference_id]).get(preference_id, [])
        conn.executemany(
            """
            INSERT INTO system_writer_preference_scopes (system_preference_id, scope)
            VALUES (?, ?)
            """,
            [(system_preference_id, scope) for scope in scopes],
        )
        created_system_ids.append(system_preference_id)

    affected_user_ids: list[int] = []
    if created_system_ids:
        users = conn.execute(
            "SELECT id FROM users WHERE COALESCE(is_system, 0) = 0 ORDER BY id"
        ).fetchall()
        for user in users:
            user_id = int(user["id"])
            linked = False
            for system_preference_id in created_system_ids:
                cursor = conn.execute(
                    """
                    INSERT OR IGNORE INTO user_system_writer_preference_refs (
                        user_id, system_preference_id, enabled
                    ) VALUES (?, ?, 0)
                    """,
                    (user_id, system_preference_id),
                )
                linked = linked or cursor.rowcount > 0
            if linked:
                affected_user_ids.append(user_id)
    _bump_profile_revisions(conn, affected_user_ids)
    return {
        "created_system_preference_ids": created_system_ids,
        "existing_system_preference_ids": existing_system_ids,
        "affected_user_count": len(affected_user_ids),
    }


def remove_system_writer_preferences(
    conn: sqlite3.Connection,
    *,
    system_preference_ids: list[int],
) -> dict:
    selected_ids = list(dict.fromkeys(system_preference_ids))
    if not selected_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="至少选择一条系统偏好")
    placeholders = ",".join("?" for _ in selected_ids)
    rows = conn.execute(
        f"SELECT id FROM system_writer_preferences WHERE id IN ({placeholders})",
        selected_ids,
    ).fetchall()
    existing_ids = {int(row["id"]) for row in rows}
    if len(existing_ids) != len(selected_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到部分系统偏好")
    affected_user_ids = [
        int(row["user_id"])
        for row in conn.execute(
            f"""
            SELECT DISTINCT user_id
            FROM user_system_writer_preference_refs
            WHERE system_preference_id IN ({placeholders})
            """,
            selected_ids,
        ).fetchall()
    ]
    conn.execute(
        f"DELETE FROM system_writer_preferences WHERE id IN ({placeholders})",
        selected_ids,
    )
    _bump_profile_revisions(conn, affected_user_ids)
    return {
        "removed_system_preference_ids": selected_ids,
        "affected_user_count": len(affected_user_ids),
    }


def export_writer_preferences(conn: sqlite3.Connection, *, user_id: int) -> dict:
    """Return the portable subset of a user's preference profile.

    Database ids, AI evidence, and source markers intentionally stay local: an
    imported rule is a user-managed rule in its new profile.
    """
    preferences = list_owned_writer_preferences(conn, user_id)
    return {
        "schema_version": PREFERENCE_EXPORT_SCHEMA_VERSION,
        "exported_at": utc_now_iso(),
        "preferences": [
            {
                "content": item["content"],
                "scopes": item["scopes"],
                "enabled": item["enabled"],
            }
            for item in preferences
        ],
    }


def _normalize_imported_preferences(preferences: list[dict]) -> tuple[list[dict], int]:
    if len(preferences) > MAX_PREFERENCES_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"单次最多导入 {MAX_PREFERENCES_PER_USER} 条创作偏好",
        )

    normalized: list[dict] = []
    seen: set[tuple[str, tuple[str, ...]]] = set()
    skipped_duplicate_count = 0
    for index, item in enumerate(preferences, start=1):
        if not isinstance(item, dict):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"导入文件中的第 {index} 条偏好格式不正确",
            )
        content = item.get("content")
        scopes = item.get("scopes")
        enabled = item.get("enabled", True)
        if not isinstance(content, str) or not isinstance(scopes, list) or not isinstance(enabled, bool):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"导入文件中的第 {index} 条偏好格式不正确",
            )
        resolved_content = normalize_content(content)
        resolved_scopes = normalize_scopes(scopes)
        duplicate_key = (resolved_content, tuple(resolved_scopes))
        if duplicate_key in seen:
            skipped_duplicate_count += 1
            continue
        seen.add(duplicate_key)
        normalized.append({
            "content": resolved_content,
            "scopes": resolved_scopes,
            "enabled": enabled,
        })
    return normalized, skipped_duplicate_count


def import_writer_preferences(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    schema_version: str,
    preferences: list[dict],
    mode: str,
) -> dict:
    if schema_version != PREFERENCE_EXPORT_SCHEMA_VERSION:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="不支持该创作偏好备份版本",
        )
    if mode not in PREFERENCE_IMPORT_MODES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="导入方式无效",
        )

    imported, skipped_duplicate_count = _normalize_imported_preferences(preferences)
    current = list_owned_writer_preferences(conn, user_id)
    existing_count = len(current)
    if mode == "append":
        existing_keys = {(item["content"], tuple(item["scopes"])) for item in current}
        to_create: list[dict] = []
        for item in imported:
            if (item["content"], tuple(item["scopes"])) in existing_keys:
                skipped_duplicate_count += 1
                continue
            to_create.append(item)
        if existing_count + len(to_create) > MAX_PREFERENCES_PER_USER:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"导入后将超过 {MAX_PREFERENCES_PER_USER} 条创作偏好的上限，请选择替换现有偏好或精简备份文件",
            )
    else:
        to_create = imported

    changed = bool(to_create) or (mode == "replace" and existing_count > 0)
    if not changed:
        return {
            "profile_revision": get_profile_revision(conn, user_id),
            "imported_count": 0,
            "skipped_duplicate_count": skipped_duplicate_count,
            "removed_count": 0,
        }

    conn.execute("SAVEPOINT writer_preference_import")
    try:
        if mode == "replace":
            conn.execute(
                """
                DELETE FROM writer_preferences
                WHERE user_id = ?
                  AND NOT EXISTS (
                      SELECT 1 FROM system_writer_preferences
                      WHERE source_preference_id = writer_preferences.id
                  )
                """,
                (user_id,),
            )
            start_position = 0
        else:
            start_position = existing_count
        for offset, item in enumerate(to_create):
            conn.execute(
                """
                INSERT INTO writer_preferences (user_id, content, source, enabled, position)
                VALUES (?, ?, 'manual', ?, ?)
                """,
                (user_id, item["content"], 1 if item["enabled"] else 0, start_position + offset),
            )
            preference_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            conn.executemany(
                "INSERT INTO writer_preference_scopes (preference_id, scope) VALUES (?, ?)",
                [(preference_id, scope) for scope in item["scopes"]],
            )
        revision = _bump_profile_revision(conn, user_id)
        conn.execute("RELEASE SAVEPOINT writer_preference_import")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT writer_preference_import")
        conn.execute("RELEASE SAVEPOINT writer_preference_import")
        raise

    return {
        "profile_revision": revision,
        "imported_count": len(to_create),
        "skipped_duplicate_count": skipped_duplicate_count,
        "removed_count": existing_count if mode == "replace" else 0,
    }


def _owned_preference(conn: sqlite3.Connection, user_id: int, preference_id: int) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT writer_preference.* FROM writer_preferences AS writer_preference
        WHERE writer_preference.id = ?
          AND writer_preference.user_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM system_writer_preferences
              WHERE source_preference_id = writer_preference.id
          )
        """,
        (preference_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到这条创作偏好")
    return row


def _editable_system_preference(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    system_preference_id: int,
) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT system_preference.*
        FROM system_writer_preferences AS system_preference
        JOIN writer_preferences AS source_preference
          ON source_preference.id = system_preference.source_preference_id
        WHERE system_preference.id = ?
          AND source_preference.user_id = ?
        """,
        (system_preference_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到可编辑的系统偏好")
    return row


def _system_preference_from_profile(profile: dict, system_preference_id: int) -> dict:
    preference = next(
        (
            item
            for item in profile["preferences"]
            if item.get("system_preference_id") == system_preference_id
        ),
        None,
    )
    if preference is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到系统偏好")
    return preference


def _system_preference_row(conn: sqlite3.Connection, system_preference_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM system_writer_preferences WHERE id = ?",
        (system_preference_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到系统偏好")
    return row


def _set_system_preference_enabled(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    system_preference_id: int,
    enabled: bool,
) -> dict:
    _system_preference_row(conn, system_preference_id)
    reference = conn.execute(
        """
        SELECT enabled FROM user_system_writer_preference_refs
        WHERE user_id = ? AND system_preference_id = ?
        """,
        (user_id, system_preference_id),
    ).fetchone()
    changed = False
    if reference is None:
        if enabled:
            conn.execute(
                """
                INSERT INTO user_system_writer_preference_refs (user_id, system_preference_id, enabled)
                VALUES (?, ?, 1)
                """,
                (user_id, system_preference_id),
            )
            changed = True
    elif bool(reference["enabled"]) != enabled:
        conn.execute(
            """
            UPDATE user_system_writer_preference_refs
            SET enabled = ?, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ? AND system_preference_id = ?
            """,
            (1 if enabled else 0, user_id, system_preference_id),
        )
        changed = True

    revision = (
        _bump_profile_revision(conn, user_id)
        if changed
        else get_profile_revision(conn, user_id)
    )
    profile = list_writer_preferences(conn, user_id)
    return {
        "preference": _system_preference_from_profile(profile, system_preference_id),
        "profile_revision": revision,
    }


def _update_editable_system_preference(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    system_preference_id: int,
    content: str | None = None,
    scopes: list[str] | None = None,
) -> dict:
    row = _editable_system_preference(
        conn,
        user_id=user_id,
        system_preference_id=system_preference_id,
    )
    current_scopes = _system_preference_scopes(conn, [system_preference_id]).get(system_preference_id, [])
    resolved_content = normalize_content(content) if content is not None else row["content"]
    resolved_scopes = normalize_scopes(scopes) if scopes is not None else current_scopes
    changed = resolved_content != row["content"] or resolved_scopes != current_scopes
    if not changed:
        profile = list_writer_preferences(conn, user_id)
        return {
            "preference": _system_preference_from_profile(profile, system_preference_id),
            "profile_revision": profile["profile_revision"],
        }

    next_version = int(row["version"]) + 1
    conn.execute(
        """
        UPDATE system_writer_preferences
        SET content = ?, version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (resolved_content, next_version, system_preference_id),
    )
    if resolved_scopes != current_scopes:
        conn.execute(
            "DELETE FROM system_writer_preference_scopes WHERE system_preference_id = ?",
            (system_preference_id,),
        )
        conn.executemany(
            "INSERT INTO system_writer_preference_scopes (system_preference_id, scope) VALUES (?, ?)",
            [(system_preference_id, scope) for scope in resolved_scopes],
        )

    source_preference_id = int(row["source_preference_id"])
    conn.execute(
        """
        UPDATE writer_preferences
        SET content = ?, version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (resolved_content, next_version, source_preference_id),
    )
    if resolved_scopes != current_scopes:
        conn.execute("DELETE FROM writer_preference_scopes WHERE preference_id = ?", (source_preference_id,))
        conn.executemany(
            "INSERT INTO writer_preference_scopes (preference_id, scope) VALUES (?, ?)",
            [(source_preference_id, scope) for scope in resolved_scopes],
        )

    affected_user_ids = [
        int(item["user_id"])
        for item in conn.execute(
            """
            SELECT user_id FROM user_system_writer_preference_refs
            WHERE system_preference_id = ?
            ORDER BY user_id
            """,
            (system_preference_id,),
        ).fetchall()
    ]
    revisions = _bump_profile_revisions(conn, affected_user_ids)
    profile = list_writer_preferences(conn, user_id)
    return {
        "preference": _system_preference_from_profile(profile, system_preference_id),
        "profile_revision": revisions.get(user_id, profile["profile_revision"]),
    }


def create_writer_preference(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    content: str,
    scopes: list[str],
    enabled: bool | None = None,
    source: str = "manual",
    evidence: dict | None = None,
) -> dict:
    if source not in {"manual", "ai"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="偏好来源无效")
    count = conn.execute(
        """
        SELECT COUNT(*) AS count FROM writer_preferences AS writer_preference
        WHERE writer_preference.user_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM system_writer_preferences
              WHERE source_preference_id = writer_preference.id
          )
        """,
        (user_id,),
    ).fetchone()["count"]
    if int(count) >= MAX_PREFERENCES_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"每位用户最多维护 {MAX_PREFERENCES_PER_USER} 条创作偏好",
        )
    resolved_content = normalize_content(content)
    resolved_scopes = normalize_scopes(scopes)
    resolved_enabled = source == "manual" if enabled is None else bool(enabled)
    position_row = conn.execute(
        """
        SELECT COALESCE(MAX(writer_preference.position), -1) + 1 AS next_position
        FROM writer_preferences AS writer_preference
        WHERE writer_preference.user_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM system_writer_preferences
              WHERE source_preference_id = writer_preference.id
          )
        """,
        (user_id,),
    ).fetchone()
    conn.execute(
        """
        INSERT INTO writer_preferences (
            user_id, content, source, enabled, position, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            user_id,
            resolved_content,
            source,
            1 if resolved_enabled else 0,
            int(position_row["next_position"]),
            json.dumps(evidence, ensure_ascii=False) if evidence else None,
        ),
    )
    preference_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    conn.executemany(
        "INSERT INTO writer_preference_scopes (preference_id, scope) VALUES (?, ?)",
        [(preference_id, scope) for scope in resolved_scopes],
    )
    revision = _bump_profile_revision(conn, user_id)
    row = _owned_preference(conn, user_id, preference_id)
    return {"preference": _public_preference(row, resolved_scopes), "profile_revision": revision}


def update_writer_preference(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    preference_id: int,
    content: str | None = None,
    scopes: list[str] | None = None,
    enabled: bool | None = None,
) -> dict:
    if preference_id < 0:
        system_preference_id = -preference_id
        if content is not None or scopes is not None:
            result = _update_editable_system_preference(
                conn,
                user_id=user_id,
                system_preference_id=system_preference_id,
                content=content,
                scopes=scopes,
            )
            if enabled is None:
                return result
        if enabled is not None:
            return _set_system_preference_enabled(
                conn,
                user_id=user_id,
                system_preference_id=system_preference_id,
                enabled=bool(enabled),
            )
        _system_preference_row(conn, system_preference_id)
        profile = list_writer_preferences(conn, user_id)
        return {
            "preference": _system_preference_from_profile(profile, system_preference_id),
            "profile_revision": profile["profile_revision"],
        }
    row = _owned_preference(conn, user_id, preference_id)
    current_scopes = _preference_scopes(conn, [preference_id]).get(preference_id, [])
    resolved_content = normalize_content(content) if content is not None else row["content"]
    resolved_scopes = normalize_scopes(scopes) if scopes is not None else current_scopes
    resolved_enabled = bool(enabled) if enabled is not None else bool(row["enabled"])
    changed = (
        resolved_content != row["content"]
        or resolved_scopes != current_scopes
        or resolved_enabled != bool(row["enabled"])
    )
    if not changed:
        return {
            "preference": _public_preference(row, current_scopes),
            "profile_revision": get_profile_revision(conn, user_id),
        }
    conn.execute(
        """
        UPDATE writer_preferences
        SET content = ?, enabled = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
        """,
        (resolved_content, 1 if resolved_enabled else 0, preference_id, user_id),
    )
    if resolved_scopes != current_scopes:
        conn.execute("DELETE FROM writer_preference_scopes WHERE preference_id = ?", (preference_id,))
        conn.executemany(
            "INSERT INTO writer_preference_scopes (preference_id, scope) VALUES (?, ?)",
            [(preference_id, scope) for scope in resolved_scopes],
        )
    revision = _bump_profile_revision(conn, user_id)
    updated = _owned_preference(conn, user_id, preference_id)
    return {"preference": _public_preference(updated, resolved_scopes), "profile_revision": revision}


def delete_writer_preference(conn: sqlite3.Connection, *, user_id: int, preference_id: int) -> dict:
    _owned_preference(conn, user_id, preference_id)
    conn.execute("DELETE FROM writer_preferences WHERE id = ? AND user_id = ?", (preference_id, user_id))
    remaining = conn.execute(
        """
        SELECT writer_preference.id FROM writer_preferences AS writer_preference
        WHERE writer_preference.user_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM system_writer_preferences
              WHERE source_preference_id = writer_preference.id
          )
        ORDER BY writer_preference.position, writer_preference.id
        """,
        (user_id,),
    ).fetchall()
    for position, item in enumerate(remaining):
        conn.execute("UPDATE writer_preferences SET position = ? WHERE id = ?", (position, item["id"]))
    return {"ok": True, "profile_revision": _bump_profile_revision(conn, user_id)}


def reorder_writer_preferences(conn: sqlite3.Connection, *, user_id: int, ordered_ids: list[int]) -> dict:
    existing = conn.execute(
        """
        SELECT writer_preference.id FROM writer_preferences AS writer_preference
        WHERE writer_preference.user_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM system_writer_preferences
              WHERE source_preference_id = writer_preference.id
          )
        ORDER BY writer_preference.position, writer_preference.id
        """,
        (user_id,),
    ).fetchall()
    existing_ids = [int(row["id"]) for row in existing]
    if len(ordered_ids) != len(set(ordered_ids)) or set(ordered_ids) != set(existing_ids):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="排序列表必须完整包含当前用户的全部偏好",
        )
    if ordered_ids != existing_ids:
        for position, preference_id in enumerate(ordered_ids):
            conn.execute(
                "UPDATE writer_preferences SET position = ? WHERE id = ? AND user_id = ?",
                (position, preference_id, user_id),
            )
        revision = _bump_profile_revision(conn, user_id)
    else:
        revision = get_profile_revision(conn, user_id)
    result = list_writer_preferences(conn, user_id)
    result["profile_revision"] = revision
    return result


def _context_item(preference: dict, layer: str) -> dict:
    return {
        "id": preference["id"],
        "version": preference["version"],
        "source": preference["source"],
        "scopes": preference["scopes"],
        "layer": layer,
        "content": preference["content"],
        "is_system_preference": bool(preference.get("is_system_preference")),
        "system_preference_id": preference.get("system_preference_id"),
    }


def compile_writer_preference_context(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    stage: str,
    job_id: int,
) -> dict:
    profile = list_writer_preferences(conn, user_id)
    enabled = [item for item in profile["preferences"] if item["enabled"]]
    if stage not in CREATIVE_STAGES:
        stage_preferences: list[dict] = []
        global_preferences: list[dict] = []
    else:
        stage_preferences = [item for item in enabled if stage in item["scopes"]]
        global_preferences = [item for item in enabled if item["scopes"] == ["global"]]

    selected: list[dict] = []
    omitted_ids: list[int] = []
    used_chars = 0
    for preference, layer in [
        *((item, "stage") for item in stage_preferences),
        *((item, "global") for item in global_preferences),
    ]:
        content_chars = len(preference["content"])
        if used_chars + content_chars > MAX_COMPILED_CONTEXT_CHARS:
            omitted_ids.append(preference["id"])
            continue
        selected.append(_context_item(preference, layer))
        used_chars += content_chars

    selected_ids = {item["id"] for item in selected}
    selected_stage = [_context_item(item, "stage") for item in stage_preferences if item["id"] in selected_ids]
    selected_global = [_context_item(item, "global") for item in global_preferences if item["id"] in selected_ids]
    warnings = []
    if omitted_ids:
        warnings.append(
            f"偏好上下文超过 {MAX_COMPILED_CONTEXT_CHARS} 字符预算，已忽略 {len(omitted_ids)} 条低优先级规则"
        )
    return {
        "schema_version": "1.0.0",
        "built_at": utc_now_iso(),
        "job_id": str(job_id),
        "stage": stage,
        "supported_stage": stage in CREATIVE_STAGES,
        "profile_revision": profile["profile_revision"],
        "policy": {
            "source_of_truth": "本快照是当前 Job 唯一有效的长期用户偏好来源；不得沿用旧 Session 中未出现在本快照的偏好。",
            "precedence": [
                "平台安全、输出协议和审批规则",
                "当前 Job 的明确用户指令",
                "当前项目要求",
                "当前阶段偏好",
                "全局创作观",
                "Skill 默认创作方法",
            ],
            "conflict_rule": "同层级冲突时使用列表中更靠前的规则；阶段规则与全局规则冲突时使用阶段规则。",
        },
        "global_preferences": selected_global,
        "stage_preferences": selected_stage,
        "effective_preferences": selected,
        "effective_count": len(selected),
        "context_chars": used_chars,
        "omitted_preference_ids": omitted_ids,
        "warnings": warnings,
    }


def _snapshot_row_payload(row: sqlite3.Row) -> dict:
    payload = json.loads(row["snapshot_json"])
    payload["snapshot_sha256"] = row["snapshot_sha256"]
    return payload


def ensure_agent_preference_snapshot(
    conn: sqlite3.Connection,
    *,
    job: sqlite3.Row,
) -> dict:
    existing = conn.execute(
        "SELECT * FROM agent_preference_snapshots WHERE job_id = ?",
        (job["id"],),
    ).fetchone()
    if existing:
        return _snapshot_row_payload(existing)
    stage = job["target_stage"] or job["stage"]
    payload = compile_writer_preference_context(
        conn,
        user_id=int(job["user_id"]),
        stage=stage,
        job_id=int(job["id"]),
    )
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    conn.execute(
        """
        INSERT INTO agent_preference_snapshots (
            job_id, user_id, project_id, stage, profile_revision, snapshot_json, snapshot_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job["id"],
            job["user_id"],
            job["project_id"],
            stage,
            payload["profile_revision"],
            serialized,
            digest,
        ),
    )
    payload["snapshot_sha256"] = digest
    return payload


def preference_snapshot_path(workspace: Path, job_id: int) -> Path:
    return workspace / "runtime" / "jobs" / str(job_id) / "user-preferences.json"


def materialize_agent_preference_snapshot(
    conn: sqlite3.Connection,
    *,
    job: sqlite3.Row,
    workspace: Path,
) -> tuple[Path, dict]:
    payload = ensure_agent_preference_snapshot(conn, job=job)
    target = preference_snapshot_path(workspace, int(job["id"]))
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    temporary.replace(target)
    return target, payload
