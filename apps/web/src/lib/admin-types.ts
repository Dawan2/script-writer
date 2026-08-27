import type { AgentJob, CreditBalanceBreakdown, CreditConcurrency, CreditPlan, CreditPlanGrant, CreditPlanTerm, CreditPrice, CreditTransaction, Project, User, WriterPreference } from "@/lib/types";

export type DashboardPeriod = "today" | "yesterday" | "7d" | "30d" | "custom";
export type DashboardTaskType = "rewrite" | "novel" | "replicate" | "review" | "translate" | "humanize";
export type DashboardMetricKey = "scripts" | "writers" | "preferences" | "script_duration_p95_seconds" | "tokens" | "cost_usd";
export type DashboardOperationKind = "automatic" | "manual_edit" | "conversation" | "regenerate";
export type ProjectLifecycle = "active" | "completed" | "trash";

export type AdminDashboard = {
  generated_at: string;
  filters: {
    period: DashboardPeriod;
    timezone: string;
    operator_user_id: number | null;
    task_type: DashboardTaskType | null;
    start_date: string;
    end_date: string;
    trend_start_date: string;
    trend_end_date: string;
  };
  summary: {
    scripts_total: number;
    writers_total: number;
    preferences_total: number;
    script_duration_p95_seconds: number;
    completed_pipeline_count: number;
    tokens_total: number;
    cost_usd_total: number;
    metered_job_count: number;
    costed_job_count: number;
  };
  trend: Array<{
    date: string;
    label: string;
    scripts: number;
    writers: number;
    preferences: number;
    script_duration_p95_seconds: number;
    tokens: number;
    cost_usd: number;
  }>;
  execution: {
    aggregate: {
      total_tokens: number;
      p95_tokens: number;
      total_cost_usd: number;
      p95_cost_usd: number;
      total_duration_seconds: number;
      p95_duration_seconds: number;
    };
    stage_metrics: Array<{
      key: string;
      job_count: number;
      metered_job_count: number;
      costed_job_count: number;
      total_tokens: number;
      p95_tokens: number;
      total_cost_usd: number;
      p95_cost_usd: number;
      total_duration_seconds: number;
      p95_duration_seconds: number;
    }>;
    funnel: Array<{ key: string; value: number }>;
    operations: {
      total: number;
      by_stage: Array<{ key: string; value: number }>;
      by_stage_kind: Array<{ stage: string; key: DashboardOperationKind; value: number }>;
    };
  };
  people: Array<{
    id: number;
    name: string;
    username: string;
    task_count: number;
    operation_count: number;
    tokens: number;
    cost_usd: number;
  }>;
};

export type AdminRoleAssignment = {
  id: number;
  name: string;
  is_system: boolean;
  code: string;
};

export type AdminRole = {
  id: number;
  code: string;
  name: string;
  description: string;
  is_system: boolean;
  permission_keys: string[];
  assigned_user_count: number;
  created_at: string;
  updated_at: string;
};

export type RolePermissionItem = {
  key: string;
  label: string;
  permission_key: string;
};

export type RolePermissionCatalog = {
  scenarios: RolePermissionItem[];
  batch_task: { label: string; permission_key: string };
  admin: RolePermissionItem[];
};

export type RoleManagementPayload = {
  catalog: RolePermissionCatalog;
  roles: AdminRole[];
};

export type AdminUser = Omit<User, "permissions"> & {
  roles: AdminRoleAssignment[];
  role_ids: number[];
  is_active: boolean;
  project_count: number;
  completed_project_count: number;
  job_count: number;
  created_at: string;
  updated_at: string;
};

export type AdminUsersPayload = {
  users: AdminUser[];
  assignable_roles: AdminRole[];
};

export type AdminCreditAccount = {
  user_id: number;
  username: string;
  display_name: string;
  role: "admin" | "user";
  managed: boolean;
  balance: number | null;
  balances: CreditBalanceBreakdown | null;
  plan: CreditPlan;
  concurrency: CreditConcurrency;
  plan_term: CreditPlanTerm;
  plan_grant: CreditPlanGrant;
  plan_assigned_at: string | null;
  updated_at: string | null;
};

export type AdminCreditTransaction = CreditTransaction & { display_name: string; username: string };

export type AdminCreditsPayload = {
  plans: CreditPlan[];
  prices: CreditPrice[];
  accounts: AdminCreditAccount[];
  transactions: AdminCreditTransaction[];
};

export type AdminProject = Project & {
  owner_username: string;
  owner_display_name: string;
  job_count: number;
  failed_job_count: number;
  deleted_at?: string | null;
  lifecycle_status: ProjectLifecycle;
};

export type AdminJob = AgentJob & {
  project_name: string;
  project_status: "active" | "completed";
  project_deleted_at?: string | null;
  requested_by_username: string;
  duration_seconds?: number | null;
};

export type Pagination = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type RegionRule = {
  aliases: string[];
  default_market: string;
  default_locale: string;
  rules: string[];
  stage_overrides: Record<string, { rules: string[] }>;
  translation_context: string[];
  requires_translation: boolean;
};

export type RegionRulesConfig = {
  schema_version: string;
  regions: Record<string, RegionRule>;
};

export type RegionRulesPayload = {
  config: RegionRulesConfig;
  content_hash: string;
  usage: Record<string, number>;
};

export type ModelConfigType = "claude_code" | "image";
export type ModelThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelApiProtocol = "anthropic" | "openai";

export type ModelConfig = {
  id: number;
  name: string;
  model_type: ModelConfigType;
  request_url: string;
  model_name: string;
  api_protocol: ModelApiProtocol;
  thinking_level: ModelThinkingLevel;
  image_size: string;
  image_output_format: "png" | "jpeg" | "webp";
  image_watermark: boolean;
  fallback_model_id: number | null;
  fallback_model_name: string | null;
  api_key_configured: boolean;
  is_enabled: boolean;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
};

export type FunctionModelRoute = {
  scenario_key: string;
  scenario_label: string;
  action_key: string;
  action_label: string;
  model_type: ModelConfigType;
  model_config_id: number | null;
  model_config_name: string;
  configured_model_name: string;
  updated_at: string | null;
};

export type ModelManagementPayload = {
  models: ModelConfig[];
  routes: FunctionModelRoute[];
};

export type ModelConfigTestResult = {
  model_id: number;
  model_type: ModelConfigType;
  message: string;
  image_url: string | null;
  last_tested_at: string;
};

export type AuditLog = {
  id: number;
  actor_user_id?: number | null;
  actor_username: string;
  action: string;
  target_type: string;
  target_id?: string | null;
  target_label?: string | null;
  project_id?: number | null;
  outcome: "success" | "failure" | "denied";
  source: "web" | "api" | "system";
  severity: "info" | "warning" | "error";
  request_id?: string | null;
  parent_event_id?: number | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type AgentEvolutionStatus =
  | "queued"
  | "analyzing"
  | "awaiting_review"
  | "applying"
  | "completed"
  | "dismissed"
  | "failed"
  | "execution_failed";

export type AgentEvolutionEvidenceSummary = {
  job_count: number;
  failed_job_count: number;
  retry_job_count: number;
  error_signature_count: number;
  warning_event_count: number;
  repeated_operation_count?: number;
  repeated_tool_chain_count?: number;
  manual_change_count: number;
  manual_feedback_count: number;
  user_preference_count: number;
};

export type AdminAgentEvolutionRun = {
  id: number;
  status: AgentEvolutionStatus;
  triggered_by: number;
  range_start?: string | null;
  range_end: string;
  report_sha256?: string | null;
  execution_requirements?: string | null;
  error_message?: string | null;
  analysis_started_at?: string | null;
  analysis_completed_at?: string | null;
  execution_started_at?: string | null;
  execution_completed_at?: string | null;
  reviewed_by?: number | null;
  created_at: string;
  updated_at: string;
  evidence_summary?: AgentEvolutionEvidenceSummary | null;
  report_markdown?: string | null;
  execution_log?: string | null;
  evidence?: Record<string, unknown> | null;
};

export type AdminWriterPreference = WriterPreference & {
  user: Pick<User, "id" | "username" | "display_name" | "role"> | null;
  profile_revision: number | null;
};

export type AdminAgentEvolutionPayload = {
  runs: AdminAgentEvolutionRun[];
  preferences: AdminWriterPreference[];
};

export type AdminSystemNotification = {
  id: number;
  title: string;
  message: string;
  published_at: string;
  created_at: string;
  created_by: Pick<User, "id" | "display_name" | "username"> | null;
  recipient_count: number;
};

export type ScriptSyncStatus = "pending" | "synced" | "needs_update" | "failed" | "ignored";

export type ScriptSyncField = {
  id: string;
  name: string;
  type: string;
  multiple: boolean;
  writable: boolean;
};

export type ScriptSyncMapping = {
  source_key: string;
  source_label: string;
  kind: "text" | "number" | "datetime" | "select" | "attachment";
  target_field_id: string | null;
  target_field_name: string | null;
  target_field_type: string | null;
  auto_create: boolean;
};

export type ScriptSyncConfig = {
  url: string;
  table: { id: string; name: string } | null;
  verified_at: string | null;
  is_ready: boolean;
  fields: ScriptSyncField[];
  mappings: ScriptSyncMapping[];
  system_fields: Array<{ key: string; label: string; kind: ScriptSyncMapping["kind"] }>;
};

export type ScriptSyncTargetTest = {
  reachable: boolean;
  authorized: boolean;
  message: string;
  authorization_url: string | null;
  table: { id: string; name: string } | null;
  fields: ScriptSyncField[];
  mappings: Array<Pick<ScriptSyncMapping, "source_key" | "target_field_id" | "target_field_name" | "target_field_type" | "auto_create">>;
};

export type ScriptSyncScript = {
  project_id: number;
  script_name: string;
  scenario: "rewrite" | "novel" | "replicate";
  creator: string;
  last_modifier: string;
  last_modified_at: string;
  sync_status: ScriptSyncStatus;
  sync_time: string | null;
  sync_error: string | null;
};

export type ScriptSyncJob = {
  id: number;
  project_id: number;
  project_name: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type ScriptSyncScriptsPayload = {
  scripts: ScriptSyncScript[];
  filters: {
    scenarios: Array<"rewrite" | "novel" | "replicate">;
    operators: string[];
    statuses: Record<ScriptSyncStatus, string>;
  };
  configured: boolean;
};

export type ScriptLibraryTagKind = "theme" | "setting" | "background" | "audience";
export type ScriptLibraryStatus = "queued" | "processing" | "ready" | "failed";

export type ScriptLibraryScript = {
  id: number;
  title: string;
  source_type: "manual" | "project_archive" | "short-writing-skill";
  source_label: string;
  source_project_id: number | null;
  original_filename: string;
  chars: number;
  episode_count: number | null;
  status: ScriptLibraryStatus;
  summary: string;
  tags: Record<ScriptLibraryTagKind, string[]>;
  distillation_version: string;
  error_message: string | null;
  retryable: boolean;
  distillation_progress?: {
    stage: string;
    label: string;
    current: number;
    total: number;
    percent: number;
    message: string;
  };
  created_at: string;
  updated_at: string;
  case_card?: Record<string, unknown>;
  formulas?: Array<Record<string, unknown>>;
  distillation_result?: Record<string, unknown>;
  formula_cards?: ScriptFormulaCard[];
  principle_cards?: ScriptFormulaCard[];
  source_index?: ScriptSourceChunkIndex[];
};

export type ScriptSourceChunkIndex = {
  id: string;
  locator: string;
  start_char: number;
  end_char: number;
  preview: string;
};

export type ScriptSourceChunk = Omit<ScriptSourceChunkIndex, "preview"> & { content: string };

export type ScriptLibraryPayload = {
  scripts: ScriptLibraryScript[];
  pagination: Pagination;
  facets: Record<ScriptLibraryTagKind, string[]>;
  taxonomy: Record<ScriptLibraryTagKind, string[]>;
  stats: {
    total: number;
    ready: number;
    processing: number;
    failed: number;
    status_counts: Record<ScriptLibraryStatus | "all", number>;
    formula_cards: number;
    principle_cards: number;
    formula_counts: Record<string, number>;
  };
};

export type ScriptFormulaCard = {
  id: string;
  card_kind: "formula" | "principle";
  category: "story_engine" | "world_rule" | "character_relationship" | "long_arc" | "episode_structure" | "hook_information" | "audience_payoff" | "emotional_progression" | "scene_conflict" | "dialogue_action" | "principle";
  /** @deprecated kept for old cached responses; new API uses category/card_kind. */
  formula_type?: string;
  title: string;
  description: string;
  usage_scenario: string;
  not_applicable: string[];
  core_formula: string;
  usage_guidance: string[];
  completion_criteria: string[];
  applicable_tags: string[];
  source_script_ids: number[];
  source_count: number;
  source_script_titles: string[];
  source_scripts?: Array<{ id: number; title: string }>;
  status: "candidate" | "active" | "retired";
  origin: string;
  content: Record<string, unknown>;
  stages: string[];
  creative_decision: string;
  revision: number;
};

export type ScriptFormulaPayload = {
  formulas: ScriptFormulaCard[];
  pagination: Pagination;
  facets: Record<ScriptLibraryTagKind, string[]>;
  filter_counts: {
    stage: Record<string, number>;
    status: Record<string, number>;
  };
  taxonomy: Record<ScriptLibraryTagKind, string[]>;
};
