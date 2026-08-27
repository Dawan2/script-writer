#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTO_ADAPT_TAG,
  normalizeScriptProfile,
  SCRIPT_PROFILE_FIELDS,
  SCRIPT_PROFILE_LABELS,
  scriptProfileErrors,
  userSelectedScriptProfileFields
} from "./script-profile.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("参数格式无效");
    }
    const name = key.slice(2);
    if (Object.hasOwn(args, name)) throw new Error(`参数 --${name} 不能重复`);
    args[name] = value;
  }
  for (const required of ["workspace", "stage", "updated-by"]) {
    if (!args[required]?.trim()) throw new Error(`缺少 --${required} 参数`);
  }
  return args;
}

function splitValues(value) {
  return [...new Set(String(value || "").split(/[,，]/u).map((item) => item.trim()).filter(Boolean))];
}

function expectedStage(taskType) {
  if (taskType === "novel") return "novel_analysis";
  if (taskType === "rewrite" || taskType === "replicate") return "world_view";
  return "";
}

async function writeJsonAtomic(filePath, value) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function resolveScriptProfile({ workspace, stage, updatedBy = "admin", ...selected }) {
  const workspaceDir = path.resolve(workspace);
  const inputPath = path.join(workspaceDir, "1.1-user-input.json");
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const project = input.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error("项目输入缺少项目资料");
  const requiredStage = expectedStage(project.task_type);
  if (!requiredStage) throw new Error("当前任务场景不需要解析剧本设定");
  if (stage !== requiredStage) {
    throw new Error(`当前任务只能在 ${requiredStage} 阶段解析剧本设定`);
  }

  const brief = project.distribution_brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) throw new Error("发行配置不存在");
  const userSelectedFields = userSelectedScriptProfileFields(brief);
  const current = normalizeScriptProfile(project.task_type, brief, {
    defaultAuto: true,
    allowAuto: true,
    userSelectedFields
  });
  const pending = SCRIPT_PROFILE_FIELDS.filter((kind) => current[kind].includes(AUTO_ADAPT_TAG));
  if (!pending.length) {
    return { workspace_dir: workspaceDir, script_profile: current, resolved_fields: [], preserved_fields: [...SCRIPT_PROFILE_FIELDS] };
  }

  const finalProfile = {};
  SCRIPT_PROFILE_FIELDS.forEach((kind) => {
    if (!pending.includes(kind)) {
      finalProfile[kind] = current[kind];
      return;
    }
    const values = splitValues(selected[kind]);
    if (!values.length) throw new Error(`缺少待解析的${SCRIPT_PROFILE_LABELS[kind]}`);
    finalProfile[kind] = values;
  });
  const errors = scriptProfileErrors(finalProfile, { allowAuto: false, userSelectedFields });
  if (errors.length) throw new Error(errors.join("；"));

  Object.assign(brief, finalProfile);
  brief.inferred_fields = [...new Set([
    ...(Array.isArray(brief.inferred_fields) ? brief.inferred_fields : []),
    ...pending
  ])];
  brief.script_profile_resolution = {
    stage,
    resolved_fields: pending,
    resolved_at: new Date().toISOString(),
    resolved_by: updatedBy
  };
  project.distribution_brief = brief;
  input.project = project;
  input.audit = {
    ...(input.audit && typeof input.audit === "object" && !Array.isArray(input.audit) ? input.audit : {}),
    updated_at: brief.script_profile_resolution.resolved_at,
    updated_by: updatedBy
  };
  await writeJsonAtomic(inputPath, input);
  return {
    workspace_dir: workspaceDir,
    script_profile: finalProfile,
    resolved_fields: pending,
    preserved_fields: SCRIPT_PROFILE_FIELDS.filter((kind) => !pending.includes(kind))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await resolveScriptProfile({
      workspace: path.resolve(agentRoot, args.workspace),
      stage: args.stage,
      updatedBy: args["updated-by"],
      theme: args.theme,
      setting: args.setting,
      background: args.background,
      audience: args.audience
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      message: result.resolved_fields.length ? "剧本设定已确定。" : "剧本设定已是明确选项。",
      next_action: result.resolved_fields.length
        ? "重新调用初始化工具刷新执行规范，再继续当前阶段。"
        : "继续完成当前阶段内容。",
      ...result
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      tool: "resolve-script-profile",
      message: error.message,
      next_action: "根据剧本设定解析原则修正标签后重试。"
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
