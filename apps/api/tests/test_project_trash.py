import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import project_trash_service, workspace_service
from app.services.project_trash_service import (
    ProjectPurgeError,
    list_trashed_projects,
    purge_expired_projects,
    purge_project,
    restore_project,
)


class ProjectTrashTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo_root = Path(self.temp_dir.name)
        self.agents_dir = self.repo_root / "Agents"
        self.workspaces_dir = self.agents_dir / "workspaces"
        self.data_dir = self.repo_root / "data"
        self.upload_dir = self.data_dir / "uploads"
        self.workspaces_dir.mkdir(parents=True)
        self.upload_dir.mkdir(parents=True)
        self.settings = SimpleNamespace(
            repo_root=self.repo_root,
            agents_dir=self.agents_dir,
            workspaces_dir=self.workspaces_dir,
            data_dir=self.data_dir,
            upload_dir=self.upload_dir,
        )
        self.settings_patches = [
            patch.object(project_trash_service, "settings", self.settings),
            patch.object(workspace_service, "settings", self.settings),
        ]
        for settings_patch in self.settings_patches:
            settings_patch.start()

        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(
            """
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL
            );
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                owner_user_id INTEGER NOT NULL REFERENCES users(id),
                name TEXT NOT NULL,
                workspace_dir TEXT NOT NULL UNIQUE,
                target_region TEXT,
                task_type TEXT NOT NULL DEFAULT 'rewrite',
                current_stage TEXT NOT NULL DEFAULT 'project_init',
                pinned INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                claude_session_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE agent_jobs (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                raw_log_path TEXT
            );
            CREATE TABLE project_notes (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                content TEXT NOT NULL
            );
            """
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, role) VALUES (1, 'owner', '所有者', 'user')"
        )
        self.user = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()

    def tearDown(self):
        self.conn.close()
        for settings_patch in reversed(self.settings_patches):
            settings_patch.stop()
        self.temp_dir.cleanup()

    def create_project(self, *, project_id=1, workspace_name="project-1", deleted_at=None):
        workspace = self.workspaces_dir / workspace_name
        workspace.mkdir()
        (workspace / "1.2-project-progress.json").write_text(
            json.dumps({"current_stage": "project_init", "stages": {}, "audit": {}}),
            encoding="utf-8",
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, pinned, deleted_at, claude_session_id
            ) VALUES (?, 1, ?, ?, '北美', 'rewrite', 'project_init', 0, ?, 'session')
            """,
            (project_id, f"项目 {project_id}", f"workspaces/{workspace_name}", deleted_at),
        )
        return workspace

    def test_trash_list_reports_retention_and_project_can_be_restored(self):
        deleted_at = datetime.now(timezone.utc) - timedelta(days=2)
        self.create_project(deleted_at=deleted_at.strftime("%Y-%m-%d %H:%M:%S"))
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()

        result = list_trashed_projects(self.conn, self.user)
        items = result["projects"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], 1)
        self.assertEqual(items[0]["days_remaining"], 28)
        self.assertNotIn("workspace_dir", items[0])
        self.assertEqual(
            result["pagination"],
            {"page": 1, "page_size": 10, "total": 1, "total_pages": 1},
        )

        restored = restore_project(self.conn, project)
        self.assertEqual(restored["id"], 1)
        deleted_value = self.conn.execute("SELECT deleted_at FROM projects WHERE id = 1").fetchone()[0]
        self.assertIsNone(deleted_value)

    def test_permanent_delete_removes_workspace_logs_and_database_rows(self):
        workspace = self.create_project(deleted_at="2026-01-01 00:00:00")
        (workspace / "1.1-user-input.json").write_text(
            json.dumps({"project": {"source_script": {"reference_path": "references/source.md"}}}),
            encoding="utf-8",
        )
        log_path = self.data_dir / "zdebug" / "jobs" / "agent_job_10.jsonl"
        log_path.parent.mkdir(parents=True)
        log_path.write_text("{}\n", encoding="utf-8")
        self.conn.execute(
            "INSERT INTO agent_jobs (id, project_id, status, raw_log_path) VALUES (10, 1, 'succeeded', ?)",
            (str(log_path),),
        )
        self.conn.execute("INSERT INTO project_notes (id, project_id, content) VALUES (1, 1, '数据')")
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()

        purge_project(self.conn, project)

        self.assertFalse(workspace.exists())
        self.assertFalse(log_path.exists())
        self.assertIsNone(self.conn.execute("SELECT id FROM projects WHERE id = 1").fetchone())
        self.assertIsNone(self.conn.execute("SELECT id FROM agent_jobs WHERE id = 10").fetchone())
        self.assertIsNone(self.conn.execute("SELECT id FROM project_notes WHERE id = 1").fetchone())

    def test_cleanup_purges_only_projects_at_least_thirty_days_old(self):
        now = datetime(2026, 7, 11, 8, 0, tzinfo=timezone.utc)
        expired_workspace = self.create_project(
            project_id=1,
            workspace_name="expired",
            deleted_at=(now - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S"),
        )
        recent_workspace = self.create_project(
            project_id=2,
            workspace_name="recent",
            deleted_at=(now - timedelta(days=29, hours=23)).strftime("%Y-%m-%d %H:%M:%S"),
        )

        result = purge_expired_projects(self.conn, now=now)

        self.assertEqual(result, {"purged_ids": [1], "failures": []})
        self.assertFalse(expired_workspace.exists())
        self.assertTrue(recent_workspace.exists())
        self.assertIsNotNone(self.conn.execute("SELECT id FROM projects WHERE id = 2").fetchone())

    def test_trash_list_queries_only_the_requested_page(self):
        for project_id in range(1, 13):
            self.create_project(
                project_id=project_id,
                workspace_name=f"project-{project_id}",
                deleted_at="2026-07-01 00:00:00",
            )

        result = list_trashed_projects(self.conn, self.user, page=3, page_size=5)

        self.assertEqual([project["id"] for project in result["projects"]], [2, 1])
        self.assertEqual(
            result["pagination"],
            {"page": 3, "page_size": 5, "total": 12, "total_pages": 3},
        )

        clamped = list_trashed_projects(self.conn, self.user, page=99, page_size=5)
        self.assertEqual(clamped["pagination"]["page"], 3)
        self.assertEqual([project["id"] for project in clamped["projects"]], [2, 1])

    def test_workspace_root_is_never_deleted(self):
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, pinned, deleted_at, claude_session_id
            ) VALUES (1, 1, '危险路径', 'workspaces', '北美', 'rewrite', 'project_init', 0, '2026-01-01', 'session')
            """
        )
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()

        with self.assertRaises(ProjectPurgeError):
            purge_project(self.conn, project)

        self.assertTrue(self.workspaces_dir.exists())
        self.assertIsNotNone(self.conn.execute("SELECT id FROM projects WHERE id = 1").fetchone())


if __name__ == "__main__":
    unittest.main()
