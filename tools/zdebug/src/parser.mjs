function compact(value, limit = 260) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function stringify(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentItems(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : [];
}

function firstContentItem(entry, type) {
  return contentItems(entry).find((item) => item?.type === type) || null;
}

function contentToText(content) {
  if (typeof content === "string") return stripSystemReminders(content);
  if (!Array.isArray(content)) return stringify(content);
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return stringify(item);
      if (item.type === "text") return stripSystemReminders(item.text || "");
      if (item.type === "thinking") return item.thinking || item.text || item.content || "";
      if (item.type === "tool_result") return toolResultContent(item);
      if (item.type === "tool_use") return stringify({
        name: item.name,
        id: item.id,
        input: item.input,
      });
      return stringify(item);
    })
    .filter(Boolean)
    .join("\n\n");
}

function stripSystemReminders(text) {
  return String(text || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function toolResultContent(result) {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item || typeof item !== "object") return stringify(item);
      return item.text || item.content || stringify(item);
    }).join("\n");
  }
  return stringify(content);
}

function toolUseItems(entry) {
  return contentItems(entry).filter((item) => item?.type === "tool_use");
}

function toolResultItems(entry) {
  return contentItems(entry).filter((item) => item?.type === "tool_result");
}

function classify(entry) {
  if (entry.type === "parse_error") return "error";
  if (entry.type === "zdebug_preparation") return "preparation";
  if (entry.type === "zdebug_start") return "runtime_start";
  if (entry.type === "zdebug_runtime_ready") return "runtime_ready";
  if (entry.type === "zdebug_heartbeat") return "runtime_waiting";
  if (entry.type === "stream_event") return "internal";
  if (entry.type === "system") return "internal";
  if (entry.type?.startsWith?.("zdebug_")) return "internal";
  if (entry.type === "stderr") return "stderr";
  if (entry.type === "stdout") return "stdout";
  if (entry.type === "result") return "agent_end";
  if (entry.type === "summary") return "summary";

  // Claude Code 2.1.204 omits message.role on completed assistant envelopes.
  // The outer event type remains authoritative, including for historical logs
  // written before the runtime normalizer was added.
  const role = entry?.message?.role || (entry.type === "assistant" ? "assistant" : "");
  if (role === "user" && firstContentItem(entry, "tool_result")) return "tool_result";
  if (role === "user") return "user_message";

  if (role === "assistant") {
    const taskTool = toolUseItems(entry).find((item) => item.name === "Task" && item.input?.subagent_type);
    if (taskTool) return "agent_child";
    if (firstContentItem(entry, "tool_use")) return "tool_call";
    if (firstContentItem(entry, "thinking")) return "assistant_thinking";
    return "assistant_message";
  }

  return "internal";
}

function titleFor(entry, type) {
  if (type === "preparation") return entry.title || "任务准备";
  if (type === "runtime_start") return entry.zdebug_operation ? `开始${entry.zdebug_operation}` : "任务进程已启动";
  if (type === "runtime_ready") return "创作引擎已就绪";
  if (type === "runtime_waiting") return "AI 正在执行";
  if (type === "user_message") return "用户请求";
  if (type === "assistant_message") return "AI 回复";
  if (type === "assistant_thinking") return "AI 思考";
  if (type === "tool_call") {
    const tool = firstContentItem(entry, "tool_use");
    return `工具调用：${tool?.name || "tool"}`;
  }
  if (type === "agent_child") {
    const tool = firstContentItem(entry, "tool_use");
    return `子 Agent：${tool?.input?.subagent_type || "Task"}`;
  }
  if (type === "tool_result") return "工具结果";
  if (type === "agent_end") {
    const label = entry.zdebug_operation || "本轮处理";
    return entry.is_error ? `${label}异常结束` : `${label}完成`;
  }
  if (type === "summary") return "上下文摘要";
  if (type === "stderr") return "错误输出";
  if (type === "stdout") return "标准输出";
  if (type === "error") return "解析异常";
  return type;
}

function detailsFor(entry, type) {
  if (type === "preparation") return entry.message || "";
  if (type === "runtime_start") {
    const operation = entry.zdebug_operation ? `，准备${entry.zdebug_operation}` : "";
    return `任务 #${entry.job_id || "-"} 已启动${operation}，正在连接创作引擎。`;
  }
  if (type === "runtime_ready") {
    return [
      entry.claude_code_version ? `Claude Code ${entry.claude_code_version}` : "Claude Code",
      entry.model ? `模型：${entry.model}` : "",
    ].filter(Boolean).join(" · ");
  }
  if (type === "runtime_waiting") {
    const ageSeconds = Math.max(0, Math.round(Number(entry.age_ms || 0) / 1000));
    const silenceSeconds = Math.max(0, Math.round(Number(entry.silence_ms || 0) / 1000));
    return `任务已运行 ${ageSeconds} 秒，距上一条可展示内容 ${silenceSeconds} 秒。AI 仍在执行，等待下一条思考、工具操作或回复。`;
  }
  if (type === "error") return entry.raw || "";
  if (type === "tool_call" || type === "agent_child") {
    const tools = toolUseItems(entry).map((tool) => ({
      name: tool.name,
      id: tool.id,
      input: tool.input,
    }));
    return stringify(tools.length === 1 ? tools[0] : tools);
  }
  if (type === "tool_result") {
    const direct = entry.toolUseResult || entry.tool_use_result;
    if (direct?.file?.content) return direct.file.content;
    if (direct?.stdout) return direct.stdout;
    if (direct?.stderr) return direct.stderr;
    const results = toolResultItems(entry).map((result) => toolResultContent(result));
    return results.join("\n---\n");
  }
  if (type === "agent_end") {
    const meta = [];
    if (entry.duration_ms !== undefined) meta.push(`duration_ms: ${entry.duration_ms}`);
    if (entry.num_turns !== undefined) meta.push(`num_turns: ${entry.num_turns}`);
    if (entry.total_cost_usd !== undefined) meta.push(`total_cost_usd: ${entry.total_cost_usd}`);
    return [entry.result || "", meta.join("\n")].filter(Boolean).join("\n\n");
  }
  if (entry?.message?.content !== undefined) return contentToText(entry.message.content);
  if (entry.message) return stringify(entry.message);
  if (entry.summary) return entry.summary;
  if (entry.message !== undefined) return stringify(entry.message);
  return stringify(entry);
}

function metadataFor(entry, type) {
  const metadata = {};
  for (const field of ["model", "duration_ms", "num_turns", "total_cost_usd", "session_id", "is_error"]) {
    if (entry[field] !== undefined) metadata[field] = entry[field];
  }
  if (type === "tool_result") {
    const result = firstContentItem(entry, "tool_result");
    if (result?.tool_use_id) metadata.tool_use_id = result.tool_use_id;
    if (result?.is_error !== undefined) metadata.success = !result.is_error;
  }
  return metadata;
}

function visibleStepId(entry, index) {
  const base = entry.uuid || entry.message?.id || entry.id || `${entry.type || "entry"}-${index}`;
  const processId = entry?.zdebug_process?.id || "main";
  return `${processId}:${base}-${index}`;
}

export function parseEntries(entries) {
  let visibleIndex = 1;
  let hiddenCount = 0;
  const steps = [];
  const replaceableStepIndexes = new Map();
  const operationBySession = new Map();

  entries.forEach((sourceEntry, index) => {
    const sessionId = sourceEntry?.session_id;
    if (sourceEntry?.type === "zdebug_start" && sessionId && sourceEntry.operation) {
      operationBySession.set(sessionId, sourceEntry.operation);
    }
    const operation = sourceEntry?.zdebug_operation || (sessionId ? operationBySession.get(sessionId) : "");
    const entry = operation ? { ...sourceEntry, zdebug_operation: operation } : sourceEntry;
    const type = classify(entry);
    if (type === "internal") {
      hiddenCount += 1;
      return;
    }

    const details = detailsFor(entry, type);
    if (!String(details || "").trim() && type !== "agent_end") {
      hiddenCount += 1;
      return;
    }

    const replaceKey = replacementKey(entry, type);
    const step = {
      id: visibleStepId(entry, index),
      index,
      originalIndex: visibleIndex,
      stepNumber: visibleIndex,
      type,
      title: titleFor(entry, type),
      timestamp: entry.timestamp || entry.created_at || "",
      summary: compact(details),
      details,
      process: entry.zdebug_process || { id: "main", name: "主进程", tag: "" },
      metadata: metadataFor(entry, type),
      raw: stringify(entry),
    };

    if (replaceKey && replaceableStepIndexes.has(replaceKey)) {
      const existingIndex = replaceableStepIndexes.get(replaceKey);
      const previous = steps[existingIndex];
      steps[existingIndex] = {
        ...step,
        id: previous.id,
        originalIndex: previous.originalIndex,
        stepNumber: previous.stepNumber,
      };
      hiddenCount += 1;
      return;
    }

    steps.push(step);
    if (replaceKey) replaceableStepIndexes.set(replaceKey, steps.length - 1);
    visibleIndex += 1;
  });

  Object.defineProperty(steps, "hiddenCount", {
    value: hiddenCount,
    enumerable: false,
  });
  return steps;
}

function replacementKey(entry, type) {
  const processId = entry?.zdebug_process?.id || "main";
  if (type === "runtime_start" || type === "runtime_waiting") return `${processId}:${type}`;
  if (!["assistant_message", "assistant_thinking", "tool_call", "agent_child"].includes(type)) return "";
  const messageId = entry?.message?.id;
  return messageId ? `${processId}:${type}:${messageId}` : "";
}
