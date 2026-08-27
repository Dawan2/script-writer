import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.services import workspace_service


class FullScriptDeliveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.agents_dir = self.root / "Agents"
        self.workspace = self.agents_dir / "workspaces" / "demo"
        (self.workspace / "output").mkdir(parents=True)
        self.settings_patch = patch.object(
            workspace_service,
            "settings",
            SimpleNamespace(agents_dir=self.agents_dir, workspaces_dir=self.agents_dir / "workspaces"),
        )
        self.settings_patch.start()

        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                workspace_dir TEXT NOT NULL,
                target_region TEXT,
                task_type TEXT NOT NULL,
                current_stage TEXT NOT NULL
            )
            """
        )
        self.conn.execute(
            "INSERT INTO projects (id, name, workspace_dir, target_region, task_type, current_stage) VALUES (1, '原项目名', 'workspaces/demo', '北美', 'rewrite', 'full_generate')"
        )
        self.write_workspace()

    def tearDown(self) -> None:
        self.conn.close()
        self.settings_patch.stop()
        self.temp_dir.cleanup()

    def project(self):
        return self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()

    def write_json(self, name: str, payload: object) -> None:
        path = self.workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def write_workspace(
        self,
        *,
        full_status: str = "completed",
        trial_status: str = "awaiting_approval",
        quality_passed: bool = True,
    ) -> None:
        brief = {
            "status": "complete",
            "target_countries": ["美国"],
            "target_locale": "en-US",
            "episode_duration": "90 秒",
            "target_episode_count": 30,
            "maturity_target": "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
            "market_deliverables": [{"market": "美国", "locale": "en-US", "status": "resolved"}],
            "locale_contract_status": "single_locale",
            "requires_separate_language_versions": False,
            "missing_fields": [],
            "assumptions_require_approval": False,
            "inferred_fields": [],
            "assumption_notes": [],
        }
        self.write_json("1.1-user-input.json", {
            "project": {
                "project_name": "原项目名",
                "target_region": "北美",
                "distribution_brief": brief,
            }
        })
        self.write_json("1.2-project-progress.json", {
            "stages": {
                "full_generate": {
                    "status": full_status,
                    "quality_check": {"passed": quality_passed},
                },
                "trial_generate": {"status": trial_status},
                "dialogue_translate": {"status": "completed"},
            }
        })
        self.write_json("2.1-world-view.json", {
            "世界观描述": "故事发生在一座沿海城市，权力与亲密关系都必须建立在明确边界之上。",
            "关键概念映射": [],
        })
        synopsis = "女主在危机中夺回选择权，并与男主建立平等关系。"
        self.write_json("3.1-outline.json", {
            "剧本名称": "星夜回声",
            "关键角色名称映射": [{
                "中文名称": "林星",
                "英文名称": "Lynn Xing",
            }],
            "故事梗概": synopsis,
        })
        self.write_json("runtime/dialogue-translate/manifest.json", {
            "schema_version": "1.1.0",
            "story_synopsis": {
                "source_file": "3.1-outline.json",
                "source_hash": workspace_service.sha256_text(synopsis),
                "unit_file": "7.1-lines-001.json",
                "translated_text": "The heroine reclaims her agency in a crisis and builds an equal partnership with the hero.",
            },
        })
        self.write_json("4.1-character.json", [{
            "人物名称": "林星",
            "性别": "女",
            "国籍": "中国",
            "年龄": "32岁",
            "身份": "项目负责人",
            "外貌": "短发利落，神情专注",
            "穿着": "简洁西装与平底鞋",
            "性格": "理性坚定，习惯先解决问题",
            "核心诉求": "守住职业与生活的自主选择。",
            "人物难题": "必须在危机中学会拒绝他人的替代安排。",
            "关系与弧光": "从习惯照顾他人转向公开提出自己的条件。",
            "阶段变化": [{
                "故事阶段": "开篇",
                "身份与处境": "在高压项目中负责关键协调。",
                "人物形象": "32岁的项目负责人，短发利落、神情专注，穿简洁西装与平底鞋，理性坚定，习惯先解决问题。",
                "口吻": "先讲事实，再明确边界，不再替对方做决定。",
            }],
        }])
        (self.workspace / "output" / "星夜回声-剧本全稿.md").write_text(
            "# 剧本全稿\n\n## 第1集\n\n### 1-1 夜 内 办公室\n人物：林星、周沉\n\n△林星合上文件。\n\n林星（平静）：这是全稿台词。  \n(This is dialogue from the full script.)\n",
            encoding="utf-8",
        )
        (self.workspace / "output" / "剧本试稿.md").write_text(
            "# 剧本试稿\n\n## 第1集\n\n### 1-1 夜 内 办公室\n人物：林星、周沉\n\n△林星放下手机。\n\n林星（平静）：这是试稿台词。  \n(This is dialogue from the trial script.)\n",
            encoding="utf-8",
        )
        (self.workspace / "output" / "星夜回声-台词译稿.md").write_text(
            "# 星夜回声 - 台词译稿\n\n## 第1集\n\n### 1-1 夜 内 办公室\n人物：林星、周沉\n\n△林星合上文件。\n\n林星（平静）：这是中文台词。  \n(This is translated dialogue.)\n",
            encoding="utf-8",
        )

    def test_delivery_collects_only_the_confirmed_four_section_inputs(self) -> None:
        delivery = workspace_service.full_script_delivery_for_project(self.project())

        self.assertEqual(delivery["title"], "星夜回声")
        self.assertEqual(delivery["script_info"]["target_region"], "北美")
        self.assertEqual(delivery["script_info"]["target_countries"], ["美国"])
        self.assertNotIn("target_locale", delivery["script_info"])
        self.assertNotIn("target_platforms", delivery["script_info"])
        self.assertEqual(delivery["world_view"], "故事发生在一座沿海城市，权力与亲密关系都必须建立在明确边界之上。")
        self.assertEqual(delivery["synopsis"], "女主在危机中夺回选择权，并与男主建立平等关系。")
        self.assertEqual(delivery["characters"][0]["name"], "林星")
        self.assertEqual(delivery["characters"][0]["english_name"], "Lynn Xing")
        self.assertEqual(
            set(delivery["characters"][0]),
            {"name", "english_name", "gender", "nationality", "age", "identity", "appearance", "attire", "personality"},
        )
        self.assertNotIn("phase_changes", delivery["characters"][0])
        self.assertNotIn("core_need", delivery["characters"][0])
        self.assertIn("林星（平静）", delivery["script"]["content"])

    def test_delivery_supports_replication_projects(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'replicate' WHERE id = 1")

        delivery = workspace_service.full_script_delivery_for_project(self.project())

        self.assertEqual(delivery["title"], "星夜回声")
        self.assertIn("林星（平静）", delivery["script"]["content"])

    def test_delivery_uses_the_saved_full_script_when_it_needs_revision(self) -> None:
        self.write_workspace(full_status="needs_revision", quality_passed=False)

        delivery = workspace_service.full_script_delivery_for_project(self.project())

        self.assertIn("林星（平静）", delivery["script"]["content"])

    def test_trial_delivery_uses_the_same_context_with_only_trial_script_content(self) -> None:
        self.write_workspace(full_status="running", trial_status="awaiting_approval", quality_passed=False)

        delivery = workspace_service.trial_script_delivery_for_project(self.project())

        self.assertEqual(delivery["script"]["file_name"], "剧本试稿.md")
        self.assertIn("这是试稿台词", delivery["script"]["content"])
        self.assertNotIn("这是全稿台词", delivery["script"]["content"])
        self.assertEqual(delivery["world_view"], "故事发生在一座沿海城市，权力与亲密关系都必须建立在明确边界之上。")
        self.assertEqual(delivery["characters"][0]["name"], "林星")
        self.assertNotIn("phase_changes", delivery["characters"][0])

    def test_trial_delivery_uses_first_ten_episodes_of_completed_full_script(self) -> None:
        full_path = self.workspace / "output" / "星夜回声-剧本全稿.md"
        full_path.write_text(
            "# 剧本全稿\n\n"
            + "\n\n".join(
                f"## 第{episode}集：测试标题{episode}\n\n### {episode}-1 夜 内 办公室\n人物：林星\n\n△林星打开文件。\n\n林星：这是全稿第{episode}集。"
                for episode in range(1, 13)
            )
            + "\n",
            encoding="utf-8",
        )

        delivery = workspace_service.trial_script_delivery_for_project(self.project())

        self.assertEqual(delivery["script"]["file_name"], "星夜回声-剧本全稿.md")
        self.assertIn("这是全稿第10集", delivery["script"]["content"])
        self.assertNotIn("这是全稿第11集", delivery["script"]["content"])
        self.assertNotIn("这是试稿台词", delivery["script"]["content"])

    def test_completed_full_script_supplies_trial_delivery_for_all_adaptation_projects(self) -> None:
        for task_type in ("rewrite", "novel", "replicate"):
            with self.subTest(task_type=task_type):
                self.conn.execute("UPDATE projects SET task_type = ? WHERE id = 1", (task_type,))
                if task_type == "novel":
                    self.write_json("2.1-novel-analysis.json", {
                        "世界观": {
                            "世界观描述": "小说改编后的沿海城市。",
                            "关键概念映射": [],
                        }
                    })

                delivery = workspace_service.trial_script_delivery_for_project(self.project())

                self.assertEqual(delivery["script"]["file_name"], "星夜回声-剧本全稿.md")
                self.assertIn("这是全稿台词", delivery["script"]["content"])
                self.assertNotIn("这是试稿台词", delivery["script"]["content"])

    def test_delivery_exposes_outline_episode_titles_for_formatted_export(self) -> None:
        outline_path = self.workspace / "3.1-outline.json"
        outline = json.loads(outline_path.read_text(encoding="utf-8"))
        outline["开篇"] = {
            "剧集": [{"集数": 1, "剧集名称": "火场归来"}],
        }
        outline["剧情单元"] = [{
            "剧集": [{"集数": 2, "剧集名称": "照片反咬"}],
        }]
        outline_path.write_text(json.dumps(outline, ensure_ascii=False), encoding="utf-8")

        delivery = workspace_service.full_script_delivery_for_project(self.project())

        self.assertEqual(
            delivery["script"]["episode_titles"],
            {"1": "火场归来", "2": "照片反咬"},
        )

    def test_read_stage_file_displays_outline_episode_titles_without_changing_source_hash(self) -> None:
        outline_path = self.workspace / "3.1-outline.json"
        outline = json.loads(outline_path.read_text(encoding="utf-8"))
        outline["开篇"] = {"剧集": [{"集数": 1, "剧集名称": "火场归来"}]}
        outline["剧情单元"] = []
        outline_path.write_text(json.dumps(outline, ensure_ascii=False), encoding="utf-8")

        raw_content = (self.workspace / "output" / "星夜回声-剧本全稿.md").read_text(encoding="utf-8")
        document = workspace_service.read_stage_file(self.project(), "full_generate")

        self.assertIn("## 第1集：火场归来", document["content"])
        self.assertEqual(document["content_hash"], workspace_service.sha256_text(raw_content))
        self.assertEqual(
            (self.workspace / "output" / "星夜回声-剧本全稿.md").read_text(encoding="utf-8"),
            raw_content,
        )

    def test_read_stage_file_preserves_translated_episode_titles(self) -> None:
        outline_path = self.workspace / "3.1-outline.json"
        outline = json.loads(outline_path.read_text(encoding="utf-8"))
        outline["开篇"] = {"剧集": [{"集数": 1, "剧集名称": "火场归来"}]}
        outline["剧情单元"] = []
        outline_path.write_text(json.dumps(outline, ensure_ascii=False), encoding="utf-8")
        script_path = self.workspace / "output" / "星夜回声-台词译稿.md"
        script_path.write_text(
            "# 台词译稿\n\n## 第1集：火场归来（Fire Returns）\n",
            encoding="utf-8",
        )

        document = workspace_service.read_stage_file(self.project(), "dialogue_translate")

        self.assertIn("## 第1集：火场归来（Fire Returns）", document["content"])

    def test_dialogue_delivery_uses_the_same_character_profile_context(self) -> None:
        delivery = workspace_service.dialogue_script_delivery_for_project(self.project())

        self.assertEqual(delivery["title"], "星夜回声")
        self.assertEqual(delivery["script"]["file_name"], "星夜回声-台词译稿.md")
        self.assertIn("This is translated dialogue.", delivery["script"]["content"])
        self.assertEqual(
            delivery["translated_synopsis"],
            "The heroine reclaims her agency in a crisis and builds an equal partnership with the hero.",
        )
        self.assertEqual(
            set(delivery["characters"][0]),
            {"name", "english_name", "gender", "nationality", "age", "identity", "appearance", "attire", "personality"},
        )

    def test_trial_dialogue_delivery_keeps_project_materials_and_limits_body_to_ten_episodes(self) -> None:
        script_path = self.workspace / "output" / "星夜回声-台词译稿.md"
        script_path.write_text(
            "# 星夜回声 - 台词译稿\n\n"
            + "\n\n".join(
                f"## 第{episode}集：测试标题{episode}\n\n林星：第{episode}集台词。  \n(Episode {episode} dialogue.)"
                for episode in range(1, 13)
            )
            + "\n",
            encoding="utf-8",
        )

        full_delivery = workspace_service.dialogue_script_delivery_for_project(self.project())
        trial_delivery = workspace_service.dialogue_script_delivery_for_project(self.project(), scope="trial")

        self.assertEqual(trial_delivery["title"], full_delivery["title"])
        self.assertEqual(trial_delivery["script_info"], full_delivery["script_info"])
        self.assertEqual(trial_delivery["world_view"], full_delivery["world_view"])
        self.assertEqual(trial_delivery["synopsis"], full_delivery["synopsis"])
        self.assertEqual(trial_delivery["translated_synopsis"], full_delivery["translated_synopsis"])
        self.assertEqual(trial_delivery["characters"], full_delivery["characters"])
        self.assertIn("第10集台词", trial_delivery["script"]["content"])
        self.assertNotIn("第11集台词", trial_delivery["script"]["content"])
        self.assertIn("第12集台词", full_delivery["script"]["content"])

    def test_legacy_character_profiles_keep_the_original_delivery_contract(self) -> None:
        self.write_json("4.1-character.json", [{
            "人物名称": "林星",
            "角色身份": "项目负责人",
            "身份": "项目负责人",
            "形象": "冷静、利落的项目负责人。",
            "口吻": "先讲事实，再明确边界。",
            "核心诉求": "守住职业与生活的自主选择。",
            "人物难题": "必须在危机中学会拒绝他人的替代安排。",
            "关系与弧光": "从习惯照顾他人转向公开提出自己的条件。",
            "阶段变化": [{
                "故事阶段": "开篇",
                "身份与处境": "在高压项目中负责关键协调。",
                "人物形象变化": "从职业化克制转为主动表达。",
                "口吻变化": "不再替对方做决定。",
            }],
        }])

        full_delivery = workspace_service.full_script_delivery_for_project(self.project())
        dialogue_delivery = workspace_service.dialogue_script_delivery_for_project(self.project())

        expected_fields = {"name", "appearance", "voice", "core_need", "challenge", "relationship_arc"}
        self.assertEqual(set(full_delivery["characters"][0]), expected_fields)
        self.assertEqual(set(dialogue_delivery["characters"][0]), expected_fields)
        self.assertEqual(full_delivery["characters"][0]["appearance"], "冷静、利落的项目负责人。")

    def test_standalone_dialogue_delivery_does_not_require_rewrite_artifacts(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'translate', current_stage = 'dialogue_translate' WHERE id = 1")
        user_input = json.loads((self.workspace / "1.1-user-input.json").read_text(encoding="utf-8"))
        user_input["project"]["task_type"] = "translate"
        user_input["project"]["source_script"] = {
            "display_name": "独立译稿",
            "output_path": "output/原始剧本.md",
        }
        (self.workspace / "1.1-user-input.json").write_text(json.dumps(user_input, ensure_ascii=False), encoding="utf-8")
        for file_name in ("2.1-world-view.json", "3.1-outline.json", "4.1-character.json"):
            (self.workspace / file_name).unlink()
        (self.workspace / "output" / "独立译稿-台词译稿.md").write_text(
            "# 独立译稿 - 台词译稿\n\n林夏：你好。  \n(Hello.)\n",
            encoding="utf-8",
        )

        delivery = workspace_service.dialogue_script_delivery_for_project(self.project())

        self.assertEqual(delivery["title"], "独立译稿")
        self.assertEqual(delivery["world_view"], "")
        self.assertEqual(delivery["synopsis"], "")
        self.assertEqual(delivery["characters"], [])
        self.assertEqual(delivery["translated_synopsis"], "")
        self.assertIn("(Hello.)", delivery["script"]["content"])

    def test_dialogue_delivery_requires_a_current_translated_synopsis(self) -> None:
        (self.workspace / "runtime" / "dialogue-translate" / "manifest.json").unlink()

        with self.assertRaisesRegex(HTTPException, "缺少英文简介"):
            workspace_service.dialogue_script_delivery_for_project(self.project())

    def test_dialogue_delivery_rejects_a_stale_translated_synopsis(self) -> None:
        outline_path = self.workspace / "3.1-outline.json"
        outline = json.loads(outline_path.read_text(encoding="utf-8"))
        outline["故事梗概"] = "女主在另一场危机中作出新的选择。"
        outline_path.write_text(json.dumps(outline, ensure_ascii=False), encoding="utf-8")

        with self.assertRaisesRegex(HTTPException, "故事梗概已更新"):
            workspace_service.dialogue_script_delivery_for_project(self.project())

    def test_domestic_delivery_hides_english_character_name(self) -> None:
        self.conn.execute("UPDATE projects SET target_region = '国内' WHERE id = 1")
        user_input = json.loads((self.workspace / "1.1-user-input.json").read_text(encoding="utf-8"))
        user_input["project"]["target_region"] = "国内"
        (self.workspace / "1.1-user-input.json").write_text(
            json.dumps(user_input, ensure_ascii=False),
            encoding="utf-8",
        )

        delivery = workspace_service.full_script_delivery_for_project(self.project())

        self.assertEqual(delivery["characters"][0]["english_name"], "")

    def test_delivery_is_not_available_while_the_full_script_is_generating(self) -> None:
        self.write_workspace(full_status="running", quality_passed=False)

        with self.assertRaisesRegex(HTTPException, "正在生成"):
            workspace_service.full_script_delivery_for_project(self.project())

    def test_completed_full_script_supplies_trial_delivery_while_old_trial_is_generating(self) -> None:
        self.write_workspace(trial_status="running", quality_passed=False)

        delivery = workspace_service.trial_script_delivery_for_project(self.project())

        self.assertIn("这是全稿台词", delivery["script"]["content"])
        self.assertNotIn("这是试稿台词", delivery["script"]["content"])

    def test_trial_delivery_is_not_available_while_first_trial_is_generating(self) -> None:
        self.write_workspace(full_status="running", trial_status="running", quality_passed=False)

        with self.assertRaisesRegex(HTTPException, "剧本试稿正在生成"):
            workspace_service.trial_script_delivery_for_project(self.project())

    def test_delivery_is_not_available_for_review_only_projects(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'review' WHERE id = 1")

        with self.assertRaisesRegex(HTTPException, "仅适用于改编项目"):
            workspace_service.full_script_delivery_for_project(self.project())

    def test_novel_delivery_uses_world_view_from_novel_analysis(self) -> None:
        self.conn.execute("UPDATE projects SET task_type = 'novel' WHERE id = 1")
        self.write_json("2.1-novel-analysis.json", {
            "基础信息": {
                "小说名称": "原著小说",
                "小说梗概": "原著小说基础信息。",
                "题材": ["都市情感"],
                "基调": "紧张",
            },
            "核心卖点": "身份谜局持续升级。",
            "故事主线": "",
            "世界观": "家族继承秩序会被公开证据直接改写，公开鉴定报告决定继承权。",
            "关键人物": [],
            "剧情单元": [],
        })

        delivery = workspace_service.full_script_delivery_for_project(self.project())

        self.assertEqual(delivery["world_view"], "家族继承秩序会被公开证据直接改写，公开鉴定报告决定继承权。")


if __name__ == "__main__":
    unittest.main()
