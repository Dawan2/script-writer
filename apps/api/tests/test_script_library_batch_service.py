from __future__ import annotations

import hashlib
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.db import session
from app.services import script_library_batch_service as batch


class ScriptLibraryBatchServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=self.root / "data",
            database_path=self.root / "data" / "app.db",
            script_distillation_max_parallel=3,
        )
        self.session_patch = patch.object(session, "settings", self.settings)
        self.batch_settings_patch = patch.object(batch, "settings", self.settings)
        self.session_patch.start()
        self.batch_settings_patch.start()
        session.init_db()
        self.conn = session.get_connection()

    def tearDown(self) -> None:
        self.conn.close()
        self.batch_settings_patch.stop()
        self.session_patch.stop()
        self.temp_dir.cleanup()

    def _insert_script(self, script_id: int, *, complete: bool = True) -> None:
        card = {"story_engine": {"initial_situation": f"剧本 {script_id}"}} if complete else {}
        self.conn.execute(
            """
            INSERT INTO script_library_scripts (
                id, title, source_type, original_filename, source_file_path,
                source_sha256, status, case_card_json, distillation_mode
            ) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, 'batch_case')
            """,
            (
                script_id,
                f"剧本 {script_id}",
                f"{script_id}.md",
                str(self.root / f"{script_id}.md"),
                hashlib.sha256(str(script_id).encode()).hexdigest(),
                "processing" if complete else "queued",
                json.dumps(card, ensure_ascii=False),
            ),
        )
        self.conn.commit()

    @staticmethod
    def _formula(formula_id: str = "") -> dict:
        return {
            "candidate_id": "F01",
            "formula_id": formula_id,
            "name": "证据公开后的权力转移",
            "category": "scene_conflict",
            "stages": ["trial_generate"],
            "usage_scenario": "当剧本写作需要让新证据立即改变场景中的行动权归属时。",
            "not_applicable": ["当前场景只需要留下疑问而不需要当场兑现。"],
            "creative_decision": "当剧本写作需要让新证据立即改变场景中的行动权归属时。",
            "creative_problem": "当剧本写作需要让新证据立即改变场景中的行动权归属时。",
            "goal": "让观众在同一场戏中同时看到真相公开和权力状态改变。",
            "core_formula": "错误的公开判断 → 可核验的新证据 → 不可撤回的行动权转移。",
            "conditions": ["场景高潮依靠新信息完成反转"],
            "variables": ["证据类型", "权力资源"],
            "steps": ["先建立一个错误的公共判断", "再公开可核验证据并立即触发行动"],
            "mechanism": "新信息与不可撤回的行动后果连续发生，观众才能确认反转已经改变故事状态。",
            "expected_effect": "让观众在同一场戏中同时看到真相公开和权力状态改变。",
            "observable_checks": ["反转后至少一人的行动权已经改变"],
            "failure_modes": ["只解释真相却没有任何人付诸行动"],
            "rewrite_usage": "保留原剧的反转事实，补足证据公开后对当场关系和后续选择的影响。",
            "original_usage": "先设计一个可见的错判局面，再让证据与权力转移在同一场戏内完成。",
            "genre_adaptations": [{
                "tags": ["现代"],
                "difference": "证据更多依靠现代组织规则完成公开验证。",
                "usage_adjustment": "让转移的资源与职位、决策权或社会信用相关。",
                "boundary_adjustment": "如果组织规则无法支持当场转移，应延后兑现而不强行反转。",
            }],
            "source_script_ids": [1, 2],
            "observation_refs": ["script:1", "script:2"],
        }

    @staticmethod
    def _principle(principle_id: str) -> dict:
        return {
            "candidate_id": "P01",
            "principle_id": principle_id,
            "title": "反转必须产生行动后果",
            "stages": ["trial_generate"],
            "statement": "当新信息承担场景高潮时，应让它立即产生不可撤回的行动后果。",
            "rationale": "可见的后果能确认反转真正改变了人物手中的资源和后续选择。",
            "applies_when": ["场景任务是用新信息改变当前判断"],
            "fails_or_changes_when": ["场景只需留下疑问而不需立即兑现"],
            "review_criteria": ["反转后至少一人的行动权或关系状态已改变"],
            "source_script_ids": [1, 2],
            "related_formula_ids": [],
            "evidence_references": ["script:1", "script:2"],
        }

    def test_invalid_checkpoint_is_not_reused_and_valid_result_replaces_it(self) -> None:
        payload = {"cases": [1]}
        output_path = self.root / "checkpoint.json"
        fingerprint = hashlib.sha256(batch._json(payload).encode("utf-8")).hexdigest()
        output_path.write_text(json.dumps({
            "input_fingerprint": fingerprint,
            "result": {"formulas": []},
        }), encoding="utf-8")

        def validate(value: dict) -> dict:
            if set(value) != {"formula_candidates"}:
                raise RuntimeError("顶层字段无效")
            return value

        with patch.object(batch, "direct_skill_system_prompt", return_value="prompt"), patch.object(
            batch, "call_direct_model", return_value='{"formula_candidates":[]}'
        ) as model_call:
            result = batch._call_batch_stage(
                skill_name="skill",
                task_name="task",
                payload=payload,
                runtime={},
                output_path=output_path,
                max_tokens=100,
                output_contract="contract",
                validator=validate,
            )

        self.assertEqual(result, {"formula_candidates": []})
        model_call.assert_called_once()
        self.assertEqual(json.loads(output_path.read_text())["result"], result)

    def test_checkpoint_is_not_saved_before_validation_passes(self) -> None:
        output_path = self.root / "invalid.json"
        with patch.object(batch, "direct_skill_system_prompt", return_value="prompt"), patch.object(
            batch, "call_direct_model", return_value="{}"
        ) as model_call:
            with self.assertRaisesRegex(RuntimeError, "未通过校验"):
                batch._call_batch_stage(
                    skill_name="skill",
                    task_name="task",
                    payload={},
                    runtime={},
                    output_path=output_path,
                    max_tokens=100,
                    output_contract="contract",
                    validator=lambda _: (_ for _ in ()).throw(RuntimeError("无效输出")),
                )

        self.assertEqual(model_call.call_count, batch.MODEL_VALIDATION_ATTEMPTS)
        self.assertFalse(output_path.exists())

    def test_checkpoint_is_invalidated_when_skill_prompt_changes(self) -> None:
        output_path = self.root / "skill-version.json"

        def validate(value: dict) -> dict:
            if set(value) != {"formula_candidates"}:
                raise RuntimeError("顶层字段无效")
            return value

        with patch.object(
            batch,
            "direct_skill_system_prompt",
            side_effect=["prompt-v1", "prompt-v2"],
        ), patch.object(
            batch,
            "call_direct_model",
            return_value='{"formula_candidates":[]}',
        ) as model_call:
            for _ in range(2):
                batch._call_batch_stage(
                    skill_name="skill",
                    task_name="task",
                    payload={"cases": [1]},
                    runtime={},
                    output_path=output_path,
                    max_tokens=100,
                    output_contract="contract",
                    validator=validate,
                )

        self.assertEqual(model_call.call_count, 2)

    def test_validation_repairs_keep_using_the_selected_model(self) -> None:
        output_path = self.root / "repaired.json"
        runtime = {
            "model_name": "selected-model",
            "fallback": {"model_name": "fallback-model"},
        }
        responses = ["{}", "{}", '{"formula_candidates":[]}']
        observed_models: list[str] = []

        def call_model(**kwargs):
            observed_models.append(kwargs["runtime"]["model_name"])
            return responses.pop(0)

        def validate(value: dict) -> dict:
            if set(value) != {"formula_candidates"}:
                raise RuntimeError("顶层字段无效")
            return value

        with patch.object(batch, "direct_skill_system_prompt", return_value="prompt"), patch.object(
            batch, "call_direct_model", side_effect=call_model
        ):
            result = batch._call_batch_stage(
                skill_name="skill",
                task_name="task",
                payload={},
                runtime=runtime,
                output_path=output_path,
                max_tokens=100,
                output_contract="contract",
                validator=validate,
            )

        self.assertEqual(result, {"formula_candidates": []})
        self.assertEqual(observed_models, ["selected-model"] * batch.MODEL_VALIDATION_ATTEMPTS)

    def test_formula_deidentification_allows_reusable_tags_but_rejects_source_terms_in_prose(self) -> None:
        formula = self._formula()
        formula["genre_adaptations"][0]["tags"] = ["先婚后爱"]

        normalized = batch._normalize_formula_card(
            formula,
            forbidden_terms=["先婚后爱"],
            label="批量公式候选",
        )

        self.assertEqual(normalized["genre_adaptations"][0]["tags"], ["先婚后爱"])
        formula["genre_adaptations"][0]["difference"] = "林夏在原剧中的具体经历不能直接作为题材差异。"
        with self.assertRaisesRegex(RuntimeError, "林夏"):
            batch._normalize_formula_card(
                formula,
                forbidden_terms=["林夏"],
                label="批量公式候选",
            )

    def test_formula_rejects_mixed_stage_granularity(self) -> None:
        formula = self._formula()
        formula["stages"] = ["outline_rewrite", "trial_generate"]

        with self.assertRaisesRegex(RuntimeError, "横跨了不同创作粒度"):
            batch._normalize_formula_card(formula, forbidden_terms=[], label="批量公式候选")

    def test_formula_rejects_adaptation_tags_outside_taxonomy(self) -> None:
        formula = self._formula()
        formula["genre_adaptations"][0]["tags"] = ["都市职场"]

        with self.assertRaisesRegex(RuntimeError, "标签体系之外"):
            batch._normalize_formula_card(formula, forbidden_terms=[], label="批量公式候选")

    def test_worldbuilding_category_alias_is_normalized(self) -> None:
        formula = self._formula()
        formula["category"] = "worldbuilding"
        formula["stages"] = ["world_view"]

        normalized = batch._normalize_formula_card(
            formula,
            forbidden_terms=[],
            label="批量公式候选",
        )

        self.assertEqual(normalized["category"], "world_rule")

    def test_formula_merge_only_receives_principles_for_its_stages(self) -> None:
        principles = [
            {"principle_id": "world", "stages": ["world_view"]},
            {"principle_id": "trial", "stages": ["trial_generate"]},
            {"principle_id": "shared", "stages": ["trial_generate", "full_generate"]},
        ]

        selected = batch._principles_for_formula_stages(
            principles,
            ("trial_generate", "full_generate"),
        )

        self.assertEqual([item["principle_id"] for item in selected], ["trial", "shared"])

    def test_formula_rejects_ambiguous_usage_scenario(self) -> None:
        formula = self._formula()
        formula["usage_scenario"] = "如何在当前场景中让证据改变行动权？"
        formula["creative_decision"] = formula["usage_scenario"]
        formula["creative_problem"] = formula["usage_scenario"]

        with self.assertRaisesRegex(RuntimeError, "不能写成问题"):
            batch._normalize_formula_card(formula, forbidden_terms=[], label="批量公式候选")

    def test_batch_formula_fills_storage_compatibility_fields(self) -> None:
        formula = self._formula()
        formula.pop("creative_decision")
        formula.pop("creative_problem")
        formula.pop("expected_effect")

        normalized = batch._normalize_formula_card(formula, forbidden_terms=[], label="批量公式候选")

        self.assertEqual(normalized["creative_decision"], formula["usage_scenario"])
        self.assertEqual(normalized["creative_problem"], formula["usage_scenario"])
        self.assertEqual(normalized["expected_effect"], formula["goal"])

    def test_refinement_draft_allows_one_source_and_preserves_it_exactly(self) -> None:
        formula = self._formula()
        formula.update({
            "candidate_id": "R01_old",
            "observation_refs": ["old:formula-old"],
        })

        normalized = batch._validate_refinement_batch(
            {"formula_candidates": [formula]},
            allowed_ids={1},
            old_formula_ids={"formula-old"},
            source_ids_by_old_formula={"formula-old": {1}},
            tags_by_old_formula={"formula-old": {"现代"}},
            expected_candidate_ids={"R01_old": "formula-old"},
            minimum_sources=1,
        )

        self.assertEqual(normalized[0]["source_script_ids"], [1])

    def test_refinement_reports_all_invalid_adaptation_tags_together(self) -> None:
        first = self._formula()
        first.update({
            "candidate_id": "R01_old",
            "observation_refs": ["old:formula-one"],
        })
        first["genre_adaptations"][0]["tags"] = ["现代豪门"]
        second = json.loads(json.dumps(first, ensure_ascii=False))
        second.update({
            "candidate_id": "R02_old",
            "observation_refs": ["old:formula-two"],
        })
        second["genre_adaptations"][0]["tags"] = ["重组家庭"]

        with self.assertRaises(RuntimeError) as raised:
            batch._validate_refinement_batch(
                {"formula_candidates": [first, second]},
                allowed_ids={1, 2},
                old_formula_ids={"formula-one", "formula-two"},
                source_ids_by_old_formula={"formula-one": {1}, "formula-two": {2}},
                tags_by_old_formula={"formula-one": {"现代"}, "formula-two": {"现代"}},
                minimum_sources=1,
            )

        self.assertIn("现代豪门", str(raised.exception))
        self.assertIn("重组家庭", str(raised.exception))

    def test_refinement_rebuilds_sources_from_old_formula_relations(self) -> None:
        formula = self._formula()
        formula.update({
            "candidate_id": "R01_old",
            "source_script_ids": [1, 3],
            "observation_refs": ["old:formula-old"],
        })

        normalized = batch._validate_refinement_batch(
            {"formula_candidates": [formula]},
            allowed_ids={1, 2},
            old_formula_ids={"formula-old"},
            source_ids_by_old_formula={"formula-old": {1, 2}},
            tags_by_old_formula={"formula-old": {"现代"}},
            expected_candidate_ids={"R01_old": "formula-old"},
            minimum_sources=1,
        )

        self.assertEqual(normalized[0]["source_script_ids"], [1, 2])

    def test_final_principle_requires_two_formula_sources(self) -> None:
        principle = self._principle("")
        principle["related_formula_ids"] = ["formula-one"]

        with self.assertRaisesRegex(RuntimeError, "2 张不同公式"):
            batch._validate_principles(
                {"principle_candidates": [principle]},
                {1, 2},
                {},
                minimum_sources=2,
                allowed_formula_ids={"formula-one", "formula-two"},
                minimum_formula_sources=2,
            )

        principle["related_formula_ids"].append("formula-two")
        normalized = batch._validate_principles(
            {"principle_candidates": [principle]},
            {1, 2},
            {},
            minimum_sources=2,
            allowed_formula_ids={"formula-one", "formula-two"},
            minimum_formula_sources=2,
        )
        self.assertEqual(normalized[0]["related_formula_ids"], ["formula-one", "formula-two"])

    def test_principle_evidence_is_kept_with_its_script(self) -> None:
        references = ["script:1:O01", "2/O03", "observation:2/O04"]

        self.assertEqual(batch._principle_evidence_for_script(references, 1), ["script:1:O01"])
        self.assertEqual(
            batch._principle_evidence_for_script(references, 2),
            ["2/O03", "observation:2/O04"],
        )
        self.assertEqual(batch._principle_evidence_for_script(references, 3), ["script:3"])

    def test_refinement_uses_controlled_tags_from_linked_scripts(self) -> None:
        self._insert_script(1)
        self.conn.execute(
            """
            UPDATE script_library_scripts
            SET theme_tags_json='["现代言情"]', background_tags_json='["现代"]'
            WHERE id=1
            """
        )
        formula = self._formula()
        formula["source_script_ids"] = [1]
        batch._store_formulas(self.conn, [formula])
        stored_tags = self.conn.execute(
            "SELECT applicable_tags_json FROM script_library_formulas WHERE id=?",
            (formula["formula_id"],),
        ).fetchone()
        self.assertEqual(json.loads(stored_tags["applicable_tags_json"]), ["现代"])
        stored = self.conn.execute(
            "SELECT content_json FROM script_library_formulas WHERE id=?",
            (formula["formula_id"],),
        ).fetchone()
        legacy_content = json.loads(stored["content_json"])
        legacy_content["applicable_tags"] = ["家庭冲突"]
        self.conn.execute(
            "UPDATE script_library_formulas SET applicable_tags_json=?, content_json=? WHERE id=?",
            (
                json.dumps(["家庭冲突"], ensure_ascii=False),
                json.dumps(legacy_content, ensure_ascii=False),
                formula["formula_id"],
            ),
        )
        self.conn.commit()

        refinement_input = batch._existing_formula_refinement_input(self.conn)

        self.assertEqual(refinement_input[0]["applicable_tags"], ["现代言情", "现代"])

    def test_formula_batches_run_in_parallel_and_merge_in_batch_order(self) -> None:
        cases = [
            {"script_id": script_id, "source_specific_terms": []}
            for script_id in range(1, 9)
        ]
        active = 0
        maximum_active = 0
        lock = threading.Lock()
        first_wave = threading.Barrier(3, timeout=2)

        def collect(**kwargs):
            nonlocal active, maximum_active
            batch_number = int(kwargs["task_name"].rsplit("_", 1)[-1])
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
            try:
                if batch_number <= 3:
                    first_wave.wait()
                    time.sleep((4 - batch_number) * 0.01)
                return {"formula_candidates": [{"batch_number": batch_number}]}
            finally:
                with lock:
                    active -= 1

        with patch.object(
            batch,
            "case_ready_counts",
            return_value={"total": len(cases), "remaining": 0},
        ), patch.object(batch, "load_case_digests", return_value=cases), patch.object(
            batch, "resolve_runtime_model", return_value={}
        ), patch.object(batch, "_call_batch_stage", side_effect=collect) as stage_call, patch.object(
            batch, "_merge_formula_candidates", return_value=[]
        ) as merge_call, patch.object(batch, "_store_formulas"):
            batch.distill_formulas(batch_size=2)

        self.assertEqual(stage_call.call_count, 4)
        self.assertEqual(maximum_active, 3)
        self.assertEqual(
            [item["batch_number"] for item in merge_call.call_args.args[0]],
            [1, 2, 3, 4],
        )

    def test_incomplete_case_cards_keep_batch_at_case_phase(self) -> None:
        self._insert_script(1, complete=True)
        self._insert_script(2, complete=False)
        run_id = batch.ensure_script_library_batch_run(self.conn)
        self.conn.commit()

        with patch.object(batch, "distill_formulas") as distill:
            batch.run_script_library_batch_run(int(run_id))

        distill.assert_not_called()
        row = self.conn.execute("SELECT * FROM script_library_batch_runs WHERE id=?", (run_id,)).fetchone()
        self.assertEqual((row["status"], row["phase"], row["case_card_count"]), ("queued", "case_cards", 1))

    def test_completed_cases_advance_through_formulas_and_principles(self) -> None:
        self._insert_script(1)
        self._insert_script(2)
        run_id = batch.ensure_script_library_batch_run(self.conn)
        self.conn.commit()

        with patch.object(batch, "distill_formulas", return_value=[{"id": "F"}]) as formulas, patch.object(
            batch, "distill_principles", return_value=[{"id": "P"}]
        ) as principles:
            batch.run_script_library_batch_run(int(run_id))

        formulas.assert_called_once()
        principles.assert_called_once()
        row = self.conn.execute("SELECT * FROM script_library_batch_runs WHERE id=?", (run_id,)).fetchone()
        self.assertEqual((row["status"], row["phase"]), ("succeeded", "completed"))
        self.assertEqual((row["formula_count"], row["principle_count"]), (1, 1))
        ready = self.conn.execute("SELECT COUNT(*) FROM script_library_scripts WHERE status='ready'").fetchone()[0]
        self.assertEqual(ready, 2)

    def test_recovery_returns_running_batch_to_queue(self) -> None:
        self._insert_script(1, complete=False)
        run_id = batch.ensure_script_library_batch_run(self.conn)
        self.conn.execute("UPDATE script_library_batch_runs SET status='running' WHERE id=?", (run_id,))
        self.conn.commit()

        recovered = batch.recover_script_library_batch_runs(self.conn)

        self.assertEqual(recovered, [run_id])
        status = self.conn.execute("SELECT status FROM script_library_batch_runs WHERE id=?", (run_id,)).fetchone()[0]
        self.assertEqual(status, "queued")

    def test_recovery_requeues_failed_batch_without_resetting_its_phase(self) -> None:
        self._insert_script(1)
        run_id = batch.ensure_script_library_batch_run(self.conn)
        self.conn.execute(
            """
            UPDATE script_library_batch_runs
            SET status='failed', phase='formulas', retry_count=1, error_message='上次模型返回无效'
            WHERE id=?
            """,
            (run_id,),
        )
        self.conn.commit()

        recovered = batch.recover_script_library_batch_runs(self.conn)

        row = self.conn.execute(
            "SELECT status,phase,retry_count,error_message FROM script_library_batch_runs WHERE id=?",
            (run_id,),
        ).fetchone()
        self.assertEqual(recovered, [run_id])
        self.assertEqual((row["status"], row["phase"], row["retry_count"]), ("queued", "formulas", 1))
        self.assertEqual(row["error_message"], "上次模型返回无效")

    def test_queue_scan_does_not_create_a_full_library_run(self) -> None:
        self._insert_script(1)

        self.assertEqual(batch.queued_script_library_batch_run_ids(), [])
        count = self.conn.execute("SELECT COUNT(*) FROM script_library_batch_runs").fetchone()[0]
        self.assertEqual(count, 0)

        run_id = batch.ensure_script_library_batch_run(self.conn)
        self.conn.commit()
        self.assertEqual(batch.queued_script_library_batch_run_ids(), [run_id])

    def test_catalog_updates_preserve_existing_source_relations(self) -> None:
        for script_id in (1, 2, 3):
            self._insert_script(script_id)
        formula = self._formula("formula-shared")
        batch._store_formulas(self.conn, [formula])
        self.conn.execute(
            """
            INSERT INTO script_library_formula_sources (
                formula_id, script_id, candidate_id, action
            ) VALUES ('formula-shared', 3, 'historical', 'reuse')
            """
        )
        principle = self._principle("principle-shared")
        batch._store_principles(self.conn, [principle])
        self.conn.execute(
            """
            INSERT INTO script_library_principle_observations (
                id, script_id, local_observation_id, principle_id, relation,
                statement, rationale
            ) VALUES (
                'historical-observation', 3, 'historical', 'principle-shared', 'supports',
                '历史原则观察内容', '历史观察中已经确认的原因'
            )
            """
        )
        self.conn.commit()

        batch._store_formulas(self.conn, [self._formula("formula-shared")])
        batch._store_principles(self.conn, [self._principle("principle-shared")])
        self.conn.commit()

        formula_source = self.conn.execute(
            "SELECT 1 FROM script_library_formula_sources WHERE formula_id='formula-shared' AND script_id=3"
        ).fetchone()
        principle_source = self.conn.execute(
            "SELECT 1 FROM script_library_principle_observations WHERE id='historical-observation'"
        ).fetchone()
        self.assertIsNotNone(formula_source)
        self.assertIsNotNone(principle_source)

    def test_principle_catalog_entry_stays_candidate_until_review(self) -> None:
        self._insert_script(1)
        self._insert_script(2)

        principle = self._principle("principle-review-required")
        batch._store_principles(self.conn, [principle])
        self.conn.execute(
            "UPDATE script_library_principles SET status='active' WHERE id='principle-review-required'"
        )
        batch._store_principles(self.conn, [self._principle("principle-review-required")])
        self.conn.commit()

        row = self.conn.execute(
            "SELECT status,source_count FROM script_library_principles WHERE id='principle-review-required'"
        ).fetchone()
        self.assertEqual((row["status"], row["source_count"]), ("candidate", 2))

    def test_formula_stage_rejects_partial_case_library(self) -> None:
        self._insert_script(1)
        self._insert_script(2, complete=False)

        with self.assertRaisesRegex(RuntimeError, "1 部剧本未完成案例卡"):
            batch.distill_formulas()


if __name__ == "__main__":
    unittest.main()
