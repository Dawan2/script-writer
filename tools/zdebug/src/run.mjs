import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function isNodeScript(command) {
  return /\.(?:cjs|mjs|js)$/i.test(String(command || "").replace(/^["']|["']$/g, ""));
}

function buildSpawnCommand(claudePath, args) {
  if (isNodeScript(claudePath)) {
    return {
      command: process.execPath,
      args: [claudePath, ...args],
    };
  }
  return { command: claudePath, args };
}

function lineWriter(stream, source, logEvent) {
  let buffer = "";
  return {
    write(chunk) {
      const text = chunk.toString();
      stream.write(text);
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) logEvent(source, line);
      }
    },
    flush() {
      if (buffer.trim()) logEvent(source, buffer);
      buffer = "";
    },
  };
}

function malformedMessageText(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const numericKeys = Object.keys(message).filter((key) => /^\d+$/.test(key));
  if (!numericKeys.length) return "";
  numericKeys.sort((left, right) => Number(left) - Number(right));
  if (numericKeys.some((key, index) => Number(key) !== index)) return "";
  return numericKeys.map((key) => message[key]).join("");
}

function normalizedAssistantMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const normalized = { ...message, role: message.role || "assistant" };
  const malformedText = malformedMessageText(message);
  for (const key of Object.keys(normalized)) {
    if (/^\d+$/.test(key)) delete normalized[key];
  }
  // Claude Code 2.1.204 can prepend this transport text as numeric object
  // keys while still returning a valid content array.  Keep the real content
  // and remove the broken envelope; without content, retain the message as a
  // visible diagnostic instead of silently discarding it.
  if (malformedText && !Array.isArray(normalized.content)) {
    normalized.content = [{ type: "text", text: malformedText }];
  }
  return normalized;
}

export function normalizeRuntimeEntry(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (payload.type === "assistant") {
    return { ...payload, message: normalizedAssistantMessage(payload.message) };
  }
  if (payload.type === "system" && payload.subtype === "init") {
    return {
      type: "zdebug_runtime_ready",
      timestamp: payload.timestamp,
      session_id: payload.session_id,
      model: payload.model,
      claude_code_version: payload.claude_code_version,
      permission_mode: payload.permissionMode,
      zdebug_source: payload.zdebug_source,
    };
  }
  return payload;
}

function parseStdoutLine(line) {
  try {
    const payload = JSON.parse(line);
    return normalizeRuntimeEntry({
      ...payload,
      timestamp: payload.timestamp || new Date().toISOString(),
      zdebug_source: "stdout",
    });
  } catch {
    return {
      type: "stdout",
      timestamp: new Date().toISOString(),
      message: line,
      zdebug_source: "stdout",
    };
  }
}

function stderrLine(line) {
  return {
    type: "stderr",
    timestamp: new Date().toISOString(),
    message: line,
    zdebug_source: "stderr",
  };
}

export function shouldPersistEntry(entry) {
  if (entry?.type === "stream_event") return false;
  if (entry?.type === "system" && ["thinking_tokens", "status"].includes(entry.subtype)) return false;
  return true;
}

export function createPartialThinkingRecorder() {
  const blocks = new Map();
  let sequence = 0;

  function snapshot(block, entry) {
    if (!block.text || block.text.length === block.lastPersistedLength) return null;
    block.lastPersistedLength = block.text.length;
    const text = block.text.length > 4000 ? `...${block.text.slice(-4000)}` : block.text;
    return {
      type: "assistant",
      timestamp: entry.timestamp,
      session_id: entry.session_id,
      message: {
        id: block.id,
        role: "assistant",
        content: [{ type: "thinking", thinking: text }],
      },
      zdebug_partial: true,
      zdebug_source: entry.zdebug_source,
    };
  }

  return (entry) => {
    if (entry?.type !== "stream_event" || !entry.event || typeof entry.event !== "object") return null;
    const event = entry.event;
    const index = String(event.index ?? 0);
    if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
      blocks.set(index, { id: `partial-thinking-${sequence += 1}-${index}`, text: "", lastPersistedLength: 0 });
      return null;
    }
    const delta = event.delta;
    if (event.type === "content_block_delta" && delta?.type === "thinking_delta") {
      const block = blocks.get(index) || { id: `partial-thinking-${sequence += 1}-${index}`, text: "", lastPersistedLength: 0 };
      blocks.set(index, block);
      block.text += String(delta.thinking || "");
      return snapshot(block, entry);
    }
    if (event.type === "content_block_stop") {
      const block = blocks.get(index);
      blocks.delete(index);
      return block ? snapshot(block, entry) : null;
    }
    return null;
  };
}

export function userInputLogEntry(value, timestamp = new Date().toISOString()) {
  const text = String(value || "").trim();
  if (!text) return null;
  return {
    type: "user",
    timestamp,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    zdebug_source: "user_input",
  };
}

export async function runWithClaude(config) {
  const claudePath = config.claudePath || process.env.ORCA_CLAUDE_PATH || process.env.CLAUDE_PATH || "claude";
  const args = Array.isArray(config.args) ? config.args : [];
  const logPath = config.logPath || process.env.ORCA_ZDEBUG_RUN_LOG || "";
  const pipeStdin = Boolean(config.pipeStdin);
  const userInput = config.userInput ?? "";

  let logStream = null;
  let persistedEntries = 0;
  let skippedEntries = 0;
  const recordPartialThinking = createPartialThinkingRecorder();
  if (logPath) {
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: "a" });
  }

  function append(entry) {
    if (!logStream) return;
    const partialThinking = recordPartialThinking(entry);
    if (partialThinking) entry = partialThinking;
    if (!shouldPersistEntry(entry)) {
      skippedEntries += 1;
      return;
    }
    logStream.write(`${JSON.stringify(entry)}\n`);
    persistedEntries += 1;
  }

  const startedAt = new Date().toISOString();
  append({
    type: "zdebug_start",
    timestamp: startedAt,
    job_id: process.env.ORCA_ZDEBUG_JOB_ID || "",
    session_id: process.env.ORCA_ZDEBUG_SESSION_ID || "",
    cwd: process.cwd(),
    command: claudePath,
    args,
    operation: process.env.ORCA_ZDEBUG_OPERATION || "",
  });
  const userEntry = userInputLogEntry(userInput, startedAt);
  if (userEntry) append(userEntry);

  const spawnCommand = buildSpawnCommand(claudePath, args);
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  append({
    type: "zdebug_child_spawned",
    timestamp: new Date().toISOString(),
    job_id: process.env.ORCA_ZDEBUG_JOB_ID || "",
    session_id: process.env.ORCA_ZDEBUG_SESSION_ID || "",
    pid: child.pid || null,
    command: spawnCommand.command,
    stdin: pipeStdin ? "pipe" : "closed",
  });

  const logEvent = (source, line) => {
    append(source === "stdout" ? parseStdoutLine(line) : stderrLine(line));
  };
  const stdout = lineWriter(process.stdout, "stdout", logEvent);
  const stderr = lineWriter(process.stderr, "stderr", logEvent);

  let lastOutputAt = Date.now();
  const noteOutput = () => {
    lastOutputAt = Date.now();
  };
  if (pipeStdin) {
    process.stdin.pipe(child.stdin);
  } else {
    child.stdin.end();
  }
  child.stdout.on("data", (chunk) => {
    noteOutput();
    stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    noteOutput();
    stderr.write(chunk);
  });

  const heartbeat = setInterval(() => {
    if (child.exitCode !== null || child.killed) return;
    const entry = {
      type: "zdebug_heartbeat",
      timestamp: new Date().toISOString(),
      job_id: process.env.ORCA_ZDEBUG_JOB_ID || "",
      session_id: process.env.ORCA_ZDEBUG_SESSION_ID || "",
      pid: child.pid || null,
      age_ms: Date.now() - Date.parse(startedAt),
      silence_ms: Date.now() - lastOutputAt,
    };
    append(entry);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }, 15000);

  const forwardSignal = (signal) => {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
  };
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGINT", () => forwardSignal("SIGINT"));

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearInterval(heartbeat);
      stdout.flush();
      stderr.flush();
      append({
        type: "zdebug_end",
        timestamp: new Date().toISOString(),
        job_id: process.env.ORCA_ZDEBUG_JOB_ID || "",
        session_id: process.env.ORCA_ZDEBUG_SESSION_ID || "",
        exit_code: code,
        signal,
      });
      resolve(code ?? (signal ? 143 : 1));
    });
  });

  await new Promise((resolve) => {
    if (!logStream) return resolve();
    logStream.end(resolve);
  });
  if (logPath) {
    await fsp.writeFile(`${logPath}.metrics.json`, `${JSON.stringify({
      schema_version: "1.0.0",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: exitCode,
      persisted_entries: persistedEntries,
      skipped_partial_entries: skippedEntries
    }, null, 2)}\n`, "utf8");
  }

  return exitCode;
}
