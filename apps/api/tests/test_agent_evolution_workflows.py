from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.db import session
from app.services import (
    preference_summary_service,
    system_agent_evolution_service,
    workspace_service,
)
from app.services.notification_service import list_notifications
from app.services.preference_summary_service import (
    build_preference_summary_evidence,
    claim_preference_summary_job,
    queue_preference_summary,
    run_preference_summary_job,
)
from app.services.system_agent_evolution_service import (
    build_system_evolution_evidence,
    create_system_evolution_run,
    request_system_evolution_execution,
    retry_system_evolution_run,
    run_system_evolution_analysis,
    run_system_evolution_execution,
)
from app.services.writer_preference_service import get_profile_revision


class EvolutionWorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.data_dir = self.root / "data"
        self.agents_dir = self.root / "Agents"
        self.workspaces_dir = self.agents_dir / "workspaces"
        self.workspace = self.workspaces_dir / "demo"
        self.workspace.mkdir(parents=True)
        (self.agents_dir / ".claude" / "skills").mkdir(parents=True)
        self.settings = SimpleNamespace(
            data_dir=self.data_dir,
            database_path=self.data_dir / "app.db",
            repo_root=self.root,
            agents_dir=self.agents_dir,
            workspaces_dir=self.workspaces_dir,
            upload_dir=self.data_dir / "uploads",
        )
        self.patches = [
            patch.object(session, "settings", self.settings),
            patch.object(workspace_service, "settings", self.settings),
            patch.object(preference_summary_service, "settings", self.settings),
            patch.object(system_agent_evolution_service, "settings", self.settings),
        ]
        for item in self.patches:
            item.start()
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'admin', '管理员', 'hash', 'admin')"
        )
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (2, 'writer', '编剧', 'hash', 'user')"
        )
        self.conn.execute(
            """
            INSERT INTO projects (
                id, owner_user_id, name, workspace_dir, target_region, task_type,
                current_stage, status, claude_session_id, created_at, updated_at
            ) VALUES (
                1, 2, '归档项目', 'workspaces/demo', '北美', 'rewrite',
                'foreign_review', 'completed', 'project-session',
                '2026-07-10 00:00:00', '2026-07-14 00:00:00'
            )
            """
        )
        (self.workspace / "01-user-input.json").write_text(
            json.dumps(
                {
                    "project": {
                        "extra_requirements": "对白要克制，不要用说教总结人物选择。"
                    }
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def _insert_job(self, job_id: int, *, status: str = "succeeded", retry_of: int | None = None) -> None:
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, prompt, status,
                claude_session_id, logical_thread_id, retry_of_job_id,
                created_at, updated_at, finished_at
            ) VALUES (?, 1, 2, 'chat_edit', 'trial_generate', '', ?, ?, 'thread', ?,
                      '2026-07-13 10:00:00', '2026-07-13 10:01:00', '2026-07-13 10:01:00')
            """,
            (job_id, status, f"session-{job_id}", retry_of),
        )

    def test_archive_summary_excludes_automatic_messages_and_creates_disabled_sourced_preferences(self) -> None:
        self._insert_job(10)
        self._insert_job(11)
        self.conn.execute(
            """
            INSERT INTO agent_messages (
                id, project_id, job_id, stage, role, content, metadata_json, created_at
            ) VALUES (1, 1, 10, 'outline_rewrite', 'user', '自动进入下一阶段', ?, '2026-07-13 09:00:00')
            """,
            (json.dumps({"input_origin": "automatic"}, ensure_ascii=False),),
        )
        self.conn.execute(
            """
            INSERT INTO agent_messages (
                id, project_id, job_id, stage, role, content, metadata_json, created_at
            ) VALUES (2, 1, 11, 'chat_edit', 'user', '包装后的完整提示', ?, '2026-07-13 10:00:00')
            """,
            (json.dumps({"input_origin": "manual", "manual_input": "试稿中每次反转都要由人物行动引发"}, ensure_ascii=False),),
        )
        impact = {
            "summary": "semantic 修改：新增 2 行，删除 1 行",
            "added_samples": ["女主先提交证据，再触发反转"],
            "removed_samples": ["真相突然公布"],
        }
        self.conn.execute(
            """
            INSERT INTO artifact_changes (
                id, project_id, stage, file_path, old_hash, new_hash,
                change_kind, impact_json, edited_by, created_at
            ) VALUES (3, 1, 'trial_generate', 'workspaces/demo/04-剧本试稿.md',
                      'old', 'new', 'semantic', ?, 2, '2026-07-13 10:02:00')
            """,
            (json.dumps(impact, ensure_ascii=False),),
        )
        summary_job = queue_preference_summary(self.conn, project_id=1, user_id=2)
        self.conn.commit()

        evidence = build_preference_summary_evidence(self.conn, int(summary_job["id"]))
        self.assertEqual([item["ref"] for item in evidence["manual_messages"]], ["message:2"])
        self.assertNotIn("自动进入下一阶段", json.dumps(evidence, ensure_ascii=False))
        self.assertEqual(evidence["manual_adjustments"][0]["added_samples"], impact["added_samples"])
        self.conn.commit()

        def fake_summary(evidence_path: Path, output_path: Path, _log_path: Path, **_kwargs) -> None:
            captured = json.loads(evidence_path.read_text(encoding="utf-8"))
            self.assertEqual(captured["manual_messages"][0]["content"], "试稿中每次反转都要由人物行动引发")
            output_path.write_text(
                json.dumps(
                    {
                        "schema_version": "1.0.0",
                        "preferences": [{
                            "content": "试稿中的反转应由人物的可观察行动引发",
                            "scopes": ["trial_generate"],
                            "evidence_refs": ["message:2", "artifact_change:3"],
                            "rationale": "对话与手动修改相互印证",
                        }],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

        def fake_preference_tool(action: str, *, evidence_path: Path, output_path: Path) -> dict:
            if action == "init":
                output_path.write_text(
                    json.dumps({"schema_version": "1.0.0", "preferences": []}, ensure_ascii=False),
                    encoding="utf-8",
                )
                return {"ok": True}
            self.assertEqual(action, "validate")
            return {
                "ok": True,
                "details": {"result": json.loads(output_path.read_text(encoding="utf-8"))},
            }

        with patch.object(preference_summary_service, "invoke_preference_summary_skill", side_effect=fake_summary), patch.object(
            preference_summary_service, "run_preference_summary_tool", side_effect=fake_preference_tool
        ):
            run_preference_summary_job(int(summary_job["id"]))

        preference = self.conn.execute("SELECT * FROM writer_preferences").fetchone()
        self.assertIsNotNone(preference)
        self.assertEqual(preference["source"], "ai")
        self.assertFalse(preference["enabled"])
        source = json.loads(preference["evidence_json"])
        self.assertEqual(source["project_name"], "归档项目")
        self.assertEqual(source["evidence_refs"], ["message:2", "artifact_change:3"])
        notifications = list_notifications(self.conn, 2)
        self.assertEqual(notifications["unread_count"], 1)
        self.assertEqual(notifications["notifications"][0]["target_path"], f"/preferences?source_job={summary_job['id']}")

    def test_archive_summary_records_explicit_regeneration_reason_and_claims_once(self) -> None:
        self._insert_job(12)
        self.conn.execute(
            """
            INSERT INTO agent_messages (
                project_id, job_id, stage, role, content, metadata_json, created_at
            ) VALUES (1, 12, 'outline_rewrite', 'user', '重新生成当前阶段内容', ?, '2026-07-13 10:00:00')
            """,
            (json.dumps({
                "input_origin": "manual",
                "manual_input": "中段节奏偏慢，需要把每次反转改成角色主动选择的结果。",
            }, ensure_ascii=False),),
        )
        summary_job = queue_preference_summary(self.conn, project_id=1, user_id=2)
        self.conn.commit()

        evidence = build_preference_summary_evidence(self.conn, int(summary_job["id"]))
        self.assertEqual(
            evidence["manual_messages"],
            [{
                "ref": "message:1",
                "stage": "outline_rewrite",
                "content": "中段节奏偏慢，需要把每次反转改成角色主动选择的结果。",
                "created_at": "2026-07-13 10:00:00",
            }],
        )
        claimed = claim_preference_summary_job(self.conn, int(summary_job["id"]))
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["status"], "running")
        self.assertIsNone(claim_preference_summary_job(self.conn, int(summary_job["id"])))
        queued_after_running = queue_preference_summary(self.conn, project_id=1, user_id=2)
        self.assertIsNone(claim_preference_summary_job(self.conn, int(queued_after_running["id"])))

    def test_archive_summary_yields_to_queued_or_running_user_work(self) -> None:
        self._insert_job(13, status="queued")
        summary_job = queue_preference_summary(self.conn, project_id=1, user_id=2)
        self.conn.commit()

        self.assertIsNone(claim_preference_summary_job(self.conn, int(summary_job["id"])))
        self.assertEqual(
            self.conn.execute(
                "SELECT status FROM preference_summary_jobs WHERE id = ?", (summary_job["id"],)
            ).fetchone()["status"],
            "queued",
        )

        self.conn.execute("UPDATE agent_jobs SET status = 'succeeded' WHERE id = 13")
        self.conn.execute("INSERT INTO batch_task_batches (id, created_by, name) VALUES (1, 2, '待处理批量任务')")
        self.conn.execute(
            """
            INSERT INTO batch_tasks (
                batch_id, created_by, scenario, source_path, input_json, status
            ) VALUES (1, 2, 'rewrite', '/tmp/source.docx', '{}', 'running')
            """
        )
        self.conn.commit()
        self.assertIsNone(claim_preference_summary_job(self.conn, int(summary_job["id"])))

        self.conn.execute("UPDATE batch_tasks SET status = 'succeeded' WHERE batch_id = 1")
        self.conn.commit()
        claimed = claim_preference_summary_job(self.conn, int(summary_job["id"]))
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["status"], "running")

    def test_archive_summary_does_not_import_after_its_project_is_reopened(self) -> None:
        self._insert_job(14)
        self.conn.execute(
            """
            INSERT INTO agent_messages (
                project_id, job_id, stage, role, content, metadata_json, created_at
            ) VALUES (1, 14, 'chat_edit', 'user', '调整对白', ?, '2026-07-13 10:00:00')
            """,
            (json.dumps({"input_origin": "manual", "manual_input": "对白要更克制"}, ensure_ascii=False),),
        )
        summary_job = queue_preference_summary(self.conn, project_id=1, user_id=2)
        self.conn.commit()

        def fake_summary(_evidence_path: Path, _output_path: Path, _log_path: Path, **_kwargs) -> None:
            self.conn.execute(
                "UPDATE preference_summary_jobs SET status = 'canceled' WHERE id = ?",
                (summary_job["id"],),
            )
            self.conn.commit()

        def fake_preference_tool(action: str, *, output_path: Path, **_kwargs: Path) -> dict:
            if action == "init":
                output_path.write_text(
                    json.dumps({"schema_version": "1.0.0", "preferences": []}, ensure_ascii=False),
                    encoding="utf-8",
                )
                return {"ok": True}
            self.fail("已取消的偏好复盘不应继续校验或导入")

        with patch.object(preference_summary_service, "invoke_preference_summary_skill", side_effect=fake_summary), patch.object(
            preference_summary_service, "run_preference_summary_tool", side_effect=fake_preference_tool
        ):
            run_preference_summary_job(int(summary_job["id"]))

        self.assertEqual(
            self.conn.execute(
                "SELECT status FROM preference_summary_jobs WHERE id = ?", (summary_job["id"],)
            ).fetchone()["status"],
            "canceled",
        )
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM writer_preferences").fetchone()[0], 0)

    def test_archive_summary_without_manual_evidence_skips_model_and_notification(self) -> None:
        (self.workspace / "01-user-input.json").write_text(
            json.dumps({"project": {"extra_requirements": ""}}, ensure_ascii=False),
            encoding="utf-8",
        )
        summary_job = queue_preference_summary(self.conn, project_id=1, user_id=2)
        self.conn.commit()

        def fake_preference_tool(action: str, *, output_path: Path, **_kwargs: Path) -> dict:
            if action == "init":
                output_path.write_text(
                    json.dumps({"schema_version": "1.0.0", "preferences": []}, ensure_ascii=False),
                    encoding="utf-8",
                )
                return {"ok": True}
            self.assertEqual(action, "validate")
            return {
                "ok": True,
                "details": {"result": json.loads(output_path.read_text(encoding="utf-8"))},
            }

        with patch.object(preference_summary_service, "invoke_preference_summary_skill", side_effect=AssertionError("无手工证据时不应调用模型")), patch.object(
            preference_summary_service, "run_preference_summary_tool", side_effect=fake_preference_tool
        ):
            run_preference_summary_job(int(summary_job["id"]))

        self.assertEqual(
            self.conn.execute(
                "SELECT status FROM preference_summary_jobs WHERE id = ?", (summary_job["id"],)
            ).fetchone()["status"],
            "succeeded",
        )
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM writer_preferences").fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM notifications").fetchone()[0], 0)

    def test_system_evolution_builds_evidence_and_requires_human_execution_constraints(self) -> None:
        self._insert_job(20, status="failed")
        self._insert_job(21, retry_of=20)
        self.conn.execute(
            """
            INSERT INTO agent_events (id, job_id, seq, event_type, message, created_at)
            VALUES (30, 20, 1, 'error', '工具参数格式错误 400', '2026-07-13 10:00:10')
            """
        )
        impact = {"summary": "semantic 修改", "added_samples": ["收紧对白"], "removed_samples": ["解释性独白"]}
        self.conn.execute(
            """
            INSERT INTO artifact_changes (
                id, project_id, stage, file_path, old_hash, new_hash,
                change_kind, impact_json, edited_by, created_at
            ) VALUES (31, 1, 'trial_generate', 'workspaces/demo/04-剧本试稿.md',
                      'a', 'b', 'semantic', ?, 2, '2026-07-13 10:03:00')
            """,
            (json.dumps(impact, ensure_ascii=False),),
        )
        self.conn.execute(
            """
            INSERT INTO agent_messages (
                id, project_id, job_id, stage, role, content, metadata_json, created_at
            ) VALUES (32, 1, 21, 'chat_edit', 'user', '对白太说教，请收紧', ?, '2026-07-13 10:04:00')
            """,
            (json.dumps({"input_origin": "manual", "manual_input": "对白太说教，请收紧"}, ensure_ascii=False),),
        )
        self.conn.commit()
        actor = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        run = create_system_evolution_run(self.conn, actor=actor)
        self.conn.commit()

        evidence = build_system_evolution_evidence(self.conn, run)
        self.assertEqual(evidence["summary"]["failed_job_count"], 1)
        self.assertEqual(evidence["summary"]["retry_job_count"], 1)
        self.assertEqual(evidence["failures_and_retries"]["error_groups"][0]["evidence_refs"], ["event:30"])
        self.assertEqual(evidence["quality_and_rework"]["manual_changes"][0]["ref"], "artifact_change:31")
        self.assertEqual(evidence["quality_and_rework"]["manual_feedback"][0]["ref"], "message:32")
        self.conn.commit()

        def fake_analysis(_evidence_path: Path, report_path: Path, _log_path: Path, **_kwargs) -> None:
            report_path.write_text(
                """# Agent 进化分析报告

## 分析范围
本轮时间窗口。

## 证据概览
检测到一次参数错误。

## 优化建议
### 改善工具参数报错
- 现象：同类工具参数错误导致任务失败并触发重试。
- 证据：[event:30] [job:20]
- 根因假设：输入字段校验和修复提示没有共用同一参数契约。
- 调整对象：Agents/.claude/skills/_shared/lib/skill-contracts.mjs
- 具体方案：增加参数校验与可操作错误提示，并让调用模板复用该契约。
- 预期收益：降低同类参数错误和无效重试次数。
- 副作用：旧输入可能需要一次兼容性校验。
- 验收指标：同类失败率下降，历史通过样例保持通过。
- 回滚点：保留当前参数校验实现，发现兼容性问题时恢复旧版本。

## 执行优先级
先验证参数契约。

## 验证与回滚
回归失败率与历史通过样例。
""",
                encoding="utf-8",
            )

        def fake_validation(action: str, **_paths: Path) -> dict:
            self.assertIn(action, {"analysis", "execution"})
            return {"ok": True}

        with patch.object(system_agent_evolution_service, "invoke_evolution_analysis_skill", side_effect=fake_analysis), patch.object(
            system_agent_evolution_service, "run_evolution_validation_tool", side_effect=fake_validation
        ):
            run_system_evolution_analysis(int(run["id"]))
        analyzed = self.conn.execute("SELECT * FROM system_agent_evolution_runs WHERE id = ?", (run["id"],)).fetchone()
        self.assertEqual(analyzed["status"], "awaiting_review")
        self.assertTrue(Path(analyzed["report_path"]).is_file())

        with self.assertRaises(HTTPException) as raised:
            request_system_evolution_execution(self.conn, run=analyzed, actor=actor, requirements=" ")
        self.assertEqual(raised.exception.status_code, 422)

        applying = request_system_evolution_execution(
            self.conn,
            run=analyzed,
            actor=actor,
            requirements="只执行参数校验，保持现有输出协议不变。",
        )
        self.conn.commit()
        self.assertEqual(applying["status"], "applying")

        def fake_execution(
            _evidence_path: Path,
            _report_path: Path,
            _requirements_path: Path,
            execution_report_path: Path,
            _log_path: Path,
            **_kwargs,
        ) -> None:
            execution_report_path.write_text(
                """# 执行记录

## 执行范围

只核对已审批的参数校验建议，未扩大到其他生产模块。

## 实际变更

未修改生产 Skill，因为本次只完成执行链路验证。

## 未执行项及原因

未修改其他 Skill，因为没有获得对应的审批范围和充分证据。

## 指标对照

保留当前失败率和通过样例作为基线，后续执行再比较优化收益。

## 回滚方法

本次无文件改动；后续改动将保留当前版本并按文件恢复。
""",
                encoding="utf-8",
            )

        def fake_verification(run_dir: Path, changed_files: list[str]) -> Path:
            self.assertEqual(changed_files, [])
            path = run_dir / "verification.json"
            path.write_text(
                json.dumps({
                    "status": "passed",
                    "changed_files": changed_files,
                    "commands": [
                        {"command": "npm test", "status": "passed"},
                        {"command": "npm run check", "status": "passed"},
                    ],
                }, ensure_ascii=False),
                encoding="utf-8",
            )
            return path

        with patch.object(system_agent_evolution_service, "invoke_evolution_execution_skill", side_effect=fake_execution), patch.object(
            system_agent_evolution_service, "run_evolution_validation_tool", side_effect=fake_validation
        ), patch.object(system_agent_evolution_service, "_run_evolution_verification", side_effect=fake_verification):
            run_system_evolution_execution(int(run["id"]))
        completed = self.conn.execute("SELECT * FROM system_agent_evolution_runs WHERE id = ?", (run["id"],)).fetchone()
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["execution_requirements"], "只执行参数校验，保持现有输出协议不变。")

    def test_preference_revision_reads_do_not_open_write_transactions(self) -> None:
        self.conn.execute("DELETE FROM writer_preference_profiles WHERE user_id = 2")
        self.conn.commit()

        self.assertEqual(get_profile_revision(self.conn, 2), 0)
        self.assertFalse(self.conn.in_transaction)
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM writer_preference_profiles WHERE user_id = 2"
            ).fetchone()[0],
            0,
        )

    def test_system_evolution_repairs_one_invalid_analysis_before_review(self) -> None:
        actor = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        run = create_system_evolution_run(self.conn, actor=actor)
        self.conn.commit()
        calls = {"analysis": 0}

        def fake_analysis(_evidence_path: Path, report_path: Path, _log_path: Path, **_kwargs) -> None:
            calls["analysis"] += 1
            if calls["analysis"] == 1:
                report_path.write_text("# 不完整报告\n", encoding="utf-8")
                return
            report_path.write_text(
                """# Agent 进化分析报告

## 分析范围

本轮没有足够的失败样本，覆盖范围仅包含空窗口数据。

## 证据概览

没有可用的任务、错误或人工返工证据，不能推断全局问题。

## 优化建议

### 不建议本次修改
- 判断：当前时间窗口没有足够的跨项目证据，不应提出生产 Skill 调整。
- 证据缺口：缺少重复失败、人工返工和质量指标之间的可追溯关联。
- 后续采集：继续收集下一窗口的失败事件、修订记录和成本变化后再分析。

## 执行优先级

本轮不执行改动，优先保证后续证据采集的完整性和可追溯性。

## 验证与回滚

本轮没有发布改动；后续提案须回放样例并保留现有版本作为回滚点。
""",
                encoding="utf-8",
            )

        def fake_validation(action: str, **_paths: Path) -> dict:
            if action == "analysis" and calls["analysis"] == 1:
                raise RuntimeError("进化analysis校验失败：缺少章节")
            return {"ok": True}

        with patch.object(system_agent_evolution_service, "invoke_evolution_analysis_skill", side_effect=fake_analysis), patch.object(
            system_agent_evolution_service, "run_evolution_validation_tool", side_effect=fake_validation
        ):
            run_system_evolution_analysis(int(run["id"]))

        completed = self.conn.execute(
            "SELECT * FROM system_agent_evolution_runs WHERE id = ?", (run["id"],)
        ).fetchone()
        self.assertEqual(completed["status"], "awaiting_review")
        self.assertEqual(calls["analysis"], 2)

    def test_system_evolution_analysis_uses_the_production_validation_script(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        agents_dir = repo_root / "Agents"
        evidence_path = self.data_dir / "validator-evidence.json"
        report_path = self.data_dir / "validator-report.md"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(
            json.dumps({"jobs": [{"ref": "job:20"}], "events": [{"ref": "event:30"}]}, ensure_ascii=False),
            encoding="utf-8",
        )
        report = """# Agent 进化分析报告

## 报告范围与结论

本轮覆盖多个任务和事件，用于核对是否存在可重复的系统问题。

## 证据概览

任务和失败事件均有可追溯编号，能够支撑有限范围的改进判断。

## 优化建议

### 收紧工具参数校验
- 现象：同类参数错误导致任务失败并触发后续重试。
- 证据：[event:30] [job:20]
- 根因假设：输入字段校验与修复提示没有共用同一参数约束。
- 调整对象：Agents/.claude/skills/trial_generate/scripts/check-trial.mjs
- 具体方案：补充参数校验和可操作的修复提示，并复用统一字段约束。
- 预期收益：降低同类参数错误和无效重试次数，缩短任务恢复时间。
- 副作用：历史输入需要进行一次兼容性检查，避免影响现有调用方式。
- 验收指标：相同错误样本能够给出修复提示，历史通过样例继续保持通过。
- 回滚点：保留当前校验版本，发现兼容问题时恢复原有参数处理逻辑。

## 执行优先级

先验证参数校验兼容性，再安排对实际失败样本的回归检查。

## 验证与回滚

回归历史通过样例和失败样例，确认不出现质量或兼容性回退后再保留改动。
"""
        report_path.write_text(
            system_agent_evolution_service._result_markdown(
                json.dumps({"result": report}, ensure_ascii=False)
            ),
            encoding="utf-8",
        )

        with patch.object(system_agent_evolution_service, "settings", SimpleNamespace(agents_dir=agents_dir)):
            result = system_agent_evolution_service.run_evolution_validation_tool(
                "analysis", evidence_path=evidence_path, report_path=report_path
            )

        self.assertTrue(result["ok"])

    def test_failed_system_evolution_verification_restores_skill_tree(self) -> None:
        actor = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        run = create_system_evolution_run(self.conn, actor=actor)
        run_dir = self.data_dir / "agent-evolution" / str(run["id"])
        run_dir.mkdir(parents=True)
        evidence_path = run_dir / "evidence.json"
        report_path = run_dir / "report.md"
        evidence_path.write_text("{}", encoding="utf-8")
        report_path.write_text("# 已审批报告", encoding="utf-8")
        skill_file = self.agents_dir / ".claude" / "skills" / "trial_generate" / "SKILL.md"
        skill_file.parent.mkdir(parents=True, exist_ok=True)
        skill_file.write_text("原始 Skill 内容\n", encoding="utf-8")
        protected_file = (
            self.agents_dir / ".claude" / "skills" / "system-agent-evolution" / "scripts"
            / "evolution-contract-tools.mjs"
        )
        protected_file.parent.mkdir(parents=True, exist_ok=True)
        protected_file.write_text("原始校验工具\n", encoding="utf-8")
        self.conn.execute(
            """
            UPDATE system_agent_evolution_runs
            SET status = 'applying', evidence_path = ?, report_path = ?,
                execution_requirements = '只验证回滚机制'
            WHERE id = ?
            """,
            (str(evidence_path), str(report_path), run["id"]),
        )
        self.conn.commit()

        def fake_execution(
            _evidence_path: Path,
            _report_path: Path,
            _requirements_path: Path,
            execution_report_path: Path,
            _log_path: Path,
            **_kwargs,
        ) -> None:
            skill_file.write_text("错误变更\n", encoding="utf-8")
            protected_file.write_text("错误校验工具变更\n", encoding="utf-8")
            execution_report_path.write_text("# 执行记录\n", encoding="utf-8")

        with patch.object(system_agent_evolution_service, "invoke_evolution_execution_skill", side_effect=fake_execution), patch.object(
            system_agent_evolution_service, "_run_evolution_verification", side_effect=RuntimeError("npm test 失败")
        ):
            run_system_evolution_execution(int(run["id"]))

        completed = self.conn.execute(
            "SELECT * FROM system_agent_evolution_runs WHERE id = ?", (run["id"],)
        ).fetchone()
        self.assertEqual(completed["status"], "execution_failed")
        self.assertEqual(skill_file.read_text(encoding="utf-8"), "原始 Skill 内容\n")
        self.assertEqual(protected_file.read_text(encoding="utf-8"), "原始校验工具\n")

    def test_evolution_analysis_is_single_shot_and_uses_evidence_allowlist(self) -> None:
        skill_path = (
            self.agents_dir / ".claude" / "skills" / "system-agent-evolution" / "SKILL.md"
        )
        skill_path.parent.mkdir(parents=True)
        skill_path.write_text("# 分析规则\n\n每个建议必须有证据。\n", encoding="utf-8")
        contract_path = skill_path.parent / "contracts" / "report-contract.json"
        contract_path.parent.mkdir(parents=True)
        contract_path.write_text(
            json.dumps({
                "required_headings": ["分析范围", "证据概览", "优化建议", "执行优先级", "验证与回滚"],
                "recommendation_fields": ["现象", "证据", "根因假设", "调整对象", "具体方案", "预期收益", "副作用", "验收指标", "回滚点"],
                "no_change_fields": ["判断", "证据缺口", "后续采集"],
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        evidence_path = self.data_dir / "evidence.json"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(
            json.dumps({"jobs": [{"ref": "job:20"}], "note": "[event:999] 不是可用引用"}, ensure_ascii=False),
            encoding="utf-8",
        )
        report_path = self.data_dir / "report.md"
        log_path = self.data_dir / "analysis.log"
        response = SimpleNamespace(
            stdout=json.dumps({"result": "```markdown\n# 报告\n\n[job:20]\n```"}, ensure_ascii=False)
        )

        with patch.object(system_agent_evolution_service, "run_ai_skill", return_value=response) as mocked:
            system_agent_evolution_service.invoke_evolution_analysis_skill(
                evidence_path, report_path, log_path
            )

        prompt = mocked.call_args.args[0]
        allowlist = prompt.split("<allowed_evidence_refs>", 1)[1].split(
            "</allowed_evidence_refs>", 1
        )[0]
        self.assertIn('"job:20"', allowlist)
        self.assertNotIn("event:999", allowlist)
        self.assertIn("<report_output_contract>", prompt)
        self.assertIn("## 分析范围", prompt)
        self.assertTrue(mocked.call_args.kwargs["disable_tools"])
        self.assertFalse(mocked.call_args.kwargs["persist_session"])
        self.assertEqual(mocked.call_args.kwargs["runtime_log_path"], self.data_dir / "analysis.jsonl")
        self.assertEqual(mocked.call_args.kwargs["runtime_id"], "agent-evolution-data")
        self.assertEqual(report_path.read_text(encoding="utf-8"), "# 报告\n\n[job:20]\n")

    def test_streamed_evolution_result_is_parsed_from_zdebug_output(self) -> None:
        stdout = "\n".join([
            json.dumps({"type": "zdebug_heartbeat", "silence_ms": 1000}),
            json.dumps({"type": "result", "result": "# 报告\n\n正文"}, ensure_ascii=False),
        ])

        self.assertEqual(system_agent_evolution_service._result_markdown(stdout), "# 报告\n\n正文\n")

    def test_evolution_result_normalizes_the_known_analysis_heading_alias(self) -> None:
        stdout = json.dumps({
            "result": "# Agent 进化分析报告\n\n## 报告范围与结论\n\n本轮样本范围和总体结论。"
        }, ensure_ascii=False)

        result = system_agent_evolution_service._result_markdown(stdout)

        self.assertIn("## 分析范围", result)
        self.assertNotIn("## 报告范围与结论", result)

    def test_system_skill_prompts_embed_sop_and_limit_write_capabilities(self) -> None:
        preference_skill = self.agents_dir / ".claude" / "skills" / "preference-summary" / "SKILL.md"
        evolution_skill = self.agents_dir / ".claude" / "skills" / "system-agent-evolution" / "SKILL.md"
        preference_skill.parent.mkdir(parents=True, exist_ok=True)
        evolution_skill.parent.mkdir(parents=True, exist_ok=True)
        preference_skill.write_text("# 偏好 SOP\n\n只能写结果文件。\n", encoding="utf-8")
        evolution_skill.write_text("# 进化 SOP\n\n后端负责验证。\n", encoding="utf-8")

        evidence_path = self.data_dir / "prompt-evidence.json"
        output_path = self.data_dir / "prompt-result.json"
        report_path = self.data_dir / "approved-report.md"
        requirements_path = self.data_dir / "requirements.md"
        execution_path = self.data_dir / "execution.md"
        log_path = self.data_dir / "prompt.log"
        for file_path in [evidence_path, report_path, requirements_path]:
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text("{}\n", encoding="utf-8")

        with patch.object(preference_summary_service, "run_ai_skill") as preference_run:
            preference_summary_service.invoke_preference_summary_skill(
                evidence_path, output_path, log_path
            )
        preference_prompt = preference_run.call_args.args[0]
        self.assertIn("<skill_instructions>", preference_prompt)
        self.assertIn("只能写结果文件", preference_prompt)
        self.assertEqual(preference_run.call_args.kwargs["tools"], "Read,Edit,Write")

        with patch.object(system_agent_evolution_service, "run_ai_skill") as evolution_run:
            system_agent_evolution_service.invoke_evolution_execution_skill(
                evidence_path, report_path, requirements_path, execution_path, log_path
            )
        evolution_prompt = evolution_run.call_args.args[0]
        self.assertIn("<skill_instructions>", evolution_prompt)
        self.assertIn("后端负责验证", evolution_prompt)
        self.assertIn("除执行记录输出文件外", evolution_prompt)
        self.assertEqual(evolution_run.call_args.kwargs["tools"], "Read,Edit,Write")

    def test_failed_evolution_run_can_be_retried_in_place(self) -> None:
        actor = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        run = create_system_evolution_run(self.conn, actor=actor)
        self.conn.execute(
            """
            UPDATE system_agent_evolution_runs
            SET status = 'failed', evidence_path = 'old-evidence.json',
                report_path = 'old-report.md', report_sha256 = 'old-digest',
                error_message = '上游请求超时', analysis_started_at = CURRENT_TIMESTAMP,
                analysis_completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (run["id"],),
        )
        self.conn.commit()
        failed = self.conn.execute(
            "SELECT * FROM system_agent_evolution_runs WHERE id = ?", (run["id"],)
        ).fetchone()

        retried = retry_system_evolution_run(self.conn, run=failed, actor=actor)

        self.assertEqual(retried["id"], run["id"])
        self.assertEqual(retried["status"], "queued")
        self.assertEqual(retried["range_end"], run["range_end"])
        self.assertIsNone(retried["evidence_path"])
        self.assertIsNone(retried["report_path"])
        self.assertIsNone(retried["error_message"])
        self.assertIsNone(retried["analysis_started_at"])
        audit = self.conn.execute(
            "SELECT action, details_json FROM audit_logs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(audit["action"], "agent_evolution.retry")
        self.assertEqual(json.loads(audit["details_json"])["range_end"], run["range_end"])


if __name__ == "__main__":
    unittest.main()
