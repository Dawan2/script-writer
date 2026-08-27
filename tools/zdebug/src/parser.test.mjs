import assert from "node:assert/strict";
import test from "node:test";

import { parseEntries } from "./parser.mjs";

test("task preparation is visible before the Agent process starts", () => {
  const steps = parseEntries([
    {
      type: "zdebug_preparation",
      title: "剧本标签已补全",
      message: "已根据原始材料补全剧本标签：主题、设定、受众。",
      timestamp: "2026-08-24T12:00:00Z",
    },
    {
      type: "zdebug_preparation",
      title: "世界观已初始化",
      message: "世界观目录与执行规范已生成。",
      timestamp: "2026-08-24T12:00:01Z",
    },
    { type: "zdebug_start", job_id: "50", timestamp: "2026-08-24T12:00:02Z" },
  ]);

  assert.deepEqual(steps.map((step) => step.title), [
    "剧本标签已补全",
    "世界观已初始化",
    "任务进程已启动",
  ]);
  assert.equal(steps[0].details, "已根据原始材料补全剧本标签：主题、设定、受众。");
});

test("runtime heartbeats stay visible without flooding the timeline", () => {
  const steps = parseEntries([
    { type: "zdebug_start", job_id: "50", timestamp: "2026-07-13T05:50:00Z" },
    { type: "zdebug_heartbeat", age_ms: 15_000, silence_ms: 10_000, timestamp: "2026-07-13T05:50:15Z" },
    { type: "zdebug_heartbeat", age_ms: 30_000, silence_ms: 25_000, timestamp: "2026-07-13T05:50:30Z" },
  ]);

  assert.equal(steps.length, 2);
  assert.equal(steps[0].title, "任务进程已启动");
  assert.equal(steps[0].timestamp, "2026-07-13T05:50:00Z");
  assert.equal(steps[1].title, "AI 正在执行");
  assert.equal(steps[1].timestamp, "2026-07-13T05:50:30Z");
  assert.match(steps[1].details, /距上一条可展示内容 25 秒/);
  assert.match(steps[1].details, /AI 仍在执行/);
  assert.equal(steps.hiddenCount, 1);
});

test("partial AI thinking updates replace the active thought instead of adding timeline rows", () => {
  const steps = parseEntries([
    {
      type: "assistant",
      timestamp: "2026-07-13T05:50:15Z",
      zdebug_partial: true,
      message: { id: "partial-thinking-1-0", role: "assistant", content: [{ type: "thinking", thinking: "正在规划" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-07-13T05:50:20Z",
      zdebug_partial: true,
      message: { id: "partial-thinking-1-0", role: "assistant", content: [{ type: "thinking", thinking: "正在规划交付内容" }] },
    },
  ]);

  assert.equal(steps.length, 1);
  assert.equal(steps[0].title, "AI 思考");
  assert.equal(steps[0].details, "正在规划交付内容");
  assert.equal(steps[0].timestamp, "2026-07-13T05:50:20Z");
});

test("a CLI result is scoped to its operation instead of the whole task", () => {
  const steps = parseEntries([
    {
      type: "zdebug_start",
      job_id: "50",
      session_id: "repair-session",
      operation: "质量修订",
      timestamp: "2026-07-16T08:00:00Z",
    },
    {
      type: "zdebug_runtime_ready",
      session_id: "repair-session",
      claude_code_version: "2.1.204",
      model: "opus",
      timestamp: "2026-07-16T08:00:01Z",
    },
    {
      type: "result",
      session_id: "repair-session",
      is_error: false,
      result: "已完成修订",
      timestamp: "2026-07-16T08:01:00Z",
    },
  ]);

  assert.deepEqual(steps.map((step) => step.title), [
    "开始质量修订",
    "创作引擎已就绪",
    "质量修订完成",
  ]);
  assert.match(steps[0].details, /准备质量修订/);
  assert.match(steps[1].details, /Claude Code 2.1.204/);
});

test("worker timeline steps retain the worker process tag", () => {
  const steps = parseEntries([{
    type: "assistant",
    timestamp: "2026-07-13T05:50:00Z",
    zdebug_process: { id: "worker:trial-dialogue-review-1", name: "台词语义审读", tag: "子进程 1" },
    message: { id: "worker-message", role: "assistant", content: [{ type: "text", text: "审读完成" }] },
  }]);

  assert.equal(steps.length, 1);
  assert.equal(steps[0].process.tag, "子进程 1");
  assert.match(steps[0].id, /^worker:trial-dialogue-review-1:/);
});

test("historical Claude 2.1 assistant records remain visible without message.role", () => {
  const steps = parseEntries([{
    type: "assistant",
    timestamp: "2026-07-16T08:00:00Z",
    message: {
      0: "U",
      content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "trial.md" } }],
    },
  }]);

  assert.equal(steps.length, 1);
  assert.equal(steps[0].title, "工具调用：Read");
});

test("runtime steps from a worker do not replace the main process runtime steps", () => {
  const steps = parseEntries([
    { type: "zdebug_start", timestamp: "2026-07-13T05:50:00Z" },
    {
      type: "zdebug_start",
      timestamp: "2026-07-13T05:51:00Z",
      zdebug_process: { id: "worker:trial-dialogue-review-1", name: "台词语义审读", tag: "子进程 2" },
    },
    { type: "zdebug_heartbeat", timestamp: "2026-07-13T05:52:00Z", age_ms: 120_000, silence_ms: 1_000 },
    {
      type: "zdebug_heartbeat",
      timestamp: "2026-07-13T05:53:00Z",
      age_ms: 120_000,
      silence_ms: 1_000,
      zdebug_process: { id: "worker:trial-dialogue-review-1", name: "台词语义审读", tag: "子进程 2" },
    },
  ]);

  assert.equal(steps.length, 4);
  assert.deepEqual(steps.map((step) => step.process.id), [
    "main",
    "worker:trial-dialogue-review-1",
    "main",
    "worker:trial-dialogue-review-1",
  ]);
});

test("user events render as user requests", () => {
  const steps = parseEntries([{
    type: "user",
    timestamp: "2026-07-16T08:00:00Z",
    message: { role: "user", content: [{ type: "text", text: "请重写开场" }] },
  }]);

  assert.equal(steps.length, 1);
  assert.equal(steps[0].title, "用户请求");
  assert.equal(steps[0].details, "请重写开场");
});
