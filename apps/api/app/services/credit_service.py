from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status


STAGE_CREDITS: dict[str, int] = {
    "novel_analysis": 5,
    "world_view": 1,
    "character_rewrite": 2,
    "outline_rewrite": 3,
    "trial_generate": 5,
    "full_generate": 10,
    "dialogue_translate": 4,
    "foreign_review": 15,
    "humanizer_zh": 5,
}

STAGE_LABELS: dict[str, str] = {
    "novel_analysis": "小说解读",
    "world_view": "世界观",
    "outline_rewrite": "故事梗概",
    "character_rewrite": "人物小传",
    "trial_generate": "剧本试稿",
    "full_generate": "完整剧本",
    "dialogue_translate": "台词翻译",
    "foreign_review": "海外审稿",
    "humanizer_zh": "剧本润色",
}

SHANGHAI = ZoneInfo("Asia/Shanghai")
PLAN_TERM_DAYS = 30

CREDIT_PLANS: dict[str, dict[str, Any]] = {
    "free": {
        "code": "free",
        "label": "体验套餐",
        "cadence": "once",
        "allowance": 55,
        "max_concurrent_jobs": 1,
        "description": "预估可完成 1 次完整剧本改写，和 1 次海外审稿。",
    },
    "basic": {
        "code": "basic",
        "label": "初级套餐",
        "cadence": "daily",
        "allowance": 60,
        "max_concurrent_jobs": 2,
        "description": "预估每天可完成 1 次完整剧本改写。",
    },
    "advanced": {
        "code": "advanced",
        "label": "高级套餐",
        "cadence": "daily",
        "allowance": 150,
        "max_concurrent_jobs": 3,
        "description": "预估每天可完成 3 次完整剧本改写。",
    },
}

CONCURRENCY_LIMIT_ERROR = "AI_CONCURRENCY_LIMIT_REACHED"


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return bool(conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone())


def credits_available(conn: sqlite3.Connection) -> bool:
    return all(_table_exists(conn, table) for table in (
        "credit_accounts", "credit_stage_prices", "agent_job_credits", "credit_ledger",
    ))


def _account_row(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM credit_accounts WHERE user_id = ?", (user_id,)
    ).fetchone()


def _row_value(row: sqlite3.Row | None, key: str, default: Any = None) -> Any:
    if row is None or key not in row.keys():
        return default
    return row[key]


def _credit_components(account: sqlite3.Row | None) -> dict[str, int]:
    """Return the spendable sources, treating pre-bucket balances as long-lived."""
    balance = int(_row_value(account, "balance", 0) or 0)
    experience = int(_row_value(account, "experience_balance", 0) or 0)
    supplemental = int(_row_value(account, "supplemental_balance", 0) or 0)
    plan = int(_row_value(account, "plan_balance", 0) or 0)
    unclassified = max(0, balance - experience - supplemental - plan)
    return {
        "experience": experience,
        "supplemental": supplemental + unclassified,
        "plan": plan,
    }


def _credit_breakdown(account: sqlite3.Row | None) -> dict[str, int]:
    return _credit_components(account)


def _allocate_credits(
    account: sqlite3.Row,
    amount: int,
    *,
    order: tuple[str, ...] = ("experience", "supplemental", "plan"),
) -> dict[str, int] | None:
    if amount <= 0:
        return {"experience": 0, "supplemental": 0, "plan": 0}
    components = _credit_components(account)
    if sum(components.values()) < amount:
        return None
    remaining = amount
    allocation = {"experience": 0, "supplemental": 0, "plan": 0}
    for source in order:
        used = min(remaining, components[source])
        allocation[source] = used
        remaining -= used
        if remaining == 0:
            break
    return allocation if remaining == 0 else None


def _save_credit_components(
    conn: sqlite3.Connection,
    *,
    account: sqlite3.Row,
    components: dict[str, int],
    plan_balance_grant_key: str | None | object = ...,
) -> sqlite3.Row | None:
    if any(value < 0 for value in components.values()):
        return None
    next_balance = sum(components.values())
    key = _row_value(account, "plan_balance_grant_key") if plan_balance_grant_key is ... else plan_balance_grant_key
    result = conn.execute(
        """
        UPDATE credit_accounts
        SET balance = ?, experience_balance = ?, supplemental_balance = ?, plan_balance = ?,
            plan_balance_grant_key = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND balance = ?
        """,
        (
            next_balance,
            components["experience"],
            components["supplemental"],
            components["plan"],
            key,
            account["user_id"],
            account["balance"],
        ),
    )
    if result.rowcount != 1:
        return None
    return _account_row(conn, int(account["user_id"]))


def _record_credit_ledger(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    project_id: int | None,
    job_id: int | None,
    kind: str,
    delta: int,
    balance_after: int,
    note: str,
) -> None:
    conn.execute(
        """
        INSERT INTO credit_ledger (user_id, project_id, job_id, kind, delta, balance_after, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, project_id, job_id, kind, delta, balance_after, note),
    )


def _as_utc(value: datetime | None = None) -> datetime:
    current = value or datetime.now(timezone.utc)
    return current.replace(tzinfo=timezone.utc) if current.tzinfo is None else current.astimezone(timezone.utc)


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _as_utc(parsed)


def _storage_timestamp(value: datetime) -> str:
    return _as_utc(value).strftime("%Y-%m-%d %H:%M:%S")


def _term_expiry_for_start(started_at: datetime) -> datetime:
    local_start = _as_utc(started_at).astimezone(SHANGHAI)
    expiry_day = local_start.date() + timedelta(days=PLAN_TERM_DAYS)
    return datetime.combine(expiry_day, time.min, tzinfo=SHANGHAI).astimezone(timezone.utc)


def _plan_term_for_account(
    account: sqlite3.Row | None,
    *,
    plan: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    if plan["cadence"] == "once":
        return {
            "status": "unlimited",
            "starts_at": _row_value(account, "plan_assigned_at"),
            "expires_at": None,
            "expires_on": None,
            "days_remaining": None,
            "total_days": None,
        }

    started_at = _parse_timestamp(_row_value(account, "plan_assigned_at"))
    expires_at = _parse_timestamp(_row_value(account, "plan_expires_at"))
    # Accounts created before the timed-plan rollout retain their existing term
    # rather than silently receiving an unlimited daily package.
    if expires_at is None and started_at is not None:
        expires_at = _term_expiry_for_start(started_at)
    current = _as_utc(now)
    status_value = "active" if expires_at is None or current < expires_at else "expired"
    expires_on = None
    days_remaining = 0
    if expires_at is not None:
        local_expiry = expires_at.astimezone(SHANGHAI)
        expires_on = (local_expiry.date() - timedelta(days=1)).isoformat()
        if status_value == "active":
            days_remaining = max(0, (local_expiry.date() - current.astimezone(SHANGHAI).date()).days)
    return {
        "status": status_value,
        "starts_at": _storage_timestamp(started_at) if started_at else _row_value(account, "plan_assigned_at"),
        "expires_at": _storage_timestamp(expires_at) if expires_at else None,
        "expires_on": expires_on,
        "days_remaining": days_remaining,
        "total_days": PLAN_TERM_DAYS,
    }


def public_plans(conn: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
    concurrency_limits = {
        code: int(definition["max_concurrent_jobs"])
        for code, definition in CREDIT_PLANS.items()
    }
    if conn is not None and _table_exists(conn, "credit_plan_limits"):
        for row in conn.execute(
            "SELECT plan_code, max_concurrent_jobs FROM credit_plan_limits"
        ).fetchall():
            if row["plan_code"] in concurrency_limits:
                concurrency_limits[row["plan_code"]] = int(row["max_concurrent_jobs"])
    plans = []
    for code, definition in CREDIT_PLANS.items():
        allowance = int(definition["allowance"])
        cadence_label = "一次性" if definition["cadence"] == "once" else "每日"
        plans.append({
            **definition,
            "max_concurrent_jobs": concurrency_limits[code],
            "allowance": allowance,
            "allowance_label": f"{cadence_label} {allowance} 额度",
        })
    return plans


def _plan_for_account(conn: sqlite3.Connection, account: sqlite3.Row | None) -> dict[str, Any]:
    plan_code = str(_row_value(account, "plan_code", "free") or "free")
    plans = {plan["code"]: plan for plan in public_plans(conn)}
    return dict(plans.get(plan_code, plans["free"]))


def _effective_plan_for_account(
    conn: sqlite3.Connection,
    account: sqlite3.Row | None,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    assigned_plan = _plan_for_account(conn, account)
    term = _plan_term_for_account(account, plan=assigned_plan, now=now)
    if term["status"] == "expired":
        return next(plan for plan in public_plans(conn) if plan["code"] == "free")
    return assigned_plan


def active_user_job_count(conn: sqlite3.Connection, *, user_id: int) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS active_count
        FROM agent_jobs
        WHERE user_id = ? AND status IN ('queued', 'running')
        """,
        (user_id,),
    ).fetchone()
    return int(row["active_count"] if row else 0)


def concurrency_limit_message(plan: dict[str, Any]) -> str:
    limit = int(plan["max_concurrent_jobs"])
    return (
        f"{plan['label']}最多可同时运行 {limit} 个 AI 任务，当前运行中的任务已满。"
        "请等待其中一个任务完成或取消后再试。"
    )


def user_concurrency_limit_message(conn: sqlite3.Connection, *, user_id: int) -> str:
    plan = _effective_plan_for_account(conn, _account_row(conn, user_id))
    return concurrency_limit_message(plan)


def concurrency_status(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved_plan = plan or _plan_for_account(conn, _account_row(conn, user_id))
    limit = int(resolved_plan["max_concurrent_jobs"])
    active = active_user_job_count(conn, user_id=user_id)
    reached = active >= limit
    return {
        "limit": limit,
        "active": active,
        "available": max(0, limit - active),
        "reached": reached,
        "message": concurrency_limit_message(resolved_plan) if reached else None,
    }


def ensure_concurrent_job_capacity(conn: sqlite3.Connection, *, user_id: int) -> None:
    plan = _effective_plan_for_account(conn, _account_row(conn, user_id))
    current = concurrency_status(conn, user_id=user_id, plan=plan)
    if current["reached"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=current["message"],
        )


def is_concurrency_limit_error(exc: BaseException) -> bool:
    return CONCURRENCY_LIMIT_ERROR in str(exc)


def _plan_grant_key(
    plan: dict[str, Any],
    account: sqlite3.Row | None,
    *,
    now: datetime | None = None,
) -> str:
    if plan["cadence"] == "once":
        return "welcome"
    local_now = _as_utc(now).astimezone(SHANGHAI)
    term_id = int(_row_value(account, "plan_term_id", 0) or 0)
    return f"daily:{term_id}:{local_now.date().isoformat()}"


def _legacy_daily_grant_for_date(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    plan_code: str,
    day: str,
) -> sqlite3.Row | None:
    rows = conn.execute(
        """
        SELECT grant_key, credits, created_at
        FROM credit_plan_grants
        WHERE user_id = ? AND plan_code = ? AND grant_key NOT LIKE 'daily:%'
        ORDER BY id DESC
        """,
        (user_id, plan_code),
    ).fetchall()
    for row in rows:
        created_at = _parse_timestamp(row["created_at"])
        if created_at and created_at.astimezone(SHANGHAI).date().isoformat() == day:
            return row
    return None


def _plan_grant_status(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    plan: dict[str, Any],
    account: sqlite3.Row | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    resolved_account = account or _account_row(conn, user_id)
    grant_key = _plan_grant_key(plan, resolved_account, now=now)
    if not _table_exists(conn, "credit_plan_grants"):
        return {
            "grant_key": grant_key,
            "granted": False,
            "granted_credits": 0,
            "granted_at": None,
            "can_grant": False,
        }
    row = conn.execute(
        "SELECT credits, created_at FROM credit_plan_grants WHERE user_id = ? AND grant_key = ?",
        (user_id, grant_key),
    ).fetchone()
    if row is None and plan["cadence"] == "daily" and int(_row_value(resolved_account, "plan_term_id", 0) or 0) == 0:
        day = _as_utc(now).astimezone(SHANGHAI).date().isoformat()
        row = _legacy_daily_grant_for_date(conn, user_id=user_id, plan_code=plan["code"], day=day)
    term = _plan_term_for_account(resolved_account, plan=plan, now=now)
    return {
        "grant_key": row["grant_key"] if row and "grant_key" in row.keys() else grant_key,
        "granted": row is not None,
        "granted_credits": int(row["credits"]) if row else 0,
        "granted_at": row["created_at"] if row else None,
        "can_grant": row is None and term["status"] != "expired",
    }


def _public_transaction(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "display_name": _row_value(row, "display_name"),
        "username": _row_value(row, "username"),
        "project_id": row["project_id"],
        "project_name": _row_value(row, "project_name"),
        "job_id": row["job_id"],
        "stage": _row_value(row, "stage"),
        "kind": row["kind"],
        "delta": int(row["delta"]),
        "balance_after": int(row["balance_after"]),
        "note": row["note"],
        "job_credit_status": _row_value(row, "job_credit_status"),
        "created_at": row["created_at"],
    }


def user_credit_transactions(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    limit: int = 40,
) -> list[dict[str, Any]]:
    if not credits_available(conn):
        return []
    rows = conn.execute(
        """
        SELECT ledger.*, projects.name AS project_name,
               job_credits.stage, job_credits.status AS job_credit_status
        FROM credit_ledger AS ledger
        LEFT JOIN projects ON projects.id = ledger.project_id
        LEFT JOIN agent_job_credits AS job_credits ON job_credits.job_id = ledger.job_id
        WHERE ledger.user_id = ?
        ORDER BY ledger.id DESC
        LIMIT ?
        """,
        (user_id, max(1, min(int(limit), 100))),
    ).fetchall()
    return [_public_transaction(row) for row in rows]


def _price_map(conn: sqlite3.Connection) -> dict[str, int]:
    prices = dict(STAGE_CREDITS)
    if not credits_available(conn):
        return prices
    rows = conn.execute("SELECT stage, credits FROM credit_stage_prices").fetchall()
    for row in rows:
        if row["stage"] in prices:
            prices[row["stage"]] = int(row["credits"])
    return prices


def public_prices(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    prices = _price_map(conn)
    return [
        {"stage": stage, "label": STAGE_LABELS[stage], "credits": prices[stage]}
        for stage in STAGE_CREDITS
    ]


def credit_summary(conn: sqlite3.Connection, *, user_id: int) -> dict[str, Any]:
    account = _account_row(conn, user_id) if credits_available(conn) else None
    plan = _plan_for_account(conn, account)
    term = _plan_term_for_account(account, plan=plan)
    effective_plan = _effective_plan_for_account(conn, account)
    return {
        "managed": account is not None,
        "balance": int(account["balance"]) if account else None,
        "balances": _credit_breakdown(account) if account else None,
        "plan": plan,
        "concurrency": concurrency_status(conn, user_id=user_id, plan=effective_plan),
        "plan_term": term,
        "plan_grant": _plan_grant_status(conn, user_id=user_id, plan=plan, account=account) if account else None,
        "prices": public_prices(conn),
        "transactions": user_credit_transactions(conn, user_id=user_id),
    }


def ensure_sufficient_credits(conn: sqlite3.Connection, *, user_id: int, amount: int) -> None:
    if amount <= 0 or not credits_available(conn):
        return
    account = _account_row(conn, user_id)
    if account is None:
        return
    available = int(account["balance"])
    if available < amount:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"创作额度不足，本次需要 {amount} 额度，当前可用 {available} 额度。请联系管理员补充额度。",
        )


def quote_for_stages(conn: sqlite3.Connection, stages: Iterable[str]) -> dict[str, Any]:
    prices = _price_map(conn)
    normalized = [stage for stage in stages if stage in prices]
    return {
        "credits": sum(prices[stage] for stage in normalized),
        "stages": [
            {"stage": stage, "label": STAGE_LABELS[stage], "credits": prices[stage]}
            for stage in normalized
        ],
    }


def record_credit_adjustment(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    delta: int,
    note: str,
    project_id: int | None = None,
    job_id: int | None = None,
    kind: str = "manual_adjustment",
    experience_delta: int = 0,
    supplemental_delta: int | None = None,
    plan_delta: int = 0,
    plan_balance_grant_key: str | None | object = ...,
) -> dict[str, Any]:
    if delta == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="调整额度不能为 0")
    if not credits_available(conn):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="额度账户尚未初始化")

    conn.execute(
        "INSERT OR IGNORE INTO credit_accounts (user_id, balance) VALUES (?, 0)", (user_id,)
    )
    account = _account_row(conn, user_id)
    if account is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="额度账户尚未初始化")
    if supplemental_delta is None:
        if delta > 0:
            supplemental_delta = delta
        else:
            allocation = _allocate_credits(
                account,
                -delta,
                order=("supplemental", "plan", "experience"),
            )
            if allocation is None:
                available = int(account["balance"])
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"可用创作额度不足，当前为 {available} 额度。",
                )
            experience_delta = -allocation["experience"]
            supplemental_delta = -allocation["supplemental"]
            plan_delta = -allocation["plan"]
    if experience_delta + supplemental_delta + plan_delta != delta:
        raise ValueError("额度来源变动与总额度不一致")
    components = _credit_components(account)
    next_components = {
        "experience": components["experience"] + experience_delta,
        "supplemental": components["supplemental"] + supplemental_delta,
        "plan": components["plan"] + plan_delta,
    }
    updated = _save_credit_components(
        conn,
        account=account,
        components=next_components,
        plan_balance_grant_key=plan_balance_grant_key,
    )
    if updated is None:
        latest = _account_row(conn, user_id)
        available = int(latest["balance"]) if latest else 0
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"可用创作额度不足，当前为 {available} 额度。",
        )
    balance_after = int(updated["balance"])
    _record_credit_ledger(
        conn,
        user_id=user_id,
        project_id=project_id,
        job_id=job_id,
        kind=kind,
        delta=delta,
        balance_after=balance_after,
        note=note,
    )
    return {"balance": balance_after, "balances": _credit_breakdown(updated)}


def set_user_credit_plan(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    plan_code: str,
    granted_by: int | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    if plan_code not in CREDIT_PLANS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请选择有效的用户套餐")
    conn.execute(
        "INSERT OR IGNORE INTO credit_accounts (user_id, balance) VALUES (?, 0)",
        (user_id,),
    )
    current = _account_row(conn, user_id)
    assigned_at = _as_utc(now)
    current_plan = _plan_for_account(conn, current)
    current_term = _plan_term_for_account(current, plan=current_plan, now=assigned_at)
    # Saving the package dialog without changing an active paid plan must not
    # silently start another term or issue a second daily allocation.
    if plan_code == current_plan["code"] and plan_code in {"basic", "advanced"} and current_term["status"] == "active":
        grant_status = _plan_grant_status(
            conn,
            user_id=user_id,
            plan=current_plan,
            account=current,
            now=assigned_at,
        )
        initial_grant = None
        if grant_status["can_grant"]:
            initial_grant = grant_current_plan_credits(
                conn,
                user_id=user_id,
                granted_by=granted_by,
                now=assigned_at,
            )
            current = _account_row(conn, user_id)
            grant_status = initial_grant["plan_grant"]
        return {
            "user_id": user_id,
            "balance": int(current["balance"]) if current else 0,
            "plan": current_plan,
            "plan_term": _plan_term_for_account(current, plan=current_plan, now=assigned_at),
            "plan_grant": grant_status,
            "initial_granted": initial_grant is not None,
        }

    if plan_code in {"basic", "advanced"}:
        next_term_id = int(_row_value(current, "plan_term_id", 0) or 0) + 1
        expires_at = _term_expiry_for_start(assigned_at)
        conn.execute(
            """
            UPDATE credit_accounts
            SET plan_code = ?, plan_assigned_at = ?, plan_expires_at = ?,
                plan_term_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
            """,
            (plan_code, _storage_timestamp(assigned_at), _storage_timestamp(expires_at), next_term_id, user_id),
        )
    else:
        conn.execute(
            """
            UPDATE credit_accounts
            SET plan_code = ?, plan_assigned_at = ?, plan_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
            """,
            (plan_code, _storage_timestamp(assigned_at), user_id),
        )
        clear_expired_plan_credits(
            conn,
            user_id=user_id,
            now=assigned_at,
            force=True,
            note="套餐已调整，当日套餐额度已清零",
        )
    account = _account_row(conn, user_id)
    plan = _plan_for_account(conn, account)
    grant_status = _plan_grant_status(conn, user_id=user_id, plan=plan, account=account, now=assigned_at)
    initial_grant = None
    if grant_status["can_grant"]:
        initial_grant = grant_current_plan_credits(
            conn,
            user_id=user_id,
            granted_by=granted_by,
            now=assigned_at,
        )
        account = _account_row(conn, user_id)
        grant_status = initial_grant["plan_grant"]
    return {
        "user_id": user_id,
        "balance": int(account["balance"]) if account else 0,
        "plan": plan,
        "plan_term": _plan_term_for_account(account, plan=plan, now=assigned_at),
        "plan_grant": grant_status,
        "initial_granted": initial_grant is not None,
    }


def _is_current_plan_grant_key(grant_key: str | None, *, now: datetime) -> bool:
    if not grant_key:
        return False
    local_day = _as_utc(now).astimezone(SHANGHAI).date().isoformat()
    return grant_key.startswith("daily:") and grant_key.endswith(f":{local_day}")


def clear_expired_plan_credits(
    conn: sqlite3.Connection,
    *,
    now: datetime | None = None,
    user_id: int | None = None,
    expected_grant_key: str | None = None,
    force: bool = False,
    note: str = "当日套餐额度已到期清零",
) -> list[dict[str, Any]]:
    """Remove only the previous daily-plan balance before a new day is issued."""
    if not credits_available(conn):
        return []
    current = _as_utc(now)
    query = "SELECT * FROM credit_accounts WHERE plan_balance > 0"
    params: tuple[Any, ...] = ()
    if user_id is not None:
        query += " AND user_id = ?"
        params = (user_id,)
    cleared: list[dict[str, Any]] = []
    for account in conn.execute(query, params).fetchall():
        grant_key = _row_value(account, "plan_balance_grant_key")
        should_clear = force
        if expected_grant_key is not None:
            should_clear = should_clear or grant_key != expected_grant_key
        elif not should_clear:
            should_clear = not _is_current_plan_grant_key(grant_key, now=current)
        if not should_clear:
            continue
        components = _credit_components(account)
        plan_amount = components["plan"]
        if plan_amount <= 0:
            continue
        adjustment = record_credit_adjustment(
            conn,
            user_id=int(account["user_id"]),
            delta=-plan_amount,
            note=note,
            kind="plan_expire",
            supplemental_delta=0,
            plan_delta=-plan_amount,
            plan_balance_grant_key=None,
        )
        cleared.append({
            "user_id": int(account["user_id"]),
            "credits": plan_amount,
            "balance": adjustment["balance"],
            "grant_key": grant_key,
        })
    return cleared


def grant_current_plan_credits(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    granted_by: int | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not credits_available(conn) or not _table_exists(conn, "credit_plan_grants"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="额度账户尚未初始化")
    account = _account_row(conn, user_id)
    if account is None:
        conn.execute("INSERT INTO credit_accounts (user_id, balance) VALUES (?, 0)", (user_id,))
        account = _account_row(conn, user_id)
    plan = _plan_for_account(conn, account)
    term = _plan_term_for_account(account, plan=plan, now=now)
    if term["status"] == "expired":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该套餐已到期，自动额度发放已结束")
    grant_key = _plan_grant_key(plan, account, now=now)
    if plan["cadence"] == "daily":
        clear_expired_plan_credits(
            conn,
            user_id=user_id,
            now=now,
            expected_grant_key=grant_key,
        )
    try:
        conn.execute(
            """
            INSERT INTO credit_plan_grants (user_id, plan_code, grant_key, credits, granted_by)
            VALUES (?, ?, ?, ?, ?)
            """,
            (user_id, plan["code"], grant_key, int(plan["allowance"]), granted_by),
        )
    except sqlite3.IntegrityError as exc:
        period = "体验额度" if plan["cadence"] == "once" else "今日套餐额度"
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"该用户的{period}已经发放，请使用临时补充额度。",
        ) from exc
    # The grant key is an internal idempotency key; user-visible ledger notes
    # should describe the entitlement rather than expose implementation details.
    period_note = "体验套餐额度" if plan["cadence"] == "once" else "当日套餐额度"
    allowance = int(plan["allowance"])
    adjustment = record_credit_adjustment(
        conn,
        user_id=user_id,
        delta=allowance,
        note=f"{plan['label']} · {period_note}",
        kind="plan_grant",
        experience_delta=allowance if plan["cadence"] == "once" else 0,
        supplemental_delta=0,
        plan_delta=allowance if plan["cadence"] == "daily" else 0,
        plan_balance_grant_key=grant_key if plan["cadence"] == "daily" else ...,
    )
    return {
        "user_id": user_id,
        "balance": adjustment["balance"],
        "plan": plan,
        "plan_grant": _plan_grant_status(conn, user_id=user_id, plan=plan, account=_account_row(conn, user_id), now=now),
    }


def grant_due_plan_credits(
    conn: sqlite3.Connection,
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Issue today's allocation once for each active daily plan.

    The unique per-term grant key makes repeated scheduler passes and concurrent
    API workers harmless. A service restart later in the day still catches up
    today's issuance without releasing a backlog of old daily quotas at once.
    """
    if not credits_available(conn) or not _table_exists(conn, "credit_plan_grants"):
        return []
    current = _as_utc(now)
    clear_expired_plan_credits(conn, now=current)
    rows = conn.execute(
        """
        SELECT credit_accounts.*, users.username, users.display_name
        FROM credit_accounts
        JOIN users ON users.id = credit_accounts.user_id
        WHERE credit_accounts.plan_code IN ('basic', 'advanced')
          AND users.is_active = 1
          AND COALESCE(users.is_system, 0) = 0
        """
    ).fetchall()
    issued: list[dict[str, Any]] = []
    for account in rows:
        plan = _plan_for_account(conn, account)
        term = _plan_term_for_account(account, plan=plan, now=current)
        if term["status"] != "active":
            continue
        status_value = _plan_grant_status(conn, user_id=int(account["user_id"]), plan=plan, account=account, now=current)
        if not status_value["can_grant"]:
            continue
        try:
            granted = grant_current_plan_credits(
                conn,
                user_id=int(account["user_id"]),
                granted_by=None,
                now=current,
            )
        except HTTPException as exc:
            # Another API process can win the same daily grant during startup.
            if exc.status_code == status.HTTP_409_CONFLICT:
                continue
            raise
        issued.append({
            **granted,
            "username": account["username"],
            "display_name": account["display_name"],
            "plan_term": term,
        })
    return issued


def reserve_job_credits(
    conn: sqlite3.Connection,
    *,
    job: sqlite3.Row,
    quote: dict[str, Any],
) -> dict[str, Any]:
    """Reserve the displayed amount before a managed job starts."""
    amount = int(quote.get("credits") or 0)
    if amount <= 0 or not credits_available(conn):
        return {"managed": False, "credits": amount, "balance": None}
    account = _account_row(conn, int(job["user_id"]))
    # Test and legacy records that predate the rollout remain operable. Newly
    # created and migrated users always receive a managed account.
    if account is None:
        return {"managed": False, "credits": amount, "balance": None}
    ensure_sufficient_credits(conn, user_id=int(job["user_id"]), amount=amount)
    allocation = _allocate_credits(account, amount)
    if allocation is None:
        ensure_sufficient_credits(conn, user_id=int(job["user_id"]), amount=amount)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="额度状态已变化，请刷新后重试。")
    components = _credit_components(account)
    updated = _save_credit_components(
        conn,
        account=account,
        components={
            "experience": components["experience"] - allocation["experience"],
            "supplemental": components["supplemental"] - allocation["supplemental"],
            "plan": components["plan"] - allocation["plan"],
        },
    )
    if updated is None:
        ensure_sufficient_credits(conn, user_id=int(job["user_id"]), amount=amount)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="额度状态已变化，请刷新后重试。")
    balance_after = int(updated["balance"])
    stage = str(job["target_stage"] or job["stage"])
    conn.execute(
        """
        INSERT INTO agent_job_credits (
            job_id, user_id, project_id, stage, credits,
            experience_credits, supplemental_credits, plan_credits, plan_credit_grant_key, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')
        """,
        (
            job["id"], job["user_id"], job["project_id"], stage, amount,
            allocation["experience"], allocation["supplemental"], allocation["plan"],
            _row_value(account, "plan_balance_grant_key") if allocation["plan"] else None,
        ),
    )
    _record_credit_ledger(
        conn,
        user_id=int(job["user_id"]),
        project_id=int(job["project_id"]),
        job_id=int(job["id"]),
        kind="reserve",
        delta=-amount,
        balance_after=balance_after,
        note=f"处理{STAGE_LABELS.get(stage, '创作任务')}",
    )
    return {"managed": True, "credits": amount, "balance": balance_after}


def settle_job_credits(conn: sqlite3.Connection, *, job_id: int) -> None:
    if not credits_available(conn):
        return
    conn.execute(
        """
        UPDATE agent_job_credits
        SET status = 'settled', settled_at = CURRENT_TIMESTAMP
        WHERE job_id = ? AND status = 'reserved'
        """,
        (job_id,),
    )


def release_job_credits(
    conn: sqlite3.Connection,
    *,
    job_id: int,
    now: datetime | None = None,
) -> None:
    if not credits_available(conn):
        return
    reservation = conn.execute(
        "SELECT * FROM agent_job_credits WHERE job_id = ? AND status = 'reserved'", (job_id,)
    ).fetchone()
    if not reservation:
        return
    experience_credits = int(_row_value(reservation, "experience_credits", 0) or 0)
    supplemental_credits = int(_row_value(reservation, "supplemental_credits", reservation["credits"]) or 0)
    plan_credits = int(_row_value(reservation, "plan_credits", 0) or 0)
    plan_grant_key = _row_value(reservation, "plan_credit_grant_key")
    refundable_plan = plan_credits if _is_current_plan_grant_key(plan_grant_key, now=_as_utc(now)) else 0
    refundable_total = experience_credits + supplemental_credits + refundable_plan
    if refundable_total:
        record_credit_adjustment(
            conn,
            user_id=int(reservation["user_id"]),
            project_id=int(reservation["project_id"]),
            job_id=int(reservation["job_id"]),
            delta=refundable_total,
            kind="release",
            note="任务未完成，已退还创作额度" if refundable_plan == plan_credits else "任务未完成，已退还仍有效的创作额度",
            experience_delta=experience_credits,
            supplemental_delta=supplemental_credits,
            plan_delta=refundable_plan,
        )
    conn.execute(
        """
        UPDATE agent_job_credits
        SET status = 'released', released_at = CURRENT_TIMESTAMP
        WHERE job_id = ? AND status = 'reserved'
        """,
        (job_id,),
    )


def re_reserve_job_credits(conn: sqlite3.Connection, *, job_id: int) -> dict[str, Any]:
    """Reuse a released reservation when a checkpointed job is resumed."""
    if not credits_available(conn):
        return {"managed": False, "credits": 0, "balance": None}
    reservation = conn.execute(
        "SELECT * FROM agent_job_credits WHERE job_id = ?", (job_id,)
    ).fetchone()
    if not reservation or reservation["status"] != "released":
        return {"managed": bool(reservation), "credits": int(reservation["credits"]) if reservation else 0, "balance": None}
    amount = int(reservation["credits"])
    user_id = int(reservation["user_id"])
    account = _account_row(conn, user_id)
    allocation = _allocate_credits(account, amount) if account else None
    if allocation is None:
        available = int(account["balance"]) if account else 0
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"创作额度不足，恢复本次处理需要 {amount} 额度，当前可用 {available} 额度。",
        )
    components = _credit_components(account)
    updated = _save_credit_components(
        conn,
        account=account,
        components={
            "experience": components["experience"] - allocation["experience"],
            "supplemental": components["supplemental"] - allocation["supplemental"],
            "plan": components["plan"] - allocation["plan"],
        },
    )
    if updated is None:
        latest = _account_row(conn, user_id)
        available = int(latest["balance"]) if latest else 0
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"创作额度不足，恢复本次处理需要 {amount} 额度，当前可用 {available} 额度。",
        )
    balance_after = int(updated["balance"])
    conn.execute(
        """
        UPDATE agent_job_credits
        SET status = 'reserved', released_at = NULL,
            experience_credits = ?, supplemental_credits = ?, plan_credits = ?,
            plan_credit_grant_key = ?
        WHERE job_id = ?
        """,
        (
            allocation["experience"],
            allocation["supplemental"],
            allocation["plan"],
            _row_value(account, "plan_balance_grant_key") if allocation["plan"] else None,
            job_id,
        ),
    )
    _record_credit_ledger(
        conn,
        user_id=user_id,
        project_id=int(reservation["project_id"]),
        job_id=job_id,
        kind="reserve",
        delta=-amount,
        balance_after=balance_after,
        note="恢复未完成的处理",
    )
    return {"managed": True, "credits": amount, "balance": balance_after}


def job_credit_details(conn: sqlite3.Connection, *, job_id: int) -> dict[str, Any] | None:
    if not credits_available(conn):
        return None
    row = conn.execute(
        "SELECT credits, status FROM agent_job_credits WHERE job_id = ?", (job_id,)
    ).fetchone()
    if not row:
        return None
    return {"credits": int(row["credits"]), "status": row["status"]}


def admin_credit_overview(conn: sqlite3.Connection, *, limit: int = 120) -> dict[str, Any]:
    if not credits_available(conn):
        return {"plans": public_plans(conn), "prices": public_prices(conn), "accounts": [], "transactions": []}
    accounts = conn.execute(
        """
        SELECT users.id, users.username, users.display_name, users.role,
               credit_accounts.balance, credit_accounts.experience_balance,
               credit_accounts.supplemental_balance, credit_accounts.plan_balance,
               credit_accounts.plan_balance_grant_key, credit_accounts.plan_code,
               credit_accounts.plan_assigned_at, credit_accounts.plan_expires_at,
               credit_accounts.plan_term_id, credit_accounts.updated_at
        FROM users
        LEFT JOIN credit_accounts ON credit_accounts.user_id = users.id
        WHERE users.is_active = 1 AND COALESCE(users.is_system, 0) = 0
        ORDER BY credit_accounts.balance IS NULL, users.display_name COLLATE NOCASE, users.id
        """
    ).fetchall()
    transactions = conn.execute(
        """
        SELECT ledger.*, users.display_name, users.username, projects.name AS project_name,
               job_credits.stage, job_credits.status AS job_credit_status
        FROM credit_ledger AS ledger
        JOIN users ON users.id = ledger.user_id
        LEFT JOIN projects ON projects.id = ledger.project_id
        LEFT JOIN agent_job_credits AS job_credits ON job_credits.job_id = ledger.job_id
        ORDER BY ledger.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    account_payload = []
    for row in accounts:
        plan = _plan_for_account(conn, row)
        term = _plan_term_for_account(row, plan=plan)
        effective_plan = _effective_plan_for_account(conn, row)
        account_payload.append({
            "user_id": row["id"], "username": row["username"], "display_name": row["display_name"],
            "role": row["role"], "managed": row["balance"] is not None,
            "balance": int(row["balance"]) if row["balance"] is not None else None,
            "balances": _credit_breakdown(row) if row["balance"] is not None else None,
            "plan": plan,
            "plan_term": term,
            "concurrency": concurrency_status(conn, user_id=int(row["id"]), plan=effective_plan),
            "plan_assigned_at": row["plan_assigned_at"],
            "plan_grant": _plan_grant_status(conn, user_id=int(row["id"]), plan=plan, account=row),
            "updated_at": row["updated_at"],
        })
    return {
        "plans": public_plans(conn),
        "prices": public_prices(conn),
        "accounts": account_payload,
        "transactions": [_public_transaction(row) for row in transactions],
    }


def update_stage_prices(conn: sqlite3.Connection, *, prices: dict[str, int]) -> list[dict[str, Any]]:
    unknown = set(prices) - set(STAGE_CREDITS)
    if unknown:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="存在无效的阶段额度配置")
    if set(prices) != set(STAGE_CREDITS):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请完整提交所有阶段额度")
    if any(int(amount) < 1 or int(amount) > 1000 for amount in prices.values()):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="每项创作额度需在 1 至 1000 之间")
    for stage, amount in prices.items():
        conn.execute(
            """
            INSERT INTO credit_stage_prices (stage, credits, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(stage) DO UPDATE SET credits = excluded.credits, updated_at = CURRENT_TIMESTAMP
            """,
            (stage, int(amount)),
        )
    return public_prices(conn)
