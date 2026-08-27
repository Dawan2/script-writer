#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete } from "../../../tools/distribution-brief.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import {
  screenplayLengthContract,
  underLengthEpisodes,
  underLengthIssue
} from "../../../tools/screenplay-length.mjs";
import { collectOutlineEpisodes, episodeTitle, parseTrialTemplate } from "./init-trial.mjs";
import {
  loadStageExecutionStrategy,
  shouldValidateStageExecution,
  stageExecutionSpecIssues,
  stageExecutionStrategyIssues
} from "../../_shared/scripts/stage-execution-spec.mjs";
import {
  actionLineIssues,
  normalizeActionLineSpacingFile
} from "../../_shared/scripts/screenplay-format-validation.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/trial.json5");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

function extractEpisodes(text) {
  const headings = [...text.matchAll(/^##[ \t]*第[ \t]*(\d+)[ \t]*集(?:[ \t]*[：:][ \t]*(.+?))?[ \t]*\r?$/gmu)];
  return headings.map((heading, index) => ({
    episode: Number(heading[1]),
    title: (heading[2] || "").trim(),
    content: text.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim()
  }));
}

function checkEpisode(section, issues) {
  const label = `第 ${section.episode} 集`;
  const lines = section.content.split(/\r?\n/u);
  if (!lines.some((line) => line.startsWith("### "))) issues.push(`${label}至少需要一个场景标题`);
  if (!lines.some((line) => line.startsWith("人物："))) issues.push(`${label}缺少人物栏`);
  issues.push(...actionLineIssues(lines, label));
  const hasChineseDialogue = lines.some((line) => (
    /^[^#△|>：:\n]{1,32}(?:[（(][^）)\n]{1,24}[）)])?[：:]\s*\S/u.test(line)
    && !/^人物[：:]/u.test(line)
  ));
  if (!hasChineseDialogue) {
    issues.push(`${label}至少需要一组中文台词`);
  }
}

export async function checkTrial(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const trialPath = path.join(workspaceDir, "output", "剧本试稿.md");
  const [progress, userInput, outline, template, normalizedTrial] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8").then(JSON.parse),
    fs.readFile(templatePath, "utf8").then(parseTrialTemplate),
    normalizeActionLineSpacingFile(trialPath)
  ]);
  const text = normalizedTrial.content;
  const formatRepairs = normalizedTrial.repairedLineCount > 0
    ? [`已自动为 ${normalizedTrial.repairedLineCount} 个动作行补充“△”后的空格。`]
    : [];
  assertDistributionBriefComplete(userInput.project);
  const lengthContract = screenplayLengthContract(userInput);
  if (progress.stages?.character_rewrite?.status !== "completed") throw new Error("character_rewrite 尚未完成");
  const issues = [];
  const validateExecution = await shouldValidateStageExecution(workspaceDir, "trial_generate");
  if (validateExecution) {
    issues.push(...await stageExecutionSpecIssues(workspaceDir, "trial_generate", userInput));
    issues.push(...await stageExecutionStrategyIssues(workspaceDir, "trial_generate", userInput));
  }
  if (!text.trimStart().startsWith(template["文档标题"])) issues.push("剧本试稿缺少正确的文档标题");
  const expectedEntries = collectOutlineEpisodes(outline).slice(0, 10);
  const expected = expectedEntries.map((entry) => entry.episode);
  const sections = extractEpisodes(text);
  const actual = sections.map((section) => section.episode);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    issues.push(`试稿必须且只能包含第 ${expected.join("、")} 集`);
  }
  const expectedTitles = new Map(expectedEntries.map((entry) => [entry.episode, episodeTitle(entry)]));
  sections.forEach((section) => {
    const title = expectedTitles.get(section.episode);
    if (title && section.title !== title) issues.push(`第 ${section.episode} 集标题必须为“${title}”`);
  });
  sections.forEach((section) => checkEpisode(section, issues));
  const shortEpisodes = underLengthEpisodes(sections, lengthContract.minimum_episode_characters);
  if (shortEpisodes.length) issues.push(underLengthIssue(shortEpisodes, lengthContract.minimum_episode_characters));
  if (issues.length) return { ok: false, issues, format_repairs: formatRepairs };
  await updateProgress({
    workspace: workspaceDir,
    stage: "trial_generate",
    status: "awaiting_approval",
    allowApprovalState: true,
    updatedBy,
    outputFiles: ["output/剧本试稿.md"]
  });
  return {
    ok: true,
    output_file: path.join(workspaceDir, "output", "剧本试稿.md"),
    episode_range: [expected[0], expected.at(-1)],
    approval_required: true,
    format_repairs: formatRepairs,
    quality_check: {
      passed: true,
      principle_review_criteria: (validateExecution
        ? (await loadStageExecutionStrategy(workspaceDir, "trial_generate")).snapshot?.principles
        : []
      )?.map((item) => ({
        principle_id: item.id,
        title: item.title,
        version: item.version,
        review_criteria: item.review_criteria
      })) || []
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkTrial(args.workspace, args.updatedBy);
    if (!result.ok) {
      const text = result.issues.join("\n");
      const nextAction = /执行策略/u.test(text)
        ? "先重新调用执行策略并阅读新文件，再重新检查。"
        : /执行规范|项目信息|用户要求或偏好/u.test(text)
          ? "先重新调用初始化剧本试稿并阅读新执行规范，再重新生成执行策略。"
          : "只修复 output/剧本试稿.md 中返回的问题后重新检查。";
      process.stderr.write(`${JSON.stringify({ ...result, stage: "trial_generate", tool: "check", next_action: nextAction }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "剧本试稿已通过检查，等待用户确认。", next_action: "请用户审阅并批准剧本试稿后，再执行 full_generate。" }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "trial_generate", tool: "check", message: error.message, next_action: "检查剧本试稿、大纲和角色小传后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
