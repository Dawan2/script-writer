"use client";

import Link from "next/link";
import { Archive, Bot, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleHelp, Coins, FileText, GripVertical, Home, KeyRound, ListFilter, LogOut, MoreVertical, Pencil, Pin, Plus, Search, Trash2, UserRound, UsersRound } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AppNav } from "@/components/navigation/app-nav";
import appNavStyles from "@/components/navigation/app-nav.module.css";
import { ChangePasswordDialog } from "@/components/workspace/change-password-dialog";
import { NotificationCenter } from "@/components/workspace/notification-center";
import { ProjectPermissionsDialog } from "@/components/workspace/project-permissions-dialog";
import { ScenarioSelect, type ScenarioSelectOption } from "@/components/workspace/scenario-select";
import { OPERATION_MANUAL_URL } from "@/lib/constants";
import { formatDateTime } from "@/lib/date-time";
import { getProjectScenario, PROJECT_SCENARIOS } from "@/lib/project-scenarios";
import type { CreditSummary, Notification, Project, User } from "@/lib/types";

type ProjectListProps = {
  user?: User | null;
  creditSummary?: CreditSummary | null;
  projects: Project[];
  selectedProjectId?: number;
  query: string;
  collapsed: boolean;
  notifications: Notification[];
  hasUnreadNotifications: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (project: Project) => void;
  onNew: () => void;
  onToggleCollapsed: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onOpenTrash: () => void;
  onOpenCredits: () => void;
  onNotificationSelect: (notification: Notification) => void;
  onLogout: () => void;
  onTogglePin: (project: Project) => void;
  onRename: (project: Project) => void;
  onArchive: (project: Project) => void;
  onDelete: (project: Project) => void;
};

type ProjectTooltip = {
  project: Project;
  left: number;
  side: "left" | "right";
  top: number;
};

type ProjectStageTrackItem = {
  key: string;
  label: string;
};

type ProjectScenarioFilter = "all" | Project["task_type"];

const PROJECT_SCENARIO_FILTER_OPTIONS: readonly ScenarioSelectOption<ProjectScenarioFilter>[] = [
  { key: "all", label: "全部", icon: ListFilter, color: "#1a344a" },
  ...PROJECT_SCENARIOS
];

const PROJECT_TOOLTIP_ID = "project-list-hover-tooltip";
const PROJECT_TOOLTIP_GAP = 10;
const PROJECT_TOOLTIP_GUTTER = 12;
const PROJECT_TOOLTIP_WIDTH = 352;
const PROJECT_TOOLTIP_HALF_HEIGHT = 150;
const PROJECT_STAGE_TRACKS: Record<Project["task_type"], ProjectStageTrackItem[]> = {
  rewrite: [
    { key: "project_init", label: "原始剧本" },
    { key: "world_view", label: "世界观" },
    { key: "outline_rewrite", label: "故事梗概" },
    { key: "character_rewrite", label: "人物小传" },
    { key: "trial_generate", label: "剧本试稿" },
    { key: "full_generate", label: "完整剧本" },
    { key: "dialogue_translate", label: "台词翻译" },
    { key: "foreign_review", label: "审稿报告" }
  ],
  novel: [
    { key: "novel_analysis", label: "小说解读" },
    { key: "outline_rewrite", label: "故事梗概" },
    { key: "character_rewrite", label: "人物小传" },
    { key: "trial_generate", label: "剧本试稿" },
    { key: "full_generate", label: "完整剧本" },
    { key: "dialogue_translate", label: "台词翻译" },
    { key: "foreign_review", label: "审稿报告" }
  ],
  replicate: [
    { key: "project_init", label: "爆款分析报告" },
    { key: "world_view", label: "世界观" },
    { key: "outline_rewrite", label: "故事梗概" },
    { key: "character_rewrite", label: "人物小传" },
    { key: "trial_generate", label: "剧本试稿" },
    { key: "full_generate", label: "完整剧本" },
    { key: "dialogue_translate", label: "台词翻译" },
    { key: "foreign_review", label: "审稿报告" }
  ],
  review: [
    { key: "full_generate", label: "待审剧本" },
    { key: "foreign_review", label: "审稿报告" }
  ],
  translate: [
    { key: "project_init", label: "原始剧本" },
    { key: "dialogue_translate", label: "台词翻译" }
  ],
  humanize: [
    { key: "project_init", label: "原始剧本" },
    { key: "humanizer_zh", label: "剧本润色" }
  ]
};

function projectProgressFilterOptions(scenarioFilter: ProjectScenarioFilter): ScenarioSelectOption<string>[] {
  const visibleScenarios = scenarioFilter === "all"
    ? PROJECT_SCENARIOS
    : PROJECT_SCENARIOS.filter((scenario) => scenario.key === scenarioFilter);

  return [
    { key: "all", label: "全部" },
    ...visibleScenarios.flatMap((scenario) => PROJECT_STAGE_TRACKS[scenario.key].map((stage) => ({
      key: `${scenario.key}:${stage.key}`,
      label: stage.label,
      group: scenarioFilter === "all" ? scenario.label : undefined
    })))
  ];
}

function scenarioColorStyle(color: string): CSSProperties {
  return { "--scenario-color": color } as CSSProperties;
}

function projectStageTrack(project: Project) {
  const stages = PROJECT_STAGE_TRACKS[project.task_type];
  return project.requires_translation === false && (project.task_type === "rewrite" || project.task_type === "novel" || project.task_type === "replicate")
    ? stages.filter((stage) => stage.key !== "dialogue_translate")
    : stages;
}

function projectProgressFilterValue(project: Pick<Project, "task_type" | "current_stage">) {
  return `${project.task_type}:${project.current_stage}`;
}

function formatProjectDate(timestamp: string) {
  return formatDateTime(timestamp, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
}

export function ProjectList({
  user,
  creditSummary,
  projects,
  selectedProjectId,
  query,
  collapsed,
  notifications,
  hasUnreadNotifications,
  onQueryChange,
  onSelect,
  onNew,
  onToggleCollapsed,
  onResizeStart,
  onOpenTrash,
  onOpenCredits,
  onNotificationSelect,
  onLogout,
  onTogglePin,
  onRename,
  onArchive,
  onDelete
}: ProjectListProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [openMenuProjectId, setOpenMenuProjectId] = useState<number | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [projectView, setProjectView] = useState<"active" | "completed">("active");
  const [scenarioFilter, setScenarioFilter] = useState<ProjectScenarioFilter>("all");
  const [progressFilter, setProgressFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [projectTooltip, setProjectTooltip] = useState<ProjectTooltip | null>(null);
  const [permissionsProject, setPermissionsProject] = useState<Project | null>(null);
  const searchShellRef = useRef<HTMLDivElement>(null);
  const menuShellRef = useRef<HTMLDivElement>(null);
  const userMenuShellRef = useRef<HTMLDivElement>(null);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const firstUserMenuItemRef = useRef<HTMLAnchorElement>(null);
  const changePasswordUserMenuItemRef = useRef<HTMLButtonElement>(null);
  const trashUserMenuItemRef = useRef<HTMLButtonElement>(null);
  const lastUserMenuItemRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchVisible = searchOpen || query.trim().length > 0;
  const filtersActive = scenarioFilter !== "all" || progressFilter !== "all";
  const progressFilterOptions = useMemo(() => projectProgressFilterOptions(scenarioFilter), [scenarioFilter]);
  const filteredProjects = projects.filter((project) => (
    (scenarioFilter === "all" || project.task_type === scenarioFilter)
    && (progressFilter === "all" || projectProgressFilterValue(project) === progressFilter)
  ));
  const activeProjects = filteredProjects.filter((project) => project.status !== "completed");
  const completedProjects = filteredProjects.filter((project) => project.status === "completed");
  const visibleProjects = projectView === "completed" ? completedProjects : activeProjects;

  useEffect(() => {
    if (!searchVisible || query.trim().length > 0) return;

    function handlePointerDown(event: PointerEvent) {
      if (!searchShellRef.current?.contains(event.target as Node)) {
        setSearchOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [query, searchVisible]);

  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    const selectedProject = projects.find((project) => project.id === selectedProjectId);
    if (selectedProject) setProjectView(selectedProject.status === "completed" ? "completed" : "active");
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (openMenuProjectId === null) return;

    function handlePointerDown(event: PointerEvent) {
      if (!menuShellRef.current?.contains(event.target as Node)) {
        setOpenMenuProjectId(null);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [openMenuProjectId]);

  useEffect(() => {
    function hideProjectTooltip() {
      setProjectTooltip(null);
    }

    window.addEventListener("resize", hideProjectTooltip);
    window.addEventListener("scroll", hideProjectTooltip, true);
    return () => {
      window.removeEventListener("resize", hideProjectTooltip);
      window.removeEventListener("scroll", hideProjectTooltip, true);
    };
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return;

    window.requestAnimationFrame(() => firstUserMenuItemRef.current?.focus());

    function handlePointerDown(event: PointerEvent) {
      if (!userMenuShellRef.current?.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        window.requestAnimationFrame(() => userMenuTriggerRef.current?.focus());
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [userMenuOpen]);

  const userLabel = user?.display_name ?? user?.username ?? "用户";
  const userInitial = user?.display_name?.[0] ?? user?.username?.[0] ?? "用";

  function showProjectTooltip(project: Project, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    const maxTooltipWidth = Math.min(PROJECT_TOOLTIP_WIDTH, window.innerWidth - PROJECT_TOOLTIP_GUTTER * 2);
    const side = rect.right + PROJECT_TOOLTIP_GAP + maxTooltipWidth <= window.innerWidth - PROJECT_TOOLTIP_GUTTER
      ? "right"
      : "left";
    const left = side === "right"
      ? Math.min(rect.right + PROJECT_TOOLTIP_GAP, window.innerWidth - maxTooltipWidth - PROJECT_TOOLTIP_GUTTER)
      : Math.max(PROJECT_TOOLTIP_GUTTER, rect.left - PROJECT_TOOLTIP_GAP - maxTooltipWidth);
    const minTop = Math.min(PROJECT_TOOLTIP_GUTTER + PROJECT_TOOLTIP_HALF_HEIGHT, window.innerHeight / 2);
    const maxTop = Math.max(minTop, window.innerHeight - PROJECT_TOOLTIP_GUTTER - PROJECT_TOOLTIP_HALF_HEIGHT);
    const top = Math.min(Math.max(rect.top + rect.height / 2, minTop), maxTop);

    setProjectTooltip({ project, left, side, top });
  }

  function hideProjectTooltip(projectId?: number) {
    setProjectTooltip((current) => !projectId || current?.project.id === projectId ? null : current);
  }

  const tooltipCreatorName = projectTooltip?.project.creator_name
    ?? (projectTooltip?.project.owner_user_id === user?.id ? userLabel : "--");
  const tooltipModifierName = projectTooltip?.project.last_modified_by ?? tooltipCreatorName;
  const tooltipStageTrack = projectTooltip ? projectStageTrack(projectTooltip.project) : [];
  const tooltipScenario = projectTooltip ? getProjectScenario(projectTooltip.project.task_type) : null;
  const TooltipScenarioIcon = tooltipScenario?.icon;
  const tooltipCurrentStageIndex = projectTooltip
    ? tooltipStageTrack.findIndex((stage) => stage.key === projectTooltip.project.current_stage)
    : -1;
  const projectHoverTooltip = projectTooltip && typeof document !== "undefined"
    ? createPortal(
      <div
        id={PROJECT_TOOLTIP_ID}
        className="project-hover-tooltip"
        data-side={projectTooltip.side}
        role="tooltip"
        style={{ left: projectTooltip.left, top: projectTooltip.top }}
      >
        <div className="project-hover-tooltip-header">
          <div className="project-hover-tooltip-title">
            <span className="project-hover-project-mark" aria-hidden="true">
              {projectTooltip.project.is_batch_task ? <Bot size={16} /> : <FileText size={16} />}
            </span>
            <span className="project-hover-title-copy">
              <strong>{projectTooltip.project.name}</strong>
              <span className={`project-hover-tag scenario-${projectTooltip.project.task_type}`}>
                {TooltipScenarioIcon ? <TooltipScenarioIcon size={13} /> : null}
                {tooltipScenario?.label}
              </span>
            </span>
          </div>
        </div>
        <div className="project-hover-tooltip-body">
          <div className="project-hover-stage-route">
            <div className="project-hover-stage-route-heading">
              <span>当前阶段</span>
              <strong>{projectTooltip.project.current_stage_name}</strong>
            </div>
            <ol
              className="project-hover-stage-track"
              aria-label={`当前阶段：${projectTooltip.project.current_stage_name}`}
              style={{ gridTemplateColumns: `repeat(${tooltipStageTrack.length}, minmax(0, 1fr))` }}
            >
              {tooltipStageTrack.map((stage, index) => {
                const state = index === tooltipCurrentStageIndex
                  ? "current"
                  : index < tooltipCurrentStageIndex
                    ? "completed"
                    : "pending";
                return (
                  <li key={stage.key} className={state} aria-label={`${stage.label}，${state === "current" ? "当前阶段" : state === "completed" ? "已完成" : "未开始"}`}>
                    <span className={`project-hover-stage-node${projectTooltip.project.has_running_agent && state === "current" ? " running" : ""}`} aria-hidden="true" />
                    <span>{stage.label}</span>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="project-hover-audit-groups">
            <div className="project-hover-audit-group created">
              <span className="project-hover-audit-heading"><UserRound size={13} />创建</span>
              <strong>{tooltipCreatorName}</strong>
              <time dateTime={projectTooltip.project.created_at}><CalendarDays size={13} />{formatProjectDate(projectTooltip.project.created_at)}</time>
            </div>
            <div className="project-hover-audit-group updated">
              <span className="project-hover-audit-heading"><Pencil size={13} />最后修改</span>
              <strong>{tooltipModifierName}</strong>
              <time dateTime={projectTooltip.project.updated_at}><CalendarDays size={13} />{formatProjectDate(projectTooltip.project.updated_at)}</time>
            </div>
          </div>
        </div>
      </div>,
      document.body
    )
    : null;

  function handleUserMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [
      firstUserMenuItemRef.current,
      changePasswordUserMenuItemRef.current,
      trashUserMenuItemRef.current,
      lastUserMenuItemRef.current
    ].filter(Boolean) as HTMLElement[];
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowDown") items[(currentIndex + 1 + items.length) % items.length]?.focus();
    else items[(currentIndex - 1 + items.length) % items.length]?.focus();
  }

  const userMenu = userMenuOpen ? (
    <div className="project-user-menu" role="menu" aria-label="用户菜单" onKeyDown={handleUserMenuKeyDown}>
      <div className="project-user-summary">
        <div className="project-user-identity">
          <strong>{userLabel}</strong>
          {user?.username ? <small>@{user.username}</small> : null}
        </div>
        {creditSummary?.managed ? (
          <small className="project-user-credit"><Coins size={12} />可用 {creditSummary.balance ?? 0} 创作额度</small>
        ) : null}
        {creditSummary?.plan ? (
          <button
            className="project-user-plan"
            type="button"
            aria-label={`查看${creditSummary.plan.label}的创作额度与明细`}
            title="查看创作额度与明细"
            onClick={() => {
              setUserMenuOpen(false);
              onOpenCredits();
            }}
          >
            <span>{creditSummary.plan.label}</span>
            <small className={creditSummary.plan_term.status}>{creditSummary.plan_term.status === "unlimited"
              ? "额度长期有效"
              : creditSummary.plan_term.status === "expired"
                ? `已于 ${creditSummary.plan_term.expires_on?.replaceAll("-", "/") ?? "--"} 到期`
                : `有效至 ${creditSummary.plan_term.expires_on?.replaceAll("-", "/") ?? "--"} · 剩余 ${creditSummary.plan_term.days_remaining ?? 0} 天`}</small>
          </button>
        ) : null}
      </div>
      <Link ref={firstUserMenuItemRef} href="/" role="menuitem" onClick={() => setUserMenuOpen(false)}>
        <Home size={15} />
        首页
      </Link>
      <button
        ref={changePasswordUserMenuItemRef}
        type="button"
        role="menuitem"
        onClick={() => {
          setUserMenuOpen(false);
          setChangePasswordOpen(true);
        }}
      >
        <KeyRound size={15} />
        修改密码
      </button>
      <button
        ref={trashUserMenuItemRef}
        type="button"
        role="menuitem"
        onClick={() => {
          setUserMenuOpen(false);
          onOpenTrash();
        }}
      >
        <Trash2 size={15} />
        回收站
      </button>
      <button ref={lastUserMenuItemRef} type="button" role="menuitem" onClick={onLogout}>
        <LogOut size={15} />
        退出登录
      </button>
    </div>
  ) : null;

  function closeChangePasswordDialog() {
    setChangePasswordOpen(false);
    window.requestAnimationFrame(() => userMenuTriggerRef.current?.focus());
  }

  const changePasswordDialog = changePasswordOpen ? <ChangePasswordDialog onClose={closeChangePasswordDialog} /> : null;

  if (collapsed) {
    return (
      <aside className="glass-panel project-panel collapsed" aria-label="创作项目栏">
        <button
          className="project-panel-toggle"
          aria-label="展开创作项目"
          title="展开创作项目"
          onClick={onToggleCollapsed}
        >
          <ChevronRight size={14} />
        </button>
        <div className="collapsed-rail">
          <div className="project-collapsed-head">
            <div className="brand-mark rail-brand-mark" aria-hidden="true">
              <img className="brand-logo" src="/logo.png" alt="" />
            </div>
            <AppNav current="workspace" user={user} compact />
            <a
              className="rail-icon-button manual-help-button"
              href={OPERATION_MANUAL_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="打开操作手册"
              title="操作手册"
            >
              <CircleHelp size={16} />
            </a>
            <NotificationCenter
              compact
              notifications={notifications}
              hasUnread={hasUnreadNotifications}
              onSelect={onNotificationSelect}
            />
          </div>
          <div className="project-rail-tools">
            <button className="rail-icon-button rail-primary" aria-label="新建任务" title="新建任务" onClick={onNew}>
              <Plus size={16} />
            </button>
            <button
              className="rail-icon-button"
              aria-label="搜索剧本"
              title="搜索剧本"
              onClick={() => {
                onToggleCollapsed();
                setSearchOpen(true);
              }}
            >
              <Search size={16} />
            </button>
            <span className="rail-separator" />
          </div>
          <div className="project-rail-list">
            {visibleProjects.map((project) => (
              <button
                key={project.id}
                className={[
                  "rail-icon-button",
                  "project-rail-item",
                  project.id === selectedProjectId ? "selected" : "",
                  project.pinned ? "pinned" : ""
                ].filter(Boolean).join(" ")}
                aria-label={`打开 ${project.name}`}
                title={project.name}
                onClick={() => onSelect(project)}
              >
                <FileText size={15} />
                {project.pinned ? <span className="rail-pin-dot" /> : null}
              </button>
            ))}
          </div>
          <div className="project-user-shell collapsed-user-shell" ref={userMenuShellRef}>
            {userMenu}
            <button
              ref={userMenuTriggerRef}
              className="avatar-button rail-avatar-button"
              aria-label="打开用户菜单"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              title="用户菜单"
              onClick={() => setUserMenuOpen((open) => !open)}
            >
              <span className="avatar">{userInitial}</span>
            </button>
          </div>
          {changePasswordDialog}
        </div>
      </aside>
    );
  }

  return (
    <aside className="glass-panel project-panel">
      <button
        className="project-resize-handle"
        type="button"
        aria-label="拖动调整项目栏宽度"
        title="拖动调整项目栏宽度"
        onPointerDown={onResizeStart}
      >
        <GripVertical size={16} />
      </button>
      <button
        className="project-panel-toggle"
        aria-label="收起创作项目"
        title="收起创作项目"
        onClick={onToggleCollapsed}
      >
        <ChevronLeft size={14} />
      </button>
      {/* 项目栏是固定五行的网格，品牌行与导航必须合成同一行，否则列表区会失去弹性高度 */}
      <div className={appNavStyles.panelHeader}>
        <div className="project-brand-row">
          <div className="project-brand-left">
            <div className="brand-mark" aria-hidden="true">
              <img className="brand-logo" src="/logo.png" alt="" />
            </div>
            <div className="brand-copy">
              <strong>出海剧作家</strong>
            </div>
          </div>
          <div className="project-brand-actions">
            <a
              className="icon-button manual-help-button"
              href={OPERATION_MANUAL_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="打开操作手册"
              title="操作手册"
            >
              <CircleHelp size={18} />
            </a>
            <NotificationCenter
              notifications={notifications}
              hasUnread={hasUnreadNotifications}
              onSelect={onNotificationSelect}
            />
          </div>
        </div>
        <AppNav current="workspace" user={user} />
      </div>

      <div ref={searchShellRef}>
        <div className="project-actions">
          <button className="primary-action project-new-task-action" onClick={onNew}>
            <Plus size={18} />
            <span>新任务</span>
          </button>
          <button type="button" className="soft-action" aria-label="搜索剧本" title="搜索剧本" onClick={() => setSearchOpen(true)}>
            <Search size={19} />
          </button>
          <button
            type="button"
            className="soft-action project-filter-toggle"
            aria-label={filtersOpen ? "收起筛选" : "打开筛选"}
            aria-expanded={filtersOpen}
            aria-controls={filtersOpen ? "project-list-filters" : undefined}
            title={filtersOpen ? "收起筛选" : "打开筛选"}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            {filtersOpen ? <ChevronUp size={18} /> : <ListFilter size={17} />}
            {filtersActive && !filtersOpen ? <span className="filter-active-indicator" aria-hidden="true" /> : null}
          </button>
        </div>
        {filtersOpen ? (
          <div className="project-filter-panel" id="project-list-filters">
            <div className="project-filter">
              <span className="project-filter-label">场景</span>
              <ScenarioSelect
                ariaLabel="按场景筛选"
                listId="project-scenario-filter-options"
                options={PROJECT_SCENARIO_FILTER_OPTIONS}
                value={scenarioFilter}
                onChange={(nextValue) => {
                  setScenarioFilter(nextValue);
                  setProgressFilter("all");
                }}
                variant="filter"
              />
            </div>
            <div className="project-filter">
              <span className="project-filter-label">进度</span>
              <ScenarioSelect
                ariaLabel="按进度筛选"
                listId="project-progress-filter-options"
                options={progressFilterOptions}
                value={progressFilter}
                onChange={setProgressFilter}
                showIcons={false}
                variant="filter"
              />
            </div>
          </div>
        ) : null}
        {searchVisible ? (
          <input
            ref={inputRef}
            className="project-search"
            placeholder="搜索项目名称"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        ) : null}
      </div>

      <div className="project-status-tabs" role="tablist" aria-label="项目状态">
        <button role="tab" aria-selected={projectView === "active"} className={projectView === "active" ? "active" : ""} onClick={() => setProjectView("active")}>进行中 <span>{activeProjects.length}</span></button>
        <button role="tab" aria-selected={projectView === "completed"} className={projectView === "completed" ? "active" : ""} onClick={() => setProjectView("completed")}>已归档 <span>{completedProjects.length}</span></button>
      </div>

      <div className="project-list" onScroll={() => hideProjectTooltip()}>
        {visibleProjects.map((project) => {
          const menuOpen = openMenuProjectId === project.id;
          const canEditProject = project.access_level !== "view";
          const canManagePermissions = user?.role === "admin" || project.owner_user_id === user?.id;
          const finalStage = project.task_type === "review"
            ? "foreign_review"
            : project.task_type === "translate"
              ? "dialogue_translate"
              : project.task_type === "humanize"
                ? "humanizer_zh"
                : "foreign_review";
          const canArchiveProject = canEditProject
            && project.status !== "completed"
            && project.current_stage === finalStage
            && !project.has_running_agent;
          const hasProjectMenu = canManagePermissions || (canEditProject && project.status !== "completed");
          const scenario = getProjectScenario(project.task_type);
          const ProjectScenarioIcon = scenario.icon;
          const rowClassName = [
            "project-row",
            project.id === selectedProjectId ? "selected" : "",
            project.pinned ? "pinned" : "",
            project.status === "completed" ? "completed" : "",
            menuOpen ? "menu-open" : ""
          ].filter(Boolean).join(" ");

          return (
            <div
              key={project.id}
              className={rowClassName}
              onPointerEnter={(event) => showProjectTooltip(project, event.currentTarget)}
              onPointerLeave={() => hideProjectTooltip(project.id)}
              onFocusCapture={(event) => showProjectTooltip(project, event.currentTarget)}
              onBlurCapture={(event) => {
                if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) {
                  hideProjectTooltip(project.id);
                }
              }}
            >
              <span className="project-row-scenario-art" aria-hidden="true" style={scenarioColorStyle(scenario.color)}>
                <ProjectScenarioIcon strokeWidth={1.25} />
              </span>
              <button
                className="project-pin-toggle"
                aria-label="固定项目"
                aria-pressed={project.pinned}
                title={project.pinned ? "取消固定" : "固定项目"}
                disabled={project.status === "completed" || !canEditProject}
                onClick={() => onTogglePin(project)}
              >
                <Pin size={10} fill={project.pinned ? "currentColor" : "none"} />
              </button>
              <button
                className="project-row-main"
                aria-describedby={projectTooltip?.project.id === project.id ? PROJECT_TOOLTIP_ID : undefined}
                onClick={() => {
                  hideProjectTooltip(project.id);
                  onSelect(project);
                }}
              >
                <span className="project-row-title">
                  <strong>{project.name}</strong>
                </span>
                <span className="project-row-meta">
                  <span>
                    <i
                      className={
                        project.status === "completed"
                          ? "status-completed"
                          : project.has_running_agent
                          ? "status-loading"
                          : project.current_stage === "project_init"
                            ? "status-ready"
                            : "status-active"
                      }
                    />
                    {project.status === "completed" ? "已归档" : project.current_stage_name}
                  </span>
                  <time>{formatDateTime(project.updated_at, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
                </span>
              </button>

              {hasProjectMenu ? (
                <span className="project-tools" ref={menuOpen ? menuShellRef : undefined}>
                  <button
                    className="project-tool more-tool"
                    aria-label="更多项目操作"
                    onClick={() => setOpenMenuProjectId(menuOpen ? null : project.id)}
                  >
                    <MoreVertical size={15} />
                  </button>
                  {menuOpen ? (
                    <span className="project-menu">
                      {canManagePermissions ? <button
                        onClick={() => {
                          setOpenMenuProjectId(null);
                          hideProjectTooltip(project.id);
                          setPermissionsProject(project);
                        }}
                      >
                        <UsersRound size={14} />
                        权限管理
                      </button> : null}
                      {canEditProject && project.status !== "completed" ? <button
                        onClick={() => {
                          setOpenMenuProjectId(null);
                          onRename(project);
                        }}
                      >
                        <Pencil size={14} />
                        重命名
                      </button> : null}
                      {canArchiveProject ? <button
                        onClick={() => {
                          setOpenMenuProjectId(null);
                          onArchive(project);
                        }}
                      >
                        <Archive size={14} />
                        归档
                      </button> : null}
                      {canManagePermissions ? <button
                        onClick={() => {
                          setOpenMenuProjectId(null);
                          onDelete(project);
                        }}
                      >
                        <Trash2 size={14} />
                        删除
                      </button> : null}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
          );
        })}
        {!visibleProjects.length ? (
          <p className="empty-hint">
            {query.trim() || filtersActive
              ? "没有符合当前搜索和筛选条件的项目，换个关键词或清空筛选再看看。"
              : projectView === "completed" ? "暂无已归档项目" : "暂无进行中项目"}
          </p>
        ) : null}
      </div>

      <div className="project-user-shell" ref={userMenuShellRef}>
        {userMenu}
        <button
          ref={userMenuTriggerRef}
          className="avatar-button project-avatar-button"
          aria-label="打开用户菜单"
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          onClick={() => setUserMenuOpen((open) => !open)}
        >
          <span className="avatar">{userInitial}</span>
          <span>{userLabel}</span>
          <ChevronDown size={16} />
        </button>
      </div>
      {projectHoverTooltip}
      {permissionsProject ? <ProjectPermissionsDialog project={permissionsProject} onClose={() => setPermissionsProject(null)} /> : null}
      {changePasswordDialog}
    </aside>
  );
}
