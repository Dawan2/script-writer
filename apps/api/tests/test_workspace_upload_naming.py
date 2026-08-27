import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import UploadFile

from app.services import workspace_service


class WorkspaceUploadNamingTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo_root = Path(self.temp_dir.name)
        self.agents_dir = self.repo_root / "Agents"
        self.workspaces_dir = self.agents_dir / "workspaces"
        self.upload_dir = self.repo_root / "data" / "uploads"
        self.workspaces_dir.mkdir(parents=True)
        self.upload_dir.mkdir(parents=True)
        config_path = self.agents_dir / ".claude" / "config" / "region-rules.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text(
            json.dumps({"regions": {"北美": {"default_market": "美国", "default_locale": "en-US", "rules": ["测试规则"]}}}),
            encoding="utf-8",
        )
        self.settings_patch = patch.object(
            workspace_service,
            "settings",
            SimpleNamespace(
                agents_dir=self.agents_dir,
                workspaces_dir=self.workspaces_dir,
                upload_dir=self.upload_dir,
            ),
        )
        self.settings_patch.start()

        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                workspace_dir TEXT NOT NULL UNIQUE,
                target_region TEXT,
                task_type TEXT NOT NULL DEFAULT 'rewrite',
                current_stage TEXT NOT NULL DEFAULT 'project_init',
                status TEXT NOT NULL DEFAULT 'active',
                completed_at TEXT,
                completed_by INTEGER,
                pinned INTEGER NOT NULL DEFAULT 0,
                claude_session_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self.user = {"id": 7, "username": "writer"}

    def tearDown(self):
        self.conn.close()
        self.settings_patch.stop()
        self.temp_dir.cleanup()

    @staticmethod
    def upload(filename: str, content: bytes = b"scene one") -> UploadFile:
        return UploadFile(io.BytesIO(content), filename=filename)

    def test_blank_project_name_falls_back_to_client_filename_without_path(self):
        upload = self.upload(r"C:\fakepath\《十八岁太奶奶》 1-90集.txt")

        name = workspace_service.project_name_for_upload("  ", upload)

        self.assertEqual(name, "《十八岁太奶奶》 1-90集")

    def test_project_creation_archives_then_cleans_temporary_upload(self):
        workspace = self.workspaces_dir / "2026-07-12_writer_visible-title"
        captured_command = []
        captured_source = b""

        def fake_run(command, **_kwargs):
            nonlocal captured_source
            captured_command.extend(command)
            source_path = Path(command[command.index("--source-file") + 1])
            captured_source = source_path.read_bytes()
            workspace.mkdir()
            (workspace / "1.1-user-input.json").write_text(
                json.dumps({"project": {}}),
                encoding="utf-8",
            )
            (workspace / "1.2-project-progress.json").write_text(
                json.dumps({"current_skill": "project_init", "stages": {}, "audit": {}}),
                encoding="utf-8",
            )
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"workspace_dir": str(workspace)}),
                stderr="",
            )

        upload = self.upload("原始上传名.txt", "剧本正文".encode())
        with patch.object(workspace_service.subprocess, "run", side_effect=fake_run):
            project = workspace_service.create_project_from_upload(
                self.conn,
                user=self.user,
                project_name="显式项目名",
                target_region="北美",
                extra_requirements="",
                task_type="rewrite",
                upload=upload,
            )

        stored_path = Path(captured_command[captured_command.index("--source-file") + 1])
        source_title = captured_command[captured_command.index("--source-title") + 1]
        self.assertEqual(project["name"], "显式项目名")
        self.assertEqual(source_title, "原始上传名")
        self.assertRegex(stored_path.stem, r"^[0-9a-f]{32}$")
        self.assertEqual(stored_path.suffix, ".txt")
        self.assertNotIn("原始上传名", stored_path.name)
        self.assertEqual(captured_source, "剧本正文".encode())
        self.assertFalse(stored_path.exists())

    def test_review_command_also_carries_source_title(self):
        command = workspace_service.review_prepare_command(
            project_name="审稿项目",
            source_path=Path("/tmp/a1b2c3.pdf"),
            source_title="审稿项目",
            target_region="北美",
            extra_requirements="",
            username="writer",
        )

        self.assertEqual(command[command.index("--source-title") + 1], "审稿项目")


if __name__ == "__main__":
    unittest.main()
