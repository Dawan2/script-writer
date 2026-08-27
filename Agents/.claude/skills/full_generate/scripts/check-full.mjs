#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "../../../tools/update-progress.mjs";
import {
  assertEpisodeNumbers,
  collectOutlineStages,
  extractEpisodeSections,
  flattenEpisodes,
  getStageTasks,
  normalizeEpisodeSectionHeading,
  renderFullScript,
  stageFilePath,
  trialEpisodeCount
} from "./full-utils.mjs";
import { assertDistributionBriefComplete } from "../../../tools/distribution-brief.mjs";
import { fullScriptHeading, fullScriptRelativePath, hasCompletedFullScript } from "../../../tools/script-artifacts.mjs";
import {
  screenplayLengthContract,
  underLengthEpisodes,
  underLengthIssue
} from "../../../tools/screenplay-length.mjs";
import { normalizeBilingualDialogueFormat } from "../../../tools/bilingual-dialogue-format.mjs";
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

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

function isChineseDialogueLine(line) {
  return /^[^#△|>：:\n]{1,32}(?:[（(][^）)\n]{1,24}[）)])?[：:]\s*\S/u.test(line)
    && !/^人物[：:]/u.test(line);
}

function normalizeOptionalTargetDialogue(text) {
  const formatted = normalizeBilingualDialogueFormat(String(text || "")).content;
  const lines = formatted.replace(/\r\n?/gu, "\n").split("\n");
  const normalized = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isChineseDialogueLine(line)) {
      normalized.push(line);
      continue;
    }
    // A parenthesized line immediately after dialogue is the optional target-language slot.
    normalized.push(line.replace(/[ \t]{2,}$/u, ""));
    if (/^[（(].+[）)]$/u.test((lines[index + 1] || "").trim())) index += 1;
  }
  return normalized.join("\n");
}

function checkEpisode(section, issues) {
  const label = `第 ${section.episode} 集`;
  const lines = section.content.split(/\r?\n/u);
  if (!lines.some((line) => line.startsWith("### "))) issues.push(`${label}至少需要一个场景标题`);
  if (!lines.some((line) => line.startsWith("人物："))) issues.push(`${label}缺少人物栏`);
  issues.push(...actionLineIssues(lines, label));
  if (!lines.some(isChineseDialogueLine)) {
    issues.push(`${label}至少需要一组中文台词`);
  }
}

export async function checkFull(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [userInput, outline] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8").then(JSON.parse)
  ]);
  assertDistributionBriefComplete(userInput.project);
  const lengthContract = screenplayLengthContract(userInput);
  const fullRelativePath = fullScriptRelativePath(outline);
  const formatRepairs = [];
  async function readNormalizedScript(filePath) {
    const normalized = await normalizeActionLineSpacingFile(filePath);
    if (normalized.repairedLineCount > 0) {
      formatRepairs.push(
        `${path.relative(workspaceDir, filePath)}：已自动为 ${normalized.repairedLineCount} 个动作行补充“△”后的空格。`
      );
    }
    return normalized.content;
  }
  const fullText = await readNormalizedScript(path.join(workspaceDir, fullRelativePath));
  const progress = await fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse);
  const stages = collectOutlineStages(outline);
  const entries = flattenEpisodes(stages);
  const fullProgress = progress.stages?.full_generate || {};
  const fullRevision = hasCompletedFullScript(userInput.project, fullProgress);
  const covered = trialEpisodeCount(stages);
  const fullSections = extractEpisodeSections(fullText);
  const stageSections = [];
  for (const stage of fullRevision ? [] : getStageTasks(stages, covered)) {
    const stagePath = stageFilePath(workspaceDir, stage);
    const stageText = await readNormalizedScript(stagePath);
    const sections = extractEpisodeSections(stageText);
    assertEpisodeNumbers(sections, stage.episodes, "故事阶段“" + stage.name + "”");
    stageSections.push(...sections);
  }
  const issues = [];
  const validateExecution = await shouldValidateStageExecution(workspaceDir, "full_generate");
  if (validateExecution) {
    issues.push(...await stageExecutionSpecIssues(workspaceDir, "full_generate", userInput));
    issues.push(...await stageExecutionStrategyIssues(workspaceDir, "full_generate", userInput));
  }
  if (!fullText.trimStart().startsWith(fullScriptHeading(outline))) issues.push("剧本全稿缺少正确的文档标题");
  const expected = entries.map((entry) => entry.episode);
  const actual = fullSections.map((section) => section.episode);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push(`剧本全稿必须且只能包含第 ${expected.join("、")} 集`);
  if (!fullRevision) {
    const trialText = await readNormalizedScript(path.join(workspaceDir, "output/剧本试稿.md"));
    const trialSections = extractEpisodeSections(trialText);
    const trialExpected = entries.slice(0, covered).map((entry) => entry.episode);
    const trialActual = trialSections.map((section) => section.episode);
    if (JSON.stringify(trialActual) !== JSON.stringify(trialExpected)) issues.push("剧本试稿范围与大纲不一致");
    for (let index = 0; index < Math.min(covered, fullSections.length, trialSections.length); index += 1) {
      const entry = entries[index];
      if (
        normalizeOptionalTargetDialogue(normalizeEpisodeSectionHeading(fullSections[index], entry))
        !== normalizeOptionalTargetDialogue(normalizeEpisodeSectionHeading(trialSections[index], entry))
      ) {
        issues.push(`第 ${trialSections[index].episode} 集不得改写已通过的剧本试稿内容`);
      }
    }
    const expectedFull = renderFullScript(
      [...trialSections, ...stageSections].sort((left, right) => left.episode - right.episode),
      outline
    );
    if (normalizeOptionalTargetDialogue(fullText) !== normalizeOptionalTargetDialogue(expectedFull)) {
      issues.push("剧本全稿与试稿或阶段文件不一致；请只修订源文件后重新合并。");
    }
  }
  fullSections.forEach((section) => checkEpisode(section, issues));
  const shortEpisodes = underLengthEpisodes(fullSections, lengthContract.minimum_episode_characters);
  if (shortEpisodes.length) issues.push(underLengthIssue(shortEpisodes, lengthContract.minimum_episode_characters));
  if (issues.length) return { ok: false, issues, format_repairs: formatRepairs };
  const nextSkill = userInput.project?.requires_translation === false ? "foreign_review" : "dialogue_translate";
  await updateProgress({
    workspace: workspaceDir,
    stage: "full_generate",
    status: "completed",
    updatedBy,
    nextSkill,
    outputFiles: [fullRelativePath]
  });
  return {
    ok: true,
    output_file: path.join(workspaceDir, fullRelativePath),
    episode_range: [expected[0], expected.at(-1)],
    format_repairs: formatRepairs,
    next_skill: nextSkill,
    quality_check: {
      passed: true,
      principle_review_criteria: (validateExecution
        ? (await loadStageExecutionStrategy(workspaceDir, "full_generate")).snapshot?.principles
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
    const result = await checkFull(args.workspace, args.updatedBy);
    if (!result.ok) {
      const text = result.issues.join("\n");
      const nextAction = /执行策略/u.test(text)
        ? "先重新调用执行策略并阅读新文件，再重新检查。"
        : /执行规范|项目信息|用户要求或偏好/u.test(text)
          ? "先重新调用初始化剧本全稿并阅读新执行规范，再重新生成执行策略。"
          : "只修复返回问题命中的完整剧本或阶段文件，再重新合并并检查。";
      process.stderr.write(`${JSON.stringify({ ...result, stage: "full_generate", tool: "check", next_action: nextAction }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "剧本全稿已通过检查。", next_action: `可以执行 ${result.next_skill}。` }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "full_generate", tool: "check", message: error.message, next_action: "检查完整剧本、剧本大纲及当前生成模式后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
