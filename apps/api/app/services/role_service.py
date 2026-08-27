from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status

from app.services.audit_service import record_audit


ROLE_CODE_SYSTEM_ADMIN = "system_administrator"
ROLE_CODE_DEFAULT_CREATOR = "default_creator"

SCENARIO_PERMISSION_PREFIX = "scenario:"
BATCH_TASK_PERMISSION = "batch_tasks"
ADMIN_PERMISSION_PREFIX = "admin:"

SCENARIO_DEFINITIONS: tuple[dict[str, str], ...] = (
    {"key": "rewrite", "label": "剧本改写"},
    {"key": "novel", "label": "小说改编"},
    {"key": "replicate", "label": "爆款复刻"},
    {"key": "review", "label": "剧本审核"},
    {"key": "translate", "label": "台词翻译"},
    {"key": "humanize", "label": "剧本润色"},
)

ADMIN_FEATURE_DEFINITIONS: tuple[dict[str, str], ...] = (
    {"key": "dashboard", "label": "经营概览"},
    {"key": "users", "label": "用户管理"},
    {"key": "roles", "label": "角色管理"},
    {"key": "notifications", "label": "系统通知"},
    {"key": "credits", "label": "创作额度"},
    {"key": "regions", "label": "地区规则"},
    {"key": "projects", "label": "项目管理"},
    {"key": "models", "label": "模型管理"},
    {"key": "script_sync", "label": "剧本同步"},
    {"key": "distillation", "label": "剧本蒸馏"},
    {"key": "jobs", "label": "任务运行"},
    {"key": "evolution", "label": "Agent 进化"},
    {"key": "audit", "label": "审计日志"},
)

SCENARIO_PERMISSION_KEYS = frozenset(
    f"{SCENARIO_PERMISSION_PREFIX}{item['key']}" for item in SCENARIO_DEFINITIONS
)
ADMIN_PERMISSION_KEYS = frozenset(
    f"{ADMIN_PERMISSION_PREFIX}{item['key']}" for item in ADMIN_FEATURE_DEFINITIONS
)
ALL_PERMISSION_KEYS = frozenset({*SCENARIO_PERMISSION_KEYS, BATCH_TASK_PERMISSION, *ADMIN_PERMISSION_KEYS})


def _row_value(row: sqlite3.Row | dict[str, Any], key: str, default: Any = None) -> Any:
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


def scenario_permission_key(scenario_key: str) -> str:
    return f"{SCENARIO_PERMISSION_PREFIX}{scenario_key}"


def admin_permission_key(feature_key: str) -> str:
    return f"{ADMIN_PERMISSION_PREFIX}{feature_key}"


def permission_catalog() -> dict[str, Any]:
    return {
        "scenarios": [
            {**item, "permission_key": scenario_permission_key(item["key"])}
            for item in SCENARIO_DEFINITIONS
        ],
        "batch_task": {"permission_key": BATCH_TASK_PERMISSION, "label": "批量任务"},
        "admin": [
            {**item, "permission_key": admin_permission_key(item["key"])}
            for item in ADMIN_FEATURE_DEFINITIONS
        ],
    }


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    return bool(conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone())


def _role_id_by_code(conn: sqlite3.Connection, code: str) -> int:
    row = conn.execute("SELECT id FROM roles WHERE code = ?", (code,)).fetchone()
    if not row:
        raise RuntimeError("内置角色初始化失败")
    return int(row["id"])


def _replace_role_permissions(conn: sqlite3.Connection, role_id: int, permission_keys: Iterable[str]) -> None:
    conn.execute("DELETE FROM role_permissions WHERE role_id = ?", (role_id,))
    conn.executemany(
        "INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)",
        [(role_id, key) for key in sorted(set(permission_keys))],
    )


def _ensure_builtin_role(
    conn: sqlite3.Connection,
    *,
    code: str,
    name: str,
    description: str,
    permission_keys: Iterable[str],
    preserve_permissions: bool = False,
) -> int:
    expected_permissions = set(permission_keys)
    row = conn.execute(
        "SELECT id, name, description, is_system, permissions_configured FROM roles WHERE code = ?",
        (code,),
    ).fetchone()
    created = row is None
    if row:
        role_id = int(row["id"])
        if (
            row["name"] != name
            or (row["description"] or "") != description
            or not row["is_system"]
        ):
            conn.execute(
                "UPDATE roles SET name = ?, description = ?, is_system = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (name, description, role_id),
            )
    else:
        cursor = conn.execute(
            """
            INSERT INTO roles (code, name, description, is_system, permissions_configured)
            VALUES (?, ?, ?, 1, 0)
            """,
            (code, name, description),
        )
        role_id = int(cursor.lastrowid)
    current_permissions = {
        str(item["permission_key"])
        for item in conn.execute(
            "SELECT permission_key FROM role_permissions WHERE role_id = ?",
            (role_id,),
        ).fetchall()
    }
    permissions_configured = bool(row["permissions_configured"]) if row else False
    should_seed_permissions = (
        (created or not permissions_configured)
        if preserve_permissions
        else current_permissions != expected_permissions
    )
    if should_seed_permissions:
        _replace_role_permissions(conn, role_id, expected_permissions)
    if should_seed_permissions or not permissions_configured:
        conn.execute(
            "UPDATE roles SET permissions_configured = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (role_id,),
        )
    return role_id


def ensure_role_defaults(conn: sqlite3.Connection) -> None:
    """Create compatibility roles and initialize legacy accounts without overwriting managed permissions."""
    if not _table_exists(conn, "roles"):
        return
    admin_role_id = _ensure_builtin_role(
        conn,
        code=ROLE_CODE_SYSTEM_ADMIN,
        name="系统管理员",
        description="拥有所有场景、批量任务和管理后台功能的访问权限。",
        permission_keys=ALL_PERMISSION_KEYS,
    )
    creator_role_id = _ensure_builtin_role(
        conn,
        code=ROLE_CODE_DEFAULT_CREATOR,
        name="默认创作者",
        description="新用户默认使用的基础角色，可配置场景、批量任务和管理后台权限。",
        permission_keys=SCENARIO_PERMISSION_KEYS,
        preserve_permissions=True,
    )

    columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "role_assignments_initialized" not in columns:
        return
    legacy_users = conn.execute(
        """
        SELECT id, role
        FROM users
        WHERE COALESCE(is_system, 0) = 0
          AND COALESCE(role_assignments_initialized, 0) = 0
        """
    ).fetchall()
    for user in legacy_users:
        role_id = admin_role_id if user["role"] == "admin" else creator_role_id
        conn.execute(
            "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)",
            (user["id"], role_id),
        )
        conn.execute(
            "UPDATE users SET role_assignments_initialized = 1 WHERE id = ?",
            (user["id"],),
        )


def _role_permission_map(conn: sqlite3.Connection, role_ids: Iterable[int]) -> dict[int, list[str]]:
    ids = list(dict.fromkeys(role_ids))
    if not ids:
        return {}
    placeholders = ", ".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT role_id, permission_key
        FROM role_permissions
        WHERE role_id IN ({placeholders})
        ORDER BY permission_key
        """,
        ids,
    ).fetchall()
    result = {role_id: [] for role_id in ids}
    for row in rows:
        result[int(row["role_id"])].append(str(row["permission_key"]))
    return result


def _public_role(row: sqlite3.Row, permission_keys: Iterable[str], assigned_user_count: int = 0) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "code": str(row["code"]),
        "name": str(row["name"]),
        "description": str(row["description"] or ""),
        "is_system": bool(row["is_system"]),
        "permission_keys": list(permission_keys),
        "assigned_user_count": int(assigned_user_count),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_roles(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    ensure_role_defaults(conn)
    rows = conn.execute(
        """
        SELECT roles.*, COUNT(DISTINCT user_roles.user_id) AS assigned_user_count
        FROM roles
        LEFT JOIN user_roles ON user_roles.role_id = roles.id
        GROUP BY roles.id
        ORDER BY roles.is_system DESC, roles.name COLLATE NOCASE, roles.id
        """
    ).fetchall()
    permissions = _role_permission_map(conn, [int(row["id"]) for row in rows])
    return [
        _public_role(row, permissions.get(int(row["id"]), []), int(row["assigned_user_count"]))
        for row in rows
    ]


def list_role_management(conn: sqlite3.Connection) -> dict[str, Any]:
    return {"catalog": permission_catalog(), "roles": list_roles(conn)}


def can_manage_role_definitions(conn: sqlite3.Connection, actor: sqlite3.Row | dict[str, Any]) -> bool:
    return admin_permission_key("roles") in permission_keys_for_user(conn, actor)


def list_assignable_roles(conn: sqlite3.Connection, actor: sqlite3.Row | dict[str, Any]) -> list[dict[str, Any]]:
    """Return roles that the current user may attach to another account."""
    roles = list_roles(conn)
    if can_manage_role_definitions(conn, actor):
        return roles
    actor_permissions = permission_keys_for_user(conn, actor)
    return [
        role
        for role in roles
        if not role["is_system"] and set(role["permission_keys"]).issubset(actor_permissions)
    ]


def can_manage_user_account(
    conn: sqlite3.Connection,
    actor: sqlite3.Row | dict[str, Any],
    target: sqlite3.Row | dict[str, Any],
) -> bool:
    """Whether an actor may perform account-level operations on the target."""
    ensure_role_defaults(conn)
    if can_manage_role_definitions(conn, actor):
        return True
    target_id = _row_value(target, "id")
    if target_id is None:
        return False
    actor_permissions = permission_keys_for_user(conn, actor)
    role_ids = _role_ids_for_user(conn, int(target_id))
    permissions_by_role = _role_permission_map(conn, role_ids)
    for role_id in role_ids:
        role = _require_role(conn, role_id)
        if role["is_system"] or not set(permissions_by_role.get(role_id, [])).issubset(actor_permissions):
            return False
    return True


def require_manage_user_account(
    conn: sqlite3.Connection,
    actor: sqlite3.Row | dict[str, Any],
    target: sqlite3.Row | dict[str, Any],
) -> None:
    if can_manage_user_account(conn, actor, target):
        return
    record_audit(
        conn,
        actor=actor,
        action="authorization.denied",
        target_type="user",
        target_id=_row_value(target, "id"),
        target_label=str(_row_value(target, "username", "用户账号")),
        outcome="denied",
        severity="warning",
        details={"required_permission": "admin:users", "reason": "target_role_out_of_scope"},
    )
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="你不能管理权限高于当前账号的用户")


def _normalize_permission_keys(permission_keys: Iterable[str]) -> list[str]:
    values = [str(key).strip() for key in permission_keys]
    normalized = sorted({key for key in values if key})
    invalid = [key for key in normalized if key not in ALL_PERMISSION_KEYS]
    if invalid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="包含无效的权限项")
    return normalized


def _require_role(conn: sqlite3.Connection, role_id: int) -> sqlite3.Row:
    role = conn.execute("SELECT * FROM roles WHERE id = ?", (role_id,)).fetchone()
    if not role:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="角色不存在")
    return role


def create_role(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    name: str,
    description: str = "",
    permission_keys: Iterable[str] = (),
) -> dict[str, Any]:
    ensure_role_defaults(conn)
    normalized_name = name.strip()
    normalized_description = description.strip()
    if not normalized_name or len(normalized_name) > 60:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="角色名称不能为空且不能超过 60 个字符")
    if len(normalized_description) > 200:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="角色说明不能超过 200 个字符")
    normalized_permissions = _normalize_permission_keys(permission_keys)
    try:
        cursor = conn.execute(
            """
            INSERT INTO roles (code, name, description, is_system, created_by)
            VALUES (?, ?, ?, 0, ?)
            """,
            (f"custom-{uuid.uuid4().hex}", normalized_name, normalized_description, actor["id"]),
        )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="角色名称已存在") from exc
    role_id = int(cursor.lastrowid)
    _replace_role_permissions(conn, role_id, normalized_permissions)
    record_audit(
        conn,
        actor=actor,
        action="role.create",
        target_type="role",
        target_id=role_id,
        target_label=normalized_name,
        details={"permission_keys": normalized_permissions},
    )
    role = _require_role(conn, role_id)
    return _public_role(role, normalized_permissions)


def update_role(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    role_id: int,
    name: str | None = None,
    description: str | None = None,
    permission_keys: Iterable[str] | None = None,
) -> dict[str, Any]:
    ensure_role_defaults(conn)
    role = _require_role(conn, role_id)
    if role["is_system"] and role["code"] != ROLE_CODE_DEFAULT_CREATOR:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="内置角色不能修改")
    if role["is_system"] and (name is not None or description is not None):
        if name is not None and str(name).strip() != str(role["name"]):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="默认创作者名称不能修改")
        if description is not None and str(description).strip() != str(role["description"] or ""):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="默认创作者说明不能修改")
    next_name = str(name if name is not None else role["name"]).strip()
    next_description = str(description if description is not None else role["description"] or "").strip()
    if not next_name or len(next_name) > 60:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="角色名称不能为空且不能超过 60 个字符")
    if len(next_description) > 200:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="角色说明不能超过 200 个字符")
    current_permissions = _role_permission_map(conn, [role_id]).get(role_id, [])
    next_permissions = _normalize_permission_keys(permission_keys) if permission_keys is not None else current_permissions
    try:
        conn.execute(
            "UPDATE roles SET name = ?, description = ?, permissions_configured = CASE WHEN ? THEN 1 ELSE permissions_configured END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (next_name, next_description, int(role["code"] == ROLE_CODE_DEFAULT_CREATOR), role_id),
        )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="角色名称已存在") from exc
    _replace_role_permissions(conn, role_id, next_permissions)
    record_audit(
        conn,
        actor=actor,
        action="role.update",
        target_type="role",
        target_id=role_id,
        target_label=next_name,
        details={"permission_keys": next_permissions},
    )
    updated = _require_role(conn, role_id)
    assigned_count = conn.execute("SELECT COUNT(*) FROM user_roles WHERE role_id = ?", (role_id,)).fetchone()[0]
    return _public_role(updated, next_permissions, int(assigned_count))


def delete_role(conn: sqlite3.Connection, *, actor: sqlite3.Row, role_id: int) -> None:
    ensure_role_defaults(conn)
    role = _require_role(conn, role_id)
    if role["is_system"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="内置角色不能删除")
    assigned_count = int(conn.execute("SELECT COUNT(*) FROM user_roles WHERE role_id = ?", (role_id,)).fetchone()[0])
    if assigned_count:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该角色仍分配给用户，请先调整用户角色")
    conn.execute("DELETE FROM roles WHERE id = ?", (role_id,))
    record_audit(
        conn,
        actor=actor,
        action="role.delete",
        target_type="role",
        target_id=role_id,
        target_label=str(role["name"]),
        severity="warning",
    )


def roles_for_user_ids(conn: sqlite3.Connection, user_ids: Iterable[int]) -> dict[int, list[dict[str, Any]]]:
    ensure_role_defaults(conn)
    ids = list(dict.fromkeys(int(user_id) for user_id in user_ids))
    if not ids:
        return {}
    placeholders = ", ".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT user_roles.user_id, roles.id, roles.name, roles.description, roles.is_system, roles.code
        FROM user_roles
        JOIN roles ON roles.id = user_roles.role_id
        WHERE user_roles.user_id IN ({placeholders})
        ORDER BY roles.is_system DESC, roles.name COLLATE NOCASE, roles.id
        """,
        ids,
    ).fetchall()
    result: dict[int, list[dict[str, Any]]] = {user_id: [] for user_id in ids}
    for row in rows:
        result[int(row["user_id"])].append({
            "id": int(row["id"]),
            "name": str(row["name"]),
            "is_system": bool(row["is_system"]),
            "code": str(row["code"]),
        })
    return result


def _system_admin_count(conn: sqlite3.Connection) -> int:
    return int(conn.execute(
        """
        SELECT COUNT(DISTINCT users.id)
        FROM users
        JOIN user_roles ON user_roles.user_id = users.id
        JOIN roles ON roles.id = user_roles.role_id
        WHERE roles.code = ?
          AND users.is_active = 1
          AND COALESCE(users.is_system, 0) = 0
        """,
        (ROLE_CODE_SYSTEM_ADMIN,),
    ).fetchone()[0])


def _role_ids_for_user(conn: sqlite3.Connection, user_id: int) -> set[int]:
    rows = conn.execute("SELECT role_id FROM user_roles WHERE user_id = ?", (user_id,)).fetchall()
    return {int(row["role_id"]) for row in rows}


def _sync_legacy_user_role(conn: sqlite3.Connection, user_id: int) -> None:
    is_system_admin = bool(conn.execute(
        """
        SELECT 1
        FROM user_roles
        JOIN roles ON roles.id = user_roles.role_id
        WHERE user_roles.user_id = ? AND roles.code = ?
        """,
        (user_id, ROLE_CODE_SYSTEM_ADMIN),
    ).fetchone())
    conn.execute(
        """
        UPDATE users
        SET role = ?, role_assignments_initialized = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        ("admin" if is_system_admin else "user", user_id),
    )


def permission_keys_for_user(conn: sqlite3.Connection, user: sqlite3.Row | dict[str, Any]) -> frozenset[str]:
    if not _table_exists(conn, "roles"):
        return ALL_PERMISSION_KEYS if _row_value(user, "role") == "admin" else SCENARIO_PERMISSION_KEYS
    ensure_role_defaults(conn)
    user_id = _row_value(user, "id")
    if user_id is None:
        return frozenset()
    rows = conn.execute(
        """
        SELECT DISTINCT role_permissions.permission_key
        FROM user_roles
        JOIN role_permissions ON role_permissions.role_id = user_roles.role_id
        WHERE user_roles.user_id = ?
        """,
        (user_id,),
    ).fetchall()
    return frozenset(str(row["permission_key"]) for row in rows)


def user_has_permission(conn: sqlite3.Connection, user: sqlite3.Row | dict[str, Any], permission_key: str) -> bool:
    return permission_key in permission_keys_for_user(conn, user)


def user_has_any_admin_permission(conn: sqlite3.Connection, user: sqlite3.Row | dict[str, Any]) -> bool:
    return bool(permission_keys_for_user(conn, user) & ADMIN_PERMISSION_KEYS)


def user_has_scenario_permission(conn: sqlite3.Connection, user: sqlite3.Row | dict[str, Any], scenario_key: str) -> bool:
    return user_has_permission(conn, user, scenario_permission_key(scenario_key))


def accessible_scenario_keys(conn: sqlite3.Connection, user: sqlite3.Row | dict[str, Any]) -> set[str]:
    permissions = permission_keys_for_user(conn, user)
    return {
        item["key"]
        for item in SCENARIO_DEFINITIONS
        if scenario_permission_key(item["key"]) in permissions
    }


def _require_permission(conn: sqlite3.Connection, user: sqlite3.Row | dict[str, Any], permission_key: str) -> None:
    if user_has_permission(conn, user, permission_key):
        return
    record_audit(
        conn,
        actor=user,
        action="authorization.denied",
        target_type="permission",
        target_id=permission_key,
        target_label="功能权限",
        outcome="denied",
        severity="warning",
        details={"required_permission": permission_key},
    )
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="你没有使用此功能的权限")


def require_scenario_permission(conn: sqlite3.Connection, user: sqlite3.Row | dict[str, Any], scenario_key: str) -> None:
    _require_permission(conn, user, scenario_permission_key(scenario_key))


def require_feature_permission(conn: sqlite3.Connection, user: sqlite3.Row | dict[str, Any], permission_key: str) -> None:
    _require_permission(conn, user, permission_key)


def replace_user_roles(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    target: sqlite3.Row,
    role_ids: Iterable[int],
    preserve_unassignable_existing: bool = True,
) -> list[dict[str, Any]]:
    ensure_role_defaults(conn)
    requested_ids = list(dict.fromkeys(int(role_id) for role_id in role_ids))
    selected_roles = [_require_role(conn, role_id) for role_id in requested_ids]
    actor_permissions = permission_keys_for_user(conn, actor)
    can_manage_roles = admin_permission_key("roles") in actor_permissions
    current_ids = _role_ids_for_user(conn, int(target["id"]))
    if not can_manage_roles:
        for role in selected_roles:
            permissions = set(_role_permission_map(conn, [int(role["id"])]).get(int(role["id"]), []))
            if (
                (role["is_system"] or not permissions.issubset(actor_permissions))
                and int(role["id"]) not in current_ids
            ):
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="你不能分配超出自身权限的角色")
        if preserve_unassignable_existing:
            current_roles = [_require_role(conn, role_id) for role_id in current_ids]
            protected_ids = [
                int(role["id"])
                for role in current_roles
                if role["is_system"]
                or not set(_role_permission_map(conn, [int(role["id"])]).get(int(role["id"]), [])).issubset(actor_permissions)
            ]
            requested_ids.extend(role_id for role_id in protected_ids if role_id not in requested_ids)
            selected_roles = [_require_role(conn, role_id) for role_id in requested_ids]

    normalized_ids = requested_ids
    system_admin_id = _role_id_by_code(conn, ROLE_CODE_SYSTEM_ADMIN)
    if system_admin_id in current_ids and system_admin_id not in normalized_ids and _system_admin_count(conn) <= 1:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="必须保留至少一位系统管理员")
    if int(target["id"]) == int(actor["id"]):
        selected_permissions = set()
        for role in selected_roles:
            selected_permissions.update(_role_permission_map(conn, [int(role["id"])]).get(int(role["id"]), []))
        if admin_permission_key("users") not in selected_permissions:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="不能移除当前账号的用户管理权限")

    conn.execute("DELETE FROM user_roles WHERE user_id = ?", (target["id"],))
    conn.executemany(
        "INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)",
        [(target["id"], role_id, actor["id"]) for role_id in normalized_ids],
    )
    _sync_legacy_user_role(conn, int(target["id"]))
    record_audit(
        conn,
        actor=actor,
        action="user.roles.update",
        target_type="user",
        target_id=target["id"],
        target_label=str(target["username"]),
        details={"role_ids": normalized_ids},
    )
    return roles_for_user_ids(conn, [int(target["id"])]).get(int(target["id"]), [])


def assign_default_role_to_user(conn: sqlite3.Connection, *, user_id: int) -> None:
    """Give newly created users the compatibility creator role once."""
    ensure_role_defaults(conn)
    if not _table_exists(conn, "user_roles"):
        return
    if _role_ids_for_user(conn, user_id):
        return
    creator_role_id = _role_id_by_code(conn, ROLE_CODE_DEFAULT_CREATOR)
    conn.execute("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", (user_id, creator_role_id))
    _sync_legacy_user_role(conn, user_id)


def assign_legacy_role(conn: sqlite3.Connection, *, actor: sqlite3.Row, target: sqlite3.Row, role: str) -> list[dict[str, Any]]:
    ensure_role_defaults(conn)
    if role not in {"admin", "user"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="无效的用户角色")
    current_ids = _role_ids_for_user(conn, int(target["id"]))
    admin_role_id = _role_id_by_code(conn, ROLE_CODE_SYSTEM_ADMIN)
    creator_role_id = _role_id_by_code(conn, ROLE_CODE_DEFAULT_CREATOR)
    if role == "admin":
        current_ids.add(admin_role_id)
    else:
        current_ids.discard(admin_role_id)
        if not current_ids:
            current_ids.add(creator_role_id)
    return replace_user_roles(conn, actor=actor, target=target, role_ids=sorted(current_ids))
