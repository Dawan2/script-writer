#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkNovelAnalysis } from "./check-novel-analysis.mjs";
import { ANALYSIS_RELATIVE_PATH, isPlainObject } from "./novel-analysis-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workspaceRoot = path.join(agentRoot, "workspaces");

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") {
    throw new Error("请使用 --workspace <项目目录>");
  }
  const workspace = path.resolve(agentRoot, argv[1]);
  if (!isInside(workspaceRoot, workspace)) throw new Error("项目目录必须位于 workspaces/ 下");
  return workspace;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function applyNovelAnalysisRecommendations(analysis) {
  if (!isPlainObject(analysis) || !Array.isArray(analysis["剧情单元"])) {
    throw new Error("小说解读缺少有效的剧情单元");
  }

  const recommendationCounts = { retain: 0, delete: 0, merge: 0 };
  let newlyConfirmedMergeCount = 0;
  const acceptedUnits = [];

  for (const unit of analysis["剧情单元"]) {
    if (!isPlainObject(unit)) throw new Error("小说解读包含无效的剧情单元");
    const recommendation = unit["改编建议"];
    if (recommendation === "删除") {
      recommendationCounts.delete += 1;
      continue;
    }
    if (recommendation === "合并") {
      recommendationCounts.merge += 1;
      if (unit["已确认合并"] === true) acceptedUnits.push(unit);
      else {
        acceptedUnits.push({ ...unit, "已确认合并": true });
        newlyConfirmedMergeCount += 1;
      }
      continue;
    }
    if (recommendation === "保留") {
      recommendationCounts.retain += 1;
      acceptedUnits.push(unit);
      continue;
    }
    throw new Error("小说解读包含无效的改编建议");
  }

  const deletedUnitCount = recommendationCounts.delete;
  if (!acceptedUnits.length) throw new Error("自动接纳后至少需要保留一个剧情单元");
  return {
    analysis: {
      ...analysis,
      "剧情单元": acceptedUnits
    },
    recommendation_counts: recommendationCounts,
    deleted_unit_count: deletedUnitCount,
    merged_unit_count: recommendationCounts.merge,
    newly_confirmed_merge_count: newlyConfirmedMergeCount,
    remaining_unit_count: acceptedUnits.length,
    changed: deletedUnitCount > 0 || newlyConfirmedMergeCount > 0
  };
}

export async function acceptNovelAnalysisRecommendations(workspace) {
  const workspaceDir = path.resolve(workspace);
  const validation = await checkNovelAnalysis(workspaceDir, "batch", { validateOnly: true });
  if (!validation.ok) {
    throw new Error(`小说解读尚未通过检查，不能自动接纳建议：${validation.issues.join("；")}`);
  }

  const analysisPath = path.join(workspaceDir, ANALYSIS_RELATIVE_PATH);
  let analysis;
  try {
    analysis = JSON.parse(await fs.readFile(analysisPath, "utf8"));
  } catch {
    throw new Error("小说解读不存在或不是有效 JSON");
  }
  const result = applyNovelAnalysisRecommendations(analysis);
  if (result.changed) await writeJsonAtomically(analysisPath, result.analysis);
  const { analysis: _analysis, ...summary } = result;

  return {
    ok: true,
    message: summary.changed
      ? `已自动接纳剧情单元建议：删除 ${summary.deleted_unit_count} 个，合并 ${summary.newly_confirmed_merge_count} 个。`
      : "剧情单元建议已完成自动接纳。",
    next_action: "继续执行故事梗概阶段。",
    ...summary
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = parseArgs(process.argv.slice(2));
    const result = await acceptNovelAnalysisRecommendations(workspace);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      tool: "accept-novel-analysis-recommendations",
      message: error.message,
      next_action: "先修复小说解读检查问题，再重新执行批量任务。"
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
