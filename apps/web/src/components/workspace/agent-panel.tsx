"use client";

import { Bot, Bug, Check, ChevronDown, ClipboardList, Coins, Ellipsis, FileText, Loader2, MessageSquareText, Paperclip, Send, SlidersHorizontal, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cancelAgentJob, createAgentJob, getAgentCreditQuote, getAgentEvents, getAgentHistory, getWriterPreferences, retryAgentJob, startAgentDebug } from "@/lib/api-client";
import { formatDateTime } from "@/lib/date-time";
import type { AgentDebugSession, AgentDocumentExcerpt, AgentEvent, AgentHistory, AgentJob, AgentStageChoice, CreditPrice, Project, StageDocument, StageFile, WriterPreference, WriterPreferenceScopeKey } from "@/lib/types";

const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);
const TRANSCRIPT_STORAGE_PREFIX = "orca-agent-transcript";
const TRANSCRIPT_ROW_LIMIT = 80;
const AGENT_EVENT_LIMIT = 200;
const NOVEL_ANALYSIS_PROGRESS_EVENTS = new Set([
  "novel_reading_plan",
  "novel_reading_checkpoint",
  "novel_reading_progress",
  "novel_reading_worker_start",
  "novel_reading_worker_done",
  "novel_reading_worker_retry",
  "novel_reading_parallelism_reduced",
  "novel_reading_repair",
  "novel_reading_failed",
  "novel_arc_progress",
  "novel_analysis_synthesis",
  "novel_analysis_prepared"
]);
const STAGE_ACTIVITY_LABELS: Record<AgentStageChoice, string> = {
  next: "下一阶段",
  all: "全流程",
  chat_edit: "对话修改",
  novel_analysis: "小说解读",
  world_view: "世界观",
  outline_rewrite: "故事梗概",
  character_rewrite: "人物小传",
  trial_generate: "剧本试稿",
  full_generate: "完整剧本",
  dialogue_translate: "台词翻译",
  foreign_review: "海外审稿",
  humanizer_zh: "剧本润色"
};
const PREFERENCE_SCOPE_KEYS = new Set<WriterPreferenceScopeKey>([
  "novel_analysis", "world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review", "humanizer_zh"
]);

function recentAgentEvents(events: AgentEvent[]) {
  return events
    .filter((event) => event.event_type !== "stream_content_block_delta")
    .slice(-AGENT_EVENT_LIMIT);
}

type AttachmentDraft = {
  id: number;
  name: string;
  content: string;
};

type ExcerptPreview = {
  id: number;
  content: string;
  left: number;
  top: number;
  placement: "above" | "below";
};

type LabeledExcerpt = {
  excerpt: AgentDocumentExcerpt;
  label: string;
};

type AgentActivityItem = {
  id: number;
  label: string;
  text: string;
  time: string;
  tone: "ai" | "tool" | "flow" | "result" | "error";
};

type ActivityCandidate =
  | { kind: "text"; id: number; text: string; time: string }
  | { kind: "item"; item: AgentActivityItem };

type AgentConversationRow = {
  id: string;
  kind: "user" | "assistant" | "status";
  label: string;
  text: string;
  time: string;
  jobId?: number;
  stage?: AgentStageChoice;
  targetStage?: string;
};

export type AgentRunCommand = {
  id: number;
  stage: AgentStageChoice;
  targetStage?: string;
  prompt: string;
  referenceCurrentFile?: boolean;
  manualInput?: string;
  regenerateCurrentFile?: boolean;
  optimizationScope?: "review_p0";
};

export type AgentActiveJobState = {
  job: AgentJob;
  events: AgentEvent[];
};

export type AgentPromptDraft = {
  id: number;
  text: string;
};

type AgentPanelProps = {
  project: Project | null;
  document: StageDocument | null;
  draft: string;
  selectedFile: StageFile | null;
  files: StageFile[];
  excerpts: AgentDocumentExcerpt[];
  canDebug?: boolean;
  command: AgentRunCommand | null;
  promptDraft: AgentPromptDraft | null;
  activeJobState: AgentActiveJobState | null;
  minimized: boolean;
  archived?: boolean;
  readOnly?: boolean;
  briefLoading?: boolean;
  creditPrices?: CreditPrice[];
  creditBalance?: number | null;
  creditsManaged?: boolean;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onOpenDistributionBrief: () => void;
  onCommandHandled: (commandId: number) => void;
  onPromptDraftHandled: (draftId: number) => void;
  onRemoveExcerpt: (excerptId: number) => void;
  onClearExcerpts: () => void;
  onContextItemsChange: (hasContext: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onJobStarted: (job: AgentJob) => void;
  onCompleted: () => Promise<void> | void;
  onCreditsChanged: () => Promise<void> | void;
  onError: (message: string) => void;
};

function eventTime(event: AgentEvent) {
  return formatDateTime(event.created_at, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }, "");
}

function runningJobIdFromMessage(message: string) {
  const match = message.match(/running job #(\d+)/i);
  return match ? Number(match[1]) : null;
}

function eventLines(message: string) {
  return message.split(/\r?\n/);
}

function compactText(value: string, limit = 180) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function parseRawJson(event: AgentEvent): any | null {
  if (!event.raw_json) return null;
  if (typeof event.raw_json !== "string") return event.raw_json;
  try {
    return JSON.parse(event.raw_json);
  } catch {
    return null;
  }
}

function eventMarksExecutionStarted(event: AgentEvent) {
  if (["stage_start", "chat_start", "assistant", "stdout", "stderr", "memory_sync", "worker_activity"].includes(event.event_type)) {
    return true;
  }
  if (/Agent 任务已启动|开始执行|计划执行|正在(?:开始|继续)处理当前内容/.test(event.message)) {
    return true;
  }
  const raw = parseRawJson(event);
  return !!raw && !String(raw.type ?? "").startsWith("zdebug_");
}

function executionHasStarted(events: AgentEvent[]) {
  return events.some(eventMarksExecutionStarted);
}

function contentText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => contentText(item)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.thinking === "string") return record.thinking;
    if (record.content) return contentText(record.content);
    return "";
  }
  return String(value);
}

function toolInputSummary(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  const preferredKeys = ["file_path", "path", "command", "pattern", "query", "prompt"];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return compactText(value, 80);
    }
  }
  const keys = Object.keys(record).slice(0, 4);
  return keys.length ? `参数：${keys.join(", ")}` : "";
}

function makeActivityItem(
  event: AgentEvent,
  label: string,
  text: string,
  tone: AgentActivityItem["tone"],
) {
  return {
    id: event.id,
    label,
    text: compactText(text),
    time: eventTime(event),
    tone
  };
}

function activityFromRawEvent(event: AgentEvent, raw: any): ActivityCandidate | null {
  if (raw?.type === "stream_event") {
    const streamEvent = raw.event || {};
    const streamType = streamEvent.type;
    if (streamType === "message_start") {
      const model = streamEvent.message?.model;
      return { kind: "item", item: makeActivityItem(event, "AI", model ? `开始回复，模型 ${model}` : "开始回复", "ai") };
    }
    if (streamType === "content_block_start") {
      const block = streamEvent.content_block || {};
      if (block.type === "tool_use") {
        return { kind: "item", item: makeActivityItem(event, "工具", `准备使用 ${block.name || "工具"}`, "tool") };
      }
      if (block.type === "text") {
        return { kind: "item", item: makeActivityItem(event, "AI", "正在组织回复内容", "ai") };
      }
    }
    if (streamType === "content_block_delta") {
      const delta = streamEvent.delta || {};
      if (delta.type === "text_delta" && delta.text?.trim()) {
        return { kind: "text", id: event.id, text: delta.text, time: eventTime(event) };
      }
      return null;
    }
    if (streamType === "message_stop") {
      return { kind: "item", item: makeActivityItem(event, "AI", "本轮回复完成", "ai") };
    }
  }

  if (raw?.type === "assistant") {
    const content = raw.message?.content;
    if (Array.isArray(content)) {
      const tool = content.find((item) => item?.type === "tool_use");
      if (tool) {
        const detail = toolInputSummary(tool.input);
        return {
          kind: "item",
          item: makeActivityItem(event, "工具", `正在使用 ${tool.name || "工具"}${detail ? `：${detail}` : ""}`, "tool")
        };
      }
      const text = content
        .filter((item) => item?.type === "text")
        .map((item) => item.text || "")
        .join("\n")
        .trim();
      if (text) {
        return { kind: "item", item: makeActivityItem(event, "AI 回复", text, "ai") };
      }
    }
  }

  if (raw?.type === "user") {
    const text = contentText(raw.message?.content);
    if (text.trim()) {
      return { kind: "item", item: makeActivityItem(event, "工具结果", text, "tool") };
    }
  }

  if (raw?.type === "result") {
    return {
      kind: "item",
      item: makeActivityItem(event, raw.is_error ? "运行异常" : "本轮结果", raw.result || "本轮处理已结束，正在继续后续流程", raw.is_error ? "error" : "result")
    };
  }

  return null;
}

function activityCandidate(event: AgentEvent): ActivityCandidate | null {
  if (NOVEL_ANALYSIS_PROGRESS_EVENTS.has(event.event_type)) {
    const tone = event.event_type === "novel_reading_failed" ? "error" : "flow";
    return { kind: "item", item: makeActivityItem(event, "小说解读", event.message, tone) };
  }
  if (event.event_type === "worker_activity") {
    const raw = parseRawJson(event);
    const tone = raw?.category === "异常" ? "error" : raw?.category === "工具" ? "tool" : "flow";
    return { kind: "item", item: makeActivityItem(event, "子进程", event.message, tone) };
  }
  if (event.event_type === "error" || event.event_type === "stderr") {
    return { kind: "item", item: makeActivityItem(event, "异常", event.message, "error") };
  }
  if (event.event_type === "model_unavailable_retry") {
    return { kind: "item", item: makeActivityItem(event, "自动重试", event.message, "flow") };
  }
  if (["info", "stage_start", "stage_done", "chat_start", "chat_done", "done", "warning"].includes(event.event_type)) {
    const relevant = /任务|计划|开始|完成|取消|ZDebug|阶段|对话式|正在处理|已同步|尚未达到交付/.test(event.message);
    if (relevant) {
      return { kind: "item", item: makeActivityItem(event, "流程", event.message, event.event_type === "warning" ? "error" : "flow") };
    }
  }

  const raw = parseRawJson(event);
  if (raw) {
    const fromRaw = activityFromRawEvent(event, raw);
    if (fromRaw) return fromRaw;
  }

  if (event.message.startsWith("⏺ tool_use_start")) {
    return { kind: "item", item: makeActivityItem(event, "工具", event.message.replace("⏺ tool_use_start", "准备使用"), "tool") };
  }
  if (event.message.startsWith("✔") || event.message.startsWith("✖")) {
    return { kind: "item", item: makeActivityItem(event, "运行结果", event.message, event.message.startsWith("✖") ? "error" : "result") };
  }

  return null;
}

function buildActivityItems(events: AgentEvent[]) {
  const items: AgentActivityItem[] = [];
  let textBuffer = "";
  let textEventId = 0;
  let textTime = "";

  const flushText = () => {
    const text = compactText(textBuffer, 220);
    if (text) {
      items.push({
        id: textEventId,
        label: "AI 回复",
        text,
        time: textTime,
        tone: "ai"
      });
    }
    textBuffer = "";
    textEventId = 0;
    textTime = "";
  };

  for (const event of events) {
    const candidate = activityCandidate(event);
    if (!candidate) continue;
    if (candidate.kind === "text") {
      textBuffer += candidate.text;
      textEventId = candidate.id;
      textTime = candidate.time;
      if (textBuffer.length > 420) flushText();
      continue;
    }
    flushText();
    const last = items.at(-1);
    if (!last || last.label !== candidate.item.label || last.text !== candidate.item.text) {
      items.push(candidate.item);
    }
  }
  flushText();
  return items.slice(-6);
}

function debugSessionUrl(session: AgentDebugSession | null) {
  if (!session) return "";
  try {
    const url = new URL(session.url || `http://127.0.0.1:${session.port}`);
    if (typeof window !== "undefined") {
      const debugUrl = new URL(`/zdebug/${url.port}/`, window.location.origin);
      if (session.selected_log_id) {
        debugUrl.searchParams.set("logid", session.selected_log_id);
      }
      if (session.session_id) {
        debugUrl.searchParams.set("sessionid", session.session_id);
      }
      return debugUrl.toString();
    }
    if (session.selected_log_id) {
      url.searchParams.set("logid", session.selected_log_id);
    }
    if (session.session_id) {
      url.searchParams.set("sessionid", session.session_id);
    }
    return url.toString();
  } catch {
    return session.url;
  }
}

function isLogPinnedToBottom(log: HTMLDivElement) {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 36;
}

function timeNow() {
  return formatDateTime(new Date(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function transcriptStorageKey(projectId: number, stage: string) {
  return `${TRANSCRIPT_STORAGE_PREFIX}:${projectId}:${stage}`;
}

function saveTranscriptRows(key: string, rows: AgentConversationRow[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(rows.slice(-TRANSCRIPT_ROW_LIMIT)));
}

function extractUserRequest(promptText: string | undefined) {
  if (!promptText) return "用户请求";
  const match = promptText.match(/用户请求：\s*\n([\s\S]*?)(?:\n\n用户附件：|\n\n用户选取的项目文件片段：|$)/);
  return compactText((match?.[1] ?? promptText).trim() || "用户请求", 240);
}

function creditCostForStage(prices: CreditPrice[] | undefined, stage: string | undefined) {
  if (!stage) return null;
  return prices?.find((item) => item.stage === stage)?.credits ?? null;
}

function agentFileCanReceiveAdjustment(project: Project | null, file: StageFile) {
  if (!file.exists || file.stage === "project_init") return false;
  if (project?.task_type === "review") return file.stage === "foreign_review";
  if (project?.task_type === "translate") return file.stage === "dialogue_translate";
  if (project?.task_type === "humanize") return file.stage === "humanizer_zh";
  return true;
}

function agentFileDisabledReason(project: Project | null, file: StageFile) {
  if (file.stage === "project_init") return "请在项目设置中更新";
  if (!file.exists) return "尚未生成";
  if (project?.task_type === "review" && file.stage !== "foreign_review") return "待审剧本不可修改";
  if (project?.task_type === "translate" && file.stage !== "dialogue_translate") return "当前任务只能调整台词翻译";
  if (project?.task_type === "humanize" && file.stage !== "humanizer_zh") return "当前任务只能调整润色剧本";
  return "";
}

function labelDocumentExcerpts(excerpts: AgentDocumentExcerpt[]): LabeledExcerpt[] {
  const totalByFile = new Map<string, number>();
  const indexByFile = new Map<string, number>();
  for (const excerpt of excerpts) {
    totalByFile.set(excerpt.file_path, (totalByFile.get(excerpt.file_path) ?? 0) + 1);
  }
  return excerpts.map((excerpt) => {
    const index = (indexByFile.get(excerpt.file_path) ?? 0) + 1;
    indexByFile.set(excerpt.file_path, index);
    const suffix = (totalByFile.get(excerpt.file_path) ?? 0) > 1 ? String(index) : "";
    return {
      excerpt,
      label: `${excerpt.document_name}片段${suffix}`
    };
  });
}

function excerptPreviewText(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 52 ? `${compact.slice(0, 52)}...` : compact;
}

function rowsFromHistory(history: AgentHistory): AgentConversationRow[] {
  const targetStageByJobId = new Map(history.jobs.map((job) => [job.id, job.target_stage || job.stage]));
  const messageRows = history.messages.map((message) => ({
    id: `message-${message.id}`,
    kind: message.role as "user" | "assistant",
    label: message.role === "user" ? "用户输入" : "Agent",
    text: message.role === "user" ? extractUserRequest(message.content) : compactText(message.content, 360),
    time: formatDateTime(message.created_at, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }, ""),
    jobId: message.job_id,
    stage: message.stage as AgentStageChoice,
    targetStage: message.job_id ? targetStageByJobId.get(message.job_id) : message.stage
  }));
  return messageRows.slice(-TRANSCRIPT_ROW_LIMIT);
}

function mergeRunningStatusRows(
  historyRows: AgentConversationRow[],
  currentRows: AgentConversationRow[],
  jobs: AgentJob[]
) {
  const activeJobIds = new Set(
    jobs.filter((historyJob) => !terminalStatuses.has(historyJob.status)).map((historyJob) => historyJob.id)
  );
  const runningStatusRows = currentRows.filter(
    (row) => row.kind === "status" && row.jobId !== undefined && activeJobIds.has(row.jobId)
  );
  const historyIds = new Set(historyRows.map((row) => row.id));
  return [
    ...historyRows,
    ...runningStatusRows.filter((row) => !historyIds.has(row.id))
  ].slice(-TRANSCRIPT_ROW_LIMIT);
}

function toolNameFromMessage(message: string) {
  const streamMatch = message.match(/^⏺\s+tool_use_start\s+([^\s[]+)/);
  if (streamMatch) return streamMatch[1];
  const assistantMatch = message.match(/^⏺\s+([^\s[]+)/);
  if (assistantMatch) return assistantMatch[1];
  return "";
}

function toolActivity(toolName: string) {
  const normalized = toolName.toLowerCase();
  if (["read", "glob", "grep"].includes(normalized)) return "正在读取项目内容";
  if (["write", "edit", "notebookedit"].includes(normalized)) return "正在更新项目文件";
  if (["bash", "skill"].includes(normalized)) return "正在执行标准工作流";
  if (["todowrite", "taskcreate", "taskupdate"].includes(normalized)) return "正在更新执行计划";
  if (["websearch", "webfetch"].includes(normalized)) return "正在检索参考资料";
  if (["task", "agent"].includes(normalized)) return "正在处理子任务";
  return `正在调用 ${toolName || "工具"}`;
}

function stepTitleFromEvent(event: AgentEvent) {
  if (NOVEL_ANALYSIS_PROGRESS_EVENTS.has(event.event_type)) return event.message;
  if (event.event_type === "worker_activity") return event.message;
  if (event.event_type === "error" || event.event_type === "stderr") return "执行遇到异常";
  if (event.event_type === "model_unavailable_retry") return "正在等待创作服务恢复";
  if (event.event_type === "stage_start") return "正在生成阶段内容";
  if (event.event_type === "chat_start") return "正在处理对话要求";
  if (event.event_type === "memory_sync") return "正在同步项目记忆";
  if (["stage_done", "chat_done", "done"].includes(event.event_type)) return "正在整理执行结果";
  if (event.event_type === "info") {
    if (event.message.includes("Agent 任务已启动")) return "正在准备执行";
    if (event.message.includes("计划执行")) return "已确认执行计划";
    if (event.message.includes("正在开始处理当前内容") || event.message.includes("正在继续处理当前内容")) return "正在连接创作服务";
    if (event.message.includes("已同步当前阶段进度")) return "正在同步阶段进度";
  }
  const raw = parseRawJson(event);
  if (raw?.type === "result") return raw.is_error ? "本轮处理异常结束" : "本轮处理完成，正在继续";
  if (raw?.type === "assistant") {
    const content = raw.message?.content;
    if (Array.isArray(content)) {
      const tool = content.find((item) => item?.type === "tool_use");
      if (tool) return toolActivity(tool.name || "tool");
      if (content.some((item) => item?.type === "thinking")) return "正在分析任务";
      if (content.some((item) => item?.type === "text")) return "正在生成回复";
    }
  }
  if (raw?.type === "user") {
    const content = raw.message?.content;
    if (Array.isArray(content) && content.some((item) => item?.type === "tool_result")) return "正在处理工具结果";
    return "正在理解用户要求";
  }
  if (raw?.type === "stream_event") {
    const streamEvent = raw.event || {};
    if (streamEvent.type === "content_block_start") {
      const block = streamEvent.content_block || {};
      if (block.type === "tool_use") return toolActivity(block.name || "tool");
      if (block.type === "text") return "正在生成回复";
    }
    return null;
  }
  const toolName = toolNameFromMessage(event.message);
  if (toolName) return toolActivity(toolName);
  if (event.message.startsWith("工具结果")) return "正在处理工具结果";
  if (event.message.startsWith("✔")) return "本轮处理完成，正在继续";
  if (event.message.startsWith("✖")) return "执行失败";
  if (event.event_type === "assistant") return "正在生成回复";
  if (event.event_type === "user") return "正在处理工具结果";
  return null;
}

function latestStepTitle(events: AgentEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const title = stepTitleFromEvent(events[index]);
    if (title) return title;
  }
  return "正在准备执行";
}

function runStatusText(job: AgentJob | null, events: AgentEvent[], submitting: boolean, selectedFile?: StageFile | null) {
  if (submitting && (!job || terminalStatuses.has(job.status))) return "正在提交 Agent 任务";
  if (!job) return "Agent 待命";
  const prefix = STAGE_ACTIVITY_LABELS[job.stage] ?? "Agent 任务";
  if (job.status === "queued" && !executionHasStarted(events)) return `${prefix}：等待执行资源`;
  if (
    job.status === "succeeded"
    && selectedFile?.stage === "foreign_review"
    && selectedFile.review_decision?.outcome === "revision_requested"
    && (job.target_stage || job.stage) === selectedFile.stage
  ) {
    return `${prefix}：已提出调整建议`;
  }
  if (
    job.status === "succeeded"
    && selectedFile?.status === "needs_revision"
    && (job.target_stage || job.stage) === selectedFile.stage
  ) {
    const count = selectedFile.quality_warnings?.length ?? 0;
    return `${prefix}：${count > 0 ? `${count} 项待处理` : "需要处理"}`;
  }
  if (job.status === "succeeded") return `${prefix}：执行完成`;
  if (job.status === "failed") {
    const reason = job.error_message?.replace(/\s+/g, " ").trim();
    return `${prefix}：${reason || "执行失败，请重试"}`;
  }
  if (job.status === "canceled") return `${prefix}：已取消`;
  return `${prefix}：${latestStepTitle(events)}`;
}

export function AgentPanel({
  project,
  document,
  draft,
  selectedFile,
  files,
  excerpts,
  canDebug = false,
  command,
  promptDraft,
  activeJobState,
  minimized,
  archived = false,
  readOnly = false,
  briefLoading = false,
  creditPrices,
  creditBalance,
  creditsManaged = false,
  onResizeStart,
  onOpenDistributionBrief,
  onCommandHandled,
  onPromptDraftHandled,
  onRemoveExcerpt,
  onClearExcerpts,
  onContextItemsChange,
  onBusyChange,
  onJobStarted,
  onCompleted,
  onCreditsChanged,
  onError
}: AgentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [targetStage, setTargetStage] = useState("");
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [excerptPreview, setExcerptPreview] = useState<ExcerptPreview | null>(null);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [job, setJob] = useState<AgentJob | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [conversationRows, setConversationRows] = useState<AgentConversationRow[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesLoading, setPreferencesLoading] = useState(false);
  const [preferencesError, setPreferencesError] = useState("");
  const [effectivePreferences, setEffectivePreferences] = useState<WriterPreference[]>([]);
  const preferencesButtonRef = useRef<HTMLButtonElement>(null);
  const preferencesCloseRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const logPinnedToBottomRef = useRef(true);
  const activeTranscriptKeyRef = useRef("");
  const lastEventIdRef = useRef(0);
  const onCompletedRef = useRef(onCompleted);
  const onCreditsChangedRef = useRef(onCreditsChanged);
  const onErrorRef = useRef(onError);
  const commandTargetStageRef = useRef<string | null>(null);

  const running = job
    ? !terminalStatuses.has(job.status)
    : !!activeJobState && !terminalStatuses.has(activeJobState.job.status);
  const targetFile = useMemo(
    () => files.find((file) => file.stage === targetStage) ?? selectedFile,
    [files, selectedFile, targetStage]
  );
  const hasUnsavedChanges = !!document && draft !== document.content;
  const canRun = !!project && !!document && !archived && !readOnly && !hasUnsavedChanges && !running && !submitting;
  const currentDocumentCanReceiveAdjustment = useMemo(() => {
    return Boolean(targetFile && agentFileCanReceiveAdjustment(project, targetFile));
  }, [project, targetFile]);
  const adjustmentCreditCost = useMemo(
    () => creditCostForStage(creditPrices, targetFile?.stage),
    [creditPrices, targetFile?.stage]
  );
  const adjustmentCreditInsufficient = Boolean(
    creditsManaged
    && adjustmentCreditCost !== null
    && creditBalance !== null
    && creditBalance !== undefined
    && creditBalance < adjustmentCreditCost
  );
  const adjustmentPlaceholder = readOnly
    ? "仅可查看此项目"
    : archived
    ? "项目已归档"
    : !currentDocumentCanReceiveAdjustment
      ? project?.task_type === "review"
        ? "待审剧本不可修改，请在审稿报告中补充复核重点"
        : "请通过项目设置更新原始剧本和任务需求"
      : adjustmentCreditCost !== null
        ? `说说你想如何调整${targetFile?.name ?? "当前文档"}（${adjustmentCreditCost}额度）`
        : `说说你想如何调整${targetFile?.name ?? "当前文档"}`;

  const canSend = canRun && currentDocumentCanReceiveAdjustment && (prompt.trim().length > 0 || attachments.length > 0 || excerpts.length > 0);
  const currentTranscriptKey = useMemo(() => {
    if (!project) return "";
    return transcriptStorageKey(project.id, "project");
  }, [project]);
  const liveActivity = useMemo(
    () => runStatusText(job, events, submitting, targetFile),
    [events, job, submitting, targetFile]
  );
  const preferenceStage = useMemo(() => {
    const stage = targetFile?.stage ?? document?.stage;
    return stage && PREFERENCE_SCOPE_KEYS.has(stage as WriterPreferenceScopeKey)
      ? stage as WriterPreferenceScopeKey
      : null;
  }, [document?.stage, targetFile?.stage]);
  const preferenceStageName = targetFile?.name ?? document?.name ?? "当前文件";
  const hasContextItems = attachments.length > 0 || excerpts.length > 0;
  const labeledExcerpts = useMemo(() => labelDocumentExcerpts(excerpts), [excerpts]);

  useEffect(() => {
    onContextItemsChange(hasContextItems);
  }, [hasContextItems, onContextItemsChange]);

  const resizePromptInput = useCallback(() => {
    const textarea = promptInputRef.current;
    if (!textarea) return;
    const style = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight) || 20;
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const maxHeight = lineHeight * 5 + verticalPadding;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(resizePromptInput);
    return () => window.cancelAnimationFrame(frame);
  }, [prompt, resizePromptInput]);

  useEffect(() => {
    if (!files.length) {
      setTargetStage("");
      return;
    }
    const reviewRevisionTarget = selectedFile?.stage === "foreign_review" && project?.task_type === "rewrite"
      ? files.find((file) => file.stage === "full_generate" && agentFileCanReceiveAdjustment(project, file))
      : null;
    if (reviewRevisionTarget) {
      if (targetStage !== reviewRevisionTarget.stage) setTargetStage(reviewRevisionTarget.stage);
      return;
    }
    const currentTarget = files.find((file) => file.stage === targetStage);
    if (currentTarget && agentFileCanReceiveAdjustment(project, currentTarget)) return;
    const selectedTarget = reviewRevisionTarget ?? (selectedFile && files.find((file) => (
      file.stage === selectedFile.stage && agentFileCanReceiveAdjustment(project, file)
    )));
    const fallback = selectedTarget ?? [...files].reverse().find((file) => agentFileCanReceiveAdjustment(project, file));
    setTargetStage(fallback?.stage ?? "");
  }, [files, project, selectedFile?.stage, targetStage]);

  useEffect(() => {
    if (!selectedFile || prompt.trim() || attachments.length || excerpts.length) return;
    const nextTarget = selectedFile.stage === "foreign_review" && project?.task_type === "rewrite"
      ? files.find((file) => file.stage === "full_generate" && agentFileCanReceiveAdjustment(project, file))
      : files.find((file) => (
        file.stage === selectedFile.stage && agentFileCanReceiveAdjustment(project, file)
      ));
    if (nextTarget) setTargetStage(nextTarget.stage);
  }, [attachments.length, excerpts.length, files, project, prompt, selectedFile?.stage]);

  useEffect(() => {
    if (!fileMenuOpen) return;
    function closeFileMenu(event: MouseEvent) {
      if (event.target instanceof Node && !fileMenuRef.current?.contains(event.target)) setFileMenuOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setFileMenuOpen(false);
    }
    window.document.addEventListener("mousedown", closeFileMenu);
    window.document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.document.removeEventListener("mousedown", closeFileMenu);
      window.document.removeEventListener("keydown", handleKeyDown);
    };
  }, [fileMenuOpen]);

  useEffect(() => {
    onCompletedRef.current = onCompleted;
    onCreditsChangedRef.current = onCreditsChanged;
    onErrorRef.current = onError;
  }, [onCompleted, onCreditsChanged, onError]);

  useEffect(() => {
    setJob(null);
    setEvents([]);
    lastEventIdRef.current = 0;
    setPrompt("");
    setFileMenuOpen(false);
    setExcerptPreview(null);
    setAttachments([]);
    setConversationRows([]);
    activeTranscriptKeyRef.current = "";
    setPreferencesOpen(false);
    logPinnedToBottomRef.current = true;
  }, [project?.id]);

  useEffect(() => {
    if (!preferencesOpen) return;
    window.requestAnimationFrame(() => preferencesCloseRef.current?.focus());
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPreferencesOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      preferencesButtonRef.current?.focus();
    };
  }, [preferencesOpen]);

  useEffect(() => {
    if (!currentTranscriptKey || running || submitting) return;
    activeTranscriptKeyRef.current = currentTranscriptKey;
    logPinnedToBottomRef.current = true;
  }, [currentTranscriptKey, running, submitting]);

  const loadServerHistory = useCallback(async () => {
    if (!project) return;
    const history = await getAgentHistory(project.id);
    const rows = rowsFromHistory(history);
    setConversationRows((currentRows) => {
      const mergedRows = mergeRunningStatusRows(rows, currentRows, history.jobs);
      if (currentTranscriptKey) saveTranscriptRows(currentTranscriptKey, mergedRows);
      return mergedRows;
    });
    setJob((current) => current && !terminalStatuses.has(current.status) ? current : (history.jobs[0] ?? null));
  }, [currentTranscriptKey, project?.id]);

  useEffect(() => {
    if (!project) return;
    void loadServerHistory().catch((err) => onErrorRef.current(err instanceof Error ? err.message : "读取 Agent 历史失败"));
  }, [loadServerHistory, project?.id]);

  const ensureJobRows = useCallback((nextJob: AgentJob, sourcePrompt?: string, sourceEvents: AgentEvent[] = []) => {
    if (!project) return;
    const key = currentTranscriptKey || transcriptStorageKey(project.id, "project");
    activeTranscriptKeyRef.current = key;
    const statusText = runStatusText(nextJob, sourceEvents, false, targetFile);
    setConversationRows((existingRows) => {
      const hasUserRow = existingRows.some((row) => row.kind === "user" && row.jobId === nextJob.id);
      const hasStatusRow = existingRows.some((row) => row.kind === "status" && row.jobId === nextJob.id);
      const nextRows = [
        ...existingRows,
        ...(!hasUserRow ? [{
          id: `job-${nextJob.id}-user`,
          kind: "user" as const,
          label: "用户输入",
          text: extractUserRequest(sourcePrompt ?? nextJob.prompt),
          time: timeNow(),
          jobId: nextJob.id,
          stage: nextJob.stage,
          targetStage: nextJob.target_stage || nextJob.stage
        }] : []),
        ...(!hasStatusRow ? [{
          id: `job-${nextJob.id}-status`,
          kind: "status" as const,
          label: "执行信息",
          text: statusText,
          time: timeNow(),
          jobId: nextJob.id,
          stage: nextJob.stage,
          targetStage: nextJob.target_stage || nextJob.stage
        }] : [])
      ].slice(-TRANSCRIPT_ROW_LIMIT);
      saveTranscriptRows(key, nextRows);
      return nextRows;
    });
  }, [currentTranscriptKey, project, targetFile]);

  useEffect(() => {
    if (!activeJobState) return;
    const recentEvents = recentAgentEvents(activeJobState.events);
    setJob(activeJobState.job);
    setEvents(recentEvents);
    lastEventIdRef.current = activeJobState.events.at(-1)?.id ?? 0;
    ensureJobRows(activeJobState.job, undefined, recentEvents);
    logPinnedToBottomRef.current = true;
  }, [activeJobState]);

  useEffect(() => {
    onBusyChange(running || submitting);
  }, [onBusyChange, running, submitting]);

  useEffect(() => {
    if (!job || terminalStatuses.has(job.status)) return;
    const activeJobId = job.id;
    let closed = false;
    const stream = new EventSource(`/api/agent/jobs/${activeJobId}/stream?after_id=${lastEventIdRef.current}`);
    stream.addEventListener("agent-event", (event) => {
      if (closed) return;
      const nextEvent = JSON.parse((event as MessageEvent).data) as AgentEvent;
      lastEventIdRef.current = nextEvent.id;
      setEvents((current) => recentAgentEvents([...current, nextEvent]));
    });
    stream.addEventListener("agent-done", () => {
      if (closed) return;
      closed = true;
      stream.close();
      void getAgentEvents(activeJobId, lastEventIdRef.current).then(async ({ events: nextEvents, job: nextJob }) => {
        if (nextEvents.length) {
          setEvents((current) => recentAgentEvents([...current, ...nextEvents]));
          lastEventIdRef.current = nextEvents.at(-1)?.id ?? lastEventIdRef.current;
        }
        setJob(nextJob);
        if (nextJob.status === "succeeded") await onCompletedRef.current();
        if (nextJob.status === "failed") {
          await onCreditsChangedRef.current();
          onErrorRef.current(nextJob.error_message || "Agent 执行失败");
        }
        await loadServerHistory();
      }).catch((err) => onErrorRef.current(err instanceof Error ? err.message : "读取 Agent 状态失败"));
    });
    return () => {
      closed = true;
      stream.close();
    };
  }, [job?.id, job?.status, loadServerHistory]);

  useEffect(() => {
    if (!job) return;
    const key = activeTranscriptKeyRef.current || (project ? transcriptStorageKey(project.id, "project") : "");
    if (!key) return;
    const nextText = runStatusText(job, events, submitting, targetFile);
    setConversationRows((currentRows) => {
      let changed = false;
      const nextRows = currentRows.map((row) => {
        if (row.kind !== "status" || row.jobId !== job.id) return row;
        if (row.text === nextText) return row;
        changed = true;
        return { ...row, text: nextText, time: timeNow() };
      });
      if (!nextRows.some((row) => row.kind === "status" && row.jobId === job.id)) {
        changed = true;
        nextRows.push({
          id: `job-${job.id}-status`,
          kind: "status",
          label: "执行信息",
          text: nextText,
          time: timeNow(),
          jobId: job.id,
          stage: job.stage,
          targetStage: job.target_stage || job.stage
        });
      }
      if (changed) saveTranscriptRows(key, nextRows);
      return changed ? nextRows.slice(-TRANSCRIPT_ROW_LIMIT) : currentRows;
    });
  }, [document, events, job, project, submitting, targetFile]);

  useEffect(() => {
    const log = logRef.current;
    if (!log || !logPinnedToBottomRef.current) return;
    window.requestAnimationFrame(() => {
      log.scrollTo({
        top: log.scrollHeight,
        behavior: "auto"
      });
    });
  }, [conversationRows]);

  const handleLogScroll = useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    logPinnedToBottomRef.current = isLogPinnedToBottom(log);
  }, []);

  const buildAgentPrompt = useCallback((userPrompt: string, includeAttachments: boolean) => {
    const attachmentText = includeAttachments && attachments.length
      ? `\n\n用户附件：\n${attachments.map((attachment) => (
        `## ${attachment.name}\n~~~text\n${attachment.content}\n~~~`
      )).join("\n\n")}`
      : "";
    const excerptText = labeledExcerpts.length
      ? `\n\n用户选取的项目文件片段：\n${labeledExcerpts.map(({ excerpt, label }) => (
        `## ${label}\n标签名称：${label}\n文件路径：${excerpt.file_path}\n~~~text\n${excerpt.content}\n~~~`
      )).join("\n\n")}`
      : "";
    const request = userPrompt.trim();
    if (!request && !attachmentText && !excerptText) return "";

    return `
用户请求：
${request || "（未输入文字）"}
${attachmentText}${excerptText}
`.trim();
  }, [attachments, labeledExcerpts]);

  const startJob = useCallback(async (
    stage: AgentStageChoice,
    userPrompt: string,
    includeAttachments: boolean,
    referenceCurrentFile?: boolean,
    manualInput?: string,
    regenerateCurrentFile?: boolean,
    optimizationScope?: "review_p0"
  ) => {
    if (!project || !document || !targetFile || archived || readOnly || running || submitting) return;
    const resolvedTargetStage = commandTargetStageRef.current ?? targetFile.stage;
    commandTargetStageRef.current = null;
    setSubmitting(true);
    try {
      const quote = await getAgentCreditQuote(project.id, stage, resolvedTargetStage);
      if (quote.concurrency.reached) {
        await onCreditsChanged();
        onError(quote.concurrency.message || "当前运行中的任务已满，请等待其中一个任务完成或取消后再试。");
        return;
      }
      if (!quote.affordable) {
        await onCreditsChanged();
        onError(`创作额度不足，本次需要 ${quote.credits} 额度，当前可用 ${quote.balance ?? 0} 额度。请联系管理员补充额度。`);
        return;
      }
      const nextJob = await createAgentJob(project.id, {
        stage,
        target_stage: resolvedTargetStage,
        prompt: buildAgentPrompt(userPrompt, includeAttachments),
        user_input: manualInput?.trim() || (stage === "chat_edit" ? userPrompt : undefined),
        reference_current_file: referenceCurrentFile,
        regenerate_current_file: regenerateCurrentFile,
        optimization_scope: optimizationScope
      });
      onJobStarted(nextJob);
      setJob(nextJob);
      setEvents([]);
      lastEventIdRef.current = 0;
      setPrompt("");
      setAttachments([]);
      onClearExcerpts();
      ensureJobRows(nextJob, userPrompt);
      logPinnedToBottomRef.current = true;
      await onCreditsChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Agent 任务创建失败";
      const existingJobId = runningJobIdFromMessage(message);
      if (existingJobId) {
        try {
          const { job: existingJob, events: existingEvents } = await getAgentEvents(existingJobId);
          const recentEvents = recentAgentEvents(existingEvents);
          setJob(existingJob);
          setEvents(recentEvents);
          lastEventIdRef.current = existingEvents.at(-1)?.id ?? 0;
          setPrompt("");
          setAttachments([]);
          onClearExcerpts();
          ensureJobRows(existingJob, undefined, recentEvents);
          logPinnedToBottomRef.current = true;
        } catch (attachErr) {
          onError(attachErr instanceof Error ? attachErr.message : message);
        }
        return;
      }
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }, [archived, buildAgentPrompt, document, ensureJobRows, onClearExcerpts, onCreditsChanged, onError, onJobStarted, project, readOnly, running, submitting, targetFile]);

  useEffect(() => {
    if (!command) return;
    if (readOnly) {
      onError("你只有查看权限，无法运行 Agent。");
      onCommandHandled(command.id);
      return;
    }
    if (archived) {
      onError("项目已归档，请先重新开启。");
      onCommandHandled(command.id);
      return;
    }
    if (running || submitting) {
      onError("Agent 正在执行中，请等待当前任务完成。");
      onCommandHandled(command.id);
      return;
    }
    commandTargetStageRef.current = command.targetStage ?? document?.stage ?? selectedFile?.stage ?? null;
    void startJob(
      command.stage,
      command.prompt,
      false,
      command.referenceCurrentFile,
      command.manualInput,
      command.regenerateCurrentFile,
      command.optimizationScope
    )
      .finally(() => onCommandHandled(command.id));
  }, [archived, command, document?.stage, onCommandHandled, onError, readOnly, running, selectedFile?.stage, startJob, submitting]);

  useEffect(() => {
    if (!promptDraft) return;
    setPrompt(promptDraft.text);
    window.requestAnimationFrame(() => {
      resizePromptInput();
      promptInputRef.current?.focus();
      promptInputRef.current?.setSelectionRange(promptDraft.text.length, promptDraft.text.length);
    });
    onPromptDraftHandled(promptDraft.id);
  }, [onPromptDraftHandled, promptDraft, resizePromptInput]);

  async function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    if (readOnly) return;
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const now = Date.now();
    const nextAttachments = await Promise.all(files.map(async (file, index) => ({
      id: now + index,
      name: file.name,
      content: (await file.text()).slice(0, 50000)
    })));
    setAttachments((current) => [...current, ...nextAttachments]);
    event.target.value = "";
  }

  function showExcerptPreview(excerpt: AgentDocumentExcerpt, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const placement = window.innerHeight - rect.bottom >= 60 ? "below" : "above";
    setExcerptPreview({
      id: excerpt.id,
      content: excerptPreviewText(excerpt.content),
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 372)),
      top: placement === "below" ? rect.bottom + 6 : rect.top - 6,
      placement
    });
  }

  async function handleSubmit() {
    if (readOnly) {
      onError("你只有查看权限，无法运行 Agent。");
      return;
    }
    if (hasUnsavedChanges) {
      onError("当前文档有未保存修改，请先保存");
      return;
    }
    if (!currentDocumentCanReceiveAdjustment) {
      onError(project?.task_type === "review"
        ? "待审剧本不可直接修改，请在审稿报告中补充复核重点"
        : "请通过项目设置更新原始剧本和任务需求");
      return;
    }
    if (!canSend) return;
    await startJob("chat_edit", prompt, true);
  }

  async function handleCancel() {
    if (readOnly) {
      onError("你只有查看权限，无法取消任务。");
      return;
    }
    if (!job || terminalStatuses.has(job.status)) return;
    try {
      setJob(await cancelAgentJob(job.id));
      await onCreditsChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "取消任务失败");
    }
  }

  async function handleRetry(jobId: number) {
    if (readOnly) {
      onError("你只有查看权限，无法重试任务。");
      return;
    }
    if (hasUnsavedChanges) {
      onError("当前文档有未保存修改，请先保存");
      return;
    }
    if (archived) {
      onError("项目已归档，请先重新开启。");
      return;
    }
    if (running || submitting) return;
    setSubmitting(true);
    try {
      const source = conversationRows.find((row) => row.jobId === jobId);
      const quote = project ? await getAgentCreditQuote(project.id, "chat_edit", source?.targetStage ?? source?.stage) : null;
      if (quote?.concurrency.reached) {
        await onCreditsChanged();
        onError(quote.concurrency.message || "当前运行中的任务已满，请等待其中一个任务完成或取消后再试。");
        return;
      }
      if (quote && !quote.affordable) {
        await onCreditsChanged();
        onError(`创作额度不足，重试需要 ${quote.credits} 额度，当前可用 ${quote.balance ?? 0} 额度。请联系管理员补充额度。`);
        return;
      }
      const nextJob = await retryAgentJob(jobId);
      setJob(nextJob);
      setEvents([]);
      lastEventIdRef.current = 0;
      ensureJobRows(nextJob);
      logPinnedToBottomRef.current = true;
      await onCreditsChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : "重试任务失败";
      const existingJobId = runningJobIdFromMessage(message);
      if (existingJobId) {
        try {
          const { job: existingJob, events: existingEvents } = await getAgentEvents(existingJobId);
          const recentEvents = recentAgentEvents(existingEvents);
          setJob(existingJob);
          setEvents(recentEvents);
          lastEventIdRef.current = existingEvents.at(-1)?.id ?? 0;
          ensureJobRows(existingJob, undefined, recentEvents);
          logPinnedToBottomRef.current = true;
        } catch (attachErr) {
          onError(attachErr instanceof Error ? attachErr.message : message);
        }
        return;
      }
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOpenDebug() {
    if (!canDebug || !job) return;
    const debugWindow = window.open("about:blank", "_blank");
    if (!debugWindow) {
      onError("浏览器阻止了调试日志窗口，请允许新窗口后重试。");
      return;
    }
    debugWindow.opener = null;
    debugWindow.document.title = "ZDebug";
    debugWindow.document.body.textContent = "正在打开调试日志...";
    setDebugLoading(true);
    try {
      const debugUrl = debugSessionUrl(await startAgentDebug(job.id));
      if (!debugUrl) throw new Error("无法获取调试日志地址");
      debugWindow.location.replace(debugUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "启动调试日志失败";
      if (!debugWindow.closed) debugWindow.document.body.textContent = message;
      onError(message);
    } finally {
      setDebugLoading(false);
    }
  }

  async function handleOpenPreferences() {
    setPreferencesOpen(true);
    setPreferencesLoading(true);
    setPreferencesError("");
    setEffectivePreferences([]);
    try {
      const payload = await getWriterPreferences();
      if (!preferenceStage) return;
      setEffectivePreferences(payload.preferences.filter((item) => (
        item.enabled && (item.scopes.includes("global") || item.scopes.includes(preferenceStage))
      )));
    } catch (err) {
      setPreferencesError(err instanceof Error ? err.message : "读取创作偏好失败");
    } finally {
      setPreferencesLoading(false);
    }
  }

  return (
    <section className={`glass-panel agent-panel${minimized ? " minimized" : ""}`}>
      <button
        className="agent-resize-handle"
        type="button"
        aria-label="拖动调整 Agent 面板高度"
        title="拖动调整 Agent 面板高度"
        onPointerDown={onResizeStart}
      >
        <Ellipsis size={18} />
      </button>
      {!minimized ? (
        <div className="agent-log-shell">
          <div className="agent-log-toolbar">
            <div className="agent-live-activity" title={liveActivity}>
              <i className={running || submitting ? "loading-dot" : job?.status === "failed" ? "error-dot" : "check-dot"} />
              <span>{liveActivity}</span>
            </div>
            <div className="agent-toolbar-actions">
              {targetFile?.stage === "project_init" ? (
                <button
                  className={`agent-debug-button${briefLoading ? " loading" : ""}`}
                  type="button"
                  aria-label="查看任务需求"
                  title="任务需求"
                  disabled={!document || briefLoading}
                  onClick={onOpenDistributionBrief}
                >
                  {briefLoading ? <Loader2 size={15} /> : <ClipboardList size={15} />}
                </button>
              ) : null}
              <button
                ref={preferencesButtonRef}
                className={`agent-debug-button${preferencesLoading ? " loading" : ""}`}
                type="button"
                aria-label="查看当前阶段应用的创作偏好"
                title="查看当前阶段应用的创作偏好"
                disabled={!document || preferencesLoading}
                onClick={() => void handleOpenPreferences()}
              >
                {preferencesLoading ? <Loader2 size={15} /> : <SlidersHorizontal size={15} />}
              </button>
              {canDebug ? (
                <button
                  className={`agent-debug-button${debugLoading ? " loading" : ""}`}
                  type="button"
                  aria-label="打开 ZDebug 调试日志"
                  title={job ? "打开 ZDebug 调试日志" : "启动 Agent 任务后可打开调试日志"}
                  disabled={!job || debugLoading}
                  onClick={() => void handleOpenDebug()}
                >
                  {debugLoading ? <Loader2 size={15} /> : <Bug size={15} />}
                </button>
              ) : null}
            </div>
          </div>
          <div className="agent-log" ref={logRef} onScroll={handleLogScroll}>
            {conversationRows.length ? conversationRows.map((row) => {
              const rowRunning = row.kind === "status" && job?.id === row.jobId && (running || submitting);
              const rowFailed = row.kind === "status" && job?.id === row.jobId && job?.status === "failed";
              return (
                <article
                  className={`agent-conversation-row ${row.kind}${rowRunning ? " running" : ""}${rowFailed ? " failed" : ""}`}
                  key={row.id}
                >
                  <time>{row.time}</time>
                  <strong>{row.label}</strong>
                  <div className="agent-conversation-message">
                    <span title={row.text}>{row.text}</span>
                    {rowFailed ? (
                      <button
                        className="agent-retry-link"
                        type="button"
                        disabled={readOnly || running || submitting || Boolean(creditsManaged && creditBalance !== null && creditBalance !== undefined && creditCostForStage(creditPrices, row.targetStage ?? row.stage) !== null && creditBalance < Number(creditCostForStage(creditPrices, row.targetStage ?? row.stage)))}
                        title={creditsManaged && creditBalance !== null && creditBalance !== undefined && creditCostForStage(creditPrices, row.targetStage ?? row.stage) !== null && creditBalance < Number(creditCostForStage(creditPrices, row.targetStage ?? row.stage)) ? `额度不足，当前可用 ${creditBalance} 额度` : "重新执行本次任务"}
                        onClick={() => void handleRetry(row.jobId!)}
                      >
                        {creditsManaged && creditBalance !== null && creditBalance !== undefined && creditCostForStage(creditPrices, row.targetStage ?? row.stage) !== null && creditBalance < Number(creditCostForStage(creditPrices, row.targetStage ?? row.stage)) ? "额度不足" : "点击重试"}
                        {creditCostForStage(creditPrices, row.targetStage ?? row.stage) !== null ? (
                          <small>{creditCostForStage(creditPrices, row.targetStage ?? row.stage)}额度</small>
                        ) : null}
                      </button>
                    ) : null}
                  </div>
                  <i className={rowFailed ? "error-dot" : rowRunning ? "loading-dot" : "check-dot"} />
                </article>
              );
            }) : (
              <div className="agent-empty-log">
                <Bot size={18} />
                <span>{document ? "等待当前文档的对话请求。" : "先选择一个项目文件。"}</span>
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className={`agent-composer${hasContextItems ? " has-context" : ""}`}>
        {hasContextItems ? (
          <div className="agent-context-row">
            {attachments.map((attachment) => (
              <span className="agent-attachment-chip" key={attachment.id}>
                <Paperclip size={13} />
                <span title={attachment.name}>{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`移除附件${attachment.name}`}
                  title={`移除附件${attachment.name}`}
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {labeledExcerpts.map(({ excerpt, label }) => (
              <span
                className="agent-excerpt-chip"
                key={excerpt.id}
                tabIndex={0}
                onMouseEnter={(event) => showExcerptPreview(excerpt, event.currentTarget)}
                onMouseLeave={() => setExcerptPreview((current) => current?.id === excerpt.id ? null : current)}
                onFocus={(event) => showExcerptPreview(excerpt, event.currentTarget)}
                onBlur={() => setExcerptPreview((current) => current?.id === excerpt.id ? null : current)}
              >
                <MessageSquareText size={13} />
                <span>{label}</span>
                <button
                  type="button"
                  aria-label={`移除${label}`}
                  title={`移除${label}`}
                  onClick={() => {
                    setExcerptPreview(null);
                    onRemoveExcerpt(excerpt.id);
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={promptInputRef}
          className="agent-prompt-input"
          rows={1}
          placeholder={adjustmentPlaceholder}
          value={prompt}
          disabled={!project || archived || readOnly || running || !currentDocumentCanReceiveAdjustment}
          onChange={(event) => {
            setPrompt(event.target.value);
            window.requestAnimationFrame(resizePromptInput);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <div className="agent-composer-footer">
          <div className="agent-composer-footer-left">
            <div className="agent-file-picker" ref={fileMenuRef}>
              <button
                type="button"
                className="agent-file-picker-trigger"
                aria-haspopup="listbox"
                aria-expanded={fileMenuOpen}
                title="选择要调整的项目文件"
                disabled={!project || archived || readOnly || running || submitting}
                onClick={() => setFileMenuOpen((open) => !open)}
              >
                <FileText size={15} />
                <span>{targetFile?.name ?? "选择项目文件"}</span>
                <ChevronDown size={14} />
              </button>
              {fileMenuOpen ? (
                <div className="agent-file-menu" role="listbox" aria-label="要调整的项目文件">
                  {files.map((file) => {
                    const selectable = agentFileCanReceiveAdjustment(project, file);
                    const reason = agentFileDisabledReason(project, file);
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={file.stage === targetFile?.stage}
                        key={file.stage}
                        disabled={!selectable}
                        title={selectable ? `调整${file.name}` : reason}
                        onClick={() => {
                          setTargetStage(file.stage);
                          setFileMenuOpen(false);
                          promptInputRef.current?.focus();
                        }}
                      >
                        <span>{file.name}</span>
                        {file.stage === targetFile?.stage ? <Check size={14} /> : reason ? <small>{reason}</small> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <input
              ref={fileInputRef}
              className="agent-file-input"
              type="file"
              multiple
              onChange={(event) => void handleAttachmentChange(event)}
            />
            <button
              className="attachment-button"
              aria-label="上传附件"
              title="上传附件"
              disabled={!project || archived || readOnly || running || submitting || !currentDocumentCanReceiveAdjustment}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={17} />
            </button>
          </div>
          <div className="agent-composer-footer-right">
            {adjustmentCreditCost !== null && !running ? (
              <span className={`agent-credit-note${adjustmentCreditInsufficient ? " insufficient" : ""}`} title={adjustmentCreditInsufficient ? `额度不足：需要 ${adjustmentCreditCost}，当前可用 ${creditBalance ?? 0}` : `本次调整会消耗 ${adjustmentCreditCost} 额度`}>
                <Coins size={14} />{adjustmentCreditInsufficient ? `额度不足 · 可用 ${creditBalance ?? 0}` : `${adjustmentCreditCost}额度`}
              </span>
            ) : null}
            <button
              className="send-button"
              aria-label={running ? "取消当前任务" : adjustmentCreditCost !== null ? `发送调整要求，消耗 ${adjustmentCreditCost} 额度` : "发送调整要求"}
              title={running ? "取消当前任务" : adjustmentCreditCost !== null ? `发送调整要求，消耗 ${adjustmentCreditCost} 额度` : "shift+enter发送"}
              disabled={!project || archived || readOnly || submitting || (!running && (!canSend || adjustmentCreditInsufficient))}
              onClick={() => running ? void handleCancel() : void handleSubmit()}
            >
              {running ? <Square size={18} /> : <Send size={18} />}
            </button>
          </div>
        </div>
      </div>
      {excerptPreview && typeof window !== "undefined" ? createPortal(
        <div
          className={`agent-excerpt-preview ${excerptPreview.placement}`}
          role="tooltip"
          style={{ left: excerptPreview.left, top: excerptPreview.top }}
        >
          {excerptPreview.content}
        </div>,
        window.document.body
      ) : null}
      {preferencesOpen ? (
        <div className="z-debug-backdrop" role="dialog" aria-modal="true" aria-labelledby="applied-preferences-title">
          <section className="applied-preferences-modal">
            <header className="z-debug-header">
              <div>
                <strong id="applied-preferences-title">当前阶段的创作偏好</strong>
                <span>{preferenceStageName}</span>
              </div>
              <div className="z-debug-actions">
                <button ref={preferencesCloseRef} type="button" aria-label="关闭创作偏好" onClick={() => setPreferencesOpen(false)}>
                  <X size={16} />
                </button>
              </div>
            </header>
            <div className="applied-preferences-body">
              {preferencesLoading ? <div className="z-debug-state"><Loader2 size={18} /><span>正在读取创作偏好...</span></div> : null}
              {!preferencesLoading && preferencesError ? <div className="z-debug-state error">{preferencesError}</div> : null}
              {!preferencesLoading && !preferencesError && !preferenceStage ? (
                <div className="applied-preferences-empty">原始剧本阶段不应用长期创作偏好。</div>
              ) : null}
              {!preferencesLoading && !preferencesError && preferenceStage && !effectivePreferences.length ? (
                <div className="applied-preferences-empty">当前阶段暂无已启用的创作偏好。</div>
              ) : null}
              {!preferencesLoading && !preferencesError && effectivePreferences.length ? (
                <ul className="applied-preferences-list" aria-label="已启用的创作偏好">
                  {effectivePreferences.map((item) => <li key={item.id}>
                    <span className={`applied-preferences-source ${item.is_system_preference ? "system" : "personal"}`}>
                      {item.is_system_preference ? "系统" : "我的"}
                    </span>
                    <p>{item.content}</p>
                  </li>)}
                </ul>
              ) : null}
            </div>
            <footer className="applied-preferences-footer">
              <a href={`/preferences?scope=${preferenceStage ?? "global"}#scope-${preferenceStage ?? "global"}`}>
                管理我的偏好
              </a>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
