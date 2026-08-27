from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import script_distillation_pipeline as pipeline


CHUNK_ID = "C0001"


def _segment_facts() -> dict:
    return {
        "covered_chunk_ids": [CHUNK_ID],
        "characters": [
            {
                "name": "林夏",
                "actions": ["公开证据并收回项目决策权"],
                "goals_or_pressure": "需要在公开指控中证明自己并保住项目。",
                "resources_or_information": "掌握可以现场核验的原始文件。",
                "state_change": "从被定性的人变成现场决策者。",
                "evidence_references": [CHUNK_ID],
            }
        ],
        "events": [
            {
                "event": "林夏在公开会议上展示原始文件，推翻对手的指控。",
                "cause": "对手已经公开锁定结论。",
                "consequence": "现场裁决改变，项目决策权回到林夏手中。",
                "characters": ["林夏", "顾沉"],
                "evidence_references": [CHUNK_ID],
            }
        ],
        "relationships": [],
        "world_rules": [],
        "payoff_beats": [],
        "craft_observations": [],
        "source_terms": ["林夏", "顾沉"],
        "open_questions": [],
    }


def _fact_index() -> dict:
    chronology = [
        {
            "phase": phase,
            "event": event,
            "cause": "对手先在公开场合锁定了对主角不利的结论。",
            "consequence": consequence,
            "characters": ["林夏", "顾沉"],
            "evidence_references": [CHUNK_ID],
        }
        for phase, event, consequence in (
            ("开篇", "林夏在公开会议上被错误指控。", "她必须当场回应，否则失去项目。"),
            ("反转", "林夏按顺序展示三份可核验文件。", "现场判断逐层改变，指控者无法撤回立场。"),
            ("收束", "林夏用最终文件确认真实责任人。", "她收回项目决策权，对手承担误判后果。"),
        )
    ]
    characters = [
        {
            "name": name,
            "dramatic_role": role,
            "desire": desire,
            "pressure_or_misbelief": pressure,
            "resources_and_information": resource,
            "opening_state": opening,
            "decisive_actions": actions,
            "ending_state": ending,
            "evidence_references": [CHUNK_ID],
        }
        for name, role, desire, pressure, resource, opening, actions, ending in (
            (
                "林夏",
                "在公开指控中收回行动权的主角。",
                "保住项目并恢复自己的决策资格。",
                "现场多数人已经接受对手的错误结论。",
                "她掌握可以分层核验的原始文件。",
                "她处于被定性且需要自证的位置。",
                ["先让指控者确认公开立场。", "再按影响范围展示文件。"],
                "她得到现场认可并收回项目决策权。",
            ),
            (
                "顾沉",
                "代表旧有裁决秩序并承担误判代价的对手。",
                "维持自己的公开判断和项目控制权。",
                "他误以为先发言就能固定现场结论。",
                "他拥有会议主导权，但不掌握原始证据。",
                "他以裁决者身份公开定性林夏。",
                ["公开确认指控。", "在证据成立后承认误判。"],
                "他失去项目裁决权并承担公开责任。",
            ),
        )
    ]
    observations = [
        {
            "fact_id": f"E{index:02d}",
            "creative_problem": problem,
            "setup": "对手已经在见证人面前锁定结论，主角拥有可核验信息。",
            "author_choice": choice,
            "story_change": change,
            "audience_effect_hypothesis": "观众可以随信息更新判断，并看到反转造成实际后果。",
            "boundary": "如果文件不能独立核验，这种公开反转就不成立。",
            "evidence_references": [CHUNK_ID],
        }
        for index, (problem, choice, change) in enumerate(
            (
                ("如何让公开指控不只是口头争吵。", "先让对手确认不可轻易撤回的公开立场。", "对手需要为后续误判承担更高成本。"),
                ("如何防止一份证据立即结束全部冲突。", "让三份文件分别改变清白、责任和行动权。", "每层证据都开启一个新的现场行动。"),
                ("如何让反转不停留在人物态度变化上。", "把最终证据与项目决策权的当场转移绑定。", "场景结束后的资源和下一步目标都发生改变。"),
            ),
            start=1,
        )
    ]
    return {
        "covered_chunk_ids": [CHUNK_ID],
        "story_summary": "林夏在公开会议上被顾沉错误指控，她利用可以当场核验的原始文件逐层改变现场判断，最终找到真实责任人，并收回项目决策权。",
        "chronology": chronology,
        "characters": characters,
        "relationships": [
            {
                "parties": ["林夏", "顾沉"],
                "opening_state": "顾沉掌握会议裁决权，林夏被迫承担自证义务。",
                "change_chain": "林夏通过分层证据逐步削弱顾沉的判断权，最终将其转化为项目决策权。",
                "ending_state": "林夏成为项目决策者，顾沉需要承担误判责任。",
                "evidence_references": [CHUNK_ID],
            }
        ],
        "world_rules": [],
        "payoff_chains": [
            {
                "payoff_type": "真相反转",
                "setup": "对手在公开会议上锁定错误结论。",
                "pressure": "主角若不当场自证就会失去项目。",
                "release": "原始文件按功能逐层推翻错误判断。",
                "story_consequence": "现场重新认定责任，主角获得决策权。",
                "evidence_references": [CHUNK_ID],
            },
            {
                "payoff_type": "权力转移",
                "setup": "项目决策权原本由误判者掌握。",
                "pressure": "单纯洗清指控仍不能恢复主角的行动空间。",
                "release": "最终证据与项目权限转移在同一节点发生。",
                "story_consequence": "主角不但获得清白，还可以决定下一步行动。",
                "evidence_references": [CHUNK_ID],
            },
        ],
        "craft_observations": observations,
        "source_terms": ["林夏", "顾沉"],
        "open_questions": [],
    }


def _case_stage() -> dict:
    observations = [
        {
            "observation_id": f"O{index:02d}",
            "stage": stage,
            "creative_problem": problem,
            "setup": "对手已在公开场合锁定错误结论，主角掌握可核验的原始文件。",
            "author_choice": choice,
            "story_change": change,
            "audience_effect_hypothesis": "观众可随证据更新判断，并看到反转的实际后果。",
            "tradeoff_or_boundary": "如果证据无法独立核验，这种公开反转就会失去可信度。",
            "evidence_references": [CHUNK_ID],
        }
        for index, (stage, problem, choice, change) in enumerate(
            (
                ("trial_generate", "如何让公开指控具备不可轻易撤回的成本。", "先让对手确认公开立场，再揭示可核验证据。", "对手必须承担误判带来的现场责任。"),
                ("outline_rewrite", "如何用多层证据维持冲突递进而不重复。", "为每层证据分配不同的状态变化功能。", "每次揭示都会改变下一步的对抗对象和行动目标。"),
                ("full_generate", "如何让场景反转产生剧情后果而非只有情绪。", "把最终证据与项目决策权的转移绑定。", "人物可采取的行动和后续故事目标同时改变。"),
            ),
            start=1,
        )
    ]
    return {
        "summary": "林夏在公开会议上被顾沉错误指控，她利用可以现场核验的原始文件逐层推翻判断，并把真相的揭示与项目决策权转移绑定，最终找到真实责任人，收回了行动权，让误判者承担了公开责任。",
        "tags": {
            "theme": ["女性成长"],
            "setting": ["大女主", "打脸虐渣"],
            "background": ["现代", "职场"],
            "audience": ["女频"],
        },
        "case_card": {
            "logline": "被公开错误定性的项目负责人，通过分层可核验证据找到真正责任人，并收回项目决策权。",
            "audience_promise": "观众持续等待每层证据改变一项现场判断，最终让误判者承担可见代价。",
            "story_engine": {
                "initial_situation": "主角在公开会议上被定性，现场多数人已经接受错误结论。",
                "protagonist_goal": "主角要洗清指控、找到真实责任人并保住项目。",
                "main_resistance": "对手掌握会议程序和先发判断，且已当众锁定立场。",
                "stakes": "如果不能现场改变判断，主角会失去项目、决策权和专业信用。",
                "repeatable_conflict_loop": "对手提出一层定性，主角揭示一份功能不同的证据，现场判断和行动权随之变化。",
                "ending_change": "主角从被裁决者变为项目决策者，误判者从裁决人变为责任承担者。",
            },
            "world_rules": [],
            "characters": [
                {
                    "name": "林夏",
                    "dramatic_function": "在公开误判中收回决策权的主角。",
                    "desire": "保住项目并恢复自己的专业信用。",
                    "fear_need_or_misbelief": "她开始以为只要证明清白就能恢复行动权。",
                    "leverage": "可以在现场独立核验的原始文件。",
                    "secret_or_unknown": "真正责任人隐藏在最终文件的流转记录中。",
                    "initial_state": "她被公开定性，必须在对手制定的程序中自证。",
                    "turning_action": "她不只证明自己无责，还用文件确认真正责任人。",
                    "final_state": "她获得现场认可并收回项目决策权。",
                    "evidence_references": [CHUNK_ID],
                },
                {
                    "name": "顾沉",
                    "dramatic_function": "代表旧裁决秩序并承担误判代价的对手。",
                    "desire": "维持自己的公开判断和项目控制权。",
                    "fear_need_or_misbelief": "他误以为先发言就能固定现场结论。",
                    "leverage": "他掌握会议程序和项目的旧决策权。",
                    "secret_or_unknown": "他不知道当前指控使用的文件已经被替换。",
                    "initial_state": "他以裁决者身份公开定性主角。",
                    "turning_action": "他在原始文件成立后当场承认误判。",
                    "final_state": "他失去项目决策权并需要承担公开责任。",
                    "evidence_references": [CHUNK_ID],
                },
            ],
            "relationship_dynamics": [
                {
                    "parties": ["林夏", "顾沉"],
                    "initial_power": "顾沉掌握会议裁决权，林夏承担自证义务。",
                    "debt_or_misunderstanding": "顾沉根据被替换的文件认定林夏需要负责。",
                    "change_chain": "林夏逐层揭示证据，先改变现场判断，再改变责任归属，最后改变项目权限。",
                    "final_state": "林夏成为决策者，顾沉成为误判责任的承担者。",
                    "evidence_references": [CHUNK_ID],
                }
            ],
            "narrative_phases": [
                {
                    "phase": phase,
                    "goal": goal,
                    "opposition": opposition,
                    "irreversible_change": change,
                    "audience_return": payoff,
                    "evidence_references": [CHUNK_ID],
                }
                for phase, goal, opposition, change, payoff in (
                    ("定性", "让主角必须立即回应公开指控。", "对手掌握会议程序和现场多数判断。", "对手当众锁定了不能轻易撤回的立场。", "观众明确主角可能失去的项目和信用。"),
                    ("更新", "用功能不同的文件逐层改变现场判断。", "对手不断试图把新证据解释为与责任无关。", "每份文件都使原有结论少一个支点。", "观众持续获得新信息，且每次都看到局势变化。"),
                    ("转权", "把真相确认转化为主角新的行动权。", "单纯恢复清白仍不会自动恢复项目权限。", "项目决策权在现场转移给主角。", "反转不只让对手丢脸，还让主角获得后续选择。"),
                )
            ],
            "audience_payoffs": [
                {
                    "payoff_type": "公开正名",
                    "setup": "主角在现场被多数人认定需要承担责任。",
                    "pressure": "她如果无法立即回应就会失去项目。",
                    "release": "可核验的原始文件当场推翻错误结论。",
                    "story_consequence": "现场重新认定责任，主角不再承担自证义务。",
                    "evidence_references": [CHUNK_ID],
                },
                {
                    "payoff_type": "决策权归位",
                    "setup": "主角即使洗清指控，仍没有决定项目的权力。",
                    "pressure": "旧裁决者仍然可以用原有权限限制她的下一步行动。",
                    "release": "最终证据同时触发现场的项目权限转移。",
                    "story_consequence": "主角获得真实选择权，误判者失去继续裁决她的位置。",
                    "evidence_references": [CHUNK_ID],
                },
            ],
            "key_observations": observations,
            "strengths": ["每层证据都改变现场判断或人物可采取的行动。"],
            "limitations": ["所有信息都集中在一场会议中，不适合直接延展为长篇结构。"],
            "source_specific_terms": ["林夏"],
            "evidence_references": [CHUNK_ID],
        },
    }


def _formula_stage() -> dict:
    return {
        "formula_candidates": [],
        "no_formula_reason": "这个短样本只能支持具体写法观察，暂不足以提炼出具备迁移边界的公式候选。",
    }


def _principle_stage() -> dict:
    return {
        "principle_observations": [],
        "no_principle_reason": "单一短样本没有提供跨题材支持、边界或反例，不足以产生新的创作原则观察。",
    }


class ScriptDistillationPipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.execute(
            """
            CREATE TABLE script_library_scripts (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                distillation_stage TEXT NOT NULL DEFAULT 'queued',
                distillation_stage_label TEXT NOT NULL DEFAULT '等待处理',
                distillation_progress_current INTEGER NOT NULL DEFAULT 0,
                distillation_progress_total INTEGER NOT NULL DEFAULT 0,
                distillation_progress_message TEXT NOT NULL DEFAULT '',
                updated_at TEXT
            )
            """
        )
        self.connection.execute("INSERT INTO script_library_scripts (id, title) VALUES (1, '证据之后')")
        self.script = self.connection.execute("SELECT * FROM script_library_scripts WHERE id = 1").fetchone()
        self.source_marker = "ONLY_SOURCE_MARKER"
        self.chunks = [
            {
                "id": CHUNK_ID,
                "locator": "第1集",
                "raw_content": f"林夏与顾沉在公开会议对峙。{self.source_marker}林夏展示原始文件并收回项目决策权。",
                "content": f"林夏与顾沉在公开会议对峙。{self.source_marker}林夏展示原始文件并收回项目决策权。",
            }
        ]

    def tearDown(self) -> None:
        self.connection.close()

    def _fake_stage(self, calls: list[tuple[str, dict]], *, fail_first_review: bool = False):
        review_count = 0

        def invoke(**kwargs):
            nonlocal review_count
            task_name = kwargs["task_name"]
            payload = kwargs["payload"]
            calls.append((task_name, payload))
            if task_name == "segment_evidence_extraction":
                value = _segment_facts()
            elif task_name in {"partial_fact_consolidation", "full_fact_consolidation"}:
                value = _fact_index()
            elif task_name == "case_card_and_tags":
                value = _case_stage()
            elif task_name == "formula_candidate_distillation":
                value = _formula_stage()
            elif task_name == "principle_observation_distillation":
                value = _principle_stage()
            elif task_name == "final_distillation_review":
                review_count += 1
                value = (
                    {
                        "approved": False,
                        "summary": "案例卡需要重新确认与事实索引的对应关系。",
                        "issues": [
                            {
                                "stage": "case_card",
                                "problem": "案例卡的主要人物状态需要根据事实索引重新核对。",
                                "repair_instruction": "根据事实索引重新整理人物起点、关键行动和最终状态。",
                                "evidence_references": [CHUNK_ID],
                            }
                        ],
                    }
                    if fail_first_review and review_count == 1
                    else {"approved": True, "summary": "事实、案例和抽象边界一致，可以进入知识归档。", "issues": []}
                )
            else:
                raise AssertionError(f"未处理的阶段：{task_name}")
            result = kwargs["validator"](value)
            output_path = kwargs["output_path"]
            pipeline._write_json(output_path, result)
            pipeline._checkpoint_fingerprint_path(output_path).write_text(
                pipeline._checkpoint_fingerprint(task_name, payload) + "\n",
                encoding="utf-8",
            )
            return result

        return invoke

    def test_source_enters_only_evidence_stage_and_retry_reuses_checkpoints(self) -> None:
        calls: list[tuple[str, dict]] = []
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as retry_dir:
            first = Path(first_dir)
            with patch.object(pipeline, "_call_stage", side_effect=self._fake_stage(calls)):
                result = pipeline.run_distillation_pipeline(
                    conn=self.connection,
                    job_id=1,
                    script=self.script,
                    indexed_chunks=self.chunks,
                    model_runtime={},
                    work_dir=first,
                    previous_work_dirs=[],
                )

            self.assertEqual(result["source"]["title"], "证据之后")
            stages_with_source = [
                task_name
                for task_name, payload in calls
                if self.source_marker in json.dumps(payload, ensure_ascii=False)
            ]
            self.assertEqual(stages_with_source, ["segment_evidence_extraction"])

            with patch.object(pipeline, "_call_stage", side_effect=AssertionError("已通过的阶段不应重新调用模型")):
                retried = pipeline.run_distillation_pipeline(
                    conn=self.connection,
                    job_id=2,
                    script=self.script,
                    indexed_chunks=self.chunks,
                    model_runtime={},
                    work_dir=Path(retry_dir),
                    previous_work_dirs=[first],
                )
            self.assertEqual(retried, result)

    def test_review_repair_regenerates_earliest_stage_and_all_downstream_stages(self) -> None:
        calls: list[tuple[str, dict]] = []
        with tempfile.TemporaryDirectory() as directory, patch.object(
            pipeline,
            "_call_stage",
            side_effect=self._fake_stage(calls, fail_first_review=True),
        ):
            pipeline.run_distillation_pipeline(
                conn=self.connection,
                job_id=3,
                script=self.script,
                indexed_chunks=self.chunks,
                model_runtime={},
                work_dir=Path(directory),
                previous_work_dirs=[],
            )

        names = [name for name, _ in calls]
        self.assertEqual(names.count("case_card_and_tags"), 2)
        self.assertEqual(names.count("formula_candidate_distillation"), 2)
        self.assertEqual(names.count("principle_observation_distillation"), 2)
        self.assertEqual(names.count("final_distillation_review"), 2)

    def test_checkpoint_requires_matching_input_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = Path("case-card.json")
            pipeline._write_json(root / relative, {"value": "old"})
            pipeline._checkpoint_fingerprint_path(root / relative).write_text("old-input\n", encoding="utf-8")

            cached = pipeline._load_checkpoint(
                root,
                [],
                relative,
                lambda value: value,
                fingerprint="new-input",
            )

        self.assertIsNone(cached)

    def test_case_card_discards_unverifiable_extra_source_terms(self) -> None:
        stage = _case_stage()
        stage["case_card"]["source_specific_terms"] = ["毒针管", "林 夏"]

        result = pipeline.validate_case_card_stage(
            stage,
            {CHUNK_ID},
            source_text="<!-- C0001 | 第1集 -->\n林 夏公开了证据。",
            allowed_source_terms=["林夏"],
        )

        self.assertEqual(result["case_card"]["source_specific_terms"], ["林夏"])

    def test_stage_failure_is_retried_twice_and_error_is_used_on_next_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "case-card.json"
            failed_calls = []

            def always_fail(**kwargs):
                failed_calls.append(kwargs)
                raise RuntimeError("模型返回缺少案例卡证据")

            with patch.object(pipeline, "call_direct_model", side_effect=always_fail):
                with self.assertRaisesRegex(RuntimeError, "已重试 2 次"):
                    pipeline._call_stage(
                        skill_name="script-case-card",
                        task_name="case_card_and_tags",
                        payload={"title": "证据之后"},
                        schema={"type": "object"},
                        validator=lambda value: value,
                        runtime={},
                        output_path=output,
                        max_tokens=1000,
                    )

            self.assertEqual(len(failed_calls), 3)
            failure = json.loads(output.with_name("case-card.failure.json").read_text(encoding="utf-8"))
            self.assertIn("案例卡证据", failure["error"])

            prompts = []

            def succeed(**kwargs):
                prompts.append(kwargs["user_prompt"])
                return '{"ok": true}'

            with patch.object(pipeline, "call_direct_model", side_effect=succeed):
                result = pipeline._call_stage(
                    skill_name="script-case-card",
                    task_name="case_card_and_tags",
                    payload={"title": "证据之后"},
                    schema={"type": "object"},
                    validator=lambda value: value,
                    runtime={},
                    output_path=output,
                    max_tokens=1000,
                )

            self.assertEqual(result, {"ok": True})
            self.assertIn("模型返回缺少案例卡证据", prompts[0])
            self.assertFalse(output.with_name("case-card.failure.json").exists())


if __name__ == "__main__":
    unittest.main()
