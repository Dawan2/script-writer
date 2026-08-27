from __future__ import annotations

import sqlite3
from collections.abc import Iterable

from fastapi import HTTPException, status

from app.core.security import hash_password, verify_password
from app.services.audit_service import record_audit
from app.services.writer_preference_service import initialize_system_writer_preferences_for_user


def get_user_by_username(conn: sqlite3.Connection, username: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def get_user_by_id(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def create_user(
    conn: sqlite3.Connection,
    *,
    username: str,
    password: str,
    display_name: str | None = None,
    role: str = "user",
) -> sqlite3.Row:
    conn.execute(
        """
        INSERT INTO users (username, display_name, password_hash, role)
        VALUES (?, ?, ?, ?)
        """,
        (username, display_name or username, hash_password(password), role),
    )
    user = get_user_by_username(conn, username)
    if user:
        initialize_system_writer_preferences_for_user(conn, user_id=int(user["id"]))
        try:
            from app.services.role_service import assign_default_role_to_user

            assign_default_role_to_user(conn, user_id=int(user["id"]))
        except sqlite3.OperationalError:
            # Focused legacy tests can intentionally omit the RBAC tables.
            pass
        try:
            conn.execute(
                "INSERT OR IGNORE INTO credit_accounts (user_id, balance) VALUES (?, 0)",
                (user["id"],),
            )
            from app.services.credit_service import set_user_credit_plan

            set_user_credit_plan(
                conn,
                user_id=int(user["id"]),
                plan_code="free",
                granted_by=None,
            )
        except sqlite3.OperationalError:
            # Focused legacy tests can intentionally omit optional business tables.
            pass
    return user


def authenticate_user(conn: sqlite3.Connection, username: str, password: str) -> sqlite3.Row | None:
    user = get_user_by_username(conn, username)
    if not user or not user["is_active"]:
        return None
    if not verify_password(password, user["password_hash"]):
        return None
    return user


def change_password(
    conn: sqlite3.Connection,
    *,
    user: sqlite3.Row,
    current_password: str,
    new_password: str,
) -> sqlite3.Row:
    if not verify_password(current_password, user["password_hash"]):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="当前密码不正确")

    if len(new_password) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="新密码至少需要 8 个字符")
    if len(new_password) > 200:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="新密码不能超过 200 个字符")
    if current_password == new_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="新密码不能与当前密码相同")

    next_auth_version = int(user["auth_version"] if "auth_version" in user.keys() else 0) + 1
    cursor = conn.execute(
        """
        UPDATE users
        SET password_hash = ?, auth_version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND password_hash = ?
        """,
        (hash_password(new_password), next_auth_version, user["id"], user["password_hash"]),
    )
    if cursor.rowcount != 1:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="密码已变更，请重新登录后再试")

    updated_user = get_user_by_id(conn, user["id"])
    if not updated_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")

    record_audit(
        conn,
        actor=updated_user,
        action="auth.password_change",
        target_type="user",
        target_id=updated_user["id"],
        target_label=updated_user["username"],
    )
    return updated_user


def public_user(user: sqlite3.Row, *, permission_keys: Iterable[str] = ()) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "role": user["role"],
        "permissions": sorted(set(permission_keys)),
    }
