import assert from "node:assert/strict";
import test from "node:test";
import {
  actionLineIssues,
  normalizeActionLineSpacing
} from "../.claude/skills/_shared/scripts/screenplay-format-validation.mjs";

test("动作行缺少空格时自动补齐", () => {
  const result = normalizeActionLineSpacing([
    "△玛雅推开房门。",
    "△ 约翰后退一步。",
    "玛雅：不要动。"
  ].join("\n"));

  assert.equal(result.content, [
    "△ 玛雅推开房门。",
    "△ 约翰后退一步。",
    "玛雅：不要动。"
  ].join("\n"));
  assert.equal(result.repairedLineCount, 1);
});

test("动作行兼容三角标记后有无空格", () => {
  assert.deepEqual(actionLineIssues(["△玛雅推开房门。"], "第 1 集"), []);
  assert.deepEqual(actionLineIssues(["△ 玛雅推开房门。"], "第 1 集"), []);
});

test("缺少动作时返回可直接执行的格式和示例", () => {
  const issues = actionLineIssues(["人物：玛雅", "玛雅：开门。"], "第 2 集");

  assert.deepEqual(issues, [
    "第 2 集没有检测到可拍动作；请至少添加一行以“△ ”开头的具体动作，例如“△ 玛雅推开房门。”"
  ]);
});

test("空动作标记会明确指出缺少动作内容", () => {
  assert.deepEqual(actionLineIssues(["△   "], "第 3 集"), [
    "第 3 集的动作行只有“△”标记，没有动作内容；请在“△”后写明具体可拍动作，例如“△ 玛雅推开房门。”"
  ]);
});
