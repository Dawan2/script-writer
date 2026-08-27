import fs from "node:fs/promises";
import path from "node:path";

const STATIC_STAGE_OUTPUTS = {
  novel_analysis: [
    "2.1-novel-analysis.json",
    "runtime/novel-source-index.json"
  ],
  world_view: [
    "2.1-world-view.json"
  ],
  outline_rewrite: [
    "3.1-outline.json",
    "output/剧本大纲.md"
  ],
  character_rewrite: [
    "4.1-character.json",
    "output/角色小传.md"
  ],
  trial_generate: [
    "output/剧本试稿.md"
  ],
  full_generate: [
    "output/剧本全稿.md",
    "tmp/全稿分阶段"
  ],
  dialogue_translate: [
    "output/台词译稿.md",
    "runtime/dialogue-translate"
  ],
  foreign_review: [
    "review-scorecard.json",
    "output/审稿报告.md",
    "runtime/review-scoring.json",
    "runtime/review-source-index.json",
    "runtime/review-coverage.json",
    "runtime/review-ledger.json"
  ],
  humanizer_zh: [
    "output/去AI味剧本.md"
  ]
};

const NAMED_OUTPUT_SUFFIXES = {
  outline_rewrite: "故事梗概",
  full_generate: "剧本全稿",
  dialogue_translate: "台词译稿"
};

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function removePath(workspace, relativePath, removed) {
  const target = path.resolve(workspace, relativePath);
  if (!isWithin(workspace, target)) throw new Error(`不允许清理工作区外的文件：${relativePath}`);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return;
  await fs.rm(target, { recursive: stat.isDirectory(), force: true });
  removed.push(path.relative(workspace, target));
}

async function namedStageOutputs(workspace, suffix) {
  const outputDir = path.join(workspace, "output");
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(`-${suffix}.md`))
    .map((entry) => path.join("output", entry.name));
}

async function dialogueUnitOutputs(workspace) {
  const entries = await fs.readdir(workspace, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /^7\.1-lines-\d+\.json$/u.test(entry.name))
    .map((entry) => entry.name);
}

/**
 * Remove only the current stage's generated artifacts before a clean rerun.
 * The API runner snapshots protected delivery files before this helper is called.
 */
export async function resetStageOutput(workspacePath, stage) {
  const workspace = path.resolve(workspacePath);
  const staticOutputs = STATIC_STAGE_OUTPUTS[stage];
  if (!staticOutputs) throw new Error(`不支持清理的阶段：${stage}`);

  const dynamicOutputs = [
    ...(NAMED_OUTPUT_SUFFIXES[stage] ? await namedStageOutputs(workspace, NAMED_OUTPUT_SUFFIXES[stage]) : []),
    ...(stage === "dialogue_translate" ? await dialogueUnitOutputs(workspace) : [])
  ];
  const removed = [];
  for (const relativePath of new Set([...staticOutputs, ...dynamicOutputs])) {
    await removePath(workspace, relativePath, removed);
  }
  return { stage, removed };
}
