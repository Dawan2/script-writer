from __future__ import annotations

import sqlite3


STAGE_LABELS = {
    "next": "下一阶段",
    "all": "全流程生成",
    "chat_edit": "对话调整",
    "novel_analysis": "小说解读",
    "world_view": "世界观",
    "outline_rewrite": "故事梗概",
    "character_rewrite": "人物小传",
    "trial_generate": "剧本试稿",
    "full_generate": "完整剧本",
    "dialogue_translate": "台词翻译",
    "foreign_review": "AI 审稿",
    "humanizer_zh": "剧本润色",
}

SYSTEM_NOTIFICATION_KIND = "system"


def _notification_stage(stage: str, target_stage: str | None, project_current_stage: str) -> str:
    if stage == "all":
        return project_current_stage
    return target_stage or stage


def create_agent_completion_notification(conn: sqlite3.Connection, job_id: int) -> None:
    row = conn.execute(
        """
        SELECT job.*, project.name AS project_name, project.current_stage AS project_current_stage
        FROM agent_jobs AS job
        JOIN projects AS project ON project.id = job.project_id
        WHERE job.id = ?
        """,
        (job_id,),
    ).fetchone()
    if not row:
        return

    stage = _notification_stage(row["stage"], row["target_stage"], row["project_current_stage"])
    activity = STAGE_LABELS.get(row["stage"], STAGE_LABELS.get(stage, "AI 任务"))
    conn.execute(
        """
        INSERT INTO notifications (
            user_id, project_id, job_id, kind, title, message, target_stage
        ) VALUES (?, ?, ?, 'agent_completed', ?, ?, ?)
        ON CONFLICT(job_id) DO NOTHING
        """,
        (
            row["user_id"],
            row["project_id"],
            row["id"],
            f"{activity}已完成",
            f"「{row['project_name']}」的最新结果已更新",
            stage,
        ),
    )


def _public_timestamp(value: str | None) -> str | None:
    if not value or value.endswith("Z") or "+" in value[10:]:
        return value
    return f"{value.replace(' ', 'T')}Z"


def public_notification(row: sqlite3.Row) -> dict:
    keys = set(row.keys())
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "job_id": row["job_id"],
        "preference_summary_job_id": (
            row["preference_summary_job_id"] if "preference_summary_job_id" in keys else None
        ),
        "system_notification_id": (
            row["system_notification_id"] if "system_notification_id" in keys else None
        ),
        "kind": row["kind"],
        "title": row["title"],
        "message": row["message"],
        "target_stage": row["target_stage"],
        "target_path": row["target_path"] if "target_path" in keys else None,
        "read_at": _public_timestamp(row["read_at"]),
        "created_at": _public_timestamp(row["created_at"]),
    }


def list_notifications(conn: sqlite3.Connection, user_id: int, limit: int = 10) -> dict:
    rows = conn.execute(
        """
        SELECT * FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        """,
        (user_id, limit),
    ).fetchall()
    unread_count = conn.execute(
        "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
        (user_id,),
    ).fetchone()[0]
    unread_system_rows = conn.execute(
        """
        SELECT * FROM notifications
        WHERE user_id = ? AND kind = ? AND read_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 20
        """,
        (user_id, SYSTEM_NOTIFICATION_KIND),
    ).fetchall()
    return {
        "notifications": [public_notification(row) for row in rows],
        "has_unread": unread_count > 0,
        "unread_count": unread_count,
        "unread_system_notifications": [public_notification(row) for row in unread_system_rows],
    }


def mark_all_notifications_read(conn: sqlite3.Connection, user_id: int) -> int:
    cursor = conn.execute(
        """
        UPDATE notifications
        SET read_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND read_at IS NULL
        """,
        (user_id,),
    )
    return cursor.rowcount


def mark_notification_read(conn: sqlite3.Connection, user_id: int, notification_id: int) -> bool:
    cursor = conn.execute(
        """
        UPDATE notifications
        SET read_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND read_at IS NULL
        """,
        (notification_id, user_id),
    )
    return cursor.rowcount > 0


def public_system_notification(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "message": row["message"],
        "published_at": _public_timestamp(row["published_at"]),
        "created_at": _public_timestamp(row["created_at"]),
        "created_by": {
            "id": row["created_by"],
            "display_name": row["created_by_display_name"],
            "username": row["created_by_username"],
        } if row["created_by"] else None,
        "recipient_count": row["recipient_count"],
    }


def publish_system_notification(
    conn: sqlite3.Connection,
    *,
    title: str,
    message: str,
    created_by: int,
) -> dict:
    cursor = conn.execute(
        """
        INSERT INTO system_notifications (title, message, created_by)
        VALUES (?, ?, ?)
        """,
        (title, message, created_by),
    )
    system_notification_id = cursor.lastrowid
    recipients = conn.execute(
        """
        SELECT id FROM users
        WHERE is_active = 1 AND is_system = 0
        """
    ).fetchall()
    conn.executemany(
        """
        INSERT INTO notifications (
            user_id, system_notification_id, kind, title, message
        ) VALUES (?, ?, ?, ?, ?)
        """,
        [
            (recipient["id"], system_notification_id, SYSTEM_NOTIFICATION_KIND, title, message)
            for recipient in recipients
        ],
    )
    row = conn.execute(
        """
        SELECT system_notification.*, creator.display_name AS created_by_display_name,
               creator.username AS created_by_username, COUNT(notification.id) AS recipient_count
        FROM system_notifications AS system_notification
        LEFT JOIN users AS creator ON creator.id = system_notification.created_by
        LEFT JOIN notifications AS notification
            ON notification.system_notification_id = system_notification.id
        WHERE system_notification.id = ?
        GROUP BY system_notification.id
        """,
        (system_notification_id,),
    ).fetchone()
    return public_system_notification(row)


def list_system_notifications(conn: sqlite3.Connection, limit: int = 100) -> list[dict]:
    rows = conn.execute(
        """
        SELECT system_notification.*, creator.display_name AS created_by_display_name,
               creator.username AS created_by_username, COUNT(notification.id) AS recipient_count
        FROM system_notifications AS system_notification
        LEFT JOIN users AS creator ON creator.id = system_notification.created_by
        LEFT JOIN notifications AS notification
            ON notification.system_notification_id = system_notification.id
        GROUP BY system_notification.id
        ORDER BY system_notification.published_at DESC, system_notification.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [public_system_notification(row) for row in rows]
