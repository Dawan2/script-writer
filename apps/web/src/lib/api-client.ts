import type {
  AgentDebugSession,
  AgentEvent,
  AgentHistory,
  AgentJob,
  AgentStageChoice,
  BatchTask,
  BatchTaskScenario,
  BatchTasksPayload,
  CreditSummary,
  CreditQuote,
  DocumentCommentCreateInput,
  DocumentCommentThread,
  DistributionBriefInput,
  DistributionBriefSnapshot,
  FileVersion,
  FileVersionHistory,
  ProjectInitialization,
  ProjectReinitializeInput,
  Project,
  ProjectMember,
  ProjectMembersPayload,
  ProjectMemoryStatus,
  NotificationsPayload,
  StageDocument,
  StageFile,
  ScriptTagTaxonomy,
  TargetRegion,
  TrashedProjectPage,
  User,
  WriterPreference,
  WriterPreferenceBackupItem,
  WriterPreferenceImportMode,
  WriterPreferenceImportResult,
  WriterPreferenceScopeKey,
  WriterPreferencesBackup,
  WriterPreferencesPayload
} from "@/lib/types";

async function parseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as {
    detail?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload.detail ?? payload.message, response.status));
  }
  return payload as T;
}

function apiErrorMessage(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const issue = item as { loc?: unknown; msg?: unknown };
      const location = Array.isArray(issue.loc)
        ? issue.loc.filter((part) => part !== "body").join(".")
        : "";
      const message = typeof issue.msg === "string" ? issue.msg : JSON.stringify(item);
      return location ? `${location}：${message}` : message;
    }).filter(Boolean);
    if (messages.length) return messages.join("；");
  }
  if (detail && typeof detail === "object") {
    try {
      return JSON.stringify(detail);
    } catch {
      // Fall through to the status-based message.
    }
  }
  return `请求失败（${status}）`;
}

export async function login(username: string, password: string): Promise<User> {
  const payload = await parseJson<{ user: User }>(
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    })
  );
  return payload.user;
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<User> {
  const payload = await parseJson<{ user: User }>(
    await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
    })
  );
  return payload.user;
}

export async function getMe(): Promise<User> {
  const payload = await parseJson<{ user: User }>(await fetch("/api/auth/me"));
  return payload.user;
}

export async function getCreditSummary(): Promise<CreditSummary> {
  const payload = await parseJson<{ credits: CreditSummary }>(await fetch("/api/credits/me"));
  return payload.credits;
}

export async function getAgentCreditQuote(
  projectId: number,
  stage: AgentStageChoice,
  targetStage?: string
): Promise<CreditQuote> {
  const query = new URLSearchParams({ stage });
  if (targetStage) query.set("target_stage", targetStage);
  const payload = await parseJson<{ quote: CreditQuote }>(
    await fetch(`/api/projects/${projectId}/agent/credit-quote?${query.toString()}`, { cache: "no-store" })
  );
  return payload.quote;
}

export async function getSessionUser(): Promise<User | null> {
  const payload = await parseJson<{ user: User | null }>(await fetch("/api/auth/session"));
  return payload.user;
}

export async function getProjects(query?: string): Promise<Project[]> {
  const payload = await parseJson<{ projects: Project[] }>(
    await fetch(`/api/projects${query ? `?query=${encodeURIComponent(query)}` : ""}`)
  );
  return payload.projects;
}

export async function updateProject(projectId: number, patch: Partial<Pick<Project, "name" | "pinned">>) {
  const payload = await parseJson<{ project: Project }>(
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    })
  );
  return payload.project;
}

export async function getProjectMembers(projectId: number): Promise<ProjectMembersPayload> {
  return parseJson<ProjectMembersPayload>(await fetch(`/api/projects/${projectId}/members`));
}

export async function addProjectMemberPermission(
  projectId: number,
  username: string,
  permission: "view" | "edit"
): Promise<ProjectMember> {
  const payload = await parseJson<{ member: ProjectMember }>(
    await fetch(`/api/projects/${projectId}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, permission })
    })
  );
  return payload.member;
}

export async function setProjectMemberPermission(
  projectId: number,
  userId: number,
  permission: "view" | "edit"
): Promise<ProjectMember> {
  const payload = await parseJson<{ member: ProjectMember }>(
    await fetch(`/api/projects/${projectId}/members/${userId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permission })
    })
  );
  return payload.member;
}

export async function removeProjectMemberPermission(projectId: number, userId: number) {
  await parseJson<{ ok: boolean }>(
    await fetch(`/api/projects/${projectId}/members/${userId}`, { method: "DELETE" })
  );
}

export async function deleteProject(projectId: number) {
  await parseJson<{ ok: boolean }>(await fetch(`/api/projects/${projectId}`, { method: "DELETE" }));
}

export async function archiveProject(projectId: number, expectedHash?: string, jobId?: number): Promise<Project> {
  const payload = await parseJson<{ project: Project }>(
    await fetch(`/api/projects/${projectId}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_hash: expectedHash, job_id: jobId })
    })
  );
  return payload.project;
}

export async function reopenProject(projectId: number): Promise<Project> {
  const payload = await parseJson<{ project: Project }>(
    await fetch(`/api/projects/${projectId}/reopen`, { method: "POST" })
  );
  return payload.project;
}

export async function getTrashedProjects(page = 1, pageSize = 10): Promise<TrashedProjectPage> {
  return parseJson<TrashedProjectPage>(
    await fetch(`/api/projects/trash?page=${page}&page_size=${pageSize}`)
  );
}

export async function restoreProject(projectId: number): Promise<Project> {
  const payload = await parseJson<{ project: Project }>(
    await fetch(`/api/projects/trash/${projectId}/restore`, { method: "POST" })
  );
  return payload.project;
}

export async function permanentlyDeleteProject(projectId: number) {
  await parseJson<{ ok: boolean }>(await fetch(`/api/projects/trash/${projectId}`, { method: "DELETE" }));
}

export async function createProject(formData: FormData): Promise<Project> {
  const payload = await parseJson<{ project: Project }>(
    await fetch("/api/projects", {
      method: "POST",
      body: formData
    })
  );
  return payload.project;
}

export async function getBatchTaskScenarios(): Promise<{ scenarios: BatchTaskScenario[]; regions: TargetRegion[] }> {
  return parseJson<{ scenarios: BatchTaskScenario[]; regions: TargetRegion[] }>(
    await fetch("/api/batch-tasks/scenarios")
  );
}

export async function getBatchTasks(filters: {
  scenario?: string;
  status?: string;
  query?: string;
} = {}): Promise<BatchTasksPayload> {
  const search = new URLSearchParams();
  if (filters.scenario) search.set("scenario", filters.scenario);
  if (filters.status) search.set("task_status", filters.status);
  if (filters.query) search.set("query", filters.query);
  const suffix = search.size ? `?${search.toString()}` : "";
  return parseJson<BatchTasksPayload>(await fetch(`/api/batch-tasks${suffix}`));
}

export async function createBatchTasks(batchName: string, tasks: Array<Record<string, unknown> & { source_file: File }>) {
  const formData = new FormData();
  const payload = tasks.map((task, index) => {
    const { source_file: sourceFile, ...values } = task;
    const sourceFileKey = `source_file_${index}`;
    formData.append(sourceFileKey, sourceFile);
    return { ...values, source_file_key: sourceFileKey };
  });
  formData.set("batch_name", batchName);
  formData.set("tasks", JSON.stringify(payload));
  return parseJson<{ batch: { id: number; name: string }; tasks: BatchTask[] }>(
    await fetch("/api/batch-tasks", { method: "POST", body: formData })
  );
}

export async function startAllBatchTasks(): Promise<{ updated: number }> {
  return parseJson<{ updated: number }>(await fetch("/api/batch-tasks/start-all", { method: "POST" }));
}

export async function batchTaskAction(action: "start" | "pause" | "rerun" | "delete", taskIds: number[]) {
  return parseJson<{ updated: number; failures: Array<{ task_id: number; message: string }> }>(
    await fetch("/api/batch-tasks/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, task_ids: taskIds })
    })
  );
}

export async function startBatchTask(taskId: number): Promise<BatchTask> {
  const payload = await parseJson<{ task: BatchTask }>(
    await fetch(`/api/batch-tasks/${taskId}/start`, { method: "POST" })
  );
  return payload.task;
}

export async function pauseBatchTask(taskId: number): Promise<BatchTask> {
  const payload = await parseJson<{ task: BatchTask }>(
    await fetch(`/api/batch-tasks/${taskId}/pause`, { method: "POST" })
  );
  return payload.task;
}

export async function rerunBatchTask(taskId: number): Promise<BatchTask> {
  const payload = await parseJson<{ task: BatchTask }>(
    await fetch(`/api/batch-tasks/${taskId}/rerun`, { method: "POST" })
  );
  return payload.task;
}

export async function deleteBatchTask(taskId: number) {
  return parseJson<{ ok: boolean }>(await fetch(`/api/batch-tasks/${taskId}`, { method: "DELETE" }));
}

export async function getProjectInitialization(projectId: number): Promise<ProjectInitialization> {
  const payload = await parseJson<{ initialization: ProjectInitialization }>(
    await fetch(`/api/projects/${projectId}/initialization`)
  );
  return payload.initialization;
}

export async function reinitializeProject(
  projectId: number,
  input: ProjectReinitializeInput
): Promise<ProjectInitialization> {
  const payload = await parseJson<{ initialization: ProjectInitialization }>(
    await fetch(`/api/projects/${projectId}/reinitialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    })
  );
  return payload.initialization;
}

export async function getTargetRegions(): Promise<TargetRegion[]> {
  const payload = await parseJson<{ regions: TargetRegion[] }>(await fetch("/api/projects/regions"));
  return payload.regions;
}

export async function getScriptTagTaxonomy(): Promise<ScriptTagTaxonomy> {
  const payload = await parseJson<{ taxonomy: ScriptTagTaxonomy }>(await fetch("/api/projects/script-tags"));
  return payload.taxonomy;
}

export async function getDistributionBrief(projectId: number): Promise<DistributionBriefSnapshot> {
  const payload = await parseJson<{ distribution_brief: DistributionBriefSnapshot }>(
    await fetch(`/api/projects/${projectId}/distribution-brief`)
  );
  return payload.distribution_brief;
}

export async function updateDistributionBrief(
  projectId: number,
  brief: DistributionBriefInput,
  confirmed: boolean,
  expectedHash: string
): Promise<DistributionBriefSnapshot> {
  const payload = await parseJson<{ distribution_brief: DistributionBriefSnapshot }>(
    await fetch(`/api/projects/${projectId}/distribution-brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...brief, confirmed, expected_hash: expectedHash })
    })
  );
  return payload.distribution_brief;
}

export async function getFiles(projectId: number): Promise<StageFile[]> {
  const payload = await parseJson<{ files: StageFile[] }>(await fetch(`/api/projects/${projectId}/files`));
  return payload.files;
}

export async function getFile(projectId: number, stage: string): Promise<StageDocument> {
  const payload = await parseJson<{ file: StageDocument }>(await fetch(`/api/projects/${projectId}/files/${stage}`));
  return payload.file;
}

export async function saveFile(projectId: number, stage: string, content: string, expectedHash?: string): Promise<StageDocument> {
  const payload = await parseJson<{ file: StageDocument }>(
    await fetch(`/api/projects/${projectId}/files/${stage}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, expected_hash: expectedHash })
    })
  );
  return payload.file;
}

export async function getDocumentComments(projectId: number, stage: string): Promise<DocumentCommentThread[]> {
  const payload = await parseJson<{ comments: DocumentCommentThread[] }>(
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(stage)}/comments`)
  );
  return payload.comments;
}

export async function createDocumentComment(
  projectId: number,
  stage: string,
  comment: DocumentCommentCreateInput
): Promise<DocumentCommentThread> {
  const payload = await parseJson<{ comment: DocumentCommentThread }>(
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(stage)}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(comment)
    })
  );
  return payload.comment;
}

export async function replyToDocumentComment(
  projectId: number,
  stage: string,
  threadId: number,
  content: string
): Promise<DocumentCommentThread> {
  const payload = await parseJson<{ comment: DocumentCommentThread }>(
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(stage)}/comments/${threadId}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content })
    })
  );
  return payload.comment;
}

export async function deleteDocumentCommentMessage(
  projectId: number,
  stage: string,
  threadId: number,
  messageId: number
): Promise<{ thread_id: number; message_id: number; thread_deleted: boolean }> {
  const payload = await parseJson<{ result: { thread_id: number; message_id: number; thread_deleted: boolean } }>(
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(stage)}/comments/${threadId}/messages/${messageId}`, {
      method: "DELETE"
    })
  );
  return payload.result;
}

export async function updateOutlineTitle(
  projectId: number,
  payload: { title: string; english_title?: string; expected_hash: string }
): Promise<{ project: Project; file: StageDocument }> {
  return parseJson<{ project: Project; file: StageDocument }>(
    await fetch(`/api/projects/${projectId}/outline-title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
}

export async function getFileVersions(projectId: number, stage: string): Promise<FileVersionHistory> {
  const payload = await parseJson<{ history: FileVersionHistory }>(
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(stage)}/versions`, { cache: "no-store" })
  );
  return payload.history;
}

export async function getFileVersion(projectId: number, stage: string, versionId: number): Promise<FileVersion> {
  const payload = await parseJson<{ version: FileVersion }>(
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(stage)}/versions/${versionId}`, { cache: "no-store" })
  );
  return payload.version;
}

export async function restoreFileVersion(
  projectId: number,
  stage: string,
  versionId: number,
  expectedHash: string
): Promise<StageDocument> {
  const payload = await parseJson<{ file: StageDocument }>(
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(stage)}/versions/${versionId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_hash: expectedHash })
    })
  );
  return payload.file;
}

export async function getProjectMemory(projectId: number): Promise<ProjectMemoryStatus> {
  const payload = await parseJson<{ memory: ProjectMemoryStatus }>(await fetch(`/api/projects/${projectId}/memory`));
  return payload.memory;
}

export async function approveStage(projectId: number, stage: string, expectedHash?: string, jobId?: number) {
  return parseJson<{ approval: { stage: string; status: string; memory: ProjectMemoryStatus } }>(
    await fetch(`/api/projects/${projectId}/stages/${encodeURIComponent(stage)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_hash: expectedHash, job_id: jobId })
    })
  );
}

export async function createAgentJob(
  projectId: number,
  payload: {
    stage: AgentStageChoice;
    target_stage?: string;
    prompt?: string;
    user_input?: string;
    dry_run?: boolean;
    reference_current_file?: boolean;
    regenerate_current_file?: boolean;
    optimization_scope?: "review_p0";
  }
): Promise<AgentJob> {
  const response = await parseJson<{ job: AgentJob }>(
    await fetch(`/api/projects/${projectId}/agent/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
  return response.job;
}

export async function retryAgentJob(jobId: number): Promise<AgentJob> {
  const response = await parseJson<{ job: AgentJob }>(
    await fetch(`/api/agent/jobs/${jobId}/retry`, { method: "POST" })
  );
  return response.job;
}

export async function getAgentHistory(projectId: number, stage?: string): Promise<AgentHistory> {
  const query = stage ? `?stage=${encodeURIComponent(stage)}` : "";
  return parseJson<AgentHistory>(await fetch(`/api/projects/${projectId}/agent/history${query}`));
}

export async function getActiveAgentJob(projectId: number): Promise<{ job: AgentJob | null; events: AgentEvent[] }> {
  return parseJson<{ job: AgentJob | null; events: AgentEvent[] }>(
    await fetch(`/api/projects/${projectId}/agent/jobs`)
  );
}

export async function getAgentEvents(jobId: number, afterId = 0): Promise<{ job: AgentJob; events: AgentEvent[] }> {
  return parseJson<{ job: AgentJob; events: AgentEvent[] }>(
    await fetch(`/api/agent/jobs/${jobId}/events?after_id=${afterId}`)
  );
}

export async function getNotifications(): Promise<NotificationsPayload> {
  return parseJson<NotificationsPayload>(await fetch("/api/notifications?limit=30"));
}

export async function markNotificationsRead(): Promise<{ updated: number }> {
  return parseJson<{ updated: number }>(
    await fetch("/api/notifications/read", { method: "POST" })
  );
}

export async function markNotificationRead(notificationId: number): Promise<{ updated: boolean }> {
  return parseJson<{ updated: boolean }>(
    await fetch(`/api/notifications/${notificationId}/read`, { method: "POST" })
  );
}

export async function cancelAgentJob(jobId: number): Promise<AgentJob> {
  const payload = await parseJson<{ job: AgentJob }>(
    await fetch(`/api/agent/jobs/${jobId}/cancel`, { method: "POST" })
  );
  return payload.job;
}

export async function startAgentDebug(jobId: number): Promise<AgentDebugSession> {
  const payload = await parseJson<{ debug: AgentDebugSession }>(
    await fetch(`/api/agent/jobs/${jobId}/debug`, { method: "POST" })
  );
  return payload.debug;
}

export async function getWriterPreferences(): Promise<WriterPreferencesPayload> {
  return parseJson<WriterPreferencesPayload>(await fetch("/api/me/writer-preferences", { cache: "no-store" }));
}

export async function exportWriterPreferences(): Promise<WriterPreferencesBackup> {
  return parseJson<WriterPreferencesBackup>(await fetch("/api/me/writer-preferences/export"));
}

export async function importWriterPreferences(payload: {
  schema_version: string;
  preferences: WriterPreferenceBackupItem[];
  mode: WriterPreferenceImportMode;
}): Promise<WriterPreferenceImportResult> {
  return parseJson<WriterPreferenceImportResult>(
    await fetch("/api/me/writer-preferences/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
}

export async function createWriterPreference(payload: {
  content: string;
  scopes: WriterPreferenceScopeKey[];
  enabled: boolean;
}): Promise<{ preference: WriterPreference; profile_revision: number }> {
  return parseJson<{ preference: WriterPreference; profile_revision: number }>(
    await fetch("/api/me/writer-preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
}

export async function updateWriterPreference(
  preferenceId: number,
  patch: Partial<Pick<WriterPreference, "content" | "scopes" | "enabled">>
): Promise<{ preference: WriterPreference; profile_revision: number }> {
  return parseJson<{ preference: WriterPreference; profile_revision: number }>(
    await fetch(`/api/me/writer-preferences/${preferenceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    })
  );
}

export async function deleteWriterPreference(preferenceId: number): Promise<{ ok: boolean; profile_revision: number }> {
  return parseJson<{ ok: boolean; profile_revision: number }>(
    await fetch(`/api/me/writer-preferences/${preferenceId}`, { method: "DELETE" })
  );
}

export async function reorderWriterPreferences(orderedIds: number[]): Promise<WriterPreferencesPayload> {
  return parseJson<WriterPreferencesPayload>(
    await fetch("/api/me/writer-preferences/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ordered_ids: orderedIds })
    })
  );
}
