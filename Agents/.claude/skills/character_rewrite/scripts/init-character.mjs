#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete, resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { writeStageExecutionSpec } from "../../_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/character.json5");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

function parseTemplate(text) {
  return JSON.parse(text.replace(/\/\/.*$/gmu, ""));
}

function collectRoles(outline) {
  if (!outline || typeof outline !== "object" || Array.isArray(outline) || !Array.isArray(outline["剧情单元"])) {
    throw new Error("3.1-outline.json 缺少剧情单元");
  }
  const names = [];
  const seen = new Set();
  const addNames = (roles) => {
    if (!Array.isArray(roles)) return;
    roles.forEach((role) => {
      const name = typeof role === "string" ? role.trim() : "";
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    });
  };
  addNames(outline["开篇"]?.["关键角色"]);
  if (Array.isArray(outline["开篇"]?.["剧集"])) {
    outline["开篇"]["剧集"].forEach((episode) => addNames(episode?.["关键角色"]));
  }
  outline["剧情单元"].forEach((unit) => {
    addNames(unit?.["关键角色"]);
    if (Array.isArray(unit?.["剧集"])) unit["剧集"].forEach((episode) => addNames(episode?.["关键角色"]));
  });
  if (!names.length) throw new Error("3.1-outline.json 未提取到关键角色");
  return names;
}

function createCharacter(template, name) {
  return Object.fromEntries(Object.entries(template).map(([key, value]) => {
    if (key === "人物名称") return [key, name];
    if (typeof value === "boolean") return [key, false];
    return [key, Array.isArray(value) ? [] : ""];
  }));
}

export async function initializeCharacter(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [progress, userInput, outline, template] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8").then(JSON.parse),
    fs.readFile(templatePath, "utf8").then(parseTemplate)
  ]);
  assertDistributionBriefComplete(userInput.project);
  if (progress.stages?.outline_rewrite?.status !== "completed") {
    throw new Error("outline_rewrite 尚未完成");
  }
  if (!Array.isArray(template) || !template[0] || typeof template[0] !== "object") {
    throw new Error("character.json5 缺少角色模板");
  }
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "character_rewrite");
  const names = collectRoles(outline);
  const outputPath = path.join(workspaceDir, "4.1-character.json");
  const existing = await fs.readFile(outputPath, "utf8").catch(() => "");
  if (!existing.trim()) {
    await fs.writeFile(outputPath, `${JSON.stringify(names.map((name) => createCharacter(template[0], name)), null, 2)}\n`, "utf8");
  } else {
    JSON.parse(existing);
  }
  await updateProgress({
    workspace: workspaceDir,
    stage: "character_rewrite",
    status: "in_progress",
    updatedBy,
    outputFiles: ["4.1-character.json", "output/角色小传.md"]
  });
  const executionSpec = await writeStageExecutionSpec({
    workspace: workspaceDir,
    stage: "character_rewrite",
    userInput,
    outputFile: "4.1-character.json",
    options: { jobId: process.env.ORCA_AGENT_JOB_ID }
  });
  return {
    workspace_dir: workspaceDir,
    character_file: outputPath,
    character_names: names,
    maturity_target: resolveMaturityTarget(userInput.project.distribution_brief),
    execution_spec_directory: executionSpec.paths.directory,
    execution_spec_file: executionSpec.paths.markdown
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeCharacter(args.workspace, args.updatedBy);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, message: `角色小传已初始化完成，请先阅读\`${result.execution_spec_file}\`，再按照 Skill 要求执行下一步。`, next_action: "请按照 Skill 步骤，继续执行下一步" }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "character_rewrite", tool: "init", message: error.message, next_action: "修复剧本大纲或项目进度后重新初始化。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
