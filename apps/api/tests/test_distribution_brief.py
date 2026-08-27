from pathlib import Path
import json
import unittest

from fastapi import HTTPException

from app.core.config import settings
from app.services.script_tag_service import tag_taxonomy
from app.services.workspace_service import default_distribution_brief, project_init_command, review_prepare_command


class DistributionBriefCommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.brief = {
            "target_country": "美国,加拿大",
            "target_locale": "en-US",
            "episode_duration": "60-90 秒",
            "target_episode_count": 90,
            "maturity_target": "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
            "theme": ["悬疑", "商战"],
            "setting": ["大女主", "业界精英"],
            "background": ["现代", "都市", "职场"],
            "audience": ["女频"],
        }

    def assert_brief_flags(self, command: list[str], *, include_script_tags: bool = True) -> None:
        expected = {
            "--target-country": "美国,加拿大",
            "--target-locale": "en-US",
            "--episode-duration": "60-90 秒",
            "--target-episode-count": "90",
            "--maturity-target": "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
        }
        if include_script_tags:
            expected.update({
                "--theme": "悬疑,商战",
                "--setting": "大女主,业界精英",
                "--background": "现代,都市,职场",
                "--audience": "女频",
            })
        for flag, value in expected.items():
            index = command.index(flag)
            self.assertEqual(command[index + 1], value)

    def test_project_init_receives_complete_distribution_brief(self) -> None:
        command = project_init_command(
            project_name="测试项目",
            source_path=Path("/tmp/source.md"),
            source_title="测试项目",
            target_region="北美",
            extra_requirements="",
            username="tester",
            distribution_brief=self.brief,
        )
        self.assert_brief_flags(command)
        task_index = command.index("--task-type")
        self.assertEqual(command[task_index + 1], "rewrite")

    def test_blank_extra_requirements_is_not_sent_as_an_empty_cli_value(self) -> None:
        command = project_init_command(
            project_name="测试项目",
            source_path=Path("/tmp/source.md"),
            source_title="测试项目",
            target_region="北美",
            extra_requirements="   ",
            username="tester",
        )

        self.assertNotIn("--extra-requirements", command)

    def test_standalone_review_receives_same_distribution_brief(self) -> None:
        command = review_prepare_command(
            project_name="待审剧本",
            source_path=Path("/tmp/source.md"),
            source_title="待审剧本",
            target_region="北美",
            extra_requirements="",
            username="tester",
            distribution_brief=self.brief,
        )
        self.assert_brief_flags(command, include_script_tags=False)
        for flag in ("--theme", "--setting", "--background", "--audience"):
            self.assertNotIn(flag, command)
        task_index = command.index("--task-type")
        self.assertEqual(command[task_index + 1], "review")

    def test_omitted_advanced_fields_are_left_for_project_init_inference(self) -> None:
        command = project_init_command(
            project_name="自动补全",
            source_path=Path("/tmp/source.md"),
            source_title="自动补全",
            target_region="北美",
            extra_requirements="",
            username="tester",
            distribution_brief={"target_country": "美国", "target_locale": "en-US"},
        )
        self.assertIn("--target-country", command)
        self.assertIn("--target-locale", command)
        for flag in ("--episode-duration", "--target-episode-count"):
            self.assertNotIn(flag, command)
        self.assertNotIn("--maturity-target", command)

    def test_creative_tasks_default_to_auto_adapt_and_support_explicit_tags(self) -> None:
        defaults = default_distribution_brief("北美", {}, task_type="rewrite")
        for field in ("theme", "setting", "background", "audience"):
            self.assertEqual(defaults[field], ["自动适配"])

        explicit = default_distribution_brief("北美", self.brief, task_type="novel")
        self.assertEqual(explicit["theme"], ["悬疑", "商战"])
        self.assertEqual(explicit["audience"], ["女频"])

    def test_non_creative_tasks_do_not_store_script_tags(self) -> None:
        for task_type in ("review", "translate", "humanize"):
            brief = default_distribution_brief("北美", self.brief, task_type=task_type)
            for field in ("theme", "setting", "background", "audience"):
                self.assertNotIn(field, brief)

    def test_user_selected_semantic_conflicts_are_preserved(self) -> None:
        brief = default_distribution_brief("北美", {
            "theme": ["民国爱情"],
            "setting": ["大女主"],
            "background": ["现代", "古代"],
            "audience": ["女频"],
        }, task_type="rewrite")

        self.assertEqual(brief["theme"], ["民国爱情"])
        self.assertEqual(brief["background"], ["现代", "古代"])

    def test_user_selected_tags_still_follow_structural_limits(self) -> None:
        with self.assertRaises(HTTPException):
            default_distribution_brief("北美", {
                "theme": ["悬疑", "商战", "动作", "科幻", "喜剧"],
                "setting": ["大女主"],
                "background": ["现代"],
                "audience": ["女频"],
            }, task_type="rewrite")

    def test_api_and_agent_taxonomies_match(self) -> None:
        agent_taxonomy = json.loads(
            (settings.agents_dir / ".claude/config/script-tag-taxonomy.json").read_text(encoding="utf-8")
        )
        self.assertEqual(tag_taxonomy(), agent_taxonomy)


if __name__ == "__main__":
    unittest.main()
