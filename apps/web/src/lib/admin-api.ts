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
import { apiErrorFromResponse } from "@/lib/api-error";

async function parseJson<T>(responseOrPromise: Response | Promise<Response>): Promise<T> {
  const response = await responseOrPromise;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw apiErrorFromResponse(response.status, payload, response.headers.get("x-request-id"));
  }
  return payload as T;
}

function queryString(values: Record<string, string | number | undefined | null>) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  });
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function getAdminDashboard(filters: {
  period: DashboardPeriod;
  operatorUserId?: number;
  taskType?: DashboardTaskType;
  startDate?: string;
  endDate?: string;
}) {
  return parseJson<AdminDashboard>(fetch(`/api/admin/dashboard${queryString({
    period: filters.period,
    operator_user_id: filters.operatorUserId,
    task_type: filters.taskType,
    start_date: filters.startDate,
    end_date: filters.endDate
  })}`));
}

export function getAdminUsers(query?: string) {
  return parseJson<AdminUsersPayload>(fetch(`/api/admin/users${queryString({ query })}`));
}

export function getAdminRoleManagement() {
  return parseJson<RoleManagementPayload>(fetch("/api/admin/role-management"));
}

export function createAdminRole(payload: { name: string; description: string; permission_keys?: string[] }) {
  return parseJson<{ role: AdminRole }>(fetch("/api/admin/role-management/roles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export function updateAdminRole(roleId: number, payload: Partial<{ name: string; description: string; permission_keys: string[] }>) {
  return parseJson<{ role: AdminRole }>(fetch(`/api/admin/role-management/roles/${roleId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export function deleteAdminRole(roleId: number) {
  return parseJson<{ ok: boolean }>(fetch(`/api/admin/role-management/roles/${roleId}`, { method: "DELETE" }));
}

export function getAdminSystemNotifications() {
  return parseJson<{ notifications: AdminSystemNotification[] }>(fetch("/api/admin/system-notifications"));
}

export function publishAdminSystemNotification(payload: { title: string; message: string }) {
  return parseJson<{ notification: AdminSystemNotification }>(fetch("/api/admin/system-notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export function getAdminCredits() {
  return parseJson<AdminCreditsPayload>(fetch("/api/admin/credits"));
}

export function updateAdminCreditPrices(prices: Record<string, number>) {
  return parseJson<{ prices: AdminCreditsPayload["prices"] }>(fetch("/api/admin/credits/prices", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prices })
  }));
}

export function adjustAdminCredits(userId: number, delta: number, note: string) {
  return parseJson<{ account: { user_id: number; balance: number } }>(fetch(`/api/admin/credits/users/${userId}/adjust`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delta, note })
  }));
}

export function updateAdminCreditPlan(userId: number, planCode: "free" | "basic" | "advanced") {
  return parseJson<{ account: Pick<AdminCreditsPayload["accounts"][number], "user_id" | "balance" | "plan" | "plan_term" | "plan_grant"> }>(
    fetch(`/api/admin/credits/users/${userId}/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_code: planCode })
    })
  );
}

export function createAdminUser(payload: {
  username: string;
  display_name: string;
  password: string;
  role?: "admin" | "user";
  role_ids?: number[];
}) {
  return parseJson<{ user: AdminUser }>(fetch("/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export function updateAdminUser(userId: number, patch: {
  display_name?: string;
  role?: "admin" | "user";
  role_ids?: number[];
  password?: string;
}) {
  return parseJson<{ user: AdminUser }>(fetch(`/api/admin/users/${userId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  }));
}

export function deleteAdminUser(userId: number, transferToUserId?: number) {
  return parseJson<{ ok: boolean; transferred_projects: number }>(fetch(`/api/admin/users/${userId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transfer_to_user_id: transferToUserId })
  }));
}

export function getAdminRegions() {
  return parseJson<RegionRulesPayload>(fetch("/api/admin/regions"));
}

export function saveAdminRegions(config: RegionRulesConfig, expectedHash: string) {
  return parseJson<RegionRulesPayload>(fetch("/api/admin/regions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, expected_hash: expectedHash })
  }));
}

export function getAdminModelManagement() {
  return parseJson<ModelManagementPayload>(fetch("/api/admin/model-management"));
}

export function createAdminModelConfig(payload: {
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
}) {
  return parseJson<{ model: ModelConfig }>(fetch("/api/admin/model-management/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export function updateAdminModelConfig(modelId: number, payload: Partial<{
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
}>) {
  return parseJson<{ model: ModelConfig }>(fetch(`/api/admin/model-management/models/${modelId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export function deleteAdminModelConfig(modelId: number) {
  return parseJson<{ ok: boolean }>(fetch(`/api/admin/model-management/models/${modelId}`, { method: "DELETE" }));
}

export function testAdminModelConfig(modelId: number) {
  return parseJson<{ result: ModelConfigTestResult }>(fetch(`/api/admin/model-management/models/${modelId}/test`, { method: "POST" }));
}

export function updateAdminFunctionModelRoute(scenarioKey: string, actionKey: string, modelConfigId: number) {
  return parseJson<{ route: ModelManagementPayload["routes"][number] }>(
    fetch(`/api/admin/model-management/routes/${encodeURIComponent(scenarioKey)}/${encodeURIComponent(actionKey)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model_config_id: modelConfigId })
    })
  );
}

export function updateAdminFunctionModelRoutes(payload: {
  model_config_id: number;
  route_keys: Array<Pick<ModelManagementPayload["routes"][number], "scenario_key" | "action_key">>;
}) {
  return parseJson<{ updated_count: number; routes: ModelManagementPayload["routes"] }>(
    fetch("/api/admin/model-management/routes/batch", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
}

export function getAdminProjects(filters: {
  query?: string;
  lifecycle?: "all" | ProjectLifecycle;
  taskType?: "rewrite" | "novel" | "replicate" | "review" | "translate" | "humanize";
  region?: string;
  ownerUserId?: number;
  page?: number;
}) {
  return parseJson<{ projects: AdminProject[]; pagination: Pagination }>(fetch(`/api/admin/projects${queryString({
    query: filters.query,
    lifecycle: filters.lifecycle,
    task_type: filters.taskType,
    region: filters.region,
    owner_user_id: filters.ownerUserId,
    page: filters.page
  })}`));
}

export function updateAdminProject(projectId: number, patch: { name?: string; owner_user_id?: number; target_region?: string }) {
  return parseJson<{ project: AdminProject }>(fetch(`/api/admin/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  }));
}

export function bulkAdminProjectAction(action: "archive" | "trash", projectIds: number[]) {
  return parseJson<{ succeeded: number[]; failed: Array<{ project_id: number; message: string }> }>(fetch("/api/admin/projects/bulk-actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, project_ids: projectIds })
  }));
}

export function trashAdminProject(projectId: number) {
  return parseJson<{ ok: boolean }>(fetch(`/api/admin/projects/${projectId}`, { method: "DELETE" }));
}

export function restoreAdminProject(projectId: number) {
  return parseJson<{ project: AdminProject }>(fetch(`/api/admin/projects/${projectId}/restore`, { method: "POST" }));
}

export function purgeAdminProject(projectId: number) {
  return parseJson<{ ok: boolean }>(fetch(`/api/admin/projects/${projectId}/permanent`, { method: "DELETE" }));
}

export function getAdminJobs(filters: { query?: string; status?: string; page?: number }) {
  return parseJson<{ jobs: AdminJob[]; pagination: Pagination }>(fetch(`/api/admin/jobs${queryString({
    query: filters.query,
    job_status: filters.status,
    page: filters.page
  })}`));
}

export function cancelAdminJob(jobId: number) {
  return parseJson<{ job: AdminJob }>(fetch(`/api/admin/jobs/${jobId}/cancel`, { method: "POST" }));
}

export function retryAdminJob(jobId: number) {
  return parseJson<{ job: AdminJob }>(fetch(`/api/admin/jobs/${jobId}/retry`, { method: "POST" }));
}

export function getAuditLogs(filters: {
  query?: string;
  action?: string;
  projectId?: number;
  outcome?: "success" | "failure" | "denied";
  source?: "web" | "api" | "system";
  page?: number;
}) {
  return parseJson<{ logs: AuditLog[]; pagination: Pagination }>(fetch(`/api/admin/audit-logs${queryString({
    query: filters.query,
    action: filters.action,
    project_id: filters.projectId,
    outcome: filters.outcome,
    source: filters.source,
    page: filters.page
  })}`));
}

export function getAdminAgentEvolution() {
  return parseJson<AdminAgentEvolutionPayload>(fetch("/api/admin/agent-evolution"));
}

export function setAdminSystemWriterPreferences(preferenceIds: number[]) {
  return parseJson<{
    created_system_preference_ids: number[];
    existing_system_preference_ids: number[];
    affected_user_count: number;
    preferences: AdminWriterPreference[];
  }>(fetch("/api/admin/agent-evolution/preferences/system", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preference_ids: preferenceIds })
  }));
}

export function removeAdminSystemWriterPreferences(preferenceIds: number[]) {
  return parseJson<{
    removed_system_preference_ids: number[];
    affected_user_count: number;
    preferences: AdminWriterPreference[];
  }>(fetch("/api/admin/agent-evolution/preferences/system", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preference_ids: preferenceIds })
  }));
}

export function getAdminAgentEvolutionRun(runId: number) {
  return parseJson<{ run: AdminAgentEvolutionRun }>(fetch(`/api/admin/agent-evolution/runs/${runId}`));
}

export function createAdminAgentEvolutionRun() {
  return parseJson<{ run: AdminAgentEvolutionRun }>(fetch("/api/admin/agent-evolution/runs", { method: "POST" }));
}

export function retryAdminAgentEvolutionRun(runId: number) {
  return parseJson<{ run: AdminAgentEvolutionRun }>(fetch(`/api/admin/agent-evolution/runs/${runId}/retry`, { method: "POST" }));
}

export function startAdminAgentEvolutionDebug(runId: number) {
  return parseJson<{ debug: AgentDebugSession }>(fetch(`/api/admin/agent-evolution/runs/${runId}/debug`, { method: "POST" }));
}

export function dismissAdminAgentEvolutionRun(runId: number) {
  return parseJson<{ run: AdminAgentEvolutionRun }>(fetch(`/api/admin/agent-evolution/runs/${runId}/dismiss`, { method: "POST" }));
}

export function executeAdminAgentEvolutionRun(runId: number, requirements: string) {
  return parseJson<{ run: AdminAgentEvolutionRun }>(fetch(`/api/admin/agent-evolution/runs/${runId}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requirements })
  }));
}

export function getAdminScriptSyncConfig() {
  return parseJson<ScriptSyncConfig>(fetch("/api/admin/script-sync/config"));
}

export function testAdminScriptSyncTarget(url: string) {
  return parseJson<ScriptSyncTargetTest>(fetch("/api/admin/script-sync/config/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  }));
}

export function startAdminScriptSyncAuthorization() {
  return parseJson<{ authorization_url: string }>(fetch("/api/admin/script-sync/config/authorization", { method: "POST" }));
}

export function completeAdminScriptSyncAuthorization() {
  return parseJson<{ authorized: boolean }>(fetch("/api/admin/script-sync/config/authorization/complete", { method: "POST" }));
}

export function saveAdminScriptSyncConfig(payload: {
  url: string;
  mappings: Array<{ source_key: string; target_field_id: string | null; auto_create: boolean }>;
}) {
  return parseJson<ScriptSyncConfig>(fetch("/api/admin/script-sync/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export function getAdminScriptSyncScripts(filters: {
  query?: string;
  scenario?: "rewrite" | "novel" | "replicate";
  operator?: string;
  statuses?: ScriptSyncStatus[];
}) {
  return parseJson<ScriptSyncScriptsPayload>(fetch(`/api/admin/script-sync/scripts${queryString({
    query: filters.query,
    scenario: filters.scenario,
    operator: filters.operator,
    sync_status: filters.statuses?.join(",")
  })}`));
}

export function getActiveAdminScriptSyncJobs() {
  return parseJson<{ jobs: ScriptSyncJob[] }>(fetch("/api/admin/script-sync/jobs/active"));
}

export function enqueueAdminScriptSyncJobs(projectIds: number[]) {
  return parseJson<{
    jobs: ScriptSyncJob[];
    queued_project_ids: number[];
    already_active_project_ids: number[];
  }>(fetch("/api/admin/script-sync/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_ids: projectIds })
  }));
}

export function ignoreAdminScriptSync(projectId: number) {
  return parseJson<{ sync: { project_id: number; status: "ignored" } }>(
    fetch(`/api/admin/script-sync/scripts/${projectId}/ignore`, { method: "POST" })
  );
}

export function getAdminScriptLibrary(filters: {
  query?: string;
  status?: ScriptLibraryStatus;
  tags?: Partial<Record<ScriptLibraryTagKind, string>>;
  page?: number;
}) {
  return parseJson<ScriptLibraryPayload>(fetch(`/api/admin/script-library/scripts${queryString({
    query: filters.query,
    script_status: filters.status,
    theme: filters.tags?.theme,
    setting: filters.tags?.setting,
    background: filters.tags?.background,
    audience: filters.tags?.audience,
    page: filters.page
  })}`));
}

export function getAdminScriptLibraryScript(scriptId: number) {
  return parseJson<{ script: ScriptLibraryScript }>(fetch(`/api/admin/script-library/scripts/${scriptId}`));
}

export function uploadAdminScripts(files: File[]) {
  const body = new FormData();
  files.forEach((file) => body.append("files", file));
  return parseJson<{ scripts: ScriptLibraryScript[]; job_ids: number[]; rejected: Array<{ filename: string; message: string }> }>(fetch("/api/admin/script-library/scripts", {
    method: "POST",
    body
  }));
}

export function updateAdminScriptLibraryScript(
  scriptId: number,
  payload: { title?: string; tags?: Record<ScriptLibraryTagKind, string[]> }
) {
  return parseJson<{ script: ScriptLibraryScript }>(fetch(`/api/admin/script-library/scripts/${scriptId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export function deleteAdminScriptLibraryScript(scriptId: number) {
  return parseJson<{ ok: boolean }>(fetch(`/api/admin/script-library/scripts/${scriptId}`, { method: "DELETE" }));
}

export function retryAdminScriptDistillation(scriptId: number) {
  return parseJson<{ script: ScriptLibraryScript; job_id: number }>(fetch(`/api/admin/script-library/scripts/${scriptId}/retry`, { method: "POST" }));
}

export function getAdminScriptSource(scriptId: number, query?: string) {
  return parseJson<{ chunks: ScriptSourceChunk[] }>(fetch(`/api/admin/script-library/scripts/${scriptId}/source${queryString({ query })}`));
}

export function getAdminScriptFormulas(filters: {
  formulaType?: string;
  cardKind?: "formula" | "principle";
  stage?: string;
  status?: "candidate" | "active";
  query?: string;
  tags?: Partial<Record<ScriptLibraryTagKind, string>>;
  page?: number;
}) {
  return parseJson<ScriptFormulaPayload>(fetch(`/api/admin/script-library/formulas${queryString({
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
  })}`));
}

export function deleteAdminScriptFormula(formulaId: string) {
  return parseJson<{ ok: boolean }>(fetch(`/api/admin/script-library/formulas/${encodeURIComponent(formulaId)}`, { method: "DELETE" }));
}
