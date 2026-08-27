import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject } from "../.claude/skills/project_init/scripts/init-project.mjs";
import { validateProjectWorkspace } from "../.claude/skills/project_init/scripts/validate-project.mjs";
import { updateDistributionBrief } from "../.claude/skills/project_init/scripts/update-distribution-brief.mjs";
import { initializeWorldView } from "../.claude/skills/world_view/scripts/init-world-view.mjs";
import { checkWorldView } from "../.claude/skills/world_view/scripts/check-world-view.mjs";
import { getWorldViewExecutionStrategy } from "../.claude/skills/world_view/scripts/get-execution-strategy.mjs";
import { initializeOutline } from "../.claude/skills/outline_rewrite/scripts/init-outline.mjs";
import { checkOutline } from "../.claude/skills/outline_rewrite/scripts/check-outline.mjs";
import { checkCharacter } from "../.claude/skills/character_rewrite/scripts/check-character.mjs";
import { getEpisodeInfo } from "../.claude/skills/trial_generate/scripts/get-episode-info.mjs";
import { getUserPreferences } from "../.claude/tools/get-user-preferences.mjs";
import { updateStagePreferences } from "../.claude/tools/update-stage-preferences.mjs";
import { checkTrial } from "../.claude/skills/trial_generate/scripts/check-trial.mjs";
import { approveStage } from "../.claude/tools/approve-stage.mjs";
import { initializeFull } from "../.claude/skills/full_generate/scripts/init-full.mjs";
import { getFullExecutionStrategy } from "../.claude/skills/full_generate/scripts/get-execution-strategy.mjs";
import { getStageInfo } from "../.claude/skills/full_generate/scripts/get-stage-info.mjs";
import { mergeFullScript } from "../.claude/skills/full_generate/scripts/merge-full.mjs";
import { checkFull } from "../.claude/skills/full_generate/scripts/check-full.mjs";
import { initializeDialogueTranslation } from "../.claude/skills/dialogue_translate/scripts/init-dialogue-translate.mjs";
import { mergeDialogueTranslation } from "../.claude/skills/dialogue_translate/scripts/merge-dialogue-translate.mjs";
import { checkDialogueTranslation } from "../.claude/skills/dialogue_translate/scripts/check-dialogue-translate.mjs";
import { extractDialogueSource, renderTranslatedScript } from "../.claude/skills/dialogue_translate/scripts/dialogue-translate-utils.mjs";
import { initializeHumanizerZh } from "../.claude/skills/humanizer-zh/scripts/init-humanizer-zh.mjs";
import { checkHumanizerZh } from "../.claude/skills/humanizer-zh/scripts/check-humanizer-zh.mjs";
import { initializeForeignReview } from "../.claude/skills/foreign_review/scripts/init-foreign-review.mjs";
import { checkForeignReview } from "../.claude/skills/foreign_review/scripts/check-foreign-review.mjs";
import { buildReviewSourceIndex } from "../.claude/skills/foreign_review/scripts/index-review-source.mjs";
import { checkReviewAdmission, contentDensityAssessment, validateAdmissionGate } from "../.claude/skills/foreign_review/scripts/check-review-admission.mjs";
import {
  calculateReviewScoringState,
  createReviewScoringState,
  gradeForScore,
  overallGradeForScore,
  REPAIR_SCOPES,
  REVIEW_METHOD_TEMPLATE,
  REQUIRED_CHECKS,
  resolveReviewInput,
  SCORECARD_SCHEMA_VERSION,
  synchronizeScorecardGrades,
  upgradeReviewScorecard
} from "../.claude/skills/foreign_review/scripts/foreign-review-utils.mjs";
import { calculateReviewScore } from "../.claude/skills/foreign_review/scripts/calculate-review-score.mjs";
import { updateProgress } from "../.claude/tools/update-progress.mjs";
import { resolveScriptProfile } from "../.claude/tools/resolve-script-profile.mjs";

const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCALIZED_NAME = "艾玛·格兰特";
const ENGLISH_NAME = "Emma Grant";

async function readJson(filePath) {
  return fs.readFile(filePath, "utf8").then(JSON.parse);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function episode(number) {
  return {
    "集数": number,
    "剧集名称": "第" + number + "集",
    "关键角色": [LOCALIZED_NAME],
    "写作思路": {
      "开场冲突": `${LOCALIZED_NAME}收到威胁。`,
      "主要转折": ["她主动追查线索。"],
      "结尾承接": "新的证据迫使她继续行动。"
    },
    "剧集梗概": `${LOCALIZED_NAME}为追回被夺走的证据主动出击，局面因此升级。`
  };
}

function screenplayEpisode(number) {
  const action = `${LOCALIZED_NAME}沿着走廊追上周默，反复核对手机里的时间、地点和联系人，并在每一次犹豫后重新确认要把证据带回公开场合。`.repeat(12);
  return [
    "## 第" + number + "集：第" + number + "集",
    "",
    "### " + number + "-1 日 内 走廊",
    `人物：${LOCALIZED_NAME}`,
    "△" + action,
    `${LOCALIZED_NAME}：你不能带走证据。`
  ].join("\n");
}

function sceneGroupedEpisode(number) {
  const action = `${LOCALIZED_NAME}在压力下确认新的行动目标，和对手正面交锋后保留关键证据，并把下一步风险转化为更明确的选择。`.repeat(5);
  return [
    `\\#\\#\\# 场${number}\\-1`,
    "",
    "日 内 走廊",
    `人物：${LOCALIZED_NAME}`,
    `△${action}`,
    `${LOCALIZED_NAME}：我会把证据带出去。`,
    "",
    `\\#\\#\\# 场${number}\\-2`,
    "",
    "夜 内 会议室",
    `人物：${LOCALIZED_NAME}`,
    `△${action}`,
    `${LOCALIZED_NAME}：下一次我会先做选择。`
  ].join("\n");
}

function outlineFixture() {
  return {
    "英文剧本名称": "Boundary Pursuit",
    "关键角色名称映射": [{
      "英文名称": ENGLISH_NAME,
      "中文名称": LOCALIZED_NAME
    }],
    "故事梗概": `${LOCALIZED_NAME}在证据被夺后主动追查，最终以代价换回真相。`,
    "开篇": {
      "开篇描述": `${LOCALIZED_NAME}当场发现证据被夺走，必须立刻选择追查。`,
      "关键角色": [LOCALIZED_NAME],
      "剧集": [episode(1)]
    },
    "剧情单元": [{
      "单元名称": "追查",
      "单元描述": `${LOCALIZED_NAME}持续追查线索，关系与风险不断升级。`,
      "关键角色": [LOCALIZED_NAME],
      "剧集": Array.from({ length: 34 }, (_, index) => episode(index + 2))
    }]
  };
}

function characterFixture() {
  return [{
    "人物名称": LOCALIZED_NAME,
    "性别": "女",
    "国籍": "美国",
    "年龄": "30岁",
    "身份": "调查者",
    "外貌": "利落短发，目光始终盯着细节",
    "穿着": "深色风衣、便于行动的长裤和旧皮质笔记本包",
    "性格": "冷静执拗，习惯先核实再行动",
    "所属阵营": "真相追查者",
    "是否主角": true,
    "人物关系": [],
    "核心诉求": "找回证据并证明真相。",
    "人物难题": "每次追查都会让她失去新的信任。",
    "关系与弧光": "她从独自追查，发展为愿意承担公开真相的代价。",
    "阶段变化": [{
      "故事阶段": "开篇",
      "身份与处境": "证据刚被夺走的调查者。",
      "人物形象": "30岁的调查者，利落短发、目光始终盯着细节，穿深色风衣、便于行动的长裤和旧皮质笔记本包，冷静执拗，习惯先核实再行动。",
      "口吻": "句子短而具体，先追问可验证的事实，再逼对方表态；压力下仍不泄露未核实的判断。"
    }, {
      "故事阶段": "追查",
      "身份与处境": "持续追查并承受新的威胁。",
      "人物形象": "30岁的调查者，利落短发、目光始终盯着细节，穿深色风衣、便于行动的长裤和旧皮质笔记本包，冷静执拗，习惯先核实再行动，连续行动后衣着沾灰但保持警觉。",
      "口吻": "仍以事实开场，但会明确提出交换条件和行动期限；遭遇威胁时直接点出对方必须承担的后果。"
    }]
  }];
}

test("人物关系图谱必须指定唯一主角并保持连接", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-character-graph-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const outline = outlineFixture();
  outline["关键角色名称映射"].push({
    "英文名称": "Noah Reed",
    "中文名称": "诺亚·里德"
  });
  outline["开篇"]["关键角色"] = [LOCALIZED_NAME, "诺亚·里德"];
  outline["开篇"]["剧集"].forEach((item) => { item["关键角色"] = [LOCALIZED_NAME, "诺亚·里德"]; });
  outline["剧情单元"].forEach((unit) => {
    unit["关键角色"] = [LOCALIZED_NAME, "诺亚·里德"];
    unit["剧集"].forEach((item) => { item["关键角色"] = [LOCALIZED_NAME, "诺亚·里德"]; });
  });
  await writeJson(path.join(workspaceDir, "3.1-outline.json"), outline);

  const characters = characterFixture();
  characters[0]["人物关系"] = [{ "关联人物": "诺亚·里德", "关系": "合作调查者" }];
  characters.push({
    "人物名称": "诺亚·里德",
    "性别": "男",
    "国籍": "美国",
    "年龄": "35岁",
    "身份": "证据持有人",
    "外貌": "轮廓分明，眼下带着长期失眠的疲惫",
    "穿着": "剪裁合身的深灰西装，袖口始终整齐",
    "性格": "谨慎克制，先衡量风险再给出承诺",
    "所属阵营": "真相追查者",
    "是否主角": true,
    "人物关系": [{ "关联人物": LOCALIZED_NAME, "关系": "被试探的盟友" }],
    "核心诉求": "在自保的前提下让证据获得可信的公开渠道。",
    "人物难题": `过去的沉默使他难以获得${LOCALIZED_NAME}的完全信任。`,
    "关系与弧光": `他从把${LOCALIZED_NAME}当作风险，转为以行动证明自己愿意承担公开真相的代价。`,
    "阶段变化": [{
      "故事阶段": "开篇",
      "身份与处境": "掌握证据却受人监视的关键证人。",
      "人物形象": "35岁的证据持有人，轮廓分明、眼下带着长期失眠的疲惫，穿剪裁合身的深灰西装、袖口始终整齐，谨慎克制，先衡量风险再给出承诺。",
      "口吻": "措辞保留，只回应可验证的问题；每次承诺前先确认交换条件，不谈未准备公开的信息。"
    }, {
      "故事阶段": "追查",
      "身份与处境": `与${LOCALIZED_NAME}共同追查并开始承担公开风险。`,
      "人物形象": "35岁的证据持有人，轮廓分明、眼下带着长期失眠的疲惫，穿剪裁合身的深灰西装、袖口始终整齐，谨慎克制，先衡量风险再给出承诺，连夜奔走后仍保持克制。",
      "口吻": "愿意明确提出共同目标与可交换资源，但继续划清自己不能透露的信息边界。"
    }]
  });
  await writeJson(path.join(workspaceDir, "4.1-character.json"), characters);

  const result = await checkCharacter(workspaceDir, "graph-test");
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("人物关系图谱必须且只能指定一位主角"));

  characters[1]["是否主角"] = false;
  characters[0]["人物关系"] = [];
  characters[1]["人物关系"] = [];
  await writeJson(path.join(workspaceDir, "4.1-character.json"), characters);
  const disconnected = await checkCharacter(workspaceDir, "graph-test");
  assert.equal(disconnected.ok, false);
  assert.ok(disconnected.issues.includes("人物关系图谱存在未连接角色：诺亚·里德"));
});

test("国内发行的角色小传不显示英文名称", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-domestic-character-title-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await writeJson(path.join(workspaceDir, "1.1-user-input.json"), {
    project: {
      target_region: "国内",
      distribution_brief: { requires_translation: false }
    }
  });
  await writeJson(path.join(workspaceDir, "1.2-project-progress.json"), {
    stages: { character_rewrite: { status: "in_progress" } }
  });
  await writeJson(path.join(workspaceDir, "3.1-outline.json"), outlineFixture());
  await writeJson(path.join(workspaceDir, "4.1-character.json"), characterFixture());

  assert.equal((await checkCharacter(workspaceDir, "domestic-title-test")).ok, true);
  const markdown = await fs.readFile(path.join(workspaceDir, "output", "角色小传.md"), "utf8");
  assert.match(markdown, new RegExp(`## ${LOCALIZED_NAME}`, "u"));
  assert.doesNotMatch(markdown, new RegExp(`## ${LOCALIZED_NAME}（${ENGLISH_NAME}）`, "u"));
});

test("剧本改编大纲开头展示可编辑的关键角色名称，JSON 不保留原名", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-outline-role-names-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const outline = { "剧本名称": "边界追查", ...outlineFixture() };
  outline["关键角色名称映射"][0]["原角色名称"] = "林夏";
  await writeJson(path.join(workspaceDir, "3.1-outline.json"), outline);
  await writeJson(path.join(workspaceDir, "1.1-user-input.json"), {
    project: { task_type: "rewrite", source_script: { display_name: "旧剧本" } }
  });

  const result = await checkOutline(workspaceDir, "outline-role-name-test");
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("关键角色名称映射第 1 项字段必须与 outline.json5 一致"));

  delete outline["关键角色名称映射"][0]["原角色名称"];
  await writeJson(path.join(workspaceDir, "3.1-outline.json"), outline);
  await writeJson(path.join(workspaceDir, "1.2-project-progress.json"), {
    stages: { outline_rewrite: { status: "in_progress" } },
    audit: {}
  });
  const passed = await checkOutline(workspaceDir, "outline-role-name-test");
  assert.equal(passed.ok, true);
  const markdown = await fs.readFile(passed.output_file, "utf8");
  const persistedOutline = await readJson(path.join(workspaceDir, "3.1-outline.json"));
  assert.match(markdown, /## 关键角色名称/u);
  assert.match(markdown, new RegExp(`- ${LOCALIZED_NAME}（${ENGLISH_NAME}）`, "u"));
  assert.doesNotMatch(markdown, /\| 中文名称 \| 英文名称 \|/u);
  assert.deepEqual(Object.keys(persistedOutline["关键角色名称映射"][0]), ["英文名称", "中文名称"]);
  assert.doesNotMatch(markdown, /原角色名称/u);
});

const REVIEW_CHECKS = REQUIRED_CHECKS;

test("旧版审稿评分卡可升级到当前结构", () => {
  const legacy = {
    "schema_version": "2.1.0",
    "评级依据": { "审读范围": "全文", "决策方法": "逐集审读", "六维结论": [] },
    "六维分析": [{ "维度": "市场与选题", "评级": "A", "判断": "卖点成立。", "表格导读": "旧字段", "检查项": [] }],
    "剧本信息": { "剧本名称": "测试剧", "频类": "竖屏短剧", "题材": ["悬疑"], "剧本标签": ["追查"], "一句话介绍": "测试介绍", "剧情梗概": "测试梗概" },
    "卖点拆解": [{ "卖点": "测试卖点", "状态": "尚未兑现" }]
  };
  const upgraded = upgradeReviewScorecard(legacy);
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.scorecard.schema_version, SCORECARD_SCHEMA_VERSION);
  assert.equal(upgraded.scorecard["评级依据"]["审稿方法"], REVIEW_METHOD_TEMPLATE);
  assert.equal(Object.hasOwn(upgraded.scorecard["六维分析"][0], "表格导读"), false);
  assert.equal(Object.hasOwn(upgraded.scorecard["剧本信息"], "频类"), false);
  assert.equal(Object.hasOwn(upgraded.scorecard["剧本信息"], "一句话介绍"), false);
  assert.equal(upgraded.scorecard["卖点拆解"][0]["状态"], "兑现不足");

  const v22 = upgradeReviewScorecard({
    "schema_version": "2.2.0",
    "剧本信息": { "剧本名称": "测试剧", "频类": "竖屏短剧", "题材": [], "剧本标签": [], "一句话介绍": "测试介绍", "剧情梗概": "测试梗概" },
    "卖点拆解": [{ "卖点": "测试卖点", "状态": "尚未兑现" }]
  });
  assert.equal(v22.scorecard.schema_version, SCORECARD_SCHEMA_VERSION);
  assert.equal(Object.hasOwn(v22.scorecard["剧本信息"], "频类"), false);
  assert.equal(v22.scorecard["卖点拆解"][0]["状态"], "兑现不足");

  const v23 = upgradeReviewScorecard({
    "schema_version": "2.3.0",
    "六维分析": [{
      "维度": "成片与制作",
      "检查项": [{ "检查项": "90 秒承载" }]
    }]
  });
  assert.equal(v23.scorecard.schema_version, SCORECARD_SCHEMA_VERSION);
  assert.equal(v23.scorecard["六维分析"][0]["检查项"][0]["检查项"], "内容量承载");

  const v25 = upgradeReviewScorecard({
    "schema_version": "2.5.0",
    "评级依据": {
      "六维结论": [{ "分析维度": "发行与风险", "评级": "A", "结论": "通过", "一句话判断": "沿用旧口径的结论。" }]
    },
    "六维分析": [{
      "维度": "发行与风险",
      "评级": "A",
      "判断": "沿用旧口径的判断。",
      "检查项": [{ "检查项": "内容分级与敏感呈现", "评级": "A", "问题说明": "旧口径。", "原稿证据": [] }]
    }]
  });
  assert.equal(v25.changed, true);
  assert.equal(v25.scorecard.schema_version, SCORECARD_SCHEMA_VERSION);
  assert.deepEqual(v25.scorecard["六维分析"][0]["检查项"].map((item) => item["检查项"]), ["用户粘性", "传播潜力", "内容合规性", "价值观导向"]);
  assert.equal(v25.scorecard["六维分析"][0]["评级"], "");
  assert.equal(v25.scorecard["六维分析"][0]["判断"], "");
  assert.deepEqual(v25.scorecard["评级依据"]["六维结论"][0], { "分析维度": "发行与风险", "评级": "", "结论": "", "一句话判断": "" });
});

test("发行与风险使用用户与内容口径的四项检查", () => {
  assert.deepEqual(REVIEW_CHECKS["发行与风险"], ["用户粘性", "传播潜力", "内容合规性", "价值观导向"]);
});

test("审稿评分按配置权重归并总体评级，分数不写入评分卡", () => {
  const state = createReviewScoringState({ scriptHash: "score-test" });
  const scores = {
    "市场与选题": 100,
    "故事结构与逻辑": 70,
    "人物与关系": 80,
    "单集节奏与留存": 90,
    "成片与制作": 100,
    "发行与风险": 60,
  };
  state["维度"].forEach((dimension) => {
    dimension["检查项"].forEach((check) => {
      check["分数"] = scores[dimension["维度"]];
    });
  });
  const calculated = calculateReviewScoringState(state, "score-test");
  assert.equal(calculated["总分"], 83);
  assert.equal(calculated["总体评级"], "A");
  assert.deepEqual(calculated["维度"].map((dimension) => dimension["评级"]), ["SS", "B", "A", "S", "SS", "C"]);

  const scoreScript = Array.from({ length: 35 }, (_, index) => screenplayEpisode(index + 1)).join("\n\n");
  const publicCard = scorecard("返修", "剧本全稿", "output/剧本全稿.md", scoreScript);
  const synchronized = synchronizeScorecardGrades(publicCard, calculated);
  assert.equal(synchronized["总体结论"]["评级"], "A");
  assert.equal(/"(?:总分|得分|分数|权重)"\s*:/u.test(JSON.stringify(synchronized)), false);
});

test("审稿评分严格使用配置的评级阈值，并只给总体评级加号", () => {
  [
    [0, "D"],
    [59.99, "D"],
    [60, "C"],
    [69.99, "C"],
    [70, "B"],
    [79.99, "B"],
    [80, "A"],
    [89.99, "A"],
    [90, "S"],
    [97.99, "S"],
    [98, "SS"],
    [100, "SS"]
  ].forEach(([score, grade]) => assert.equal(gradeForScore(score), grade));

  assert.equal(overallGradeForScore(70), "B");
  assert.equal(overallGradeForScore(75), "B");
  assert.equal(overallGradeForScore(79), "B+");
  assert.equal(overallGradeForScore(80), "A");
  assert.equal(overallGradeForScore(98), "SS");
});

test("连续场次标记归并为剧集，并据此判断内容密度和标题兑现", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-review-scene-episodes-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const scriptPath = path.join(workspaceDir, "output", "剧本全稿.md");
  const scriptText = Array.from({ length: 35 }, (_, index) => sceneGroupedEpisode(index + 1)).join("\n\n");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, scriptText, "utf8");
  await writeJson(path.join(workspaceDir, "review-input.json"), {
    script_path: "output/剧本全稿.md",
    script_title: "场次分集测试剧",
    target_market: "美国",
    target_locale: "en-US",
    episode_duration: "60 秒",
    maturity_target: "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头"
  });

  const index = await buildReviewSourceIndex(workspaceDir);
  assert.equal(index.structure_status, "规范分集");
  assert.equal(index.units.filter((unit) => unit.type === "剧集").length, 35);
  assert.equal(index.units[0].episode, 1);
  assert.equal(index.units.at(-1).episode, 35);
  assert.equal(contentDensityAssessment(index).result, "通过");

  const card = scorecard("返修", "剧本全稿", "output/剧本全稿.md", scriptText);
  const valid = validateAdmissionGate(card["准入标准"], index, scriptText.split("\n"));
  assert.equal(valid.ok, true);
  assert.equal(card["准入标准"]["检查项"][0]["结果"], "通过");
  assert.equal(card["准入标准"]["检查项"][1]["结果"], "通过");

  card["准入标准"]["检查项"][3]["结果"] = "部分通过";
  const invalid = validateAdmissionGate(card["准入标准"], index, scriptText.split("\n"));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.includes("标题承诺兑现只能判定为“通过”或“不通过”，不得使用“部分通过”"));
});

function scorecard(verdict, repairScope, scriptFile, scriptText) {
  const titledEpisodeCount = [...scriptText.matchAll(/^##\s*第\s*\d+\s*集/gmu)].length;
  const sceneEpisodeCount = new Set([...scriptText.matchAll(/^\\#\\#\\#\s*场\s*(\d+)\\-\d+/gmu)].map((match) => match[1])).size;
  const episodeCount = titledEpisodeCount || sceneEpisodeCount;
  const episodeAdmission = episodeCount >= 35 ? "通过" : "不通过";
  const admissionItems = [
    "集数达标", "内容密度", "终稿洁净度", "标题承诺兑现", "主角能力有来源",
    "世界规则自洽", "角色关系成立", "爽点持续升级", "台词可执行", "视听与AI生产"
  ].map((name, index) => ({
    "检查项": name,
    "结果": index === 0 ? episodeAdmission : "通过",
    "说明": index === 0 && episodeAdmission === "不通过"
      ? `**全剧仅 ${episodeCount} 集，未达到最低交付集数。**`
      : index === 0
        ? `**全剧共 ${episodeCount} 集，满足最低交付集数。**`
        : `**${name}满足基础要求。**`,
    "原稿证据": [{ "起始行": 1, "结束行": 1, "说明": "第 1 集开场建立主角追查目标。" }]
  }));
  const dimensions = Object.entries(REVIEW_CHECKS).map(([name, checks]) => ({
    "维度": name,
    "评级": "A",
    "判断": `${name}的核心要求已在剧情中建立，具备基础成立条件。`,
    "检查项": checks.map((check) => ({
      "检查项": check,
      "评级": "A",
      "问题说明": `${check}的信息表达完整，剧情功能明确。`,
      "原稿证据": [{ "起始行": 1, "结束行": 1, "说明": "第 1 集开场建立主角追查目标。" }]
    }))
  }));
  return {
    "schema_version": SCORECARD_SCHEMA_VERSION,
    "审稿信息": {
      "审稿模式": "剧本改写审稿",
      "剧本文件": scriptFile,
      "剧本哈希": createHash("sha256").update(scriptText, "utf8").digest("hex"),
      "原始文件": "references/source.md",
      "当前版本": "当前项目全稿",
      "审读集数": episodeCount ? `全剧第 1-${episodeCount} 集（共 ${episodeCount} 集）` : "全文；分集结构需人工确认",
      "目标市场": "美国",
      "目标语": "en-US",
      "单集时长": "90 秒",
      "内容分级": "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
      "可用材料": ["审读文本：剧本全稿.md"],
      "判断边界": "仅对当前完整正文作出判断。",
      "结构状态": "规范分集",
      "审读范围": episodeCount ? `全剧第 1-${episodeCount} 集；已完成全文审读。` : "全文；已完成全文审读。"
    },
    "总体结论": {
      "结论": verdict,
      "评级": "A",
      "一句话判断": verdict + "结论由主线承诺、人物行动和结构节奏共同支撑。",
      "建议修改范围": repairScope,
      "下一步": verdict === "通过" ? "进入发行复核。" : "从最早修改范围开始返修。"
    },
    "剧本信息": {
      "剧本名称": "林夏的证据追查",
      "题材": ["悬疑", "情感"],
      "剧本标签": ["主动追查", "关系代价", "悬疑反转"],
      "剧情梗概": "林夏在证据被夺后持续追查，她的行动推动关系和风险不断升级，最终要为公开真相付出代价。"
    },
    "卖点拆解": [{
      "卖点": "主动追查证据的女主",
      "状态": "可保留",
      "观众为什么看": "主角从开场就有明确目标和行动压力。",
      "是否兑现": "正文开篇已经建立追查证据的直接冲突。",
      "证据": [{ "起始行": 1, "结束行": 1, "说明": "第 1 集开场建立主角追查目标。" }]
    }],
    "准入标准": {
    "结论": episodeAdmission === "通过" ? "通过" : "不通过",
      "一句话判断": episodeAdmission === "通过"
        ? "十项基础条件均已达到，可继续进入六维评级。"
        : "当前剧集数量未达到最低要求，不进入六维评级。",
      "检查项": admissionItems,
      "修改建议": []
    },
    "评级依据": {
      "综合判定": "林夏从开场即有明确的证据追查目标，每次行动都会改变风险和人物关系，主线在中段保持推进。真相公开前的反制力度仍偏弱，结局中主角为选择付出的代价也需要进一步压实，才能支撑情绪回报。",
      "审读范围": episodeCount
        ? `全剧第 1-${episodeCount} 集，覆盖开篇、一卡、中段和结局。`
        : "全文，覆盖开篇、中段和结局。",
      "审稿方法": REVIEW_METHOD_TEMPLATE,
      "六维结论": dimensions.map((dimension) => ({ "分析维度": dimension["维度"], "评级": "A", "结论": "通过", "一句话判断": dimension["判断"] }))
    },
    "六维分析": dimensions,
    "P0问题": [],
    "P1问题": [],
    "风险与复核": []
  };
}

function report(card) {
  const verdict = card["总体结论"];
  const information = card["剧本信息"];
  const reviewInfo = card["审稿信息"];
  const basis = card["评级依据"];
  const lines = [
    `# 《${information["剧本名称"]}》审稿报告`,
    "",
    "## 一、审核结论",
    "",
    "### 1. 整体结论",
    "",
    `> **审核结论：** ${verdict["结论"]}`,
    ">",
    `> **总体评级：** ${verdict["评级"]}`,
    ">",
    `> **一句话评估：** ${verdict["一句话判断"]}`,
    "",
    "核心承诺、人物行动和结构节奏构成当前结论。",
    "",
    "### 2. 剧本信息",
    "",
    `- 剧集名称：${information["剧本名称"]}`,
    `- 目标市场：${reviewInfo["目标市场"]}`,
    `- 目标语与时长：${reviewInfo["目标语"]}，${reviewInfo["单集时长"]}`,
    `- 剧情梗概：${information["剧情梗概"]}`,
    `- 题材：${information["题材"].join("、")}`,
    `- 剧本标签：${information["剧本标签"].join("、")}`,
    "",
    "### 3. 核心卖点",
    "",
    "主角开场主动追查证据，形成明确的观看承诺。",
    "",
    ...card["卖点拆解"].flatMap((item, index) => [
      `${index + 1}. **${item["卖点"]}**（${item["状态"]}）`,
      `   - 观众吸引力：${item["观众为什么看"]}`,
      `   - 正文兑现：${item["是否兑现"]}`
    ]),
    "",
    "## 二、准入标准",
    "",
    card["准入标准"]["一句话判断"],
    "",
    "| 检查项 | 结果 | 说明 |",
    "| --- | --- | --- |",
    ...card["准入标准"]["检查项"].map((item) => `| ${item["检查项"]} | ${item["结果"]} | ${item["说明"]} |`),
    "",
    "## 三、评级概述",
    "",
    basis["综合判定"],
    "",
    "### 1. 审读范围",
    basis["审读范围"],
    "",
    "### 2. 审稿方法",
    basis["审稿方法"],
    "",
    "### 3. 维度结论",
    "",
    "| 分析维度 | 评级 | 结论 | 一句话判断 |",
    "| --- | --- | --- | --- |",
    ...basis["六维结论"].map((item) => `| ${item["分析维度"]} | ${item["评级"]} | ${item["结论"]} | ${item["一句话判断"]} |`),
    "",
    "## 四、评分细则",
    "",
    "本稿应重点关注 **故事结构与逻辑** 的 **中段推进是否因果升级**，以及 **人物与关系** 的 **人物弧光与配角作用**：这两项决定核心承诺能否在终局完成兑现。"
  ];
  card["六维分析"].forEach((dimension, index) => {
    lines.push(
      "",
      `### ${index + 1}. ${dimension["维度"]}`,
      "",
      dimension["判断"],
      "",
      "| 检查项 | 评级 | 问题说明 | 原稿证据 |",
      "| --- | --- | --- | --- |",
      ...dimension["检查项"].map((item) => `| ${item["检查项"]} | ${item["评级"]} | ${item["问题说明"]} | 第 1-1 行：${item["原稿证据"][0]["说明"]} |`)
    );
  });
  lines.push(
    "",
    "## 五、修改建议",
    "",
    "本轮未列出需要展开的返修问题。",
    "",
    "### 1. P0 问题",
    "> P0：不解决会影响项目能否成立或能否进入下一阶段，必须先完成返修。",
    "- 当前未识别 P0 问题。",
    "",
    "### 2. P1 问题",
    "> P1：不改变项目的基本成立性，但会明显影响留存、质感或交付效率，应在本轮返修中一并处理。",
    "- 当前未识别 P1 问题。",
    "",
    "## 六、最终结论",
    verdict["下一步"],
    ""
  );
  return lines.join("\n");
}

function failedAdmissionReport(card) {
  const fullReport = report(card).replace(
    "核心承诺、人物行动和结构节奏构成当前结论。",
    "准入标准构成当前处理结论。"
  );
  const common = fullReport.slice(0, fullReport.indexOf("\n## 三、评级概述"));
  return [
    common,
    "",
    "## 三、最终结论",
    "",
    "本稿不符合准入门槛，不进入六维评级。",
    "",
    "修改建议：",
    "",
    ...card["准入标准"]["修改建议"].map((item, index) => `${index + 1}. ${item}`),
    "",
    card["总体结论"]["下一步"],
    ""
  ].join("\n");
}

async function writeReviewArtifacts(workspaceDir, verdict, repairScope, { calculateScore = true } = {}) {
  const reviewInput = await resolveReviewInput(workspaceDir);
  const scriptFile = reviewInput.scriptRelativePath;
  const scriptText = await fs.readFile(reviewInput.scriptPath, "utf8");
  const card = scorecard(verdict, repairScope, scriptFile, scriptText);
  const index = await readJson(path.join(workspaceDir, "runtime", "review-source-index.json"));
  const scriptHash = card["审稿信息"]["剧本哈希"];
  const totalLines = scriptText.replace(/\s+$/u, "").split(/\r?\n/u).length;
  await writeJson(path.join(workspaceDir, "runtime", "review-coverage.json"), {
    "schema_version": "1.0.0", "script_hash": scriptHash, "total_lines": totalLines, "ranges": [{ start: 1, end: totalLines }], "complete": true
  });
  await writeJson(path.join(workspaceDir, "runtime", "review-ledger.json"), {
    "schema_version": "1.0.0",
    "script_hash": scriptHash,
    "units": index.units.map((unit) => ({
      ...unit,
      "status": "已审读",
      "剧情功能": "建立主角追查证据的剧情任务。",
      "冲突": "主角必须在风险下追回被夺走的证据。",
      "选择": "主角选择继续追查而非放弃。",
      "结果": "追查行动推动下一段剧情。",
      "卡点": "新的证据迫使主角继续行动。",
      "人物动机": [], "规则变化": [], "矛盾点": [],
      "证据": [{ "起始行": unit.start_line, "结束行": unit.start_line, "说明": "单元起始位置用于取证。" }]
    }))
  });
  await writeJson(path.join(workspaceDir, "review-scorecard.json"), card);
  await fs.writeFile(path.join(workspaceDir, "output", "审稿报告.md"), report(card), "utf8");
  const scoring = createReviewScoringState({ scriptHash, scorecard: card });
  scoring["维度"].forEach((dimension) => {
    dimension["检查项"].forEach((check) => {
      check["分数"] = 85;
    });
  });
  await writeJson(path.join(workspaceDir, "runtime", "review-scoring.json"), scoring);
  if (calculateScore) await calculateReviewScore(workspaceDir);
  return readJson(path.join(workspaceDir, "review-scorecard.json"));
}

test("目标地区会派生市场和语言，可选发行配置为空时直接放行", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-new-brief-"));
  const sourcePath = path.join(tempDir, "source.md");
  await fs.writeFile(sourcePath, "# 原剧\n\n林夏发现证据被夺走。\n", "utf8");
  let workspaceDir = "";
  t.after(async () => {
    await Promise.all([
      workspaceDir ? fs.rm(workspaceDir, { recursive: true, force: true }) : Promise.resolve(),
      fs.rm(tempDir, { recursive: true, force: true })
    ]);
  });
  const projectName = "任务书测试-" + Date.now();
  const initialized = await initializeProject([
    "--project-name", projectName,
    "--script-file", sourcePath,
    "--target-region", "北美",
    "--created-by", "brief-test"
  ]);
  workspaceDir = initialized.workspace_dir;
  const input = await readJson(path.join(workspaceDir, "1.1-user-input.json"));
  assert.equal(Object.hasOwn(input.project, "extra_requirements"), false);
  assert.ok((await fs.readFile(path.join(workspaceDir, "output", "原始剧本.md"), "utf8")).startsWith("# source\n"));
  assert.equal(initialized.distribution_brief_status, "complete");
  assert.deepEqual(input.project.distribution_brief.target_countries, ["美国"]);
  assert.equal(input.project.distribution_brief.target_locale, "en-US");
  assert.equal(input.project.distribution_brief.maturity_target, "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头");
  assert.equal(Object.hasOwn(input.project.distribution_brief, "target_platforms"), false);
  let progress = await readJson(path.join(workspaceDir, "1.2-project-progress.json"));
  assert.equal(progress.stages.project_init.status, "completed");
  assert.equal(progress.next_skill, "world_view");
  assert.equal((await validateProjectWorkspace(workspaceDir)).next_skill, "world_view");

  const updated = await updateDistributionBrief({
    workspace: workspaceDir,
    "updated-by": "brief-test",
    "maturity-target": "R限制级影片，允许大量血腥暴力、性爱画面、持续粗口、毒品描写",
  });
  assert.equal(updated.distribution_brief_status, "complete");
  const updatedInput = await readJson(path.join(workspaceDir, "1.1-user-input.json"));
  assert.deepEqual(updatedInput.project.distribution_brief.target_countries, ["美国"]);
  assert.equal(updatedInput.project.distribution_brief.maturity_target, "R限制级影片，允许大量血腥暴力、性爱画面、持续粗口、毒品描写");
  progress = await readJson(path.join(workspaceDir, "1.2-project-progress.json"));
  assert.equal(progress.stages.project_init.status, "completed");
  assert.equal(progress.next_skill, "world_view");
  assert.equal((await validateProjectWorkspace(workspaceDir)).next_skill, "world_view");
});

test("同名原剧本可创建多个独立项目", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-new-duplicate-project-"));
  const sourcePath = path.join(tempDir, "同名原剧.md");
  await fs.writeFile(sourcePath, "# 原剧\n\n林夏发现证据被夺走。\n", "utf8");
  const createdWorkspaces = [];
  t.after(async () => {
    await Promise.all([
      ...createdWorkspaces.map((workspace) => fs.rm(workspace, { recursive: true, force: true })),
      fs.rm(tempDir, { recursive: true, force: true })
    ]);
  });

  const args = [
    "--project-name", "重复项目-" + Date.now(),
    "--script-file", sourcePath,
    "--target-region", "北美",
    "--created-by", "duplicate-test"
  ];
  const first = await initializeProject(args);
  createdWorkspaces.push(first.workspace_dir);
  const second = await initializeProject(args);
  createdWorkspaces.push(second.workspace_dir);

  assert.notEqual(second.workspace_dir, first.workspace_dir);
  assert.equal(path.basename(second.workspace_dir), path.basename(first.workspace_dir) + "-2");
  const secondInput = await readJson(path.join(second.workspace_dir, "1.1-user-input.json"));
  assert.equal(secondInput.project.project_name, args[1]);
  assert.equal(secondInput.project.workspace, path.posix.join("workspaces", path.basename(second.workspace_dir)));
});

test("独立剧本润色以原始剧本初始化并保留已有底稿", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-humanizer-source-"));
  const sourcePath = path.join(tempDir, "待处理剧本.md");
  await fs.writeFile(sourcePath, [
    "# 待处理剧本",
    "",
    "## 第1集 初见",
    "林夏：你又来晚了。",
    "",
    "## 第2集 追问",
    "周默：我没有别的选择。"
  ].join("\n"), "utf8");
  let workspaceDir = "";
  t.after(async () => {
    await Promise.all([
      workspaceDir ? fs.rm(workspaceDir, { recursive: true, force: true }) : Promise.resolve(),
      fs.rm(tempDir, { recursive: true, force: true })
    ]);
  });

  const initialized = await initializeProject([
    "--project-name", "剧本润色测试-" + Date.now(),
    "--script-file", sourcePath,
    "--target-region", "北美",
    "--created-by", "humanizer-test",
    "--task-type", "humanize"
  ]);
  workspaceDir = initialized.workspace_dir;
  assert.equal(initialized.validation.next_skill, "humanizer_zh");
  assert.equal((await validateProjectWorkspace(workspaceDir)).next_skill, "humanizer_zh");

  const first = await initializeHumanizerZh({ workspace: workspaceDir, "updated-by": "humanizer-test" });
  assert.equal(first.reused_existing_output, false);
  const source = await fs.readFile(path.join(workspaceDir, "output", "原始剧本.md"), "utf8");
  const outputPath = path.join(workspaceDir, "output", "去AI味剧本.md");
  assert.equal(await fs.readFile(outputPath, "utf8"), source);

  const revised = source.replace("林夏：你又来晚了。", "林夏：这回，你来得可真准时。\n△她把门挡住。");
  await fs.writeFile(outputPath, revised, "utf8");
  const repeated = await initializeHumanizerZh({ workspace: workspaceDir, "updated-by": "humanizer-test" });
  assert.equal(repeated.reused_existing_output, true);
  assert.equal(await fs.readFile(outputPath, "utf8"), revised);

  await fs.writeFile(outputPath, revised.replace("## 第2集 追问", "## 第3集 追问"), "utf8");
  await assert.rejects(
    () => checkHumanizerZh({ workspace: workspaceDir, "updated-by": "humanizer-test" }),
    /分集标题及顺序/u
  );

  await fs.writeFile(outputPath, revised, "utf8");
  const checked = await checkHumanizerZh({ workspace: workspaceDir, "updated-by": "humanizer-test" });
  assert.equal(checked.episode_count, 2);
  const progress = await readJson(path.join(workspaceDir, "1.2-project-progress.json"));
  assert.equal(progress.stages.humanizer_zh.status, "completed");
});

test("独立剧本审核保留低分报告并允许再次审稿", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-new-review-only-"));
  const sourcePath = path.join(tempDir, "source.md");
  await fs.writeFile(sourcePath, "# 待审剧本\n\n林夏发现证据被夺走。\n", "utf8");
  let workspaceDir = "";
  t.after(async () => {
    await Promise.all([
      workspaceDir ? fs.rm(workspaceDir, { recursive: true, force: true }) : Promise.resolve(),
      fs.rm(tempDir, { recursive: true, force: true })
    ]);
  });

  const initialized = await initializeProject([
    "--project-name", "独立审核-" + Date.now(),
    "--script-file", sourcePath,
    "--target-region", "北美",
    "--created-by", "review-test"
  ]);
  workspaceDir = initialized.workspace_dir;
  const inputPath = path.join(workspaceDir, "1.1-user-input.json");
  const progressPath = path.join(workspaceDir, "1.2-project-progress.json");
  const input = await readJson(inputPath);
  input.project.task_type = "review";
  await writeJson(inputPath, input);
  const progress = await readJson(progressPath);
  progress.stages.full_generate.status = "needs_revision";
  progress.stages.full_generate.invalidated_by = "outline_rewrite";
  progress.stages.foreign_review.status = "needs_revision";
  await writeJson(progressPath, progress);
  await fs.writeFile(
    path.join(workspaceDir, "output", "剧本全稿.md"),
    Array.from({ length: 35 }, (_, index) => screenplayEpisode(index + 1)).join("\n\n") + "\n",
    "utf8"
  );

  await initializeForeignReview(workspaceDir, "review-test");
  const reportScaffold = await fs.readFile(path.join(workspaceDir, "output", "审稿报告.md"), "utf8");
  assert.match(reportScaffold, /^# 《.+》审稿报告/mu);
  assert.ok(reportScaffold.includes("### 3. 核心卖点"));
  assert.ok(reportScaffold.includes("## 二、准入标准"));
  assert.ok(reportScaffold.indexOf("## 二、准入标准") < reportScaffold.indexOf("## 三、评级概述"));
  assert.ok(reportScaffold.indexOf("综合判定正文。") < reportScaffold.indexOf("### 1. 审读范围"));
  assert.ok(reportScaffold.indexOf("### 1. 审读范围") < reportScaffold.indexOf("### 3. 维度结论"));
  assert.ok(reportScaffold.includes(REVIEW_METHOD_TEMPLATE));
  const scaffoldInformation = reportScaffold.match(/### 2\. 剧本信息([\s\S]*?)### 3\. 核心卖点/u)?.[1] || "";
  assert.doesNotMatch(scaffoldInformation, /^\s*\|/mu);
  assert.match(scaffoldInformation, /- 剧集名称：[\s\S]*- 目标市场：[\s\S]*- 目标语与时长：[\s\S]*- 剧情梗概：[\s\S]*- 题材：[\s\S]*- 剧本标签：/u);
  assert.doesNotMatch(scaffoldInformation, /当前版本：|频类：|一句话介绍：/u);
  assert.doesNotMatch(reportScaffold, /<\/?(?:div|h[1-6]|p|table|span|br)\b/iu);
  let updatedProgress = await readJson(progressPath);
  assert.equal(updatedProgress.stages.full_generate.status, "completed");

  await writeReviewArtifacts(workspaceDir, "返修", "剧本大纲");
  const result = await checkForeignReview(workspaceDir, "review-test");
  assert.equal(result.outcome, "awaiting_approval");
  assert.equal(result.review_only, true);
  updatedProgress = await readJson(progressPath);
  assert.equal(updatedProgress.stages.full_generate.status, "completed");
  assert.equal(updatedProgress.stages.foreign_review.status, "awaiting_approval");
  assert.equal(Object.hasOwn(updatedProgress.stages.foreign_review, "revision_route_validation"), false);
});

test("海外审稿检查为每项失败返回可执行的修复说明", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-review-repairs-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const scriptPath = path.join(workspaceDir, "待审剧本.md");
  await fs.writeFile(
    scriptPath,
    Array.from({ length: 35 }, (_, index) => screenplayEpisode(index + 1)).join("\n\n") + "\n",
    "utf8"
  );
  await writeJson(path.join(workspaceDir, "review-input.json"), {
    review_mode: "standalone",
    script_path: "待审剧本.md",
    script_title: "修复说明测试剧",
    target_market: "美国",
    target_locale: "en-US",
    episode_duration: "60 秒",
    maturity_target: "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头"
  });
  await initializeForeignReview(workspaceDir, "repair-instruction-test");
  await writeReviewArtifacts(workspaceDir, "返修", "剧本全稿");

  const cardPath = path.join(workspaceDir, "review-scorecard.json");
  const card = await readJson(cardPath);
  card["总体结论"]["建议修改范围"] = "全剧";
  card["风险与复核"] = ["需要人工复核的内容风险"];
  await writeJson(cardPath, card);
  await fs.appendFile(path.join(workspaceDir, "output", "审稿报告.md"), "\nTODO\n", "utf8");

  const result = await checkForeignReview(workspaceDir, "repair-instruction-test");
  assert.equal(result.ok, false);
  assert.equal(result.issue_count, result.issues.length);
  assert.equal(result.repair_instructions.length, result.issues.length);
  result.repair_instructions.forEach((instruction, index) => {
    assert.equal(instruction.message, result.issues[index]);
    assert.ok(instruction.file);
    assert.ok(instruction.required);
    assert.ok(instruction.action);
  });
  const scopeRepair = result.repair_instructions.find((item) => item.code === "INVALID_REPAIR_SCOPE");
  assert.deepEqual(scopeRepair?.allowed_values, REPAIR_SCOPES);
  const riskRepair = result.repair_instructions.find((item) => item.code === "FIX_RISK_REVIEW");
  assert.deepEqual(riskRepair?.required_fields, ["类别", "严重程度", "说明", "建议", "需要人工复核"]);
  const reportRepair = result.repair_instructions.find((item) => item.code === "FIX_REVIEW_REPORT" && item.message.includes("内部内容"));
  assert.equal(reportRepair?.file, "output/审稿报告.md");
  assert.match(result.next_action, /无需读取检查工具源码/u);
});

test("海外审稿拒绝无对象的追看结论", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-review-copy-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const scriptPath = path.join(workspaceDir, "待审剧本.md");
  await fs.writeFile(
    scriptPath,
    Array.from({ length: 35 }, (_, index) => screenplayEpisode(index + 1)).join("\n\n") + "\n",
    "utf8"
  );
  await writeJson(path.join(workspaceDir, "review-input.json"), {
    review_mode: "standalone",
    script_path: "待审剧本.md",
    script_title: "文案检查测试剧",
    target_market: "美国",
    target_locale: "en-US",
    episode_duration: "60 秒",
    maturity_target: "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头"
  });
  await initializeForeignReview(workspaceDir, "copy-check-test");
  await writeReviewArtifacts(workspaceDir, "返修", "剧本全稿");

  const cardPath = path.join(workspaceDir, "review-scorecard.json");
  const card = await readJson(cardPath);
  const originalJudgment = card["总体结论"]["一句话判断"];
  const compressedJudgment = "逃离清算和亲子秘密能支撑追看。";
  card["总体结论"]["一句话判断"] = compressedJudgment;
  await writeJson(cardPath, card);

  const reportPath = path.join(workspaceDir, "output", "审稿报告.md");
  const reportText = await fs.readFile(reportPath, "utf8");
  await fs.writeFile(reportPath, reportText.replace(originalJudgment, compressedJudgment), "utf8");

  const result = await checkForeignReview(workspaceDir, "copy-check-test");
  assert.equal(result.ok, false);
  const copyRepair = result.repair_instructions.find((item) => item.code === "REWRITE_REVIEW_COPY");
  assert.match(copyRepair?.message || "", /能支撑追看/u);
  assert.match(copyRepair?.action || "", /对象/u);
});

test("海外审稿检查会一次列出全部缺失交付物", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-review-missing-artifacts-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));

  const result = await checkForeignReview(workspaceDir, "missing-artifact-test");
  assert.equal(result.ok, false);
  assert.equal(result.issue_count, 6);
  assert.equal(result.repair_instructions.length, 6);
  result.repair_instructions.forEach((instruction) => {
    assert.equal(instruction.code, "MISSING_REVIEW_FILE");
    assert.match(instruction.file, new RegExp(workspaceDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(instruction.action, /初始化海外审稿/u);
  });
});

test("准入不通过时停止评分并只保留最终修改建议", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-review-admission-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const scriptPath = path.join(workspaceDir, "待审剧本.md");
  await fs.writeFile(
    scriptPath,
    Array.from({ length: 9 }, (_, index) => screenplayEpisode(index + 1)).join("\n\n") + "\n",
    "utf8"
  );
  await writeJson(path.join(workspaceDir, "review-input.json"), {
    review_mode: "standalone",
    script_path: "待审剧本.md",
    script_title: "准入测试剧",
    target_market: "美国",
    target_locale: "en-US",
    episode_duration: "60 秒",
    maturity_target: "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头"
  });
  await initializeForeignReview(workspaceDir, "admission-test");
  await writeReviewArtifacts(workspaceDir, "返修", "剧本全稿", { calculateScore: false });

  const cardPath = path.join(workspaceDir, "review-scorecard.json");
  const card = await readJson(cardPath);
  card["准入标准"]["检查项"][0] = {
    "检查项": "集数达标",
    "结果": "不通过",
    "说明": "**全剧仅 9 集，未达到部分审稿的最低集数。**",
    "原稿证据": [{ "起始行": 1, "结束行": 1, "说明": "第 1 集开场。" }]
  };
  card["准入标准"]["一句话判断"] = "当前稿因集数不足未达到准入门槛，应先补齐可供审读的连续剧集再进行六维评级。";
  card["准入标准"]["修改建议"] = ["至少补写 1 集，并让新增内容承接现有主线与结局。"];
  card["总体结论"] = {
    "结论": "返修",
    "评级": "A",
    "一句话判断": "当前正文只有 9 集，未达到部分审稿的最低集数要求。",
    "建议修改范围": "剧本全稿",
    "下一步": "补齐至少 10 集后，重新执行准入检查。"
  };
  await writeJson(cardPath, card);

  const admissionResult = await checkReviewAdmission(workspaceDir);
  assert.equal(admissionResult.ok, true);
  assert.equal(admissionResult.admission, "不通过");
  assert.equal(admissionResult.continue_to_scoring, false);
  const failedCard = await readJson(cardPath);
  assert.equal(failedCard["总体结论"]["评级"], "未评级");
  await assert.rejects(calculateReviewScore(workspaceDir), /尚未通过准入标准/u);
  await fs.writeFile(path.join(workspaceDir, "output", "审稿报告.md"), failedAdmissionReport(failedCard), "utf8");

  const checked = await checkForeignReview(workspaceDir, "admission-test");
  assert.equal(checked.ok, true);
  assert.equal(checked.outcome, "complete");
  const failedReport = await fs.readFile(path.join(workspaceDir, "output", "审稿报告.md"), "utf8");
  assert.doesNotMatch(failedReport, /评级概述|评分细则|P0 问题|P1 问题/u);
  assert.match(failedReport, /## 三、最终结论[\s\S]*不符合准入门槛/u);
});

test("写作信息只返回当前故事阶段的角色变化", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-new-stage-characters-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await writeJson(path.join(workspaceDir, "3.1-outline.json"), outlineFixture());
  await writeJson(path.join(workspaceDir, "4.1-character.json"), characterFixture());

  const opening = await getEpisodeInfo(workspaceDir, { episode: 1 });
  assert.equal(opening.task_type, "rewrite");
  assert.match(opening.next_action, /不扩展试稿范围/u);
  assert.doesNotMatch(opening.next_action, /高光时刻剧本改编原则/u);
  assert.equal(Object.hasOwn(opening.characters[0], "英文名称"), false);
  assert.deepEqual(opening.characters[0]["阶段变化"].map((stage) => stage["故事阶段"]), ["开篇"]);
  assert.deepEqual(Object.keys(opening.characters[0]).sort(), ["人物名称", "核心诉求", "人物难题", "关系与弧光", "阶段变化"].sort());
  assert.deepEqual(Object.keys(opening.characters[0]["阶段变化"][0]).sort(), ["故事阶段", "身份与处境", "人物形象", "口吻"].sort());

  const unit = await getEpisodeInfo(workspaceDir, { unit: "追查" });
  assert.deepEqual(unit.characters[0]["阶段变化"].map((stage) => stage["故事阶段"]), ["追查"]);

  const fullStage = await getStageInfo(workspaceDir, "追查");
  assert.equal(Object.hasOwn(fullStage.characters[0], "英文名称"), false);
  assert.deepEqual(fullStage.characters[0]["阶段变化"].map((stage) => stage["故事阶段"]), ["追查"]);
  assert.deepEqual(Object.keys(fullStage.characters[0]).sort(), ["人物名称", "核心诉求", "人物难题", "关系与弧光", "阶段变化"].sort());
  assert.deepEqual(Object.keys(fullStage.characters[0]["阶段变化"][0]).sort(), ["故事阶段", "身份与处境", "人物形象", "口吻"].sort());
});

test("台词提取保留中文舞台提示并兼容已有英文译文", () => {
  const source = [
    "# 第1集",
    "",
    "林夏：你不能带走证据。",
    "（她伸手拦住门口。）",
    "周默：那你就试试。",
    "(Then try to stop me.)"
  ].join("\n");

  const extracted = extractDialogueSource(source, { existingTargetMode: "existing-english" });
  assert.equal(extracted.dialogues.length, 2);
  assert.equal(extracted.dialogues[0].episode, 1);
  assert.equal(extracted.dialogues[0].existing_target, "");
  assert.equal(extracted.dialogues[1].existing_target, "Then try to stop me.");
  assert.match(extracted.template, /（她伸手拦住门口。）/u);
});

test("台词译稿保留首个剧集标题并追加目标语名称", () => {
  const output = renderTranslatedScript(
    "# 第1集：火场归来\n\n林夏：回来。  \n（{{ORCA_DIALOGUE_TRANSLATION:E001-L0001}}）",
    new Map([["E001-L0001", "Come back."]]),
    "# 台词译稿",
    new Map([[1, "Fire Returns"]])
  );

  assert.match(output, /^# 台词译稿\n\n# 第1集：火场归来（Fire Returns）/u);
});

test("项目输入、确认、返修与全稿来源契约能够闭环", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-new-contract-"));
  const sourcePath = path.join(tempDir, "source.md");
  const attachmentPath = path.join(tempDir, "notes.md");
  await fs.writeFile(sourcePath, "# 原剧\n\n第1集\n林夏发现证据被夺走。\n", "utf8");
  await fs.writeFile(attachmentPath, "# 补充设定\n\n林夏擅长调查。\n", "utf8");
  const projectName = "契约测试-" + Date.now();
  let workspaceDir = "";
  t.after(async () => {
    await Promise.all([
      workspaceDir ? fs.rm(workspaceDir, { recursive: true, force: true }) : Promise.resolve(),
      fs.rm(tempDir, { recursive: true, force: true })
    ]);
  });

  const initialized = await initializeProject([
    "--project-name", projectName,
    "--script-file", sourcePath,
    "--target-region", "North America",
    "--attachment", attachmentPath,
    "--created-by", "contract-test"
  ]);
  workspaceDir = initialized.workspace_dir;
  const inputPath = path.join(workspaceDir, "1.1-user-input.json");
  const progressPath = path.join(workspaceDir, "1.2-project-progress.json");
  const input = await readJson(inputPath);
  assert.equal(input.project.target_region, "北美");
  assert.equal(input.project.distribution_brief.status, "complete");
  assert.equal(input.project.distribution_brief.target_locale, "en-US");
  assert.equal(input.project.attachments[0].text_status, "available");
  assert.ok(await fs.stat(path.join(workspaceDir, input.project.attachments[0].text_path)));
  assert.ok(await fs.stat(path.join(workspaceDir, "memory", "stage-preferences.json")));
  assert.equal((await validateProjectWorkspace(workspaceDir)).next_skill, "world_view");
  await assert.rejects(
    updateProgress({
      workspace: workspaceDir,
      stage: "trial_generate",
      status: "approved",
      updatedBy: "contract-test"
    }),
    /审批状态只能由对应的检查或批准工具更新/u
  );

  await initializeWorldView(workspaceDir, "contract-test");
  await resolveScriptProfile({
    workspace: workspaceDir,
    stage: "world_view",
    updatedBy: "contract-test",
    theme: "悬疑",
    setting: "大女主",
    background: "现代,都市",
    audience: "女频"
  });
  await initializeWorldView(workspaceDir, "contract-test");
  await getWorldViewExecutionStrategy(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "2.1-world-view.json"), JSON.stringify({
    "世界观描述": "林夏在现代都市依靠调查能力追查证据。",
    "关键概念映射": [{
      "原剧本概念": "家族掌控的证据链",
      "映射后概念": "跨境企业网络控制的数字证据链"
    }]
  }), "utf8");
  assert.equal((await checkWorldView(workspaceDir, "contract-test")).ok, true);
  await writeJson(path.join(workspaceDir, "2.1-world-view.json"), {
    "世界观描述": "林夏在现代都市依靠调查能力追查证据。",
    "关键概念映射": []
  });
  assert.equal((await checkWorldView(workspaceDir, "contract-test")).ok, true);
  let progress = await readJson(progressPath);
  assert.equal(progress.stages.world_view.status, "completed");
  assert.equal(progress.next_skill, "outline_rewrite");
  await initializeOutline(workspaceDir, "contract-test");
  assert.ok(await fs.stat(path.join(workspaceDir, "memory", "world_view_memory.json")));
  assert.ok(await fs.stat(path.join(workspaceDir, "memory", "outline_rewrite_memory.json")));
  await writeJson(path.join(workspaceDir, "3.1-outline.json"), outlineFixture());

  progress = await readJson(progressPath);
  progress.stages.outline_rewrite.status = "completed";
  await writeJson(progressPath, progress);
  await writeJson(path.join(workspaceDir, "4.1-character.json"), characterFixture());
  assert.equal((await checkCharacter(workspaceDir, "contract-test")).ok, true);
  const characterMarkdown = await fs.readFile(path.join(workspaceDir, "output", "角色小传.md"), "utf8");
  assert.match(characterMarkdown, new RegExp(`## ${LOCALIZED_NAME}（${ENGLISH_NAME}）`, "u"));
  assert.ok(characterMarkdown.includes("### 人物形象"));
  assert.ok(characterMarkdown.includes("- 性别：女｜国籍：美国｜年龄：30岁"));
  assert.ok(characterMarkdown.includes("### 人物内核"));
  assert.ok(characterMarkdown.includes("| 故事阶段 | 身份与处境 | 人物形象 | 口吻 |"));
  assert.ok(characterMarkdown.includes("| 开篇 |"));
  await fs.writeFile(
    path.join(workspaceDir, "output", "剧本试稿.md"),
    "# 剧本试稿\n\n" + Array.from({ length: 10 }, (_, index) => screenplayEpisode(index + 1)
      .replace("  \n(", "\n\n("))
      .join("\n\n") + "\n",
    "utf8"
  );

  await updateStagePreferences({
    workspace: workspaceDir,
    stage: "trial_generate",
    content: "保持林夏主动调查。",
    "updated-by": "contract-test"
  });
  const preferences = await getUserPreferences(workspaceDir, "trial_generate");
  assert.ok(preferences.preferences.includes("保持林夏主动调查。"));
  assert.deepEqual(preferences.attachments, [{
    original_name: "notes.md",
    text_path: input.project.attachments[0].text_path
  }]);

  const preferenceSnapshotPath = path.join(workspaceDir, "runtime", "jobs", "system-preference-test", "user-preferences.json");
  await fs.mkdir(path.dirname(preferenceSnapshotPath), { recursive: true });
  await writeJson(preferenceSnapshotPath, {
    stage: "trial_generate",
    effective_preferences: [
      { content: "用户创作偏好", is_system_preference: false },
      { content: "系统创作偏好", is_system_preference: true }
    ]
  });
  const previousPreferenceContextPath = process.env.ORCA_USER_PREFERENCE_CONTEXT_PATH;
  process.env.ORCA_USER_PREFERENCE_CONTEXT_PATH = preferenceSnapshotPath;
  try {
    const snapshotPreferences = await getUserPreferences(workspaceDir, "trial_generate");
    assert.ok(snapshotPreferences.preferences.includes("用户创作偏好"));
    assert.ok(snapshotPreferences.preferences.includes("系统创作偏好"));
    const mismatchedStage = await getUserPreferences(workspaceDir, "full_generate");
    assert.equal(mismatchedStage.preferences.includes("系统创作偏好"), false);
  } finally {
    if (previousPreferenceContextPath === undefined) delete process.env.ORCA_USER_PREFERENCE_CONTEXT_PATH;
    else process.env.ORCA_USER_PREFERENCE_CONTEXT_PATH = previousPreferenceContextPath;
  }

  const trial = await checkTrial(workspaceDir, "contract-test");
  assert.equal(trial.ok, true);
  assert.equal(trial.approval_required, true);
  assert.deepEqual(trial.format_repairs, ["已自动为 10 个动作行补充“△”后的空格。"]);
  const checkedTrialText = await fs.readFile(path.join(workspaceDir, "output", "剧本试稿.md"), "utf8");
  assert.doesNotMatch(checkedTrialText, /^△\S/mu);
  assert.match(checkedTrialText, new RegExp(`${LOCALIZED_NAME}：你不能带走证据。`, "u"));
  assert.doesNotMatch(checkedTrialText, /^（.+）$/mu);
  await approveStage(workspaceDir, "trial_generate", "contract-test");
  progress = await readJson(progressPath);
  assert.equal(progress.stages.trial_generate.status, "approved");
  assert.equal(progress.next_skill, "full_generate");

  const initialFull = await initializeFull(workspaceDir, "contract-test");
  await getFullExecutionStrategy(workspaceDir);
  assert.equal(initialFull.generation_mode, "trial_continuation");
  assert.match(
    await fs.readFile(initialFull.execution_spec_file, "utf8"),
    /- 执行模式：trial_continuation/u
  );
  const trialPath = path.join(workspaceDir, "output", "剧本试稿.md");
  await fs.writeFile(
    path.join(workspaceDir, "tmp", "全稿分阶段", "02-追查.md"),
    "# 追查\n\n" + Array.from({ length: 25 }, (_, index) => screenplayEpisode(index + 11)).join("\n\n") + "\n",
    "utf8"
  );
  const merged = await mergeFullScript(workspaceDir);
  assert.deepEqual(merged.format_repairs, []);
  assert.equal(await fs.readFile(trialPath, "utf8"), checkedTrialText);
  const fullPath = path.join(workspaceDir, "output", "剧本全稿.md");
  assert.match(await fs.readFile(fullPath, "utf8"), new RegExp(`${LOCALIZED_NAME}：你不能带走证据。`, "u"));
  const full = await checkFull(workspaceDir, "contract-test");
  assert.equal(full.ok, true);
  assert.deepEqual(full.format_repairs, [
    "output/剧本全稿.md：已自动为 25 个动作行补充“△”后的空格。",
    "tmp/全稿分阶段/02-追查.md：已自动为 25 个动作行补充“△”后的空格。"
  ]);
  assert.equal(await fs.readFile(trialPath, "utf8"), checkedTrialText);
  const checkedFullText = await fs.readFile(fullPath, "utf8");
  assert.doesNotMatch(checkedFullText, /^△\S/mu);
  assert.doesNotMatch(checkedFullText, /^（.+）$/mu);
  progress = await readJson(progressPath);
  assert.equal(progress.stages.full_generate.status, "completed");
  assert.equal(progress.stages.full_generate.completed_once, true);
  progress.stages.trial_generate.status = "pending";
  await writeJson(progressPath, progress);
  const revision = await initializeFull(workspaceDir, "contract-test");
  await getFullExecutionStrategy(workspaceDir);
  assert.equal(revision.generation_mode, "full_revision");
  assert.match(
    await fs.readFile(revision.execution_spec_file, "utf8"),
    /- 执行模式：full_revision/u
  );
  assert.deepEqual(revision.stage_files, []);
  const openingInfo = await getStageInfo(workspaceDir, "开篇");
  assert.equal(openingInfo.generation_mode, "full_revision");
  assert.equal(openingInfo.stage_script_file, "output/剧本全稿.md");
  const trialBeforeRevision = await fs.readFile(trialPath, "utf8");
  const revisedFullText = (await fs.readFile(fullPath, "utf8"))
    .replace(`${LOCALIZED_NAME}：你不能带走证据。`, `${LOCALIZED_NAME}：我会亲自带回证据。`);
  await fs.writeFile(fullPath, revisedFullText, "utf8");
  await mergeFullScript(workspaceDir);
  const revisedFull = await checkFull(workspaceDir, "contract-test");
  assert.equal(revisedFull.ok, true);
  assert.match(await fs.readFile(fullPath, "utf8"), /我会亲自带回证据/u);
  assert.equal(await fs.readFile(trialPath, "utf8"), trialBeforeRevision);

  progress = await readJson(progressPath);
  delete progress.stages.full_generate.completed_once;
  progress.stages.full_generate.status = "stale";
  await writeJson(progressPath, progress);
  const previousResetFlag = process.env.ORCA_RESET_CURRENT_STAGE;
  process.env.ORCA_RESET_CURRENT_STAGE = "1";
  try {
    const resetRevision = await initializeFull(workspaceDir, "contract-test");
    await getFullExecutionStrategy(workspaceDir);
    assert.equal(resetRevision.generation_mode, "full_revision");
  } finally {
    if (previousResetFlag === undefined) delete process.env.ORCA_RESET_CURRENT_STAGE;
    else process.env.ORCA_RESET_CURRENT_STAGE = previousResetFlag;
  }
  progress = await readJson(progressPath);
  assert.equal(progress.stages.full_generate.completed_once, true);
  await fs.writeFile(fullPath, revisedFullText, "utf8");
  await mergeFullScript(workspaceDir);
  assert.equal((await checkFull(workspaceDir, "contract-test")).ok, true);

  const translation = await initializeDialogueTranslation(workspaceDir, "contract-test");
  const initializedTranslationUnit = await readJson(translation.unit_files[0]);
  assert.equal(initializedTranslationUnit["剧集"][0]["剧集名称"], "第1集");
  assert.equal(initializedTranslationUnit["剧集"][0]["目标语剧集名称"], "");
  for (const unitPath of translation.unit_files) {
    const unit = await readJson(unitPath);
    if (typeof unit["英文简介"] === "string") unit["英文简介"] = "Translated story synopsis.";
    unit["剧集"].forEach((episodeItem) => {
      if (typeof episodeItem["剧集名称"] === "string") {
        episodeItem["目标语剧集名称"] = `Episode ${episodeItem["集数"]}`;
      }
      episodeItem["台词"].forEach((line) => {
        line["目标语台词"] = `Translated line ${line["台词ID"]}`;
      });
    });
    await writeJson(unitPath, unit);
  }
  assert.equal((await mergeDialogueTranslation(workspaceDir)).ok, true);
  assert.equal((await checkDialogueTranslation(workspaceDir, "contract-test")).ok, true);
  const translationRelativePath = path.relative(workspaceDir, translation.output_file);
  const translatedScript = await fs.readFile(translation.output_file, "utf8");
  assert.match(translatedScript, /## 第1集：第1集（Episode 1）/u);
  assert.match(translatedScript, /Translated line E001-L0001/u);
  assert.equal(
    (await readJson(path.join(workspaceDir, "runtime", "dialogue-translate", "manifest.json"))).story_synopsis.translated_text,
    "Translated story synopsis."
  );
  progress = await readJson(progressPath);
  assert.equal(progress.stages.dialogue_translate.status, "completed");
  assert.equal(progress.next_skill, "foreign_review");

  await initializeForeignReview(workspaceDir, "contract-test");
  await writeReviewArtifacts(workspaceDir, "返修", "剧本全稿");
  progress = await readJson(progressPath);
  progress.stages.foreign_review.last_error = "过期检查错误";
  await writeJson(progressPath, progress);
  const revised = await checkForeignReview(workspaceDir, "contract-test");
  assert.equal(revised.outcome, "revision_requested");
  progress = await readJson(progressPath);
  assert.equal(progress.stages.full_generate.status, "completed");
  assert.equal(progress.current_skill, "foreign_review");
  assert.equal(Object.hasOwn(progress.stages.foreign_review, "last_error"), false);
  assert.equal(progress.stages.foreign_review.status, "completed");
  assert.equal(progress.stages.foreign_review.review_decision.outcome, "revision_requested");
  assert.equal(progress.stages.foreign_review.review_decision.revision_stage, "full_generate");
  assert.deepEqual(
    Object.keys(progress.stages.foreign_review.review_decision.artifact_hashes).sort(),
    [translationRelativePath, "output/审稿报告.md", "review-scorecard.json", "runtime/review-scoring.json"].sort()
  );
  const repeatedReview = await checkForeignReview(workspaceDir, "contract-test");
  assert.equal(repeatedReview.outcome, "revision_requested");
  assert.equal(repeatedReview.already_recorded, true);

  await updateProgress({
    workspace: workspaceDir,
    stage: "dialogue_translate",
    status: "completed",
    updatedBy: "contract-test",
    nextSkill: "foreign_review",
    outputFiles: [translationRelativePath]
  });
  await initializeForeignReview(workspaceDir, "contract-test");
  progress = await readJson(progressPath);
  assert.equal(Object.hasOwn(progress.stages.foreign_review, "review_decision"), false);
  assert.equal(Object.hasOwn(progress.stages.foreign_review, "revision_route_validation"), false);
  await writeReviewArtifacts(workspaceDir, "通过", "海外发行复核");
  const passed = await checkForeignReview(workspaceDir, "contract-test");
  assert.equal(passed.outcome, "awaiting_approval");
  await approveStage(workspaceDir, "foreign_review", "contract-test");
  progress = await readJson(progressPath);
  assert.equal(progress.stages.foreign_review.status, "approved");
  assert.equal(progress.next_skill, "");
});
