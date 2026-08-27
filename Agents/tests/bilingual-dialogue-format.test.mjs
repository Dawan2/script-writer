import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBilingualDialogueFormat } from "../.claude/tools/bilingual-dialogue-format.mjs";

test("自动规范已存在的双语台词对，不改动台词文本", () => {
  const source = [
    "林夏（压低声音）：你不能带走证据。",
    "",
    "",
    "(You cannot take the evidence.)",
    "",
    "周默：你来晚了。   ",
    "  (You are too late.)  ",
    ""
  ].join("\n");

  const result = normalizeBilingualDialogueFormat(source);

  assert.equal(result.changed, true);
  assert.deepEqual(result.repairs, {
    repaired_pairs: 2,
    normalized_dialogue_lines: 2,
    normalized_translation_lines: 1,
    removed_blank_lines: 2
  });
  assert.equal(result.content, [
    "林夏（压低声音）：你不能带走证据。  ",
    "(You cannot take the evidence.)",
    "",
    "周默：你来晚了。  ",
    "(You are too late.)",
    ""
  ].join("\n"));
  assert.equal(normalizeBilingualDialogueFormat(result.content).changed, false);
});

test("缺少或无法确认译文时不自动补写", () => {
  const source = [
    "林夏：你不能带走证据。",
    "",
    "△周默转身离开。",
    "",
    "人物：林夏、周默",
    "(Characters: Lin Xia and Zhou Mo.)"
  ].join("\n");

  const result = normalizeBilingualDialogueFormat(source);

  assert.equal(result.changed, false);
  assert.equal(result.content, source);
  assert.deepEqual(result.repairs, {
    repaired_pairs: 0,
    normalized_dialogue_lines: 0,
    normalized_translation_lines: 0,
    removed_blank_lines: 0
  });
});
