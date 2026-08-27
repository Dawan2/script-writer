export type User = {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "user";
  permissions: string[];
};

export type CreditPrice = {
  stage: string;
  label: string;
  credits: number;
};

export type CreditPlan = {
  code: "free" | "basic" | "advanced";
  label: string;
  allowance: number;
  cadence: "once" | "daily";
  max_concurrent_jobs: number;
  allowance_label: string;
  description: string;
};

export type CreditConcurrency = {
  limit: number;
  active: number;
  available: number;
  reached: boolean;
  message: string | null;
};

export type CreditPlanGrant = {
  grant_key: string;
  granted: boolean;
  granted_credits: number;
  granted_at: string | null;
  can_grant: boolean;
};

export type CreditPlanTerm = {
  status: "unlimited" | "active" | "expired";
  starts_at: string | null;
  expires_at: string | null;
  expires_on: string | null;
  days_remaining: number | null;
  total_days: number | null;
};

export type CreditBalanceBreakdown = {
  experience: number;
  supplemental: number;
  plan: number;
};

export type CreditTransaction = {
  id: number;
  user_id: number;
  display_name?: string | null;
  username?: string | null;
  project_id: number | null;
  project_name: string | null;
  job_id: number | null;
  stage: string | null;
  kind: string;
  delta: number;
  balance_after: number;
  note: string;
  job_credit_status: "reserved" | "settled" | "released" | null;
  created_at: string;
};

export type CreditSummary = {
  managed: boolean;
  balance: number | null;
  balances: CreditBalanceBreakdown | null;
  plan: CreditPlan;
  concurrency: CreditConcurrency;
  plan_term: CreditPlanTerm;
  plan_grant: CreditPlanGrant | null;
  prices: CreditPrice[];
  transactions: CreditTransaction[];
};

export type CreditQuote = {
  credits: number;
  stages: CreditPrice[];
  managed: boolean;
  balance: number | null;
  affordable: boolean;
  concurrency: CreditConcurrency;
};

export type Project = {
  id: number;
  name: string;
  owner_user_id: number;
  access_level?: "owner" | "view" | "edit" | null;
  creator_name?: string | null;
  workspace_dir: string;
  target_region?: string;
  requires_translation?: boolean;
  task_type: "rewrite" | "novel" | "replicate" | "review" | "translate" | "humanize";
  current_stage: string;
  current_stage_name: string;
  status: "active" | "completed";
  completed_at?: string | null;
  completed_by?: number | null;
  pinned: boolean;
  claude_session_id: string;
  has_running_agent: boolean;
  is_batch_task?: boolean;
  created_at: string;
  updated_at: string;
  last_modified_by?: string | null;
};

export type ProjectMember = {
  id: number;
  username: string;
  display_name: string;
  access_level: "owner" | "view" | "edit";
  is_owner: boolean;
};

export type ProjectMembersPayload = {
  members: ProjectMember[];
};

export type BatchTaskStage = {
  key: string;
  name: string;
  file_name: string;
};

export type BatchTaskScenario = {
  key: string;
  name: string;
  stages: BatchTaskStage[];
};

export type BatchTaskStatus = "queued" | "running" | "paused" | "succeeded" | "failed";

export type BatchTask = {
  id: number;
  batch_id: number;
  batch_name: string;
  creator_name: string;
  project_id: number | null;
  project_name: string;
  project_deleted: boolean;
  scenario: Pick<BatchTaskScenario, "key" | "name">;
  phase: {
    key: string | null;
    name: string;
    file_name: string | null;
  };
  pause_at: {
    key: string | null;
    name: string;
    file_name: string | null;
  };
  status: BatchTaskStatus;
  result: string;
  duration_seconds: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
  retry_count: number;
  max_retries: number;
  run_count: number;
  last_error: string | null;
};

export type BatchTasksPayload = {
  tasks: BatchTask[];
  scenarios: BatchTaskScenario[];
  max_parallel: number;
};

export type TrashedProject = {
  id: number;
  name: string;
  target_region?: string;
  task_type: "rewrite" | "novel" | "replicate" | "review" | "translate" | "humanize";
  deleted_at: string;
  purge_at: string;
  days_remaining: number;
};

export type TrashedProjectPage = {
  projects: TrashedProject[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
};

export type TargetRegion = {
  key: string;
  target_language: string;
  target_market: string;
  requires_translation: boolean;
};

export type ScriptTagTaxonomy = {
  theme: string[];
  setting: string[];
  background: string[];
  audience: string[];
};

export type DistributionBrief = {
  status: "complete" | "provisional";
  target_countries: string[];
  target_locale: string;
  episode_duration?: string;
  target_episode_count?: number | null;
  maturity_target?: string;
  theme?: string[];
  setting?: string[];
  background?: string[];
  audience?: string[];
  market_deliverables: Array<{
    market: string;
    locale: string | null;
    delivery_mode: string;
    status: "resolved" | "locale_required";
    locale_source: string;
  }>;
  locale_contract_status: "region_default" | "single_locale" | "multi_locale" | "locale_required";
  requires_separate_language_versions: boolean;
  missing_fields: string[];
  assumptions_require_approval: boolean;
  inferred_fields?: string[];
  assumption_notes?: Array<{
    field: string;
    basis: string;
  }>;
};

export type DistributionBriefInput = Pick<DistributionBrief,
  | "episode_duration"
  | "target_episode_count"
  | "maturity_target"
  | "theme"
  | "setting"
  | "background"
  | "audience"
>;

export type DistributionBriefSnapshot = {
  brief: DistributionBrief;
  content_hash: string;
  target_region?: string;
  extra_requirements: string;
  changed?: boolean;
  invalidated_stages?: string[];
  memory_revision?: number;
  source?: {
    display_name: string;
  } | null;
};

export type ProjectInitialization = {
  project_name: string;
  task_type: "rewrite" | "novel" | "replicate" | "review" | "translate" | "humanize";
  target_region: string;
  target_country: string;
  target_locale: string;
  extra_requirements: string;
  source: {
    display_name: string;
    file_type: string;
    sha256: string;
  };
  brief: DistributionBrief;
  config_hash: string;
};

export type ProjectReinitializeInput = {
  project_name: string;
  target_region: string;
  extra_requirements?: string;
  episode_duration?: string;
  target_episode_count?: number;
  maturity_target?: string;
  theme?: string[];
  setting?: string[];
  background?: string[];
  audience?: string[];
  expected_hash: string;
};

export type ReviewDecision = {
  outcome: "passed" | "revision_requested";
  verdict?: string | null;
  revision_stage?: string | null;
  reason?: string | null;
};

export type StageFile = {
  index: number;
  stage: string;
  name: string;
  file_name: string;
  status: string;
  current: boolean;
  exists: boolean;
  clickable: boolean;
  merged_into_full_script: boolean;
  updated_at?: string;
  quality_passed?: boolean | null;
  quality_warnings?: string[];
  review_decision?: ReviewDecision | null;
  next_action?: string | null;
  document_sync_pending?: boolean;
};

export type AgentDocumentExcerpt = {
  id: number;
  stage: string;
  document_name: string;
  file_path: string;
  content: string;
};

export type ReviewGrade =
  | "D" | "D+"
  | "C" | "C+"
  | "B" | "B+"
  | "A" | "A+"
  | "S" | "S+"
  | "SS";

export type ReviewDimension = {
  key:
    | "market_fit"
    | "story_engine"
    | "character_drive"
    | "retention_pacing"
    | "dialogue_production"
    | "overseas_readiness";
  name: string;
  grade: ReviewGrade | null;
  one_line_comment: string;
};

export type ReviewScorecard = {
  basic_info: {
    script_name: string;
    target_region: string;
    target_language: string;
    genre_tags: string[];
  };
  verdict: {
    code: "pass" | "revise" | "reject_or_reselect" | "supplement_materials";
    label: "通过" | "返修" | "淘汰/重选" | "返修：补材料";
    summary: string;
    primary_issue_levels: string[];
    next_action: string;
    human_review_required: boolean;
    legal_review_required: boolean;
  };
  overall: {
    grade: ReviewGrade | null;
  };
  dimensions: ReviewDimension[];
  p0_issue_count: number;
  critical_risks: Array<{
    severity: "critical" | "high";
    summary: string;
    action: string;
    requires_human_review: boolean;
  }>;
};

export type WorldView = {
  "世界观描述": string;
  "关键概念映射": Array<{
    "原剧本概念": string;
    "映射后概念": string;
  }>;
};

export type NovelAnalysis = {
  "基础信息": {
    "小说名称": string;
    "小说梗概": string;
    "题材": string[];
    "基调": string;
  };
  "核心卖点": string;
  "故事主线": string;
  "世界观": string;
  "关键人物": Array<{
    "人物名称": string;
    "人物画像": string;
  }>;
  "剧情单元": Array<{
    "单元ID": string;
    "单元名称": string;
    "单元梗概": string;
    "主线推进": string;
    "关键人物": Array<{
      "人物名称": string;
      "单元作用与变化": string;
    }>;
    "关键信息": string[];
    "高光时刻": Array<{
      "名称": string;
      "原文索引": string;
    }>;
    "改编建议": "保留" | "删除" | "合并";
    "合并目标单元ID": string;
    "已确认合并": boolean;
    "建议原因": string;
  }>;
};

export type NovelAnalysisSection = "basic" | "characters" | "units";

export type CharacterRelationshipGraph = {
  protagonist: string;
  characters: Array<{
    name: string;
    role_identity: string;
    faction: string;
    is_protagonist: boolean;
  }>;
  relationships: Array<{
    source: string;
    target: string;
    label: string;
  }>;
};

export type StageDocument = {
  stage: string;
  name: string;
  file_name: string;
  content: string;
  content_hash?: string;
  world_view?: WorldView;
  novel_analysis?: NovelAnalysis;
  relationship_graph?: CharacterRelationshipGraph | null;
  review_scorecard?: ReviewScorecard | null;
  outline_title?: {
    title: string;
    english_title: string;
    confirmed: boolean;
  };
  memory?: {
    status: string;
    revision?: number;
    sync_reason?: string;
    impact?: Record<string, unknown>;
  };
};

export type DocumentCommentAuthor = {
  id: number;
  display_name: string;
};

export type DocumentCommentAnchor = {
  start: number;
  end: number;
  text: string;
  prefix: string;
  suffix: string;
  preview_start: number | null;
  preview_end: number | null;
};

export type DocumentCommentMessage = {
  id: number;
  content: string;
  is_root: boolean;
  author: DocumentCommentAuthor;
  created_at: string;
};

export type DocumentCommentThread = {
  id: number;
  stage: string;
  anchor: DocumentCommentAnchor;
  created_by: DocumentCommentAuthor;
  created_at: string;
  updated_at: string;
  messages: DocumentCommentMessage[];
};

export type DocumentCommentLayout = {
  anchorTops: Record<number, number>;
  contentHeight: number;
  pendingAnchorTop?: number;
  scrollTop: number;
  viewportTop: number;
};

export type DocumentCommentCreateInput = {
  anchor_start: number;
  anchor_end: number;
  anchor_text: string;
  anchor_prefix: string;
  anchor_suffix: string;
  preview_start?: number | null;
  preview_end?: number | null;
  content: string;
};

export type FileVersionSummary = {
  id: number;
  version_number: number;
  operation: "initial" | "manual_save" | "agent_edit" | "agent_generation" | "regenerate" | "restore" | "unknown";
  editor_name: string;
  created_at: string;
  change_summary: string;
  is_current: boolean;
  can_restore: boolean;
};

export type FileVersionHistory = {
  stage: string;
  name: string;
  current_content_hash: string;
  versions: FileVersionSummary[];
};

export type FileVersion = Omit<FileVersionSummary, "version_number"> & {
  stage: string;
  name: string;
  file_name: string;
  content: string;
};

export type ProjectMemoryStatus = {
  initialized: boolean;
  fresh: boolean;
  revision?: number;
  generated_at?: string;
  stale_files: string[];
  missing_files: string[];
  new_files: string[];
};

export type AgentStageChoice =
  | "next"
  | "all"
  | "chat_edit"
  | "novel_analysis"
  | "world_view"
  | "outline_rewrite"
  | "character_rewrite"
  | "trial_generate"
  | "full_generate"
  | "dialogue_translate"
  | "foreign_review"
  | "humanizer_zh";

export type AgentJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type AgentJob = {
  id: number;
  project_id: number;
  user_id: number;
  stage: AgentStageChoice;
  target_stage?: string;
  prompt?: string;
  status: AgentJobStatus;
  claude_session_id: string;
  logical_thread_id?: string;
  dry_run: boolean;
  regenerate_current_file?: boolean;
  reference_current_file?: boolean | null;
  optimization_scope?: "review_p0" | null;
  started_at?: string;
  finished_at?: string;
  error_message?: string;
  error_code?: string;
  error_category?: string;
  error_retryable?: boolean;
  raw_log_path?: string;
  raw_log_bytes?: number;
  created_at: string;
  updated_at: string;
};

export type Notification = {
  id: number;
  project_id: number | null;
  job_id: number | null;
  preference_summary_job_id?: number | null;
  system_notification_id?: number | null;
  kind: "agent_completed" | "preference_summary_completed" | "system";
  title: string;
  message: string;
  target_stage?: string | null;
  target_path?: string | null;
  read_at?: string | null;
  created_at: string;
};

export type NotificationsPayload = {
  notifications: Notification[];
  has_unread: boolean;
  unread_count: number;
  unread_system_notifications: Notification[];
};

export type AgentMessage = {
  id: number;
  job_id?: number;
  stage: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type AgentHistory = {
  logical_thread_id: string;
  messages: AgentMessage[];
  jobs: AgentJob[];
};

export type AgentEvent = {
  id: number;
  job_id: number;
  seq: number;
  event_type: string;
  message: string;
  raw_json?: string;
  created_at: string;
};

export type AgentDebugSession = {
  job_id: number;
  process_key: string;
  status: "starting" | "running" | "stopped" | "error";
  url: string;
  port: number;
  project_path: string;
  session_id: string;
  selected_log_id: string;
  reused: boolean;
};

export type WriterPreferenceScopeKey =
  | "global"
  | "novel_analysis"
  | "world_view"
  | "outline_rewrite"
  | "character_rewrite"
  | "trial_generate"
  | "full_generate"
  | "dialogue_translate"
  | "foreign_review"
  | "humanizer_zh";

export type WriterPreferenceScope = {
  key: WriterPreferenceScopeKey;
  name: string;
  description: string;
};

export type WriterPreference = {
  id: number;
  content: string;
  scopes: WriterPreferenceScopeKey[];
  source: "manual" | "ai";
  enabled: boolean;
  position: number;
  version: number;
  evidence?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  is_system_preference: boolean;
  system_preference_id?: number | null;
  can_edit_system_preference?: boolean;
};

export type WriterPreferencesPayload = {
  profile_revision: number;
  scopes: WriterPreferenceScope[];
  preferences: WriterPreference[];
  limits: {
    max_items: number;
    max_content_chars: number;
    max_context_chars: number;
  };
};

export type WriterPreferenceBackupItem = {
  content: string;
  scopes: WriterPreferenceScopeKey[];
  enabled: boolean;
};

export type WriterPreferencesBackup = {
  schema_version: string;
  exported_at: string;
  preferences: WriterPreferenceBackupItem[];
};

export type WriterPreferenceImportMode = "append" | "replace";

export type WriterPreferenceImportResult = {
  profile_revision: number;
  imported_count: number;
  skipped_duplicate_count: number;
  removed_count: number;
};
