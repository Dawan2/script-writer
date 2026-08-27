from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.services import workspace_service


OUTLINE_FILE = "output/剧本大纲.md"
OLD_OUTLINE = "# 剧本大纲\n\n旧故事\n"
NEW_OUTLINE = "# 剧本大纲\n\n新故事\n"

OLD_WORLD_VIEW = {
    "世界观描述": "旧世界观",
    "关键概念映射": [{"原设定": "旧设定", "新设定": "旧映射", "改编理由": "旧理由"}],
}
NEW_WORLD_VIEW = {
    "世界观描述": "新世界观",
    "关键概念映射": [{"原设定": "新设定", "新设定": "新映射", "改编理由": "新理由"}],
}


class InjectedFailure(RuntimeError):
    """Stands in for any unexpected failure inside a composite write."""


class WriteAtomicityTest(unittest.TestCase):
    """写入原子化与一致性回归：数据库与磁盘不得停在互相矛盾的状态。"""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.agents_dir = (Path(self.temp_dir.name) / "Agents").resolve()
        self.workspaces_dir = self.agents_dir / "workspaces"
        self.workspace = self.workspaces_dir / "demo"
        (self.workspace / "output").mkdir(parents=True)
        (self.agents_dir / ".claude" / "config").mkdir(parents=True)
        (self.agents_dir / ".claude" / "config" / "region-rules.json").write_text(
            json.dumps({
                "regions": {
                    "北美": {"default_market": "美国", "default_locale": "en-US", "rules": ["测试规则"]},
                }
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        self.settings_patch = patch.object(
            workspace_service,
            "settings",
            SimpleNamespace(agents_dir=self.agents_dir, workspaces_dir=self.workspaces_dir),
        )
        self.settings_patch.start()
        self.addCleanup(self.settings_patch.stop)
        self.addCleanup(self.temp_dir.cleanup)

        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        self.conn.executescript(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                owner_user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                workspace_dir TEXT NOT NULL,
                target_region TEXT,
                task_type TEXT NOT NULL,
                current_stage TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                claude_session_id TEXT NOT NULL,
                updated_at TEXT
            );
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                display_name TEXT NOT NULL
            );
            CREATE TABLE agent_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                status TEXT
            );
            CREATE TABLE file_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER,
                stage TEXT,
                file_path TEXT,
                edited_by INTEGER,
                content_hash TEXT,
                previous_content_hash TEXT,
                change_kind TEXT,
                change_summary TEXT,
                memory_revision INTEGER,
                content_snapshot TEXT,
                operation TEXT NOT NULL DEFAULT 'unknown',
                job_id INTEGER,
                restored_from_version_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE artifact_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER,
                stage TEXT,
                file_path TEXT,
                old_hash TEXT,
                new_hash TEXT,
                change_kind TEXT,
                impact_json TEXT,
                edited_by INTEGER,
                created_at TEXT
            );
            CREATE TABLE audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_user_id INTEGER,
                actor_username TEXT,
                action TEXT,
                target_type TEXT,
                target_id TEXT,
                target_label TEXT,
                details_json TEXT,
                project_id INTEGER,
                outcome TEXT NOT NULL DEFAULT 'success',
                source TEXT NOT NULL DEFAULT 'api',
                severity TEXT NOT NULL DEFAULT 'info',
                request_id TEXT,
                parent_event_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, status, claude_session_id
            ) VALUES (1, 9, '测试项目', 'workspaces/demo', '北美', 'rewrite', 'outline_rewrite', 'active', 'session')
            """
        )
        self.conn.execute("INSERT INTO users (id, username, display_name) VALUES (9, 'writer', '编剧')")
        self.user = {"id": 9, "username": "writer", "role": "admin"}
        self.write_workspace()

    # ------------------------------------------------------------------ 夹具

    def write_workspace(self) -> None:
        user_input = {
            "schema_version": "1.1.0",
            "project": {
                "project_name": "测试项目",
                "workspace": "workspaces/demo",
                "task_type": "rewrite",
                "target_region": "北美",
                "target_language": "en-US",
                "attachments": [],
            },
            "status": "outline_rewrite:completed",
            "audit": {"created_at": "2026-07-20T00:00:00Z", "created_by": "writer"},
        }
        progress = {
            "schema_version": "1.1.0",
            "status": "ready_for_next_skill",
            "current_skill": "outline_rewrite",
            "next_skill": "character_rewrite",
            "stages": {
                stage: {"status": "completed" if stage in ("project_init", "world_view", "outline_rewrite") else "pending"}
                for stage in (
                    "project_init", "novel_analysis", "world_view", "outline_rewrite",
                    "character_rewrite", "trial_generate", "full_generate",
                    "dialogue_translate", "foreign_review", "humanizer_zh",
                )
            },
            "audit": {"created_at": "2026-07-20T00:00:00Z", "created_by": "writer"},
        }
        (self.workspace / "1.1-user-input.json").write_text(
            json.dumps(user_input, ensure_ascii=False), encoding="utf-8"
        )
        (self.workspace / "1.2-project-progress.json").write_text(
            json.dumps(progress, ensure_ascii=False), encoding="utf-8"
        )
        self.outline_path = self.workspace / OUTLINE_FILE
        self.outline_path.write_text(OLD_OUTLINE, encoding="utf-8")
        self.world_view_path = self.workspace / "2.1-world-view.json"
        self.world_view_path.write_text(
            json.dumps(OLD_WORLD_VIEW, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        self.progress_path = self.workspace / "1.2-project-progress.json"

    def project(self) -> sqlite3.Row:
        return self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()

    def row_counts(self) -> dict[str, int]:
        return {
            table: int(self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in ("file_versions", "artifact_changes", "audit_logs")
        }

    def save_outline(self, content: str = NEW_OUTLINE) -> dict:
        return workspace_service.write_stage_file(
            self.conn, self.project(), self.user, "outline_rewrite", content
        )

    def save_world_view(self, payload: dict | None = None) -> dict:
        with patch.object(workspace_service, "run_stage_validation", return_value={"ok": True}), \
                patch.object(workspace_service, "sync_workspace_memory", return_value={"fresh": True}):
            return workspace_service.write_stage_file(
                self.conn,
                self.project(),
                self.user,
                "world_view",
                json.dumps(payload or NEW_WORLD_VIEW, ensure_ascii=False),
            )

    def failing_stage_file_write(self, stage_path: Path):
        """只让阶段正文落盘失败，其他文件（进度）与补偿复原仍可正常落盘。"""
        original = workspace_service._atomic_write_text
        broken = {stage_path}

        def guarded(path: Path, content: str) -> None:
            if path in broken:
                broken.clear()
                raise OSError("磁盘写入失败")
            original(path, content)

        return patch.object(workspace_service, "_atomic_write_text", side_effect=guarded)

    def failing_final_stage_file_write(self, stage_path: Path):
        """只让"数据库写入已完成之后"的那次正文落盘失败。"""
        original = workspace_service._atomic_write_text

        def guarded(path: Path, content: str) -> None:
            already_written = int(
                self.conn.execute("SELECT COUNT(*) FROM artifact_changes").fetchone()[0]
            )
            if path == stage_path and already_written:
                raise OSError("磁盘写入失败")
            original(path, content)

        return patch.object(workspace_service, "_atomic_write_text", side_effect=guarded)

    def sql_recorder(self, events: list[str]):
        """把复合写入实际执行的事务与写库语句按顺序记入 ``events``。"""
        def trace(statement: str) -> None:
            keyword = statement.strip().split()[0].upper() if statement.strip() else ""
            if keyword in ("INSERT", "UPDATE"):
                events.append("database")
            elif keyword in ("SAVEPOINT", "RELEASE", "ROLLBACK"):
                events.append(keyword.lower())

        self.conn.set_trace_callback(trace)
        self.addCleanup(self.conn.set_trace_callback, None)

    # ---------------------------------------------------------------- V1 / V2

    def test_stage_body_lands_through_the_hardened_atomic_writer(self) -> None:
        written: list[tuple[Path, str]] = []
        original = workspace_service._atomic_write_text

        def recorder(path: Path, content: str) -> None:
            written.append((path, content))
            original(path, content)

        with patch.object(workspace_service, "_atomic_write_text", side_effect=recorder):
            self.save_outline()

        self.assertIn((self.outline_path, NEW_OUTLINE), written)
        self.assertEqual(self.outline_path.read_text(encoding="utf-8"), NEW_OUTLINE)

    def test_atomic_write_uses_same_directory_temp_file_and_flushes_file_and_directory(self) -> None:
        target = self.workspace / "output" / "落盘样例.md"
        observed_temp_names: list[str] = []
        real_replace = Path.replace

        def replace_spy(self_path: Path, destination):
            observed_temp_names.append(self_path.name)
            return real_replace(self_path, destination)

        with patch.object(os, "fsync", wraps=os.fsync) as fsync_spy, \
                patch.object(Path, "replace", replace_spy):
            workspace_service._atomic_write_text(target, "内容\n")

        self.assertEqual(target.read_text(encoding="utf-8"), "内容\n")
        self.assertEqual(len(observed_temp_names), 1)
        self.assertTrue(observed_temp_names[0].startswith(f".{target.name}."))
        self.assertTrue(observed_temp_names[0].endswith(".tmp"))
        # 一次同步文件内容，一次同步目录项。
        self.assertEqual(fsync_spy.call_count, 2)
        self.assertEqual(list(target.parent.glob(".*.tmp")), [])

    # --------------------------------------------------------------------- V3

    def test_stage_body_lands_after_every_database_write(self) -> None:
        events: list[str] = []
        original_write = workspace_service._atomic_write_text
        self.sql_recorder(events)

        def recorder(path: Path, content: str) -> None:
            original_write(path, content)
            if path == self.outline_path:
                events.append("stage_file")

        with patch.object(workspace_service, "_atomic_write_text", side_effect=recorder):
            self.save_outline()

        self.assertEqual(events[0], "savepoint")
        self.assertEqual(events[-1], "release")
        self.assertEqual(events.count("stage_file"), 1)
        self.assertNotIn("rollback", events)
        last_database_write = max(index for index, name in enumerate(events) if name == "database")
        self.assertLess(last_database_write, events.index("stage_file"))

    def test_structured_stage_body_lands_after_every_database_write(self) -> None:
        events: list[str] = []
        original_write = workspace_service._atomic_write_text
        self.sql_recorder(events)

        def recorder(path: Path, content: str) -> None:
            original_write(path, content)
            if path == self.world_view_path:
                events.append("stage_file")

        with patch.object(workspace_service, "_atomic_write_text", side_effect=recorder):
            self.save_world_view()

        self.assertEqual(events[0], "savepoint")
        self.assertEqual(events[-1], "release")
        self.assertNotIn("rollback", events)
        last_database_write = max(index for index, name in enumerate(events) if name == "database")
        last_stage_file_write = max(index for index, name in enumerate(events) if name == "stage_file")
        self.assertLess(last_database_write, last_stage_file_write)
        self.assertEqual(
            json.loads(self.world_view_path.read_text(encoding="utf-8"))["世界观描述"],
            "新世界观",
        )

    # --------------------------------------------------------------------- V4

    def test_database_failure_leaves_the_stage_file_byte_identical(self) -> None:
        before = self.outline_path.read_bytes()

        with patch.object(workspace_service, "record_file_version", side_effect=InjectedFailure("库写入失败")):
            with self.assertRaises(HTTPException) as raised:
                self.save_outline()

        self.assertGreaterEqual(raised.exception.status_code, 500)
        self.assertEqual(self.outline_path.read_bytes(), before)

    def test_database_failure_leaves_the_structured_stage_file_byte_identical(self) -> None:
        before = self.world_view_path.read_bytes()

        with patch.object(workspace_service, "record_file_version", side_effect=InjectedFailure("库写入失败")):
            with self.assertRaises(HTTPException) as raised:
                self.save_world_view()

        self.assertGreaterEqual(raised.exception.status_code, 500)
        self.assertEqual(self.world_view_path.read_bytes(), before)

    def test_database_failure_leaves_no_partial_rows_even_after_a_commit(self) -> None:
        # 先写入一次成功保存，再让第二次保存在数据库段中途失败：
        # SAVEPOINT 必须只回滚失败的那一段，且提交后不留半条记录。
        self.save_outline()
        self.conn.commit()
        before = self.row_counts()

        with patch.object(workspace_service, "record_audit", side_effect=InjectedFailure("库写入失败")):
            with self.assertRaises(HTTPException):
                self.save_outline("# 剧本大纲\n\n第三版\n")
        self.conn.commit()

        self.assertEqual(self.row_counts(), before)

    # --------------------------------------------------------------------- V5

    def test_stage_file_write_failure_leaves_no_database_rows(self) -> None:
        before = self.row_counts()

        with self.failing_stage_file_write(self.outline_path):
            with self.assertRaises(HTTPException):
                self.save_outline()
        self.conn.commit()

        self.assertEqual(self.row_counts(), before)
        self.assertEqual(self.outline_path.read_text(encoding="utf-8"), OLD_OUTLINE)

    def test_structured_stage_file_write_failure_leaves_no_database_rows(self) -> None:
        before = self.row_counts()
        world_view_before = self.world_view_path.read_bytes()

        with self.failing_final_stage_file_write(self.world_view_path):
            with self.assertRaises(HTTPException):
                self.save_world_view()
        self.conn.commit()

        self.assertEqual(self.row_counts(), before)
        self.assertEqual(self.world_view_path.read_bytes(), world_view_before)

    # --------------------------------------------------------------------- V6

    def test_failed_rollback_is_recorded_and_keeps_the_original_reason(self) -> None:
        def guarded(path: Path, content: str) -> None:
            raise OSError("磁盘写入失败")

        with patch.object(workspace_service, "record_file_version", side_effect=InjectedFailure("库写入失败")), \
                patch.object(workspace_service, "_atomic_write_text", side_effect=guarded):
            with self.assertRaises(HTTPException) as raised:
                self.save_outline()

        traces = self.conn.execute(
            "SELECT action, outcome, severity, details_json FROM audit_logs WHERE severity = 'error'"
        ).fetchall()
        self.assertEqual(len(traces), 1)
        self.assertEqual(traces[0]["outcome"], "failure")
        details = json.loads(traces[0]["details_json"])
        self.assertIn("库写入失败", details["failure"])
        self.assertIn("磁盘写入失败", details["rollback_failure"])
        self.assertIsInstance(raised.exception.__cause__, InjectedFailure)

    # --------------------------------------------------------------------- V7

    def test_leftover_temporary_file_is_never_read_as_the_document(self) -> None:
        leftover = self.outline_path.with_name(f".{self.outline_path.name}.abc123.tmp")
        leftover.write_text("# 剧本大纲\n\n被截断的", encoding="utf-8")

        document = workspace_service.read_stage_file(self.project(), "outline_rewrite")

        self.assertEqual(document["content"], OLD_OUTLINE)
        listed = {
            item["file_name"]
            for item in workspace_service.files_for_project(self.project())
        }
        self.assertNotIn(leftover.name, listed)
        self.assertTrue(leftover.is_file())

    def test_successful_save_leaves_no_temporary_file_behind(self) -> None:
        self.save_outline()

        self.assertEqual(list(self.outline_path.parent.glob(".*.tmp")), [])
        self.assertEqual(list(self.workspace.glob(".*.tmp")), [])
        self.assertEqual(self.outline_path.read_text(encoding="utf-8"), NEW_OUTLINE)

    # --------------------------------------------------------------------- V8

    def test_progress_lands_before_the_stage_body(self) -> None:
        order: list[str] = []
        original_write = workspace_service._atomic_write_text
        original_mark = workspace_service.mark_semantic_edit_in_progress

        def mark_recorder(*args, **kwargs):
            result = original_mark(*args, **kwargs)
            order.append("progress")
            return result

        def write_recorder(path: Path, content: str) -> None:
            original_write(path, content)
            if path == self.outline_path:
                order.append("stage_file")

        with patch.object(workspace_service, "mark_semantic_edit_in_progress", side_effect=mark_recorder), \
                patch.object(workspace_service, "_atomic_write_text", side_effect=write_recorder):
            self.save_outline()

        self.assertEqual(order, ["progress", "stage_file"])

    def test_stage_body_write_failure_restores_the_progress_file(self) -> None:
        before = self.progress_path.read_bytes()

        with self.failing_stage_file_write(self.outline_path):
            with self.assertRaises(HTTPException):
                self.save_outline()

        self.assertEqual(self.progress_path.read_bytes(), before)

    # -------------------------------------------------------------- 用户可见文案

    def test_save_failure_message_is_plain_chinese(self) -> None:
        with patch.object(workspace_service, "record_file_version", side_effect=InjectedFailure(
            "sqlite3.OperationalError: no such table: file_versions /tmp/agents/workspaces/demo"
        )):
            with self.assertRaises(HTTPException) as raised:
                self.save_outline()

        message = str(raised.exception.detail)
        for forbidden in (
            "record_file_version", "file_versions", "INSERT", "SAVEPOINT",
            "OperationalError", "sqlite3", "/tmp",
        ):
            self.assertNotIn(forbidden, message)
        self.assertTrue(message.startswith("保存未完成"))


if __name__ == "__main__":
    unittest.main()
