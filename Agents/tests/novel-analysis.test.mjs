import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { initializeProject } from "../.claude/skills/project_init/scripts/init-project.mjs";
import { convertScriptToMarkdown } from "../.claude/skills/project_init/scripts/convert-script-to-md.mjs";
import { validateProjectWorkspace } from "../.claude/skills/project_init/scripts/validate-project.mjs";
import { checkNovelAnalysis } from "../.claude/skills/novel_analysis/scripts/check-novel-analysis.mjs";
import { completeNovelReading, NovelReadingToolError } from "../.claude/skills/novel_analysis/scripts/complete-novel-reading.mjs";
import { initializeNovelAnalysis } from "../.claude/skills/novel_analysis/scripts/init-novel-analysis.mjs";
import { checkNovelLength } from "../.claude/skills/novel_analysis/scripts/check-novel-length.mjs";
import { buildNovelSourceIndex, deriveNovelOutlinePlan } from "../.claude/skills/novel_analysis/scripts/novel-analysis-utils.mjs";
import { readNovelSource } from "../.claude/skills/novel_analysis/scripts/read-novel-source.mjs";
import { initializeOutline } from "../.claude/skills/outline_rewrite/scripts/init-outline.mjs";
import { checkOutline } from "../.claude/skills/outline_rewrite/scripts/check-outline.mjs";
import { getOutlineExecutionStrategy } from "../.claude/skills/outline_rewrite/scripts/get-execution-strategy.mjs";
import { getEpisodeInfo } from "../.claude/skills/trial_generate/scripts/get-episode-info.mjs";
import { initializeFull } from "../.claude/skills/full_generate/scripts/init-full.mjs";
import { getStageInfo } from "../.claude/skills/full_generate/scripts/get-stage-info.mjs";
import { getAdaptationContext } from "../.claude/tools/get-adaptation-context.mjs";
import { resolveScriptProfile } from "../.claude/tools/resolve-script-profile.mjs";

const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertNoUnconfirmedDecision(unit) {
  ["改编建议", "合并目标单元ID", "已确认合并", "建议原因"].forEach((key) => {
    assert.equal(Object.hasOwn(unit, key), false, `不应返回未确认的${key}`);
  });
}

test("小说解读区分首次生成、定向修复和已完成内容修改", async () => {
  const skill = await fs.readFile(
    path.join(agentsRoot, ".claude", "skills", "novel_analysis", "SKILL.md"),
    "utf8"
  );

  assert.match(skill, /## 快速开始/u);
  assert.match(skill, /## 生成流程/u);
  assert.doesNotMatch(skill, /## 工作流程/u);
  assert.match(skill, /\| 首次生成 \|/u);
  assert.match(skill, /\| 修复生成结果 \|[\s\S]*不调用“完整阅读小说”/u);
  assert.match(skill, /\| 修改已完成内容 \|/u);
  assert.match(skill, /原著事实或高光索引可疑时，定向读取原文/u);
});

function episode(number) {
  return {
    "集数": number,
    "剧集名称": `第${number}集`,
    "关键角色": ["艾琳·格雷"],
    "写作思路": {
      "开场冲突": "艾琳被迫立刻做出选择。",
      "主要转折": ["她从被动隐瞒转为主动查证。"],
      "结尾承接": "新证据把危险引向下一集。"
    },
    "剧集梗概": "艾琳围绕被调换的继承证据主动追查，并为选择承担新的代价。"
  };
}

test("完整阅读小说工具只返回确定的启动动作", async () => {
  const requests = [];
  const result = await completeNovelReading({
    endpoint: "http://127.0.0.1:8000/internal/agent-tools/novel-analysis/prepare",
    token: "temporary-token",
    fetchImpl: async (endpoint, options) => {
      requests.push({ endpoint, options });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          message: "小说全文已阅读完成，解读草稿已生成。",
          next_action: "阅读解读原则并复核结果。",
          internal_path: "/not-visible",
          block_count: 20
        })
      };
    }
  });

  assert.deepEqual(result, {
    ok: true,
    message: "小说全文阅读已启动。",
    next_action: "全文阅读正在由系统完成。立即结束本轮，不要等待、轮询或再次调用‘完整阅读小说’。"
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["x-agent-tool-token"], "temporary-token");
});

test("完整阅读小说工具原样传递服务端修复指引", async () => {
  await assert.rejects(
    completeNovelReading({
      endpoint: "http://127.0.0.1:8000/internal/agent-tools/novel-analysis/prepare",
      token: "temporary-token",
      fetchImpl: async () => ({
        ok: false,
        json: async () => ({
          detail: {
            message: "小说全文阅读暂未完成。",
            next_action: "重新调用‘完整阅读小说’。"
          }
        })
      })
    }),
    (error) => {
      assert.ok(error instanceof NovelReadingToolError);
      assert.equal(error.message, "小说全文阅读暂未完成。");
      assert.equal(error.nextAction, "重新调用‘完整阅读小说’。");
      return true;
    }
  );
});

test("完整阅读小说工具缺少任务凭证时不发起请求", async () => {
  let requested = false;
  await assert.rejects(
    completeNovelReading({
      endpoint: "http://127.0.0.1:8000/internal/agent-tools/novel-analysis/prepare",
      token: "",
      fetchImpl: async () => {
        requested = true;
      }
    }),
    /当前任务没有可用的小说全文阅读上下文/u
  );
  assert.equal(requested, false);
});

test("小说改编按目标集数与单集时长生成故事梗概单元容量", () => {
  const plan = deriveNovelOutlinePlan({
    distribution_brief: {
      target_episode_count: 35,
      episode_duration: "90秒"
    }
  });

  assert.equal(plan.max_outline_unit_count, 6);
  assert.equal(plan.episode_duration_seconds, 90);
  assert.equal(plan.target_total_duration_seconds, 3150);
  assert.deepEqual(plan.outline_unit_budgets.map((unit) => unit.planned_episodes), [5, 5, 5, 7, 7, 6]);
  assert.deepEqual(plan.outline_unit_budgets.map((unit) => unit.planned_duration_seconds), [450, 450, 450, 630, 630, 540]);
});

test("小说索引排除文档元信息并保留真实开篇", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-novel-index-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
  const sourcePath = path.join(workspace, "runtime", "原始小说.md");
  await fs.writeFile(sourcePath, "# 复仇小说\n\n來源：https://example.com/novel\n\n## 第1章 来信\n她收到了信。\n", "utf8");

  const index = await buildNovelSourceIndex(workspace, "runtime/原始小说.md");

  assert.equal(index.chapters[0].title, "第1章 来信");
  assert.equal(index.chapters[0].start_line, 1);
  await fs.writeFile(sourcePath, "她在雨中决定复仇。\n序章\n命运开始\n第一章 来信\n她收到了信。\n", "utf8");
  const withNarrativePreface = await buildNovelSourceIndex(workspace, "runtime/原始小说.md");
  assert.equal(withNarrativePreface.chapters[0].title, "开篇");
  assert.equal(withNarrativePreface.chapters[1].title, "序章");
  await assert.rejects(buildNovelSourceIndex(workspace, "../越界.md"), /必须位于当前项目目录内/u);
});

test("小说解读在写入产物前拒绝超过六十万字的原文", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agents-novel-length-limit-"));
  const sourcePath = path.join(directory, "长篇小说.md");
  await fs.writeFile(sourcePath, "第一章\n主角作出选择。\n", "utf8");
  let workspace = "";
  t.after(async () => {
    await Promise.all([
      workspace ? fs.rm(workspace, { recursive: true, force: true }) : Promise.resolve(),
      fs.rm(directory, { recursive: true, force: true })
    ]);
  });

  const initialized = await initializeProject([
    "--project-name", `超长小说-${Date.now()}`,
    "--script-file", sourcePath,
    "--source-title", "超长小说",
    "--target-region", "国内",
    "--task-type", "novel",
    "--created-by", "novel-test"
  ]);
  workspace = initialized.workspace_dir;
  const originalPath = path.join(workspace, "runtime", "原始小说.md");
  await fs.writeFile(originalPath, "字".repeat(600_001), "utf8");

  const admission = await checkNovelLength(workspace);
  assert.equal(admission.allowed, false);
  assert.equal(admission.character_count, 600_001);
  assert.equal(
    admission.message,
    "这是一部 60.0 万字的宏篇巨著，剧本化效果不会很好。\n建议分多季，每季30万字左右，再按季实现剧本化。"
  );
  await assert.rejects(initializeNovelAnalysis(workspace, "novel-test"), /这是一部 60\.0 万字/u);
  await assert.rejects(fs.stat(path.join(workspace, "2.1-novel-analysis.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(workspace, "runtime", "novel-source-index.json")), { code: "ENOENT" });
});

test("小说索引会无损拆分过长单段", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-novel-long-line-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const longParagraph = "她继续追查。".repeat(2000);
  await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
  await fs.writeFile(path.join(workspace, "runtime", "原始小说.md"), `第一章\n${longParagraph}`, "utf8");

  const index = await buildNovelSourceIndex(workspace, "runtime/原始小说.md");
  const normalized = await fs.readFile(path.join(workspace, "runtime", "原始小说.md"), "utf8");
  const normalizedLines = normalized.split("\n");

  assert.ok(index.total_lines > 2);
  assert.ok(normalizedLines.every((line) => line.length <= 4000));
  assert.equal(normalizedLines.slice(1).join(""), longParagraph);
});

test("小说索引按章节边界生成大块阅读范围", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-novel-batches-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
  const source = Array.from({ length: 6 }, (_, index) => [
    `第${index + 1}章`,
    "剧情".repeat(15_000)
  ].join("\n")).join("\n");
  await fs.writeFile(path.join(workspace, "runtime", "原始小说.md"), source, "utf8");

  const index = await buildNovelSourceIndex(workspace, "runtime/原始小说.md");
  const chapterStarts = new Set(index.chapters.map((chapter) => chapter.start_line));
  const chapterEnds = new Set(index.chapters.map((chapter) => chapter.end_line));

  assert.equal(index.suggested_batches.length, 6);
  index.suggested_batches.forEach((batch) => {
    assert.ok(batch.char_count > 0 && batch.char_count <= 54_000);
    assert.ok(chapterStarts.has(batch.start_line));
    assert.ok(chapterEnds.has(batch.end_line));
  });
});

test("小说索引限制单个阅读范围承载的章节数", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-novel-chapter-cap-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
  const source = Array.from({ length: 37 }, (_, index) => `第${index + 1}章\n短章节正文。`).join("\n");
  await fs.writeFile(path.join(workspace, "runtime", "原始小说.md"), source, "utf8");

  const index = await buildNovelSourceIndex(workspace, "runtime/原始小说.md");

  assert.equal(index.suggested_batches.length, 4);
  index.suggested_batches.forEach((batch) => {
    const chapterCount = index.chapters.filter(
      (chapter) => chapter.start_line >= batch.start_line && chapter.end_line <= batch.end_line
    ).length;
    assert.ok(chapterCount <= 12);
  });
});

test("小说原文读取兼容闭区间的 1201 行边界", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-novel-read-limit-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const sourceLines = Array.from({ length: 1202 }, (_, index) => `正文第 ${index + 1} 行`);
  await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
  await fs.writeFile(path.join(workspace, "runtime", "原始小说.md"), sourceLines.join("\n"), "utf8");
  await writeJson(path.join(workspace, "runtime", "novel-source-index.json"), {
    source_file: "runtime/原始小说.md",
    total_lines: sourceLines.length,
    chapters: []
  });

  const tolerated = await readNovelSource(workspace, { range: "1-1201" });
  assert.equal(tolerated.content.split("\n").length, 1201);
  assert.match(tolerated.content, /^1: 正文第 1 行/mu);
  assert.match(tolerated.content, /1201: 正文第 1201 行$/mu);
  await assert.rejects(readNovelSource(workspace, { range: "1-1202" }), /单次最多读取 1200 行/u);
});

test("EPUB 按 OPF spine 顺序提取正文", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agents-epub-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const epubPath = path.join(directory, "小说.epub");
  const outputPath = path.join(directory, "小说.md");
  const archive = new JSZip();
  archive.file("META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>`);
  archive.file("OPS/content.opf", `<?xml version="1.0"?><package><manifest><item id="first" href="chapter-1.xhtml" media-type="application/xhtml+xml"/><item id="second" href="chapter-2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="second"/><itemref idref="first"/></spine></package>`);
  archive.file("OPS/chapter-1.xhtml", "<html><body><h1>第一章</h1><p>第一段正文。</p></body></html>");
  archive.file("OPS/chapter-2.xhtml", "<html><body><h1>第二章</h1><p>第二段正文。</p></body></html>");
  await fs.writeFile(epubPath, await archive.generateAsync({ type: "nodebuffer" }));

  const result = await convertScriptToMarkdown(epubPath, outputPath);
  const converted = await fs.readFile(outputPath, "utf8");
  assert.equal(result.converter, "epub-jszip");
  assert.ok(converted.indexOf("第二章") < converted.indexOf("第一章"));
  assert.match(converted, /第二段正文。/u);
});

test("国内小说改编初始化后跳过台词翻译", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agents-domestic-novel-"));
  const sourcePath = path.join(directory, "国内小说.md");
  await fs.writeFile(sourcePath, "第一章\n主角必须立刻做出选择。\n", "utf8");
  let workspace = "";
  t.after(async () => {
    await Promise.all([
      workspace ? fs.rm(workspace, { recursive: true, force: true }) : Promise.resolve(),
      fs.rm(directory, { recursive: true, force: true })
    ]);
  });

  const initialized = await initializeProject([
    "--project-name", `国内小说-${Date.now()}`,
    "--script-file", sourcePath,
    "--source-title", "国内小说",
    "--target-region", "国内",
    "--task-type", "novel",
    "--created-by", "novel-test"
  ]);
  workspace = initialized.workspace_dir;
  const progress = await fs.readFile(path.join(workspace, "1.2-project-progress.json"), "utf8").then(JSON.parse);
  const input = await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8").then(JSON.parse);
  const validation = await validateProjectWorkspace(workspace);
  assert.equal(input.project.requires_translation, false);
  assert.equal(progress.stages.dialogue_translate.status, "skipped");
  assert.equal(validation.next_skill, "novel_analysis");
});

test("小说改编从全文索引到高光按需读取形成闭环", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-novel-analysis-"));
  const sourcePath = path.join(tempDir, "长篇小说.md");
  const paragraphs = [
    "第一章 被调换的信件",
    "林夏在婚礼前收到一封署名陌生的信。",
    "信中证明她的身份在二十年前被调换。",
    "她没有逃走，而是把信藏进捧花，决定当众求证。",
    "第二章 当众选择",
    "订婚宴上，林夏把信交给祖母。",
    "周沉试图夺走证据，林夏当众念出落款。",
    "祖母承认隐瞒，并交出第二份鉴定报告。",
    ...Array.from({ length: 30 }, (_, index) => `追查记录 ${index + 1}：林夏继续核对证据与人物关系。`)
  ];
  await fs.writeFile(sourcePath, `${paragraphs.join("\n")}\n`, "utf8");
  let workspace = "";
  t.after(async () => {
    await Promise.all([
      workspace ? fs.rm(workspace, { recursive: true, force: true }) : Promise.resolve(),
      fs.rm(tempDir, { recursive: true, force: true })
    ]);
  });

  const initialized = await initializeProject([
    "--project-name", `小说改编契约-${Date.now()}`,
    "--script-file", sourcePath,
    "--source-title", "长篇小说",
    "--target-region", "North America",
    "--task-type", "novel",
    "--episode-duration", "90秒",
    "--target-episode-count", "35",
    "--created-by", "novel-test"
  ]);
  workspace = initialized.workspace_dir;
  const validation = await validateProjectWorkspace(workspace);
  assert.equal(validation.next_skill, "novel_analysis");
  assert.ok(await fs.stat(path.join(workspace, "runtime", "原始小说.md")));
  await assert.rejects(fs.stat(path.join(workspace, "output", "原始剧本.md")));

  const analysisInit = await initializeNovelAnalysis(workspace, "novel-test");
  assert.equal(analysisInit.source_index.chapters.length, 2);
  assert.equal(analysisInit.adaptation_plan.max_outline_unit_count, 6);
  await resolveScriptProfile({
    workspace,
    stage: "novel_analysis",
    updatedBy: "novel-test",
    theme: "现代言情,悬疑",
    setting: "大女主,豪门",
    background: "现代,都市",
    audience: "女频"
  });
  const sourceExcerpt = await readNovelSource(workspace, { sourceIndex: "L2-L5" });
  assert.match(sourceExcerpt.content, /身份在二十年前被调换/u);
  await assert.rejects(readNovelSource(workspace, { sourceIndex: "L2-L999" }), /行号必须位于/u);

  const analysis = {
    "基础信息": {
      "小说名称": "长篇小说",
      "小说梗概": "林夏在订婚前发现身份被调换，以公开求证推动家族秘密逐层揭开。",
      "题材": ["现代情感", "身份悬疑"],
      "基调": "高压、克制、持续反转"
    },
    "核心卖点": "身份谜局不断升级：主角每次主动求证都会揭开更大的家族秘密，并迫使她承担更高代价。",
    "故事主线": "林夏发现身份疑点，选择公开追查，在关系破裂与证据争夺中逼近真相，最终夺回身份决定权。",
    "世界观": "现代家族企业以血缘和继承权维持秩序，公开鉴定报告会直接改变权力归属。",
    "关键人物": [{
      "人物名称": "林夏",
      "人物画像": "身份被调换的继承人，渴望查清身份并保住选择权；从依赖家族认可转为主动公开真相，转变发生在订婚宴公开信件时。"
    }],
    "剧情单元": [{
      "单元ID": "unit-letter",
      "单元名称": "信件出现",
      "单元梗概": "林夏收到身份信件，并决定把私人疑点带到公开场合求证。",
      "主线推进": "身份疑点从内心怀疑变为主动行动。",
      "关键人物": [{ "人物名称": "林夏", "单元作用与变化": "从震惊转为主动设计公开求证。" }],
      "关键信息": ["林夏知道身份可能被调换，其他人不知道她已拿到信。"],
      "高光时刻": [{ "名称": "捧花藏信", "原文索引": "L2-L5" }],
      "改编建议": "保留",
      "合并目标单元ID": "",
      "已确认合并": false,
      "建议原因": "该单元前置身份冲突，并让主角作出公开求证的主动选择。"
    }, {
      "单元ID": "unit-banquet",
      "单元名称": "宴会揭信",
      "单元梗概": "林夏在宴会上公开信件，迫使祖母承认隐瞒并交出新证据。",
      "主线推进": "身份秘密首次公开，证据争夺升级。",
      "关键人物": [{ "人物名称": "林夏", "单元作用与变化": "从试探求证转为承担公开真相的代价。" }],
      "关键信息": ["祖母掌握第二份鉴定报告。"],
      "高光时刻": [{ "名称": "宴会公开身份", "原文索引": "L6-L9" }],
      "改编建议": "保留",
      "合并目标单元ID": "",
      "已确认合并": false,
      "建议原因": "身份公开带来关系与证据争夺的双重升级，是不可替代的中段高光。"
    }]
  };
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), analysis);
  const validatedOnly = await checkNovelAnalysis(workspace, "novel-test", { validateOnly: true });
  assert.equal(validatedOnly.ok, true);
  assert.equal(validatedOnly.validation_only, true);

  const localUnitCharacter = JSON.parse(JSON.stringify(analysis));
  localUnitCharacter["剧情单元"][1]["关键人物"].push({
    "人物名称": "祖母",
    "单元作用与变化": "被公开的证据迫使她承认隐瞒，并交出新的鉴定报告。"
  });
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), localUnitCharacter);
  const localUnitCharacterChecked = await checkNovelAnalysis(workspace, "novel-test", { validateOnly: true });
  assert.equal(localUnitCharacterChecked.ok, true);

  const tooManyPrimaryCharacters = JSON.parse(JSON.stringify(analysis));
  tooManyPrimaryCharacters["关键人物"] = Array.from({ length: 11 }, (_, index) => ({
    "人物名称": `主要角色${index + 1}`,
    "人物画像": "持续推动主线并在终局获得关系回报。"
  }));
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), tooManyPrimaryCharacters);
  const tooManyPrimaryCharactersChecked = await checkNovelAnalysis(workspace, "novel-test", { validateOnly: true });
  assert.equal(tooManyPrimaryCharactersChecked.ok, false);
  assert.ok(tooManyPrimaryCharactersChecked.issues.some((issue) => issue.startsWith("关键人物最多 10 人")));

  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), analysis);
  const progressBeforePublish = await fs.readFile(path.join(workspace, "1.2-project-progress.json"), "utf8").then(JSON.parse);
  assert.equal(progressBeforePublish.stages.novel_analysis.status, "in_progress");
  const checked = await checkNovelAnalysis(workspace, "novel-test");
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.recommendation_counts, { retain: 2, delete: 0, merge: 0 });
  assert.equal(checked.confirmed_merge_count, 0);

  const overBudgetSuggestion = JSON.parse(JSON.stringify(analysis));
  overBudgetSuggestion["剧情单元"] = Array.from({ length: 7 }, (_, index) => {
    const unit = JSON.parse(JSON.stringify(analysis["剧情单元"][index % analysis["剧情单元"].length]));
    unit["单元ID"] = `unit-budget-${index + 1}`;
    unit["单元名称"] = `原著单元${index + 1}`;
    unit["改编建议"] = "保留";
    unit["建议原因"] = "该单元保留主线推进与不可替代的情节回报。";
    return unit;
  });
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), overBudgetSuggestion);
  const overBudgetChecked = await checkNovelAnalysis(workspace, "novel-test");
  assert.equal(overBudgetChecked.ok, true);
  assert.deepEqual(overBudgetChecked.recommendation_counts, { retain: 7, delete: 0, merge: 0 });

  overBudgetSuggestion["剧情单元"][6]["改编建议"] = "删除";
  overBudgetSuggestion["剧情单元"][6]["建议原因"] = "该单元重复交代既有证据，只保留结果并压缩并入原著单元6。";
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), overBudgetSuggestion);
  const withinBudgetChecked = await checkNovelAnalysis(workspace, "novel-test");
  assert.equal(withinBudgetChecked.ok, true);
  assert.deepEqual(withinBudgetChecked.recommendation_counts, { retain: 6, delete: 1, merge: 0 });
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), analysis);

  const deleteSuggestion = JSON.parse(JSON.stringify(analysis));
  deleteSuggestion["剧情单元"][0]["改编建议"] = "删除";
  deleteSuggestion["剧情单元"][0]["建议原因"] = "该单元只重复交代身份疑点，可并入后续公开求证。";
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), deleteSuggestion);
  const deletedChecked = await checkNovelAnalysis(workspace, "novel-test");
  assert.equal(deletedChecked.ok, true);
  const unconfirmedDeleteContext = await getAdaptationContext(workspace);
  const unconfirmedDeleteUnit = unconfirmedDeleteContext.novel_analysis["剧情单元"].find((unit) => unit["单元ID"] === "unit-letter");
  assert.ok(unconfirmedDeleteUnit);
  assertNoUnconfirmedDecision(unconfirmedDeleteUnit);

  const invalidSuggestion = JSON.parse(JSON.stringify(analysis));
  invalidSuggestion["剧情单元"][0]["改编建议"] = "合并";
  invalidSuggestion["剧情单元"][0]["建议原因"] = "";
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), invalidSuggestion);
  const invalidChecked = await checkNovelAnalysis(workspace, "novel-test");
  assert.equal(invalidChecked.ok, false);
  assert.ok(invalidChecked.issues.includes("剧情单元第 1 项建议合并时必须指定合并目标单元ID"));
  assert.ok(invalidChecked.issues.includes("剧情单元第 1 项的建议原因不能为空"));

  const mergeSuggestion = JSON.parse(JSON.stringify(analysis));
  mergeSuggestion["剧情单元"][0]["改编建议"] = "合并";
  mergeSuggestion["剧情单元"][0]["合并目标单元ID"] = "unit-banquet";
  mergeSuggestion["剧情单元"][0]["建议原因"] = "信件本身不单独展开，但其公开选择与高光应并入宴会揭信。";
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), mergeSuggestion);
  const mergeChecked = await checkNovelAnalysis(workspace, "novel-test");
  assert.equal(mergeChecked.ok, true);
  assert.deepEqual(mergeChecked.recommendation_counts, { retain: 1, delete: 0, merge: 1 });
  assert.equal(mergeChecked.confirmed_merge_count, 0);

  const missingMergeTarget = JSON.parse(JSON.stringify(mergeSuggestion));
  missingMergeTarget["剧情单元"][0]["合并目标单元ID"] = "unit-missing";
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), missingMergeTarget);
  const missingMergeTargetChecked = await checkNovelAnalysis(workspace, "novel-test", { validateOnly: true });
  assert.equal(missingMergeTargetChecked.ok, false);
  assert.ok(missingMergeTargetChecked.issues.includes("剧情单元第 1 项的合并目标单元ID无效：unit-missing"));

  const nonRetainedMergeTarget = JSON.parse(JSON.stringify(mergeSuggestion));
  nonRetainedMergeTarget["剧情单元"][1]["改编建议"] = "删除";
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), nonRetainedMergeTarget);
  const nonRetainedTargetChecked = await checkNovelAnalysis(workspace, "novel-test", { validateOnly: true });
  assert.equal(nonRetainedTargetChecked.ok, false);
  assert.ok(nonRetainedTargetChecked.issues.includes("剧情单元第 1 项只能并入建议保留的剧情单元：unit-banquet"));
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), mergeSuggestion);

  const context = await getAdaptationContext(workspace);
  assert.equal(context.source_kind, "novel_analysis");
  assert.equal(Object.hasOwn(context, "source_file"), false);
  assert.equal(context.world_view["世界观描述"], analysis["世界观"]);
  assert.deepEqual(context.world_view["关键概念映射"], []);
  assert.equal(context.adaptation_plan.max_outline_unit_count, 6);
  assert.equal(Object.hasOwn(context, "original_novel"), false);
  assert.equal(context.novel_analysis["剧情单元"].length, 2);
  context.novel_analysis["剧情单元"].forEach(assertNoUnconfirmedDecision);

  const outlineInit = await initializeOutline(workspace, "novel-test");
  await getOutlineExecutionStrategy(workspace);
  const initializedOutline = await fs.readFile(path.join(workspace, "3.1-outline.json"), "utf8").then(JSON.parse);
  const projectInput = await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8").then(JSON.parse);
  const projectTitle = projectInput.project.project_name;
  assert.equal(outlineInit.task_type, "novel");
  assert.equal(Object.hasOwn(outlineInit, "adaptation_context_file"), false);
  assert.equal(outlineInit.adaptation_plan.max_outline_unit_count, 6);
  assert.equal(initializedOutline["剧本名称"], projectTitle);
  assert.equal(initializedOutline["英文剧本名称"], "");
  const overCapacityOutline = {
    "剧本名称": projectTitle,
    "英文剧本名称": "",
    "关键角色名称映射": [{ "英文名称": "Erin Gray", "中文名称": "艾琳·格雷" }],
    "故事梗概": "艾琳主动公开身份疑点，在证据争夺中拿回选择权。",
    "开篇": {
      "开篇描述": "艾琳在订婚前收到身份信件。",
      "关键角色": ["艾琳·格雷"],
      "剧集": [episode(1)],
      "原著剧情单元": ["unit-letter"]
    },
    "剧情单元": [{
      "单元名称": "公开追查",
      "单元描述": "艾琳把秘密带到公开场合，并继续追查证据。",
      "关键角色": ["艾琳·格雷"],
      "剧集": Array.from({ length: 10 }, (_, index) => episode(index + 2)),
      "原著剧情单元": ["unit-banquet"]
    }]
  };
  await writeJson(path.join(workspace, "3.1-outline.json"), overCapacityOutline);
  const overCapacityChecked = await checkOutline(workspace, "novel-test");
  assert.equal(overCapacityChecked.ok, false);
  assert.ok(overCapacityChecked.issues.includes("第 1 个剧情单元（含开篇第 1 集）最多 5 集，当前为 11 集"));
  assert.ok(!overCapacityChecked.issues.some((issue) => issue.includes("已确认合并的原著剧情单元 unit-letter")));

  const confirmedMergeSuggestion = JSON.parse(JSON.stringify(mergeSuggestion));
  confirmedMergeSuggestion["剧情单元"][0]["已确认合并"] = true;
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), confirmedMergeSuggestion);
  const confirmedMergeChecked = await checkNovelAnalysis(workspace, "novel-test");
  assert.equal(confirmedMergeChecked.ok, true);
  assert.equal(confirmedMergeChecked.confirmed_merge_count, 1);
  const confirmedMergeContext = await getAdaptationContext(workspace);
  const confirmedMergeUnit = confirmedMergeContext.novel_analysis["剧情单元"].find((unit) => unit["单元ID"] === "unit-letter");
  assert.deepEqual({
    "改编建议": confirmedMergeUnit?.["改编建议"],
    "合并目标单元ID": confirmedMergeUnit?.["合并目标单元ID"],
    "已确认合并": confirmedMergeUnit?.["已确认合并"],
    "建议原因": confirmedMergeUnit?.["建议原因"]
  }, {
    "改编建议": "合并",
    "合并目标单元ID": "unit-banquet",
    "已确认合并": true,
    "建议原因": "信件本身不单独展开，但其公开选择与高光应并入宴会揭信。"
  });
  const mergeTargetUnit = confirmedMergeContext.novel_analysis["剧情单元"].find((unit) => unit["单元ID"] === "unit-banquet");
  assert.ok(mergeTargetUnit);
  assertNoUnconfirmedDecision(mergeTargetUnit);
  await writeJson(path.join(workspace, "3.1-outline.json"), overCapacityOutline);
  const confirmedMergeOutlineChecked = await checkOutline(workspace, "novel-test");
  assert.equal(confirmedMergeOutlineChecked.ok, false);
  assert.ok(confirmedMergeOutlineChecked.issues.includes("已确认合并的原著剧情单元 unit-letter 必须与其目标 unit-banquet 关联到同一个故事梗概单元"));

  function outlineUnit(name, startEpisode, episodeCount, sourceUnits) {
    return {
      "单元名称": name,
      "单元描述": `${name}持续推动身份证据与关系冲突。`,
      "关键角色": ["艾琳·格雷"],
      "剧集": Array.from({ length: episodeCount }, (_, index) => episode(startEpisode + index)),
      "原著剧情单元": sourceUnits
    };
  }

  const validOutline = {
    ...overCapacityOutline,
    "开篇": {
      ...overCapacityOutline["开篇"],
      "原著剧情单元": ["unit-letter", "unit-banquet"]
    },
    "剧情单元": [
      outlineUnit("公开追查", 2, 4, ["unit-banquet"]),
      outlineUnit("证据升级", 6, 5, ["unit-banquet"]),
      outlineUnit("关系决裂", 11, 5, ["unit-banquet"]),
      outlineUnit("身份反转", 16, 7, ["unit-banquet"]),
      outlineUnit("反击夺权", 23, 7, ["unit-banquet"]),
      outlineUnit("终局选择", 30, 6, ["unit-banquet"])
    ]
  };
  const tooManyUnitsOutline = JSON.parse(JSON.stringify(validOutline));
  tooManyUnitsOutline["剧情单元"].push(outlineUnit("尾声", 36, 1, ["unit-banquet"]));
  await writeJson(path.join(workspace, "3.1-outline.json"), tooManyUnitsOutline);
  const tooManyUnitsChecked = await checkOutline(workspace, "novel-test");
  assert.equal(tooManyUnitsChecked.ok, false);
  assert.ok(tooManyUnitsChecked.issues.includes("故事梗概最多可安排 6 个剧情单元，当前为 7 个"));

  await writeJson(path.join(workspace, "3.1-outline.json"), validOutline);
  const outlineChecked = await checkOutline(workspace, "novel-test");
  assert.equal(outlineChecked.ok, true);
  assert.match(await fs.readFile(outlineChecked.output_file, "utf8"), new RegExp(`^# ${projectTitle} - 故事梗概`, "u"));

  const renamedNovelOutline = { ...validOutline, "剧本名称": "继承疑云" };
  await writeJson(path.join(workspace, "3.1-outline.json"), renamedNovelOutline);
  const renamedNovelChecked = await checkOutline(workspace, "novel-test");
  assert.equal(renamedNovelChecked.ok, false);
  assert.ok(renamedNovelChecked.issues.includes(`非剧本改写或爆款复刻项目的剧本名称必须保持为项目名称“${projectTitle}”，不得在故事梗概阶段重命名`));

  const englishNovelOutline = { ...validOutline, "英文剧本名称": "Inheritance in Doubt" };
  await writeJson(path.join(workspace, "3.1-outline.json"), englishNovelOutline);
  const englishNovelChecked = await checkOutline(workspace, "novel-test");
  assert.equal(englishNovelChecked.ok, false);
  assert.ok(englishNovelChecked.issues.includes("非剧本改写项目无需填写英文剧本名称"));

  await writeJson(path.join(workspace, "3.1-outline.json"), validOutline);

  const userDeletedUnit = JSON.parse(JSON.stringify(confirmedMergeSuggestion));
  userDeletedUnit["剧情单元"] = userDeletedUnit["剧情单元"].filter((unit) => unit["单元ID"] !== "unit-letter");
  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), userDeletedUnit);
  const deletionChecked = await checkNovelAnalysis(workspace, "novel-test");
  assert.equal(deletionChecked.ok, true);
  const confirmedDeletionContext = await getAdaptationContext(workspace);
  assert.equal(confirmedDeletionContext.novel_analysis["剧情单元"].some((unit) => unit["单元ID"] === "unit-letter"), false);
  const deletionOutline = JSON.parse(JSON.stringify(validOutline));
  deletionOutline["开篇"]["原著剧情单元"] = ["unit-banquet"];
  await writeJson(path.join(workspace, "3.1-outline.json"), deletionOutline);
  const deletionOutlineChecked = await checkOutline(workspace, "novel-test");
  assert.equal(deletionOutlineChecked.ok, true);

  await writeJson(path.join(workspace, "2.1-novel-analysis.json"), confirmedMergeSuggestion);
  await writeJson(path.join(workspace, "3.1-outline.json"), validOutline);
  const restoredOutlineChecked = await checkOutline(workspace, "novel-test");
  assert.equal(restoredOutlineChecked.ok, true);
  await writeJson(path.join(workspace, "4.1-character.json"), [{
    "人物名称": "艾琳·格雷",
    "核心诉求": "查清身份",
    "人物难题": "公开真相会失去家人",
    "关系与弧光": "从寻求认可转为承担选择",
    "阶段变化": [
      { "故事阶段": "开篇", "身份与处境": "收到信件", "人物形象": "28岁的继承人，神情克制，穿家族晚宴礼服，谨慎但愿意求证。", "口吻": "先试探对方掌握的信息，再克制地提出追问。" },
      { "故事阶段": "关系决裂", "身份与处境": "公开秘密", "人物形象": "28岁的继承人，神情克制，穿家族晚宴礼服，谨慎但愿意求证，关系破裂后仍保持体面。", "口吻": "不再回避关键事实，直接提出条件并承担关系破裂的后果。" }
    ]
  }]);

  const openingInfo = await getEpisodeInfo(workspace, { episode: 1 });
  assert.equal(openingInfo.task_type, "novel");
  assert.match(openingInfo.next_action, /高光时刻剧本改编原则/u);
  assert.match(openingInfo.next_action, /读取小说高光原文/u);
  assert.equal(openingInfo.source_highlights[0].unit_id, "unit-letter");
  assert.equal(openingInfo.source_highlights[0].highlights[0].source_index, "L2-L5");
  const revisionProgress = await fs.readFile(path.join(workspace, "1.2-project-progress.json"), "utf8").then(JSON.parse);
  revisionProgress.stages.trial_generate = { status: "pending" };
  revisionProgress.stages.full_generate = { status: "stale", completed_once: true };
  await writeJson(path.join(workspace, "1.2-project-progress.json"), revisionProgress);
  const fullRevision = await initializeFull(workspace, "novel-test");
  assert.equal(fullRevision.generation_mode, "full_revision");
  const fullStage = await getStageInfo(workspace, "关系决裂");
  assert.equal(fullStage.generation_mode, "full_revision");
  assert.equal(fullStage.source_highlights[0].unit_id, "unit-banquet");
  assert.equal(fullStage.source_highlights[0].highlights[0].source_index, "L6-L9");
});
