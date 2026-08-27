import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import zdebug_manager as zdebug_module
from app.services.zdebug_manager import (
    ZDebugManager,
    extract_chat_user_request,
    project_job_log_files,
    worker_display_name,
)


class ZDebugManagerTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.data_dir = self.root / "data"
        self.agents_dir = self.root / "Agents"
        self.settings_patch = patch.object(
            zdebug_module,
            "settings",
            SimpleNamespace(
                data_dir=self.data_dir,
                repo_root=self.root,
                agents_dir=self.agents_dir,
                workspaces_dir=self.agents_dir / "workspaces",
            ),
        )
        self.settings_patch.start()
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                task_type TEXT NOT NULL DEFAULT 'rewrite',
                workspace_dir TEXT
            );
            CREATE TABLE agent_jobs (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL,
                stage TEXT NOT NULL,
                target_stage TEXT,
                prompt TEXT,
                status TEXT NOT NULL,
                claude_session_id TEXT NOT NULL,
                raw_log_path TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT
            );
            """
        )
        self.conn.execute(
            "INSERT INTO projects (id, name, workspace_dir) VALUES (1, '项目一', 'workspaces/project-one')"
        )
        self.conn.execute(
            "INSERT INTO projects (id, name, workspace_dir) VALUES (2, '项目二', 'workspaces/project-two')"
        )

    def tearDown(self):
        self.conn.close()
        self.settings_patch.stop()
        self.temp_dir.cleanup()

    def _insert_job(
        self,
        job_id: int,
        *,
        project_id: int,
        stage: str,
        target_stage: str,
        prompt: str,
        created_at: str,
        session_id: str = "shared-session",
        status: str = "succeeded",
    ) -> Path:
        log_path = self.data_dir / "zdebug" / "jobs" / f"agent_job_{job_id}.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text('{"type":"result","result":"ok"}\n', encoding="utf-8")
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, stage, target_stage, prompt, status, claude_session_id,
                raw_log_path, created_at, started_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                project_id,
                stage,
                target_stage,
                prompt,
                status,
                session_id,
                str(log_path),
                created_at,
                created_at,
            ),
        )
        return log_path

    def test_project_manifest_is_job_unique_scoped_and_time_descending(self):
        self._insert_job(
            101,
            project_id=1,
            stage="outline_rewrite",
            target_stage="outline_rewrite",
            prompt="标准动作",
            created_at="2026-07-11 09:00:00",
        )
        self._insert_job(
            102,
            project_id=1,
            stage="chat_edit",
            target_stage="outline_rewrite",
            prompt=(
                "当前定位文档信息：\n- 项目：项目一\n\n用户请求：\n"
                "请把第三集的冲突提前，并保留角色的克制感。\n\n"
                "用户附件：\n## note.txt\n不应出现在名称里\n\n"
                "请从工作区读取目标文件，并完成修改。"
            ),
            created_at="2026-07-11 10:00:00",
            status="running",
        )
        self._insert_job(
            201,
            project_id=2,
            stage="character_rewrite",
            target_stage="character_rewrite",
            prompt="另一个项目",
            created_at="2026-07-11 11:00:00",
        )
        self.conn.commit()

        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        files = project_job_log_files(self.conn, project=project, current_job_id=102)

        self.assertEqual([item["id"] for item in files], ["job-102", "job-101"])
        self.assertEqual([item["sessionId"] for item in files], ["shared-session", "shared-session"])
        self.assertEqual(files[0]["name"], "故事梗概 · 请把第三集的冲突提前，并保留角色的克制感。")
        self.assertEqual(files[1]["name"], "故事梗概 · outline_rewrite")
        self.assertTrue(files[0]["current"])
        self.assertTrue(files[0]["live"])
        self.assertFalse(files[1]["current"])
        self.assertEqual(files[0]["modifiedAt"], "2026-07-11T10:00:00Z")

    def test_chat_request_is_compact_and_length_limited(self):
        prompt = "用户请求：\n" + "角色对话 " * 40 + "\n\n请从工作区读取目标文件"
        result = extract_chat_user_request(prompt, max_chars=24)
        self.assertEqual(len(result), 24)
        self.assertTrue(result.endswith("..."))
        self.assertNotIn("\n", result)

    def test_project_manifest_includes_worker_logs_with_child_tag(self):
        self._insert_job(
            102,
            project_id=1,
            stage="trial_generate",
            target_stage="trial_generate",
            prompt="生成试稿",
            created_at="2026-07-11 10:00:00",
            status="running",
        )
        worker_log = (
            self.agents_dir
            / "workspaces/project-one/runtime/jobs/102/workers/trial-dialogue-review-1.jsonl"
        )
        worker_log.parent.mkdir(parents=True)
        worker_log.write_text('{"type":"zdebug_start"}\n', encoding="utf-8")
        self.conn.commit()

        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        files = project_job_log_files(self.conn, project=project, current_job_id=102)

        self.assertEqual([item["id"] for item in files], ["job-102"])
        worker = files[0]["workers"][0]
        self.assertEqual(worker["id"], "worker:trial-dialogue-review-1")
        self.assertEqual(worker["tag"], "子进程 1")
        self.assertEqual(worker["name"], "台词语义审读")
        self.assertTrue(worker["live"])

    def test_semantic_repair_attempts_keep_a_user_facing_worker_name(self):
        self.assertEqual(worker_display_name("trial-semantic-repair-2"), "定向修订")

    def test_open_viewer_registers_new_worker_log(self):
        manager = ZDebugManager()
        manifest_path = manager._write_log_manifest(
            job_id=36,
            project_id=7,
            selected_log_id="job-36",
            log_files=[{
                "id": "job-36",
                "jobId": 36,
                "sessionId": "parent-session",
                "name": "剧本试稿 · trial_generate",
                "path": str(self.root / "36.jsonl"),
                "modifiedAt": "2026-07-11T11:00:00Z",
                "current": True,
                "live": True,
            }],
        )
        manager._processes["agent_job_36"] = SimpleNamespace(
            process=SimpleNamespace(poll=lambda: None),
            log_manifest_path=manifest_path,
            project_id=7,
            selected_log_id="job-36",
            process_key="agent_job_36",
        )
        worker_log = self.root / "workers" / "trial-narrative-review-1.jsonl"
        worker_log.parent.mkdir(parents=True)
        worker_log.write_text('{"type":"zdebug_start"}\n', encoding="utf-8")

        manager.register_worker_log(
            job_id=36,
            label="trial-narrative-review-1",
            runtime_log_path=worker_log,
            session_id="worker-session",
            worker_number=1,
            live=True,
        )

        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        worker = payload["files"][0]["workers"][0]
        self.assertEqual(worker["tag"], "子进程 1")
        self.assertEqual(worker["name"], "叙事质量审读")
        self.assertTrue(worker["live"])

    def test_manifest_persists_selected_job_id(self):
        manager = ZDebugManager()
        files = [
            {
                "id": "job-35",
                "jobId": 35,
                "sessionId": "same-session",
                "name": "剧本试稿 · trial_generate",
                "path": str(self.root / "35.jsonl"),
                "modifiedAt": "2026-07-11T10:00:00Z",
                "current": False,
                "live": False,
            },
            {
                "id": "job-36",
                "jobId": 36,
                "sessionId": "same-session",
                "name": "剧本试稿 · trial_generate",
                "path": str(self.root / "36.jsonl"),
                "modifiedAt": "2026-07-11T11:00:00Z",
                "current": True,
                "live": True,
            },
        ]
        manifest_path = manager._write_log_manifest(
            job_id=36,
            project_id=7,
            selected_log_id="job-36",
            log_files=files,
        )

        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["scope"], {"type": "project", "projectId": 7})
        self.assertEqual(payload["selectedLogId"], "job-36")
        self.assertEqual([item["id"] for item in payload["files"]], ["job-35", "job-36"])

    def test_evolution_viewer_uses_an_isolated_manifest_and_runtime_log(self):
        manager = ZDebugManager()
        runtime_log = self.data_dir / "agent-evolution" / "7" / "analysis.jsonl"
        with patch.object(manager, "_start_log_viewer", return_value={"status": "running"}) as start:
            result = manager.start_for_evolution_run(
                run_id=7,
                project_path=self.root,
                runtime_log_path=runtime_log,
                modified_at="2026-07-14 10:00:00",
                live=True,
            )

        self.assertEqual(result["status"], "running")
        values = start.call_args.kwargs
        self.assertEqual(values["process_key"], "agent_evolution_7")
        self.assertEqual(values["scope"], {"type": "system_agent_evolution", "runId": 7})
        self.assertEqual(values["runtime_log_path"], runtime_log)
        self.assertEqual(values["log_files"][0]["id"], "agent-evolution-7")
        self.assertTrue(values["log_files"][0]["live"])


if __name__ == "__main__":
    unittest.main()
