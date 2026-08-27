from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.services import novel_analysis_admission, workspace_service


REPO_ROOT = Path(__file__).resolve().parents[3]


class NovelAnalysisAdmissionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.agents_dir = root / "Agents"
        self.workspaces_dir = self.agents_dir / "workspaces"
        self.workspace = self.workspaces_dir / "demo"
        self.workspace.mkdir(parents=True)
        self.workspace_settings = SimpleNamespace(agents_dir=self.agents_dir, workspaces_dir=self.workspaces_dir)
        self.tool_settings = SimpleNamespace(agents_dir=REPO_ROOT / "Agents")
        self.admission_settings_patch = patch.object(novel_analysis_admission, "settings", self.tool_settings)
        self.workspace_settings_patch = patch.object(workspace_service, "settings", self.workspace_settings)
        self.admission_settings_patch.start()
        self.workspace_settings_patch.start()
        (self.workspace / "runtime").mkdir()
        (self.workspace / "1.1-user-input.json").write_text(json.dumps({
            "project": {
                "task_type": "novel",
                "source_script": {"output_path": "runtime/原始小说.md"},
            },
        }, ensure_ascii=False), encoding="utf-8")
        (self.workspace / "1.2-project-progress.json").write_text("{}", encoding="utf-8")
        self.project = {"task_type": "novel", "workspace_dir": "workspaces/demo"}

    def tearDown(self) -> None:
        self.workspace_settings_patch.stop()
        self.admission_settings_patch.stop()
        self.temp_dir.cleanup()

    def test_rejects_oversized_novel_with_the_user_facing_split_recommendation(self) -> None:
        (self.workspace / "runtime/原始小说.md").write_text("字" * 600_001, encoding="utf-8")

        with self.assertRaises(HTTPException) as raised:
            novel_analysis_admission.assert_novel_analysis_admission(self.project)

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(
            raised.exception.detail,
            "这是一部 60.0 万字的宏篇巨著，剧本化效果不会很好。\n建议分多季，每季30万字左右，再按季实现剧本化。",
        )

    def test_allows_a_novel_at_the_character_limit(self) -> None:
        (self.workspace / "runtime/原始小说.md").write_text("字" * 600_000, encoding="utf-8")

        result = novel_analysis_admission.assert_novel_analysis_admission(self.project)

        self.assertTrue(result["allowed"])
        self.assertEqual(result["character_count"], 600_000)


if __name__ == "__main__":
    unittest.main()
