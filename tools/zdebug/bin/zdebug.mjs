#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.mjs";
import { runWithClaude } from "../src/run.mjs";

function readOption(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

function hasFlag(args, ...names) {
  return names.some((name) => args.includes(name));
}

async function readUserInputFile(args) {
  const inputPath = readOption(args, "--user-input-file");
  if (!inputPath) return undefined;
  try {
    return await fs.readFile(inputPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read user input file: ${inputPath}`, { cause: error });
  }
}

function showHelp() {
  console.log(`
zdebug

Usage:
  zdebug --serve --port 4301 --project /path/to/project
  zdebug --serve --log-dir ~/.claude/projects/-path-to-project
  zdebug --run-with -p "prompt" --output-format stream-json --verbose

Options:
  --serve, --log, -l    Start the web log viewer
  --run-with            Run Claude through ZDebug and tee live logs
  --pipe-stdin          Pipe ZDebug stdin into the wrapped process
  --user-input-file <path>  Persist the launcher task from a file instead of an environment variable
  --claude-path <path>  Claude executable or cli.js used by --run-with
  --project <path>      Project directory used to resolve Claude logs
  --log-dir <path>      Read logs directly from a directory
  --log-manifest <path> Read only the explicitly listed task logs
  --runtime-log <path>  Read the current ZDebug runtime jsonl file
  --runtime-name <name> Display name for the runtime log
  --session-id <id>     Preferred session id for the runtime log
  --selected-log-id <id> Preferred manifest log id
  --port <number>       Port, defaults to 4301
  --host <host>         Host, defaults to 127.0.0.1
  --help, -h            Show help
`.trim());
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help", "-h")) {
    showHelp();
    return;
  }

  const runWithIndex = args.indexOf("--run-with");
  if (runWithIndex !== -1) {
    const wrapperArgs = args.slice(0, runWithIndex);
    const exitCode = await runWithClaude({
      claudePath: readOption(wrapperArgs, "--claude-path"),
      args: args.slice(runWithIndex + 1),
      logPath: readOption(wrapperArgs, "--runtime-log"),
      pipeStdin: hasFlag(wrapperArgs, "--pipe-stdin"),
      userInput: await readUserInputFile(wrapperArgs),
    });
    process.exit(exitCode);
  }

  if (!hasFlag(args, "--serve", "--log", "-l")) {
    showHelp();
    process.exitCode = 1;
    return;
  }

  const thisFile = fileURLToPath(import.meta.url);
  const toolRoot = path.resolve(path.dirname(thisFile), "..");
  const port = Number(readOption(args, "--port", "4301"));
  const host = readOption(args, "--host", "127.0.0.1");
  const projectDir = readOption(args, "--project", process.cwd());
  const logDir = readOption(args, "--log-dir");
  const logManifest = readOption(args, "--log-manifest");
  const runtimeLog = readOption(args, "--runtime-log");
  const runtimeName = readOption(args, "--runtime-name");
  const sessionId = readOption(args, "--session-id");
  const selectedLogId = readOption(args, "--selected-log-id");

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid port: ${readOption(args, "--port")}`);
  }

  await startServer({
    host,
    port,
    projectDir,
    logDir,
    logManifest,
    runtimeLog,
    runtimeName,
    sessionId,
    selectedLogId,
    toolRoot,
  });

  console.log("zdebug Web server started");
  console.log(`Project: ${path.resolve(projectDir)}`);
  if (logDir) console.log(`Log dir: ${path.resolve(logDir)}`);
  if (logManifest) console.log(`Log manifest: ${path.resolve(logManifest)}`);
  console.log(`Open: http://${host}:${port}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
