from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from app.services.novel_analysis_pipeline import (
    _finalize_leaf_output,
    MAX_SOURCE_BLOCK_CHARS,
    build_source_blocks,
    create_leaf_ledger_skeleton,
    final_analysis_semantics_prompt,
    group_story_cards,
    leaf_semantics_prompt,
    materialize_final_analysis,
    materialize_leaf_ledger,
    materialize_story_arc_card,
    prepare_novel_analysis_draft,
    story_arc_semantics_prompt,
    validate_leaf_ledger,
    validate_story_arc_card,
)


SKILL_ROOT = Path(__file__).resolve().parents[3] / "Agents" / ".claude" / "skills" / "novel_analysis"


def source_block(start: int, end: int, *, title: str = "当前范围") -> dict:
    return {
        "id": f"block-{start:03d}",
        "order": start,
        "start_line": start,
        "end_line": end,
        "source_index": f"L{start}-L{end}",
        "chapters": [{
            "title": title,
            "start_line": start,
            "end_line": end,
            "span": f"L{start}-L{end}",
        }],
    }


def leaf_semantics(block: dict, *, opening_state: str = "主角尚未掌握关键证据。") -> dict:
    skeleton = create_leaf_ledger_skeleton(block)
    chapters = []
    for chapter in skeleton["chapters"]:
        span = chapter["span"]
        chapters.append({
            "chapter_id": chapter["chapter_id"],
            "events": [{
                "source_indexes": [span],
                "cause_and_choice": "新证据出现，主角决定主动查证。",
                "conflict_and_turn": "对手阻止主角接近真相，局面随之升级。",
                "result_and_future_effect": "主角获得新线索，并必须继续承担公开真相的代价。",
                "state_changes": [{"subject": "林夏", "change": "从怀疑转为主动查证。"}],
                "information_changes": [{"content": "证据真实存在", "known_by_and_status": "仅林夏知情，形成新的信息差。"}],
                "highlights": [{"name": "公开证据", "source_index": span}],
                "world_constraints": [],
            }],
        })
    return {
        "opening_state": opening_state,
        "closing_state": "主角带着新线索进入下一段行动。",
        "chapters": chapters,
    }


def story_arc_semantics(start: int, end: int) -> dict:
    span = f"L{start}-L{end}"
    return {
        "arcs": [{
            "source_indexes": [span],
            "summary": "主角顺着新证据追查真相，并在阻拦中取得下一步线索。",
            "mainline_advance": "主线从怀疑推进到主动追查。",
            "key_characters": [{"name": "林夏", "role_and_change": "从被动怀疑转为主动查证。"}],
            "information_changes": [{"content": "证据真实存在", "effect": "林夏取得行动依据。"}],
            "highlights": [{"name": "公开证据", "source_index": span}],
            "unresolved_threads": [{
                "thread": "证据背后的操控者",
                "status_and_effect": "身份仍未揭晓，持续驱动追查。",
                "source_indexes": [span],
            }],
        }],
        "handoff_state": "林夏带着线索进入下一段追查。",
    }


def final_semantics(*, merged: bool = False) -> dict:
    units = [{
        "name": "公开证据",
        "summary": "林夏追查并公开证据。",
        "mainline_advance": "真相被公开。",
        "key_characters": [{"name": "林夏", "role_and_change": "从追查转为承担公开真相的代价。"}],
        "key_information": ["证据真实存在。"],
        "highlights": [{"name": "公开证据", "source_index": "L1-L1"}],
        "recommendation": "保留",
        "recommendation_reason": "该单元完成主线回报。",
    }]
    if merged:
        units.append({
            "name": "追查余波",
            "summary": "林夏消化公开证据后的反击。",
            "mainline_advance": "为下一次正面对抗积累代价。",
            "key_characters": [{"name": "林夏", "role_and_change": "从主动公开转为承担反击。"}],
            "key_information": ["对手开始反击。"],
            "highlights": [{"name": "反击来临", "source_index": "L1-L1"}],
            "recommendation": "合并",
            "merge_target_order": 1,
            "recommendation_reason": "单独回报不足，应并入公开证据后的反应。",
        })
    return {
        "basic_info": {"synopsis": "林夏持续追查身份真相。", "genres": ["悬疑"], "tone": "紧张"},
        "core_hook": "证据不断改变人物关系和权力位置。",
        "main_storyline": "林夏主动追查并公开真相。",
        "world": "公开证据能够改变权力归属。",
        "characters": [{"name": "林夏", "profile": "主动追查真相的继承人，从依赖认可转为承担公开真相的代价。"}],
        "units": units,
    }


def materialized_leaf(block: dict) -> dict:
    ledger, issues = materialize_leaf_ledger(block=block, semantics=leaf_semantics(block))
    if issues:
        raise AssertionError(issues)
    return ledger


class NovelAnalysisPipelineTests(unittest.TestCase):
    def test_source_blocks_cover_every_line_and_refine_large_batches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source_path = workspace / "runtime" / "原始小说.md"
            source_path.parent.mkdir(parents=True)
            source_lines = [f"第{index}段" + ("剧情" * 12_000) for index in range(1, 7)]
            source_path.write_text("\n".join(source_lines), encoding="utf-8")
            blocks = build_source_blocks(workspace, {
                "source_file": "runtime/原始小说.md",
                "total_lines": len(source_lines),
                "suggested_batches": [{"start_line": 1, "end_line": len(source_lines)}],
            })

            self.assertGreater(len(blocks), 1)
            self.assertEqual(blocks[0]["start_line"], 1)
            self.assertEqual(blocks[-1]["end_line"], len(source_lines))
            for previous, current in zip(blocks, blocks[1:]):
                self.assertEqual(previous["end_line"] + 1, current["start_line"])
            for block in blocks:
                self.assertLessEqual(len(block["content"]), MAX_SOURCE_BLOCK_CHARS)
            rebuilt: list[str] = []
            for block in blocks:
                rebuilt.extend(rendered.split(": ", 1)[1] for rendered in block["content"].split("\n"))
            self.assertEqual(rebuilt, source_lines)

    def test_leaf_tool_owns_static_chapter_fields_and_dynamic_event_ids(self) -> None:
        block = {
            **source_block(1, 8),
            "chapters": [
                {"title": "第一章", "start_line": 1, "end_line": 4, "span": "L1-L4"},
                {"title": "第二章", "start_line": 5, "end_line": 8, "span": "L5-L8"},
            ],
        }
        semantics = leaf_semantics(block)
        # This was a common malformed extra field in the failed long-novel run.
        semantics["chapters"][0]["chapter_summary"] = "不应写入持久化账本。"
        semantics["chapters"][0]["title"] = "模型不应控制章节标题"

        ledger, issues = materialize_leaf_ledger(block=block, semantics=semantics)

        self.assertEqual(issues, [])
        self.assertEqual(ledger["chapters"][0]["title"], "第一章")
        self.assertNotIn("closing_state", ledger["chapters"][0])
        self.assertEqual(ledger["chapters"][0]["events"][0]["event_id"], "block-001-chapter-001-event-001")
        self.assertEqual(validate_leaf_ledger(ledger, block=block), [])

    def test_leaf_tool_rejects_an_index_outside_the_owning_chapter(self) -> None:
        block = source_block(11, 20)
        semantics = leaf_semantics(block)
        semantics["chapters"][0]["events"][0]["highlights"][0]["source_index"] = "L9-L12"

        _ledger, issues = materialize_leaf_ledger(block=block, semantics=semantics)

        self.assertTrue(any(issue.endswith("高光时刻第 1 项原文索引超出当前范围：L9-L12") for issue in issues))

    def test_leaf_checkpoint_validation_rechecks_nested_source_indexes(self) -> None:
        block = source_block(11, 20)
        ledger = materialized_leaf(block)
        ledger["chapters"][0]["events"][0]["highlights"][0]["source_index"] = "L9-L12"
        ledger["chapters"][0]["events"][0]["world_constraints"] = [{
            "rule": "测试规则",
            "dramatic_function": "测试作用",
            "source_indexes": ["L9-L12"],
        }]

        issues = validate_leaf_ledger(ledger, block=block)

        self.assertTrue(any(issue.endswith("高光时刻第 1 项原文索引超出当前范围：L9-L12") for issue in issues))
        self.assertTrue(any(issue.endswith("世界规则第 1 项原文索引超出当前范围：L9-L12") for issue in issues))

    def test_leaf_prompt_only_requests_semantic_fields(self) -> None:
        block = source_block(1, 3, title="第一章")

        prompt = leaf_semantics_prompt(block=block, reading_principles="以原著事实为准。")

        self.assertIn("服务已生成固定章节、标题、原文范围和序号", prompt)
        self.assertIn("block-001-chapter-001", prompt)
        self.assertNotIn("cross_chapter_threads", prompt)
        self.assertNotIn("章节 `closing_state`", prompt)

    def test_leaf_repair_is_limited_to_the_invalid_chapter(self) -> None:
        block = {
            **source_block(1, 8),
            "content": "\n".join(f"{index}: 第{index}行原文" for index in range(1, 9)),
            "chapters": [
                {"title": "第一章", "start_line": 1, "end_line": 4, "span": "L1-L4"},
                {"title": "第二章", "start_line": 5, "end_line": 8, "span": "L5-L8"},
            ],
        }
        invalid = leaf_semantics(block)
        original_first_chapter = json.loads(json.dumps(invalid["chapters"][0], ensure_ascii=False))
        invalid_event = invalid["chapters"][1]["events"][0]
        invalid_event["source_indexes"] = ["L4-L6"]
        invalid_event["highlights"][0]["source_index"] = "L4-L6"

        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "block-001.json"
            output_path.write_text(json.dumps(invalid, ensure_ascii=False), encoding="utf-8")
            calls: list[str] = []

            def run_model(prompt: str, label: str, repair_path: Path) -> None:
                calls.append(label)
                self.assertEqual(label, "novel-read-001-chapter-002-repair")
                self.assertIn("唯一合法原文范围：L5-L8", prompt)
                self.assertIn("本章原文：\n5: 第5行原文", prompt)
                self.assertNotIn("1: 第1行原文", prompt)
                repaired = json.loads(json.dumps(invalid["chapters"][1], ensure_ascii=False))
                repaired["events"][0]["source_indexes"] = ["L5-L8"]
                repaired["events"][0]["highlights"][0]["source_index"] = "L5-L8"
                repair_path.write_text(json.dumps(repaired, ensure_ascii=False), encoding="utf-8")

            ledger, issues = _finalize_leaf_output(
                block=block,
                output_path=output_path,
                label="novel-read-001",
                reading_principles="以原著事实为准。",
                run_model=run_model,
            )

            self.assertEqual(issues, [])
            self.assertIsNotNone(ledger)
            self.assertEqual(calls, ["novel-read-001-chapter-002-repair"])
            repaired_semantics = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(repaired_semantics["chapters"][0], original_first_chapter)
            self.assertEqual(
                ledger["chapters"][1]["events"][0]["source_indexes"],
                ["L5-L8"],
            )

    def test_repair_prompts_keep_the_previous_semantic_result(self) -> None:
        block = source_block(1, 2, title="第一章")
        prior_leaf = leaf_semantics(block)
        leaf_prompt = leaf_semantics_prompt(
            block=block,
            reading_principles="以原著事实为准。",
            prior_issues=["第一章的事件第 1 项原文索引超出当前范围：L0-L1"],
            prior_semantics=prior_leaf,
        )
        self.assertIn('"opening_state": "主角尚未掌握关键证据。"', leaf_prompt)

        card = materialized_leaf(block)
        prior_arc = story_arc_semantics(1, 2)
        arc_prompt = story_arc_semantics_prompt(
            cards=[card],
            level=1,
            group_index=1,
            reading_principles="以原著事实为准。",
            unit_principles="按原著因果提炼。",
            prior_issues=["剧情弧第 1 项原文索引超出当前范围：L0-L1"],
            prior_semantics=prior_arc,
        )
        self.assertIn('"handoff_state": "林夏带着线索进入下一段追查。"', arc_prompt)

        prior_final = final_semantics()
        final_prompt = final_analysis_semantics_prompt(
            cards=[card],
            reading_principles="以原著事实为准。",
            unit_principles="按原著因果提炼。",
            project={"project_name": "测试小说"},
            adaptation_plan={"target_episode_count": 35},
            preferences=[],
            prior_issues=["剧情单元第 1 项高光原文索引无效"],
            prior_semantics=prior_final,
        )
        self.assertIn('"core_hook": "证据不断改变人物关系和权力位置。"', final_prompt)

    def test_story_arc_tool_creates_dynamic_arc_objects(self) -> None:
        first = materialized_leaf(source_block(1, 2, title="第一章"))
        second = materialized_leaf(source_block(3, 4, title="第二章"))

        card, issues = materialize_story_arc_card(
            cards=[first, second],
            level=1,
            group_index=2,
            semantics=story_arc_semantics(1, 4),
        )

        self.assertEqual(issues, [])
        self.assertEqual(card["card_id"], "arc-01-002")
        self.assertEqual(card["arcs"][0]["arc_id"], "arc-01-002-arc-001")
        self.assertEqual(card["source_card_ids"], ["block-001", "block-003"])
        self.assertEqual(validate_story_arc_card(card=card, source_cards=[first, second]), [])

    def test_story_arc_checkpoint_validation_rechecks_nested_source_indexes(self) -> None:
        first = materialized_leaf(source_block(1, 2, title="第一章"))
        second = materialized_leaf(source_block(3, 4, title="第二章"))
        card, issues = materialize_story_arc_card(
            cards=[first, second],
            level=1,
            group_index=1,
            semantics=story_arc_semantics(1, 4),
        )
        self.assertEqual(issues, [])
        card["arcs"][0]["unresolved_threads"][0]["source_indexes"] = ["L0-L1"]

        validation_issues = validate_story_arc_card(card=card, source_cards=[first, second])

        self.assertTrue(any(issue.endswith("未解线索第 1 项原文索引超出当前范围：L0-L1") for issue in validation_issues))

    def test_story_card_groups_do_not_leave_a_singleton_reduction(self) -> None:
        cards = [materialized_leaf(source_block(index, index)) for index in range(1, 10)]

        groups = group_story_cards(cards)

        self.assertEqual([len(group) for group in groups], [4, 3, 2])

    def test_final_tool_assigns_ids_and_resolves_merge_targets(self) -> None:
        analysis, issues = materialize_final_analysis(
            semantics=final_semantics(merged=True),
            project={"source_script": {"display_name": "山河故人.epub"}},
            total_lines=20,
        )

        self.assertEqual(issues, [])
        self.assertEqual(analysis["基础信息"]["小说名称"], "山河故人.epub")
        self.assertEqual(analysis["剧情单元"][0]["单元ID"], "unit-001")
        self.assertEqual(analysis["剧情单元"][1]["合并目标单元ID"], "unit-001")
        self.assertFalse(analysis["剧情单元"][1]["已确认合并"])

    def test_final_tool_allows_unit_local_characters_outside_primary_roles(self) -> None:
        semantics = final_semantics()
        semantics["units"][0]["key_characters"][0]["name"] = "未登记角色"

        analysis, issues = materialize_final_analysis(
            semantics=semantics,
            project={"project_name": "测试小说"},
            total_lines=3,
        )

        self.assertEqual(issues, [])
        self.assertEqual(analysis["关键人物"][0]["人物名称"], "林夏")
        self.assertEqual(analysis["剧情单元"][0]["关键人物"][0]["人物名称"], "未登记角色")

    def test_final_tool_limits_primary_characters(self) -> None:
        semantics = final_semantics()
        semantics["characters"] = [
            {"name": f"主要角色{index}", "profile": "持续推动主线并在终局获得关系回报。"}
            for index in range(1, 12)
        ]

        _analysis, issues = materialize_final_analysis(
            semantics=semantics,
            project={"project_name": "测试小说"},
            total_lines=3,
        )

        self.assertIn("关键人物最多 10 人", issues)

    def test_pipeline_uses_batched_leaf_readers_then_semantic_synthesis(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source_path = workspace / "runtime" / "原始小说.md"
            source_path.parent.mkdir(parents=True)
            source_path.write_text("\n".join(f"第{index}段剧情" for index in range(1, 4)), encoding="utf-8")
            source_index = {
                "source_file": "runtime/原始小说.md",
                "total_lines": 3,
                "suggested_batches": [{"start_line": index, "end_line": index} for index in range(1, 4)],
            }
            blocks = build_source_blocks(workspace, source_index)
            block_by_label = {f"novel-read-{block['order']:03d}": block for block in blocks}
            labels: list[str] = []
            batches: list[list[str]] = []

            def run_model(_prompt: str, label: str, output_file: Path) -> None:
                labels.append(label)
                output_file.parent.mkdir(parents=True, exist_ok=True)
                payload = final_semantics() if label.startswith("novel-analysis-synthesis") else leaf_semantics(block_by_label[label])
                output_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            def run_model_batch(requests: list[dict]) -> None:
                batches.append([request["label"] for request in requests])
                for request in requests:
                    run_model(request["prompt"], request["label"], request["output_file"])

            result = prepare_novel_analysis_draft(
                workspace=workspace,
                skill_root=SKILL_ROOT,
                job_id=77,
                prepared={"source_index": source_index, "adaptation_plan": {"target_episode_count": 35, "max_outline_unit_count": 6}},
                project={"project_name": "三段故事"},
                preferences=[],
                run_model=run_model,
                run_model_batch=run_model_batch,
                validate_final=lambda _path: [],
            )

            self.assertEqual(batches, [["novel-read-001", "novel-read-002", "novel-read-003"]])
            self.assertEqual(result["novel_reading"]["block_count"], 3)
            self.assertEqual(result["novel_reading"]["story_arc_levels"], 0)
            self.assertEqual(labels[-1], "novel-analysis-synthesis")
            output = json.loads((workspace / "2.1-novel-analysis.json").read_text(encoding="utf-8"))
            self.assertFalse(output["剧情单元"][0]["已确认合并"])

    def test_pipeline_builds_story_arc_cards_instead_of_lossless_ledger_merges(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source_path = workspace / "runtime" / "原始小说.md"
            source_path.parent.mkdir(parents=True)
            source_path.write_text("\n".join(f"第{index}段剧情" for index in range(1, 10)), encoding="utf-8")
            source_index = {
                "source_file": "runtime/原始小说.md",
                "total_lines": 9,
                "suggested_batches": [{"start_line": index, "end_line": index} for index in range(1, 10)],
            }
            blocks = build_source_blocks(workspace, source_index)
            block_by_label = {f"novel-read-{block['order']:03d}": block for block in blocks}
            labels: list[str] = []
            batches: list[list[str]] = []

            def run_model(prompt: str, label: str, output_file: Path) -> None:
                labels.append(label)
                output_file.parent.mkdir(parents=True, exist_ok=True)
                if label.startswith("novel-read-"):
                    payload = leaf_semantics(block_by_label[label])
                elif label.startswith("novel-arc-"):
                    matched = re.search(r"本组覆盖原文范围：L(\d+)-L(\d+)", prompt)
                    self.assertIsNotNone(matched)
                    payload = story_arc_semantics(int(matched.group(1)), int(matched.group(2)))
                else:
                    payload = final_semantics()
                output_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            def run_model_batch(requests: list[dict]) -> None:
                batches.append([request["label"] for request in requests])
                for request in requests:
                    run_model(request["prompt"], request["label"], request["output_file"])

            result = prepare_novel_analysis_draft(
                workspace=workspace,
                skill_root=SKILL_ROOT,
                job_id=78,
                prepared={"source_index": source_index, "adaptation_plan": {"target_episode_count": 35, "max_outline_unit_count": 6}},
                project={"project_name": "九段故事"},
                preferences=[],
                run_model=run_model,
                run_model_batch=run_model_batch,
                validate_final=lambda _path: [],
            )

            self.assertEqual(batches[0], [f"novel-read-{index:03d}" for index in range(1, 10)])
            self.assertTrue(any(label.startswith("novel-arc-") for batch in batches[1:] for label in batch))
            self.assertFalse(any(label.startswith("novel-merge-") for label in labels))
            self.assertEqual(result["novel_reading"]["story_arc_levels"], 1)

    def test_pipeline_preserves_all_valid_leaf_cards_when_multiple_outputs_need_repair(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source_path = workspace / "runtime" / "原始小说.md"
            source_path.parent.mkdir(parents=True)
            source_path.write_text("第一段\n第二段", encoding="utf-8")
            source_index = {
                "source_file": "runtime/原始小说.md",
                "total_lines": 2,
                "suggested_batches": [{"start_line": 1, "end_line": 1}, {"start_line": 2, "end_line": 2}],
            }
            blocks = build_source_blocks(workspace, source_index)

            def run_model(_prompt: str, label: str, output_file: Path) -> None:
                output_file.parent.mkdir(parents=True, exist_ok=True)
                if label in {"novel-read-001", "novel-read-001-repair", "novel-read-001-repair-2"}:
                    payload = leaf_semantics(blocks[0])
                    payload["closing_state"] = ""
                elif label == "novel-read-002":
                    payload = leaf_semantics(blocks[1])
                else:
                    self.fail(f"unexpected model label: {label}")
                output_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            def run_model_batch(requests: list[dict]) -> None:
                for request in requests:
                    run_model(request["prompt"], request["label"], request["output_file"])

            with self.assertRaisesRegex(RuntimeError, "已保存 1 个可复用部分"):
                prepare_novel_analysis_draft(
                    workspace=workspace,
                    skill_root=SKILL_ROOT,
                    job_id=86,
                    prepared={"source_index": source_index, "adaptation_plan": {"target_episode_count": 35, "max_outline_unit_count": 6}},
                    project={"project_name": "两段故事"},
                    preferences=[],
                    run_model=run_model,
                    run_model_batch=run_model_batch,
                    validate_final=lambda _path: [],
                )

            checkpoint = workspace / "runtime" / "novel-analysis" / "ledgers" / "block-002.json"
            self.assertTrue(checkpoint.exists())

    def test_pipeline_reuses_leaf_and_story_arc_checkpoints(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source_path = workspace / "runtime" / "原始小说.md"
            source_path.parent.mkdir(parents=True)
            source_path.write_text("\n".join(f"第{index}段" for index in range(1, 10)), encoding="utf-8")
            source_index = {
                "source_file": "runtime/原始小说.md",
                "total_lines": 9,
                "suggested_batches": [{"start_line": index, "end_line": index} for index in range(1, 10)],
            }
            blocks = build_source_blocks(workspace, source_index)
            labels: list[str] = []

            def run_model(prompt: str, label: str, output_file: Path) -> None:
                labels.append(label)
                output_file.parent.mkdir(parents=True, exist_ok=True)
                if label.startswith("novel-read-"):
                    order = int(label.split("-")[-1])
                    payload = leaf_semantics(blocks[order - 1])
                elif label.startswith("novel-arc-"):
                    matched = re.search(r"本组覆盖原文范围：L(\d+)-L(\d+)", prompt)
                    self.assertIsNotNone(matched)
                    payload = story_arc_semantics(int(matched.group(1)), int(matched.group(2)))
                else:
                    payload = final_semantics()
                output_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            common = {
                "workspace": workspace,
                "skill_root": SKILL_ROOT,
                "prepared": {"source_index": source_index, "adaptation_plan": {"target_episode_count": 35, "max_outline_unit_count": 6}},
                "project": {"project_name": "九段故事"},
                "preferences": [],
                "run_model": run_model,
                "validate_final": lambda _path: [],
            }
            prepare_novel_analysis_draft(job_id=82, **common)
            self.assertEqual(len([label for label in labels if label.startswith("novel-read-")]), 9)
            self.assertEqual(len([label for label in labels if label.startswith("novel-arc-")]), 3)

            labels.clear()
            prepare_novel_analysis_draft(job_id=83, **common)
            self.assertEqual(labels, ["novel-analysis-synthesis"])


if __name__ == "__main__":
    unittest.main()
