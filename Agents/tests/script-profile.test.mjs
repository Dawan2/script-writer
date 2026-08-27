import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDistributionBrief } from "../.claude/tools/distribution-brief.mjs";
import { resolveScriptProfile } from "../.claude/tools/resolve-script-profile.mjs";
import { assertScriptProfileResolved, SCRIPT_TAG_TAXONOMY } from "../.claude/tools/script-profile.mjs";
import { DEFAULT_TAXONOMY } from "../skills/script-distillation/scripts/distillation-utils.mjs";

const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function createWorkspace(t, taskType = "rewrite", brief = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-script-profile-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "1.1-user-input.json"), `${JSON.stringify({
    project: {
      task_type: taskType,
      distribution_brief: {
        ...buildDistributionBrief({ targetCountry: "美国", targetLocale: "en-US", taskType }),
        ...brief
      }
    }
  }, null, 2)}\n`, "utf8");
  return workspace;
}

test("创作场景默认自动适配，非创作场景不保存剧本设定", () => {
  const creative = buildDistributionBrief({ targetCountry: "美国", targetLocale: "en-US", taskType: "rewrite" });
  assert.deepEqual(creative.theme, ["自动适配"]);
  assert.deepEqual(creative.setting, ["自动适配"]);
  assert.deepEqual(creative.background, ["自动适配"]);
  assert.deepEqual(creative.audience, ["自动适配"]);
  assert.throws(
    () => assertScriptProfileResolved({ task_type: "rewrite", distribution_brief: creative }, "world_view"),
    /仍为自动适配/u
  );

  for (const taskType of ["review", "translate", "humanize"]) {
    const brief = buildDistributionBrief({ targetCountry: "美国", targetLocale: "en-US", taskType });
    for (const field of ["theme", "setting", "background", "audience"]) {
      assert.equal(Object.hasOwn(brief, field), false);
    }
  }
});

test("解析剧本设定只替换自动适配字段", async (t) => {
  const workspace = await createWorkspace(t, "rewrite", { theme: ["悬疑"] });
  const result = await resolveScriptProfile({
    workspace,
    stage: "world_view",
    updatedBy: "tester",
    theme: "不存在的主题",
    setting: "大女主,强强联合",
    background: "现代,都市",
    audience: "女频"
  });
  assert.deepEqual(result.resolved_fields, ["setting", "background", "audience"]);
  assert.deepEqual(result.preserved_fields, ["theme"]);
  assert.deepEqual(result.script_profile.theme, ["悬疑"]);
  assert.deepEqual(assertScriptProfileResolved({
    task_type: "rewrite",
    distribution_brief: result.script_profile
  }, "world_view"), result.script_profile);

  const stored = JSON.parse(await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8"));
  assert.deepEqual(stored.project.distribution_brief.theme, ["悬疑"]);
  assert.equal(stored.project.distribution_brief.script_profile_resolution.stage, "world_view");
});

test("用户选择的标签即使语义冲突也保持原样", () => {
  const brief = buildDistributionBrief({
    targetCountry: "美国",
    targetLocale: "en-US",
    taskType: "rewrite",
    theme: ["民国爱情"],
    setting: ["大女主"],
    background: ["现代", "古代"],
    audience: ["女频"]
  });

  assert.deepEqual(brief.theme, ["民国爱情"]);
  assert.deepEqual(brief.background, ["现代", "古代"]);
  assert.deepEqual(assertScriptProfileResolved({
    task_type: "rewrite",
    distribution_brief: brief
  }, "world_view"), {
    theme: ["民国爱情"],
    setting: ["大女主"],
    background: ["现代", "古代"],
    audience: ["女频"]
  });
});

test("自动补全的标签仍需适配用户选择", () => {
  assert.throws(() => assertScriptProfileResolved({
    task_type: "rewrite",
    distribution_brief: {
      theme: ["民国爱情"],
      setting: ["大女主"],
      background: ["现代", "都市"],
      audience: ["女频"],
      inferred_fields: ["theme"]
    }
  }, "world_view"), /民国爱情与当前主背景不一致/u);
});

test("解析剧本设定拒绝阶段错位和冲突背景", async (t) => {
  const workspace = await createWorkspace(t, "novel");
  await assert.rejects(resolveScriptProfile({
    workspace,
    stage: "world_view",
    updatedBy: "tester"
  }), /只能在 novel_analysis 阶段/u);
  await assert.rejects(resolveScriptProfile({
    workspace,
    stage: "novel_analysis",
    updatedBy: "tester",
    theme: "悬疑",
    setting: "大女主",
    background: "现代,古代",
    audience: "女频"
  }), /背景不能同时标注现代、古代/u);
});

test("Agent 与剧本库使用同一套受控标签", async () => {
  const libraryTaxonomy = JSON.parse(await fs.readFile(
    path.join(agentsRoot, ".claude", "config", "script-tag-taxonomy.json"),
    "utf8"
  ));
  assert.deepEqual(SCRIPT_TAG_TAXONOMY, libraryTaxonomy);
  assert.deepEqual(DEFAULT_TAXONOMY, libraryTaxonomy);
});
