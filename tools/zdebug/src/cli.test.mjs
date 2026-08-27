import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const zdebugEntrypoint = path.resolve(sourceDirectory, "../bin/zdebug.mjs");

test("user input file is logged without placing the task body in Claude arguments", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zdebug-user-input-"));
  try {
    const taskFile = path.join(temporaryDirectory, "task.md");
    const runtimeLog = path.join(temporaryDirectory, "runtime.jsonl");
    const fakeClaude = path.join(temporaryDirectory, "fake-claude.mjs");
    const taskBody = `小说资料\n${"关键剧情。".repeat(20_000)}`;
    await fs.writeFile(taskFile, taskBody, "utf8");
    await fs.writeFile(
      fakeClaude,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { console.log(JSON.stringify({ type: 'result', result: input.trim() })); });",
      ].join("\n"),
      "utf8",
    );

    const output = execFileSync(
      process.execPath,
      [
        zdebugEntrypoint,
        "--runtime-log", runtimeLog,
        "--user-input-file", taskFile,
        "--pipe-stdin",
        "--claude-path", fakeClaude,
        "--run-with",
        "-p",
        "--output-format", "stream-json",
      ],
      { encoding: "utf8", input: "请读取任务资料文件。\n" },
    );

    const result = JSON.parse(output.trim());
    const entries = (await fs.readFile(runtimeLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const start = entries.find((entry) => entry.type === "zdebug_start");
    const userInput = entries.find((entry) => entry.type === "user");

    assert.equal(result.result, "请读取任务资料文件。");
    assert.deepEqual(userInput.message.content, [{ type: "text", text: taskBody }]);
    assert.equal(start.args.includes(taskBody), false);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
