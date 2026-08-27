import sqlite3
import unittest

from app.services.notification_service import (
    create_agent_completion_notification,
    list_notifications,
    mark_all_notifications_read,
    mark_notification_read,
    publish_system_notification,
)
from app.services.agent_runner import update_job_status


class NotificationServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                current_stage TEXT NOT NULL
            );
            CREATE TABLE agent_jobs (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                stage TEXT NOT NULL,
                target_stage TEXT,
                status TEXT NOT NULL DEFAULT 'queued',
                started_at TEXT,
                finished_at TEXT,
                error_message TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                display_name TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                is_system INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE system_notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                created_by INTEGER,
                published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                project_id INTEGER,
                job_id INTEGER UNIQUE,
                preference_summary_job_id INTEGER UNIQUE,
                system_notification_id INTEGER,
                kind TEXT NOT NULL DEFAULT 'agent_completed',
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                target_stage TEXT,
                target_path TEXT,
                read_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO users (id, username, display_name, is_active, is_system) VALUES
                (5, 'writer', '编剧', 1, 0),
                (6, 'receiver', '接收人', 1, 0),
                (7, 'inactive', '停用账号', 0, 0),
                (8, 'system', '系统账号', 1, 1);
            INSERT INTO projects (id, name, current_stage)
            VALUES (7, '海风入夜', 'trial_generate');
            INSERT INTO agent_jobs (id, project_id, user_id, stage, target_stage)
            VALUES (23, 7, 5, 'chat_edit', 'character_rewrite');
            """
        )

    def tearDown(self) -> None:
        self.conn.close()

    def test_completion_notification_is_idempotent_and_marked_read(self) -> None:
        create_agent_completion_notification(self.conn, 23)
        create_agent_completion_notification(self.conn, 23)

        payload = list_notifications(self.conn, 5)
        self.assertTrue(payload["has_unread"])
        self.assertEqual(payload["unread_count"], 1)
        self.assertEqual(len(payload["notifications"]), 1)
        self.assertEqual(payload["notifications"][0]["title"], "对话调整已完成")
        self.assertEqual(payload["notifications"][0]["target_stage"], "character_rewrite")
        self.assertTrue(payload["notifications"][0]["created_at"].endswith("Z"))

        self.assertEqual(mark_all_notifications_read(self.conn, 5), 1)
        refreshed = list_notifications(self.conn, 5)
        self.assertFalse(refreshed["has_unread"])
        self.assertIsNotNone(refreshed["notifications"][0]["read_at"])

    def test_success_status_creates_completion_notification(self) -> None:
        update_job_status(self.conn, 23, "succeeded")

        job = self.conn.execute("SELECT * FROM agent_jobs WHERE id = 23").fetchone()
        payload = list_notifications(self.conn, 5)
        self.assertEqual(job["status"], "succeeded")
        self.assertIsNotNone(job["finished_at"])
        self.assertEqual(payload["unread_count"], 1)
        self.assertEqual(payload["notifications"][0]["job_id"], 23)

    def test_system_notification_reaches_active_users_and_tracks_each_reader(self) -> None:
        published = publish_system_notification(
            self.conn,
            title="工作台更新提醒",
            message="今晚将进行一次短暂维护，请提前保存正在编辑的内容。",
            created_by=5,
        )

        self.assertEqual(published["recipient_count"], 2)
        writer_payload = list_notifications(self.conn, 5)
        receiver_payload = list_notifications(self.conn, 6)
        self.assertEqual(writer_payload["unread_system_notifications"][0]["title"], "工作台更新提醒")
        self.assertEqual(receiver_payload["unread_system_notifications"][0]["kind"], "system")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM notifications WHERE user_id IN (7, 8)").fetchone()[0], 0)

        notification_id = writer_payload["unread_system_notifications"][0]["id"]
        self.assertTrue(mark_notification_read(self.conn, 5, notification_id))
        self.assertFalse(mark_notification_read(self.conn, 5, notification_id))
        self.assertEqual(list_notifications(self.conn, 5)["unread_system_notifications"], [])
        self.assertEqual(len(list_notifications(self.conn, 6)["unread_system_notifications"]), 1)


if __name__ == "__main__":
    unittest.main()
