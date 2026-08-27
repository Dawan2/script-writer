from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
AGENTS_DIR = REPO_ROOT / "Agents"
NODE = os.getenv("ORCA_NODE_PATH", "node")
LOCALIZED_ROLE_NAME = "艾玛·格兰特"
ENGLISH_ROLE_NAME = "Emma Grant"


def distribution_brief(*, episode_duration: str | None = None) -> dict:
    brief = {
        "status": "complete",
        "target_countries": ["美国"],
        "target_locale": "en-US",
        "target_episode_count": 2,
        "market_deliverables": [{
            "market": "美国",
            "locale": "en-US",
            "delivery_mode": "bilingual_script",
            "status": "resolved",
            "locale_source": "region_rules:default_locale",
        }],
        "locale_contract_status": "single_locale",
        "requires_separate_language_versions": False,
        "missing_fields": [],
        "assumptions_require_approval": False,
        "inferred_fields": [],
        "assumption_notes": [],
    }
    if episode_duration is not None:
        brief["episode_duration"] = episode_duration
    return brief


def episode(episode_number: int) -> dict:
    return {
        "集数": episode_number,
        "剧集名称": f"第{episode_number}集标题",
        "关键角色": [LOCALIZED_ROLE_NAME],
        "写作思路": {
            "开场冲突": f"{LOCALIZED_ROLE_NAME}面临即时压力",
            "主要转折": ["线索使局面变化"],
            "结尾承接": f"新问题迫使{LOCALIZED_ROLE_NAME}继续行动",
        },
        "剧集梗概": f"{LOCALIZED_ROLE_NAME}主动应对变化，使突危会提升。",
    }


def outline(script_name: str) -> dict:
    return {
        "剧本名称": script_name,
        "英文剧本名称": "Starlit Protocol",
        "关键角色名称映射": [{
            "英文名称": ENGLISH_ROLE_NAME,
            "中文名称": LOCALIZED_ROLE_NAME,
        }],
        "故事梗概": f"{LOCALIZED_ROLE_NAME}为拯救家人而卷入更大危机，最终以主动选择完成回报。",
        "开篇": {
            "开篇描述": f"第一集立即让{LOCALIZED_ROLE_NAME}尝到背叛的代价。",
            "关键角色": [LOCALIZED_ROLE_NAME],
            "剧集": [episode(1)],
        },
        "剧情单元": [{
            "单元名称": "线索争夺",
            "单元描述": f"{LOCALIZED_ROLE_NAME}争取能改变局面的证据。",
            "关键角色": [LOCALIZED_ROLE_NAME],
            "剧集": [episode(2)],
        }],
    }


def short_episode_markdown(episode_number: int) -> str:
    return "\n".join([
        f"## 第{episode_number}集：第{episode_number}集标题",
        "",
        "### 场景1 夜 客厅",
        f"人物：{LOCALIZED_ROLE_NAME}",
        f"△{LOCALIZED_ROLE_NAME}握紧手机，走向门口。",
        f"{LOCALIZED_ROLE_NAME}：我必须现在进去。  ",
        "(I have to go in now.)",
    ])


def valid_episode_markdown(episode_number: int, target_dialogue: str | None = None) -> str:
    action = (
        f"{LOCALIZED_ROLE_NAME}握紧手机，沿着走廊追向门口，反复确认时间、地点和联系人，"
        "并在每次犹豫后重新选择把证据带回公开场合。"
    ) * 13
    lines = [
        f"## 第{episode_number}集：第{episode_number}集标题",
        "",
        f"### {episode_number}-1 夜 内 走廊",
        f"人物：{LOCALIZED_ROLE_NAME}",
        f"△{action}",
        f"{LOCALIZED_ROLE_NAME}：我必须现在进去。",
    ]
    if target_dialogue is not None:
        lines[-1] += "  "
        lines.append(f"({target_dialogue})")
    return "\n".join(lines)


class ScriptOutputContractsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp_dir.name)
        (self.workspace / "output").mkdir()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_workspace(
        self,
        *,
        script_name: str,
        trial_status: str = "pending",
        episode_duration: str | None = None,
    ) -> None:
        user_input = {
            "schema_version": "1.1.0",
            "project": {
                "project_name": "测试项目",
                "target_region": "北美",
                "distribution_brief": distribution_brief(episode_duration=episode_duration),
                "source_script": {
                    "display_name": "原剧名称",
                    "output_path": "output/原始剧本.md",
                },
            },
        }
        progress = {
            "stages": {
                "world_view": {"status": "completed"},
                "character_rewrite": {"status": "completed"},
                "trial_generate": {"status": trial_status},
            },
        }
        (self.workspace / "1.1-user-input.json").write_text(
            json.dumps(user_input, ensure_ascii=False), encoding="utf-8"
        )
        (self.workspace / "1.2-project-progress.json").write_text(
            json.dumps(progress, ensure_ascii=False), encoding="utf-8"
        )
        (self.workspace / "3.1-outline.json").write_text(
            json.dumps(outline(script_name), ensure_ascii=False), encoding="utf-8"
        )

    def run_tool(self, relative_script: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [NODE, str(AGENTS_DIR / relative_script), "--workspace", str(self.workspace), "--updated-by", "tester"],
            cwd=AGENTS_DIR,
            text=True,
            capture_output=True,
            check=False,
        )

    def prepare_execution_strategy(self, stage: str) -> None:
        result = subprocess.run(
            [
                NODE,
                str(AGENTS_DIR / f".claude/skills/{stage}/scripts/get-execution-strategy.mjs"),
                "--workspace",
                str(self.workspace),
            ],
            cwd=AGENTS_DIR,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def run_progress_tool(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [NODE, str(AGENTS_DIR / ".claude/tools/update-progress.mjs"), "--workspace", str(self.workspace), *args],
            cwd=AGENTS_DIR,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_stage_cannot_be_completed_while_a_declared_output_is_missing(self) -> None:
        self.write_workspace(script_name="星海协议")
        progress_path = self.workspace / "1.2-project-progress.json"
        user_input_path = self.workspace / "1.1-user-input.json"
        progress_before = progress_path.read_text(encoding="utf-8")
        user_input_before = user_input_path.read_text(encoding="utf-8")

        result = self.run_progress_tool(
            "--stage", "outline_rewrite",
            "--status", "completed",
            "--updated-by", "tester",
            "--output", "output/星海协议-故事梗概.md",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("output/星海协议-故事梗概.md", result.stderr)
        self.assertIn("先生成并保存这一步的成果", result.stderr)
        self.assertEqual(progress_path.read_text(encoding="utf-8"), progress_before)
        self.assertEqual(user_input_path.read_text(encoding="utf-8"), user_input_before)

    def test_stage_is_completed_once_the_declared_output_is_on_disk(self) -> None:
        self.write_workspace(script_name="星海协议")
        (self.workspace / "output" / "星海协议-故事梗概.md").write_text("# 星海协议 - 故事梗概\n", encoding="utf-8")

        result = self.run_progress_tool(
            "--stage", "outline_rewrite",
            "--status", "completed",
            "--updated-by", "tester",
            "--output", "output/星海协议-故事梗概.md",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        progress = json.loads((self.workspace / "1.2-project-progress.json").read_text(encoding="utf-8"))
        self.assertEqual(progress["stages"]["outline_rewrite"]["status"], "completed")

    def test_trial_initialization_names_the_missing_world_view_and_the_next_step(self) -> None:
        self.write_workspace(script_name="星海协议")
        (self.workspace / "2.1-world-view.json").unlink(missing_ok=True)

        result = self.run_tool(".claude/skills/trial_generate/scripts/init-trial.mjs")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("读不到世界观", result.stderr)
        self.assertIn("重新执行“世界观”这一步", result.stderr)
        self.assertNotIn("不是有效 JSON", result.stderr)

    def test_outline_uses_a_renamed_script_title_for_file_and_heading(self) -> None:
        self.write_workspace(script_name="星海协议")

        result = self.run_tool(".claude/skills/outline_rewrite/scripts/check-outline.mjs")

        self.assertEqual(result.returncode, 0, result.stderr)
        output_path = self.workspace / "output" / "星海协议-故事梗概.md"
        self.assertTrue(output_path.is_file())
        self.assertTrue(output_path.read_text(encoding="utf-8").startswith("# 星海协议 - 故事梗概"))
        self.assertFalse((self.workspace / "output" / "剧本大纲.md").exists())
        progress = json.loads((self.workspace / "1.2-project-progress.json").read_text(encoding="utf-8"))
        self.assertEqual(progress["stages"]["outline_rewrite"]["title_confirmation"], {
            "status": "pending",
            "title": "星海协议",
            "english_title": "Starlit Protocol",
        })

    def test_outline_check_keeps_an_unchanged_confirmed_title(self) -> None:
        self.write_workspace(script_name="星海协议")
        progress_path = self.workspace / "1.2-project-progress.json"
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        progress["stages"]["outline_rewrite"] = {
            "status": "completed",
            "title_confirmation": {
                "status": "confirmed",
                "title": "星海协议",
                "english_title": "Starlit Protocol",
            },
        }
        progress_path.write_text(json.dumps(progress, ensure_ascii=False), encoding="utf-8")

        result = self.run_tool(".claude/skills/outline_rewrite/scripts/check-outline.mjs")

        self.assertEqual(result.returncode, 0, result.stderr)
        next_progress = json.loads(progress_path.read_text(encoding="utf-8"))
        self.assertEqual(next_progress["stages"]["outline_rewrite"]["title_confirmation"]["status"], "confirmed")

    def test_outline_rejects_the_original_script_title(self) -> None:
        self.write_workspace(script_name="原剧名称")

        result = self.run_tool(".claude/skills/outline_rewrite/scripts/check-outline.mjs")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不能沿用原剧本名称", result.stderr)

    def test_outline_requires_an_english_title_for_non_domestic_projects(self) -> None:
        self.write_workspace(script_name="星海协议")
        outline_path = self.workspace / "3.1-outline.json"
        payload = json.loads(outline_path.read_text(encoding="utf-8"))
        payload.pop("英文剧本名称")
        outline_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

        result = self.run_tool(".claude/skills/outline_rewrite/scripts/check-outline.mjs")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("海外项目缺少英文剧本名称", result.stderr)
        self.assertIn("自然、可发行的英文剧本名称", result.stderr)

    def test_trial_and_full_checks_enforce_the_default_duration_length_floor(self) -> None:
        self.write_workspace(script_name="星海协议", trial_status="approved")
        trial_text = "# 剧本试稿\n\n" + short_episode_markdown(1) + "\n\n" + short_episode_markdown(2) + "\n"
        (self.workspace / "output" / "剧本试稿.md").write_text(trial_text, encoding="utf-8")

        trial_result = self.run_tool(".claude/skills/trial_generate/scripts/check-trial.mjs")
        full_init_result = self.run_tool(".claude/skills/full_generate/scripts/init-full.mjs")
        full_result = self.run_tool(".claude/skills/full_generate/scripts/check-full.mjs")

        expected_issue = "第1集、第2集的字数数量不满足600字，需要进一步高质量的填充剧集内容"
        self.assertNotEqual(trial_result.returncode, 0)
        self.assertIn(expected_issue, trial_result.stderr)
        self.assertEqual(full_init_result.returncode, 0, full_init_result.stderr)
        full_path = self.workspace / "output" / "星海协议-剧本全稿.md"
        self.assertTrue(full_path.read_text(encoding="utf-8").startswith("# 星海协议 - 剧本全稿"))
        self.assertNotEqual(full_result.returncode, 0)
        self.assertIn(expected_issue, full_result.stderr)

    def test_trial_and_full_checks_allow_optional_target_dialogue(self) -> None:
        self.write_workspace(script_name="星海协议")
        trial_with_target = "# 剧本试稿\n\n" + "\n\n".join([
            valid_episode_markdown(1, "I have to go in now."),
            valid_episode_markdown(2, "I have to go in now."),
        ]) + "\n"
        (self.workspace / "output" / "剧本试稿.md").write_text(trial_with_target, encoding="utf-8")

        trial_result = self.run_tool(".claude/skills/trial_generate/scripts/check-trial.mjs")
        self.assertEqual(trial_result.returncode, 0, trial_result.stderr)

        self.write_workspace(script_name="星海协议", trial_status="approved")
        trial_without_target = "# 剧本试稿\n\n" + "\n\n".join([
            valid_episode_markdown(1),
            valid_episode_markdown(2),
        ]) + "\n"
        (self.workspace / "output" / "剧本试稿.md").write_text(trial_without_target, encoding="utf-8")

        full_init_result = self.run_tool(".claude/skills/full_generate/scripts/init-full.mjs")
        self.assertEqual(full_init_result.returncode, 0, full_init_result.stderr)
        self.prepare_execution_strategy("full_generate")
        full_path = self.workspace / "output" / "星海协议-剧本全稿.md"
        first_check_result = self.run_tool(".claude/skills/full_generate/scripts/check-full.mjs")
        self.assertEqual(first_check_result.returncode, 0, first_check_result.stderr)

        full_text = full_path.read_text(encoding="utf-8")
        full_path.write_text(
            full_text.replace(
                f"{LOCALIZED_ROLE_NAME}：我必须现在进去。",
                f"{LOCALIZED_ROLE_NAME}：我必须现在进去。  \n\n(I have to go in now.)",
                1,
            ),
            encoding="utf-8",
        )
        full_result = self.run_tool(".claude/skills/full_generate/scripts/check-full.mjs")
        self.assertEqual(full_result.returncode, 0, full_result.stderr)

    def test_full_generation_normalizes_legacy_trial_episode_headings(self) -> None:
        self.write_workspace(script_name="星海协议", trial_status="approved")
        legacy_trial = "# 剧本试稿\n\n" + "\n\n".join([
            valid_episode_markdown(1).replace("：第1集标题", ""),
            valid_episode_markdown(2).replace("：第2集标题", ""),
        ]) + "\n"
        (self.workspace / "output" / "剧本试稿.md").write_text(legacy_trial, encoding="utf-8")

        init_result = self.run_tool(".claude/skills/full_generate/scripts/init-full.mjs")
        self.prepare_execution_strategy("full_generate")
        check_result = self.run_tool(".claude/skills/full_generate/scripts/check-full.mjs")
        full_path = self.workspace / "output" / "星海协议-剧本全稿.md"

        self.assertEqual(init_result.returncode, 0, init_result.stderr)
        self.assertEqual(check_result.returncode, 0, check_result.stderr)
        self.assertIn("## 第1集：第1集标题", full_path.read_text(encoding="utf-8"))

    def test_trial_initialization_uses_the_configured_episode_duration(self) -> None:
        self.write_workspace(script_name="星海协议", episode_duration="120秒")

        result = self.run_tool(".claude/skills/trial_generate/scripts/init-trial.mjs")

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["episode_duration_seconds"], 120)
        self.assertEqual(payload["minimum_episode_characters"], 800)
        trial_text = (self.workspace / "output" / "剧本试稿.md").read_text(encoding="utf-8")
        self.assertIn("## 第1集：第1集标题", trial_text)
        self.assertIn("## 第2集：第2集标题", trial_text)
