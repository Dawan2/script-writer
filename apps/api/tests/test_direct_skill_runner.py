from __future__ import annotations

import json
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app.services import direct_skill_runner
from app.services.direct_skill_runner import call_direct_model, direct_skill_system_prompt, extract_json_object


class _CompletionHandler(BaseHTTPRequestHandler):
    payload = {}
    path = ""
    headers_snapshot = {}

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        _CompletionHandler.payload = json.loads(self.rfile.read(length).decode("utf-8"))
        _CompletionHandler.path = self.path
        _CompletionHandler.headers_snapshot = {key.lower(): value for key, value in self.headers.items()}
        response = (
            {"content": [{"type": "text", "text": '{"ok": true}'}]}
            if self.path.endswith("/messages")
            else {"choices": [{"message": {"content": '{"ok": true}'}}]}
        )
        body = json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002
        return


class _DisconnectOnceHandler(_CompletionHandler):
    request_count = 0

    def do_POST(self):  # noqa: N802
        _DisconnectOnceHandler.request_count += 1
        if _DisconnectOnceHandler.request_count == 1:
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        super().do_POST()


class _StreamingHandler(_CompletionHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        _StreamingHandler.payload = json.loads(self.rfile.read(length).decode("utf-8"))
        _StreamingHandler.path = self.path
        body = (
            'event: message_start\n'
            'data: {"type":"message_start"}\n\n'
            'event: content_block_delta\n'
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"ok\\": "}}\n\n'
            'event: content_block_delta\n'
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"true}"}}\n\n'
            'event: message_stop\n'
            'data: {"type":"message_stop"}\n\n'
            'data: [DONE]\n\n'
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class _FallbackHandler(_CompletionHandler):
    primary_calls = 0

    def do_POST(self):  # noqa: N802
        if self.path.startswith("/primary"):
            _FallbackHandler.primary_calls += 1
            body = b"gateway timeout"
            self.send_response(504)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_POST()


class _ThinkingOnlyFallbackHandler(_CompletionHandler):
    def do_POST(self):  # noqa: N802
        if self.path.startswith("/primary"):
            length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(length)
            body = (
                'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'
                'data: [DONE]\n\n'
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_POST()


class DirectSkillRunnerTest(unittest.TestCase):
    def test_skill_is_loaded_outside_claude_directory(self):
        prompt = direct_skill_system_prompt("script-distillation")
        self.assertIn("script-distillation", prompt)
        self.assertIn("案例卡只记录这部剧的事实", prompt)
        self.assertNotIn("Agents/.claude/CLAUDE.md", prompt)

    def test_distillation_stage_skills_are_loaded_independently(self):
        case_prompt = direct_skill_system_prompt("script-case-card")
        formula_prompt = direct_skill_system_prompt("script-formula-curation")

        self.assertIn("剧本标签、摘要和案例卡", case_prompt)
        self.assertNotIn("script-distillation-review", case_prompt)
        self.assertIn("reuse", formula_prompt)
        self.assertIn("improve", formula_prompt)

    def test_legacy_distillation_prompt_loads_every_stage_validation_contract(self):
        prompt = direct_skill_system_prompt(
            "script-distillation",
            task_contract="single_script_distillation",
            supporting_skills=(
                "script-case-card",
                "script-formula-distillation",
                "script-principle-distillation",
            ),
        )

        self.assertIn("每个入选人物都必须填写", prompt)
        self.assertIn("`turning_action` 为 12-500 字符", prompt)
        self.assertIn("`candidate_id` 使用不重复的 `F01` 格式", prompt)
        self.assertIn("`observation_id` 使用不重复的 `P01` 格式", prompt)
        self.assertIn("只把人名列入 `source_specific_terms` 不算通过", prompt)

    def test_distillation_skills_include_domain_knowledge_and_acceptance_rules(self):
        evidence_prompt = direct_skill_system_prompt("script-evidence-extraction")
        case_prompt = direct_skill_system_prompt("script-case-card")
        formula_prompt = direct_skill_system_prompt("script-formula-distillation")
        principle_prompt = direct_skill_system_prompt("script-principle-distillation")
        review_prompt = direct_skill_system_prompt("script-distillation-review")

        self.assertIn("如何识别有效情节点", evidence_prompt)
        self.assertIn("权力：谁能决定", evidence_prompt)
        self.assertIn("事实、观众效果假设和疑点分开记录", evidence_prompt)

        self.assertIn("案例卡字段的业务含义", case_prompt)
        self.assertIn("`repeatable_conflict_loop`", case_prompt)
        self.assertIn("按不可逆状态变化划分", case_prompt)
        self.assertIn("铺垫、加压、释放和剧情后果", case_prompt)

        self.assertIn("什么是合格的公式", formula_prompt)
        self.assertIn("公式迁移检验", formula_prompt)
        self.assertIn("使用条件、执行步骤、生效机制", formula_prompt)
        self.assertIn("改写和新创作用法", formula_prompt)

        self.assertIn("公式与原则的边界", principle_prompt)
        self.assertIn("跨题材", principle_prompt)
        self.assertIn("`review_criteria`", principle_prompt)
        self.assertIn("`supports`、`bounds`、`counters` 或 `proposes`", principle_prompt)

        self.assertIn("案例卡验收", review_prompt)
        self.assertIn("去专名、迁移、执行和可检查性审查", review_prompt)
        self.assertIn("原则验收", review_prompt)

    def test_every_distillation_skill_spells_out_its_hard_validator_contract(self):
        required_fragments = {
            "script-evidence-extraction": (
                "硬性输出要求",
                "`covered_chunk_ids` 为 1-20 项",
                "`events` 1-24 条",
                "至少引用 1 个本次输入中真实存在的 `C0001`",
            ),
            "script-fact-consolidation": (
                "硬性输出要求",
                "`chronology` 3-40 条",
                "`craft_observations` 3-20 条",
                "同时落在全剧前四分之一、中间区间和后四分之一",
            ),
            "script-case-card": (
                "硬性输出要求",
                "任一字段缺失都会导致任务失败",
                "`turning_action` 为 12-500 字符",
                "`case_card.evidence_references` 至少为",
            ),
            "script-formula-distillation": (
                "硬性输出要求",
                "`candidate_id` 使用不重复的 `F01` 格式",
                "`genre_adaptations` 为 1-6 条",
                "`catalog_decision.action` 必须是 `unresolved`",
            ),
            "script-principle-distillation": (
                "硬性输出要求",
                "`observation_id` 使用不重复的 `P01` 格式",
                "`relation` 只能是 `supports`",
                "`status` 必须是 `candidate_only`",
            ),
            "script-distillation-review": (
                "硬性输出要求",
                "`approved: true` 时 `issues` 必须为空数组",
                "`stage` 只能是 `case_card`",
            ),
            "script-formula-curation": (
                "硬性输出要求",
                "每个输入 `candidate_id` 必须且只能出现一次",
                "`create` 的 `formula_id` 必须为空字符串",
            ),
            "script-principle-curation": (
                "硬性输出要求",
                "每个输入 `observation_id` 必须且只能出现一次",
                "`retrieved_principle_ids`",
                "`propose` 的 `principle_id` 必须为空字符串",
            ),
        }
        for skill_name, fragments in required_fragments.items():
            prompt = direct_skill_system_prompt(skill_name)
            for fragment in fragments:
                with self.subTest(skill=skill_name, fragment=fragment):
                    self.assertIn(fragment, prompt)

    def test_openai_compatible_call_returns_text_and_payload(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _CompletionHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory:
                result = call_direct_model(
                    system_prompt="系统规范",
                    user_prompt="返回 JSON",
                    runtime={
                        "request_url": f"http://127.0.0.1:{server.server_port}/v1",
                        "api_key": "test-key",
                        "model_name": "MiniMax-M2",
                        "thinking_level": "max",
                    },
                    log_path=Path(directory) / "call.log",
                    timeout_seconds=10,
                )
            self.assertEqual(extract_json_object(result), {"ok": True})
            self.assertEqual(_CompletionHandler.payload["model"], "MiniMax-M2")
            self.assertEqual(_CompletionHandler.payload["messages"][0]["content"], "系统规范")
            self.assertTrue(_CompletionHandler.payload["reasoning_split"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_anthropic_messages_call_uses_system_field(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _CompletionHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory:
                result = call_direct_model(
                    system_prompt="系统规范",
                    user_prompt="返回 JSON",
                    runtime={
                        "model_type": "claude_code",
                        "api_protocol": "anthropic",
                        "request_url": f"http://127.0.0.1:{server.server_port}/coding",
                        "api_key": "test-key",
                        "model_name": "k3",
                        "thinking_level": "high",
                    },
                    log_path=Path(directory) / "call.log",
                    timeout_seconds=10,
                )
            self.assertEqual(extract_json_object(result), {"ok": True})
            self.assertEqual(_CompletionHandler.path, "/coding/v1/messages")
            self.assertEqual(_CompletionHandler.payload["system"], "系统规范")
            self.assertEqual(_CompletionHandler.payload["thinking"]["budget_tokens"], 8192)
            self.assertEqual(_CompletionHandler.payload["messages"][0]["content"], "返回 JSON")
            self.assertEqual(_CompletionHandler.headers_snapshot["x-api-key"], "test-key")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_anthropic_v1_base_url_does_not_duplicate_version_path(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _CompletionHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory:
                result = call_direct_model(
                    system_prompt="系统规范",
                    user_prompt="返回 JSON",
                    runtime={
                        "model_type": "claude_code",
                        "api_protocol": "anthropic",
                        "request_url": f"http://127.0.0.1:{server.server_port}/coding/v1",
                        "api_key": "test-key",
                        "model_name": "k3",
                        "thinking_level": "low",
                    },
                    log_path=Path(directory) / "call.log",
                    timeout_seconds=10,
                )
            self.assertEqual(extract_json_object(result), {"ok": True})
            self.assertEqual(_CompletionHandler.path, "/coding/v1/messages")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_anthropic_thinking_budget_reserves_answer_tokens(self):
        body = direct_skill_runner._request_body(
            protocol="anthropic",
            system_prompt="系统规范",
            user_prompt="返回 JSON",
            runtime={
                "model_name": "glm-5.3-flash",
                "thinking_level": "high",
                "max_tokens": 4_000,
            },
        )

        self.assertEqual(body["thinking"]["budget_tokens"], 3_744)
        self.assertEqual(body["max_tokens"], 4_000)

    def test_non_streaming_max_tokens_stop_is_reported(self):
        with self.assertRaisesRegex(RuntimeError, "模型输出达到上限"):
            direct_skill_runner._content_from_response({
                "stop_reason": "max_tokens",
                "content": [{"type": "thinking", "thinking": "thinking"}],
            })

    def test_transient_disconnect_is_retried(self):
        _DisconnectOnceHandler.request_count = 0
        server = ThreadingHTTPServer(("127.0.0.1", 0), _DisconnectOnceHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory, patch.object(
                direct_skill_runner,
                "TRANSIENT_RETRY_DELAYS_SECONDS",
                (0.0, 0.0),
            ):
                log_path = Path(directory) / "call.log"
                result = call_direct_model(
                    system_prompt="系统规范",
                    user_prompt="返回 JSON",
                    runtime={
                        "request_url": f"http://127.0.0.1:{server.server_port}/v1",
                        "api_key": "test-key",
                        "model_name": "test-model",
                    },
                    log_path=log_path,
                    timeout_seconds=10,
                )
                log = json.loads(log_path.read_text(encoding="utf-8"))
            self.assertEqual(extract_json_object(result), {"ok": True})
            self.assertEqual(_DisconnectOnceHandler.request_count, 2)
            self.assertEqual(log["attempt_count"], 2)
            self.assertTrue(log["attempts"][0]["retryable"])
            self.assertEqual(log["status"], 200)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_anthropic_streaming_response_is_assembled(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _StreamingHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory:
                result = call_direct_model(
                    system_prompt="系统规范",
                    user_prompt="返回 JSON",
                    runtime={
                        "model_type": "claude_code",
                        "api_protocol": "anthropic",
                        "request_url": f"http://127.0.0.1:{server.server_port}/coding",
                        "api_key": "test-key",
                        "model_name": "k3",
                        "thinking_level": "low",
                        "stream": True,
                        "max_tokens": 1024,
                    },
                    log_path=Path(directory) / "stream.log",
                    timeout_seconds=10,
                )
            self.assertEqual(extract_json_object(result), {"ok": True})
            self.assertTrue(_StreamingHandler.payload["stream"])
            self.assertEqual(_StreamingHandler.payload["max_tokens"], 1024)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_configured_fallback_model_is_used_after_http_failure(self):
        _FallbackHandler.primary_calls = 0
        server = ThreadingHTTPServer(("127.0.0.1", 0), _FallbackHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory, patch.object(
                direct_skill_runner,
                "TRANSIENT_RETRY_DELAYS_SECONDS",
                (0.0, 0.0),
            ):
                result = call_direct_model(
                    system_prompt="系统规范",
                    user_prompt="返回 JSON",
                    runtime={
                        "request_url": f"http://127.0.0.1:{server.server_port}/primary",
                        "api_key": "test-key",
                        "model_name": "primary",
                        "fallback": {
                            "request_url": f"http://127.0.0.1:{server.server_port}/fallback",
                            "api_key": "fallback-key",
                            "model_name": "fallback",
                        },
                    },
                    log_path=Path(directory) / "fallback.log",
                    timeout_seconds=10,
                )
            self.assertEqual(extract_json_object(result), {"ok": True})
            self.assertEqual(_FallbackHandler.primary_calls, 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_configured_fallback_is_used_when_stream_has_no_answer_text(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _ThinkingOnlyFallbackHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory:
                result = call_direct_model(
                    system_prompt="系统规范",
                    user_prompt="返回 JSON",
                    runtime={
                        "request_url": f"http://127.0.0.1:{server.server_port}/primary",
                        "api_key": "primary-key",
                        "model_name": "primary",
                        "stream": True,
                        "fallback": {
                            "request_url": f"http://127.0.0.1:{server.server_port}/fallback",
                            "api_key": "fallback-key",
                            "model_name": "fallback",
                        },
                    },
                    log_path=Path(directory) / "thinking-only.log",
                    timeout_seconds=10,
                )
            self.assertEqual(extract_json_object(result), {"ok": True})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
