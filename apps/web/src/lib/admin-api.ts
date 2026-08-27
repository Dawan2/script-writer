import type {
  AdminAgentEvolutionPayload,
  AdminAgentEvolutionRun,
  AdminCreditsPayload,
  AdminRole,
  AdminWriterPreference,
  AdminDashboard,
  AdminJob,
  AdminProject,
  AdminSystemNotification,
  AdminUser,
  AdminUsersPayload,
  AuditLog,
  DashboardPeriod,
  DashboardTaskType,
  ModelConfig,
  ModelConfigTestResult,
  ModelManagementPayload,
  Pagination,
  ProjectLifecycle,
  RegionRulesConfig,
  RegionRulesPayload,
  RoleManagementPayload,
  ScriptSyncConfig,
  ScriptSyncJob,
  ScriptSyncScriptsPayload,
  ScriptSyncStatus,
  ScriptSyncTargetTest,
  ScriptFormulaCard,
  ScriptFormulaPayload,
  ScriptLibraryPayload,
  ScriptLibraryScript,
  ScriptLibraryTagKind,
  ScriptLibraryStatus,
  ScriptSourceChunk
} from "@/lib/admin-types";
import type { AgentDebugSession } from "@/lib/types";
import { requestJson, type RequestOptions } from "@/lib/request-core";

function queryString(values: Record<string, string | number | undefined | null>) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  });
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function getAdminDashboard(
  filters: {
    period: DashboardPeriod;
    operatorUserId?: number;
    taskType?: DashboardTaskType;
    startDate?: string;
    endDate?: string;
  },
  options?: RequestOptions
) {
  return requestJson<AdminDashboard>(
    `/api/admin/dashboard${queryString({
      period: filters.period,
      operator_user_id: filters.operatorUserId,
      task_type: filters.taskType,
      start_date: filters.startDate,
      end_date: filters.endDate
    })}`,
    options
  );
}

export function getAdminUsers(query?: string, options?: RequestOptions) {
  return requestJson<AdminUsersPayload>(`/api/admin/users${queryString({ query })}`, options);
}

export function getAdminRoleManagement(options?: RequestOptions) {
  return requestJson<RoleManagementPayload>("/api/admin/role-management", options);
}

export function createAdminRole(
  payload: { name: string; description: string; permission_keys?: string[] },
  options?: RequestOptions
) {
  return requestJson<{ role: AdminRole }>("/api/admin/role-management/roles", {
    method: "POST",
    json: payload,
    ...options
  });
}

export function updateAdminRole(
  roleId: number,
  payload: Partial<{ name: string; description: string; permission_keys: string[] }>,
  options?: RequestOptions
) {
  return requestJson<{ role: AdminRole }>(`/api/admin/role-management/roles/${roleId}`, {
    method: "PUT",
    json: payload,
    ...options
  });
}

export function deleteAdminRole(roleId: number, options?: RequestOptions) {
  return requestJson<{ ok: boolean }>(`/api/admin/role-management/roles/${roleId}`, {
    method: "DELETE",
    ...options
  });
}

export function getAdminSystemNotifications(options?: RequestOptions) {
  return requestJson<{ notifications: AdminSystemNotification[] }>("/api/admin/system-notifications", options);
}

export function publishAdminSystemNotification(
  payload: { title: string; message: string },
  options?: RequestOptions
) {
  return requestJson<{ notification: AdminSystemNotification }>("/api/admin/system-notifications", {
    method: "POST",
    json: payload,
    ...options
  });
}

export function getAdminCredits(options?: RequestOptions) {
  return requestJson<AdminCreditsPayload>("/api/admin/credits", options);
}

export function updateAdminCreditPrices(prices: Record<string, number>, options?: RequestOptions) {
  return requestJson<{ prices: AdminCreditsPayload["prices"] }>("/api/admin/credits/prices", {
    method: "PUT",
    json: { prices },
    ...options
  });
}

export function adjustAdminCredits(userId: number, delta: number, note: string, options?: RequestOptions) {
  return requestJson<{ account: { user_id: number; balance: number } }>(
    `/api/admin/credits/users/${userId}/adjust`,
    {
      method: "POST",
      json: { delta, note },
      ...options
    }
  );
}

export function updateAdminCreditPlan(
  userId: number,
  planCode: "free" | "basic" | "advanced",
  options?: RequestOptions
) {
  return requestJson<{
    account: Pick<
      AdminCreditsPayload["accounts"][number],
      "user_id" | "balance" | "plan" | "plan_term" | "plan_grant"
    >;
  }>(`/api/admin/credits/users/${userId}/plan`, {
    method: "PUT",
    json: { plan_code: planCode },
    ...options
  });
}

export function createAdminUser(
  payload: {
    username: string;
    display_name: string;
    password: string;
    role?: "admin" | "user";
    role_ids?: number[];
  },
  options?: RequestOptions
) {
  return requestJson<{ user: AdminUser }>("/api/admin/users", {
    method: "POST",
    json: payload,
    ...options
  });
}

export function updateAdminUser(
  userId: number,
  patch: {
    display_name?: string;
    role?: "admin" | "user";
    role_ids?: number[];
    password?: string;
  },
  options?: RequestOptions
) {
  return requestJson<{ user: AdminUser }>(`/api/admin/users/${userId}`, {
    method: "PATCH",
    json: patch,
    ...options
  });
}

export function deleteAdminUser(userId: number, transferToUserId?: number, options?: RequestOptions) {
  return requestJson<{ ok: boolean; transferred_projects: number }>(`/api/admin/users/${userId}`, {
    method: "DELETE",
    json: { transfer_to_user_id: transferToUserId },
    ...options
  });
}

export function getAdminRegions(options?: RequestOptions) {
  return requestJson<RegionRulesPayload>("/api/admin/regions", options);
}

export function saveAdminRegions(config: RegionRulesConfig, expectedHash: string, options?: RequestOptions) {
  return requestJson<RegionRulesPayload>("/api/admin/regions", {
    method: "PUT",
    json: { config, expected_hash: expectedHash },
    ...options
  });
}

export function getAdminModelManagement(options?: RequestOptions) {
  return requestJson<ModelManagementPayload>("/api/admin/model-management", options);
}

export function createAdminModelConfig(
  payload: {
    name: string;
    model_type: ModelConfig["model_type"];
    request_url: string;
    api_key: string;
    model_name: string;
    api_protocol: ModelConfig["api_protocol"];
    thinking_level: ModelConfig["thinking_level"];
    image_size: string;
    image_output_format: ModelConfig["image_output_format"];
    image_watermark: boolean;
    fallback_model_id: number | null;
    is_enabled: boolean;
  },
  options?: RequestOptions
) {
  return requestJson<{ model: ModelConfig }>("/api/admin/model-management/models", {
    method: "POST",
    json: payload,
    ...options
  });
}

export function updateAdminModelConfig(
  modelId: number,
  payload: Partial<{
    name: string;
    request_url: string;
    api_key: string;
    model_name: string;
    api_protocol: ModelConfig["api_protocol"];
    thinking_level: ModelConfig["thinking_level"];
    image_size: string;
    image_output_format: ModelConfig["image_output_format"];
    image_watermark: boolean;
    fallback_model_id: number | null;
    is_enabled: boolean;
  }>,
  options?: RequestOptions
) {
  return requestJson<{ model: ModelConfig }>(`/api/admin/model-management/models/${modelId}`, {
    method: "PUT",
    json: payload,
    ...options
  });
}

export function deleteAdminModelConfig(modelId: number, options?: RequestOptions) {
  return requestJson<{ ok: boolean }>(`/api/admin/model-management/models/${modelId}`, {
    method: "DELETE",
    ...options
  });
}

export function testAdminModelConfig(modelId: number, options?: RequestOptions) {
  return requestJson<{ result: ModelConfigTestResult }>(`/api/admin/model-management/models/${modelId}/test`, {
    method: "POST",
    ...options
  });
}

export function updateAdminFunctionModelRoute(
  scenarioKey: string,
  actionKey: string,
  modelConfigId: number,
  options?: RequestOptions
) {
  return requestJson<{ route: ModelManagementPayload["routes"][number] }>(
    `/api/admin/model-management/routes/${encodeURIComponent(scenarioKey)}/${encodeURIComponent(actionKey)}`,
    {
      method: "PUT",
      json: { model_config_id: modelConfigId },
      ...options
    }
  );
}

export function updateAdminFunctionModelRoutes(
  payload: {
    model_config_id: number;
    route_keys: Array<Pick<ModelManagementPayload["routes"][number], "scenario_key" | "action_key">>;
  },
  options?: RequestOptions
) {
  return requestJson<{ updated_count: number; routes: ModelManagementPayload["routes"] }>(
    "/api/admin/model-management/routes/batch",
    {
      method: "PUT",
      json: payload,
      ...options
    }
  );
}

export function getAdminProjects(
  filters: {
    query?: string;
    lifecycle?: "all" | ProjectLifecycle;
    taskType?: "rewrite" | "novel" | "replicate" | "review" | "translate" | "humanize";
    region?: string;
    ownerUserId?: number;
    page?: number;
  },
  options?: RequestOptions
) {
  return requestJson<{ projects: AdminProject[]; pagination: Pagination }>(
    `/api/admin/projects${queryString({
      query: filters.query,
      lifecycle: filters.lifecycle,
      task_type: filters.taskType,
      region: filters.region,
      owner_user_id: filters.ownerUserId,
      page: filters.page
    })}`,
    options
  );
}

export function updateAdminProject(
  projectId: number,
  patch: { name?: string; owner_user_id?: number; target_region?: string },
  options?: RequestOptions
) {
  return requestJson<{ project: AdminProject }>(`/api/admin/projects/${projectId}`, {
    method: "PATCH",
    json: patch,
    ...options
  });
}

export function bulkAdminProjectAction(
  action: "archive" | "trash",
  projectIds: number[],
  options?: RequestOptions
) {
  return requestJson<{ succeeded: number[]; failed: Array<{ project_id: number; message: string }> }>(
    "/api/admin/projects/bulk-actions",
    {
      method: "POST",
      json: { action, project_ids: projectIds },
      ...options
    }
  );
}

export function trashAdminProject(projectId: number, options?: RequestOptions) {
  return requestJson<{ ok: boolean }>(`/api/admin/projects/${projectId}`, { method: "DELETE", ...options });
}

export function restoreAdminProject(projectId: number, options?: RequestOptions) {
  return requestJson<{ project: AdminProject }>(`/api/admin/projects/${projectId}/restore`, {
    method: "POST",
    ...options
  });
}

export function purgeAdminProject(projectId: number, options?: RequestOptions) {
  return requestJson<{ ok: boolean }>(`/api/admin/projects/${projectId}/permanent`, {
    method: "DELETE",
    ...options
  });
}

export function getAdminJobs(
  filters: { query?: string; status?: string; page?: number },
  options?: RequestOptions
) {
  return requestJson<{ jobs: AdminJob[]; pagination: Pagination }>(
    `/api/admin/jobs${queryString({
      query: filters.query,
      job_status: filters.status,
      page: filters.page
    })}`,
    options
  );
}

export function cancelAdminJob(jobId: number, options?: RequestOptions) {
  return requestJson<{ job: AdminJob }>(`/api/admin/jobs/${jobId}/cancel`, { method: "POST", ...options });
}

export function retryAdminJob(jobId: number, options?: RequestOptions) {
  return requestJson<{ job: AdminJob }>(`/api/admin/jobs/${jobId}/retry`, { method: "POST", ...options });
}

export function getAuditLogs(
  filters: {
    query?: string;
    action?: string;
    projectId?: number;
    outcome?: "success" | "failure" | "denied";
    source?: "web" | "api" | "system";
    page?: number;
  },
  options?: RequestOptions
) {
  return requestJson<{ logs: AuditLog[]; pagination: Pagination }>(
    `/api/admin/audit-logs${queryString({
      query: filters.query,
      action: filters.action,
      project_id: filters.projectId,
      outcome: filters.outcome,
      source: filters.source,
      page: filters.page
    })}`,
    options
  );
}

export function getAdminAgentEvolution(options?: RequestOptions) {
  return requestJson<AdminAgentEvolutionPayload>("/api/admin/agent-evolution", options);
}

export function setAdminSystemWriterPreferences(preferenceIds: number[], options?: RequestOptions) {
  return requestJson<{
    created_system_preference_ids: number[];
    existing_system_preference_ids: number[];
    affected_user_count: number;
    preferences: AdminWriterPreference[];
  }>("/api/admin/agent-evolution/preferences/system", {
    method: "POST",
    json: { preference_ids: preferenceIds },
    ...options
  });
}

export function removeAdminSystemWriterPreferences(preferenceIds: number[], options?: RequestOptions) {
  return requestJson<{
    removed_system_preference_ids: number[];
    affected_user_count: number;
    preferences: AdminWriterPreference[];
  }>("/api/admin/agent-evolution/preferences/system", {
    method: "DELETE",
    json: { preference_ids: preferenceIds },
    ...options
  });
}

export function getAdminAgentEvolutionRun(runId: number, options?: RequestOptions) {
  return requestJson<{ run: AdminAgentEvolutionRun }>(`/api/admin/agent-evolution/runs/${runId}`, options);
}

export function createAdminAgentEvolutionRun(options?: RequestOptions) {
  return requestJson<{ run: AdminAgentEvolutionRun }>("/api/admin/agent-evolution/runs", {
    method: "POST",
    ...options
  });
}

export function retryAdminAgentEvolutionRun(runId: number, options?: RequestOptions) {
  return requestJson<{ run: AdminAgentEvolutionRun }>(`/api/admin/agent-evolution/runs/${runId}/retry`, {
    method: "POST",
    ...options
  });
}

export function startAdminAgentEvolutionDebug(runId: number, options?: RequestOptions) {
  return requestJson<{ debug: AgentDebugSession }>(`/api/admin/agent-evolution/runs/${runId}/debug`, {
    method: "POST",
    ...options
  });
}

export function dismissAdminAgentEvolutionRun(runId: number, options?: RequestOptions) {
  return requestJson<{ run: AdminAgentEvolutionRun }>(`/api/admin/agent-evolution/runs/${runId}/dismiss`, {
    method: "POST",
    ...options
  });
}

export function executeAdminAgentEvolutionRun(runId: number, requirements: string, options?: RequestOptions) {
  return requestJson<{ run: AdminAgentEvolutionRun }>(`/api/admin/agent-evolution/runs/${runId}/execute`, {
    method: "POST",
    json: { requirements },
    ...options
  });
}

export function getAdminScriptSyncConfig(options?: RequestOptions) {
  return requestJson<ScriptSyncConfig>("/api/admin/script-sync/config", options);
}

export function testAdminScriptSyncTarget(url: string, options?: RequestOptions) {
  return requestJson<ScriptSyncTargetTest>("/api/admin/script-sync/config/test", {
    method: "POST",
    json: { url },
    ...options
  });
}

export function startAdminScriptSyncAuthorization(options?: RequestOptions) {
  return requestJson<{ authorization_url: string }>("/api/admin/script-sync/config/authorization", {
    method: "POST",
    ...options
  });
}

export function completeAdminScriptSyncAuthorization(options?: RequestOptions) {
  return requestJson<{ authorized: boolean }>("/api/admin/script-sync/config/authorization/complete", {
    method: "POST",
    ...options
  });
}

export function saveAdminScriptSyncConfig(
  payload: {
    url: string;
    mappings: Array<{ source_key: string; target_field_id: string | null; auto_create: boolean }>;
  },
  options?: RequestOptions
) {
  return requestJson<ScriptSyncConfig>("/api/admin/script-sync/config", {
    method: "PUT",
    json: payload,
    ...options
  });
}

export function getAdminScriptSyncScripts(
  filters: {
    query?: string;
    scenario?: "rewrite" | "novel" | "replicate";
    operator?: string;
    statuses?: ScriptSyncStatus[];
  },
  options?: RequestOptions
) {
  return requestJson<ScriptSyncScriptsPayload>(
    `/api/admin/script-sync/scripts${queryString({
      query: filters.query,
      scenario: filters.scenario,
      operator: filters.operator,
      sync_status: filters.statuses?.join(",")
    })}`,
    options
  );
}

export function getActiveAdminScriptSyncJobs(options?: RequestOptions) {
  return requestJson<{ jobs: ScriptSyncJob[] }>("/api/admin/script-sync/jobs/active", options);
}

export function enqueueAdminScriptSyncJobs(projectIds: number[], options?: RequestOptions) {
  return requestJson<{
    jobs: ScriptSyncJob[];
    queued_project_ids: number[];
    already_active_project_ids: number[];
  }>("/api/admin/script-sync/jobs", {
    method: "POST",
    json: { project_ids: projectIds },
    ...options
  });
}

export function ignoreAdminScriptSync(projectId: number, options?: RequestOptions) {
  return requestJson<{ sync: { project_id: number; status: "ignored" } }>(
    `/api/admin/script-sync/scripts/${projectId}/ignore`,
    { method: "POST", ...options }
  );
}

export function getAdminScriptLibrary(
  filters: {
    query?: string;
    status?: ScriptLibraryStatus;
    tags?: Partial<Record<ScriptLibraryTagKind, string>>;
    page?: number;
  },
  options?: RequestOptions
) {
  return requestJson<ScriptLibraryPayload>(
    `/api/admin/script-library/scripts${queryString({
      query: filters.query,
      script_status: filters.status,
      theme: filters.tags?.theme,
      setting: filters.tags?.setting,
      background: filters.tags?.background,
      audience: filters.tags?.audience,
      page: filters.page
    })}`,
    options
  );
}

export function getAdminScriptLibraryScript(scriptId: number, options?: RequestOptions) {
  return requestJson<{ script: ScriptLibraryScript }>(`/api/admin/script-library/scripts/${scriptId}`, options);
}

export function uploadAdminScripts(files: File[], options?: RequestOptions) {
  const body = new FormData();
  files.forEach((file) => body.append("files", file));
  return requestJson<{
    scripts: ScriptLibraryScript[];
    job_ids: number[];
    rejected: Array<{ filename: string; message: string }>;
  }>("/api/admin/script-library/scripts", {
    method: "POST",
    form: body,
    ...options
  });
}

export function updateAdminScriptLibraryScript(
  scriptId: number,
  payload: { title?: string; tags?: Record<ScriptLibraryTagKind, string[]> },
  options?: RequestOptions
) {
  return requestJson<{ script: ScriptLibraryScript }>(`/api/admin/script-library/scripts/${scriptId}`, {
    method: "PATCH",
    json: payload,
    ...options
  });
}

export function deleteAdminScriptLibraryScript(scriptId: number, options?: RequestOptions) {
  return requestJson<{ ok: boolean }>(`/api/admin/script-library/scripts/${scriptId}`, {
    method: "DELETE",
    ...options
  });
}

export function retryAdminScriptDistillation(scriptId: number, options?: RequestOptions) {
  return requestJson<{ script: ScriptLibraryScript; job_id: number }>(
    `/api/admin/script-library/scripts/${scriptId}/retry`,
    { method: "POST", ...options }
  );
}

export function getAdminScriptSource(scriptId: number, query?: string, options?: RequestOptions) {
  return requestJson<{ chunks: ScriptSourceChunk[] }>(
    `/api/admin/script-library/scripts/${scriptId}/source${queryString({ query })}`,
    options
  );
}

export function getAdminScriptFormulas(
  filters: {
    formulaType?: string;
    cardKind?: "formula" | "principle";
    stage?: string;
    status?: "candidate" | "active";
    query?: string;
    tags?: Partial<Record<ScriptLibraryTagKind, string>>;
    page?: number;
  },
  options?: RequestOptions
) {
  return requestJson<ScriptFormulaPayload>(
    `/api/admin/script-library/formulas${queryString({
      formula_type: filters.formulaType,
      card_kind: filters.cardKind,
      stage: filters.stage,
      verification_status: filters.status,
      query: filters.query,
      theme: filters.tags?.theme,
      setting: filters.tags?.setting,
      background: filters.tags?.background,
      audience: filters.tags?.audience,
      page: filters.page
    })}`,
    options
  );
}

export function deleteAdminScriptFormula(formulaId: string, options?: RequestOptions) {
  return requestJson<{ ok: boolean }>(
    `/api/admin/script-library/formulas/${encodeURIComponent(formulaId)}`,
    { method: "DELETE", ...options }
  );
}
