"use client";

import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleHelp, History, X } from "lucide-react";
import { AgentPanel, type AgentActiveJobState, type AgentPromptDraft, type AgentRunCommand } from "@/components/workspace/agent-panel";
import { CreditCenterDialog } from "@/components/workspace/credit-center-dialog";
import { DocumentCommentPanel, type PendingDocumentComment } from "@/components/workspace/document-comments";
import { DistributionBriefDialog } from "@/components/workspace/distribution-brief-dialog";
import { FileRail } from "@/components/workspace/file-rail";
import { FileVersionDialog } from "@/components/workspace/file-version-dialog";
import { MarkdownWorkspace } from "@/components/workspace/markdown-workspace";
import { NewProjectForm } from "@/components/workspace/new-project-form";
import { NovelAnalysisWorkspace } from "@/components/workspace/novel-analysis-workspace";
import { ProjectList } from "@/components/workspace/project-list";
import { ConfirmationDialog, ProjectTrashDialog } from "@/components/workspace/project-trash-dialog";
import { QualityIssuesDialog } from "@/components/workspace/quality-issues-dialog";
import { StageApprovalNoticeDialog } from "@/components/workspace/stage-approval-notice-dialog";
import { SystemNotificationDialog } from "@/components/workspace/system-notification-dialog";
import { WorldViewWorkspace } from "@/components/workspace/world-view-workspace";
import { PageLoading } from "@/components/ui/page-loading";
import { TextInputDialog } from "@/components/ui/text-input-dialog";
import { PROJECT_SCENARIOS } from "@/lib/project-scenarios";
import {
  archiveProject,
  approveStage,
  createProject,
  createDocumentComment,
  deleteDocumentCommentMessage,
  deleteProject,
  getActiveAgentJob,
  getCreditSummary,
  getDocumentComments,
  getDistributionBrief,
  getFile,
  getFiles,
  getMe,
  getNotifications,
  getProjectInitialization,
  getProjects,
  getScriptTagTaxonomy,
  getTargetRegions,
  getTrashedProjects,
  logout,
  markNotificationRead,
  permanentlyDeleteProject,
  restoreProject,
  reopenProject,
  reinitializeProject,
  replyToDocumentComment,
  saveFile,
  updateOutlineTitle,
  updateProject
} from "@/lib/api-client";
import { isApiError } from "@/lib/api-error";
import type { AgentDocumentExcerpt, AgentJob, AgentStageChoice, CreditSummary, DistributionBriefSnapshot, DocumentCommentAnchor, DocumentCommentLayout, DocumentCommentThread, Notification, NovelAnalysis, NovelAnalysisSection, Project, ProjectInitialization, ProjectReinitializeInput, ScriptTagTaxonomy, StageDocument, StageFile, TargetRegion, TrashedProject, User, WorldView } from "@/lib/types";

type MarkdownMode = "preview" | "markdown";
type CharacterWorkspaceView = "profile" | "graph";

const AGENT_MIN_HEIGHT = 102;
const AGENT_CONTEXT_MIN_HEIGHT = 140;
const AGENT_DEFAULT_HEIGHT = 190;
const AGENT_MAX_HEIGHT = 560;
const PROJECT_PANEL_MIN_WIDTH = 220;
const PROJECT_PANEL_DEFAULT_WIDTH = 240;
const PROJECT_PANEL_MAX_WIDTH = 480;
const PROJECT_PANEL_WIDTH_STORAGE_KEY = "orca-workspace-project-panel-width-preference";
const TRASH_PAGE_SIZE = 10;
const EMPTY_DOCUMENT_COMMENT_LAYOUT: DocumentCommentLayout = {
  anchorTops: {},
  contentHeight: 0,
  scrollTop: 0,
  viewportTop: 0
};
const RUNNABLE_STAGES = new Set<AgentStageChoice>([
  "novel_analysis",
  "world_view",
  "outline_rewrite",
  "character_rewrite",
  "trial_generate",
  "full_generate",
  "dialogue_translate",
  "foreign_review",
  "humanizer_zh"
]);
const GENERATING_STAGE_STATUSES = new Set(["in_progress", "queued", "running"]);
const ADVANCE_READY_STAGE_STATUSES = new Set(["completed", "awaiting_approval", "approved", "needs_revision"]);
const APPROVAL_STAGE_KEYS = new Set(["trial_generate", "foreign_review"]);

type FileActionState = {
  disabled: boolean;
  tooltip: string;
};

type OutlineTitleSync = {
  title: string;
  englishTitle: string;
};

type PendingOutlineTitleExport = OutlineTitleSync & {
  url: string;
  expectedHash: string;
};

function startFileDownload(url: string) {
  window.location.assign(url);
}

function isGeneratingStageFile(file: StageFile | null | undefined) {
  return Boolean(file && GENERATING_STAGE_STATUSES.has(file.status));
}

function canRestoreStageFile(file: StageFile) {
  return file.clickable || isGeneratingStageFile(file);
}

function pendingStageContent(file: StageFile) {
  return `# ${file.name}

正在生成内容。

完成后这里会自动显示。`;
}

function worldViewFromDraft(draft: string, document: StageDocument | null): WorldView {
  const fallback = document?.world_view ?? { "世界观描述": "", "关键概念映射": [] };
  try {
    const parsed = JSON.parse(draft) as Partial<WorldView>;
    const mappings = Array.isArray(parsed["关键概念映射"])
      ? parsed["关键概念映射"].flatMap((mapping) => {
        if (!mapping || typeof mapping !== "object") return [];
        return [{
          "原剧本概念": typeof mapping["原剧本概念"] === "string" ? mapping["原剧本概念"] : "",
          "映射后概念": typeof mapping["映射后概念"] === "string" ? mapping["映射后概念"] : "",
        }];
      })
      : fallback["关键概念映射"];
    return {
      "世界观描述": typeof parsed["世界观描述"] === "string" ? parsed["世界观描述"] : fallback["世界观描述"],
      "关键概念映射": mappings,
    };
  } catch {
    return fallback;
  }
}

const EMPTY_NOVEL_ANALYSIS: NovelAnalysis = {
  "基础信息": {
    "小说名称": "",
    "小说梗概": "",
    "题材": [],
    "基调": ""
  },
  "核心卖点": "",
  "故事主线": "",
  "世界观": "",
  "关键人物": [],
  "剧情单元": []
};

function novelAnalysisFromDraft(draft: string, document: StageDocument | null): NovelAnalysis {
  const fallback = document?.novel_analysis ?? EMPTY_NOVEL_ANALYSIS;
  try {
    const parsed = JSON.parse(draft) as Partial<NovelAnalysis>;
    const basicInfo = parsed["基础信息"];
    return {
      "基础信息": basicInfo && typeof basicInfo === "object" && !Array.isArray(basicInfo)
        ? {
          "小说名称": typeof basicInfo["小说名称"] === "string" ? basicInfo["小说名称"] : fallback["基础信息"]["小说名称"],
          "小说梗概": typeof basicInfo["小说梗概"] === "string" ? basicInfo["小说梗概"] : fallback["基础信息"]["小说梗概"],
          "题材": Array.isArray(basicInfo["题材"])
            ? basicInfo["题材"].filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
            : [],
          "基调": typeof basicInfo["基调"] === "string" ? basicInfo["基调"] : fallback["基础信息"]["基调"]
        }
        : fallback["基础信息"],
      "核心卖点": typeof parsed["核心卖点"] === "string" ? parsed["核心卖点"] : fallback["核心卖点"],
      "故事主线": typeof parsed["故事主线"] === "string" ? parsed["故事主线"] : fallback["故事主线"],
      "世界观": typeof parsed["世界观"] === "string" ? parsed["世界观"] : fallback["世界观"],
      "关键人物": Array.isArray(parsed["关键人物"])
        ? parsed["关键人物"].flatMap((item) => (
          item && typeof item === "object" && typeof item["人物名称"] === "string" && typeof item["人物画像"] === "string"
            ? [{ "人物名称": item["人物名称"], "人物画像": item["人物画像"] }]
            : []
        ))
        : fallback["关键人物"],
      "剧情单元": Array.isArray(parsed["剧情单元"]) ? parsed["剧情单元"] : fallback["剧情单元"]
    };
  } catch {
    return fallback;
  }
}

function saveErrorMessage(error: unknown) {
  const issues = isApiError(error) && Array.isArray(error.details?.issues)
    ? error.details.issues.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  if (issues.length) return `请完善后再保存：${issues.join("；")}`;
  return error instanceof Error ? error.message : "保存失败";
}

function markStageGenerating(files: StageFile[], stage: string) {
  return files.map((file) => ({
    ...file,
    current: file.stage === stage,
    clickable: file.stage === stage ? true : file.clickable,
    status: file.stage === stage ? "in_progress" : file.status
  }));
}

function qualityIssueKey(projectId: number, file: StageFile) {
  return `${projectId}:${file.stage}:${file.updated_at ?? ""}:${(file.quality_warnings ?? []).join("|")}`;
}

function clampProjectPanelWidth(width: number) {
  return Math.max(PROJECT_PANEL_MIN_WIDTH, Math.min(PROJECT_PANEL_MAX_WIDTH, width));
}

function qualityRepairPrompt(file: StageFile) {
  const issues = (file.quality_warnings ?? [])
    .map((warning, index) => `${index + 1}. ${warning}`)
    .join("；");
  return `请修复当前「${file.name}」中的以下问题，只修改必要内容并保留已经正确的内容：${issues}。修复完成后保存当前文档。`;
}

function stageFileLabel(file: StageFile) {
  return `「${file.name}」`;
}

function stageFileListLabel(files: StageFile[]) {
  return files.map(stageFileLabel).join("、");
}

function pendingAgentActionTooltip(agentBusy: boolean, agentCommand: AgentRunCommand | null) {
  if (agentCommand) return "系统正在准备启动任务，请稍候，任务状态更新后再操作。";
  if (agentBusy) return "当前 Agent 正在执行。请等待任务完成、失败或取消后再操作。";
  return null;
}

function regenerateActionState({
  selectedProject,
  selectedFile,
  currentRunnableStage,
  projectReadOnly,
  projectArchived,
  agentBusy,
  agentCommand,
  reinitializeBusy
}: {
  selectedProject: Project | null;
  selectedFile: StageFile | null;
  currentRunnableStage: AgentStageChoice | null;
  projectReadOnly: boolean;
  projectArchived: boolean;
  agentBusy: boolean;
  agentCommand: AgentRunCommand | null;
  reinitializeBusy: boolean;
}): FileActionState {
  if (!selectedProject) {
    return { disabled: true, tooltip: "当前没有打开的项目。请先选择或新建一个项目。" };
  }
  if (projectReadOnly) {
    return { disabled: true, tooltip: "你只有查看权限，不能重新生成内容。请联系项目所有者获取编辑权限。" };
  }
  if (projectArchived) {
    return { disabled: true, tooltip: "项目已归档，不能重新生成。请先点击“重新开启”恢复项目。" };
  }
  const pendingTooltip = pendingAgentActionTooltip(agentBusy, agentCommand);
  if (pendingTooltip) return { disabled: true, tooltip: pendingTooltip };
  if (reinitializeBusy) {
    return { disabled: true, tooltip: "任务设置正在更新。请等待更新完成后再重新生成。" };
  }
  if (!selectedFile) {
    return { disabled: true, tooltip: "请先选择一个文件，再决定是否重新生成。" };
  }
  if (selectedFile.stage === "project_init") {
    return {
      disabled: false,
      tooltip: "打开任务设置。更新任务需求后，系统会按新设置重新生成项目内容。"
    };
  }
  if (!currentRunnableStage) {
    return {
      disabled: true,
      tooltip: `${stageFileLabel(selectedFile)}不能在这里重新生成。请选择可生成的阶段，或回到“原始剧本”重新设置任务。`
    };
  }
  return {
    disabled: false,
    tooltip: `打开重新生成窗口。填写原因后，系统会重新生成${stageFileLabel(selectedFile)}。`
  };
}

function unavailableNextActionTooltip(file: StageFile) {
  if (GENERATING_STAGE_STATUSES.has(file.status)) {
    return `${stageFileLabel(file)}正在生成。请等待生成完成后再继续。`;
  }
  if (file.status === "stale") {
    return `${stageFileLabel(file)}的上游内容已变更。请点击“重新生成”更新当前文件后再继续。`;
  }
  if (file.status === "pending") {
    return `${stageFileLabel(file)}尚未生成。请点击“重新生成”完成当前阶段后再继续。`;
  }
  return `${stageFileLabel(file)}尚未达到可继续状态。请先完成或重新生成当前文件。`;
}

function needsRevisionTooltip(file: StageFile) {
  if (file.quality_warnings?.length) {
    return `打开问题处理面板。你可以选择 AI 修复或手动修改${stageFileLabel(file)}。`;
  }
  return `${stageFileLabel(file)}未通过检查，但没有收到具体问题明细。请重新生成当前文件后再试。`;
}

function foreignReviewDecisionTooltip(file: StageFile, files: StageFile[]) {
  const stage = file.review_decision?.revision_stage;
  const target = stage ? files.find((item) => item.stage === stage) : null;
  const targetLabel = target ? stageFileLabel(target) : "相关内容";
  return `海外审稿建议调整${targetLabel}。请查看审稿报告，再在对应文件中手动重新生成；调整完成后重新生成审稿报告。`;
}

function primaryStageActionState({
  selectedProject,
  selectedFile,
  files,
  nextStageFile,
  nextRunnableStage,
  primaryAction,
  dirty,
  projectReadOnly,
  agentBusy,
  agentCommand
}: {
  selectedProject: Project | null;
  selectedFile: StageFile | null;
  files: StageFile[];
  nextStageFile: StageFile | null;
  nextRunnableStage: AgentStageChoice | null;
  primaryAction: "next" | "archive" | "reopen" | "optimize-p0";
  dirty: boolean;
  projectReadOnly: boolean;
  agentBusy: boolean;
  agentCommand: AgentRunCommand | null;
}): FileActionState {
  if (!selectedProject) {
    return { disabled: true, tooltip: "当前没有打开的项目。请先选择或新建一个项目。" };
  }
  if (projectReadOnly) {
    return { disabled: true, tooltip: "你只有查看权限，不能推进项目。请联系项目所有者获取编辑权限。" };
  }
  const pendingTooltip = pendingAgentActionTooltip(agentBusy, agentCommand);
  if (pendingTooltip) return { disabled: true, tooltip: pendingTooltip };

  if (primaryAction === "reopen") {
    return {
      disabled: false,
      tooltip: "重新开启项目。项目会恢复为进行中，可以继续编辑和运行任务。"
    };
  }

  if (primaryAction === "archive") {
    const translatingOnly = selectedProject.task_type === "translate" && selectedFile?.stage === "dialogue_translate";
    const humanizingOnly = selectedProject.task_type === "humanize" && selectedFile?.stage === "humanizer_zh";
    if (dirty) {
      return {
        disabled: true,
        tooltip: translatingOnly
          ? "台词译稿有未保存修改。请先保存，或取消修改后再归档。"
          : humanizingOnly
            ? "润色剧本有未保存修改。请先保存，或取消修改后再归档。"
            : "审稿报告有未保存修改。请先保存，或取消修改后再归档。"
      };
    }
    if (translatingOnly || humanizingOnly) {
      if (selectedFile?.status !== "completed") {
        return {
          disabled: true,
          tooltip: translatingOnly ? "台词翻译尚未完成。请先完成台词译稿再归档。" : "剧本润色尚未完成。请先完成润色剧本再归档。"
        };
      }
    } else if (!selectedFile || selectedFile.status !== "approved") {
      return { disabled: true, tooltip: "审稿报告尚未确认。请完成审稿并点击“确认并继续”后再归档。" };
    }
    return {
      disabled: false,
      tooltip: "打开归档确认。归档不会删除内容，之后仍可重新开启项目。"
    };
  }

  if (primaryAction === "optimize-p0") {
    if (dirty) {
      return { disabled: true, tooltip: "审稿报告有未保存修改。请先保存，或取消修改后再优化。" };
    }
    const fullScript = files.find((file) => file.stage === "full_generate");
    if (!fullScript?.exists) {
      return { disabled: true, tooltip: "完整剧本尚未生成，暂时无法一键优化。" };
    }
    return {
      disabled: false,
      tooltip: "在完整剧本中，优化所有 P0 级别的优化建议"
    };
  }

  if (dirty) {
    return { disabled: true, tooltip: "当前文件有未保存修改。请先保存，或取消修改后再继续。" };
  }
  if (!selectedFile) {
    return { disabled: true, tooltip: "请先选择一个可查看的文件。" };
  }
  if (selectedFile.document_sync_pending) {
    if (!nextStageFile) {
      return {
        disabled: true,
        tooltip: `${stageFileLabel(selectedFile)}的修改尚待更新。请点击“重新生成”更新当前文件后再继续。`
      };
    }
    if (!nextRunnableStage) {
      return {
        disabled: true,
        tooltip: `下一阶段${stageFileLabel(nextStageFile)}暂不能自动处理。请打开该文件查看状态。`
      };
    }
    return {
      disabled: false,
      tooltip: `系统会先更新当前已保存的修改，然后开始处理${stageFileLabel(nextStageFile)}。`
    };
  }
  if (!ADVANCE_READY_STAGE_STATUSES.has(selectedFile.status)) {
    return { disabled: true, tooltip: unavailableNextActionTooltip(selectedFile) };
  }

  if (selectedFile.status === "awaiting_approval") {
    if (!APPROVAL_STAGE_KEYS.has(selectedFile.stage)) {
      return {
        disabled: true,
        tooltip: `${stageFileLabel(selectedFile)}当前不支持确认。请重新生成，或联系管理员处理该阶段状态。`
      };
    }
    if (selectedFile.stage === "foreign_review") {
      return {
        disabled: false,
        tooltip: "确认审稿报告。确认后可归档项目。"
      };
    }
    const subsequentFiles = files.filter((file) => file.index > selectedFile.index && file.exists);
    if (subsequentFiles.length) {
      return {
        disabled: false,
        tooltip: `确认${stageFileLabel(selectedFile)}。后续的${stageFileListLabel(subsequentFiles)}已有内容，系统只确认当前文件，不会自动继续生成；如需更新，请在相应文件中点击“重新生成”。`
      };
    }
    if (!nextStageFile) {
      return { disabled: true, tooltip: "当前试稿没有可继续的下一阶段。请检查项目文件后再试。" };
    }
    if (!nextRunnableStage) {
      return {
        disabled: true,
        tooltip: `下一阶段${stageFileLabel(nextStageFile)}不能自动处理。请打开该文件查看状态。`
      };
    }
    return {
      disabled: false,
      tooltip: `确认${stageFileLabel(selectedFile)}，然后开始生成${stageFileLabel(nextStageFile)}。`
    };
  }

  if (
    selectedFile.status === "needs_revision"
    && !selectedFile.document_sync_pending
    && (selectedFile.stage === "foreign_review" || nextStageFile)
  ) {
    return {
      disabled: false,
      tooltip: needsRevisionTooltip(selectedFile)
    };
  }

  if (
    selectedFile.stage === "foreign_review"
    && selectedFile.review_decision?.outcome === "revision_requested"
  ) {
    return {
      disabled: true,
      tooltip: foreignReviewDecisionTooltip(selectedFile, files)
    };
  }

  if (!nextStageFile) {
    if (selectedFile.stage === "foreign_review") {
      return {
        disabled: true,
        tooltip: selectedFile.document_sync_pending
          ? "审稿报告的修改已保存，仍需重新检查。请点击“重新生成”后再继续。"
          : "审稿报告尚未处于可确认或归档状态。请重新生成并完成审稿后再继续。"
      };
    }
    return { disabled: true, tooltip: `${stageFileLabel(selectedFile)}之后没有下一阶段，无法继续。` };
  }

  if (["completed", "awaiting_approval", "approved"].includes(nextStageFile.status) && nextStageFile.clickable) {
    return {
      disabled: false,
      tooltip: `打开${stageFileLabel(nextStageFile)}。系统会保留已有内容，不会重新生成。`
    };
  }
  if (!nextRunnableStage) {
    return {
      disabled: true,
      tooltip: `下一阶段${stageFileLabel(nextStageFile)}暂不能自动处理。请先打开该文件查看状态。`
    };
  }
  return { disabled: false, tooltip: `开始处理${stageFileLabel(nextStageFile)}。` };
}

export default function WorkspacePage() {
  const commentContentScrollElementRef = useRef<HTMLElement | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const allowedScenarioKeys = useMemo(
    () => user ? PROJECT_SCENARIOS
      .filter((scenario) => user.permissions.includes(`scenario:${scenario.key}`))
      .map((scenario) => scenario.key) : undefined,
    [user]
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [unreadSystemNotifications, setUnreadSystemNotifications] = useState<Notification[]>([]);
  const [systemNotificationDialog, setSystemNotificationDialog] = useState<Notification | null>(null);
  const [creditSummary, setCreditSummary] = useState<CreditSummary | null>(null);
  const [creditCenterOpen, setCreditCenterOpen] = useState(false);
  const [targetRegions, setTargetRegions] = useState<TargetRegion[]>([]);
  const [scriptTagTaxonomy, setScriptTagTaxonomy] = useState<ScriptTagTaxonomy>({
    theme: [],
    setting: [],
    background: [],
    audience: []
  });
  const [userLoaded, setUserLoaded] = useState(false);
  const [regionsLoaded, setRegionsLoaded] = useState(false);
  const [scriptTagsLoaded, setScriptTagsLoaded] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<StageFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<StageFile | null>(null);
  const [document, setDocument] = useState<StageDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<MarkdownMode>("preview");
  const [characterView, setCharacterView] = useState<CharacterWorkspaceView>("profile");
  const [novelAnalysisSection, setNovelAnalysisSection] = useState<NovelAnalysisSection>("basic");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCountdown, setErrorCountdown] = useState(0);
  const [projectPanelCollapsed, setProjectPanelCollapsed] = useState(false);
  const [projectPanelWidth, setProjectPanelWidth] = useState(PROJECT_PANEL_DEFAULT_WIDTH);
  const [projectPanelResizing, setProjectPanelResizing] = useState(false);
  const [filePanelCollapsed, setFilePanelCollapsed] = useState(false);
  const [documentComments, setDocumentComments] = useState<DocumentCommentThread[]>([]);
  const [activeCommentId, setActiveCommentId] = useState<number | null>(null);
  const [commentNavigationTarget, setCommentNavigationTarget] = useState<{ threadId: number } | null>(null);
  const [pendingComment, setPendingComment] = useState<PendingDocumentComment | null>(null);
  const [commentPanelOpen, setCommentPanelOpen] = useState(false);
  const [commentLayout, setCommentLayout] = useState<DocumentCommentLayout>(EMPTY_DOCUMENT_COMMENT_LAYOUT);
  const [agentHeight, setAgentHeight] = useState(AGENT_DEFAULT_HEIGHT);
  const [agentHasContext, setAgentHasContext] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentCommand, setAgentCommand] = useState<AgentRunCommand | null>(null);
  const [agentPromptDraft, setAgentPromptDraft] = useState<AgentPromptDraft | null>(null);
  const [agentExcerpts, setAgentExcerpts] = useState<AgentDocumentExcerpt[]>([]);
  const [activeAgentState, setActiveAgentState] = useState<AgentActiveJobState | null>(null);
  const [regenerateTarget, setRegenerateTarget] = useState<{ stage: AgentStageChoice; name: string } | null>(null);
  const [regenerateReason, setRegenerateReason] = useState("");
  const [regenerateReferenceCurrent, setRegenerateReferenceCurrent] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashedProjects, setTrashedProjects] = useState<TrashedProject[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashPage, setTrashPage] = useState(1);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashTotalPages, setTrashTotalPages] = useState(1);
  const [trashBusyProjectId, setTrashBusyProjectId] = useState<number | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<TrashedProject | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<"archive" | "reopen" | null>(null);
  const [lifecycleProject, setLifecycleProject] = useState<Project | null>(null);
  const [distributionBrief, setDistributionBrief] = useState<DistributionBriefSnapshot | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [projectInitialization, setProjectInitialization] = useState<ProjectInitialization | null>(null);
  const [reinitializeBusy, setReinitializeBusy] = useState(false);
  const [qualityIssue, setQualityIssue] = useState<StageFile | null>(null);
  const [stageApprovalNotice, setStageApprovalNotice] = useState<{ stageName: string; subsequentFileNames: string[] } | null>(null);
  const [versionTarget, setVersionTarget] = useState<StageFile | null>(null);
  const [outlineTitleDraft, setOutlineTitleDraft] = useState("");
  const [outlineEnglishTitleDraft, setOutlineEnglishTitleDraft] = useState("");
  const [outlineTitleEditorOpen, setOutlineTitleEditorOpen] = useState(false);
  const [outlineTitleConfirmation, setOutlineTitleConfirmation] = useState<OutlineTitleSync | null>(null);
  const [outlineTitleExport, setOutlineTitleExport] = useState<PendingOutlineTitleExport | null>(null);
  const [outlineTitleBusy, setOutlineTitleBusy] = useState(false);
  const centerStackRef = useRef<HTMLDivElement>(null);
  const agentCommandIdRef = useRef(0);
  const agentPromptDraftIdRef = useRef(0);
  const regenerateReasonRef = useRef<HTMLTextAreaElement>(null);
  const deepLinkHandledRef = useRef(false);
  const dismissedSystemNotificationIdsRef = useRef(new Set<number>());
  const agentExcerptIdRef = useRef(Date.now());
  const contentRequestRef = useRef(0);
  const commentRequestRef = useRef(0);
  const selectedStageRef = useRef<string | null>(null);
  const dismissedQualityIssueRef = useRef<string | null>(null);

  const handleCommentScrollElementChange = useCallback((element: HTMLElement | null) => {
    commentContentScrollElementRef.current = element;
  }, []);

  const handleCommentContentScroll = useCallback((deltaY: number) => {
    const element = commentContentScrollElementRef.current;
    if (!element || !deltaY) return false;
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(element.scrollTop + deltaY, maxScrollTop));
    if (nextScrollTop === element.scrollTop) return false;
    element.scrollTop = nextScrollTop;
    return true;
  }, []);

  const dirty = useMemo(() => document?.content !== draft, [document, draft]);
  const worldView = useMemo(
    () => worldViewFromDraft(draft, document),
    [document, draft]
  );
  const novelAnalysis = useMemo(
    () => novelAnalysisFromDraft(draft, document),
    [document, draft]
  );
  const agentMinHeight = agentHasContext ? AGENT_CONTEXT_MIN_HEIGHT : AGENT_MIN_HEIGHT;
  const agentMinimized = agentHeight <= agentMinHeight;
  const currentRunnableStage = useMemo(() => {
    if (!selectedFile || !RUNNABLE_STAGES.has(selectedFile.stage as AgentStageChoice)) return null;
    if (selectedProject?.task_type === "review") {
      return selectedFile.stage === "foreign_review" ? "foreign_review" : null;
    }
    return selectedFile.stage as AgentStageChoice;
  }, [selectedFile, selectedProject?.task_type]);
  const nextStageFile = useMemo(() => {
    if (!selectedFile) return null;
    return files.find((file) => (
      file.index > selectedFile.index && !file.merged_into_full_script
    )) ?? null;
  }, [files, selectedFile]);
  const nextRunnableStage = useMemo(() => {
    if (!nextStageFile || !RUNNABLE_STAGES.has(nextStageFile.stage as AgentStageChoice)) return null;
    if (selectedProject?.task_type === "review") {
      return nextStageFile.stage === "foreign_review" ? "foreign_review" : null;
    }
    return nextStageFile.stage as AgentStageChoice;
  }, [nextStageFile, selectedProject?.task_type]);
  const agentActionPending = !creating && (agentBusy || !!agentCommand);
  const selectedFileGenerating = Boolean(
    selectedFile
    && ["novel_analysis", "world_view"].includes(selectedFile.stage)
    && isGeneratingStageFile(selectedFile)
  );
  const agentLoadingStage = selectedFile && isGeneratingStageFile(selectedFile) ? selectedFile.stage : undefined;
  const projectArchived = selectedProject?.status === "completed";
  const projectReadOnly = selectedProject?.access_level === "view";
  const documentCommentsEnabled = Boolean(
    !creating
    && selectedProject
    && selectedFile
    && document
    && !["novel_analysis", "world_view"].includes(selectedFile.stage)
  );
  const commentPanelVisible = commentPanelOpen && Boolean(documentComments.length || pendingComment);
  const pageLoading = !userLoaded || !regionsLoaded || !scriptTagsLoaded || !projectsLoaded || contentLoading;
  const finalDeliverySelected = !nextStageFile && (
    selectedFile?.stage === "foreign_review"
    || (selectedProject?.task_type === "translate" && selectedFile?.stage === "dialogue_translate")
    || (selectedProject?.task_type === "humanize" && selectedFile?.stage === "humanizer_zh")
  );
  const finalDeliveryReady = selectedFile?.stage === "foreign_review"
    ? selectedFile.status === "approved"
    : selectedFile?.stage === "dialogue_translate"
      ? selectedFile.status === "completed"
      : selectedFile?.stage === "humanizer_zh"
        ? selectedFile.status === "completed"
      : false;
  const reviewHasP0 = Boolean(
    selectedProject?.task_type === "rewrite"
    && selectedFile?.stage === "foreign_review"
    && document?.stage === "foreign_review"
    && selectedFile.review_decision?.outcome === "revision_requested"
    && (document.review_scorecard?.p0_issue_count ?? 0) > 0
  );
  const primaryAction = projectArchived
    ? "reopen"
    : reviewHasP0
      ? "optimize-p0"
    : finalDeliverySelected && finalDeliveryReady
      ? "archive"
      : "next";
  const regenerateAction = regenerateActionState({
    selectedProject,
    selectedFile,
    currentRunnableStage,
    projectReadOnly,
    projectArchived,
    agentBusy,
    agentCommand,
    reinitializeBusy
  });
  const primaryStageAction = primaryStageActionState({
    selectedProject,
    selectedFile,
    files,
    nextStageFile,
    nextRunnableStage,
    primaryAction,
    dirty,
    projectReadOnly,
    agentBusy,
    agentCommand
  });
  const creditForStage = useCallback((stage: string | null | undefined) => {
    if (!stage) return null;
    return creditSummary?.prices.find((item) => item.stage === stage)?.credits ?? null;
  }, [creditSummary]);
  const regenerateCreditCost = creditForStage(currentRunnableStage);
  const primaryCreditStage = useMemo(() => {
    if (primaryAction === "optimize-p0" && !primaryStageAction.disabled) return "full_generate";
    if (primaryAction !== "next" || primaryStageAction.disabled || !selectedFile || !nextStageFile || !nextRunnableStage) return null;
    if (selectedFile.status === "awaiting_approval") {
      if (selectedFile.stage === "foreign_review" || files.some((file) => file.index > selectedFile.index && file.exists)) return null;
      return nextRunnableStage;
    }
    if (selectedFile.status === "needs_revision" && !selectedFile.document_sync_pending) return null;
    if (selectedFile.stage === "foreign_review" && selectedFile.review_decision?.outcome === "revision_requested") return null;
    if (["completed", "awaiting_approval", "approved"].includes(nextStageFile.status) && nextStageFile.clickable) return null;
    return nextRunnableStage;
  }, [files, nextRunnableStage, nextStageFile, primaryAction, primaryStageAction.disabled, selectedFile]);
  const primaryCreditCost = creditForStage(primaryCreditStage);
  const versionTitleAction = selectedFile?.exists ? (
    <button
      type="button"
      className="document-title-version-action"
      aria-label={`查看${selectedFile.name}的版本记录`}
      title="版本记录"
      onClick={() => setVersionTarget(selectedFile)}
    >
      <History size={16} />
    </button>
  ) : null;
  const outlineTitle = document?.outline_title;
  const showOutlineTitleEditor = Boolean(
    (selectedProject?.task_type === "rewrite" || selectedProject?.task_type === "replicate")
    && selectedFile?.stage === "outline_rewrite"
    && outlineTitle
  );
  const showOutlineEnglishTitle = !["国内", "中国大陆", "China", "Mainland China"].includes(selectedProject?.target_region?.trim() ?? "");
  const outlineTitleChanged = Boolean(
    outlineTitle
    && (outlineTitleDraft.trim() !== outlineTitle.title || outlineEnglishTitleDraft.trim() !== outlineTitle.english_title)
  );
  const outlineTitlePendingConfirmation = Boolean(outlineTitle && !outlineTitle.confirmed);
  const outlineTitleEditorLocked = agentActionPending || projectArchived || projectReadOnly || busy || dirty || outlineTitleBusy;
  const outlineTitleConfirmDisabled = outlineTitleEditorLocked
    || !outlineTitleDraft.trim()
    || (showOutlineEnglishTitle && !outlineEnglishTitleDraft.trim())
    || (!outlineTitlePendingConfirmation && !outlineTitleChanged);
  const outlineTitleToggleDisabled = outlineTitleBusy || (!outlineTitleEditorOpen && outlineTitleEditorLocked);
  const outlineTitleToolbarSupplement = showOutlineTitleEditor && outlineTitle?.title ? (
    <div className="outline-title-summary">
      <span className="outline-title-summary-separator" aria-hidden="true">/</span>
      <span className="outline-title-summary-name" title={outlineTitle.title}>{outlineTitle.title}</span>
      <button
        type="button"
        className="outline-title-toggle"
        aria-controls="outline-title-editor"
        aria-expanded={outlineTitleEditorOpen}
        title={outlineTitleEditorOpen ? "取消更名" : "更名"}
        disabled={outlineTitleToggleDisabled}
        onClick={() => {
          if (outlineTitleEditorOpen) {
            handleCancelOutlineTitleEdit();
            return;
          }
          handleOpenOutlineTitleEdit();
        }}
      >
        {outlineTitleEditorOpen ? "取消" : "更名"}
      </button>
    </div>
  ) : null;
  const outlineTitleBodyHeader = showOutlineTitleEditor && outlineTitleEditorOpen ? (
    <section id="outline-title-editor" className="outline-title-editor" aria-label="剧本名称">
      <div className={`outline-title-editor-fields${showOutlineEnglishTitle ? "" : " is-single"}`}>
        <label className="outline-title-editor-field">
          <span>{showOutlineEnglishTitle ? "中文剧本名称" : "剧本名称"}</span>
          <input
            value={outlineTitleDraft}
            maxLength={80}
            placeholder="填写改编后的剧本名称"
            disabled={outlineTitleEditorLocked}
            onChange={(event) => setOutlineTitleDraft(event.target.value)}
          />
        </label>
        {showOutlineEnglishTitle ? (
          <label className="outline-title-editor-field">
            <span>英文剧本名称</span>
            <input
              value={outlineEnglishTitleDraft}
              maxLength={80}
              placeholder="填写对应的英文剧本名称"
              disabled={outlineTitleEditorLocked}
              onChange={(event) => setOutlineEnglishTitleDraft(event.target.value)}
            />
          </label>
        ) : null}
        <button
          type="button"
          className="outline-title-confirm-action"
          aria-label="确认并同步剧本名称"
          title={dirty ? "请先保存正文修改" : "确认并同步剧本名称"}
          disabled={outlineTitleConfirmDisabled}
          onClick={() => handleRequestOutlineTitleSync()}
        >
          <Check size={16} />
          <span>确认</span>
        </button>
      </div>
    </section>
  ) : null;
  const creditIsInsufficient = useCallback((cost: number | null | undefined) => Boolean(
    creditSummary?.managed
    && cost !== null
    && cost !== undefined
    && creditSummary.balance !== null
    && creditSummary.balance < cost
  ), [creditSummary]);
  const showInsufficientCreditError = useCallback((cost: number) => {
    setError(`创作额度不足，本次需要 ${cost} 额度，当前可用 ${creditSummary?.balance ?? 0} 额度。请联系管理员补充额度。`);
  }, [creditSummary?.balance]);
  const showConcurrencyError = useCallback(() => {
    setError(creditSummary?.concurrency.message || "当前运行中的任务已满，请等待其中一个任务完成或取消后再试。");
  }, [creditSummary?.concurrency.message]);
  const handleAgentContextItemsChange = useCallback((hasContext: boolean) => {
    setAgentHasContext(hasContext);
    setAgentHeight((height) => {
      if (hasContext) return Math.max(height, AGENT_CONTEXT_MIN_HEIGHT);
      return height <= AGENT_CONTEXT_MIN_HEIGHT ? AGENT_MIN_HEIGHT : height;
    });
  }, []);
  const commentPanelHeight = !pageLoading && !creating && !projectArchived
    ? `calc(100% - ${agentHeight}px - 8px)`
    : "100%";
  const workspaceGridStyle = useMemo(() => ({
    "--project-column": projectPanelCollapsed ? "48px" : `${projectPanelWidth}px`,
    "--file-column": filePanelCollapsed ? "48px" : "minmax(230px, 0.21fr)",
    "--comment-panel-height": commentPanelHeight
  }) as CSSProperties, [commentPanelHeight, filePanelCollapsed, projectPanelCollapsed, projectPanelWidth]);
  const centerStackStyle = useMemo(() => ({
    "--agent-panel-height": `${agentHeight}px`
  }) as CSSProperties, [agentHeight]);

  useEffect(() => {
    const projectId = selectedProject?.id;
    const stage = selectedFile?.stage;
    const requestId = ++commentRequestRef.current;
    setDocumentComments([]);
    setActiveCommentId(null);
    setCommentNavigationTarget(null);
    setPendingComment(null);
    setCommentPanelOpen(false);
    setCommentLayout(EMPTY_DOCUMENT_COMMENT_LAYOUT);
    if (!documentCommentsEnabled || !projectId || !stage) return;

    getDocumentComments(projectId, stage)
      .then((comments) => {
        if (requestId === commentRequestRef.current) setDocumentComments(comments);
      })
      .catch((err) => {
        if (requestId === commentRequestRef.current) {
          setError(err instanceof Error ? err.message : "评论加载失败");
        }
      });
  }, [document?.content_hash, documentCommentsEnabled, selectedFile?.stage, selectedProject?.id]);

  const refreshProjects = useCallback(async (search = query) => {
    const nextProjects = await getProjects(search);
    setProjects(nextProjects);
    return nextProjects;
  }, [query]);

  const refreshNotifications = useCallback(async () => {
    const payload = await getNotifications();
    setNotifications(payload.notifications);
    setUnreadNotificationCount(payload.unread_count);
    setUnreadSystemNotifications(payload.unread_system_notifications);
    return payload;
  }, []);

  useEffect(() => {
    getScriptTagTaxonomy()
      .then(setScriptTagTaxonomy)
      .catch((err) => setError(err.message))
      .finally(() => setScriptTagsLoaded(true));
  }, []);

  const refreshCredits = useCallback(async () => {
    try {
      const summary = await getCreditSummary();
      setCreditSummary(summary);
      return summary;
    } catch {
      return null;
    }
  }, []);

  const loadTrashedProjects = useCallback(async (page = 1) => {
    setTrashLoading(true);
    setTrashError(null);
    try {
      const result = await getTrashedProjects(page, TRASH_PAGE_SIZE);
      setTrashedProjects(result.projects);
      setTrashPage(result.pagination.page);
      setTrashTotal(result.pagination.total);
      setTrashTotalPages(result.pagination.total_pages);
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : "回收站加载失败");
    } finally {
      setTrashLoading(false);
    }
  }, []);

  const handleOpenTrash = useCallback(() => {
    setTrashOpen(true);
    void loadTrashedProjects(1);
  }, [loadTrashedProjects]);

  const handleCloseTrash = useCallback(() => {
    setTrashOpen(false);
    setTrashError(null);
    setPermanentDeleteTarget(null);
  }, []);

  const markNotificationAsRead = useCallback(async (notificationId: number) => {
    const readAt = new Date().toISOString();
    setNotifications((current) => current.map((item) => (
      item.id === notificationId ? { ...item, read_at: item.read_at ?? readAt } : item
    )));
    setUnreadSystemNotifications((current) => current.filter((item) => item.id !== notificationId));
    setUnreadNotificationCount((current) => Math.max(0, current - 1));
    try {
      await markNotificationRead(notificationId);
    } catch {
      await refreshNotifications();
    }
  }, [refreshNotifications]);

  const closeSystemNotification = useCallback(() => {
    if (!systemNotificationDialog) return;
    dismissedSystemNotificationIdsRef.current.add(systemNotificationDialog.id);
    setSystemNotificationDialog(null);
    if (!systemNotificationDialog.read_at) {
      void markNotificationAsRead(systemNotificationDialog.id);
    }
  }, [markNotificationAsRead, systemNotificationDialog]);

  useEffect(() => {
    if (systemNotificationDialog) return;
    const next = unreadSystemNotifications.find(
      (notification) => !dismissedSystemNotificationIdsRef.current.has(notification.id)
    );
    if (next) setSystemNotificationDialog(next);
  }, [systemNotificationDialog, unreadSystemNotifications]);

  const handleCancelDelete = useCallback(() => setDeleteTarget(null), []);

  const handleCancelPermanentDelete = useCallback(() => setPermanentDeleteTarget(null), []);

  const loadProject = useCallback(async (project: Project, preferredStage?: string | null) => {
    const requestId = ++contentRequestRef.current;
    selectedStageRef.current = null;
    setContentLoading(true);
    setSelectedProject(project);
    setCreating(false);
    setError(null);
    setActiveAgentState(null);
    setAgentBusy(false);
    setAgentExcerpts([]);
    setQualityIssue(null);
    setStageApprovalNotice(null);
    setVersionTarget(null);
    setDistributionBrief(null);
    setProjectInitialization(null);
    try {
      const [nextFiles, activeJobState] = await Promise.all([
        getFiles(project.id),
        getActiveAgentJob(project.id)
      ]);
      if (requestId !== contentRequestRef.current) return;
      const activeStage = activeJobState.job?.target_stage;
      const displayFiles = activeStage && nextFiles.some((file) => file.stage === activeStage)
        ? markStageGenerating(nextFiles, activeStage)
        : nextFiles;
      setFiles(displayFiles);
      setAgentBusy(Boolean(activeJobState.job));
      if (activeJobState.job) {
        setActiveAgentState({
          job: activeJobState.job,
          events: activeJobState.events
        });
      }
      const preferredFile = preferredStage
        ? displayFiles.find((file) => file.stage === preferredStage && canRestoreStageFile(file)) ?? null
        : null;
      const currentStageFile = displayFiles.find((file) => file.current && canRestoreStageFile(file)) ?? null;
      const latestClickable = [...displayFiles].reverse().find((file) => file.clickable) ?? null;
      const nextFile = preferredFile ?? currentStageFile ?? latestClickable;
      setSelectedFile(nextFile);
      selectedStageRef.current = nextFile?.stage ?? null;
      if (nextFile) {
        const nextDocument = await getFile(project.id, nextFile.stage);
        if (requestId !== contentRequestRef.current) return;
        setDocument(nextDocument);
        setDraft(nextDocument.content);
        setMode("preview");
      } else {
        setDocument(null);
        setDraft("");
      }
    } finally {
      if (requestId === contentRequestRef.current) setContentLoading(false);
    }
  }, []);

  const handleNotificationSelect = useCallback(async (notification: Notification) => {
    if (notification.kind === "system") {
      if (!notification.read_at) await markNotificationAsRead(notification.id);
      setSystemNotificationDialog({ ...notification, read_at: notification.read_at ?? new Date().toISOString() });
      return;
    }
    if (!notification.read_at) await markNotificationAsRead(notification.id);
    if (notification.target_path) {
      window.location.href = notification.target_path;
      return;
    }
    let availableProjects = projects;
    let project = availableProjects.find((item) => item.id === notification.project_id);
    if (!project) {
      availableProjects = await getProjects();
      setProjects(availableProjects);
      project = availableProjects.find((item) => item.id === notification.project_id);
    }
    if (!project) {
      setError("对应任务已不存在或无法访问");
      return;
    }

    setQuery("");
    await loadProject(project, notification.target_stage);
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("project", String(project.id));
    if (notification.target_stage) url.searchParams.set("stage", notification.target_stage);
    url.searchParams.set("job", String(notification.job_id));
    window.history.replaceState(null, "", url);
  }, [loadProject, markNotificationAsRead, projects]);

  const refreshCurrentProject = useCallback(async () => {
    if (!selectedProject) return;
    const requestId = ++contentRequestRef.current;
    const nextProjects = await refreshProjects();
    if (requestId !== contentRequestRef.current) return;
    const updatedProject = nextProjects.find((item) => item.id === selectedProject.id) ?? selectedProject;
    setSelectedProject(updatedProject);
    const nextFiles = await getFiles(updatedProject.id);
    if (requestId !== contentRequestRef.current) return;
    setFiles(nextFiles);
    const previouslySelected = selectedStageRef.current
      ? nextFiles.find((file) => file.stage === selectedStageRef.current && canRestoreStageFile(file))
      : null;
    const currentStageFile = nextFiles.find((file) => file.current && canRestoreStageFile(file)) ?? null;
    const latestClickable = [...nextFiles].reverse().find((file) => file.clickable) ?? null;
    const nextFile = previouslySelected ?? currentStageFile ?? latestClickable;
    setSelectedFile(nextFile);
    selectedStageRef.current = nextFile?.stage ?? null;
    if (nextFile) {
      const nextDocument = await getFile(updatedProject.id, nextFile.stage);
      if (requestId !== contentRequestRef.current) return;
      setDocument(nextDocument);
      setDraft(nextDocument.content);
      setMode("preview");
    } else {
      setDocument(null);
      setDraft("");
    }
  }, [refreshProjects, selectedProject]);

  const handleAgentCompleted = useCallback(async () => {
    await Promise.all([refreshCurrentProject(), refreshNotifications(), refreshCredits()]);
  }, [refreshCredits, refreshCurrentProject, refreshNotifications]);

  const handleAgentJobStarted = useCallback((job: AgentJob) => {
    const targetStage = job.target_stage ?? job.stage;
    const file = files.find((item) => item.stage === targetStage);
    if (!file) return;
    const pendingContent = pendingStageContent(file);
    const generatingFile = {
      ...file,
      current: true,
      clickable: true,
      status: "in_progress"
    } as StageFile;
    setFiles((currentFiles) => markStageGenerating(currentFiles, targetStage));
    setSelectedFile(generatingFile);
    selectedStageRef.current = targetStage;
    setDocument({
      stage: targetStage,
      name: generatingFile.name,
      file_name: generatingFile.file_name,
      content: pendingContent
    });
    setDraft(pendingContent);
    setMode("preview");
    setAgentHeight((height) => Math.max(height, 260));
  }, [files]);

  useEffect(() => {
    try {
      const savedWidth = Number(window.localStorage.getItem(PROJECT_PANEL_WIDTH_STORAGE_KEY));
      if (Number.isFinite(savedWidth)) {
        setProjectPanelWidth(clampProjectPanelWidth(Math.round(savedWidth)));
      }
    } catch {
      // Keep the default width when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => {
        window.location.href = "/login";
      })
      .finally(() => setUserLoaded(true));
  }, []);

  useEffect(() => {
    void refreshCredits();
    const timer = window.setInterval(() => void refreshCredits(), 30_000);
    const handleFocus = () => void refreshCredits();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
    };
  }, [refreshCredits]);

  useEffect(() => {
    getTargetRegions()
      .then(setTargetRegions)
      .catch((err) => setError(err.message))
      .finally(() => setRegionsLoaded(true));
  }, []);

  useEffect(() => {
    const refresh = () => void refreshNotifications().catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshNotifications]);

  useEffect(() => {
    refreshProjects().then((nextProjects) => {
      if (!deepLinkHandledRef.current) {
        deepLinkHandledRef.current = true;
        const requestedId = Number(new URLSearchParams(window.location.search).get("project"));
        const requestedStage = new URLSearchParams(window.location.search).get("stage");
        const requestedProject = Number.isFinite(requestedId)
          ? nextProjects.find((project) => project.id === requestedId)
          : undefined;
        if (requestedProject) {
          void loadProject(requestedProject, requestedStage).catch((err) => setError(err.message));
          return;
        }
      }
      if (!creating && !selectedProject && nextProjects[0]) {
        loadProject(nextProjects[0]).catch((err) => setError(err.message));
      }
    }).catch((err) => setError(err.message)).finally(() => setProjectsLoaded(true));
  }, [creating, loadProject, refreshProjects, selectedProject]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshProjects(query).catch((err) => setError(err.message));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, refreshProjects]);

  useEffect(() => {
    refreshProjects(query).catch((err) => setError(err.message));
  }, [agentBusy, query, refreshProjects]);

  useEffect(() => {
    if (agentActionPending) {
      setMode("preview");
    }
  }, [agentActionPending]);

  useEffect(() => {
    if (selectedFile?.stage !== "character_rewrite") {
      setCharacterView("profile");
    }
  }, [selectedFile?.stage]);

  useEffect(() => {
    if (selectedFile?.stage === "outline_rewrite" && document?.outline_title) {
      setOutlineTitleDraft(document.outline_title.title);
      setOutlineEnglishTitleDraft(document.outline_title.english_title);
      setOutlineTitleEditorOpen(!document.outline_title.confirmed);
      return;
    }
    setOutlineTitleDraft("");
    setOutlineEnglishTitleDraft("");
    setOutlineTitleEditorOpen(false);
  }, [document?.content_hash, document?.outline_title?.confirmed, document?.outline_title?.english_title, document?.outline_title?.title, selectedFile?.stage, selectedProject?.id]);

  useEffect(() => {
    if (selectedFile?.stage !== "novel_analysis") {
      setNovelAnalysisSection("basic");
    }
  }, [selectedFile?.stage]);

  useEffect(() => {
    if (
      contentLoading
      || agentActionPending
      || projectReadOnly
      || !selectedProject
      || selectedFile?.status !== "needs_revision"
      || !(selectedFile.quality_warnings?.length)
    ) {
      setQualityIssue(null);
      return;
    }
    const key = qualityIssueKey(selectedProject.id, selectedFile);
    if (dismissedQualityIssueRef.current !== key) setQualityIssue(selectedFile);
  }, [agentActionPending, contentLoading, projectReadOnly, selectedFile, selectedProject]);

  useEffect(() => {
    if (
      !selectedProject ||
      selectedFile?.stage !== "foreign_review" ||
      document?.stage !== "foreign_review" ||
      document.review_scorecard
    ) return;

    let cancelled = false;
    const refreshScorecard = async () => {
      try {
        const latestDocument = await getFile(selectedProject.id, "foreign_review");
        if (cancelled || !latestDocument.review_scorecard) return;
        setDocument((current) => current?.stage === "foreign_review"
          ? { ...current, review_scorecard: latestDocument.review_scorecard }
          : current);
      } catch {
        // The report or scorecard may still be in progress; the stage refresh handles final errors.
      }
    };

    void refreshScorecard();
    const timer = window.setInterval(() => void refreshScorecard(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [document?.review_scorecard, document?.stage, selectedFile?.stage, selectedProject]);

  useEffect(() => {
    if (!regenerateTarget) return;
    regenerateReasonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setRegenerateTarget(null);
        setRegenerateReason("");
        setRegenerateReferenceCurrent(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [regenerateTarget]);

  useEffect(() => {
    if (!error) {
      setErrorCountdown(0);
      return;
    }

    setErrorCountdown(5);
    const timer = window.setInterval(() => {
      setErrorCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          setError(null);
          return 0;
        }
        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [error]);

  function handleCloseCommentPanel() {
    setCommentPanelOpen(false);
    setActiveCommentId(null);
    setCommentNavigationTarget(null);
    setPendingComment(null);
    setCommentLayout(EMPTY_DOCUMENT_COMMENT_LAYOUT);
  }

  function handleCancelPendingComment() {
    setPendingComment(null);
    setActiveCommentId(null);
    setCommentNavigationTarget(null);
    if (!documentComments.length) setCommentPanelOpen(false);
  }

  function handleCommentCreateRequest(anchor: DocumentCommentAnchor) {
    setPendingComment({ anchor });
    setActiveCommentId(null);
    setCommentNavigationTarget(null);
    setCommentPanelOpen(true);
  }

  function handleCommentThreadSelect(thread: DocumentCommentThread) {
    setPendingComment(null);
    setActiveCommentId(thread.id);
    setCommentNavigationTarget(null);
    setCommentPanelOpen(true);
  }

  function handleCommentThreadNavigate(thread: DocumentCommentThread) {
    setPendingComment(null);
    setActiveCommentId(thread.id);
    setCommentNavigationTarget({ threadId: thread.id });
  }

  function handleOpenCommentPanel() {
    if (!documentComments.length) return;
    setPendingComment(null);
    setActiveCommentId(null);
    setCommentNavigationTarget(null);
    setCommentPanelOpen(true);
  }

  async function handleCreateDocumentComment(content: string) {
    if (!selectedProject || !selectedFile || !pendingComment) return;
    setError(null);
    try {
      const comment = await createDocumentComment(selectedProject.id, selectedFile.stage, {
        anchor_start: pendingComment.anchor.start,
        anchor_end: pendingComment.anchor.end,
        anchor_text: pendingComment.anchor.text,
        anchor_prefix: pendingComment.anchor.prefix,
        anchor_suffix: pendingComment.anchor.suffix,
        preview_start: pendingComment.anchor.preview_start,
        preview_end: pendingComment.anchor.preview_end,
        content
      });
      setDocumentComments((current) => [...current, comment]);
      setPendingComment(null);
      setActiveCommentId(comment.id);
      setCommentNavigationTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加评论失败");
      throw err;
    }
  }

  async function handleReplyToDocumentComment(threadId: number, content: string) {
    if (!selectedProject || !selectedFile) return;
    setError(null);
    try {
      const comment = await replyToDocumentComment(selectedProject.id, selectedFile.stage, threadId, content);
      setDocumentComments((current) => current.map((item) => item.id === threadId ? comment : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : "补充评论失败");
      throw err;
    }
  }

  async function handleDeleteDocumentComment(threadId: number, messageId: number) {
    if (!selectedProject || !selectedFile) return;
    setError(null);
    try {
      const result = await deleteDocumentCommentMessage(selectedProject.id, selectedFile.stage, threadId, messageId);
      if (result.thread_deleted) {
        setDocumentComments((current) => current.filter((item) => item.id !== threadId));
        if (activeCommentId === threadId) {
          setActiveCommentId(null);
          setCommentNavigationTarget(null);
        }
        return;
      }
      setDocumentComments((current) => current.map((item) => (
        item.id === threadId
          ? { ...item, messages: item.messages.filter((message) => message.id !== messageId) }
          : item
      )));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除评论失败");
      throw err;
    }
  }

  async function handleSelectFile(file: StageFile) {
    if (!selectedProject || !canRestoreStageFile(file)) return;
    const requestId = ++contentRequestRef.current;
    setContentLoading(true);
    setSelectedFile(file);
    selectedStageRef.current = file.stage;
    try {
      const nextDocument = await getFile(selectedProject.id, file.stage);
      if (requestId !== contentRequestRef.current) return;
      setDocument(nextDocument);
      setDraft(nextDocument.content);
      setMode("preview");
    } finally {
      if (requestId === contentRequestRef.current) setContentLoading(false);
    }
  }

  async function handleSave() {
    if (!selectedProject || !selectedFile) return;
    if (selectedProject.access_level === "view") {
      setError("你只有查看权限，无法编辑此项目");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextDocument = await saveFile(selectedProject.id, selectedFile.stage, draft, document?.content_hash);
      setDocument(nextDocument);
      setDraft(nextDocument.content);
      await refreshCurrentProject();
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function handleRequestOutlineTitleSync() {
    if (!outlineTitle || !selectedProject) return;
    if (dirty) {
      setError("当前文档有未保存修改，请先保存");
      return;
    }
    const title = outlineTitleDraft.trim();
    const englishTitle = outlineEnglishTitleDraft.trim();
    if (!title) {
      setError("请填写剧本名称");
      return;
    }
    if (showOutlineEnglishTitle && !englishTitle) {
      setError("请填写英文剧本名称");
      return;
    }
    if (outlineTitle.confirmed && title === outlineTitle.title && englishTitle === outlineTitle.english_title) return;
    setOutlineTitleConfirmation({ title, englishTitle });
  }

  function handleOpenOutlineTitleEdit() {
    if (!outlineTitle) return;
    setOutlineTitleDraft(outlineTitle.title);
    setOutlineEnglishTitleDraft(outlineTitle.english_title);
    setOutlineTitleEditorOpen(true);
  }

  function handleCancelOutlineTitleEdit() {
    if (outlineTitle) {
      setOutlineTitleDraft(outlineTitle.title);
      setOutlineEnglishTitleDraft(outlineTitle.english_title);
    }
    setOutlineTitleConfirmation(null);
    setOutlineTitleEditorOpen(false);
  }

  async function synchronizeOutlineTitle(titleConfirmation: OutlineTitleSync, expectedHash: string) {
    if (!selectedProject) throw new Error("当前项目不可用");
    const result = await updateOutlineTitle(selectedProject.id, {
      title: titleConfirmation.title,
      english_title: showOutlineEnglishTitle ? titleConfirmation.englishTitle : "",
      expected_hash: expectedHash
    });
    setSelectedProject(result.project);
    if (selectedFile?.stage === "outline_rewrite") {
      setDocument(result.file);
      setDraft(result.file.content);
      setMode("preview");
    }
    await refreshCurrentProject().catch(() => undefined);
    return result;
  }

  async function handleConfirmOutlineTitleSync() {
    if (!selectedProject || !document?.content_hash || !outlineTitleConfirmation) return;
    setOutlineTitleBusy(true);
    setError(null);
    try {
      await synchronizeOutlineTitle(outlineTitleConfirmation, document.content_hash);
      setOutlineTitleConfirmation(null);
      setOutlineTitleEditorOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "剧本名称同步失败");
    } finally {
      setOutlineTitleBusy(false);
    }
  }

  async function handleDownloadRequest(url: string) {
    if (
      !selectedProject
      || (selectedProject.task_type !== "rewrite" && selectedProject.task_type !== "replicate")
      || selectedProject.access_level === "view"
      || selectedProject.status === "completed"
    ) {
      startFileDownload(url);
      return;
    }
    try {
      const outlineDocument = await getFile(selectedProject.id, "outline_rewrite");
      const title = outlineDocument.outline_title;
      if (!title || title.confirmed || !outlineDocument.content_hash) {
        startFileDownload(url);
        return;
      }
      setOutlineTitleExport({
        url,
        title: title.title,
        englishTitle: title.english_title,
        expectedHash: outlineDocument.content_hash
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法确认剧本名称状态，请稍后重试");
    }
  }

  async function handleConfirmOutlineTitleExport() {
    if (!outlineTitleExport) return;
    setOutlineTitleBusy(true);
    setError(null);
    try {
      await synchronizeOutlineTitle(outlineTitleExport, outlineTitleExport.expectedHash);
      const { url } = outlineTitleExport;
      setOutlineTitleExport(null);
      setOutlineTitleEditorOpen(false);
      startFileDownload(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "剧本名称同步失败");
    } finally {
      setOutlineTitleBusy(false);
    }
  }

  async function handleModifyOutlineTitleBeforeExport() {
    if (!selectedProject) return;
    setOutlineTitleExport(null);
    const outlineFile = files.find((file) => file.stage === "outline_rewrite");
    if (!outlineFile) {
      setError("故事梗概尚未生成，暂时无法修改剧本名称");
      return;
    }
    try {
      await handleSelectFile(outlineFile);
      setOutlineTitleEditorOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法打开故事梗概");
    }
  }

  async function handleOpenDistributionBrief() {
    if (!selectedProject) return;
    setBriefBusy(true);
    setError(null);
    try {
      setDistributionBrief(await getDistributionBrief(selectedProject.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "任务需求加载失败");
    } finally {
      setBriefBusy(false);
    }
  }

  async function handleOpenProjectReinitialize() {
    if (!selectedProject) return;
    if (selectedProject.access_level === "view") {
      setError("你只有查看权限，无法重新生成");
      return;
    }
    if (dirty) {
      setError("当前文档有未保存修改，请先保存后再重新生成");
      return;
    }
    setReinitializeBusy(true);
    setError(null);
    try {
      setProjectInitialization(await getProjectInitialization(selectedProject.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "初始化配置加载失败");
    } finally {
      setReinitializeBusy(false);
    }
  }

  async function handleProjectReinitialize(formData: FormData) {
    if (!selectedProject || !projectInitialization) return;
    if (selectedProject.access_level === "view") {
      setError("你只有查看权限，无法重新生成");
      return;
    }
    const episodeCountValue = Number(formData.get("target_episode_count"));
    const reinitializeInput: ProjectReinitializeInput = {
      project_name: String(formData.get("project_name") || projectInitialization.project_name).trim(),
      target_region: String(formData.get("target_region") || projectInitialization.target_region).trim(),
      expected_hash: projectInitialization.config_hash
    };
    const requirements = String(formData.get("extra_requirements") || "").trim();
    if (requirements) reinitializeInput.extra_requirements = requirements;
    for (const field of ["episode_duration", "maturity_target"] as const) {
      const value = String(formData.get(field) || "").trim();
      if (value) reinitializeInput[field] = value;
    }
    for (const field of ["theme", "setting", "background", "audience"] as const) {
      const value = String(formData.get(field) || "").trim();
      if (value) reinitializeInput[field] = value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
    }
    if (Number.isInteger(episodeCountValue) && episodeCountValue > 0) {
      reinitializeInput.target_episode_count = episodeCountValue;
    }
    setReinitializeBusy(true);
    setError(null);
    try {
      await reinitializeProject(selectedProject.id, reinitializeInput);
      setProjectInitialization(null);
      await refreshCurrentProject();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新初始化失败");
    } finally {
      setReinitializeBusy(false);
    }
  }

  async function handleTogglePin(project: Project) {
    const updated = await updateProject(project.id, { pinned: !project.pinned });
    const nextProjects = await refreshProjects();
    if (selectedProject?.id === updated.id) {
      setSelectedProject(nextProjects.find((item) => item.id === updated.id) ?? updated);
    }
  }

  function handleRename(project: Project) {
    setRenameTarget(project);
    setRenameValue(project.name);
  }

  async function handleConfirmRename() {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setRenameBusy(true);
    setError(null);
    try {
      const updated = await updateProject(renameTarget.id, { name });
      const nextProjects = await refreshProjects();
      if (selectedProject?.id === updated.id) {
        setSelectedProject(nextProjects.find((item) => item.id === updated.id) ?? updated);
      }
      setRenameTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失败");
    } finally {
      setRenameBusy(false);
    }
  }

  function handleDelete(project: Project) {
    setDeleteTarget(project);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const project = deleteTarget;
    setDeleteBusy(true);
    setError(null);
    try {
      await deleteProject(project.id);
      const nextProjects = await refreshProjects();
      setDeleteTarget(null);
      if (selectedProject?.id === project.id) {
        if (nextProjects[0]) {
          await loadProject(nextProjects[0]);
        } else {
          setSelectedProject(null);
          setFiles([]);
          setSelectedFile(null);
          selectedStageRef.current = null;
          setDocument(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除项目失败");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleRestoreProject(project: TrashedProject) {
    setTrashBusyProjectId(project.id);
    setTrashError(null);
    try {
      await restoreProject(project.id);
      await Promise.all([refreshProjects(), loadTrashedProjects(trashPage)]);
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : "恢复项目失败");
    } finally {
      setTrashBusyProjectId(null);
    }
  }

  async function handleConfirmPermanentDelete() {
    if (!permanentDeleteTarget) return;
    const project = permanentDeleteTarget;
    setTrashBusyProjectId(project.id);
    setTrashError(null);
    try {
      await permanentlyDeleteProject(project.id);
      await loadTrashedProjects(trashPage);
      setPermanentDeleteTarget(null);
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : "彻底删除项目失败");
      setPermanentDeleteTarget(null);
    } finally {
      setTrashBusyProjectId(null);
    }
  }

  async function handleCreateProject(formData: FormData) {
    setBusy(true);
    setError(null);
    try {
      const taskType = String(formData.get("task_type") || "rewrite");
      if (taskType === "novel" || taskType === "review" || taskType === "translate" || taskType === "humanize") {
        const latestCredits = await refreshCredits();
        if (latestCredits?.concurrency.reached) {
          setError(latestCredits.concurrency.message || "当前运行中的任务已满，请等待其中一个任务完成或取消后再试。");
          return;
        }
      }
      const project = await createProject(formData);
      const nextProjects = await refreshProjects();
      await loadProject(nextProjects.find((item) => item.id === project.id) ?? project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建项目失败");
    } finally {
      setBusy(false);
    }
  }

  function handleStartCreateProject() {
    contentRequestRef.current += 1;
    setContentLoading(false);
    setCreating(true);
    setSelectedProject(null);
    setFiles([]);
    setSelectedFile(null);
    selectedStageRef.current = null;
    setDocument(null);
    setDraft("");
    setMode("preview");
    setAgentCommand(null);
    setAgentExcerpts([]);
    setActiveAgentState(null);
    setAgentBusy(false);
    setRegenerateTarget(null);
    setRegenerateReason("");
    setRegenerateReferenceCurrent(true);
    setDistributionBrief(null);
    setProjectInitialization(null);
    setVersionTarget(null);
    setError(null);
  }

  async function handleCancelCreateProject() {
    setCreating(false);
    setError(null);
    if (projects[0]) {
      await loadProject(projects[0]);
    }
  }

  async function handleLogout() {
    await logout();
    window.location.href = "/login";
  }

  function queueAgentCommand(
    stage: AgentStageChoice,
    prompt: string,
    referenceCurrentFile?: boolean,
    manualInput?: string,
    regenerateCurrentFile?: boolean,
    optimizationScope?: "review_p0",
    targetStage?: string
  ) {
    if (selectedProject?.access_level === "view") {
      setError("你只有查看权限，无法运行 Agent");
      return;
    }
    if (creditSummary?.concurrency.reached) {
      showConcurrencyError();
      return;
    }
    agentCommandIdRef.current += 1;
    setAgentCommand({
      id: agentCommandIdRef.current,
      stage,
      targetStage,
      prompt,
      referenceCurrentFile,
      manualInput,
      regenerateCurrentFile,
      optimizationScope
    });
  }

  function beginStage(
    file: StageFile,
    stage: AgentStageChoice,
    prompt: string,
    referenceCurrentFile?: boolean,
    manualInput?: string,
    regenerateCurrentFile?: boolean,
    optimizationScope?: "review_p0"
  ) {
    if (selectedProject?.access_level === "view") {
      setError("你只有查看权限，无法运行 Agent");
      return;
    }
    if (creditSummary?.concurrency.reached) {
      showConcurrencyError();
      return;
    }
    const pendingContent = pendingStageContent(file);
    const generatingFile = {
      ...file,
      current: true,
      clickable: true,
      status: "in_progress"
    } as StageFile;
    setFiles((currentFiles) => markStageGenerating(currentFiles, stage));
    setSelectedFile(generatingFile);
    selectedStageRef.current = generatingFile.stage;
    setDocument({
      stage: generatingFile.stage,
      name: generatingFile.name,
      file_name: generatingFile.file_name,
      content: pendingContent
    });
    setDraft(pendingContent);
    setMode("preview");
    setAgentHeight((height) => Math.max(height, 260));
    queueAgentCommand(stage, prompt, referenceCurrentFile, manualInput, regenerateCurrentFile, optimizationScope);
  }

  function handleOptimizeP0() {
    const fullScript = files.find((file) => file.stage === "full_generate");
    if (!fullScript) {
      setError("完整剧本尚未生成，暂时无法一键优化。");
      return;
    }
    queueAgentCommand(
      "full_generate",
      "根据当前审稿报告中的全部 P0 建议优化完整剧本。",
      undefined,
      undefined,
      undefined,
      "review_p0",
      fullScript.stage
    );
  }

  function openRegenerateDialog(file: StageFile) {
    const stage = file.stage as AgentStageChoice;
    const isReviewProject = selectedProject?.task_type === "review";
    if (!RUNNABLE_STAGES.has(stage) || (isReviewProject && stage !== "foreign_review")) {
      setError(`「${file.name}」不能在这里重新生成。`);
      return;
    }
    const cost = creditForStage(stage);
    if (cost !== null && creditIsInsufficient(cost)) {
      showInsufficientCreditError(cost);
      return;
    }
    setRegenerateTarget({ stage, name: file.name });
    setRegenerateReason("");
    setRegenerateReferenceCurrent(true);
  }

  async function handleConfirmRegenerate() {
    if (selectedProject?.access_level === "view") {
      setError("你只有查看权限，无法重新生成");
      return;
    }
    const reason = regenerateReason.trim();
    if (!regenerateTarget || !reason) return;
    const cost = creditForStage(regenerateTarget.stage);
    if (cost !== null && creditIsInsufficient(cost)) {
      showInsufficientCreditError(cost);
      return;
    }
    const prompt = `${reason}`;
    const file = files.find((item) => item.stage === regenerateTarget.stage);
    if (file) beginStage(file, regenerateTarget.stage, prompt, regenerateReferenceCurrent, reason, true);
    else queueAgentCommand(regenerateTarget.stage, prompt, regenerateReferenceCurrent, reason, true);
    setRegenerateTarget(null);
    setRegenerateReason("");
    setRegenerateReferenceCurrent(true);
  }

  async function handleNextStage() {
    if (!selectedProject) return;
    if (selectedProject.access_level === "view") {
      setError("你只有查看权限，无法推进项目阶段");
      return;
    }
    if (primaryCreditCost !== null && creditIsInsufficient(primaryCreditCost)) {
      showInsufficientCreditError(primaryCreditCost);
      return;
    }
    if (selectedFile?.status === "needs_revision" && !selectedFile.document_sync_pending) {
      if (selectedFile.quality_warnings?.length) setQualityIssue(selectedFile);
      else setError(`${selectedFile.name}未通过检查，但没有收到具体问题明细。请重新生成当前文件后再试。`);
      return;
    }
    if (dirty) {
      setError("当前文档有未保存修改，请先保存");
      return;
    }

    if (selectedFile?.document_sync_pending) {
      if (!nextStageFile || !nextRunnableStage) {
        setError(`${selectedFile.name}的修改尚待更新，请点击“重新生成”更新当前文件后再继续。`);
        return;
      }
      beginStage(nextStageFile, nextRunnableStage, "");
      return;
    }

    if (selectedFile?.status === "awaiting_approval") {
      if (!['trial_generate', 'foreign_review'].includes(selectedFile.stage)) {
        setError("当前阶段不需要人工确认");
        return;
      }
      const subsequentFiles = files.filter((file) => file.index > selectedFile.index && file.exists);
      try {
        const currentDocument = document?.stage === selectedFile.stage
          ? document
          : await getFile(selectedProject.id, selectedFile.stage);
        await approveStage(selectedProject.id, selectedFile.stage, currentDocument.content_hash);
      } catch (err) {
        try {
          await refreshCurrentProject();
        } catch {
          // 保留确认失败信息，方便用户继续处理。
        }
        throw err;
      }

      if (selectedFile.stage === "foreign_review") {
        await refreshCurrentProject();
        return;
      }

      if (subsequentFiles.length) {
        await refreshCurrentProject();
        setStageApprovalNotice({
          stageName: selectedFile.name,
          subsequentFileNames: subsequentFiles.map((file) => file.name)
        });
        return;
      }

      if (!nextStageFile || !nextRunnableStage) {
        await refreshCurrentProject();
        return;
      }
      beginStage(
        nextStageFile,
        nextRunnableStage,
        ""
      );
      return;
    }

    if (!nextStageFile) return;
    if (["completed", "awaiting_approval", "approved"].includes(nextStageFile.status) && nextStageFile.clickable) {
      await handleSelectFile(nextStageFile);
      return;
    }
    if (!nextRunnableStage) return;
    beginStage(
      nextStageFile,
      nextRunnableStage,
      ""
    );
  }

  async function handleLifecycleAction() {
    if (!lifecycleProject || !lifecycleAction) return;
    if (lifecycleProject.access_level === "view") {
      setError("你只有查看权限，无法更新项目状态");
      return;
    }
    const isSelectedProject = selectedProject?.id === lifecycleProject.id;
    if (lifecycleAction === "archive" && isSelectedProject && dirty) {
      setError("当前审稿报告有未保存修改，请先保存");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (lifecycleAction === "archive") {
        await archiveProject(
          lifecycleProject.id,
          isSelectedProject ? document?.content_hash : undefined,
          isSelectedProject ? activeAgentState?.job.id : undefined
        );
      } else {
        await reopenProject(lifecycleProject.id);
      }
      setLifecycleAction(null);
      setLifecycleProject(null);
      setDistributionBrief(null);
      if (isSelectedProject) await refreshCurrentProject();
      else await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "项目状态更新失败");
    } finally {
      setBusy(false);
    }
  }

  function handleProjectPanelResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;

    event.preventDefault();

    const startX = event.clientX;
    const startWidth = projectPanelWidth;
    let resizedWidth = startWidth;
    const previousCursor = window.document.body.style.cursor;
    const previousUserSelect = window.document.body.style.userSelect;

    setProjectPanelResizing(true);
    window.document.body.style.cursor = "col-resize";
    window.document.body.style.userSelect = "none";

    function handlePointerMove(nextEvent: PointerEvent) {
      resizedWidth = clampProjectPanelWidth(Math.round(startWidth + nextEvent.clientX - startX));
      setProjectPanelWidth(resizedWidth);
    }

    function stopResize() {
      window.document.body.style.cursor = previousCursor;
      window.document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      setProjectPanelResizing(false);

      try {
        window.localStorage.setItem(PROJECT_PANEL_WIDTH_STORAGE_KEY, String(resizedWidth));
      } catch {
        // The width still applies for the current visit when storage is unavailable.
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function handleAgentResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = agentHeight;
    const stackHeight = centerStackRef.current?.getBoundingClientRect().height ?? 0;
    const maxHeight = stackHeight
      ? Math.max(agentMinHeight, Math.min(AGENT_MAX_HEIGHT, stackHeight - 220))
      : AGENT_MAX_HEIGHT;
    const previousCursor = window.document.body.style.cursor;
    const previousUserSelect = window.document.body.style.userSelect;

    window.document.body.style.cursor = "row-resize";
    window.document.body.style.userSelect = "none";

    function handlePointerMove(nextEvent: PointerEvent) {
      const nextHeight = Math.round(startHeight + startY - nextEvent.clientY);
      setAgentHeight(Math.max(agentMinHeight, Math.min(maxHeight, nextHeight)));
    }

    function stopResize() {
      window.document.body.style.cursor = previousCursor;
      window.document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  return (
    <main className="app-shell">
      {error ? (
        <div className="error-banner" role="status" aria-atomic="true">
          <span>{error}</span>
          <div className="error-banner-actions">
            {errorCountdown > 0 ? <span className="error-countdown" aria-hidden="true">{errorCountdown}s</span> : null}
            <button
              className="error-dismiss-button"
              type="button"
              aria-label="关闭提示"
              title="关闭提示"
              onClick={() => setError(null)}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ) : null}
      <div
        className={`workspace-grid${creating ? " creating-workspace" : ""}${projectPanelResizing ? " project-panel-resizing" : ""}${commentPanelVisible ? " comments-open" : ""}`}
        style={workspaceGridStyle}
      >
        <ProjectList
          user={user}
          creditSummary={creditSummary}
          projects={projects}
          selectedProjectId={creating ? undefined : selectedProject?.id}
          query={query}
          collapsed={projectPanelCollapsed}
          notifications={notifications}
          hasUnreadNotifications={unreadNotificationCount > 0}
          onQueryChange={setQuery}
          onSelect={(project) => loadProject(project).catch((err) => setError(err.message))}
          onNew={handleStartCreateProject}
          onToggleCollapsed={() => setProjectPanelCollapsed((collapsed) => !collapsed)}
          onResizeStart={handleProjectPanelResizeStart}
          onOpenTrash={handleOpenTrash}
          onOpenCredits={() => {
            setCreditCenterOpen(true);
            void refreshCredits();
          }}
          onNotificationSelect={(notification) => void handleNotificationSelect(notification).catch((err) => (
            setError(err instanceof Error ? err.message : "任务打开失败")
          ))}
          onLogout={() => void handleLogout()}
          onTogglePin={(project) => handleTogglePin(project).catch((err) => setError(err.message))}
          onRename={handleRename}
          onArchive={(project) => {
            setLifecycleProject(project);
            setLifecycleAction("archive");
          }}
          onDelete={handleDelete}
        />
        <div className={`center-stack${pageLoading ? " loading-mode" : creating ? " creating-mode" : projectArchived ? " archived-mode" : ""}${commentPanelVisible ? " comments-open" : ""}`} ref={centerStackRef} style={centerStackStyle}>
          {pageLoading ? (
            <PageLoading variant="workspace" label="正在加载工作台" />
          ) : creating ? (
            <NewProjectForm
              busy={busy}
              error={error}
              regions={targetRegions}
              scriptTagTaxonomy={scriptTagTaxonomy}
              creditPrices={creditSummary?.prices}
              creditBalance={creditSummary?.balance}
              creditsManaged={creditSummary?.managed}
              concurrency={creditSummary?.concurrency}
              allowedScenarioKeys={allowedScenarioKeys}
              onCancel={() => void handleCancelCreateProject()}
              onSubmit={(formData) => void handleCreateProject(formData)}
            />
          ) : document ? (
            selectedFile?.stage === "novel_analysis" ? (
              <NovelAnalysisWorkspace
                title={document.name}
                value={novelAnalysis}
                section={novelAnalysisSection}
                dirty={dirty}
                saving={busy}
                generating={selectedFileGenerating}
                locked={agentActionPending || projectArchived || projectReadOnly}
                lockReason={projectReadOnly ? "view" : projectArchived ? "archived" : "agent"}
                onChange={(nextValue) => setDraft(`${JSON.stringify(nextValue, null, 2)}\n`)}
                onSave={() => void handleSave()}
                onCancel={() => setDraft(document.content)}
                titleAction={versionTitleAction}
              />
            ) : selectedFile?.stage === "world_view" ? (
              <WorldViewWorkspace
                title={document.name}
                value={worldView}
                dirty={dirty}
                saving={busy}
                generating={selectedFileGenerating}
                locked={agentActionPending || projectArchived || projectReadOnly}
                lockReason={projectReadOnly ? "view" : projectArchived ? "archived" : "agent"}
                onChange={(nextValue) => setDraft(`${JSON.stringify(nextValue, null, 2)}\n`)}
                onSave={() => void handleSave()}
                onCancel={() => setDraft(document.content)}
                onLockedEditAttempt={() => setError(projectReadOnly ? "你只有查看权限，无法编辑此项目" : projectArchived ? "项目已归档，请先重新开启" : "Agent执行中，不可编辑")}
                titleAction={versionTitleAction}
              />
            ) : (
              <MarkdownWorkspace
                title={document.name}
                content={document.content}
                draft={draft}
                mode={mode}
                dirty={dirty}
                saving={busy}
                locked={agentActionPending || projectArchived || projectReadOnly}
                lockReason={projectReadOnly ? "view" : projectArchived ? "archived" : "agent"}
                reviewVisual={selectedFile?.stage === "foreign_review"}
                characterView={selectedFile?.stage === "character_rewrite" ? characterView : undefined}
                relationshipGraph={selectedFile?.stage === "character_rewrite" ? document.relationship_graph : null}
                loadingStage={agentLoadingStage}
                showSceneMarker={selectedFile ? ["trial_generate", "full_generate", "dialogue_translate"].includes(selectedFile.stage) : false}
                onModeChange={setMode}
                onCharacterViewChange={setCharacterView}
                onDraftChange={setDraft}
                onSave={() => void handleSave()}
                onCancel={() => setDraft(document.content)}
                comments={documentComments}
                activeCommentId={activeCommentId}
                commentNavigationTarget={commentNavigationTarget}
                pendingCommentAnchor={pendingComment?.anchor}
                commentPanelOpen={commentPanelVisible}
                onCommentCreate={documentCommentsEnabled ? handleCommentCreateRequest : undefined}
                onAddToConversation={selectedFile ? (anchor) => {
                  setAgentExcerpts((current) => [...current, {
                    id: ++agentExcerptIdRef.current,
                    stage: selectedFile.stage,
                    document_name: selectedFile.name,
                    file_path: selectedFile.file_name,
                    content: anchor.text
                  }]);
                  setAgentHeight((height) => Math.max(height, 220));
                } : undefined}
                onCommentSelect={documentCommentsEnabled ? handleCommentThreadSelect : undefined}
                onOpenCommentPanel={documentCommentsEnabled ? handleOpenCommentPanel : undefined}
                onCommentLayoutChange={documentCommentsEnabled ? setCommentLayout : undefined}
                onScrollElementChange={handleCommentScrollElementChange}
                onLockedEditAttempt={() => setError(projectReadOnly ? "你只有查看权限，无法编辑此项目" : projectArchived ? "项目已归档，请先重新开启" : "Agent执行中，不可编辑")}
                titleAction={versionTitleAction}
                titleSupplement={outlineTitleToolbarSupplement}
                bodyHeader={outlineTitleBodyHeader}
              />
            )
          ) : (
            <section className="glass-panel document-panel empty-document">
              <h1>选择或新建一个创作项目</h1>
            </section>
          )}
          {!pageLoading && !creating && !projectArchived ? (
            <AgentPanel
              project={selectedProject}
              document={document}
              draft={draft}
              selectedFile={selectedFile}
              files={files}
              excerpts={agentExcerpts}
              canDebug={user?.permissions.includes("admin:jobs")}
              command={agentCommand}
              promptDraft={agentPromptDraft}
              activeJobState={activeAgentState}
              minimized={agentMinimized}
              archived={projectArchived}
              readOnly={projectReadOnly}
              briefLoading={briefBusy}
              creditPrices={creditSummary?.prices}
              creditBalance={creditSummary?.balance}
              creditsManaged={creditSummary?.managed}
              onResizeStart={handleAgentResizeStart}
              onOpenDistributionBrief={() => void handleOpenDistributionBrief()}
              onCommandHandled={(commandId) => {
                setAgentCommand((current) => current?.id === commandId ? null : current);
              }}
              onPromptDraftHandled={(draftId) => {
                setAgentPromptDraft((current) => current?.id === draftId ? null : current);
              }}
              onRemoveExcerpt={(excerptId) => setAgentExcerpts((current) => current.filter((item) => item.id !== excerptId))}
              onClearExcerpts={() => setAgentExcerpts([])}
              onContextItemsChange={handleAgentContextItemsChange}
              onBusyChange={setAgentBusy}
              onJobStarted={handleAgentJobStarted}
              onCompleted={handleAgentCompleted}
              onCreditsChanged={async () => { await refreshCredits(); }}
              onError={(message) => setError(message)}
            />
          ) : null}
        </div>
        {commentPanelVisible ? (
          <DocumentCommentPanel
            threads={documentComments}
            activeThreadId={activeCommentId}
            pendingComment={pendingComment}
            layout={commentLayout}
            currentUserId={user?.id}
            onClose={handleCloseCommentPanel}
            onCancelPending={handleCancelPendingComment}
            onCreate={handleCreateDocumentComment}
            onReply={handleReplyToDocumentComment}
            onDeleteMessage={handleDeleteDocumentComment}
            onNavigateThread={handleCommentThreadNavigate}
            onContentScroll={handleCommentContentScroll}
          />
        ) : null}
        {!creating ? (
          <FileRail
            projectId={selectedProject?.id}
            projectTaskType={selectedProject?.task_type}
            files={files}
            selectedStage={selectedFile?.stage}
            novelAnalysisSection={novelAnalysisSection}
            collapsed={filePanelCollapsed}
            regenerateAction={regenerateAction}
            briefDisabled={briefBusy}
            primaryStageAction={primaryStageAction}
            primaryAction={primaryAction}
            regenerateCreditCost={regenerateCreditCost}
            primaryCreditCost={primaryCreditCost}
            creditBalance={creditSummary?.balance}
            creditsManaged={creditSummary?.managed}
            onToggleCollapsed={() => setFilePanelCollapsed((collapsed) => !collapsed)}
            onSelect={(file) => void handleSelectFile(file)}
            onSelectNovelAnalysisSection={setNovelAnalysisSection}
            onRegenerate={() => {
              if (selectedFile?.stage === "project_init") {
                void handleOpenProjectReinitialize();
                return;
              }
              if (selectedFile) openRegenerateDialog(selectedFile);
            }}
            onViewBrief={() => void handleOpenDistributionBrief()}
            onDownloadRequest={(url) => void handleDownloadRequest(url)}
            onNextStage={() => {
              if (primaryAction === "archive" && selectedProject) {
                setLifecycleProject(selectedProject);
                setLifecycleAction("archive");
              } else if (primaryAction === "reopen" && selectedProject) {
                setLifecycleProject(selectedProject);
                setLifecycleAction("reopen");
              } else if (primaryAction === "optimize-p0") {
                handleOptimizeP0();
              }
              else void handleNextStage().catch((err) => setError(err instanceof Error ? err.message : "进入下一步失败"));
            }}
          />
        ) : null}
      </div>
      {versionTarget && selectedProject ? (
        <FileVersionDialog
          projectId={selectedProject.id}
          file={versionTarget}
          restoreDisabledReason={
            projectReadOnly
              ? "你只有查看权限，不能恢复版本"
              : projectArchived
                ? "项目已归档，请先重新开启"
                : agentActionPending
                  ? "项目正在处理内容，完成后再恢复版本"
                  : dirty
                    ? "当前文件有未保存修改，请先保存或取消修改"
                    : null
          }
          onClose={() => setVersionTarget(null)}
          onRestored={async () => {
            selectedStageRef.current = versionTarget.stage;
            setVersionTarget(null);
            await refreshCurrentProject();
          }}
        />
      ) : null}
      {qualityIssue && selectedProject && !projectReadOnly ? (
        <QualityIssuesDialog
          file={qualityIssue}
          creditCost={creditForStage(qualityIssue.stage)}
          creditBalance={creditSummary?.balance}
          creditsManaged={creditSummary?.managed}
          onClose={() => {
            dismissedQualityIssueRef.current = qualityIssueKey(selectedProject.id, qualityIssue);
            setQualityIssue(null);
          }}
          onAutoRepair={() => {
            if (creditSummary?.concurrency.reached) {
              showConcurrencyError();
              return;
            }
            dismissedQualityIssueRef.current = qualityIssueKey(selectedProject.id, qualityIssue);
            setQualityIssue(null);
            if (!currentRunnableStage) {
              setMode("markdown");
              return;
            }
            setFiles((currentFiles) => markStageGenerating(currentFiles, qualityIssue.stage));
            setAgentHeight((height) => Math.max(height, 260));
            queueAgentCommand(currentRunnableStage, qualityRepairPrompt(qualityIssue), true);
          }}
          onManualEdit={() => {
            dismissedQualityIssueRef.current = qualityIssueKey(selectedProject.id, qualityIssue);
            setQualityIssue(null);
            setMode("markdown");
          }}
        />
      ) : null}
      {stageApprovalNotice ? (
        <StageApprovalNoticeDialog
          stageName={stageApprovalNotice.stageName}
          subsequentFileNames={stageApprovalNotice.subsequentFileNames}
          onClose={() => setStageApprovalNotice(null)}
        />
      ) : null}
      {systemNotificationDialog ? (
        <SystemNotificationDialog notification={systemNotificationDialog} onClose={closeSystemNotification} />
      ) : null}
      {renameTarget ? (
        <TextInputDialog
          title="重命名项目"
          label="项目名称"
          value={renameValue}
          confirmLabel="保存名称"
          busy={renameBusy}
          maxLength={200}
          onChange={setRenameValue}
          onCancel={() => {
            if (!renameBusy) setRenameTarget(null);
          }}
          onConfirm={() => void handleConfirmRename()}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmationDialog
          title={`将「${deleteTarget.name}」移入回收站？`}
          description="项目删除后会保留 30 天，期间可从回收站恢复。保留期结束后，项目和所有相关数据将被彻底清理。"
          confirmLabel="移入回收站"
          busy={deleteBusy}
          onCancel={handleCancelDelete}
          onConfirm={() => void handleConfirmDelete()}
        />
      ) : null}
      {outlineTitleConfirmation ? (
        <ConfirmationDialog
          title="是否同步修改任务名称及其他已生成的内容？"
          description="项目名称、已生成文件的名称和标题，以及相关的审稿与翻译记录都会同步更新。"
          confirmLabel="同步修改"
          intent="sync"
          busy={outlineTitleBusy}
          onCancel={() => {
            if (!outlineTitleBusy) setOutlineTitleConfirmation(null);
          }}
          onConfirm={() => void handleConfirmOutlineTitleSync()}
        />
      ) : null}
      {outlineTitleExport ? (
        <ConfirmationDialog
          title={`当前剧本名称为：${outlineTitleExport.title}，是否同步名称并导出？`}
          description="同步后会更新任务名称及已生成内容，再导出当前文件。"
          confirmLabel="同步并导出"
          intent="sync"
          busy={outlineTitleBusy}
          secondaryActionLabel="修改剧本名称"
          onSecondaryAction={() => void handleModifyOutlineTitleBeforeExport()}
          onCancel={() => {
            if (!outlineTitleBusy) setOutlineTitleExport(null);
          }}
          onConfirm={() => void handleConfirmOutlineTitleExport()}
        />
      ) : null}
      {lifecycleAction && lifecycleProject ? (
        <ConfirmationDialog
          title={lifecycleAction === "archive" ? `归档「${lifecycleProject.name}」？` : `重新开启「${lifecycleProject.name}」？`}
          description={lifecycleAction === "archive"
            ? "归档表示项目已结束，不会删除任何内容。归档后仍可随时查看；如需继续修改或运行 Agent，可在“已归档”中重新开启。"
            : "重新开启后，项目将回到“进行中”，并恢复编辑和 Agent 操作。"}
          confirmLabel={lifecycleAction === "archive" ? "归档项目" : "重新开启"}
          intent={lifecycleAction}
          busy={busy}
          onCancel={() => {
            setLifecycleAction(null);
            setLifecycleProject(null);
          }}
          onConfirm={() => void handleLifecycleAction()}
        />
      ) : null}
      {distributionBrief ? (
        <DistributionBriefDialog
          snapshot={distributionBrief}
          projectId={selectedProject?.id}
          onCancel={() => setDistributionBrief(null)}
        />
      ) : null}
      {projectInitialization ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => {
          if (!reinitializeBusy) setProjectInitialization(null);
        }}>
          <div onMouseDown={(event) => event.stopPropagation()}>
            <NewProjectForm
              key={projectInitialization.config_hash}
              variant="regenerate"
              initialValues={projectInitialization}
              busy={reinitializeBusy}
              error={null}
              regions={targetRegions}
              scriptTagTaxonomy={scriptTagTaxonomy}
              allowedScenarioKeys={allowedScenarioKeys}
              onCancel={() => {
                if (!reinitializeBusy) setProjectInitialization(null);
              }}
              onSubmit={(formData) => void handleProjectReinitialize(formData)}
            />
          </div>
        </div>
      ) : null}
      {trashOpen ? (
        <ProjectTrashDialog
          projects={trashedProjects}
          loading={trashLoading}
          error={trashError}
          page={trashPage}
          total={trashTotal}
          totalPages={trashTotalPages}
          busyProjectId={trashBusyProjectId}
          onClose={handleCloseTrash}
          onRetry={() => void loadTrashedProjects(trashPage)}
          onPageChange={(page) => void loadTrashedProjects(page)}
          onRestore={(project) => void handleRestoreProject(project)}
          onRequestPermanentDelete={setPermanentDeleteTarget}
        />
      ) : null}
      {permanentDeleteTarget ? (
        <ConfirmationDialog
          title={`彻底删除「${permanentDeleteTarget.name}」？`}
          description="此操作无法撤销。项目数据库记录、运行日志、系统上传件以及 Agents workspace 中的全部内容都会立即清空。"
          confirmLabel="彻底删除"
          tone="danger"
          busy={trashBusyProjectId === permanentDeleteTarget.id}
          onCancel={handleCancelPermanentDelete}
          onConfirm={() => void handleConfirmPermanentDelete()}
        />
      ) : null}
      {regenerateTarget ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => {
          setRegenerateTarget(null);
          setRegenerateReason("");
          setRegenerateReferenceCurrent(true);
        }}>
          <form
            className="regenerate-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="regenerate-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void handleConfirmRegenerate();
            }}
          >
            <div className="regenerate-dialog-header">
              <span>重新生成</span>
              <strong id="regenerate-dialog-title">{regenerateTarget.name}</strong>
              {creditForStage(regenerateTarget.stage) !== null ? (
                <small className={`regenerate-credit-note${creditIsInsufficient(creditForStage(regenerateTarget.stage)) ? " insufficient" : ""}`}>
                  {creditIsInsufficient(creditForStage(regenerateTarget.stage))
                    ? `额度不足：需要 ${creditForStage(regenerateTarget.stage)}，当前可用 ${creditSummary?.balance ?? 0}`
                    : `本次消耗 ${creditForStage(regenerateTarget.stage)} 额度`}
                </small>
              ) : null}
            </div>
            <label className="regenerate-dialog-field">
              <span>原因</span>
              <textarea
                ref={regenerateReasonRef}
                value={regenerateReason}
                placeholder="例如：节奏过慢，需要增强短剧钩子"
                onChange={(event) => setRegenerateReason(event.target.value)}
              />
            </label>
            <div className="regenerate-reference-option">
              <label className="regenerate-reference-label">
                <input
                  type="checkbox"
                  checked={regenerateReferenceCurrent}
                  onChange={(event) => setRegenerateReferenceCurrent(event.target.checked)}
                />
                <span>参考当前文件</span>
              </label>
              <span className="regenerate-reference-help">
                <button
                  type="button"
                  className="regenerate-reference-help-trigger"
                  aria-label="查看参考当前文件说明"
                  aria-describedby="regenerate-reference-tooltip"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") event.currentTarget.blur();
                  }}
                >
                  <CircleHelp size={14} aria-hidden="true" />
                </button>
                <span id="regenerate-reference-tooltip" className="regenerate-reference-tooltip" role="tooltip">
                  取消勾选后，将忽略当前已生成的内容，完全重新生成
                </span>
              </span>
            </div>
            <div className="regenerate-dialog-actions">
              <button
                type="button"
                className="cancel-action"
                onClick={() => {
                  setRegenerateTarget(null);
                  setRegenerateReason("");
                  setRegenerateReferenceCurrent(true);
                }}
              >
                取消
              </button>
              <button className="save-action" type="submit" disabled={!regenerateReason.trim() || agentActionPending || creditIsInsufficient(creditForStage(regenerateTarget.stage))}>
                {creditIsInsufficient(creditForStage(regenerateTarget.stage)) ? "额度不足，无法生成" : creditForStage(regenerateTarget.stage) !== null ? `确认生成 · ${creditForStage(regenerateTarget.stage)}额度` : "确认生成"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {creditCenterOpen && creditSummary ? <CreditCenterDialog summary={creditSummary} onClose={() => setCreditCenterOpen(false)} /> : null}
    </main>
  );
}
