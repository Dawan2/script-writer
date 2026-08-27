#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveNovelOutlinePlan } from "../skills/novel_analysis/scripts/novel-analysis-utils.mjs";
import { resolveMaturityTarget } from "./distribution-brief.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const REPLICATION_REPORT_PATH = "output/爆款分析报告.md";
const WORLD_VIEW_REDO_STEP = "重新执行“世界观”这一步，产出世界观后再继续。";

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  const workspace = path.resolve(agentRoot, argv[1]);
  const relative = path.relative(workspaceRoot, workspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("项目目录必须位于 workspaces/ 下");
  return workspace;
}

async function readJson(filePath, label, redoStep) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    const error = new Error(`读不到${label}，内容缺失或已损坏，改编无法在此基础上继续。`);
    error.nextAction = redoStep;
    throw error;
  }
}

function confirmedNovelUnit(unit, unitsById) {
  if (!unit || typeof unit !== "object" || Array.isArray(unit)) throw new Error("小说解读包含无效的剧情单元");
  const unitId = typeof unit["单元ID"] === "string" ? unit["单元ID"].trim() : "";
  const facts = {
    "单元ID": unitId,
    "单元名称": unit["单元名称"],
    "单元梗概": unit["单元梗概"],
    "主线推进": unit["主线推进"],
    "关键人物": unit["关键人物"],
    "关键信息": unit["关键信息"],
    "高光时刻": unit["高光时刻"]
  };
  if (unit["已确认合并"] !== true) return facts;

  const targetId = typeof unit["合并目标单元ID"] === "string" ? unit["合并目标单元ID"].trim() : "";
  const reason = typeof unit["建议原因"] === "string" ? unit["建议原因"].trim() : "";
  const targetUnit = unitsById.get(targetId);
  if (unit["改编建议"] !== "合并" || !unitId || !targetId || targetId === unitId || !targetUnit || targetUnit["已确认合并"] === true || !reason) {
    throw new Error(`小说解读中已确认合并的剧情单元无效：${unitId || "未命名单元"}`);
  }
  return {
    ...facts,
    "改编建议": "合并",
    "合并目标单元ID": targetId,
    "已确认合并": true,
    "建议原因": reason
  };
}

function novelAnalysisForAdaptation(analysis) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) throw new Error("小说解读必须是对象");
  const units = analysis["剧情单元"];
  if (!Array.isArray(units)) throw new Error("小说解读缺少剧情单元");
  const unitsById = new Map();
  units.forEach((unit) => {
    const unitId = typeof unit?.["单元ID"] === "string" ? unit["单元ID"].trim() : "";
    if (!unitId || unitsById.has(unitId)) throw new Error("小说解读包含无效或重复的剧情单元ID");
    unitsById.set(unitId, unit);
  });

  // 只有用户确认的合并处理进入下游上下文。
  return {
    "基础信息": analysis["基础信息"],
    "核心卖点": analysis["核心卖点"],
    "故事主线": analysis["故事主线"],
    "世界观": analysis["世界观"],
    "关键人物": analysis["关键人物"],
    "剧情单元": units.map((unit) => confirmedNovelUnit(unit, unitsById))
  };
}

export async function getAdaptationContext(workspace) {
  const userInput = await readJson(path.join(workspace, "1.1-user-input.json"), "项目信息", "重新创建项目或补全项目信息后重试。");
  const taskType = userInput.project?.task_type || "rewrite";
  const maturityTarget = resolveMaturityTarget(userInput.project?.distribution_brief);
  if (taskType === "novel") {
    const analysis = await readJson(path.join(workspace, "2.1-novel-analysis.json"), "小说解读", "重新执行“小说解读”这一步，产出小说解读后再继续。");
    const adaptationAnalysis = novelAnalysisForAdaptation(analysis);
    const worldDescription = adaptationAnalysis["世界观"];
    if (typeof worldDescription !== "string" || !worldDescription.trim()) throw new Error("小说解读缺少世界观");
    return {
      task_type: taskType,
      source_kind: "novel_analysis",
      maturity_target: maturityTarget,
      world_view: { "世界观描述": worldDescription.trim(), "关键概念映射": [] },
      novel_analysis: adaptationAnalysis,
      adaptation_plan: deriveNovelOutlinePlan(userInput.project)
    };
  }
  if (taskType === "replicate") {
    const worldView = await readJson(path.join(workspace, "2.1-world-view.json"), "世界观", WORLD_VIEW_REDO_STEP);
    try {
      await fs.access(path.join(workspace, REPLICATION_REPORT_PATH));
    } catch {
      throw new Error("爆款分析报告不存在");
    }
    return {
      task_type: taskType,
      source_kind: "viral_analysis_report",
      maturity_target: maturityTarget,
      source_file: REPLICATION_REPORT_PATH,
      world_view: worldView
    };
  }
  if (taskType !== "rewrite") throw new Error("当前场景不使用改编上下文");
  const worldView = await readJson(path.join(workspace, "2.1-world-view.json"), "世界观", WORLD_VIEW_REDO_STEP);
  const sourceFile = userInput.project?.source_script?.output_path;
  if (typeof sourceFile !== "string" || !sourceFile.trim()) throw new Error("项目输入缺少原始剧本路径");
  return {
    task_type: taskType,
    source_kind: "screenplay",
    maturity_target: maturityTarget,
    source_file: sourceFile,
    world_view: worldView
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = parseArgs(process.argv.slice(2));
    const result = await getAdaptationContext(workspace);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "已读取当前场景的改编上下文。", next_action: result.task_type === "novel" ? "只使用本次返回的小说解读生成故事梗概：未标记已确认合并的单元独立保留；标记已确认合并的单元必须按合并目标融入。adaptation_plan 只约束故事梗概单元容量。" : result.task_type === "replicate" ? "深度阅读 source_file 指向的爆款分析报告；以世界观为新外壳，保留报告中已明确的剧情功能、权力关系和冲突作用，不沿用具体人名、地点或专有设定。" : "以世界观和原始剧本为改写依据。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "get-adaptation-context", message: error.message, next_action: error.nextAction || "检查场景类型和前置阶段文件后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
