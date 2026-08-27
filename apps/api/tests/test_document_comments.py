import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.db import session
from app.services import document_comment_service


class DocumentCommentsTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=root / "data",
            database_path=root / "data" / "app.db",
            repo_root=root,
            agents_dir=root / "Agents",
            workspaces_dir=root / "Agents" / "workspaces",
            upload_dir=root / "data" / "uploads",
        )
        self.settings.workspaces_dir.mkdir(parents=True)
        self.patch = patch.object(session, "settings", self.settings)
        self.patch.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.executemany(
            """
            INSERT INTO users (id, username, display_name, password_hash, role)
            VALUES (?, ?, ?, 'hash', 'user')
            """,
            [(1, "writer", "创作者"), (2, "reviewer", "审阅者")],
        )
        self.conn.execute(
            """
            INSERT INTO projects (id, owner_user_id, name, workspace_dir, claude_session_id)
            VALUES (1, 1, '评论项目', 'workspaces/comments', 'session')
            """
        )
        self.owner = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        self.reviewer = self.conn.execute("SELECT * FROM users WHERE id = 2").fetchone()

    def tearDown(self):
        self.conn.close()
        self.patch.stop()
        self.temp_dir.cleanup()

    def test_threads_replies_and_author_deletion(self):
        thread = document_comment_service.create_document_comment(
            self.conn,
            project_id=1,
            stage="outline_rewrite",
            user=self.owner,
            anchor_start=4,
            anchor_end=8,
            anchor_text="主角登场",
            anchor_prefix="第一幕：",
            anchor_suffix="，危机出现",
            preview_start=2,
            preview_end=6,
            content="这里需要更早交代动机。",
        )

        self.assertEqual(thread["anchor"]["text"], "主角登场")
        self.assertEqual([message["content"] for message in thread["messages"]], ["这里需要更早交代动机。"])
        root_message_id = thread["messages"][0]["id"]

        updated = document_comment_service.add_document_comment_reply(
            self.conn,
            project_id=1,
            stage="outline_rewrite",
            thread_id=thread["id"],
            user=self.reviewer,
            content="同意，可以放到第一场冲突前。",
        )
        self.assertEqual(len(updated["messages"]), 2)
        reply_id = updated["messages"][1]["id"]

        with self.assertRaises(HTTPException) as unauthorized:
            document_comment_service.delete_document_comment_message(
                self.conn,
                project_id=1,
                stage="outline_rewrite",
                thread_id=thread["id"],
                message_id=root_message_id,
                user=self.reviewer,
            )
        self.assertEqual(unauthorized.exception.status_code, 403)

        result = document_comment_service.delete_document_comment_message(
            self.conn,
            project_id=1,
            stage="outline_rewrite",
            thread_id=thread["id"],
            message_id=reply_id,
            user=self.reviewer,
        )
        self.assertFalse(result["thread_deleted"])
        self.assertEqual(len(document_comment_service.list_document_comments(self.conn, 1, "outline_rewrite")[0]["messages"]), 1)

        result = document_comment_service.delete_document_comment_message(
            self.conn,
            project_id=1,
            stage="outline_rewrite",
            thread_id=thread["id"],
            message_id=root_message_id,
            user=self.owner,
        )
        self.assertTrue(result["thread_deleted"])
        self.assertEqual(document_comment_service.list_document_comments(self.conn, 1, "outline_rewrite"), [])

    def test_deleting_original_message_keeps_other_messages(self):
        thread = document_comment_service.create_document_comment(
            self.conn,
            project_id=1,
            stage="outline_rewrite",
            user=self.owner,
            anchor_start=4,
            anchor_end=8,
            anchor_text="主角登场",
            anchor_prefix="第一幕：",
            anchor_suffix="，危机出现",
            preview_start=2,
            preview_end=6,
            content="这里需要更早交代动机。",
        )
        original_message_id = thread["messages"][0]["id"]
        document_comment_service.add_document_comment_reply(
            self.conn,
            project_id=1,
            stage="outline_rewrite",
            thread_id=thread["id"],
            user=self.owner,
            content="还需要补充主角的目标。",
        )
        document_comment_service.add_document_comment_reply(
            self.conn,
            project_id=1,
            stage="outline_rewrite",
            thread_id=thread["id"],
            user=self.owner,
            content="第二场再明确一次代价。",
        )

        result = document_comment_service.delete_document_comment_message(
            self.conn,
            project_id=1,
            stage="outline_rewrite",
            thread_id=thread["id"],
            message_id=original_message_id,
            user=self.owner,
        )

        self.assertFalse(result["thread_deleted"])
        threads = document_comment_service.list_document_comments(self.conn, 1, "outline_rewrite")
        self.assertEqual(len(threads), 1)
        self.assertEqual(
            [message["content"] for message in threads[0]["messages"]],
            ["还需要补充主角的目标。", "第二场再明确一次代价。"],
        )

    def test_system_revision_comments_follow_real_changes_and_are_idempotent(self):
        before = "# 完整剧本\n\n## 第1集：开局\n旧动作。\n\n## 第2集：反击\n保持不变。\n"
        after = "# 完整剧本\n\n## 第1集：开局\n新动作。\n\n## 第2集：反击\n保持不变。\n"
        self.conn.execute(
            """
            INSERT INTO agent_jobs (id, project_id, user_id, stage, prompt, status, claude_session_id)
            VALUES (88, 1, 1, 'full_generate', '', 'succeeded', 'p0-job')
            """
        )

        created = document_comment_service.create_system_revision_comments(
            self.conn,
            project_id=1,
            stage="full_generate",
            source_job_id=88,
            before=before,
            after=after,
            issue_titles=["开场动机不足"],
        )

        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["anchor"]["text"], "新动作。")
        self.assertEqual(created[0]["created_by"]["display_name"], "系统")
        self.assertEqual(created[0]["messages"][0]["content"], "已根据本轮 P0 建议调整此处相关内容。")
        system_user = self.conn.execute(
            "SELECT * FROM users WHERE username = ?",
            (document_comment_service.SYSTEM_COMMENT_USERNAME,),
        ).fetchone()
        self.assertEqual(system_user["is_system"], 1)
        self.assertEqual(system_user["is_active"], 0)

        duplicate = document_comment_service.create_system_revision_comments(
            self.conn,
            project_id=1,
            stage="full_generate",
            source_job_id=88,
            before=before,
            after=after,
            issue_titles=["开场动机不足"],
        )
        self.assertEqual(duplicate, [])
        self.assertEqual(len(document_comment_service.list_document_comments(self.conn, 1, "full_generate")), 1)

    def test_system_revision_comments_ignore_unchanged_content(self):
        content = "# 完整剧本\n\n## 第1集：开局\n保持不变。\n"
        created = document_comment_service.create_system_revision_comments(
            self.conn,
            project_id=1,
            stage="full_generate",
            source_job_id=89,
            before=content,
            after=content,
            issue_titles=["开场动机不足"],
        )
        self.assertEqual(created, [])


if __name__ == "__main__":
    unittest.main()
