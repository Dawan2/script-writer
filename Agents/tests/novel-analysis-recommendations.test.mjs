import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptNovelAnalysisRecommendations } from "../.claude/skills/novel_analysis/scripts/accept-novel-analysis-recommendations.mjs";
import { checkNovelAnalysis } from "../.claude/skills/novel_analysis/scripts/check-novel-analysis.mjs";
import { getAdaptationContext } from "../.claude/tools/get-adaptation-context.mjs";

function unit({ id, name, sourceIndex, recommendation = "保留", mergeTarget = "" }) {
  return {
    "单元ID": id,
    "单元名称": name,
    "单元梗概": `${name}推动主角继续追查。`,
    "主线推进": "主角获得新的行动依据。",
    "关键人物": [{ "人物名称": "林夏", "单元作用与变化": "从怀疑转为主动行动。" }],
    "关键信息": ["证据会改变后续选择。"],
    "高光时刻": [{ "名称": `${name}高光`, "原文索引": sourceIndex }],
    "改编建议": recommendation,
    "合并目标单元ID": mergeTarget,
    "已确认合并": false,
    "建议原因": "该单元的取舍符合目标剧本容量。"
  };
}

test("批量小说解读自动接纳删除与合并建议，并只传递确认后的内容", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-novel-recommendations-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
  await fs.writeFile(path.join(workspace, "1.1-user-input.json"), `${JSON.stringify({
    project: {
      task_type: "novel",
      distribution_brief: {
        target_episode_count: 6,
        episode_duration: "90秒",
        theme: ["悬疑"],
        setting: ["大女主"],
        background: ["现代", "都市"],
        audience: ["女频"]
      }
    }
  })}\n`, "utf8");
  await fs.writeFile(path.join(workspace, "runtime", "novel-source-index.json"), `${JSON.stringify({ total_lines: 3 })}\n`, "utf8");
  await fs.writeFile(path.join(workspace, "2.1-novel-analysis.json"), `${JSON.stringify({
    "基础信息": { "小说名称": "测试小说", "小说梗概": "林夏追查身份真相。", "题材": ["悬疑"], "基调": "紧张" },
    "核心卖点": "每次证据公开都会改变权力关系。",
    "故事主线": "林夏持续追查并公开真相。",
    "世界观": "证据公开能够改变家族权力归属。",
    "关键人物": [{ "人物名称": "林夏", "人物画像": "她从依赖认可转为主动公开真相。" }],
    "剧情单元": [
      unit({ id: "unit-keep", name: "公开证据", sourceIndex: "L1-L1" }),
      unit({ id: "unit-delete", name: "重复追查", sourceIndex: "L2-L2", recommendation: "删除" }),
      unit({ id: "unit-merge", name: "反击余波", sourceIndex: "L3-L3", recommendation: "合并", mergeTarget: "unit-keep" })
    ]
  }, null, 2)}\n`, "utf8");

  const before = await checkNovelAnalysis(workspace, "test", { validateOnly: true });
  assert.equal(before.ok, true);

  const allDeleted = JSON.parse(await fs.readFile(path.join(workspace, "2.1-novel-analysis.json"), "utf8"));
  allDeleted["剧情单元"].forEach((item) => {
    item["改编建议"] = "删除";
    item["合并目标单元ID"] = "";
    item["已确认合并"] = false;
  });
  await fs.writeFile(path.join(workspace, "2.1-novel-analysis.json"), `${JSON.stringify(allDeleted, null, 2)}\n`, "utf8");
  const allDeletedCheck = await checkNovelAnalysis(workspace, "test", { validateOnly: true });
  assert.equal(allDeletedCheck.ok, false);
  assert.ok(allDeletedCheck.issues.includes("剧情单元至少需要一个建议保留的单元"));
  await assert.rejects(acceptNovelAnalysisRecommendations(workspace), /至少需要一个建议保留的单元/u);

  allDeleted["剧情单元"][0]["改编建议"] = "保留";
  allDeleted["剧情单元"][1]["改编建议"] = "删除";
  allDeleted["剧情单元"][2]["改编建议"] = "合并";
  allDeleted["剧情单元"][2]["合并目标单元ID"] = "unit-keep";
  await fs.writeFile(path.join(workspace, "2.1-novel-analysis.json"), `${JSON.stringify(allDeleted, null, 2)}\n`, "utf8");

  const accepted = await acceptNovelAnalysisRecommendations(workspace);
  assert.deepEqual(accepted.recommendation_counts, { retain: 1, delete: 1, merge: 1 });
  assert.equal(accepted.deleted_unit_count, 1);
  assert.equal(accepted.newly_confirmed_merge_count, 1);
  assert.equal(accepted.remaining_unit_count, 2);
  assert.equal(Object.hasOwn(accepted, "analysis"), false);

  const stored = JSON.parse(await fs.readFile(path.join(workspace, "2.1-novel-analysis.json"), "utf8"));
  assert.deepEqual(stored["剧情单元"].map((item) => item["单元ID"]), ["unit-keep", "unit-merge"]);
  assert.equal(stored["剧情单元"][1]["已确认合并"], true);
  assert.equal((await checkNovelAnalysis(workspace, "test", { validateOnly: true })).ok, true);

  const context = await getAdaptationContext(workspace);
  assert.deepEqual(context.novel_analysis["剧情单元"].map((item) => item["单元ID"]), ["unit-keep", "unit-merge"]);
  assert.equal(context.novel_analysis["剧情单元"][1]["已确认合并"], true);
  assert.equal(context.novel_analysis["剧情单元"][1]["合并目标单元ID"], "unit-keep");

  const repeated = await acceptNovelAnalysisRecommendations(workspace);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.newly_confirmed_merge_count, 0);
});
