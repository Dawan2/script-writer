import assert from "node:assert/strict";
import test from "node:test";

import { createPartialThinkingRecorder, normalizeRuntimeEntry, shouldPersistEntry, userInputLogEntry } from "./run.mjs";

test("partial stream events stay real-time while execution heartbeats are persisted", () => {
  assert.equal(shouldPersistEntry({ type: "stream_event" }), false);
  assert.equal(shouldPersistEntry({ type: "zdebug_heartbeat" }), true);
  assert.equal(shouldPersistEntry({ type: "system", subtype: "thinking_tokens" }), false);
  assert.equal(shouldPersistEntry({ type: "system", subtype: "status" }), false);
  assert.equal(shouldPersistEntry({ type: "assistant" }), true);
  assert.equal(shouldPersistEntry({ type: "result" }), true);
});

test("thinking stream deltas are converted into live, replaceable AI thinking entries", () => {
  const record = createPartialThinkingRecorder();
  const base = { type: "stream_event", timestamp: "2026-07-17T02:12:41Z", session_id: "session-1", zdebug_source: "stdout" };
  assert.equal(record({ ...base, event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } }), null);

  const first = record({ ...base, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "正在规划" } } });
  assert.equal(first.type, "assistant");
  assert.equal(first.message.content[0].thinking, "正在规划");
  assert.equal(first.zdebug_partial, true);

  const second = record({ ...base, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "交付内容" } } });
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.message.content[0].thinking, "正在规划交付内容");
});

test("Claude Code 2.1 malformed assistant envelopes keep only usable content", () => {
  const entry = normalizeRuntimeEntry({
    type: "assistant",
    message: {
      0: "U", 1: "p", 2: "s", 3: "t", 4: "r", 5: "e", 6: "a", 7: "m",
      content: [{ type: "thinking", thinking: "正在分析" }],
    },
  });

  assert.equal(entry.message.role, "assistant");
  assert.deepEqual(entry.message.content, [{ type: "thinking", thinking: "正在分析" }]);
  assert.equal(Object.hasOwn(entry.message, "0"), false);
});

test("system init is compacted into one runtime-ready record", () => {
  assert.deepEqual(normalizeRuntimeEntry({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    model: "opus",
    claude_code_version: "2.1.204",
    permissionMode: "bypassPermissions",
    zdebug_source: "stdout",
  }), {
    type: "zdebug_runtime_ready",
    timestamp: undefined,
    session_id: "session-1",
    model: "opus",
    claude_code_version: "2.1.204",
    permission_mode: "bypassPermissions",
    zdebug_source: "stdout",
  });
});

test("user input is written as a structured runtime event", () => {
  assert.deepEqual(userInputLogEntry("请重写开场", "2026-07-16T08:00:00Z"), {
    type: "user",
    timestamp: "2026-07-16T08:00:00Z",
    message: { role: "user", content: [{ type: "text", text: "请重写开场" }] },
    zdebug_source: "user_input",
  });
  assert.equal(userInputLogEntry("   "), null);
});
