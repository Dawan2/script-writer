#!/usr/bin/env node

/**
 * 停止当前仓库启动的运行进程，或重启前台界面。
 *
 * 用法：
 *   node tools/stop-project.mjs frontend  # 仅停止前台界面
 *   node tools/stop-project.mjs frontend --restart  # 重启前台界面
 *   node tools/stop-project.mjs claude    # 仅停止 Claude Code 任务
 *   node tools/stop-project.mjs all       # 停止前台、Claude 任务和 API
 *
 * 加上 --dry-run 可先查看将执行的操作，不会实际发送信号或启动服务。
 */

import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(REPO_ROOT, "Agents");
const VALID_SCOPES = new Set(["frontend", "claude", "all"]);
const GRACE_PERIOD_MS = 3_000;
const FORCE_STOP_GRACE_PERIOD_MS = 500;

function printUsage() {
  console.log(`用法：
  node tools/stop-project.mjs frontend  # 仅停止前台界面
  node tools/stop-project.mjs frontend --restart  # 重启前台界面
  node tools/stop-project.mjs claude    # 仅停止 Claude Code 任务
  node tools/stop-project.mjs all       # 停止前台、Claude 任务和 API

可选参数：
  --restart  停止后重新启动前台界面，仅可与 frontend 一起使用
  --dry-run  仅显示将执行的操作，不实际停止或启动`);
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function listProcesses() {
  return commandOutput("ps", ["-axo", "pid=,ppid=,command="])
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

function isInside(directory, parentDirectory) {
  const relative = path.relative(parentDirectory, directory);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function processCwd(pid, cache) {
  if (cache.has(pid)) return cache.get(pid);
  const output = commandOutput("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwd = output.split("\n").find((line) => line.startsWith("n"))?.slice(1) || "";
  cache.set(pid, cwd);
  return cwd;
}

function isProjectProcess(process, cwdCache) {
  const cwd = processCwd(process.pid, cwdCache);
  return Boolean(cwd) && isInside(cwd, REPO_ROOT);
}

function processMap(processes) {
  return new Map(processes.map((process) => [process.pid, process]));
}

function ancestorChain(process, byPid) {
  const chain = [];
  const visited = new Set();
  let current = process;
  while (current && !visited.has(current.pid)) {
    chain.push(current);
    visited.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return chain;
}

function listenerPids(port) {
  return commandOutput("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function descendants(rootPid, processes) {
  const children = new Map();
  for (const process of processes) {
    const group = children.get(process.ppid) || [];
    group.push(process.pid);
    children.set(process.ppid, group);
  }

  const result = new Set();
  const pending = [rootPid];
  while (pending.length) {
    const pid = pending.pop();
    if (result.has(pid)) continue;
    result.add(pid);
    pending.push(...(children.get(pid) || []));
  }
  return result;
}

function addTarget(targets, label, rootProcess, processes) {
  if (!rootProcess || rootProcess.pid === process.pid) return;
  const pids = descendants(rootProcess.pid, processes);
  const existing = targets.get(label) || new Set();
  for (const pid of pids) {
    if (pid !== process.pid) existing.add(pid);
  }
  targets.set(label, existing);
}

function findFrontendTargets(processes, cwdCache, targets, { includeDebug = true } = {}) {
  let launchMode = "development";
  const byPid = processMap(processes);
  for (const pid of listenerPids(3000)) {
    const listener = byPid.get(pid);
    if (!listener || !isProjectProcess(listener, cwdCache)) continue;
    const chain = ancestorChain(listener, byPid);
    const nextLauncher = chain.find((item) => /\bnext\s+(?:dev|start)\b/.test(item.command));
    if (nextLauncher && /\bnext\s+start\b/.test(nextLauncher.command)) launchMode = "production";
    addTarget(targets, "前台界面", nextLauncher || listener, processes);
  }

  if (includeDebug) {
    for (const item of processes) {
      if (!item.command.includes("tools/zdebug/bin/zdebug.mjs") || !item.command.includes("--serve")) continue;
      if (isProjectProcess(item, cwdCache)) addTarget(targets, "调试界面", item, processes);
    }
  }
  return launchMode;
}

function isManagedClaudeTask(item, cwdCache) {
  const command = item.command;
  const isClaude = /(?:^|\s|\/)claude(?:\s|$)/.test(command)
    || command.includes("@anthropic-ai/claude-code");
  const isNonInteractive = command.includes("--output-format")
    || /(?:^|\s)--print(?:\s|$)/.test(command)
    || /(?:^|\s)-p(?:\s|$)/.test(command);
  return isClaude && isNonInteractive && isInside(processCwd(item.pid, cwdCache), AGENTS_DIR);
}

function findClaudeTargets(processes, cwdCache, targets) {
  for (const item of processes) {
    if (isManagedClaudeTask(item, cwdCache)) addTarget(targets, "Claude Code 任务", item, processes);
  }
}

function findApiTargets(processes, cwdCache, targets) {
  const byPid = processMap(processes);
  for (const pid of listenerPids(8000)) {
    const listener = byPid.get(pid);
    if (!listener || !isProjectProcess(listener, cwdCache)) continue;
    const uvicornProcesses = ancestorChain(listener, byPid)
      .filter((item) => /(?:^|\s)uvicorn(?:\s|$)/.test(item.command) && isProjectProcess(item, cwdCache));
    addTarget(targets, "API 服务", uvicornProcesses.at(-1) || listener, processes);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopTargets(targets) {
  const pids = [...new Set([...targets.values()].flatMap((items) => [...items]))];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 进程可能已自行结束，无需报错。
    }
  }

  await sleep(GRACE_PERIOD_MS);
  const remainingAfterTerm = pids.filter(processExists);
  for (const pid of remainingAfterTerm) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能在宽限期内已结束。
    }
  }
  await sleep(FORCE_STOP_GRACE_PERIOD_MS);
  const failed = remainingAfterTerm.filter(processExists);
  return {
    stopped: pids.length - remainingAfterTerm.length,
    forced: remainingAfterTerm.length - failed.length,
    failed,
  };
}

function frontendStartScript(launchMode) {
  return launchMode === "production" ? "start:web" : "dev:web";
}

async function startFrontend(launchMode) {
  const script = frontendStartScript(launchMode);
  console.log(`正在启动前台界面：npm run ${script}`);

  const result = await new Promise((resolve) => {
    const child = spawn("npm", ["run", script], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.error) {
    console.error(`前台界面启动失败：${result.error.message}`);
    process.exitCode = 1;
  } else if (result.code !== 0) {
    console.error(`前台界面已退出${result.signal ? `（${result.signal}）` : `，退出码 ${result.code}`}。`);
    process.exitCode = result.code || 1;
  }
}

async function main() {
  const [scope, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const restart = flags.includes("--restart");
  const validFlags = new Set(["--dry-run", "--restart"]);
  if (
    !VALID_SCOPES.has(scope)
    || flags.some((flag) => !validFlags.has(flag))
    || new Set(flags).size !== flags.length
    || (restart && scope !== "frontend")
  ) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const processes = listProcesses();
  const cwdCache = new Map();
  const targets = new Map();
  const frontendLaunchMode = scope === "frontend" || scope === "all"
    ? findFrontendTargets(processes, cwdCache, targets, { includeDebug: !restart })
    : "development";
  if (scope === "claude" || scope === "all") findClaudeTargets(processes, cwdCache, targets);
  if (scope === "all") findApiTargets(processes, cwdCache, targets);

  const labels = [...targets.entries()].filter(([, pids]) => pids.size > 0);
  if (!labels.length && !restart) {
    console.log("没有发现当前项目中符合条件的运行进程。");
    return;
  }

  for (const [label, pids] of labels) {
    console.log(`${dryRun ? "将停止" : "正在停止"}${label}：${[...pids].sort((a, b) => a - b).join(", ")}`);
  }
  if (dryRun) {
    if (restart) console.log(`将启动前台界面：npm run ${frontendStartScript(frontendLaunchMode)}`);
    return;
  }

  if (labels.length) {
    const result = await stopTargets(targets);
    console.log(`处理完成：已正常停止 ${result.stopped} 个进程${result.forced ? `，强制停止 ${result.forced} 个进程` : ""}。`);
    if (result.failed.length) {
      console.error(`以下进程仍未退出，未启动前台界面：${result.failed.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!restart) return;

  const occupiedPids = listenerPids(3000);
  if (occupiedPids.length) {
    console.error(`端口 3000 仍被占用，未启动前台界面：${occupiedPids.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  await startFrontend(frontendLaunchMode);
}

await main();
