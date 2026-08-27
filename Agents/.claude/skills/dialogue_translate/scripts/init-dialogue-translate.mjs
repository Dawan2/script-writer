#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete, resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";
import { resolveRegionRules } from "../../../tools/get-region-rules.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import {
  MANIFEST_RELATIVE_PATH,
  buildTranslationUnits,
  extractEpisodeTitles,
  extractDialogueSource,
  hashText,
  normalizeEpisodeHeadingsForOutline,
  readOptionalJson,
  sourceAndOutputPaths,
  writeJson
} from "./dialogue-translate-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

function existingTargets(extracted) {
  return new Map(extracted.dialogues
    .map((line) => [line.id, line.existing_target])
    .filter(([, value]) => value && !String(value).includes("{{ORCA_DIALOGUE_TRANSLATION:")));
}

function applyExistingTargets(units, targets) {
  units.forEach((unit) => unit["剧集"].forEach((episode) => episode["台词"].forEach((line) => {
    const target = targets.get(line["台词ID"]);
    if (target) {
      line["原目标语台词"] = target;
      line["目标语台词"] = target;
    }
  })));
}

export async function initializeDialogueTranslation(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [progress, userInput, outline, worldViewFile, novelAnalysis, characters] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    readOptionalJson(path.join(workspaceDir, "3.1-outline.json")),
    readOptionalJson(path.join(workspaceDir, "2.1-world-view.json")),
    readOptionalJson(path.join(workspaceDir, "2.1-novel-analysis.json")),
    readOptionalJson(path.join(workspaceDir, "4.1-character.json"))
  ]);
  assertDistributionBriefComplete(userInput.project);
  const paths = sourceAndOutputPaths(workspaceDir, userInput, outline);
  if (["rewrite", "novel", "replicate"].includes(paths.taskType) && progress.stages?.full_generate?.status !== "completed") {
    throw new Error("full_generate 尚未完成");
  }
  if (paths.taskType === "review") throw new Error("剧本审核场景不执行台词翻译");
  if (progress.stages?.project_init?.status !== "completed") throw new Error("project_init 尚未完成");
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "dialogue_translate");
  const sourceText = await fs.readFile(paths.sourcePath, "utf8").catch(() => "");
  if (!sourceText.trim()) throw new Error(`待翻译剧本不存在或为空：${paths.sourceRelativePath}`);
  const sourceExtraction = extractDialogueSource(
    normalizeEpisodeHeadingsForOutline(sourceText, outline),
    { existingTargetMode: "existing-english" }
  );
  if (!sourceExtraction.dialogues.length) throw new Error("待翻译剧本中未识别到“人物：台词”格式的中文台词");

  const [currentOutput, previousManifest] = await Promise.all([
    fs.readFile(paths.outputPath, "utf8").catch(() => ""),
    readOptionalJson(path.join(workspaceDir, MANIFEST_RELATIVE_PATH))
  ]);
  const priorTargets = currentOutput.trim() ? existingTargets(extractDialogueSource(currentOutput)) : new Map();
  sourceExtraction.dialogues.forEach((line) => {
    if (!line.existing_target && priorTargets.has(line.id)) line.existing_target = priorTargets.get(line.id);
  });
  const region = await resolveRegionRules(userInput.project.target_region);
  const targetLocale = String(userInput.project.distribution_brief?.target_locale || userInput.project.target_language || region.default_locale).trim();
  const worldView = paths.taskType === "novel" ? novelAnalysis?.["世界观"] : worldViewFile;
  const synopsis = typeof outline?.["故事梗概"] === "string" ? outline["故事梗概"].trim() : "";
  const units = buildTranslationUnits({
    dialogues: sourceExtraction.dialogues,
    outline,
    characters: Array.isArray(characters) ? characters : [],
    synopsis,
    worldView: typeof worldView?.["世界观描述"] === "string" ? worldView["世界观描述"] : "",
    regionRules: region.rules,
    targetLocale,
    episodeTitles: extractEpisodeTitles(sourceExtraction.template)
  });
  applyExistingTargets(units, priorTargets);
  const staleUnitFiles = (await fs.readdir(workspaceDir)).filter((name) => /^7\.1-lines-\d+\.json$/u.test(name));
  await Promise.all(staleUnitFiles.map((name) => fs.rm(path.join(workspaceDir, name), { force: true })));
  const unitFiles = units.map((_unit, index) => `7.1-lines-${String(index + 1).padStart(3, "0")}.json`);
  const storySynopsis = synopsis ? {
    source_file: "3.1-outline.json",
    source_hash: hashText(synopsis),
    unit_file: unitFiles[0],
    translated_text: ""
  } : null;
  const previousSynopsis = previousManifest?.story_synopsis;
  if (
    storySynopsis
    && previousSynopsis?.source_hash === storySynopsis.source_hash
    && typeof previousSynopsis.translated_text === "string"
  ) {
    units[0]["英文简介"] = previousSynopsis.translated_text;
    storySynopsis.translated_text = previousSynopsis.translated_text;
  }
  await Promise.all(units.map((unit, index) => writeJson(path.join(workspaceDir, unitFiles[index]), unit)));

  const templateRelativePath = "runtime/dialogue-translate/template.md";
  await fs.mkdir(path.dirname(path.join(workspaceDir, templateRelativePath)), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, templateRelativePath), sourceExtraction.template, "utf8");
  await fs.mkdir(path.dirname(paths.outputPath), { recursive: true });
  await fs.writeFile(paths.outputPath, sourceExtraction.template, "utf8");
  await writeJson(path.join(workspaceDir, MANIFEST_RELATIVE_PATH), {
    schema_version: "1.1.0",
    source_file: paths.sourceRelativePath,
    source_hash: hashText(sourceText),
    template_file: templateRelativePath,
    output_file: paths.outputRelativePath,
    output_heading: paths.heading,
    target_locale: targetLocale,
    dialogue_count: sourceExtraction.dialogues.length,
    unit_files: unitFiles,
    source_dialogues: sourceExtraction.dialogues.map(({ existing_target: _ignored, ...line }) => line),
    source_episode_titles: Object.fromEntries(extractEpisodeTitles(sourceExtraction.template)),
    ...(storySynopsis ? { story_synopsis: storySynopsis } : {})
  });
  await updateProgress({
    workspace: workspaceDir,
    stage: "dialogue_translate",
    status: "in_progress",
    updatedBy,
    outputFiles: [paths.outputRelativePath]
  });
  return {
    workspace_dir: workspaceDir,
    source_file: paths.sourcePath,
    output_file: paths.outputPath,
    unit_files: unitFiles.map((file) => path.join(workspaceDir, file)),
    target_locale: targetLocale,
    maturity_target: resolveMaturityTarget(userInput.project.distribution_brief),
    dialogue_count: sourceExtraction.dialogues.length,
    ...(storySynopsis ? {
      story_synopsis: synopsis,
      synopsis_unit_file: path.join(workspaceDir, storySynopsis.unit_file)
    } : {}),
    max_parallel_units: 3
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeDialogueTranslation(args.workspace, args.updatedBy);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "台词译稿与翻译单元已初始化。", next_action: result.story_synopsis ? "先在指定单元填写英文简介，再按单元填写目标语台词；一次最多并行处理 3 个单元。" : "按单元填写目标语台词；一次最多并行处理 3 个单元。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "dialogue_translate", tool: "init", message: error.message, next_action: "检查待翻译剧本、目标地区和项目进度后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
