from __future__ import annotations

import hmac
import sqlite3
from typing import Annotated, Optional

from fastapi import Depends, Header

from app.core.config import LOCAL_SCRIPT_SYNC_INTERNAL_TOKEN, settings
from app.core.errors import APIError
from app.core.security import TOKEN_EXPIRED, read_access_token
from app.db.session import get_db
from app.services.audit_service import record_audit
from app.services.auth_service import get_user_by_id
from app.services.role_service import (
    admin_permission_key,
    require_feature_permission,
    user_has_any_admin_permission,
)


def current_user(
    authorization: Annotated[Optional[str], Header()] = None,
    conn: sqlite3.Connection = Depends(get_db),
    script_sync_internal_token: Annotated[Optional[str], Header(alias="X-Script-Sync-Internal-Token")] = None,
) -> sqlite3.Row:
    # The sync worker asks the colocated web server to render delivery Word
    # documents. It has no browser cookie, so this private, shared token gives
    # that one service-to-service hop an active administrator identity.
    expected_internal_token = str(
        getattr(settings, "script_sync_attachment_export_token", getattr(settings, "script_sync_internal_token", "")) or ""
    ).strip()
    if (
        not expected_internal_token
        and bool(getattr(settings, "script_sync_local_mode", False))
        and not str(getattr(settings, "script_sync_internal_token", "") or "").strip()
    ):
        expected_internal_token = LOCAL_SCRIPT_SYNC_INTERNAL_TOKEN
    if (
        expected_internal_token
        and script_sync_internal_token
        and hmac.compare_digest(script_sync_internal_token, expected_internal_token)
    ):
        service_user = conn.execute(
            """
            SELECT * FROM users
            WHERE role = 'admin' AND is_active = 1
            ORDER BY id ASC
            LIMIT 1
            """
        ).fetchone()
        if service_user:
            return service_user
    if not authorization or not authorization.lower().startswith("bearer "):
        raise APIError("AUTH_REQUIRED")
    token = authorization.split(" ", 1)[1]
    payload, reason = read_access_token(token)
    if not payload:
        raise APIError("SESSION_EXPIRED" if reason == TOKEN_EXPIRED else "SESSION_INVALID")
    user = get_user_by_id(conn, int(payload["sub"]))
    if not user or not user["is_active"]:
        raise APIError("ACCOUNT_DISABLED")
    auth_version = user["auth_version"] if "auth_version" in user.keys() else 0
    if int(payload.get("ver", 0)) != int(auth_version):
        raise APIError("SESSION_SUPERSEDED")
    return user


def admin_user(
    user: sqlite3.Row = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> sqlite3.Row:
    # Keep the direct helper usable in lightweight legacy tests, while real
    # requests resolve their access through the persisted role assignments.
    allowed = user["role"] == "admin" if not isinstance(conn, sqlite3.Connection) else user_has_any_admin_permission(conn, user)
    if not allowed:
        if isinstance(conn, sqlite3.Connection):
            record_audit(
                conn,
                actor=user,
                action="authorization.denied",
                target_type="admin_console",
                target_label="管理后台",
                outcome="denied",
                severity="warning",
                details={"required_role": "admin"},
            )
        raise APIError("PERMISSION_DENIED", message="这个功能只对管理员开放。")
    return user


def permission_user(permission_key: str):
    """Return a FastAPI dependency that enforces one product capability."""
    def dependency(
        user: sqlite3.Row = Depends(current_user),
        conn: sqlite3.Connection = Depends(get_db),
    ) -> sqlite3.Row:
        require_feature_permission(conn, user, permission_key)
        return user

    return dependency


def admin_feature_user(feature_key: str):
    return permission_user(admin_permission_key(feature_key))
