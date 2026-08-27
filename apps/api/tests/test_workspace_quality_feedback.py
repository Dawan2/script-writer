import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import workspace_service


class WorkspaceQualityFeedbackTest(unittest.TestCase):
    def test_file_list_exposes_actionable_quality_feedback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            (workspace / "02-故事梗概.md").write_text("# 故事梗概\n", encoding="utf-8")
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("CREATE TABLE projects (workspace_dir TEXT, task_type TEXT)")
            conn.execute("INSERT INTO projects VALUES ('workspaces/demo', 'rewrite')")
            project = conn.execute("SELECT * FROM projects").fetchone()
            progress = {
                "current_stage": "outline_rewrite",
                "stages": {
                    "outline_rewrite": {
                        "status": "needs_revision",
                        "updated_at": "2026-07-14T08:27:04.238Z",
                        "quality_check": {
                            "passed": False,
                            "warnings": ["人物栏使用了目标语姓名"],
                        },
                        "next_action": "重新运行 finalize",
                    }
                },
            }

            with (
                patch.object(workspace_service, "load_progress", return_value=progress),
                patch.object(workspace_service, "resolve_workspace", return_value=workspace),
            ):
                files = workspace_service.files_for_project(project)

            outline = next(file for file in files if file["stage"] == "outline_rewrite")
            self.assertFalse(outline["quality_passed"])
            self.assertEqual(outline["quality_warnings"], ["人物栏使用了目标语姓名"])
            self.assertIn("下一步", outline["next_action"])
            self.assertNotIn("finalize", outline["next_action"])
            conn.close()

    def test_full_script_pending_recheck_keeps_its_specific_next_action(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            (workspace / "99-剧本稿.md").write_text("# 剧本稿\n", encoding="utf-8")
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("CREATE TABLE projects (workspace_dir TEXT, task_type TEXT)")
            conn.execute("INSERT INTO projects VALUES ('workspaces/demo', 'rewrite')")
            project = conn.execute("SELECT * FROM projects").fetchone()
            progress = {
                "current_stage": "full_generate",
                "stages": {
                    "full_generate": {
                        "status": "needs_revision",
                        "quality_check": {"passed": False, "warnings": ["第53集需要补写。"]},
                        "next_action": "完整剧本已保留。请手动补充问题集，或选择 AI 修复；修复后会重新完成完整检查。",
                    },
                },
            }

            with (
                patch.object(workspace_service, "load_progress", return_value=progress),
                patch.object(workspace_service, "resolve_workspace", return_value=workspace),
            ):
                files = workspace_service.files_for_project(project)

            full_script = next(file for file in files if file["stage"] == "full_generate")
            self.assertEqual(full_script["next_action"], progress["stages"]["full_generate"]["next_action"])
            conn.close()

    def test_file_list_exposes_review_decision_without_changing_script_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            full_path = workspace / workspace_service.stage_file_for_workspace(workspace, "full_generate")
            review_path = workspace / workspace_service.stage_file_for_workspace(workspace, "foreign_review")
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text("# 剧本全稿\n", encoding="utf-8")
            review_path.write_text("# 审稿报告\n", encoding="utf-8")
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("CREATE TABLE projects (workspace_dir TEXT, task_type TEXT)")
            conn.execute("INSERT INTO projects VALUES ('workspaces/demo', 'rewrite')")
            project = conn.execute("SELECT * FROM projects").fetchone()
            progress = {
                "current_skill": "foreign_review",
                "stages": {
                    "full_generate": {
                        "status": "completed",
                        "quality_check": {"passed": True, "warnings": []},
                    },
                    "foreign_review": {
                        "status": "completed",
                        "quality_check": {"passed": True, "warnings": []},
                        "review_decision": {
                            "outcome": "revision_requested",
                            "verdict": "返修",
                            "revision_stage": "full_generate",
                            "reason": "海外审稿结论：返修；终局主线尚未完成结算。",
                        },
                    },
                },
            }

            with (
                patch.object(workspace_service, "load_progress", return_value=progress),
                patch.object(workspace_service, "resolve_workspace", return_value=workspace),
            ):
                files = workspace_service.files_for_project(project)

            full_script = next(file for file in files if file["stage"] == "full_generate")
            review = next(file for file in files if file["stage"] == "foreign_review")
            self.assertEqual(full_script["status"], "completed")
            self.assertTrue(full_script["quality_passed"])
            self.assertEqual(full_script["quality_warnings"], [])
            self.assertIsNone(full_script["review_decision"])
            self.assertEqual(review["status"], "completed")
            self.assertEqual(review["review_decision"]["outcome"], "revision_requested")
            self.assertEqual(review["review_decision"]["revision_stage"], "full_generate")
            self.assertEqual(
                review["next_action"],
                "海外审稿建议调整相关内容。请查看审稿报告，并在对应文件中手动重新生成；调整完成后重新生成审稿报告。",
            )
            conn.close()

    def test_file_list_keeps_merged_trial_after_full_script_completed(self) -> None:
        for task_type in ("rewrite", "novel", "replicate"):
            with self.subTest(task_type=task_type), tempfile.TemporaryDirectory() as temp_dir:
                workspace = Path(temp_dir)
                full_path = workspace / workspace_service.stage_file_for_workspace(workspace, "full_generate")
                trial_path = workspace / workspace_service.stage_file_for_workspace(workspace, "trial_generate")
                full_path.parent.mkdir(parents=True, exist_ok=True)
                full_path.write_text("# 剧本全稿\n\n## 第1集\n", encoding="utf-8")
                trial_path.write_text("# 剧本试稿\n\n## 第1集\n", encoding="utf-8")
                conn = sqlite3.connect(":memory:")
                conn.row_factory = sqlite3.Row
                conn.execute("CREATE TABLE projects (workspace_dir TEXT, task_type TEXT)")
                conn.execute("INSERT INTO projects VALUES ('workspaces/demo', ?)", (task_type,))
                project = conn.execute("SELECT * FROM projects").fetchone()
                progress = {
                    "current_skill": "full_generate",
                    "stages": {
                        "trial_generate": {"status": "approved"},
                        "full_generate": {"status": "completed", "completed_once": True},
                    },
                }

                with (
                    patch.object(workspace_service, "load_progress", return_value=progress),
                    patch.object(workspace_service, "resolve_workspace", return_value=workspace),
                ):
                    files = workspace_service.files_for_project(project)

                trial = next(file for file in files if file["stage"] == "trial_generate")
                self.assertFalse(trial["clickable"])
                self.assertTrue(trial["merged_into_full_script"])
                self.assertIn("full_generate", [file["stage"] for file in files])
                conn.close()

    def test_foreign_review_format_failure_remains_a_quality_problem(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            file_name = workspace_service.stage_file_for_workspace(workspace, "foreign_review")
            output_path = workspace / file_name
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text("# 审稿报告\n", encoding="utf-8")
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("CREATE TABLE projects (workspace_dir TEXT, task_type TEXT)")
            conn.execute("INSERT INTO projects VALUES ('workspaces/demo', 'rewrite')")
            project = conn.execute("SELECT * FROM projects").fetchone()
            progress = {
                "current_skill": "foreign_review",
                "stages": {
                    "foreign_review": {
                        "status": "needs_revision",
                        "quality_check": {"passed": False, "warnings": ["报告缺少固定的最终结论章节。"]},
                    },
                },
            }

            with (
                patch.object(workspace_service, "load_progress", return_value=progress),
                patch.object(workspace_service, "resolve_workspace", return_value=workspace),
            ):
                files = workspace_service.files_for_project(project)

            review = next(file for file in files if file["stage"] == "foreign_review")
            self.assertFalse(review["quality_passed"])
            self.assertEqual(review["quality_warnings"], ["报告缺少固定的最终结论章节。"])
            self.assertIsNone(review["review_decision"])
            self.assertIn("上述问题", review["next_action"])
            conn.close()

    def test_legacy_review_route_is_migrated_without_leaving_script_in_revision_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            full_path = workspace / workspace_service.stage_file_for_workspace(workspace, "full_generate")
            review_path = workspace / workspace_service.stage_file_for_workspace(workspace, "foreign_review")
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text("# 剧本全稿\n", encoding="utf-8")
            review_path.write_text("# 审稿报告\n", encoding="utf-8")
            progress = {
                "current_skill": "full_generate",
                "next_skill": "full_generate",
                "stages": {
                    "full_generate": {
                        "status": "needs_revision",
                        "revision_reason": "海外审稿结论：返修；终局主线尚未完成结算。",
                        "quality_check": {"passed": True, "warnings": []},
                    },
                    "foreign_review": {
                        "status": "pending",
                        "invalidated_by": "full_generate",
                        "revision_route_validation": {
                            "outcome": "revision_routed",
                            "verdict": "返修",
                            "revision_stage": "full_generate",
                            "artifact_hashes": {},
                        },
                    },
                },
            }

            self.assertTrue(workspace_service._migrate_legacy_foreign_review_route(workspace, progress))
            self.assertEqual(progress["stages"]["full_generate"]["status"], "completed")
            self.assertNotIn("revision_reason", progress["stages"]["full_generate"])
            self.assertEqual(progress["stages"]["foreign_review"]["status"], "completed")
            self.assertEqual(progress["stages"]["foreign_review"]["review_decision"]["outcome"], "revision_requested")
            self.assertNotIn("revision_route_validation", progress["stages"]["foreign_review"])


if __name__ == "__main__":
    unittest.main()
