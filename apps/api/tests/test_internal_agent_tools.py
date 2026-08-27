from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.routers import internal_agent_tools
from app.services.agent_runner import AgentExecutionError


class InternalAgentToolsTest(unittest.TestCase):
    def test_novel_analysis_tool_rejects_missing_token(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            internal_agent_tools.prepare_novel_analysis(None)

        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(caught.exception.detail["next_action"], "请重新执行小说解读。")

    def test_novel_analysis_tool_returns_only_the_execution_result(self) -> None:
        result = {
            "ok": True,
            "message": "小说全文已阅读完成，解读草稿已生成。",
            "next_action": "复核小说解读。",
        }
        with patch.object(internal_agent_tools, "execute_novel_analysis_tool", return_value=result) as execute:
            response = internal_agent_tools.prepare_novel_analysis("temporary-token")

        self.assertEqual(response, result)
        execute.assert_called_once_with("temporary-token")

    def test_novel_analysis_tool_maps_retryable_failure_to_a_deterministic_retry(self) -> None:
        error = AgentExecutionError(
            "NOVEL_ANALYSIS_PREPARATION",
            "runtime",
            True,
            "小说全文解读未完成。",
        )
        with (
            patch.object(internal_agent_tools, "execute_novel_analysis_tool", side_effect=error),
            self.assertRaises(HTTPException) as caught,
        ):
            internal_agent_tools.prepare_novel_analysis("temporary-token")

        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail, {
            "message": "小说全文解读未完成。",
            "next_action": "重新调用‘完整阅读小说’。",
        })

if __name__ == "__main__":
    unittest.main()
