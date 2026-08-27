import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.db import session
from app.services import script_library_service, workspace_service
from app.services.project_lifecycle_service import archive_project


class ProjectArchiveDistillationTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.agents_dir = self.root / "Agents"
        self.workspaces_dir = self.agents_dir / "workspaces"
        self.workspaces_dir.mkdir(parents=True)
        self.settings = SimpleNamespace(
            data_dir=self.root / "data",
            database_path=self.root / "data" / "app.db",
            repo_root=self.root,
            agents_dir=self.agents_dir,
            workspaces_dir=self.workspaces_dir,
        )
        self.patches = [
            patch.object(session, "settings", self.settings),
            patch.object(workspace_service, "settings", self.settings),
            patch.object(script_library_service, "settings", self.settings),
        ]
        for item in self.patches:
            item.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) "
            "VALUES (1, 'author', '作者', 'hash', 'user')"
        )
        self.actor = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()

    def tearDown(self):
        self.conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def create_project(self, project_id: int, *, task_type: str, rating: str, with_full_script: bool = True):
        workspace_name = f"project-{project_id}"
        workspace = self.workspaces_dir / workspace_name
        (workspace / "output").mkdir(parents=True)
        (workspace / "output" / "审稿报告.md").write_text("# 审稿报告\n", encoding="utf-8")
        (workspace / "3.1-outline.json").write_text(
            json.dumps({"剧本名称": f"档案 {project_id}"}, ensure_ascii=False),
            encoding="utf-8",
        )
        if with_full_script:
            script = (
                f"# 《档案 {project_id}》剧本全稿\n\n## 第1集\n\n"
                + f"△ 林夏拿起编号 {project_id} 的档案，当场追问真相。\n林夏：这份证据会改变结果。\n" * 12
            )
            full_script_path = workspace / workspace_service.stage_file_for_workspace(workspace, "full_generate")
            full_script_path.write_text(script, encoding="utf-8")
        (workspace / "review-scorecard.json").write_text(
            json.dumps(
                {"总体结论": {"评级": rating}, "剧本信息": {"剧本名称": f"评分卡档案 {project_id}"}},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (workspace / "1.2-project-progress.json").write_text(
            json.dumps(
                {
                    "current_skill": "foreign_review",
                    "stages": {
                        "full_generate": {"status": "completed"},
                        "foreign_review": {"status": "approved"},
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, status, claude_session_id
            ) VALUES (?, 1, ?, ?, '北美', ?, 'foreign_review', 'active', ?)
            """,
            (project_id, f"项目 {project_id}", f"workspaces/{workspace_name}", task_type, f"session-{project_id}"),
        )
        return self.conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()

    def test_eligible_creative_projects_queue_full_script_distillation(self):
        scenarios_and_ratings = [
            ("rewrite", "A"),
            ("novel", "A+"),
            ("replicate", "S"),
            ("rewrite", "S+"),
            ("novel", "SS"),
        ]
        for project_id, (task_type, rating) in enumerate(scenarios_and_ratings, start=1):
            project = self.create_project(project_id, task_type=task_type, rating=rating)
            archived = archive_project(self.conn, project=project, actor=self.actor)
            self.assertEqual(archived["status"], "completed")

        scripts = self.conn.execute(
            """
            SELECT source_project_id, source_label, status
            FROM script_library_scripts ORDER BY source_project_id
            """
        ).fetchall()
        self.assertEqual([row["source_project_id"] for row in scripts], [1, 2, 3, 4, 5])
        self.assertTrue(all(row["source_label"].startswith("项目归档 · ") for row in scripts))
        self.assertTrue(all(row["status"] == "queued" for row in scripts))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM script_distillation_jobs WHERE status = 'queued'").fetchone()[0],
            5,
        )

    def test_low_rating_and_non_creative_projects_do_not_queue_distillation(self):
        low_rating = self.create_project(1, task_type="rewrite", rating="B+")
        review_only = self.create_project(2, task_type="review", rating="SS")

        archive_project(self.conn, project=low_rating, actor=self.actor)
        archive_project(self.conn, project=review_only, actor=self.actor)

        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM script_library_scripts").fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM script_distillation_jobs").fetchone()[0], 0)

    def test_duplicate_archive_does_not_create_another_distillation_job(self):
        project = self.create_project(1, task_type="rewrite", rating="A")

        archive_project(self.conn, project=project, actor=self.actor)
        completed = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        archive_project(self.conn, project=completed, actor=self.actor)

        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM script_library_scripts").fetchone()[0], 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM script_distillation_jobs").fetchone()[0], 1)

    def test_distillation_queue_failure_does_not_block_project_archive(self):
        project = self.create_project(1, task_type="rewrite", rating="A", with_full_script=False)

        archived = archive_project(self.conn, project=project, actor=self.actor)

        self.assertEqual(archived["status"], "completed")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM script_library_scripts").fetchone()[0], 0)
        audit = self.conn.execute(
            "SELECT details_json FROM audit_logs WHERE action = 'project.archive' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        details = json.loads(audit["details_json"])
        self.assertEqual(details["script_distillation"]["status"], "queue_failed")
        self.assertIn("未找到完整剧本", details["script_distillation"]["message"])


if __name__ == "__main__":
    unittest.main()
