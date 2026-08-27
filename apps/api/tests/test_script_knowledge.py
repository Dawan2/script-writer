from __future__ import annotations

import hashlib
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import UploadFile

from app.db import session
from app.services import script_knowledge_service, script_library_service
from app.services.auth_service import create_user, get_user_by_username


def _formula_candidate() -> dict:
    return {
        "candidate_id": "F01",
        "category": "hook_information",
        "name": "公开立场后的分层证据反转",
        "stages": ["trial_generate", "full_generate"],
        "usage_scenario": "当剧本写作需要让一次公开反转同时改变现场判断和后续行动时。",
        "not_applicable": ["反转仅用于留下疑问而不在当前场景兑现。"],
        "creative_decision": "当剧本写作需要让一次公开反转同时改变现场判断和后续行动时。",
        "creative_problem": "当剧本写作需要让一次公开反转同时改变现场判断和后续行动时。",
        "goal": "让证据同时改变现场结论、双方权力和下一步行动目标。",
        "core_formula": "先让对手为错误的公开判断承担撤回成本，再用分层出现的可验证信息更新现场判断，最终让新结论当场转移资源或行动权。",
        "conditions": ["对手已经在公开场合锁定立场", "主角拥有可以被现场核验的信息"],
        "variables": ["公开裁判场", "可核验证据", "对手的锁定立场", "反转后的行动权"],
        "steps": ["先让对手当众给出不能轻易撤回的判断。", "再按影响范围从小到大展示可验证信息。", "最后让新结论立即改变一项资源或行动权。"],
        "mechanism": "对手公开立场后承担了撤回成本，而分层证据让观众在每一步都能更新判断，最终的资源变化使反转不会停留在口头。",
        "expected_effect": "让证据同时改变现场结论、双方权力和下一步行动目标。",
        "observable_checks": ["每层信息都改变了至少一个人的判断或行动。", "反转后有可见的资源、关系或权力变化。"],
        "failure_modes": ["证据无法被现场独立核验时，公开反转会缺乏可信度。", "后续证据只重复证明同一件事时，会变成拖延。"],
        "rewrite_usage": "保留原剧的对立关系和主线结果，只检查原有证据揭示是否逐步改变局势，补足缺失的行动后果。",
        "original_usage": "先为新人物设计一个有明确裁判规则的公开场，再为证据安排不同功能和对应的新行动后果。",
        "genre_adaptations": [{
            "tags": ["现代言情", "女频"],
            "difference": "回报重点是主角收回关系中的话语权和选择权，不是只让对手丢脸。",
            "usage_adjustment": "让证据直接解除一项关系束缚，并为主角创造新选择。",
            "boundary_adjustment": "不能用男性角色的后悔代替女主的实际权力变化。",
        }],
        "applicable_tags": ["现代言情", "追妻火葬场", "现代", "女频"],
        "observation_refs": ["O01"],
        "evidence_references": ["C0001", "C0002"],
        "catalog_decision": {"action": "unresolved", "target_id": "", "reason": "待与公共公式比较后再决定归档方式。"},
        "maturity": "single_case",
    }


class ScriptKnowledgeTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=root / "data",
            database_path=root / "data" / "app.db",
            repo_root=root,
            agents_dir=root / "Agents",
            workspaces_dir=root / "Agents" / "workspaces",
            upload_dir=root / "data" / "uploads",
        )
        self.settings.agents_dir.mkdir(parents=True)
        self.session_patch = patch.object(session, "settings", self.settings)
        self.library_patch = patch.object(script_library_service, "settings", self.settings)
        self.session_patch.start()
        self.library_patch.start()
        session.init_db()
        self.conn = session.get_connection()
        create_user(self.conn, username="admin", password="admin-password", display_name="管理员", role="admin")
        self.admin = get_user_by_username(self.conn, "admin")

    def tearDown(self):
        self.conn.close()
        self.library_patch.stop()
        self.session_patch.stop()
        self.temp_dir.cleanup()

    def _script(self):
        text = "# 证据之后\n\n第1集\n林夏与顾沉在星河集团的股东会对峙。\n" + "林夏公开证据后收回项目决策权。\n" * 100
        upload = UploadFile(filename="证据之后.md", file=io.BytesIO(text.encode("utf-8")))
        script_id = script_library_service.create_uploaded_script(self.conn, actor=self.admin, upload=upload)["script"]["id"]
        script = self.conn.execute("SELECT * FROM script_library_scripts WHERE id = ?", (script_id,)).fetchone()
        return script

    def test_distillation_uses_indexed_source_digest(self):
        script = self._script()
        indexed_source, valid_ids = script_library_service._indexed_source(self.conn, int(script["id"]))
        digest = script_library_service._indexed_source_content_hash(self.conn, int(script["id"]))

        self.assertEqual(len(digest), 64)
        canonical = "\n\n".join(
            item.strip()
            for item in re.findall(
                r"<!--\s*C\d{4,}\s*\|.*?-->\s*\n(.*?)(?=<!--\s*C\d{4,}\s*\||\Z)",
                indexed_source,
                flags=re.S,
            )
        )
        self.assertEqual(digest, hashlib.sha256(canonical.encode("utf-8")).hexdigest())
        self.assertEqual(
            digest,
            script_library_service._indexed_source_content_hash(self.conn, int(script["id"])),
        )
        self.assertGreater(len(valid_ids), 0)

    def test_usage_scenario_allows_declarative_how_phrase(self):
        candidate = _formula_candidate()
        scenario = "当人物小传需要说明身份规则如何持续改变角色选择时。"
        candidate["usage_scenario"] = scenario
        candidate["creative_decision"] = scenario
        candidate["creative_problem"] = scenario

        normalized = script_knowledge_service._normalize_formula_card(
            candidate,
            forbidden_terms=[],
            label="公式候选",
        )

        self.assertEqual(normalized["usage_scenario"], scenario)

    def test_principle_curation_only_exposes_same_stage_candidates(self):
        observation = {
            "observation_id": "P03",
            "stages": ["outline_rewrite"],
            "statement": "当反转推进主要冲突时，应让结果改变后续行动条件。",
            "relation": "supports",
            "rationale": "只有局势发生可见变化，后续选择才会承接前一轮结果。",
            "applies_when": ["故事仍需要继续推进时。"],
            "fails_or_changes_when": ["反转只负责留下疑问时。"],
            "review_criteria": ["后续行动是否继承了新状态。"],
            "related_formula_candidate_ids": [],
            "evidence_references": ["C0001"],
            "catalog_decision": {"action": "unresolved", "target_id": "", "reason": "待整理。"},
            "status": "candidate_only",
        }
        outline_principle = {
            "id": "principle-outline",
            "name": "结果必须改变后续行动条件",
            "stages": ["outline_rewrite"],
            "statement": "阶段结果必须改变后续行动条件。",
            "rationale": "让后续行动承接已经发生的变化。",
            "applies_when": ["阶段目标已经得出结果时。"],
            "fails_or_changes_when": ["故事已经结束时。"],
            "review_criteria": ["资源、关系或权限是否改变。"],
            "function": "结果必须改变后续行动条件。",
            "trigger": "阶段目标已经得出结果时。",
            "payoff": "让后续行动承接已经发生的变化。",
            "transferable_strategy": "检查资源、关系或权限变化。",
            "failure_boundary": "故事已经结束时。",
        }
        character_principle = {
            **outline_principle,
            "id": "principle-character",
            "name": "人物变化必须由选择证明",
            "stages": ["character_rewrite"],
        }

        payload, retrieved = script_knowledge_service._prepare_principle_curation_input(
            [observation],
            [character_principle, outline_principle],
        )

        public_observation = payload["observations"][0]
        self.assertEqual(payload["curation_version"], "principle-library-v3")
        self.assertEqual(public_observation["retrieved_principle_ids"], ["principle-outline"])
        self.assertEqual(
            [item["id"] for item in public_observation["retrieved_principles"]],
            ["principle-outline"],
        )
        self.assertEqual(retrieved, {"P03": {"principle-outline"}})
        self.assertNotIn("retrieved_principles", payload)

    def test_principle_curation_error_identifies_invalid_and_allowed_ids(self):
        with self.assertRaises(RuntimeError) as raised:
            script_knowledge_service._validate_principle_curation(
                {
                    "operations": [{
                        "observation_ids": ["P03"],
                        "action": "bound",
                        "principle_id": "principle-from-another-observation",
                        "reason": "这条原则语义相近，但并不属于当前观察的候选范围。",
                    }],
                },
                observations=[{"observation_id": "P03"}],
                retrieved_by_observation={"P03": {"principle-allowed"}},
                existing_ids={"principle-allowed", "principle-from-another-observation"},
            )

        message = str(raised.exception)
        self.assertIn("观察 P03", message)
        self.assertIn("principle-from-another-observation", message)
        self.assertIn("principle-allowed", message)
        self.assertIn("改用 propose 并清空 principle_id", message)

    def test_formula_and_principle_are_shared_cards_with_source_links(self):
        script = self._script()
        candidate = _formula_candidate()
        result = {
            "summary": "主角在公开场合被错误定性后，通过分层公开可核验证据，收回了项目决策权，也改变了原本失衡的关系。",
            "tags": {"theme": ["现代言情"], "setting": ["追妻火葬场"], "background": ["现代", "都市"], "audience": ["女频"]},
            "case_card": {"logline": "主角用可核验证据收回项目决策权。"},
            "formula_candidates": [candidate],
            "no_formula_reason": "",
            "principle_observations": [{
                "observation_id": "P01",
                "stages": ["trial_generate"],
                "statement": "当反转承担场景高潮时，应让新信息产生一个不可撤回的行动后果。",
                "relation": "proposes",
                "rationale": "可见后果能确认反转真正改变了人物手中的资源和后续选择。",
                "applies_when": ["场景的核心任务是用新信息改变当前判断。"],
                "fails_or_changes_when": ["场景只需要留下疑问而不需要立即兑现时，可以延后行动后果。"],
                "review_criteria": ["反转后至少一个人的行动权、资源或关系状态已经改变。"],
                "related_formula_candidate_ids": ["F01"],
                "evidence_references": ["C0001"],
            }],
            "no_principle_reason": "",
        }
        script_knowledge_service.save_distillation(self.conn, script, result)
        formula_curation = {
            "operations": [{
                "candidate_ids": ["F01"],
                "action": "create",
                "formula_id": "",
                "reason": "公式库为空，且该写法有完整的使用条件、执行步骤和失效边界。",
                "card": {key: candidate[key] for key in script_knowledge_service.FORMULA_CARD_FIELDS},
            }]
        }
        formula_summary = script_knowledge_service.apply_formula_curation(
            self.conn,
            script_id=int(script["id"]),
            result=result,
            curation=formula_curation,
        )
        principle_summary = script_knowledge_service.apply_principle_curation(
            self.conn,
            script_id=int(script["id"]),
            result=result,
            curation={"operations": [{
                "observation_ids": ["P01"],
                "action": "propose",
                "principle_id": "",
                "reason": "当前原则库为空，先保留为待审核候选。",
                "title": "反转需要产生行动后果",
            }]},
            candidate_to_formula=formula_summary["candidate_to_formula"],
        )

        formulas, principles = script_knowledge_service.cards_for_script(self.conn, int(script["id"]))
        self.assertEqual(len(formulas), 1)
        self.assertEqual(formulas[0]["title"], candidate["name"])
        self.assertEqual(formulas[0]["content"]["steps"], candidate["steps"])
        self.assertEqual(formulas[0]["usage_scenario"], candidate["usage_scenario"])
        self.assertEqual(formulas[0]["core_formula"], candidate["core_formula"])
        self.assertEqual(formulas[0]["source_count"], 1)
        self.assertEqual(len(principles), 1)
        self.assertEqual(principles[0]["status"], "candidate")
        self.assertEqual(principles[0]["content"]["observations"][0]["related_formula_ids"], formula_summary["formula_ids"])
        self.assertEqual(principle_summary["actions"]["propose"], 1)

        listed = script_library_service.list_formula_cards(self.conn, card_kind="formula", formula_type="hook_information")
        principle_list = script_library_service.list_formula_cards(self.conn, card_kind="principle")
        matching_principles = script_library_service.list_formula_cards(
            self.conn,
            card_kind="principle",
            stage="trial_generate",
            verification_status="candidate",
        )
        unmatched_principles = script_library_service.list_formula_cards(
            self.conn,
            card_kind="principle",
            stage="world_view",
        )
        matching_formulas = script_library_service.list_formula_cards(
            self.conn,
            card_kind="formula",
            stage="trial_generate",
            verification_status="candidate",
        )
        unmatched_formulas = script_library_service.list_formula_cards(
            self.conn,
            card_kind="formula",
            stage="world_view",
        )
        self.assertEqual(listed["pagination"]["total"], 1)
        self.assertEqual(principle_list["pagination"]["total"], 1)
        self.assertEqual(matching_principles["pagination"]["total"], 1)
        self.assertEqual(unmatched_principles["pagination"]["total"], 0)
        self.assertEqual(matching_formulas["pagination"]["total"], 1)
        self.assertEqual(unmatched_formulas["pagination"]["total"], 0)
        # Facet counts ignore the facet currently being edited while keeping
        # the other selection, so the two dropdowns stay linked.
        self.assertEqual(matching_principles["filter_counts"]["stage"]["trial_generate"], 1)
        self.assertEqual(matching_principles["filter_counts"]["status"]["candidate"], 1)
        self.assertEqual(matching_principles["filter_counts"]["status"]["active"], 0)
        self.assertEqual(matching_formulas["filter_counts"]["stage"]["trial_generate"], 1)
        self.assertEqual(matching_formulas["filter_counts"]["status"]["candidate"], 1)
        self.assertEqual(unmatched_formulas["filter_counts"]["stage"]["trial_generate"], 1)
        self.assertEqual(script_library_service.list_scripts(self.conn)["stats"]["formula_cards"], 1)
        self.assertEqual(script_library_service.list_scripts(self.conn)["stats"]["principle_cards"], 1)

    def test_formula_curation_retries_with_error_and_reuses_prior_job_checkpoint(self):
        script = self._script()
        candidate = _formula_candidate()
        result = {
            "case_card": {"source_specific_terms": ["林夏"]},
            "formula_candidates": [candidate],
        }
        response_operation = {
            "candidate_ids": ["F01"],
            "action": "create",
            "formula_id": "",
            "reason": "现有公式库没有覆盖这条完整的因果和执行步骤。",
            **{key: candidate[key] for key in script_knowledge_service.FORMULA_CARD_FIELDS},
        }
        response = json.dumps({"operations": [response_operation]}, ensure_ascii=False)
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as retry_dir:
            prompts = []

            def fail_once_then_succeed(**kwargs):
                prompts.append(kwargs["user_prompt"])
                if len(prompts) == 1:
                    raise RuntimeError("上游模型连接中断")
                return response

            with patch.object(script_knowledge_service, "call_direct_model", side_effect=fail_once_then_succeed), patch.object(
                script_knowledge_service, "direct_skill_system_prompt", return_value="独立技能"
            ):
                first = script_knowledge_service.invoke_formula_curation(
                    conn=self.conn,
                    result=result,
                    work_dir=Path(first_dir),
                    model_runtime={"api_key": "test", "model_name": "test"},
                )

            self.assertEqual(first["operations"][0]["action"], "create")
            self.assertEqual(len(prompts), 2)
            self.assertIn("上游模型连接中断", prompts[1])

            with patch.object(script_knowledge_service, "call_direct_model", side_effect=AssertionError("不应重复调用")), patch.object(
                script_knowledge_service, "direct_skill_system_prompt", return_value="独立技能"
            ):
                reused = script_knowledge_service.invoke_formula_curation(
                    conn=self.conn,
                    result=result,
                    work_dir=Path(retry_dir),
                    model_runtime={"api_key": "test", "model_name": "test"},
                    previous_work_dirs=[Path(first_dir)],
                )

            self.assertEqual(reused, first)


if __name__ == "__main__":
    unittest.main()
