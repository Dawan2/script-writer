from __future__ import annotations

import sqlite3
from typing import Literal, Optional

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field

from app.db.session import get_db
from app.dependencies import current_user
from app.services.audit_service import content_fingerprint, record_audit
from app.services.writer_preference_service import (
    MAX_PREFERENCE_CONTENT_CHARS,
    create_writer_preference,
    delete_writer_preference,
    export_writer_preferences,
    import_writer_preferences,
    list_writer_preferences,
    reorder_writer_preferences,
    update_writer_preference,
)


router = APIRouter(prefix="/me/writer-preferences", tags=["writer-preferences"])


def _preference_audit_snapshot(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    preference_id: int,
) -> dict | None:
    if preference_id < 0:
        system_preference_id = -preference_id
        row = conn.execute(
            """
            SELECT
                system_preference.*,
                COALESCE(preference_ref.enabled, 0) AS reference_enabled
            FROM system_writer_preferences AS system_preference
            LEFT JOIN user_system_writer_preference_refs AS preference_ref
              ON preference_ref.system_preference_id = system_preference.id
             AND preference_ref.user_id = ?
            WHERE system_preference.id = ?
            """,
            (user_id, system_preference_id),
        ).fetchone()
        if not row:
            return None
        scopes = [
            item["scope"]
            for item in conn.execute(
                """
                SELECT scope FROM system_writer_preference_scopes
                WHERE system_preference_id = ? ORDER BY scope
                """,
                (system_preference_id,),
            ).fetchall()
        ]
        return {
            "id": preference_id,
            "system_preference_id": system_preference_id,
            "is_system_preference": True,
            "content": content_fingerprint(row["content"]),
            "source": row["source"],
            "enabled": bool(row["reference_enabled"]),
            "scopes": scopes,
            "version": row["version"],
        }

    row = conn.execute(
        "SELECT * FROM writer_preferences WHERE id = ? AND user_id = ?",
        (preference_id, user_id),
    ).fetchone()
    if not row:
        return None
    scopes = [
        item["scope"]
        for item in conn.execute(
            "SELECT scope FROM writer_preference_scopes WHERE preference_id = ? ORDER BY scope",
            (preference_id,),
        ).fetchall()
    ]
    return {
        "id": row["id"],
        "content": content_fingerprint(row["content"]),
        "source": row["source"],
        "enabled": bool(row["enabled"]),
        "scopes": scopes,
        "position": row["position"],
        "version": row["version"],
    }


class WriterPreferenceCreate(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_PREFERENCE_CONTENT_CHARS)
    scopes: list[str] = Field(min_length=1)
    enabled: bool = True


class WriterPreferenceUpdate(BaseModel):
    content: Optional[str] = Field(default=None, min_length=1, max_length=MAX_PREFERENCE_CONTENT_CHARS)
    scopes: Optional[list[str]] = None
    enabled: Optional[bool] = None


class WriterPreferenceOrder(BaseModel):
    ordered_ids: list[int]


class WriterPreferenceImportItem(BaseModel):
    content: str
    scopes: list[str]
    enabled: bool = True


class WriterPreferencesImport(BaseModel):
    schema_version: str
    preferences: list[WriterPreferenceImportItem]
    mode: Literal["append", "replace"] = "append"


@router.get("")
def get_writer_preferences(
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    return list_writer_preferences(conn, int(user["id"]))


@router.get("/export")
def get_writer_preferences_export(
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    result = export_writer_preferences(conn, user_id=int(user["id"]))
    record_audit(
        conn,
        actor=user,
        action="writer_preference.export",
        target_type="writer_preference_profile",
        target_id=user["id"],
        target_label=user["username"],
        details={"schema_version": result["schema_version"], "preference_count": len(result["preferences"])},
    )
    return result


@router.post("/import")
def post_writer_preferences_import(
    payload: WriterPreferencesImport,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    result = import_writer_preferences(
        conn,
        user_id=int(user["id"]),
        schema_version=payload.schema_version,
        preferences=[item.model_dump() for item in payload.preferences],
        mode=payload.mode,
    )
    record_audit(
        conn,
        actor=user,
        action="writer_preference.import",
        target_type="writer_preference_profile",
        target_id=user["id"],
        target_label=user["username"],
        details={"mode": payload.mode, "schema_version": payload.schema_version, **result},
    )
    return result


@router.post("", status_code=status.HTTP_201_CREATED)
def post_writer_preference(
    payload: WriterPreferenceCreate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    result = create_writer_preference(
        conn,
        user_id=int(user["id"]),
        content=payload.content,
        scopes=payload.scopes,
        enabled=payload.enabled,
        source="manual",
    )
    preference = result["preference"]
    record_audit(
        conn,
        actor=user,
        action="writer_preference.create",
        target_type="writer_preference",
        target_id=preference["id"],
        target_label=f"创作偏好 #{preference['id']}",
        details=_preference_audit_snapshot(conn, user_id=int(user["id"]), preference_id=int(preference["id"])) or {},
    )
    return result


@router.patch("/{preference_id}")
def patch_writer_preference(
    preference_id: int,
    payload: WriterPreferenceUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    before = _preference_audit_snapshot(conn, user_id=int(user["id"]), preference_id=preference_id)
    result = update_writer_preference(
        conn,
        user_id=int(user["id"]),
        preference_id=preference_id,
        content=payload.content,
        scopes=payload.scopes,
        enabled=payload.enabled,
    )
    after = _preference_audit_snapshot(conn, user_id=int(user["id"]), preference_id=preference_id)
    if before != after:
        is_system_preference = preference_id < 0
        record_audit(
            conn,
            actor=user,
            action="writer_preference.system_update" if is_system_preference else "writer_preference.update",
            target_type="system_writer_preference" if is_system_preference else "writer_preference",
            target_id=-preference_id if is_system_preference else preference_id,
            target_label=f"系统偏好 #{-preference_id}" if is_system_preference else f"创作偏好 #{preference_id}",
            details={"before": before, "after": after},
        )
    return result


@router.delete("/{preference_id}")
def remove_writer_preference(
    preference_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    before = _preference_audit_snapshot(conn, user_id=int(user["id"]), preference_id=preference_id)
    result = delete_writer_preference(conn, user_id=int(user["id"]), preference_id=preference_id)
    record_audit(
        conn,
        actor=user,
        action="writer_preference.delete",
        target_type="writer_preference",
        target_id=preference_id,
        target_label=f"创作偏好 #{preference_id}",
        details={"before": before},
        severity="warning",
    )
    return result


@router.put("/order")
def put_writer_preference_order(
    payload: WriterPreferenceOrder,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    before = [
        int(row["id"])
        for row in conn.execute(
            """
            SELECT writer_preference.id FROM writer_preferences AS writer_preference
            WHERE writer_preference.user_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM system_writer_preferences
                  WHERE source_preference_id = writer_preference.id
              )
            ORDER BY writer_preference.position, writer_preference.id
            """,
            (user["id"],),
        ).fetchall()
    ]
    result = reorder_writer_preferences(conn, user_id=int(user["id"]), ordered_ids=payload.ordered_ids)
    if before != payload.ordered_ids:
        record_audit(
            conn,
            actor=user,
            action="writer_preference.reorder",
            target_type="writer_preference_profile",
            target_id=user["id"],
            target_label=user["username"],
            details={"before_order": before, "after_order": payload.ordered_ids, "profile_revision": result["profile_revision"]},
        )
    return result
