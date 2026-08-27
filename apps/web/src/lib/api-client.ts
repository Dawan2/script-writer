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
import { requestJson, requestWithoutResult, type RequestOptions } from "@/lib/request-core";

export type { RequestOptions } from "@/lib/request-core";

export async function login(username: string, password: string, options?: RequestOptions): Promise<User> {
  const payload = await requestJson<{ user: User }>("/api/auth/login", {
    method: "POST",
    json: { username, password },
    ...options
  });
  return payload.user;
}

export async function logout(options?: RequestOptions) {
  await requestWithoutResult("/api/auth/logout", { method: "POST", ...options });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  options?: RequestOptions
): Promise<User> {
  const payload = await requestJson<{ user: User }>("/api/auth/change-password", {
    method: "POST",
    json: { current_password: currentPassword, new_password: newPassword },
    ...options
  });
  return payload.user;
}

export async function getMe(options?: RequestOptions): Promise<User> {
  const payload = await requestJson<{ user: User }>("/api/auth/me", options);
  return payload.user;
}

export async function getCreditSummary(options?: RequestOptions): Promise<CreditSummary> {
  const payload = await requestJson<{ credits: CreditSummary }>("/api/credits/me", options);
  return payload.credits;
}

export async function getAgentCreditQuote(
  projectId: number,
  stage: AgentStageChoice,
  targetStage?: string,
  options?: RequestOptions
): Promise<CreditQuote> {
  const query = new URLSearchParams({ stage });
  if (targetStage) query.set("target_stage", targetStage);
  const payload = await requestJson<{ quote: CreditQuote }>(
    `/api/projects/${projectId}/agent/credit-quote?${query.toString()}`,
    options
  );
  return payload.quote;
}

export async function getSessionUser(options?: RequestOptions): Promise<User | null> {
  const payload = await requestJson<{ user: User | null }>("/api/auth/session", options);
  return payload.user;
}

export async function getProjects(query?: string, options?: RequestOptions): Promise<Project[]> {
  const payload = await requestJson<{ projects: Project[] }>(
    `/api/projects${query ? `?query=${encodeURIComponent(query)}` : ""}`,
    options
  );
  return payload.projects;
}

export async function updateProject(
  projectId: number,
  patch: Partial<Pick<Project, "name" | "pinned">>,
  options?: RequestOptions
) {
  const payload = await requestJson<{ project: Project }>(`/api/projects/${projectId}`, {
    method: "PATCH",
    json: patch,
    ...options
  });
  return payload.project;
}

export async function getProjectMembers(projectId: number, options?: RequestOptions): Promise<ProjectMembersPayload> {
  return requestJson<ProjectMembersPayload>(`/api/projects/${projectId}/members`, options);
}

export async function addProjectMemberPermission(
  projectId: number,
  username: string,
  permission: "view" | "edit",
  options?: RequestOptions
): Promise<ProjectMember> {
  const payload = await requestJson<{ member: ProjectMember }>(`/api/projects/${projectId}/members`, {
    method: "PUT",
    json: { username, permission },
    ...options
  });
  return payload.member;
}

export async function setProjectMemberPermission(
  projectId: number,
  userId: number,
  permission: "view" | "edit",
  options?: RequestOptions
): Promise<ProjectMember> {
  const payload = await requestJson<{ member: ProjectMember }>(`/api/projects/${projectId}/members/${userId}`, {
    method: "PUT",
    json: { permission },
    ...options
  });
  return payload.member;
}

export async function removeProjectMemberPermission(projectId: number, userId: number, options?: RequestOptions) {
  await requestJson<{ ok: boolean }>(`/api/projects/${projectId}/members/${userId}`, {
    method: "DELETE",
    ...options
  });
}

export async function deleteProject(projectId: number, options?: RequestOptions) {
  await requestJson<{ ok: boolean }>(`/api/projects/${projectId}`, { method: "DELETE", ...options });
}

export async function archiveProject(
  projectId: number,
  expectedHash?: string,
  jobId?: number,
  options?: RequestOptions
): Promise<Project> {
  const payload = await requestJson<{ project: Project }>(`/api/projects/${projectId}/archive`, {
    method: "POST",
    json: { expected_hash: expectedHash, job_id: jobId },
    ...options
  });
  return payload.project;
}

export async function reopenProject(projectId: number, options?: RequestOptions): Promise<Project> {
  const payload = await requestJson<{ project: Project }>(`/api/projects/${projectId}/reopen`, {
    method: "POST",
    budget: "projectReopen",
    ...options
  });
  return payload.project;
}

export async function getTrashedProjects(
  page = 1,
  pageSize = 10,
  options?: RequestOptions
): Promise<TrashedProjectPage> {
  return requestJson<TrashedProjectPage>(`/api/projects/trash?page=${page}&page_size=${pageSize}`, options);
}

export async function restoreProject(projectId: number, options?: RequestOptions): Promise<Project> {
  const payload = await requestJson<{ project: Project }>(`/api/projects/trash/${projectId}/restore`, {
    method: "POST",
    ...options
  });
  return payload.project;
}

export async function permanentlyDeleteProject(projectId: number, options?: RequestOptions) {
  await requestJson<{ ok: boolean }>(`/api/projects/trash/${projectId}`, { method: "DELETE", ...options });
}

export async function createProject(formData: FormData, options?: RequestOptions): Promise<Project> {
  const payload = await requestJson<{ project: Project }>("/api/projects", {
    method: "POST",
    form: formData,
    ...options
  });
  return payload.project;
}

export async function getBatchTaskScenarios(
  options?: RequestOptions
): Promise<{ scenarios: BatchTaskScenario[]; regions: TargetRegion[] }> {
  return requestJson<{ scenarios: BatchTaskScenario[]; regions: TargetRegion[] }>(
    "/api/batch-tasks/scenarios",
    options
  );
}

export async function getBatchTasks(
  filters: {
    scenario?: string;
    status?: string;
    query?: string;
  } = {},
  options?: RequestOptions
): Promise<BatchTasksPayload> {
  const search = new URLSearchParams();
  if (filters.scenario) search.set("scenario", filters.scenario);
  if (filters.status) search.set("task_status", filters.status);
  if (filters.query) search.set("query", filters.query);
  const suffix = search.size ? `?${search.toString()}` : "";
  return requestJson<BatchTasksPayload>(`/api/batch-tasks${suffix}`, options);
}

export async function createBatchTasks(
  batchName: string,
  tasks: Array<Record<string, unknown> & { source_file: File }>,
  options?: RequestOptions
) {
  const formData = new FormData();
  const payload = tasks.map((task, index) => {
    const { source_file: sourceFile, ...values } = task;
    const sourceFileKey = `source_file_${index}`;
    formData.append(sourceFileKey, sourceFile);
    return { ...values, source_file_key: sourceFileKey };
  });
  formData.set("batch_name", batchName);
  formData.set("tasks", JSON.stringify(payload));
  return requestJson<{ batch: { id: number; name: string }; tasks: BatchTask[] }>("/api/batch-tasks", {
    method: "POST",
    form: formData,
    ...options
  });
}

export async function startAllBatchTasks(options?: RequestOptions): Promise<{ updated: number }> {
  return requestJson<{ updated: number }>("/api/batch-tasks/start-all", { method: "POST", ...options });
}

export async function batchTaskAction(
  action: "start" | "pause" | "rerun" | "delete",
  taskIds: number[],
  options?: RequestOptions
) {
  return requestJson<{ updated: number; failures: Array<{ task_id: number; message: string }> }>(
    "/api/batch-tasks/bulk",
    {
      method: "POST",
      json: { action, task_ids: taskIds },
      ...options
    }
  );
}

export async function startBatchTask(taskId: number, options?: RequestOptions): Promise<BatchTask> {
  const payload = await requestJson<{ task: BatchTask }>(`/api/batch-tasks/${taskId}/start`, {
    method: "POST",
    ...options
  });
  return payload.task;
}

export async function pauseBatchTask(taskId: number, options?: RequestOptions): Promise<BatchTask> {
  const payload = await requestJson<{ task: BatchTask }>(`/api/batch-tasks/${taskId}/pause`, {
    method: "POST",
    ...options
  });
  return payload.task;
}

export async function rerunBatchTask(taskId: number, options?: RequestOptions): Promise<BatchTask> {
  const payload = await requestJson<{ task: BatchTask }>(`/api/batch-tasks/${taskId}/rerun`, {
    method: "POST",
    ...options
  });
  return payload.task;
}

export async function deleteBatchTask(taskId: number, options?: RequestOptions) {
  return requestJson<{ ok: boolean }>(`/api/batch-tasks/${taskId}`, { method: "DELETE", ...options });
}

export async function getProjectInitialization(
  projectId: number,
  options?: RequestOptions
): Promise<ProjectInitialization> {
  const payload = await requestJson<{ initialization: ProjectInitialization }>(
    `/api/projects/${projectId}/initialization`,
    options
  );
  return payload.initialization;
}

export async function reinitializeProject(
  projectId: number,
  input: ProjectReinitializeInput,
  options?: RequestOptions
): Promise<ProjectInitialization> {
  const payload = await requestJson<{ initialization: ProjectInitialization }>(
    `/api/projects/${projectId}/reinitialize`,
    {
      method: "POST",
      json: input,
      budget: "projectReinitialize",
      ...options
    }
  );
  return payload.initialization;
}

export async function getTargetRegions(options?: RequestOptions): Promise<TargetRegion[]> {
  const payload = await requestJson<{ regions: TargetRegion[] }>("/api/projects/regions", options);
  return payload.regions;
}

export async function getScriptTagTaxonomy(options?: RequestOptions): Promise<ScriptTagTaxonomy> {
  const payload = await requestJson<{ taxonomy: ScriptTagTaxonomy }>("/api/projects/script-tags", options);
  return payload.taxonomy;
}

export async function getDistributionBrief(
  projectId: number,
  options?: RequestOptions
): Promise<DistributionBriefSnapshot> {
  const payload = await requestJson<{ distribution_brief: DistributionBriefSnapshot }>(
    `/api/projects/${projectId}/distribution-brief`,
    { budget: "distributionBriefRead", ...options }
  );
  return payload.distribution_brief;
}

export async function updateDistributionBrief(
  projectId: number,
  brief: DistributionBriefInput,
  confirmed: boolean,
  expectedHash: string,
  options?: RequestOptions
): Promise<DistributionBriefSnapshot> {
  const payload = await requestJson<{ distribution_brief: DistributionBriefSnapshot }>(
    `/api/projects/${projectId}/distribution-brief`,
    {
      method: "PUT",
      json: { ...brief, confirmed, expected_hash: expectedHash },
      budget: "distributionBriefSave",
      ...options
    }
  );
  return payload.distribution_brief;
}

export async function getFiles(projectId: number, options?: RequestOptions): Promise<StageFile[]> {
  const payload = await requestJson<{ files: StageFile[] }>(`/api/projects/${projectId}/files`, options);
  return payload.files;
}

export async function getFile(projectId: number, stage: string, options?: RequestOptions): Promise<StageDocument> {
  const payload = await requestJson<{ file: StageDocument }>(`/api/projects/${projectId}/files/${stage}`, options);
  return payload.file;
}

export async function saveFile(
  projectId: number,
  stage: string,
  content: string,
  expectedHash?: string,
  options?: RequestOptions
): Promise<StageDocument> {
  const payload = await requestJson<{ file: StageDocument }>(`/api/projects/${projectId}/files/${stage}`, {
    method: "PUT",
    json: { content, expected_hash: expectedHash },
    budget: "stageSave",
    ...options
  });
  return payload.file;
}

export async function getDocumentComments(
  projectId: number,
  stage: string,
  options?: RequestOptions
): Promise<DocumentCommentThread[]> {
  const payload = await requestJson<{ comments: DocumentCommentThread[] }>(
    `/api/projects/${projectId}/files/${encodeURIComponent(stage)}/comments`,
    options
  );
  return payload.comments;
}

export async function createDocumentComment(
  projectId: number,
  stage: string,
  comment: DocumentCommentCreateInput,
  options?: RequestOptions
): Promise<DocumentCommentThread> {
  const payload = await requestJson<{ comment: DocumentCommentThread }>(
    `/api/projects/${projectId}/files/${encodeURIComponent(stage)}/comments`,
    {
      method: "POST",
      json: comment,
      ...options
    }
  );
  return payload.comment;
}

export async function replyToDocumentComment(
  projectId: number,
  stage: string,
  threadId: number,
  content: string,
  options?: RequestOptions
): Promise<DocumentCommentThread> {
  const payload = await requestJson<{ comment: DocumentCommentThread }>(
    `/api/projects/${projectId}/files/${encodeURIComponent(stage)}/comments/${threadId}/replies`,
    {
      method: "POST",
      json: { content },
      ...options
    }
  );
  return payload.comment;
}

export async function deleteDocumentCommentMessage(
  projectId: number,
  stage: string,
  threadId: number,
  messageId: number,
  options?: RequestOptions
): Promise<{ thread_id: number; message_id: number; thread_deleted: boolean }> {
  const payload = await requestJson<{
    result: { thread_id: number; message_id: number; thread_deleted: boolean };
  }>(
    `/api/projects/${projectId}/files/${encodeURIComponent(stage)}/comments/${threadId}/messages/${messageId}`,
    { method: "DELETE", ...options }
  );
  return payload.result;
}

export async function updateOutlineTitle(
  projectId: number,
  payload: { title: string; english_title?: string; expected_hash: string },
  options?: RequestOptions
): Promise<{ project: Project; file: StageDocument }> {
  return requestJson<{ project: Project; file: StageDocument }>(`/api/projects/${projectId}/outline-title`, {
    method: "PUT",
    json: payload,
    budget: "outlineTitleSync",
    ...options
  });
}

export async function getFileVersions(
  projectId: number,
  stage: string,
  options?: RequestOptions
): Promise<FileVersionHistory> {
  const payload = await requestJson<{ history: FileVersionHistory }>(
    `/api/projects/${projectId}/files/${encodeURIComponent(stage)}/versions`,
    options
  );
  return payload.history;
}

export async function getFileVersion(
  projectId: number,
  stage: string,
  versionId: number,
  options?: RequestOptions
): Promise<FileVersion> {
  const payload = await requestJson<{ version: FileVersion }>(
    `/api/projects/${projectId}/files/${encodeURIComponent(stage)}/versions/${versionId}`,
    options
  );
  return payload.version;
}

export async function restoreFileVersion(
  projectId: number,
  stage: string,
  versionId: number,
  expectedHash: string,
  options?: RequestOptions
): Promise<StageDocument> {
  const payload = await requestJson<{ file: StageDocument }>(
    `/api/projects/${projectId}/files/${encodeURIComponent(stage)}/versions/${versionId}/restore`,
    {
      method: "POST",
      json: { expected_hash: expectedHash },
      ...options
    }
  );
  return payload.file;
}

export async function getProjectMemory(projectId: number, options?: RequestOptions): Promise<ProjectMemoryStatus> {
  const payload = await requestJson<{ memory: ProjectMemoryStatus }>(`/api/projects/${projectId}/memory`, {
    budget: "projectMemoryRead",
    ...options
  });
  return payload.memory;
}

export async function approveStage(
  projectId: number,
  stage: string,
  expectedHash?: string,
  jobId?: number,
  options?: RequestOptions
) {
  return requestJson<{ approval: { stage: string; status: string; memory: ProjectMemoryStatus } }>(
    `/api/projects/${projectId}/stages/${encodeURIComponent(stage)}/approve`,
    {
      method: "POST",
      json: { expected_hash: expectedHash, job_id: jobId },
      budget: "stageApprove",
      ...options
    }
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
  },
  options?: RequestOptions
): Promise<AgentJob> {
  const response = await requestJson<{ job: AgentJob }>(`/api/projects/${projectId}/agent/jobs`, {
    method: "POST",
    json: payload,
    ...options
  });
  return response.job;
}

export async function retryAgentJob(jobId: number, options?: RequestOptions): Promise<AgentJob> {
  const response = await requestJson<{ job: AgentJob }>(`/api/agent/jobs/${jobId}/retry`, {
    method: "POST",
    ...options
  });
  return response.job;
}

export async function getAgentHistory(
  projectId: number,
  stage?: string,
  options?: RequestOptions
): Promise<AgentHistory> {
  const query = stage ? `?stage=${encodeURIComponent(stage)}` : "";
  return requestJson<AgentHistory>(`/api/projects/${projectId}/agent/history${query}`, options);
}

export async function getActiveAgentJob(
  projectId: number,
  options?: RequestOptions
): Promise<{ job: AgentJob | null; events: AgentEvent[] }> {
  return requestJson<{ job: AgentJob | null; events: AgentEvent[] }>(
    `/api/projects/${projectId}/agent/jobs`,
    options
  );
}

export async function getAgentEvents(
  jobId: number,
  afterId = 0,
  options?: RequestOptions
): Promise<{ job: AgentJob; events: AgentEvent[] }> {
  return requestJson<{ job: AgentJob; events: AgentEvent[] }>(
    `/api/agent/jobs/${jobId}/events?after_id=${afterId}`,
    options
  );
}

export async function getNotifications(options?: RequestOptions): Promise<NotificationsPayload> {
  return requestJson<NotificationsPayload>("/api/notifications?limit=30", options);
}

export async function markNotificationsRead(options?: RequestOptions): Promise<{ updated: number }> {
  return requestJson<{ updated: number }>("/api/notifications/read", { method: "POST", ...options });
}

export async function markNotificationRead(
  notificationId: number,
  options?: RequestOptions
): Promise<{ updated: boolean }> {
  return requestJson<{ updated: boolean }>(`/api/notifications/${notificationId}/read`, {
    method: "POST",
    ...options
  });
}

export async function cancelAgentJob(jobId: number, options?: RequestOptions): Promise<AgentJob> {
  const payload = await requestJson<{ job: AgentJob }>(`/api/agent/jobs/${jobId}/cancel`, {
    method: "POST",
    ...options
  });
  return payload.job;
}

export async function startAgentDebug(jobId: number, options?: RequestOptions): Promise<AgentDebugSession> {
  const payload = await requestJson<{ debug: AgentDebugSession }>(`/api/agent/jobs/${jobId}/debug`, {
    method: "POST",
    ...options
  });
  return payload.debug;
}

export async function getWriterPreferences(options?: RequestOptions): Promise<WriterPreferencesPayload> {
  return requestJson<WriterPreferencesPayload>("/api/me/writer-preferences", options);
}

export async function exportWriterPreferences(options?: RequestOptions): Promise<WriterPreferencesBackup> {
  return requestJson<WriterPreferencesBackup>("/api/me/writer-preferences/export", options);
}

export async function importWriterPreferences(
  payload: {
    schema_version: string;
    preferences: WriterPreferenceBackupItem[];
    mode: WriterPreferenceImportMode;
  },
  options?: RequestOptions
): Promise<WriterPreferenceImportResult> {
  return requestJson<WriterPreferenceImportResult>("/api/me/writer-preferences/import", {
    method: "POST",
    json: payload,
    ...options
  });
}

export async function createWriterPreference(
  payload: {
    content: string;
    scopes: WriterPreferenceScopeKey[];
    enabled: boolean;
  },
  options?: RequestOptions
): Promise<{ preference: WriterPreference; profile_revision: number }> {
  return requestJson<{ preference: WriterPreference; profile_revision: number }>("/api/me/writer-preferences", {
    method: "POST",
    json: payload,
    ...options
  });
}

export async function updateWriterPreference(
  preferenceId: number,
  patch: Partial<Pick<WriterPreference, "content" | "scopes" | "enabled">>,
  options?: RequestOptions
): Promise<{ preference: WriterPreference; profile_revision: number }> {
  return requestJson<{ preference: WriterPreference; profile_revision: number }>(
    `/api/me/writer-preferences/${preferenceId}`,
    {
      method: "PATCH",
      json: patch,
      ...options
    }
  );
}

export async function deleteWriterPreference(
  preferenceId: number,
  options?: RequestOptions
): Promise<{ ok: boolean; profile_revision: number }> {
  return requestJson<{ ok: boolean; profile_revision: number }>(`/api/me/writer-preferences/${preferenceId}`, {
    method: "DELETE",
    ...options
  });
}

export async function reorderWriterPreferences(
  orderedIds: number[],
  options?: RequestOptions
): Promise<WriterPreferencesPayload> {
  return requestJson<WriterPreferencesPayload>("/api/me/writer-preferences/order", {
    method: "PUT",
    json: { ordered_ids: orderedIds },
    ...options
  });
}
