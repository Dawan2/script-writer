#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MANIFEST_RELATIVE_PATH,
  readManifestUnits,
  readTranslationManifest,
  renderTranslatedScript,
  validateSynopsisTranslation,
  validateTranslationUnits,
  writeJson
} from "./dialogue-translate-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  return path.resolve(agentRoot, argv[1]);
}

export async function mergeDialogueTranslation(workspace) {
  const workspaceDir = path.resolve(workspace);
  const manifest = await readTranslationManifest(workspaceDir);
  const units = await readManifestUnits(workspaceDir, manifest);
  const validation = validateTranslationUnits(units, manifest.source_dialogues || [], manifest.source_episode_titles);
  const synopsisValidation = validateSynopsisTranslation(units, manifest.story_synopsis);
  const issues = [...validation.issues, ...synopsisValidation.issues];
  if (issues.length) return { ok: false, issues: [...new Set(issues)] };
  const template = await fs.readFile(path.join(workspaceDir, manifest.template_file), "utf8");
  const output = renderTranslatedScript(template, validation.translations, manifest.output_heading, validation.episodeTitleTranslations);
  const outputPath = path.join(workspaceDir, manifest.output_file);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, output, "utf8");
  if (manifest.story_synopsis) {
    manifest.story_synopsis.translated_text = synopsisValidation.translation;
    await writeJson(path.join(workspaceDir, MANIFEST_RELATIVE_PATH), manifest);
  }
  return {
    ok: true,
    output_file: outputPath,
    dialogue_count: validation.translations.size,
    story_synopsis_translated: Boolean(manifest.story_synopsis)
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await mergeDialogueTranslation(parseArgs(process.argv.slice(2)));
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({ ...result, stage: "dialogue_translate", tool: "merge", next_action: "只修复返回的台词单元后重新合并。" }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "台词翻译已合并为用户译稿。", next_action: "运行台词译稿检查。" }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "dialogue_translate", tool: "merge", message: error.message, next_action: "检查翻译单元和初始化清单后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
