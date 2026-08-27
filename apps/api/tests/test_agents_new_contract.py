from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, patch

from app.routers import agent as agent_router
from app.routers import projects as projects_router
from app.routers.projects import StageApproval
from app.services import agent_runner, workspace_service
from app.services.script_profile_resolution_service import resolve_automatic_script_profile
from app.services.project_lifecycle_service import archive_project


class AgentsNewContractTest(unittest.TestCase):
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
                    "拉美": {"default_market": "墨西哥", "default_locale": "es-MX", "rules": ["测试规则"]},
                    "国内": {"default_market": "中国大陆", "default_locale": "zh-CN", "requires_translation": False, "rules": ["测试规则"]},
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
        self.agent_runner_settings_patch = patch.object(
            agent_runner,
            "settings",
            SimpleNamespace(
                agents_dir=self.agents_dir,
                workspaces_dir=self.workspaces_dir,
                internal_agent_tool_base_url="http://127.0.0.1:8000",
            ),
        )
        self.agent_runner_settings_patch.start()

        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
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
                completed_at TEXT,
                completed_by INTEGER,
                pinned INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                claude_session_id TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                display_name TEXT NOT NULL
            );
            CREATE TABLE stage_approvals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                stage TEXT NOT NULL,
                artifact_hash TEXT NOT NULL,
                quality_contract_version TEXT,
                memory_revision INTEGER,
                approved_by INTEGER NOT NULL,
                job_id INTEGER
            );
            CREATE TABLE agent_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                user_id INTEGER,
                stage TEXT,
                target_stage TEXT,
                prompt TEXT,
                status TEXT,
                claude_session_id TEXT,
                authoring_session_id TEXT,
                authoring_session_origin TEXT,
                optimization_scope TEXT,
                updated_at TEXT
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
                created_at TEXT
            );
            """
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, status, claude_session_id
            ) VALUES (1, 9, '测试项目', 'workspaces/demo', '北美', 'rewrite', 'world_view', 'active', 'project-session')
            """
        )
        self.conn.execute("INSERT INTO users (id, username, display_name) VALUES (9, 'writer', '编剧')")
        self.user = {"id": 9, "username": "writer", "role": "admin"}
        self.write_workspace(task_type="rewrite")

    def tearDown(self) -> None:
        with agent_runner.NOVEL_ANALYSIS_TOOL_CONTEXTS_LOCK:
            agent_runner.NOVEL_ANALYSIS_TOOL_CONTEXTS.clear()
        self.conn.close()
        self.agent_runner_settings_patch.stop()
        self.settings_patch.stop()
        self.temp_dir.cleanup()

    @staticmethod
    def complete_brief() -> dict:
        return {
            "status": "complete",
            "target_countries": ["美国"],
            "target_locale": "en-US",
            "episode_duration": "60-90 秒",
            "target_episode_count": 60,
            "maturity_target": "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
            "market_deliverables": [{
                "market": "美国",
                "locale": "en-US",
                "delivery_mode": "bilingual_script",
                "status": "resolved",
                "locale_source": "user_confirmed:target_locale",
            }],
            "locale_contract_status": "single_locale",
            "requires_separate_language_versions": False,
            "missing_fields": [],
            "assumptions_require_approval": False,
            "inferred_fields": [],
            "assumption_notes": [],
            "theme": ["悬疑"],
            "setting": ["大女主"],
            "background": ["现代", "都市"],
            "audience": ["女频"],
        }

    def write_workspace(self, *, task_type: str, statuses: dict | None = None) -> None:
        stage_statuses = {
            "project_init": "completed",
            "novel_analysis": "pending",
            "world_view": "pending",
            "outline_rewrite": "pending",
            "character_rewrite": "pending",
            "trial_generate": "pending",
            "full_generate": "pending",
            "dialogue_translate": "pending",
            "foreign_review": "pending",
            "humanizer_zh": "pending",
        }
        stage_statuses.update(statuses or {})
        source_output_path = (
            "runtime/原始小说.md" if task_type == "novel"
            else "output/爆款分析报告.md" if task_type == "replicate"
            else "output/原始剧本.md"
        )
        user_input = {
            "schema_version": "1.1.0",
            "project": {
                "project_name": "测试项目",
                "workspace": "workspaces/demo",
                "task_type": task_type,
                "target_region": "北美",
                "target_language": "en-US",
                "distribution_brief": self.complete_brief(),
                "extra_requirements": "保留主角主动选择",
                "source_script": {
                    "reference_path": "references/source.md",
                    "output_path": source_output_path,
                    "original_name": "source.md",
                    "display_name": "源剧本文件",
                },
                "attachments": [],
            },
            "status": "project_init:completed",
            "audit": {"created_at": "2026-07-20T00:00:00Z", "created_by": "writer"},
        }
        progress = {
            "schema_version": "1.1.0",
            "status": "ready_for_next_skill",
            "current_skill": next((stage for stage, value in stage_statuses.items() if value != "pending"), "project_init"),
            "next_skill": "world_view",
            "stages": {stage: {"status": value} for stage, value in stage_statuses.items()},
            "audit": {"created_at": "2026-07-20T00:00:00Z", "created_by": "writer"},
        }
        (self.workspace / "references").mkdir(parents=True, exist_ok=True)
        (self.workspace / "references" / "source.md").write_text("# 原始剧本\n", encoding="utf-8")
        source_path = self.workspace / source_output_path
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text("# 原始内容\n", encoding="utf-8")
        (self.workspace / "1.1-user-input.json").write_text(json.dumps(user_input, ensure_ascii=False), encoding="utf-8")
        (self.workspace / "1.2-project-progress.json").write_text(json.dumps(progress, ensure_ascii=False), encoding="utf-8")

    def project(self):
        return self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()

    def progress(self) -> dict:
        return json.loads((self.workspace / "1.2-project-progress.json").read_text(encoding="utf-8"))

    def save_progress(self, progress: dict) -> None:
        (self.workspace / "1.2-project-progress.json").write_text(
            json.dumps(progress, ensure_ascii=False), encoding="utf-8"
        )

    def test_region_derives_required_market_settings_without_optional_defaults(self) -> None:
        defaults = workspace_service.default_distribution_brief("北美", {})
        self.assertEqual(defaults["target_country"], "美国")
        self.assertEqual(defaults["target_locale"], "en-US")
        self.assertNotIn("target_episode_count", defaults)
        self.assertEqual(defaults["maturity_target"], workspace_service.DEFAULT_MATURITY_TARGET)
        regions = workspace_service.list_target_regions()
        north_america = next(region for region in regions if region["key"] == "北美")
        self.assertEqual(north_america["target_market"], "美国")

        brief = workspace_service.normalize_distribution_brief({
            "target_countries": ["美国"],
            "target_locale": "en-US",
        })
        self.assertEqual(brief["status"], "complete")
        self.assertNotIn("target_episode_count", brief)
        self.assertEqual(brief["maturity_target"], workspace_service.DEFAULT_MATURITY_TARGET)

    def test_rewrite_file_rail_and_stage_prerequisites_follow_new_chain(self) -> None:
        files = workspace_service.files_for_project(self.project())
        self.assertEqual(
            [item["stage"] for item in files],
            ["project_init", "world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"],
        )
        self.assertEqual(workspace_service.stage_file_for_workspace(self.workspace, "outline_rewrite"), "output/剧本大纲.md")
        self.assertEqual(workspace_service.stage_file_for_workspace(self.workspace, "full_generate"), "output/剧本全稿.md")
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["world_view"])

        progress = self.progress()
        for stage in ("world_view", "outline_rewrite", "character_rewrite"):
            progress["stages"][stage]["status"] = "completed"
            progress["current_skill"] = stage
        self.save_progress(progress)
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["trial_generate"])

        progress["stages"]["trial_generate"]["status"] = "awaiting_approval"
        progress["current_skill"] = "trial_generate"
        self.save_progress(progress)
        with self.assertRaisesRegex(Exception, "确认"):
            agent_runner.planned_stages(self.project(), "full_generate")
        progress["stages"]["trial_generate"]["status"] = "approved"
        self.save_progress(progress)
        self.assertEqual(agent_runner.planned_stages(self.project(), "full_generate"), ["full_generate"])

        progress["stages"]["full_generate"]["status"] = "completed"
        progress["current_skill"] = "full_generate"
        self.save_progress(progress)
        self.assertEqual(agent_runner.planned_stages(self.project(), "dialogue_translate"), ["dialogue_translate"])
        with self.assertRaisesRegex(Exception, "台词翻译"):
            agent_runner.planned_stages(self.project(), "foreign_review")
        progress["stages"]["dialogue_translate"]["status"] = "completed"
        progress["current_skill"] = "dialogue_translate"
        self.save_progress(progress)
        self.assertEqual(agent_runner.planned_stages(self.project(), "foreign_review"), ["foreign_review"])

    def test_completed_full_script_can_regenerate_without_trial_approval(self) -> None:
        progress = self.progress()
        for stage in ("world_view", "outline_rewrite", "character_rewrite"):
            progress["stages"][stage]["status"] = "completed"
        progress["stages"]["trial_generate"]["status"] = "pending"
        progress["stages"]["full_generate"] = {"status": "stale", "completed_once": True}
        progress["current_skill"] = "character_rewrite"
        self.save_progress(progress)
        (self.workspace / "output" / "剧本全稿.md").write_text("# 剧本全稿\n\n## 第1集\n", encoding="utf-8")

        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["full_generate"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "full_generate"), ["full_generate"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "trial_generate"), ["full_generate"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "all"), ["full_generate"])

        progress["current_skill"] = "trial_generate"
        self.save_progress(progress)
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["full_generate"])

    def test_first_failed_full_script_does_not_skip_trial(self) -> None:
        progress = self.progress()
        progress["stages"]["character_rewrite"]["status"] = "completed"
        progress["stages"]["trial_generate"]["status"] = "pending"
        progress["stages"]["full_generate"] = {"status": "needs_revision"}
        progress["current_skill"] = "character_rewrite"
        self.save_progress(progress)
        (self.workspace / "output" / "剧本全稿.md").write_text("# 未通过检查的全稿\n", encoding="utf-8")

        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["trial_generate"])

    def test_all_adaptation_projects_skip_trial_after_a_completed_full_script(self) -> None:
        for task_type in ("novel", "replicate"):
            with self.subTest(task_type=task_type):
                self.conn.execute(
                    "UPDATE projects SET task_type = ?, current_stage = 'character_rewrite' WHERE id = 1",
                    (task_type,),
                )
                self.write_workspace(task_type=task_type)
                progress = self.progress()
                prerequisite_stages = (
                    ("novel_analysis", "outline_rewrite", "character_rewrite")
                    if task_type == "novel"
                    else ("world_view", "outline_rewrite", "character_rewrite")
                )
                for stage in prerequisite_stages:
                    progress["stages"][stage]["status"] = "completed"
                progress["stages"]["trial_generate"]["status"] = "pending"
                progress["stages"]["full_generate"] = {"status": "stale", "completed_once": True}
                progress["current_skill"] = "character_rewrite"
                self.save_progress(progress)
                (self.workspace / "output" / "剧本全稿.md").write_text("# 剧本全稿\n", encoding="utf-8")

                self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["full_generate"])
                self.assertEqual(agent_runner.planned_stages(self.project(), "all"), ["full_generate"])

    def test_completed_full_script_rejects_trial_chat_edit(self) -> None:
        progress = self.progress()
        progress["stages"]["full_generate"] = {"status": "completed", "completed_once": True}
        self.save_progress(progress)
        (self.workspace / "output" / "剧本全稿.md").write_text("# 剧本全稿\n\n## 第1集\n", encoding="utf-8")

        with self.assertRaisesRegex(Exception, "直接调整完整剧本"):
            agent_runner.create_job(
                self.conn,
                project=self.project(),
                user=self.conn.execute("SELECT * FROM users WHERE id = 9").fetchone(),
                stage="chat_edit",
                target_stage="trial_generate",
                prompt="修改开场",
            )

    def test_review_p0_optimization_uses_only_structured_p0_items(self) -> None:
        progress = self.progress()
        progress["stages"]["full_generate"] = {"status": "completed", "completed_once": True}
        self.save_progress(progress)
        (self.workspace / "output" / "剧本全稿.md").write_text("# 剧本全稿\n", encoding="utf-8")
        (self.workspace / "review-scorecard.json").write_text(
            json.dumps({
                "P0问题": [{
                    "问题": "终局规则未闭合",
                    "原稿情况": "终局没有交代规则停止原因。",
                    "修改动作": "补足规则触发与停止的因果。",
                    "验收条件": "结局前完成规则闭环。",
                }],
                "P1问题": [{
                    "问题": "次要对白偏长",
                    "修改动作": "压缩对白。",
                    "验收条件": "对白更短。",
                }],
            }, ensure_ascii=False),
            encoding="utf-8",
        )

        with patch.object(agent_runner, "foreign_review_decision_result", return_value={"ok": True}):
            context = agent_runner.review_p0_optimization_context(self.project())

        self.assertEqual(context["issue_titles"], ["终局规则未闭合"])
        prompt = agent_runner.review_p0_optimization_prompt(context)
        self.assertIn("终局规则未闭合", prompt)
        self.assertNotIn("次要对白偏长", prompt)
        self.assertIn("不得顺带处理 P1", prompt)
        self.assertIn("参考该 skill", prompt)
        self.assertIn("不要调用或重新执行 `full_generate` skill 的 SOP", prompt)
        self.assertNotIn("Use `full_generate` skill，完成剧本全稿输出。", prompt)

    def test_review_p0_optimization_requires_p0_items(self) -> None:
        progress = self.progress()
        progress["stages"]["full_generate"] = {"status": "completed", "completed_once": True}
        self.save_progress(progress)
        (self.workspace / "output" / "剧本全稿.md").write_text("# 剧本全稿\n", encoding="utf-8")
        (self.workspace / "review-scorecard.json").write_text('{"P0问题": []}\n', encoding="utf-8")

        with (
            patch.object(agent_runner, "foreign_review_decision_result", return_value={"ok": True}),
            self.assertRaisesRegex(Exception, "没有 P0"),
        ):
            agent_runner.review_p0_optimization_context(self.project())

    def test_recorded_foreign_review_decision_uses_the_actual_reviewed_script(self) -> None:
        full_path = self.workspace / "output" / "剧本全稿.md"
        dialogue_path = self.workspace / "output" / "台词译稿.md"
        scorecard_path = self.workspace / "review-scorecard.json"
        scoring_path = self.workspace / "runtime" / "review-scoring.json"
        report_path = self.workspace / "output" / "审稿报告.md"
        full_path.write_text("# 剧本全稿\n", encoding="utf-8")
        dialogue_path.write_text("# 台词译稿\n", encoding="utf-8")
        scorecard_path.write_text(
            json.dumps({"审稿信息": {"剧本文件": "output/台词译稿.md"}}, ensure_ascii=False),
            encoding="utf-8",
        )
        scoring_path.parent.mkdir(parents=True, exist_ok=True)
        scoring_path.write_text('{"内部评分":"已完成"}\n', encoding="utf-8")
        report_path.write_text("# 审稿报告\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["foreign_review"] = {
            "status": "completed",
            "review_decision": {
                "outcome": "revision_requested",
                "verdict": "返修",
                "revision_stage": "full_generate",
                "artifact_hashes": {
                    "output/台词译稿.md": hashlib.sha256(dialogue_path.read_bytes()).hexdigest(),
                    "review-scorecard.json": hashlib.sha256(scorecard_path.read_bytes()).hexdigest(),
                    "runtime/review-scoring.json": hashlib.sha256(scoring_path.read_bytes()).hexdigest(),
                    "output/审稿报告.md": hashlib.sha256(report_path.read_bytes()).hexdigest(),
                },
            },
        }
        self.save_progress(progress)

        self.assertEqual(
            agent_runner.foreign_review_decision_artifacts(self.workspace)[0],
            "output/台词译稿.md",
        )
        self.assertIsNotNone(agent_runner.foreign_review_decision_result(self.workspace))

        full_path.write_text("# 剧本全稿\n\n未经审稿的本地变更\n", encoding="utf-8")
        self.assertIsNotNone(agent_runner.foreign_review_decision_result(self.workspace))

        dialogue_path.write_text("# 台词译稿\n\n审稿后变更\n", encoding="utf-8")
        self.assertIsNone(agent_runner.foreign_review_decision_result(self.workspace))

    def test_replicate_project_uses_analysis_report_and_world_view_chain(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'replicate', current_stage = 'world_view' WHERE id = 1")
        self.write_workspace(task_type="replicate")

        files = workspace_service.files_for_project(self.project())

        self.assertEqual(
            [item["stage"] for item in files],
            ["project_init", "world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"],
        )
        self.assertEqual(files[0]["name"], "爆款分析报告")
        self.assertEqual(files[0]["file_name"], "output/爆款分析报告.md")
        self.assertEqual(workspace_service.stage_file_for_workspace(self.workspace, "project_init"), "output/爆款分析报告.md")
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["world_view"])
        self.assertNotIn("runtime/爆款复刻审稿核对.json", agent_runner.foreign_review_decision_artifacts(self.workspace))

    def test_domestic_adaptation_skips_dialogue_translation(self) -> None:
        self.conn.execute("UPDATE projects SET target_region = '国内', task_type = 'novel', current_stage = 'novel_analysis' WHERE id = 1")
        self.write_workspace(task_type="novel", statuses={"dialogue_translate": "skipped"})

        self.assertEqual(
            workspace_service.workflow_stage_order("rewrite", "国内"),
            ["project_init", "world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "foreign_review"],
        )
        self.assertEqual(
            workspace_service.workflow_stage_order("novel", "国内"),
            ["project_init", "novel_analysis", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "foreign_review"],
        )
        self.assertNotIn("dialogue_translate", [item["stage"] for item in workspace_service.files_for_project(self.project())])

        progress = self.progress()
        progress["stages"]["full_generate"]["status"] = "completed"
        progress["current_skill"] = "full_generate"
        self.save_progress(progress)
        self.assertEqual(agent_runner.planned_stages(self.project(), "foreign_review"), ["foreign_review"])

    def test_domestic_replicate_skips_dialogue_translation(self) -> None:
        self.conn.execute("UPDATE projects SET target_region = '国内', task_type = 'replicate', current_stage = 'world_view' WHERE id = 1")
        self.write_workspace(task_type="replicate", statuses={"dialogue_translate": "skipped"})

        self.assertEqual(
            workspace_service.workflow_stage_order("replicate", "国内"),
            ["project_init", "world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "foreign_review"],
        )
        self.assertNotIn("dialogue_translate", [item["stage"] for item in workspace_service.files_for_project(self.project())])

    def test_novel_project_uses_analysis_chain_and_keeps_source_as_attachment(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'novel', current_stage = 'novel_analysis' WHERE id = 1")
        self.write_workspace(task_type="novel")

        files = workspace_service.files_for_project(self.project())
        self.assertEqual(
            [item["stage"] for item in files],
            ["novel_analysis", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"],
        )
        self.assertEqual(files[0]["name"], "小说解读")
        self.assertNotIn("project_init", [item["stage"] for item in files])
        self.assertNotIn("world_view", [item["stage"] for item in files])
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["novel_analysis"])
        with self.assertRaises(Exception):
            agent_runner.planned_stages(self.project(), "world_view")

        source_path, source_name = workspace_service.source_attachment_for_project(self.project())
        self.assertEqual(source_path, self.workspace / "references" / "source.md")
        self.assertEqual(source_name, "source.md")
        snapshot = workspace_service.distribution_brief_for_project(self.project())
        self.assertEqual(snapshot["source"]["display_name"], "source.md")

        analysis = {
            "基础信息": {
                "小说名称": "测试小说",
                "小说梗概": "主角主动追查身份秘密。",
                "题材": ["悬疑"],
                "基调": "紧张",
            },
            "核心卖点": "身份谜局持续升级，每次求证都会揭开更大的秘密。",
            "故事主线": "主角从收到线索到公开真相。",
            "世界观": "现代家族企业中，公开证据能够改变继承权。",
            "关键人物": [{"人物名称": "林夏", "人物画像": "继承人，渴望查清身份；从依赖到独立，转变发生在公开证据时。"}],
            "剧情单元": [{"单元ID": "unit-truth", "单元名称": "公开真相", "单元梗概": "林夏公开证据。", "主线推进": "身份秘密公开。", "关键人物": [{"人物名称": "林夏", "单元作用与变化": "承担公开真相的代价。"}], "关键信息": ["家族知道真相。"], "高光时刻": [{"名称": "公开证据", "原文索引": "L1-L1"}], "改编建议": "保留", "合并目标单元ID": "", "已确认合并": False, "建议原因": "公开真相同时改变权力格局和主角选择，是核心高潮。"}],
        }
        (self.workspace / "2.1-novel-analysis.json").write_text(
            json.dumps(analysis, ensure_ascii=False), encoding="utf-8"
        )
        document = workspace_service.read_stage_file(self.project(), "novel_analysis")
        self.assertEqual(document["novel_analysis"]["剧情单元"][0]["单元ID"], "unit-truth")
        self.assertEqual(document["content"], json.dumps(analysis, ensure_ascii=False))

    def test_new_contract_stage_prompt_defers_preferences_to_the_skill_tool(self) -> None:
        prompt = agent_runner.stage_prompt(
            "outline_rewrite",
            self.workspace,
            "writer",
            "",
            preference_context={
                "stage": "outline_rewrite",
                "effective_preferences": [{
                    "layer": "stage",
                    "content": "每个剧情单元都要用人物的主动选择推动转折。",
                }],
            },
            preference_path=self.workspace / "runtime" / "jobs" / "9" / "user-preferences.json",
        )

        self.assertNotIn("每个剧情单元都要用人物的主动选择推动转折。", prompt)
        self.assertNotIn("current-stage-user-preferences", prompt)
        self.assertNotIn("user-preferences.json", prompt)
        self.assertIn("Use `outline_rewrite` skill", prompt)

    def test_stage_prompt_includes_the_deterministic_tool_next_action(self) -> None:
        prompt = agent_runner.stage_prompt(
            "novel_analysis",
            self.workspace,
            "writer",
            "",
            {"next_action": "小说全文解读草稿已生成，请完成最终一致性复核。"},
        )

        self.assertIn("准备结果：小说全文解读草稿已生成，请完成最终一致性复核。", prompt)

    def test_novel_quality_retry_routes_to_targeted_repair_without_full_reading(self) -> None:
        prompt = agent_runner.stage_prompt(
            "novel_analysis",
            self.workspace,
            "writer",
            "",
            {"next_action": "调用‘完整阅读小说’工具。"},
            execution_scenario="修复生成结果",
            repair_context={
                "source_job_id": 88,
                "issues": ["高光时刻原文索引越界"],
            },
        )

        self.assertIn("执行场景：修复生成结果", prompt)
        self.assertIn("上一轮检查问题（任务 #88）", prompt)
        self.assertIn("高光时刻原文索引越界", prompt)
        self.assertNotIn("准备结果：调用‘完整阅读小说’工具。", prompt)

    def test_novel_edit_routes_to_existing_analysis_without_full_reading(self) -> None:
        job = {
            "prompt": "只调整第三个剧情单元的改编建议",
            "regenerate_current_file": 1,
            "reference_current_file": 1,
        }
        scenario = agent_runner.requested_stage_execution_scenario(
            job,
            "novel_analysis",
            {},
        )
        prompt = agent_runner.stage_prompt(
            "novel_analysis",
            self.workspace,
            "writer",
            job["prompt"],
            {"next_action": "调用‘完整阅读小说’工具。"},
            execution_scenario=scenario,
        )

        self.assertEqual(scenario, "修改已完成内容")
        self.assertIn("执行场景：修改已完成内容", prompt)
        self.assertNotIn("准备结果：调用‘完整阅读小说’工具。", prompt)

    def test_world_view_stage_prompt_starts_from_the_generated_execution_spec(self) -> None:
        spec_path = self.workspace / "runtime" / "jobs" / "7" / "world_view" / "执行规范.md"
        strategy_path = self.workspace / "runtime" / "jobs" / "7" / "world_view" / "执行策略.md"
        prompt = agent_runner.stage_prompt(
            "world_view",
            self.workspace,
            "writer",
            "",
            {
                "execution_spec_file": str(spec_path),
                "execution_strategy_file": str(strategy_path),
                "knowledge_status": "loaded",
                "principle_count": 3,
                "formula_count": 0,
            },
        )

        self.assertIn("后台已完成剧本标签处理、世界观初始化和执行策略准备", prompt)
        self.assertIn(f"执行规范：{spec_path}", prompt)
        self.assertIn(f"执行策略：{strategy_path}", prompt)
        self.assertIn("已获取 3 条创作原则和 0 条策略公式", prompt)
        self.assertIn("执行场景：首次生成", prompt)
        self.assertIn("Skill 中的快速开始、生成流程", prompt)

    def test_full_revision_stage_prompt_routes_to_completed_script_editing(self) -> None:
        spec_path = self.workspace / "runtime" / "jobs" / "8" / "full_generate" / "执行规范.md"
        strategy_path = self.workspace / "runtime" / "jobs" / "8" / "full_generate" / "执行策略.md"
        prompt = agent_runner.stage_prompt(
            "full_generate",
            self.workspace,
            "writer",
            "修改已完成的剧本",
            {
                "generation_mode": "full_revision",
                "execution_spec_file": str(spec_path),
                "execution_strategy_file": str(strategy_path),
                "knowledge_status": "loaded",
                "principle_count": 1,
                "formula_count": 2,
            },
        )

        self.assertIn("执行场景：修改已完成剧本", prompt)
        self.assertIn("初始化模式：`full_revision`", prompt)
        self.assertNotIn("执行场景：首次生成", prompt)

    def test_quality_retry_loads_source_issues_and_generation_mode(self) -> None:
        retry_conn = sqlite3.connect(":memory:")
        retry_conn.row_factory = sqlite3.Row
        retry_conn.execute(
            """
            CREATE TABLE agent_jobs (
                id INTEGER PRIMARY KEY,
                project_id INTEGER,
                stage TEXT,
                target_stage TEXT,
                status TEXT,
                error_code TEXT,
                error_message TEXT,
                error_details_json TEXT
            )
            """
        )
        retry_conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, stage, target_stage, status,
                error_code, error_message, error_details_json
            ) VALUES (519, 1, 'full_generate', 'full_generate', 'failed', 'QUALITY_GATE', ?, ?)
            """,
            (
                "完整剧本尚未通过检查",
                json.dumps({"issues": ["第 21 集缺少场景标题", "第 22 集缺少人物栏"]}, ensure_ascii=False),
            ),
        )
        job = {
            "id": 520,
            "project_id": 1,
            "stage": "full_generate",
            "target_stage": "full_generate",
            "retry_of_job_id": 519,
            "prompt": "",
        }
        try:
            repair_context = agent_runner.retry_quality_repair_context(
                retry_conn,
                job,
                "full_generate",
            )
        finally:
            retry_conn.close()

        self.assertEqual(repair_context["source_job_id"], 519)
        self.assertEqual(repair_context["issues"], ["第 21 集缺少场景标题", "第 22 集缺少人物栏"])
        scenario = agent_runner.requested_stage_execution_scenario(
            job,
            "full_generate",
            {"generation_mode": "trial_continuation"},
            repair_context,
        )
        prompt = agent_runner.stage_prompt(
            "full_generate",
            self.workspace,
            "writer",
            "",
            {"generation_mode": "trial_continuation"},
            execution_scenario=scenario,
            repair_context=repair_context,
        )

        self.assertIn("执行场景：修复生成结果", prompt)
        self.assertIn("初始化模式：`trial_continuation`", prompt)
        self.assertIn("上一轮检查问题（任务 #519）", prompt)
        self.assertIn("第 21 集缺少场景标题", prompt)
        self.assertIn("不执行完整生成流程", prompt)

    def test_regeneration_with_current_file_routes_to_completed_content_editing(self) -> None:
        scenario = agent_runner.requested_stage_execution_scenario(
            {
                "prompt": "保留现有内容，只调整中段关系",
                "regenerate_current_file": 1,
                "reference_current_file": 1,
            },
            "outline_rewrite",
            {},
        )
        prompt = agent_runner.stage_prompt(
            "outline_rewrite",
            self.workspace,
            "writer",
            "保留现有内容，只调整中段关系",
            {},
            execution_scenario=scenario,
        )

        self.assertIn("执行场景：修改已完成内容", prompt)
        self.assertNotIn("执行场景：首次生成", prompt)

    def test_world_view_strategy_tool_receives_the_current_job_context(self) -> None:
        job = {"id": 79}
        subprocess_result = SimpleNamespace(returncode=0, stdout=json.dumps({
            "ok": True,
            "execution_strategy_file": str(
                self.workspace / "runtime" / "jobs" / "79" / "world_view" / "执行策略.md"
            ),
            "knowledge_status": "loaded",
            "principle_count": 2,
            "formula_count": 0,
        }, ensure_ascii=False), stderr="")
        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "agent_process_environment", return_value={}),
            patch.object(agent_runner.subprocess, "run", return_value=subprocess_result) as run,
        ):
            result = agent_runner.prepare_stage_execution_strategy(
                self.conn,
                job,
                self.workspace,
                "world_view",
                threading.Event(),
            )

        environment = run.call_args.kwargs["env"]
        self.assertEqual(environment["ORCA_AGENT_JOB_ID"], "79")
        self.assertEqual(environment["ORCA_AGENT_STAGE"], "world_view")
        self.assertEqual(
            environment["ORCA_SCRIPT_KNOWLEDGE_DB_PATH"],
            str(agent_runner.script_knowledge_database_path()),
        )
        self.assertEqual(
            environment["ORCA_USER_PREFERENCE_CONTEXT_PATH"],
            str(agent_runner.preference_snapshot_path(self.workspace, 79)),
        )
        self.assertEqual(result["principle_count"], 2)

    def test_stage_tool_receives_the_current_script_knowledge_database(self) -> None:
        job = {"id": 78, "prompt": "", "regenerate_current_file": 0, "reference_current_file": None}
        subprocess_result = SimpleNamespace(returncode=0, stdout='{"ok": true}', stderr="")
        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "agent_process_environment", return_value={}),
            patch.object(agent_runner.subprocess, "run", return_value=subprocess_result) as run,
        ):
            agent_runner.run_stage_script(
                self.conn, job, self.workspace, "writer", "world_view", "init"
            )

        self.assertEqual(
            run.call_args.kwargs["env"]["ORCA_SCRIPT_KNOWLEDGE_DB_PATH"],
            str(agent_runner.script_knowledge_database_path()),
        )

    def test_world_view_regeneration_uses_execution_spec_and_current_reason(self) -> None:
        user_prompt = agent_runner.prompt_with_regeneration_reference(
            self.project(),
            "world_view",
            "重新生成原因：世界观需要更强的阶层冲突。",
            False,
            regenerate_current_file=True,
        )
        spec_path = self.workspace / "runtime" / "jobs" / "7" / "world_view" / "执行规范.md"
        prompt = agent_runner.stage_prompt(
            "world_view",
            self.workspace,
            "writer",
            user_prompt,
            {"execution_spec_file": str(spec_path)},
        )

        self.assertIn(f"请先阅读执行规范：{spec_path}", prompt)
        self.assertNotIn("用户额外要求：保留主角主动选择", prompt)
        self.assertIn("重新生成原因：世界观需要更强的阶层冲突。", prompt)
        self.assertNotIn("请重新生成当前阶段内容", prompt)
        self.assertNotIn("当前文件参考模式：不参考", prompt)
        self.assertNotIn("禁止读取或沿用当前阶段已生成文件", prompt)

    def test_world_view_profile_preprocessing_only_replaces_automatic_fields(self) -> None:
        input_path = self.workspace / "1.1-user-input.json"
        user_input = json.loads(input_path.read_text(encoding="utf-8"))
        user_input["project"]["distribution_brief"].update({
            "theme": ["自动适配"],
            "setting": ["大女主"],
            "background": ["自动适配"],
            "audience": ["女频"],
        })
        input_path.write_text(json.dumps(user_input, ensure_ascii=False), encoding="utf-8")
        (self.agents_dir / ".claude" / "config" / "script-tag-taxonomy.json").write_text(
            json.dumps({
                "theme": ["悬疑"], "setting": ["大女主"],
                "background": ["现代", "都市"], "audience": ["女频"],
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        principles = self.agents_dir / ".claude" / "skills" / "_shared" / "references" / "剧本设定解析原则.md"
        principles.parent.mkdir(parents=True, exist_ok=True)
        principles.write_text("只补全自动适配字段。", encoding="utf-8")

        with patch(
            "app.services.script_profile_resolution_service.call_direct_model",
            return_value='{"theme":["悬疑"],"background":["现代","都市"]}',
        ) as model:
            result = resolve_automatic_script_profile(
                workspace=self.workspace,
                agents_dir=self.agents_dir,
                runtime={"model_name": "test"},
                updated_by="writer",
                job_id=7,
            )

        self.assertEqual(model.call_args.kwargs["runtime"]["max_tokens"], 12_000)
        self.assertEqual(model.call_args.kwargs["runtime"]["thinking_level"], "low")
        self.assertEqual(result["status"], "resolved")
        resolved = json.loads(input_path.read_text(encoding="utf-8"))["project"]["distribution_brief"]
        self.assertEqual(resolved["theme"], ["悬疑"])
        self.assertEqual(resolved["background"], ["现代", "都市"])
        self.assertEqual(resolved["setting"], ["大女主"])
        self.assertEqual(resolved["audience"], ["女频"])
        self.assertEqual(result["attempt_count"], 1)

    def test_world_view_profile_preprocessing_keeps_all_user_selected_tags(self) -> None:
        input_path = self.workspace / "1.1-user-input.json"
        user_input = json.loads(input_path.read_text(encoding="utf-8"))
        user_input["project"]["distribution_brief"].update({
            "theme": ["民国爱情"],
            "setting": ["大女主"],
            "background": ["现代", "都市"],
            "audience": ["女频"],
            "inferred_fields": [],
        })
        input_path.write_text(json.dumps(user_input, ensure_ascii=False), encoding="utf-8")

        with patch(
            "app.services.script_profile_resolution_service.call_direct_model"
        ) as model:
            result = resolve_automatic_script_profile(
                workspace=self.workspace,
                agents_dir=self.agents_dir,
                runtime={"model_name": "test"},
                updated_by="writer",
                job_id=84,
            )

        model.assert_not_called()
        self.assertEqual(result["status"], "not_needed")
        self.assertEqual(result["script_profile"]["theme"], ["民国爱情"])
        self.assertEqual(result["script_profile"]["background"], ["现代", "都市"])

    def test_world_view_profile_preprocessing_repairs_invalid_model_tags(self) -> None:
        input_path = self.workspace / "1.1-user-input.json"
        user_input = json.loads(input_path.read_text(encoding="utf-8"))
        user_input["project"]["distribution_brief"].update({
            "theme": ["自动适配"],
            "setting": ["自动适配"],
            "background": ["现代", "都市"],
            "audience": ["自动适配"],
        })
        input_path.write_text(json.dumps(user_input, ensure_ascii=False), encoding="utf-8")
        (self.agents_dir / ".claude" / "config" / "script-tag-taxonomy.json").write_text(
            json.dumps({
                "theme": ["民国爱情", "现代言情", "悬疑"],
                "setting": ["大女主", "马甲"],
                "background": ["现代", "都市", "民国"],
                "audience": ["女频"],
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        principles = self.agents_dir / ".claude" / "skills" / "_shared" / "references" / "剧本设定解析原则.md"
        principles.parent.mkdir(parents=True, exist_ok=True)
        principles.write_text(
            "待补全标签不得与用户已明确标签冲突。\n"
            "民国爱情不能与现代、古代或年代主背景同时使用。",
            encoding="utf-8",
        )

        with patch(
            "app.services.script_profile_resolution_service.call_direct_model",
            side_effect=[
                '{"theme":["民国爱情","悬疑"],"setting":["大女主"],"audience":["女频"]}',
                '{"theme":["现代言情","悬疑"],"setting":["大女主"],"audience":["女频"]}',
            ],
        ) as model:
            result = resolve_automatic_script_profile(
                workspace=self.workspace,
                agents_dir=self.agents_dir,
                runtime={"model_name": "test"},
                updated_by="writer",
                job_id=81,
            )

        self.assertEqual(model.call_count, 2)
        self.assertIn(
            "民国爱情不能与现代、古代或年代主背景同时使用",
            model.call_args_list[0].kwargs["system_prompt"],
        )
        repair_prompt = model.call_args_list[1].kwargs["user_prompt"]
        self.assertIn("民国爱情与当前主背景不一致", repair_prompt)
        self.assertIn('"背景": [', repair_prompt)
        self.assertEqual(result["attempt_count"], 2)
        resolved = json.loads(input_path.read_text(encoding="utf-8"))["project"]["distribution_brief"]
        self.assertEqual(resolved["theme"], ["现代言情", "悬疑"])
        self.assertEqual(resolved["background"], ["现代", "都市"])

    def test_world_view_profile_preprocessing_treats_missing_tags_as_pending(self) -> None:
        input_path = self.workspace / "1.1-user-input.json"
        user_input = json.loads(input_path.read_text(encoding="utf-8"))
        for field in ("theme", "setting", "background", "audience"):
            user_input["project"]["distribution_brief"].pop(field, None)
        input_path.write_text(json.dumps(user_input, ensure_ascii=False), encoding="utf-8")
        (self.agents_dir / ".claude" / "config" / "script-tag-taxonomy.json").write_text(
            json.dumps({
                "theme": ["现代言情"],
                "setting": ["大女主"],
                "background": ["现代", "都市"],
                "audience": ["女频"],
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        principles = self.agents_dir / ".claude" / "skills" / "_shared" / "references" / "剧本设定解析原则.md"
        principles.parent.mkdir(parents=True, exist_ok=True)
        principles.write_text("补全缺失标签。", encoding="utf-8")

        with patch(
            "app.services.script_profile_resolution_service.call_direct_model",
            return_value=(
                '{"theme":["现代言情"],"setting":["大女主"],'
                '"background":["现代","都市"],"audience":["女频"]}'
            ),
        ):
            result = resolve_automatic_script_profile(
                workspace=self.workspace,
                agents_dir=self.agents_dir,
                runtime={"model_name": "test"},
                updated_by="writer",
                job_id=83,
            )

        self.assertEqual(result["status"], "resolved")
        self.assertEqual(result["resolved_fields"], ["theme", "setting", "background", "audience"])
        self.assertEqual(result["resolved_labels"], ["主题", "设定", "背景", "受众"])

    def test_world_view_profile_failure_stops_before_initialization_and_agent(self) -> None:
        job = {
            "id": 82,
            "user_id": 9,
            "project_id": 1,
            "prompt": "生成世界观",
            "claude_session_id": "world-session",
        }
        with (
            patch.object(agent_runner, "snapshot_stage_delivery", return_value={}),
            patch.object(agent_runner, "restore_stage_delivery"),
            patch.object(agent_runner, "record_rejected_delivery"),
            patch.object(agent_runner, "refresh_project_from_progress"),
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(
                agent_runner,
                "resolve_automatic_script_profile",
                side_effect=RuntimeError("民国爱情与当前主背景不一致"),
            ),
            patch.object(agent_runner, "run_stage_script") as initialize,
            patch.object(agent_runner, "prepare_stage_execution_strategy") as prepare_strategy,
            patch.object(agent_runner, "stage_prompt") as build_prompt,
            patch.object(agent_runner, "run_claude_prompt_with_recovery") as start_agent,
        ):
            with self.assertRaises(agent_runner.AgentExecutionError) as raised:
                agent_runner.run_new_contract_stage(
                    self.conn,
                    job,
                    self.project(),
                    "writer",
                    "world_view",
                    threading.Event(),
                )

        self.assertEqual(raised.exception.code, "SCRIPT_PROFILE_RESOLUTION_FAILED")
        initialize.assert_called_once()
        prepare_strategy.assert_not_called()
        build_prompt.assert_not_called()
        start_agent.assert_not_called()

    def test_world_view_prepares_profile_spec_and_strategy_before_starting_agent(self) -> None:
        job = {
            "id": 80,
            "user_id": 9,
            "project_id": 1,
            "prompt": "生成世界观",
            "claude_session_id": "world-session",
        }
        calls: list[str] = []
        spec_path = self.workspace / "runtime" / "jobs" / "80" / "world_view" / "执行规范.md"
        strategy_path = self.workspace / "runtime" / "jobs" / "80" / "world_view" / "执行策略.md"

        def resolve_profile(**_kwargs):
            calls.append("profile")
            return {"status": "resolved", "resolved_fields": ["theme", "background"]}

        def initialize(*_args, **_kwargs):
            calls.append("init")
            return {"ok": True, "execution_spec_file": str(spec_path)}

        def prepare_strategy(*_args, **_kwargs):
            calls.append("strategy")
            return {
                "ok": True,
                "execution_strategy_file": str(strategy_path),
                "knowledge_status": "loaded",
                "principle_count": 2,
                "formula_count": 0,
            }

        def build_prompt(*_args, **_kwargs):
            calls.append("prompt")
            prepared = _args[4]
            self.assertEqual(prepared["execution_spec_file"], str(spec_path))
            self.assertEqual(prepared["execution_strategy_file"], str(strategy_path))
            return "Use `world_view` skill"

        def start_agent(*_args, **_kwargs):
            calls.append("agent")
            raise RuntimeError("stop after verifying preparation order")

        with (
            patch.object(agent_runner, "snapshot_stage_delivery", return_value={}),
            patch.object(agent_runner, "restore_stage_delivery"),
            patch.object(agent_runner, "record_rejected_delivery"),
            patch.object(agent_runner, "refresh_project_from_progress"),
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "resolve_automatic_script_profile", side_effect=resolve_profile),
            patch.object(agent_runner, "run_stage_script", side_effect=initialize),
            patch.object(
                agent_runner,
                "prepare_stage_execution_strategy",
                side_effect=prepare_strategy,
            ),
            patch.object(agent_runner, "stage_prompt", side_effect=build_prompt),
            patch.object(
                agent_runner,
                "run_claude_prompt_with_recovery",
                side_effect=start_agent,
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "preparation order"):
                agent_runner.run_new_contract_stage(
                    self.conn,
                    job,
                    self.project(),
                    "writer",
                    "world_view",
                    threading.Event(),
                )

        self.assertEqual(calls, ["init", "profile", "init", "strategy", "prompt", "agent"])

    def test_rewrite_stages_prepare_profile_spec_and_strategy_before_starting_agent(self) -> None:
        for stage in ("outline_rewrite", "character_rewrite", "trial_generate", "full_generate"):
            with self.subTest(stage=stage):
                job = {
                    "id": 180,
                    "user_id": 9,
                    "project_id": 1,
                    "prompt": "生成当前阶段",
                    "claude_session_id": f"{stage}-session",
                }
                calls: list[str] = []
                spec_path = self.workspace / "runtime" / "jobs" / "180" / stage / "执行规范.md"
                strategy_path = self.workspace / "runtime" / "jobs" / "180" / stage / "执行策略.md"

                def initialize(*_args, **_kwargs):
                    calls.append("init")
                    return {
                        "ok": True,
                        "execution_spec_file": str(spec_path),
                        "generation_mode": "full_revision" if stage == "full_generate" else None,
                    }

                def prepare_strategy(*_args, **_kwargs):
                    calls.append("strategy")
                    self.assertEqual(_args[3], stage)
                    return {
                        "ok": True,
                        "execution_strategy_file": str(strategy_path),
                        "knowledge_status": "loaded",
                        "principle_count": 2,
                        "formula_count": 3,
                    }

                def build_prompt(*_args, **_kwargs):
                    calls.append("prompt")
                    prepared = _args[4]
                    self.assertEqual(prepared["execution_spec_file"], str(spec_path))
                    self.assertEqual(prepared["execution_strategy_file"], str(strategy_path))
                    return f"Use `{stage}` skill"

                def start_agent(*_args, **_kwargs):
                    calls.append("agent")
                    raise RuntimeError("stop after verifying rewrite stage preparation order")

                with (
                    patch.object(agent_runner, "snapshot_stage_delivery", return_value={}),
                    patch.object(agent_runner, "restore_stage_delivery"),
                    patch.object(agent_runner, "record_rejected_delivery"),
                    patch.object(agent_runner, "refresh_project_from_progress"),
                    patch.object(agent_runner, "mark_stage_in_progress"),
                    patch.object(agent_runner, "add_event"),
                    patch.object(
                        agent_runner,
                        "resolve_automatic_script_profile",
                        side_effect=lambda **_kwargs: calls.append("profile") or {"status": "not_needed"},
                    ),
                    patch.object(agent_runner, "run_stage_script", side_effect=initialize),
                    patch.object(agent_runner, "prepare_stage_execution_strategy", side_effect=prepare_strategy),
                    patch.object(agent_runner, "stage_prompt", side_effect=build_prompt),
                    patch.object(
                        agent_runner,
                        "prepare_full_revision_authoring_session",
                        return_value=job,
                    ),
                    patch.object(agent_runner, "run_claude_prompt_with_recovery", side_effect=start_agent),
                    patch.object(agent_runner, "run_full_worker", side_effect=start_agent),
                ):
                    with self.assertRaisesRegex(RuntimeError, "preparation order"):
                        agent_runner.run_new_contract_stage(
                            self.conn,
                            job,
                            self.project(),
                            "writer",
                            stage,
                            threading.Event(),
                        )

                self.assertEqual(calls, ["init", "profile", "strategy", "prompt", "agent"])

    def test_non_reference_regeneration_requests_a_stage_reset(self) -> None:
        job = {
            "id": 71,
            "prompt": "重新生成原因：重写开篇。",
            "regenerate_current_file": 1,
            "reference_current_file": 0,
        }
        subprocess_result = SimpleNamespace(returncode=0, stdout='{"ok": true}', stderr="")
        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "agent_process_environment", return_value={}),
            patch.object(agent_runner.subprocess, "run", return_value=subprocess_result) as run,
        ):
            self.assertEqual(
                agent_runner.run_stage_script(
                    self.conn, job, self.workspace, "writer", "world_view", "init"
                ),
                {"ok": True},
            )

        self.assertEqual(run.call_args.kwargs["env"]["ORCA_RESET_CURRENT_STAGE"], "1")

    def test_non_reference_regeneration_starts_a_clean_stage_session(self) -> None:
        payload = agent_router.AgentJobCreate(
            stage="world_view",
            target_stage="world_view",
            prompt="重新生成原因：强化冲突。",
            regenerate_current_file=True,
            reference_current_file=False,
        )
        background_tasks = SimpleNamespace(add_task=lambda *_args, **_kwargs: None)
        with (
            patch.object(agent_router, "get_project_or_404", return_value=self.project()),
            patch.object(agent_router, "create_job", return_value={"id": 73}) as create_job,
            patch.object(agent_router, "public_job", return_value={"id": 73}),
        ):
            agent_router.post_agent_job(
                1,
                payload,
                background_tasks,
                self.conn,
                self.user,
            )

        self.assertTrue(create_job.call_args.kwargs["force_new_session"])

    def test_stage_snapshot_restores_foreign_review_runtime_state(self) -> None:
        files = {
            "review-scorecard.json": "旧评分卡",
            "output/审稿报告.md": "旧审稿报告",
            "runtime/review-scoring.json": "旧评分",
            "runtime/review-source-index.json": "旧索引",
            "runtime/review-coverage.json": "旧覆盖记录",
            "runtime/review-ledger.json": "旧审读台账",
        }
        for relative_path, content in files.items():
            target = self.workspace / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

        snapshot = agent_runner.snapshot_stage_delivery(self.workspace, 72, "foreign_review")
        for relative_path in files:
            (self.workspace / relative_path).unlink()
        agent_runner.restore_stage_delivery(self.workspace, snapshot)

        for relative_path, content in files.items():
            self.assertEqual((self.workspace / relative_path).read_text(encoding="utf-8"), content)

    def test_novel_stage_registers_full_reading_for_the_main_agent(self) -> None:
        self.conn.execute(
            "UPDATE projects SET task_type = 'novel', current_stage = 'novel_analysis' WHERE id = 1"
        )
        self.write_workspace(task_type="novel")
        job = {
            "id": 63,
            "user_id": 9,
            "project_id": 1,
            "prompt": "完成小说解读",
            "claude_session_id": "novel-session",
        }
        initialized = {
            "ok": True,
            "source_index": {"source_file": "runtime/原始小说.md"},
            "adaptation_plan": {"target_episode_count": 35},
        }
        reading_result = {
            "ok": True,
            "message": "小说全文已阅读完成，解读草稿已生成。",
            "next_action": "复核小说解读。",
        }
        with (
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_stage_script", side_effect=[initialized, {"ok": True}]),
            patch.object(agent_runner, "register_novel_analysis_tool", return_value="tool-token") as register,
            patch.object(agent_runner, "unregister_novel_analysis_tool") as unregister,
            patch.object(agent_runner, "prepare_novel_analysis_stage") as prepare,
            patch.object(agent_runner, "stage_prompt", return_value="Use `novel_analysis` skill") as prompt_builder,
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job) as run_claude,
            patch.object(agent_runner, "wait_for_novel_analysis_tool", return_value=reading_result) as wait_for_reading,
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            agent_runner.run_new_contract_stage(
                self.conn,
                job,
                self.project(),
                "writer",
                "novel_analysis",
                object(),
            )

        register.assert_called_once()
        prepare.assert_not_called()
        wait_for_reading.assert_called_once()
        self.assertEqual(run_claude.call_count, 2)
        self.assertEqual(prompt_builder.call_count, 2)
        self.assertIs(prompt_builder.call_args_list[0].args[4], initialized)
        self.assertIs(prompt_builder.call_args_list[1].args[4], reading_result)
        self.assertEqual(prompt_builder.call_args_list[0].kwargs["execution_scenario"], "首次生成")
        self.assertEqual(prompt_builder.call_args_list[1].kwargs["execution_scenario"], "首次生成")
        self.assertIn("小说全文阅读已完成。不要再次调用‘完整阅读小说’", run_claude.call_args_list[1].args[2])
        unregister.assert_called_once_with("tool-token")

    def test_novel_quality_retry_skips_full_reading_handoff(self) -> None:
        self.conn.execute(
            "UPDATE projects SET task_type = 'novel', current_stage = 'novel_analysis' WHERE id = 1"
        )
        self.write_workspace(task_type="novel")
        job = {
            "id": 64,
            "user_id": 9,
            "project_id": 1,
            "prompt": "",
            "claude_session_id": "novel-repair-session",
        }
        initialized = {
            "ok": True,
            "analysis_file": str(self.workspace / "2.1-novel-analysis.json"),
            "next_action": "调用‘完整阅读小说’工具。",
        }
        repair_context = {
            "source_job_id": 63,
            "issues": ["关键人物缺少终局回报"],
        }
        with (
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "retry_quality_repair_context", return_value=repair_context),
            patch.object(agent_runner, "run_stage_script", side_effect=[initialized, {"ok": True}]),
            patch.object(agent_runner, "register_novel_analysis_tool") as register,
            patch.object(agent_runner, "unregister_novel_analysis_tool"),
            patch.object(agent_runner, "stage_prompt", return_value="Use `novel_analysis` skill") as prompt_builder,
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job) as run_claude,
            patch.object(agent_runner, "wait_for_novel_analysis_tool") as wait_for_reading,
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            agent_runner.run_new_contract_stage(
                self.conn,
                job,
                self.project(),
                "writer",
                "novel_analysis",
                object(),
            )

        register.assert_not_called()
        wait_for_reading.assert_not_called()
        run_claude.assert_called_once()
        prompt_builder.assert_called_once()
        self.assertEqual(prompt_builder.call_args.kwargs["execution_scenario"], "修复生成结果")
        self.assertIs(prompt_builder.call_args.kwargs["repair_context"], repair_context)

    def test_novel_reading_tool_environment_is_bound_to_the_registered_job(self) -> None:
        token = agent_runner.register_novel_analysis_tool(
            job_id=63,
            workspace=self.workspace,
            username="writer",
            prepared={"ok": True},
            preference_context=None,
            timeout_event=threading.Event(),
        )

        self.assertEqual(agent_runner.novel_analysis_tool_environment(62), {})
        self.assertEqual(
            agent_runner.novel_analysis_tool_environment(63),
            {
                "ORCA_NOVEL_ANALYSIS_TOOL_TOKEN": token,
                "ORCA_NOVEL_ANALYSIS_TOOL_URL": "http://127.0.0.1:8000/internal/agent-tools/novel-analysis/prepare",
            },
        )

    def test_novel_analysis_parallelism_is_capped_at_three_workers(self) -> None:
        with patch.object(agent_runner, "settings", SimpleNamespace(novel_analysis_parallel_workers=8)):
            self.assertEqual(agent_runner.novel_analysis_parallelism(12), 3)
        with patch.object(agent_runner, "settings", SimpleNamespace(novel_analysis_parallel_workers=2)):
            self.assertEqual(agent_runner.novel_analysis_parallelism(12), 2)
            self.assertEqual(agent_runner.novel_analysis_parallelism(1), 1)

    def test_parallel_novel_workers_reduce_capacity_and_keep_completed_outputs(self) -> None:
        class FinishedProcess:
            created = 0

            def __init__(self, *_args, **_kwargs) -> None:
                type(self).created += 1
                self.pid = 50_000 + type(self).created
                self.returncode = 1 if type(self).created == 1 else 0

            def poll(self) -> int:
                return self.returncode

        worker_root = self.workspace / "runtime" / "jobs" / "63" / "novel-analysis"
        requests = [{
            "prompt": f"整理第 {index} 部分",
            "label": f"novel-read-{index:03d}",
            "output_file": worker_root / f"block-{index:03d}.json",
            "order": index,
        } for index in range(1, 4)]
        worker_settings = SimpleNamespace(
            agents_dir=self.agents_dir,
            repo_root=self.agents_dir,
            novel_analysis_parallel_workers=3,
            agent_worker_response_stall_seconds=600,
        )

        with (
            patch.object(agent_runner, "settings", worker_settings),
            patch.object(agent_runner.subprocess, "Popen", FinishedProcess),
            patch.object(agent_runner, "_tail_text", return_value="too many concurrent sessions"),
            patch.object(
                agent_runner,
                "extract_structured_worker_output",
                side_effect=[{"part": 2}, {"part": 3}, {"part": 1}],
            ),
            patch.object(agent_runner, "terminate_process_group"),
            patch.object(agent_runner.zdebug_manager, "register_worker_log"),
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "assert_job_execution_active"),
        ):
            result = agent_runner.run_parallel_novel_analysis_workers(
                self.conn,
                {"id": 63},
                self.workspace,
                requests=requests,
                timeout_event=threading.Event(),
            )

        self.assertEqual(FinishedProcess.created, 4)
        self.assertEqual(result, {"parallelism": 2, "completed": 3})
        for request in requests:
            self.assertTrue(request["output_file"].is_file())
        self.assertEqual(agent_runner.full_workers(63), [])

    def test_novel_analysis_stage_supplies_the_pipeline_with_a_batched_reader(self) -> None:
        self.write_workspace(task_type="novel")
        job = {"id": 63}
        prepared = {
            "source_index": {"source_file": "runtime/原始小说.md"},
            "adaptation_plan": {"target_episode_count": 10},
        }
        with patch.object(agent_runner, "prepare_novel_analysis_draft", return_value={"ok": True}) as pipeline:
            result = agent_runner.prepare_novel_analysis_stage(
                self.conn,
                job,
                self.workspace,
                "writer",
                prepared,
                threading.Event(),
                None,
            )

        self.assertEqual(result, {"ok": True})
        self.assertTrue(callable(pipeline.call_args.kwargs["run_model_batch"]))
        self.assertTrue(callable(pipeline.call_args.kwargs["run_model"]))

    def test_repeated_novel_reading_calls_keep_the_existing_background_task(self) -> None:
        token = agent_runner.register_novel_analysis_tool(
            job_id=65,
            workspace=self.workspace,
            username="writer",
            prepared={"ok": True},
            preference_context=None,
            timeout_event=threading.Event(),
        )

        class HoldingThread:
            instances = []

            def __init__(self, *, target, args, **_kwargs) -> None:
                self.target = target
                self.args = args
                self.started = False
                self.__class__.instances.append(self)

            def start(self) -> None:
                self.started = True

        with patch.object(agent_runner.threading, "Thread", HoldingThread):
            first = agent_runner.execute_novel_analysis_tool(token)
            second = agent_runner.execute_novel_analysis_tool(token)

        self.assertEqual(first, agent_runner.novel_analysis_tool_started_result())
        self.assertEqual(second, agent_runner.novel_analysis_tool_started_result())
        self.assertEqual(len(HoldingThread.instances), 1)
        self.assertTrue(HoldingThread.instances[0].started)

    def test_novel_reading_tool_only_returns_start_while_runner_receives_completion(self) -> None:
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, prompt, status, claude_session_id
            ) VALUES (64, 1, 9, 'novel_analysis', 'novel_analysis', '', 'running', 'novel-session')
            """
        )
        self.conn.commit()
        timeout_event = threading.Event()
        prepared = {"source_index": {"source_file": "runtime/原始小说.md"}}
        token = agent_runner.register_novel_analysis_tool(
            job_id=64,
            workspace=self.workspace,
            username="writer",
            prepared=prepared,
            preference_context=None,
            timeout_event=timeout_event,
        )

        class ImmediateThread:
            def __init__(self, *, target, args, **_kwargs) -> None:
                self.target = target
                self.args = args

            def start(self) -> None:
                self.target(*self.args)

        with (
            patch.object(agent_runner, "get_connection", return_value=self.conn),
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner.threading, "Thread", ImmediateThread),
            patch.object(
                agent_runner,
                "prepare_novel_analysis_stage",
                side_effect=[
                    agent_runner.AgentExecutionError(
                        "NOVEL_ANALYSIS_PREPARATION",
                        "runtime",
                        True,
                        "小说全文解读暂未完成。",
                    ),
                    {"ok": True},
                ],
            ) as prepare,
        ):
            started = agent_runner.execute_novel_analysis_tool(token)
            self.assertEqual(started["message"], "小说全文阅读已启动。")
            with self.assertRaises(agent_runner.AgentExecutionError):
                agent_runner.wait_for_novel_analysis_tool(
                    self.conn,
                    job_id=64,
                    token=token,
                    timeout_event=timeout_event,
                )
            retried = agent_runner.execute_novel_analysis_tool(token)
            first = agent_runner.wait_for_novel_analysis_tool(
                self.conn,
                job_id=64,
                token=token,
                timeout_event=timeout_event,
            )
            second = agent_runner.execute_novel_analysis_tool(token)

        self.assertEqual(retried["message"], "小说全文阅读已启动。")
        self.assertEqual(first, agent_runner.novel_analysis_tool_completed_result())
        self.assertEqual(second, agent_runner.novel_analysis_tool_started_result())
        self.assertEqual(first["ok"], True)
        self.assertEqual(prepare.call_count, 2)
        self.assertIs(prepare.call_args_list[1].args[4], prepared)

    def test_manual_outline_save_is_allowed_and_marks_document_sync_pending(self) -> None:
        outline_path = self.workspace / "output" / "剧本大纲.md"
        outline_path.write_text("# 剧本大纲\n\n旧故事\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["world_view"]["status"] = "completed"
        progress["stages"]["outline_rewrite"]["status"] = "completed"
        progress["stages"]["character_rewrite"]["status"] = "completed"
        progress["current_skill"] = "outline_rewrite"
        progress["next_skill"] = "character_rewrite"
        self.save_progress(progress)

        saved = workspace_service.write_stage_file(
            self.conn,
            self.project(),
            self.user,
            "outline_rewrite",
            "# 剧本大纲\n\n新故事\n",
        )

        current = self.progress()
        sync = current["stages"]["outline_rewrite"]["document_sync"]
        self.assertEqual(saved["memory"]["status"], "pending_sync")
        self.assertEqual(current["stages"]["outline_rewrite"]["status"], "completed")
        self.assertEqual(current["stages"]["character_rewrite"]["status"], "completed")
        self.assertEqual(current["current_skill"], "outline_rewrite")
        self.assertEqual(current["next_skill"], "character_rewrite")
        self.assertEqual(sync["status"], "pending")
        self.assertEqual(sync["status_before_sync"], "completed")
        self.assertEqual(sync["source_hash"], saved["content_hash"])
        self.assertIn("新故事", sync["changes"][-1]["added_samples"])
        files = workspace_service.files_for_project(self.project())
        outline = next(file for file in files if file["stage"] == "outline_rewrite")
        self.assertTrue(outline["document_sync_pending"])
        character_path = self.workspace / "output" / "角色小传.md"
        character_path.write_text("# 角色小传\n", encoding="utf-8")
        files = workspace_service.files_for_project(self.project())
        character = next(file for file in files if file["stage"] == "character_rewrite")
        self.assertTrue(character["clickable"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "character_rewrite"), ["character_rewrite"])

    def test_file_versions_can_be_viewed_and_restored_without_immediate_sync(self) -> None:
        outline_path = self.workspace / "output" / "剧本大纲.md"
        outline_path.write_text("# 剧本大纲\n\n第一版\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["outline_rewrite"]["status"] = "completed"
        progress["current_skill"] = "outline_rewrite"
        self.save_progress(progress)

        saved = workspace_service.write_stage_file(
            self.conn,
            self.project(),
            self.user,
            "outline_rewrite",
            "# 剧本大纲\n\n第二版\n",
        )
        history = workspace_service.list_file_versions(self.conn, self.project(), "outline_rewrite")

        self.assertEqual(len(history["versions"]), 2)
        self.assertTrue(history["versions"][0]["is_current"])
        self.assertEqual(history["versions"][0]["operation"], "manual_save")
        initial = history["versions"][-1]
        self.assertEqual(initial["operation"], "initial")
        self.assertTrue(initial["can_restore"])

        with patch.object(workspace_service, "sync_workspace_memory") as sync_memory:
            restored = workspace_service.restore_file_version(
                self.conn,
                self.project(),
                self.user,
                "outline_rewrite",
                initial["id"],
                saved["content_hash"],
            )

        sync_memory.assert_not_called()
        self.assertEqual(restored["content"], "# 剧本大纲\n\n第一版\n")
        self.assertEqual(restored["memory"]["status"], "pending_sync")
        self.assertEqual(self.progress()["stages"]["outline_rewrite"]["document_sync"]["status"], "pending")
        operations = [
            row["operation"]
            for row in self.conn.execute(
                "SELECT operation FROM file_versions WHERE project_id = 1 ORDER BY id"
            ).fetchall()
        ]
        self.assertEqual(operations, ["initial", "manual_save", "restore"])

    def test_file_versions_keep_only_ten_most_recent_snapshots_per_file(self) -> None:
        for version_number in range(1, 12):
            workspace_service.record_file_version(
                self.conn,
                project_id=1,
                stage="outline_rewrite",
                file_path="workspaces/demo/output/剧本大纲.md",
                edited_by=9,
                content=f"# 剧本大纲\n\n第{version_number}版\n",
                previous_content=f"# 剧本大纲\n\n第{version_number - 1}版\n",
                change_kind="substantive",
                change_summary=f"保存第{version_number}版",
                operation="manual_save",
            )
        workspace_service.record_file_version(
            self.conn,
            project_id=1,
            stage="trial_generate",
            file_path="workspaces/demo/output/剧本试稿.md",
            edited_by=9,
            content="# 剧本试稿\n\n独立版本\n",
            previous_content=None,
            change_kind="substantive",
            change_summary="保存试稿",
            operation="manual_save",
        )

        rows = self.conn.execute(
            """
            SELECT content_snapshot FROM file_versions
            WHERE project_id = 1 AND stage = 'outline_rewrite'
              AND content_snapshot IS NOT NULL
            ORDER BY id
            """
        ).fetchall()
        self.assertEqual(len(rows), 10)
        self.assertEqual(
            [row["content_snapshot"] for row in rows],
            [f"# 剧本大纲\n\n第{version_number}版\n" for version_number in range(2, 12)],
        )

        other_file_versions = self.conn.execute(
            "SELECT content_snapshot FROM file_versions WHERE project_id = 1 AND stage = 'trial_generate'"
        ).fetchall()
        self.assertEqual([row["content_snapshot"] for row in other_file_versions], ["# 剧本试稿\n\n独立版本\n"])

    def test_all_user_editable_documents_can_be_saved(self) -> None:
        documents = {
            "outline_rewrite": "output/剧本大纲.md",
            "character_rewrite": "output/角色小传.md",
            "trial_generate": "output/剧本试稿.md",
            "full_generate": "output/剧本全稿.md",
        }
        for stage, relative_path in documents.items():
            file_path = self.workspace / relative_path
            file_path.write_text("# 旧版\n", encoding="utf-8")
            saved = workspace_service.write_stage_file(
                self.conn,
                self.project(),
                self.user,
                stage,
                "# 新版\n",
            )
            self.assertEqual(saved["memory"]["status"], "pending_sync")
            self.assertEqual(self.progress()["stages"][stage]["document_sync"]["status"], "pending")

    def test_character_stage_projects_relationship_graph_for_display(self) -> None:
        (self.workspace / "output" / "角色小传.md").write_text("# 角色小传\n", encoding="utf-8")
        (self.workspace / "4.1-character.json").write_text(json.dumps([
            {
                "人物名称": "林夏",
                "身份": "调查者",
                "所属阵营": "真相追查者",
                "是否主角": True,
                "人物关系": [{"关联人物": "周沉", "关系": "合作调查者"}],
            },
            {
                "人物名称": "周沉",
                "身份": "证据持有人",
                "所属阵营": "真相追查者",
                "是否主角": False,
                "人物关系": [{"关联人物": "林夏", "关系": "被试探的盟友"}],
            },
        ], ensure_ascii=False), encoding="utf-8")

        document = workspace_service.read_stage_file(self.project(), "character_rewrite")

        graph = document["relationship_graph"]
        self.assertEqual(graph["protagonist"], "林夏")
        self.assertEqual(graph["characters"][0]["role_identity"], "调查者")
        self.assertEqual(graph["characters"][1]["faction"], "真相追查者")
        self.assertEqual(graph["relationships"], [{"source": "林夏", "target": "周沉", "label": "合作调查者"}])

    def test_pending_document_sync_scans_the_entire_project_without_running_validators(self) -> None:
        outline_path = self.workspace / "output" / "剧本大纲.md"
        full_path = self.workspace / "output" / "剧本全稿.md"
        outline_path.write_text("# 剧本大纲\n\n用户修改\n", encoding="utf-8")
        full_path.write_text("# 剧本全稿\n\n用户修改\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["outline_rewrite"] = {
            "status": "completed",
            "document_sync": {
                "status": "pending",
                "source_hash": "saved-hash",
                "status_before_sync": "completed",
                "changes": [{"summary": "用户修改了故事结局"}],
            },
        }
        progress["stages"]["full_generate"] = {
            "status": "completed",
            "document_sync": {
                "status": "pending",
                "source_hash": "saved-full-hash",
                "status_before_sync": "completed",
                "changes": [{"summary": "用户修改了结尾"}],
            },
        }
        self.save_progress(progress)
        job = {
            "id": 51,
            "project_id": 1,
            "user_id": 9,
            "claude_session_id": "sync-session",
        }

        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job) as writer,
            patch.object(agent_runner, "run_stage_script") as checker,
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            _, result = agent_runner.run_pending_document_sync(
                self.conn, job, self.project(), "writer", "character_rewrite", object()
            )

        self.assertEqual(result["synced_stages"], ["outline_rewrite", "full_generate"])
        self.assertIn("Use `document-sync` skill", writer.call_args.args[2])
        self.assertIn("故事梗概、完整剧本", writer.call_args.args[2])
        checker.assert_not_called()
        sync = self.progress()["stages"]["outline_rewrite"]["document_sync"]
        self.assertEqual(sync["status"], "synced")
        self.assertEqual(sync["sync_job_id"], "51")
        self.assertEqual(self.progress()["stages"]["full_generate"]["document_sync"]["status"], "synced")

    def test_full_document_sync_does_not_reopen_trial_confirmation_or_rewrite_trial(self) -> None:
        full_path = self.workspace / "output" / "剧本全稿.md"
        trial_path = self.workspace / "output" / "剧本试稿.md"
        full_path.write_text("# 剧本全稿\n\n## 第1集\n\n旧版\n", encoding="utf-8")
        trial_path.write_text("# 剧本试稿\n\n## 第1集\n\n旧版\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["trial_generate"]["status"] = "approved"
        progress["stages"]["full_generate"] = {
            "status": "needs_revision",
            "document_sync": {"status": "pending", "source_hash": "saved-hash", "changes": []},
        }
        self.save_progress(progress)
        job = {
            "id": 52,
            "project_id": 1,
            "user_id": 9,
            "claude_session_id": "sync-session",
        }

        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job),
            patch.object(agent_runner, "run_stage_script") as checker,
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            _, result = agent_runner.run_pending_document_sync(
                self.conn, job, self.project(), "writer", "foreign_review", object()
            )

        checker.assert_not_called()
        self.assertEqual(trial_path.read_text(encoding="utf-8"), "# 剧本试稿\n\n## 第1集\n\n旧版\n")
        self.assertEqual(self.progress()["stages"]["trial_generate"]["status"], "approved")
        self.assertEqual(self.progress()["stages"]["full_generate"]["status"], "completed")
        self.assertEqual(self.progress()["stages"]["full_generate"]["document_sync"]["status"], "synced")

    def test_review_syncs_a_saved_full_script_before_running_the_review(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'review', current_stage = 'full_generate' WHERE id = 1")
        self.write_workspace(task_type="review", statuses={"full_generate": "completed"})
        full_path = self.workspace / "output" / "剧本全稿.md"
        full_path.write_text("# 待审剧本\n\n用户刚保存的版本\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["full_generate"]["document_sync"] = {
            "status": "pending",
            "source_hash": "saved-hash",
            "status_before_sync": "completed",
        }
        self.save_progress(progress)
        job = {"id": 54, "project_id": 1, "user_id": 9, "claude_session_id": "sync-session"}

        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job) as writer,
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            _, result = agent_runner.run_pending_document_sync(
                self.conn, job, self.project(), "writer", "foreign_review", object()
            )

        self.assertEqual(result["synced_stages"], ["full_generate"])
        self.assertIn("完整剧本", writer.call_args.args[2])
        self.assertEqual(self.progress()["stages"]["full_generate"]["document_sync"]["status"], "synced")

    def test_historical_trial_sync_restores_approved_status_from_approval_record(self) -> None:
        trial_path = self.workspace / "output" / "剧本试稿.md"
        trial_path.write_text("# 剧本试稿\n\n## 第1集\n\n用户修订\n", encoding="utf-8")
        progress = self.progress()
        progress["current_skill"] = "full_generate"
        progress["next_skill"] = "foreign_review"
        progress["stages"]["trial_generate"] = {
            "status": "needs_revision",
            "document_sync": {"status": "pending", "source_hash": "saved-hash", "changes": []},
        }
        self.save_progress(progress)
        self.conn.execute(
            """
            INSERT INTO stage_approvals (project_id, stage, artifact_hash, approved_by)
            VALUES (?, ?, ?, ?)
            """,
            (1, "trial_generate", hashlib.sha256(trial_path.read_bytes()).hexdigest(), 9),
        )
        job = {"id": 53, "project_id": 1, "user_id": 9, "claude_session_id": "sync-session"}

        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            agent_runner.run_pending_document_sync(
                self.conn, job, self.project(), "writer", "full_generate", object()
            )

        current = self.progress()
        self.assertEqual(current["stages"]["trial_generate"]["status"], "approved")
        self.assertEqual(current["current_skill"], "full_generate")
        self.assertEqual(current["next_skill"], "foreign_review")

    def test_saved_trial_sync_auto_confirms_before_another_ai_operation(self) -> None:
        trial_path = self.workspace / "output" / "剧本试稿.md"
        trial_path.write_text("# 剧本试稿\n\n## 第1集\n\n用户修订\n", encoding="utf-8")
        progress = self.progress()
        progress["current_skill"] = "trial_generate"
        progress["next_skill"] = "full_generate"
        progress["stages"]["trial_generate"] = {
            "status": "awaiting_approval",
            "document_sync": {
                "status": "pending",
                "source_hash": "saved-hash",
                "status_before_sync": "awaiting_approval",
            },
        }
        self.save_progress(progress)
        job = {"id": 55, "project_id": 1, "user_id": 9, "claude_session_id": "sync-session"}

        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            _, result = agent_runner.run_pending_document_sync(
                self.conn, job, self.project(), "writer", "character_rewrite", object()
            )

        self.assertTrue(result["trial_auto_approved"])
        current = self.progress()
        self.assertEqual(current["stages"]["trial_generate"]["status"], "approved")
        self.assertEqual(current["stages"]["trial_generate"]["document_sync"]["status"], "synced")
        self.assertEqual(current["current_skill"], "trial_generate")
        self.assertEqual(current["next_skill"], "full_generate")

    def test_unsynced_pending_trial_auto_confirms_when_entering_full_generation(self) -> None:
        trial_path = self.workspace / "output" / "剧本试稿.md"
        trial_path.write_text("# 剧本试稿\n\n## 第1集\n\n用户修订\n", encoding="utf-8")
        progress = self.progress()
        progress["current_skill"] = "trial_generate"
        progress["next_skill"] = "full_generate"
        progress["stages"]["trial_generate"] = {
            "status": "pending",
            "document_sync": {
                "status": "pending",
                "source_hash": "saved-hash",
                "status_before_sync": "pending",
            },
        }
        self.save_progress(progress)
        job = {"id": 56, "project_id": 1, "user_id": 9, "claude_session_id": "sync-session"}

        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            _, result = agent_runner.run_pending_document_sync(
                self.conn,
                job,
                self.project(),
                "writer",
                "full_generate",
                object(),
            )

        self.assertTrue(result["trial_auto_approved"])
        current = self.progress()
        self.assertEqual(current["stages"]["trial_generate"]["status"], "approved")
        self.assertEqual(current["stages"]["trial_generate"]["document_sync"]["status"], "synced")
        self.assertEqual(agent_runner.planned_stages(self.project(), "full_generate"), ["full_generate"])
        approval_count = self.conn.execute(
            "SELECT COUNT(*) FROM stage_approvals WHERE project_id = ? AND stage = ?",
            (1, "trial_generate"),
        ).fetchone()[0]
        self.assertEqual(approval_count, 1)

    def test_pending_document_sync_allows_next_and_all_to_continue(self) -> None:
        progress = self.progress()
        for stage in ("world_view", "outline_rewrite", "character_rewrite"):
            progress["stages"][stage]["status"] = "completed"
        progress["current_skill"] = "trial_generate"
        progress["next_skill"] = "full_generate"
        progress["stages"]["trial_generate"] = {
            "status": "pending",
            "document_sync": {
                "status": "pending",
                "source_hash": "saved-hash",
                "status_before_sync": "pending",
            },
        }
        self.save_progress(progress)

        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["full_generate"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "all"), ["full_generate"])

        progress["stages"]["trial_generate"]["status"] = "awaiting_approval"
        self.save_progress(progress)
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["full_generate"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "all"), ["full_generate"])

    def test_document_sync_rejects_a_prompt_that_rewrites_user_markdown(self) -> None:
        outline_path = self.workspace / "output" / "剧本大纲.md"
        original = "# 剧本大纲\n\n用户保存的版本\n"
        outline_path.write_text(original, encoding="utf-8")
        progress = self.progress()
        progress["stages"]["outline_rewrite"] = {
            "status": "completed",
            "document_sync": {"status": "pending", "source_hash": "saved-hash", "status_before_sync": "completed"},
        }
        self.save_progress(progress)
        job = {"id": 54, "project_id": 1, "user_id": 9, "claude_session_id": "sync-session"}

        def rewrite_markdown(*_args, **_kwargs):
            outline_path.write_text("# 剧本大纲\n\n不应被同步覆盖\n", encoding="utf-8")
            return job

        with (
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_claude_prompt_with_recovery", side_effect=rewrite_markdown),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            with self.assertRaises(agent_runner.AgentExecutionError) as raised:
                agent_runner.run_pending_document_sync(
                    self.conn, job, self.project(), "writer", "outline_rewrite", object()
                )

        self.assertEqual(raised.exception.code, "WRITE_SCOPE_VIOLATION")
        self.assertEqual(outline_path.read_text(encoding="utf-8"), original)
        self.assertEqual(self.progress()["stages"]["outline_rewrite"]["document_sync"]["status"], "pending")

    def test_trial_approval_moves_to_full_generation_and_review_approval_allows_archive(self) -> None:
        trial_path = self.workspace / "output" / "剧本试稿.md"
        trial_path.write_text("# 剧本试稿\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["trial_generate"]["status"] = "awaiting_approval"
        progress["current_skill"] = "trial_generate"
        self.save_progress(progress)
        trial_hash = hashlib.sha256(trial_path.read_bytes()).hexdigest()

        def approve_trial(*_args, **_kwargs):
            current = self.progress()
            current["stages"]["trial_generate"]["status"] = "approved"
            current["current_skill"] = "trial_generate"
            current["next_skill"] = "full_generate"
            self.save_progress(current)
            return {
                "stage": "trial_generate",
                "status": "approved",
                "artifact_hash": trial_hash,
                "quality_contract_version": "agents-new-v1",
                "job_id": None,
                "memory": {"revision": None},
            }

        with patch.object(projects_router, "approve_new_stage", side_effect=approve_trial):
            response = projects_router.approve_project_stage(
                1, "trial_generate", StageApproval(expected_hash=trial_hash), self.conn, self.user
            )
        self.assertEqual(response["approval"]["status"], "approved")
        self.assertEqual(agent_runner.planned_stages(self.project(), "full_generate"), ["full_generate"])

        report_path = self.workspace / "output" / "审稿报告.md"
        report_path.write_text("# 审稿报告\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["foreign_review"]["status"] = "approved"
        progress["current_skill"] = "foreign_review"
        self.save_progress(progress)
        with patch("app.services.project_lifecycle_service.record_audit"):
            archived = archive_project(self.conn, project=self.project(), actor=self.user)
        self.assertEqual(archived["status"], "completed")

    def test_review_project_starts_from_the_uploaded_full_script(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'review', current_stage = 'full_generate' WHERE id = 1")
        self.write_workspace(task_type="review", statuses={"full_generate": "completed"})
        full_path = self.workspace / "output" / "剧本全稿.md"
        full_path.write_text("# 剧本全稿\n", encoding="utf-8")
        files = workspace_service.files_for_project(self.project())
        self.assertEqual([item["stage"] for item in files], ["full_generate", "foreign_review"])
        self.assertEqual([item["name"] for item in files], ["待审剧本", "审稿报告"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["foreign_review"])

    def test_review_project_can_regenerate_after_a_prior_negative_review(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'review', current_stage = 'outline_rewrite' WHERE id = 1")
        self.write_workspace(task_type="review", statuses={"full_generate": "pending", "foreign_review": "needs_revision"})
        (self.workspace / "output" / "剧本全稿.md").write_text("# 待审剧本\n", encoding="utf-8")

        self.assertEqual(agent_runner.planned_stages(self.project(), "foreign_review"), ["foreign_review"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["foreign_review"])

    def test_translate_project_only_runs_dialogue_translation(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'translate', current_stage = 'project_init' WHERE id = 1")
        self.write_workspace(task_type="translate")

        files = workspace_service.files_for_project(self.project())
        self.assertEqual([item["stage"] for item in files], ["project_init", "dialogue_translate"])
        self.assertEqual([item["name"] for item in files], ["原始剧本", "台词翻译"])
        self.assertEqual(files[1]["file_name"], "output/源剧本文件-台词译稿.md")
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["dialogue_translate"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "dialogue_translate"), ["dialogue_translate"])
        for stage in ("world_view", "full_generate", "foreign_review"):
            with self.assertRaises(Exception):
                agent_runner.planned_stages(self.project(), stage)

    def test_translate_project_can_archive_after_dialogue_translation(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'translate', current_stage = 'dialogue_translate' WHERE id = 1")
        self.write_workspace(task_type="translate", statuses={"dialogue_translate": "completed"})
        translation_path = self.workspace / "output" / "源剧本文件-台词译稿.md"
        translation_path.write_text("# 源剧本文件 - 台词译稿\n\n林夏：你好。  \n(Hello.)\n", encoding="utf-8")

        with patch("app.services.project_lifecycle_service.record_audit"):
            archived = archive_project(self.conn, project=self.project(), actor=self.user)

        self.assertEqual(archived["status"], "completed")
        self.assertEqual(archived["current_stage"], "dialogue_translate")
        self.assertEqual(self.progress()["current_skill"], "dialogue_translate")

    def test_humanize_project_only_runs_humanizer_and_can_archive(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'humanize', current_stage = 'project_init' WHERE id = 1")
        self.write_workspace(task_type="humanize")

        files = workspace_service.files_for_project(self.project())
        self.assertEqual([item["stage"] for item in files], ["project_init", "humanizer_zh"])
        self.assertEqual([item["name"] for item in files], ["原始剧本", "剧本润色"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "next"), ["humanizer_zh"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "all"), ["humanizer_zh"])
        self.assertEqual(agent_runner.planned_stages(self.project(), "humanizer_zh"), ["humanizer_zh"])
        with self.assertRaises(Exception):
            agent_runner.planned_stages(self.project(), "full_generate")

        prompt = agent_runner.stage_prompt("humanizer_zh", self.workspace, "writer", "", {})
        self.assertIn("Use `humanizer-zh` skill", prompt)
        self.assertIn("完成剧本润色输出", prompt)
        self.assertIn("用户额外要求：保留主角主动选择", prompt)

        self.conn.execute("UPDATE projects SET current_stage = 'humanizer_zh' WHERE id = 1")
        self.write_workspace(task_type="humanize", statuses={"humanizer_zh": "completed"})
        (self.workspace / "output" / "去AI味剧本.md").write_text("# 去AI味剧本\n", encoding="utf-8")
        with patch("app.services.project_lifecycle_service.record_audit"):
            archived = archive_project(self.conn, project=self.project(), actor=self.user)
        self.assertEqual(archived["status"], "completed")
        self.assertEqual(archived["current_stage"], "humanizer_zh")
        self.assertEqual(self.progress()["current_skill"], "humanizer_zh")

    def test_stage_prompt_keeps_context_inside_the_skill_contract(self) -> None:
        prompt = agent_runner.stage_prompt(
            "outline_rewrite", self.workspace, "writer", "加强中段反转", {}
        )
        self.assertIn("Use `outline_rewrite` skill", prompt)
        self.assertIn("工作区：", prompt)
        self.assertIn("用户额外要求：保留主角主动选择", prompt)
        self.assertIn("加强中段反转", prompt)
        self.assertEqual(prompt.count("Use `outline_rewrite` skill"), 1)
        self.assertNotIn("Generation Brief", prompt)
        self.assertNotIn("Canon", prompt)

    def test_outline_prompt_requires_an_english_title_for_non_domestic_projects(self) -> None:
        overseas_prompt = agent_runner.stage_prompt(
            "outline_rewrite", self.workspace, "writer", "", {}
        )
        self.assertIn("目标地区为北美", overseas_prompt)
        self.assertIn("英文剧本名称", overseas_prompt)
        self.assertIn("不得只写中文名称", overseas_prompt)

        input_path = self.workspace / "1.1-user-input.json"
        user_input = json.loads(input_path.read_text(encoding="utf-8"))
        user_input["project"]["target_region"] = "国内"
        input_path.write_text(json.dumps(user_input, ensure_ascii=False), encoding="utf-8")

        domestic_prompt = agent_runner.stage_prompt(
            "outline_rewrite", self.workspace, "writer", "", {}
        )
        self.assertIn("国内项目只填写中文剧本名称", domestic_prompt)
        self.assertIn("英文剧本名称`保持为空", domestic_prompt)

    def test_non_rewrite_outline_prompt_keeps_the_project_title(self) -> None:
        self.write_workspace(task_type="novel")

        prompt = agent_runner.stage_prompt(
            "outline_rewrite", self.workspace, "writer", "", {}
        )

        self.assertIn("当前不是剧本改写或爆款复刻场景", prompt)
        self.assertIn("剧本名称`必须保持为项目名称“测试项目”", prompt)
        self.assertIn("英文剧本名称`保持为空", prompt)
        self.assertNotIn("必须为改编后的剧本重新命名", prompt)

    def test_skill_prompts_omit_empty_initial_extra_requirements(self) -> None:
        input_path = self.workspace / "1.1-user-input.json"
        user_input = json.loads(input_path.read_text(encoding="utf-8"))
        user_input["project"]["extra_requirements"] = "  \n "
        input_path.write_text(json.dumps(user_input, ensure_ascii=False), encoding="utf-8")

        stage_prompt = agent_runner.stage_prompt(
            "outline_rewrite", self.workspace, "writer", "", {}
        )
        sync_prompt = agent_runner.document_sync_prompt(self.workspace, ["outline_rewrite"])

        self.assertNotIn("用户额外要求：", stage_prompt)
        self.assertNotIn("用户额外要求：", sync_prompt)

    def test_initial_extra_requirements_are_not_repeated_as_a_runtime_instruction(self) -> None:
        prompt = agent_runner.stage_prompt(
            "outline_rewrite", self.workspace, "writer", "保留主角主动选择", {}
        )
        sync_prompt = agent_runner.document_sync_prompt(self.workspace, ["outline_rewrite"])

        self.assertEqual(prompt.count("保留主角主动选择"), 1)
        self.assertNotIn("用户补充指令：", prompt)
        self.assertIn("用户额外要求：保留主角主动选择", sync_prompt)

    def test_generation_prompts_include_the_duration_derived_length_floor(self) -> None:
        prepared = {"minimum_episode_characters": 600}

        trial_prompt = agent_runner.stage_prompt(
            "trial_generate", self.workspace, "writer", "", prepared
        )
        full_prompt = agent_runner.stage_prompt(
            "full_generate", self.workspace, "writer", "", prepared
        )

        self.assertIn("每一集的字数不可少于600字", trial_prompt)
        self.assertIn("每一集的字数不可少于600字", full_prompt)

    def test_named_script_outputs_follow_the_outline_title(self) -> None:
        (self.workspace / "3.1-outline.json").write_text(
            json.dumps({"剧本名称": "星海 协议"}, ensure_ascii=False), encoding="utf-8"
        )

        self.assertEqual(
            workspace_service.stage_file_for_workspace(self.workspace, "outline_rewrite"),
            "output/星海-协议-故事梗概.md",
        )
        self.assertEqual(
            workspace_service.stage_file_for_workspace(self.workspace, "full_generate"),
            "output/星海-协议-剧本全稿.md",
        )

    def test_outline_title_confirmation_is_exposed_from_progress(self) -> None:
        outline = {"剧本名称": "星海协议", "英文剧本名称": "Starlit Protocol"}
        (self.workspace / "3.1-outline.json").write_text(
            json.dumps(outline, ensure_ascii=False), encoding="utf-8"
        )
        (self.workspace / "output" / "星海协议-故事梗概.md").write_text(
            "# 星海协议 - 故事梗概\n", encoding="utf-8"
        )
        progress = self.progress()
        progress["stages"]["outline_rewrite"] = {
            "status": "completed",
            "title_confirmation": {
                "status": "pending",
                "title": "星海协议",
                "english_title": "Starlit Protocol",
            },
        }
        self.save_progress(progress)

        pending_document = workspace_service.read_stage_file(self.project(), "outline_rewrite")
        self.assertEqual(pending_document["outline_title"], {
            "title": "星海协议",
            "english_title": "Starlit Protocol",
            "confirmed": False,
        })

        progress["stages"]["outline_rewrite"]["title_confirmation"]["status"] = "confirmed"
        self.save_progress(progress)

        confirmed_document = workspace_service.read_stage_file(self.project(), "outline_rewrite")
        self.assertTrue(confirmed_document["outline_title"]["confirmed"])

    def test_chat_edit_publishes_only_the_current_document_then_syncs_its_backend(self) -> None:
        outline_path = self.workspace / "output" / "剧本大纲.md"
        outline_path.write_text("# 剧本大纲\n\n旧版中段\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["world_view"]["status"] = "completed"
        progress["stages"]["outline_rewrite"]["status"] = "completed"
        progress["stages"]["character_rewrite"]["status"] = "completed"
        progress["current_skill"] = "outline_rewrite"
        progress["next_skill"] = "character_rewrite"
        self.save_progress(progress)
        job = {
            "id": 43,
            "user_id": 9,
            "project_id": 1,
            "target_stage": "outline_rewrite",
            "prompt": "加强中段关系反转",
            "claude_session_id": "outline-session",
        }

        def edit_candidate(*args, **_kwargs):
            prompt = args[2]
            if "本次唯一可写文件：" in prompt:
                candidate = self.workspace / "runtime" / "jobs" / "43" / "candidate" / "output" / "剧本大纲.md"
                candidate.write_text("# 剧本大纲\n\n调整后的中段关系反转\n", encoding="utf-8")
            return job

        with (
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "_run_new_workspace_tool", return_value={"ok": True}) as tool,
            patch.object(agent_runner, "refresh_project_from_progress") as refresh,
            patch.object(agent_runner, "run_claude_prompt_with_recovery", side_effect=edit_candidate) as writer,
            patch.object(agent_runner, "run_new_contract_stage") as rerun,
            patch.object(agent_runner, "run_stage_script") as stage_tool,
        ):
            agent_runner.run_new_contract_chat_edit_job(
                self.conn, job, self.project(), "writer", object()
            )

        self.assertEqual(tool.call_count, 1)
        self.assertEqual(tool.call_args.kwargs["script"], "update-stage-preferences.mjs")
        self.assertEqual(writer.call_count, 2)
        self.assertIn("本次唯一可写文件：", writer.call_args_list[0].args[2])
        self.assertIn("Use `document-sync` skill", writer.call_args_list[1].args[2])
        rerun.assert_not_called()
        stage_tool.assert_not_called()
        self.assertEqual(outline_path.read_text(encoding="utf-8"), "# 剧本大纲\n\n调整后的中段关系反转\n")
        current = self.progress()
        self.assertEqual(current["stages"]["outline_rewrite"]["document_sync"]["status"], "synced")
        self.assertEqual(current["stages"]["outline_rewrite"]["status"], "completed")
        self.assertEqual(current["stages"]["character_rewrite"]["status"], "completed")
        self.assertEqual(current["current_skill"], "outline_rewrite")
        self.assertEqual(current["next_skill"], "character_rewrite")
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM file_versions WHERE project_id = 1").fetchone()[0],
            2,
        )

    def test_full_script_chat_edit_runs_full_revision_skill_flow(self) -> None:
        full_path = self.workspace / "output" / "剧本全稿.md"
        full_path.write_text("# 剧本全稿\n\n## 第1集：开局\n\n旧内容\n", encoding="utf-8")
        job = {
            "id": 44,
            "user_id": 9,
            "project_id": 1,
            "stage": "chat_edit",
            "target_stage": "full_generate",
            "prompt": "根据审稿报告修改完整剧本",
            "claude_session_id": "full-stage-session",
        }

        with (
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "add_event"),
            patch.object(
                agent_runner,
                "run_pending_document_sync",
                return_value=(job, {"synced_stages": []}),
            ),
            patch.object(agent_runner, "_run_new_workspace_tool", return_value={"ok": True}) as tool,
            patch.object(agent_runner, "run_claude_stage") as stage_runner,
            patch.object(agent_runner, "run_claude_prompt_with_recovery") as direct_writer,
        ):
            agent_runner.run_new_contract_chat_edit_job(
                self.conn, job, self.project(), "writer", object()
            )

        tool.assert_called_once()
        stage_runner.assert_called_once_with(
            self.conn,
            job,
            self.project(),
            "writer",
            "full_generate",
            ANY,
            preference_context=None,
            preference_path=None,
        )
        direct_writer.assert_not_called()

    def test_full_generation_reuses_and_compacts_the_trial_authoring_session(self) -> None:
        full_job = {
            "id": 41,
            "user_id": 9,
            "project_id": 1,
            "prompt": "完成全稿",
            "claude_session_id": "full-session",
        }
        prepared_job = {**full_job, "authoring_session_id": "trial-session"}
        with (
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_stage_script", side_effect=[{"ok": True}, {"ok": True}]),
            patch.object(
                agent_runner,
                "prepare_stage_execution_strategy",
                return_value={
                    "execution_strategy_file": str(self.workspace / "runtime/full_generate/执行策略.md"),
                    "knowledge_status": "loaded",
                    "principle_count": 1,
                    "formula_count": 1,
                },
            ),
            patch.object(agent_runner, "stage_prompt", return_value="Use `full_generate` skill"),
            patch.object(agent_runner, "prepare_full_authoring_session", return_value=prepared_job) as prepare,
            patch.object(agent_runner, "compact_full_authoring_session") as compact,
            patch.object(agent_runner, "run_full_worker") as worker,
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            agent_runner.run_new_contract_stage(
                self.conn, full_job, self.project(), "writer", "full_generate", object()
            )
        prepare.assert_called_once()
        compact.assert_called_once()
        self.assertTrue(worker.call_args.kwargs["allow_stage_skill"])

    def test_p0_revision_reuses_the_latest_full_authoring_session(self) -> None:
        self.conn.executemany(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, prompt, status,
                claude_session_id, authoring_session_id, authoring_session_origin,
                optimization_scope
            ) VALUES (?, 1, 9, 'full_generate', 'full_generate', '', ?, ?, ?, ?, ?)
            """,
            [
                (70, "succeeded", "older-full-session", "older-authoring-session", "trial_generate", None),
                (71, "succeeded", "latest-full-session", "latest-authoring-session", "full_generate", None),
                (72, "running", "p0-stage-session", None, None, "review_p0"),
                (73, "running", "p0-stage-session-2", None, None, "review_p0"),
            ],
        )
        self.conn.commit()

        with (
            patch.object(agent_runner, "session_transcript_path", return_value=Path("session.jsonl")),
            patch.object(agent_runner, "add_event"),
        ):
            first = agent_runner.prepare_full_revision_authoring_session(
                self.conn,
                self.conn.execute("SELECT * FROM agent_jobs WHERE id = 72").fetchone(),
            )
            second = agent_runner.prepare_full_revision_authoring_session(
                self.conn,
                self.conn.execute("SELECT * FROM agent_jobs WHERE id = 73").fetchone(),
            )

        self.assertEqual(first["authoring_session_id"], "latest-authoring-session")
        self.assertEqual(first["authoring_session_origin"], "full_generate")
        self.assertEqual(second["authoring_session_id"], "latest-authoring-session")
        self.assertEqual(second["authoring_session_origin"], "full_generate")

    def test_full_revision_reuses_the_session_that_last_changed_the_full_script(self) -> None:
        self.conn.executemany(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, prompt, status,
                claude_session_id, authoring_session_id, authoring_session_origin,
                optimization_scope
            ) VALUES (?, 1, 9, ?, 'full_generate', '', ?, ?, ?, ?, ?)
            """,
            [
                (70, "full_generate", "succeeded", "initial-full-session", "initial-authoring-session", "trial_generate", None),
                (71, "full_generate", "succeeded", "latest-review-revision-session", None, None, "review_p0"),
                (72, "chat_edit", "running", "stage-session", None, None, None),
            ],
        )
        self.conn.commit()

        with (
            patch.object(agent_runner, "session_transcript_path", return_value=Path("session.jsonl")),
            patch.object(agent_runner, "add_event"),
        ):
            prepared = agent_runner.prepare_full_revision_authoring_session(
                self.conn,
                self.conn.execute("SELECT * FROM agent_jobs WHERE id = 72").fetchone(),
            )

        self.assertEqual(prepared["authoring_session_id"], "latest-review-revision-session")
        self.assertEqual(prepared["authoring_session_origin"], "full_generate")

    def test_p0_revision_uses_targeted_edit_without_running_full_skill_sop(self) -> None:
        full_path = self.workspace / "output" / "剧本全稿.md"
        full_path.write_text("# 剧本全稿\n\n## 第1集：开局\n\n旧内容\n", encoding="utf-8")
        full_job = {
            "id": 43,
            "user_id": 9,
            "project_id": 1,
            "stage": "full_generate",
            "target_stage": "full_generate",
            "prompt": "旧的完整剧本阶段提示词",
            "claude_session_id": "p0-stage-session",
            "authoring_session_id": "",
            "authoring_session_origin": "",
            "optimization_scope": "review_p0",
        }
        prepared_job = {
            **full_job,
            "authoring_session_id": "full-authoring-session",
            "authoring_session_origin": "full_generate",
        }
        p0_context = {
            "scope": "review_p0",
            "issue_titles": ["关键对白缺少回应"],
            "issues": [{
                "问题": "关键对白缺少回应",
                "修改动作": "补充主角的直接回应。",
                "验收条件": "该场完成问答闭环。",
            }],
        }

        def edit_full_script(*_args, **_kwargs) -> dict:
            full_path.write_text(
                "# 剧本全稿\n\n## 第1集：开局\n\n调整后的回应\n",
                encoding="utf-8",
            )
            return {"ok": True}

        with (
            patch.object(agent_runner, "review_p0_optimization_context", return_value=p0_context),
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(
                agent_runner,
                "run_stage_script",
                side_effect=[
                    {
                        "ok": True,
                        "generation_mode": "full_revision",
                        "execution_spec_file": str(self.workspace / "runtime/jobs/43/full_generate/执行规范.md"),
                    },
                    {"ok": True},
                ],
            ) as stage_script,
            patch.object(
                agent_runner,
                "prepare_stage_execution_strategy",
                return_value={
                    "execution_strategy_file": str(self.workspace / "runtime/jobs/43/full_generate/执行策略.md"),
                    "knowledge_status": "loaded",
                },
            ) as prepare_strategy,
            patch.object(agent_runner, "resolve_automatic_script_profile") as resolve_profile,
            patch.object(agent_runner, "stage_prompt") as normal_stage_prompt,
            patch.object(
                agent_runner,
                "prepare_full_revision_authoring_session",
                return_value=prepared_job,
            ) as prepare_revision,
            patch.object(agent_runner, "prepare_full_authoring_session") as prepare_initial,
            patch.object(agent_runner, "compact_full_authoring_session") as compact,
            patch.object(agent_runner, "run_full_worker", side_effect=edit_full_script) as worker,
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "refresh_project_from_progress"),
            patch.object(agent_runner, "record_file_version"),
            patch.object(agent_runner, "record_generated_document_audit"),
            patch.object(agent_runner, "create_system_revision_comments", return_value=[]),
        ):
            agent_runner.run_new_contract_stage(
                self.conn, full_job, self.project(), "writer", "full_generate", object()
            )

        normal_stage_prompt.assert_not_called()
        self.assertEqual(stage_script.call_count, 2)
        self.assertEqual([call.args[5] for call in stage_script.call_args_list], ["init", "validate"])
        prepare_strategy.assert_called_once()
        resolve_profile.assert_not_called()
        prepare_revision.assert_called_once()
        prepare_initial.assert_not_called()
        compact.assert_not_called()
        self.assertEqual(worker.call_count, 1)
        self.assertEqual(worker.call_args.args[4], "full-p0-revision")
        self.assertFalse(worker.call_args.kwargs["allow_stage_skill"])
        self.assertTrue(worker.call_args.kwargs["edit_only"])
        self.assertIn("当前完整剧本创作会话的后续修改任务", worker.call_args.args[3])
        self.assertIn("以当前文件为准", worker.call_args.args[3])
        self.assertIn("不要调用或重新执行 `full_generate` skill 的 SOP", worker.call_args.args[3])
        self.assertNotIn("Use `full_generate` skill，完成剧本全稿输出。", worker.call_args.args[3])

    def test_execution_contract_validation_is_runtime_failure(self) -> None:
        contract_error = agent_runner.stage_validation_error(
            "full_generate",
            "validate",
            ["剧本全稿执行规范缺失或已失效，请重新调用“初始化剧本全稿”"],
            "validator output",
        )
        content_error = agent_runner.stage_validation_error(
            "full_generate",
            "validate",
            ["第 3 集至少需要一个场景标题"],
            "validator output",
        )

        self.assertEqual(contract_error.code, "STAGE_EXECUTION_CONTRACT")
        self.assertEqual(contract_error.category, "runtime")
        self.assertEqual(content_error.code, "QUALITY_GATE")
        self.assertEqual(content_error.category, "quality")

    def test_p0_revision_rejects_writes_outside_the_full_script(self) -> None:
        full_path = self.workspace / "output" / "剧本全稿.md"
        review_path = self.workspace / "output" / "审稿报告.md"
        full_path.write_text("# 剧本全稿\n\n## 第1集：开局\n\n旧内容\n", encoding="utf-8")
        review_path.write_text("# 审稿报告\n\n原报告\n", encoding="utf-8")
        full_job = {
            "id": 44,
            "user_id": 9,
            "project_id": 1,
            "stage": "full_generate",
            "target_stage": "full_generate",
            "prompt": "",
            "claude_session_id": "p0-stage-session",
            "authoring_session_id": "",
            "authoring_session_origin": "",
            "optimization_scope": "review_p0",
        }
        p0_context = {
            "scope": "review_p0",
            "issue_titles": ["关键对白缺少回应"],
            "issues": [{
                "问题": "关键对白缺少回应",
                "修改动作": "补充主角的直接回应。",
                "验收条件": "该场完成问答闭环。",
            }],
        }

        def write_outside_scope(*_args, **_kwargs) -> dict:
            full_path.write_text("# 剧本全稿\n\n## 第1集：开局\n\n调整后\n", encoding="utf-8")
            review_path.write_text("# 被越权修改的审稿报告\n", encoding="utf-8")
            return {"ok": True}

        with (
            patch.object(agent_runner, "review_p0_optimization_context", return_value=p0_context),
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(
                agent_runner,
                "run_stage_script",
                return_value={"ok": True, "generation_mode": "full_revision"},
            ),
            patch.object(
                agent_runner,
                "prepare_stage_execution_strategy",
                return_value={
                    "execution_strategy_file": str(self.workspace / "runtime/jobs/44/full_generate/执行策略.md"),
                    "knowledge_status": "loaded",
                },
            ),
            patch.object(
                agent_runner,
                "prepare_full_revision_authoring_session",
                return_value={**full_job, "authoring_session_id": "full-authoring-session"},
            ),
            patch.object(agent_runner, "run_full_worker", side_effect=write_outside_scope),
            patch.object(agent_runner, "refresh_project_from_progress"),
            self.assertRaisesRegex(agent_runner.AgentExecutionError, "未授权"),
        ):
            agent_runner.run_new_contract_stage(
                self.conn, full_job, self.project(), "writer", "full_generate", object()
            )

        self.assertEqual(full_path.read_text(encoding="utf-8"), "# 剧本全稿\n\n## 第1集：开局\n\n旧内容\n")
        self.assertEqual(review_path.read_text(encoding="utf-8"), "# 审稿报告\n\n原报告\n")

    def test_completed_full_generation_reuses_latest_full_authoring_session(self) -> None:
        full_job = {
            "id": 42,
            "user_id": 9,
            "project_id": 1,
            "prompt": "按审稿报告返修完整剧本",
            "claude_session_id": "full-revision-session",
        }
        with (
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(
                agent_runner,
                "run_stage_script",
                side_effect=[{"ok": True, "generation_mode": "full_revision"}, {"ok": True}],
            ),
            patch.object(
                agent_runner,
                "prepare_stage_execution_strategy",
                return_value={
                    "execution_strategy_file": str(self.workspace / "runtime/full_generate/执行策略.md"),
                    "knowledge_status": "loaded",
                    "principle_count": 1,
                    "formula_count": 1,
                },
            ),
            patch.object(agent_runner, "stage_prompt", return_value="Use `full_generate` skill"),
            patch.object(
                agent_runner,
                "prepare_full_revision_authoring_session",
                return_value={**full_job, "authoring_session_id": "latest-full-authoring-session"},
            ) as prepare_revision,
            patch.object(agent_runner, "prepare_full_authoring_session") as prepare,
            patch.object(agent_runner, "compact_full_authoring_session") as compact,
            patch.object(agent_runner, "run_full_worker") as worker,
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            agent_runner.run_new_contract_stage(
                self.conn, full_job, self.project(), "writer", "full_generate", object()
            )

        prepare.assert_not_called()
        prepare_revision.assert_called_once()
        compact.assert_not_called()
        self.assertEqual(worker.call_args.args[4], "full-revision")
        self.assertTrue(worker.call_args.kwargs["allow_stage_skill"])

    def test_quality_repair_prompt_routes_the_skill_to_repair_flow(self) -> None:
        full_job = {
            "id": 43,
            "user_id": 9,
            "project_id": 1,
            "prompt": "",
            "claude_session_id": "full-generation-session",
            "authoring_session_id": "",
        }
        quality_error = agent_runner.AgentExecutionError(
            "QUALITY_GATE",
            "quality",
            False,
            "第 21 集缺少场景标题",
        )
        with (
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(
                agent_runner,
                "run_stage_script",
                side_effect=[
                    {"ok": True, "generation_mode": "trial_continuation"},
                    quality_error,
                    {"ok": True},
                ],
            ),
            patch.object(
                agent_runner,
                "prepare_stage_execution_strategy",
                return_value={
                    "execution_strategy_file": str(self.workspace / "runtime/full_generate/执行策略.md"),
                    "knowledge_status": "loaded",
                    "principle_count": 1,
                    "formula_count": 1,
                },
            ),
            patch.object(
                agent_runner,
                "stage_prompt",
                return_value="Use `full_generate` skill\n执行场景：首次生成。",
            ),
            patch.object(agent_runner, "prepare_full_authoring_session", return_value=full_job),
            patch.object(agent_runner, "compact_full_authoring_session"),
            patch.object(agent_runner, "run_full_worker") as worker,
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            agent_runner.run_new_contract_stage(
                self.conn, full_job, self.project(), "writer", "full_generate", object()
            )

        self.assertEqual(worker.call_count, 2)
        repair_call = worker.call_args_list[1]
        self.assertEqual(repair_call.args[4], "full-generate-repair")
        self.assertIn("执行场景：修复生成结果", repair_call.args[3])
        self.assertNotIn("执行场景：首次生成", repair_call.args[3])
        self.assertIn("请按 Skill 的快速开始", repair_call.args[3])

    def test_public_review_scorecard_hides_internal_scores(self) -> None:
        projection = workspace_service.public_review_scorecard({
            "审稿信息": {"剧本文件": "output/剧本全稿.md", "目标市场": "美国", "目标语": "en-US"},
            "总体结论": {"结论": "返修", "评级": "B+", "总分": 76.5, "一句话判断": "主线成立但前段承诺不足。"},
            "剧本信息": {"剧本名称": "测试剧", "题材": ["情感"]},
            "六维分析": [{"维度": "故事结构与逻辑", "评级": "B", "分数": 74, "权重": 30, "判断": "主线需要继续加压。"}],
            "风险与复核": [],
            "P0问题": [{"问题": "开场承诺不足"}],
        })
        self.assertEqual(projection["overall"], {"grade": "B+"})
        self.assertEqual(projection["dimensions"][0]["grade"], "B")
        self.assertNotIn("score", json.dumps(projection, ensure_ascii=False))
        self.assertNotIn("weight", json.dumps(projection, ensure_ascii=False))
        self.assertEqual(projection["p0_issue_count"], 1)

    def test_recorded_foreign_review_decision_skips_duplicate_validation(self) -> None:
        full_path = self.workspace / "output" / "剧本全稿.md"
        scorecard_path = self.workspace / "review-scorecard.json"
        scoring_path = self.workspace / "runtime" / "review-scoring.json"
        report_path = self.workspace / "output" / "审稿报告.md"
        full_path.write_text("# 剧本全稿\n", encoding="utf-8")
        scorecard_path.write_text('{"结论":"返修"}\n', encoding="utf-8")
        scoring_path.parent.mkdir(parents=True, exist_ok=True)
        scoring_path.write_text('{"内部评分":"已完成"}\n', encoding="utf-8")
        report_path.write_text("# 审稿报告\n", encoding="utf-8")
        progress = self.progress()
        progress["stages"]["full_generate"]["status"] = "completed"
        progress["stages"]["foreign_review"] = {
            "status": "completed",
            "review_decision": {
                "outcome": "revision_requested",
                "verdict": "返修",
                "revision_stage": "full_generate",
                "reason": "海外审稿结论：返修；主线需要继续加压。",
                "artifact_hashes": {
                    "output/剧本全稿.md": hashlib.sha256(full_path.read_bytes()).hexdigest(),
                    "review-scorecard.json": hashlib.sha256(scorecard_path.read_bytes()).hexdigest(),
                    "runtime/review-scoring.json": hashlib.sha256(scoring_path.read_bytes()).hexdigest(),
                    "output/审稿报告.md": hashlib.sha256(report_path.read_bytes()).hexdigest(),
                },
            },
        }
        self.save_progress(progress)
        job = {
            "id": 44,
            "user_id": 9,
            "project_id": 1,
            "prompt": "完成海外审稿",
            "claude_session_id": "review-session",
        }

        with (
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_stage_script", return_value={"ok": True}) as stage_tool,
            patch.object(agent_runner, "stage_prompt", return_value="Use `foreign_review` skill"),
            patch.object(agent_runner, "run_claude_prompt_with_recovery", return_value=job),
            patch.object(agent_runner, "assert_job_execution_active"),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            agent_runner.run_new_contract_stage(
                self.conn, job, self.project(), "writer", "foreign_review", object()
            )

        self.assertEqual(stage_tool.call_count, 1)
        self.assertEqual(stage_tool.call_args.args[5], "init")

    def test_foreign_review_quality_failure_still_requires_repair(self) -> None:
        progress = self.progress()
        progress["stages"]["full_generate"]["status"] = "completed"
        progress["stages"]["foreign_review"] = {"status": "in_progress"}
        self.save_progress(progress)

        agent_runner.mark_stage_execution_failed(
            self.conn,
            project=self.project(),
            username="writer",
            stage="foreign_review",
            job_id=45,
            error=agent_runner.AgentExecutionError(
                "QUALITY_GATE",
                "quality",
                False,
                "审稿报告未通过检查：报告缺少固定的最终结论章节。",
            ),
        )

        updated = self.progress()
        self.assertEqual(updated["stages"]["full_generate"]["status"], "completed")
        self.assertEqual(updated["stages"]["foreign_review"]["status"], "needs_revision")
        self.assertFalse(updated["stages"]["foreign_review"]["quality_check"]["passed"])
        self.assertIn("最终结论章节", updated["stages"]["foreign_review"]["quality_check"]["warnings"][0])

    def test_failed_new_stage_restores_the_last_delivery(self) -> None:
        world_view_path = self.workspace / "2.1-world-view.json"
        world_view_path.write_text('{"世界观描述":"旧版本","关键概念映射":[]}\n', encoding="utf-8")
        job = {
            "id": 42,
            "user_id": 9,
            "project_id": 1,
            "prompt": "生成世界观",
            "claude_session_id": "world-session",
        }

        def fail_after_write(*_args, **_kwargs):
            world_view_path.write_text('{"世界观描述":"半成品","关键概念映射":[]}\n', encoding="utf-8")
            raise agent_runner.AgentExecutionError("QUALITY_GATE", "quality", False, "世界观检查未通过")

        with (
            patch.object(agent_runner, "mark_stage_in_progress"),
            patch.object(agent_runner, "add_event"),
            patch.object(agent_runner, "run_stage_script", side_effect=fail_after_write),
            patch.object(agent_runner, "record_rejected_delivery"),
            patch.object(agent_runner, "refresh_project_from_progress"),
        ):
            with self.assertRaises(agent_runner.AgentExecutionError):
                agent_runner.run_new_contract_stage(
                    self.conn, job, self.project(), "writer", "world_view", object()
                )
        self.assertIn("旧版本", world_view_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
