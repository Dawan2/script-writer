import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkOutline } from "../.claude/skills/outline_rewrite/scripts/check-outline.mjs";
import { validateAdmissionGate } from "../.claude/skills/foreign_review/scripts/check-review-admission.mjs";

const roleName = "艾玛·格兰特";

function episode(number) {
  return {
    "集数": number,
    "剧集名称": `第${number}集`,
    "关键角色": [roleName],
    "写作思路": {
      "开场冲突": "证据当场被夺走。",
      "主要转折": ["她决定主动追查。"],
      "结尾承接": "新的线索迫使她继续行动。"
    },
    "剧集梗概": "她为夺回证据主动追查，局面因此升级。"
  };
}

function outlineFixture(episodeCount) {
  return {
    "剧本名称": "边界追查",
    "英文剧本名称": "Boundary Pursuit",
    "关键角色名称映射": [{ "英文名称": "Emma Grant", "中文名称": roleName }],
    "故事梗概": "艾玛为夺回证据展开追查，最终以代价换回真相。",
    "开篇": {
      "开篇描述": "艾玛发现证据被夺走，必须立刻追查。",
      "关键角色": [roleName],
      "剧集": [episode(1)]
    },
    "剧情单元": [{
      "单元名称": "追查",
      "单元描述": "艾玛持续追查，关系与风险不断升级。",
      "关键角色": [roleName],
      "剧集": Array.from({ length: episodeCount - 1 }, (_, index) => episode(index + 2))
    }]
  };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

test("剧本大纲总集数必须等于用户目标，未填写时默认为 35 集", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-outline-episode-count-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeJson(path.join(workspace, "1.2-project-progress.json"), {
    stages: { outline_rewrite: { status: "in_progress" } }, audit: {}
  });
  await writeJson(path.join(workspace, "1.1-user-input.json"), {
    project: { source_script: { display_name: "旧剧本" } }
  });
  await writeJson(path.join(workspace, "3.1-outline.json"), outlineFixture(34));

  const defaultResult = await checkOutline(workspace, "episode-count-test");
  assert.equal(defaultResult.ok, false);
  assert.ok(defaultResult.issues.includes("剧本大纲总集数必须为 35 集，当前为 34 集"));

  await writeJson(path.join(workspace, "1.1-user-input.json"), {
    project: {
      source_script: { display_name: "旧剧本" },
      distribution_brief: { target_episode_count: 34 }
    }
  });
  const targetResult = await checkOutline(workspace, "episode-count-test");
  assert.equal(targetResult.ok, true);
});

function reviewIndex(episodeCount) {
  return {
    structure_status: "规范分集",
    units: Array.from({ length: episodeCount }, (_, index) => ({
      type: "剧集",
      mechanical_stats: { characters: 300, non_empty_lines: 3 },
      episode: index + 1
    }))
  };
}

function admissionForEpisodeCount(episodeCount, result) {
  const names = ["集数达标", "内容密度", "终稿洁净度", "标题承诺兑现", "主角能力有来源", "世界规则自洽", "角色关系成立", "爽点持续升级", "台词可执行", "视听与AI生产"];
  return {
    "结论": result === "不通过" ? "不通过" : result === "部分通过" ? "部分通过" : "通过",
    "一句话判断": "十项基础条件已按当前正式集数完成判断，可据此确定是否继续评级。",
    "检查项": names.map((name) => ({
      "检查项": name,
      "结果": name === "集数达标" ? result : "通过",
      "说明": name === "集数达标"
        ? `**全剧共 ${episodeCount} 集，${result === "通过" ? "达到完整审稿的最低集数" : result === "部分通过" ? "达到部分审稿的最低集数" : "未达到部分审稿的最低集数"}。**`
        : `**${name}满足基础要求。**`,
      "原稿证据": [{ "起始行": 1, "结束行": 1, "说明": "首集建立主角目标。" }]
    })),
    "修改建议": result === "不通过" ? ["补齐至少 10 集的连续正式剧集后重新审稿。"] : []
  };
}

test("海外审稿准入按最低集数判断，不以目标集数限制", () => {
  const fullAdmission = admissionForEpisodeCount(40, "通过");
  assert.equal(validateAdmissionGate(fullAdmission, reviewIndex(40), ["第 1 集"]).ok, true);

  const partialAdmission = admissionForEpisodeCount(10, "部分通过");
  assert.equal(validateAdmissionGate(partialAdmission, reviewIndex(10), ["第 1 集"]).ok, true);

  const rejectedAdmission = admissionForEpisodeCount(9, "不通过");
  assert.equal(validateAdmissionGate(rejectedAdmission, reviewIndex(9), ["第 1 集"]).ok, true);

  const mismatch = admissionForEpisodeCount(40, "不通过");
  const mismatchResult = validateAdmissionGate(mismatch, reviewIndex(40), ["第 1 集"]);
  assert.equal(mismatchResult.ok, false);
  assert.ok(mismatchResult.issues.includes("集数达标应根据当前可确认的 40 集判定为“通过”"));
});
