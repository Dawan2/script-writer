"use client";

import {
  ChevronDown,
  CirclePause,
  Copy,
  ExternalLink,
  FilePlus2,
  Filter,
  ListChecks,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppNav } from "@/components/navigation/app-nav";
import { PageLoading } from "@/components/ui/page-loading";
import { formatDateTime } from "@/lib/date-time";
import { DEFAULT_MATURITY_TARGET, MATURITY_TARGET_OPTIONS } from "@/lib/maturity-targets";
import {
  batchTaskAction,
  createBatchTasks,
  deleteBatchTask,
  getBatchTaskScenarios,
  getBatchTasks,
  pauseBatchTask,
  rerunBatchTask,
  startAllBatchTasks,
  startBatchTask
} from "@/lib/api-client";
import type { BatchTask, BatchTaskScenario, BatchTaskStatus, TargetRegion, User } from "@/lib/types";
import styles from "./batch-tasks.module.css";

type DraftTask = {
  id: number;
  project_name: string;
  source_file: File | null;
  target_region: string;
  extra_requirements: string;
  episode_duration: string;
  target_episode_count: string;
  maturity_target: string;
};

type TaskAction = "start" | "pause" | "rerun" | "delete";

const STATUS_LABELS: Record<BatchTaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  paused: "已暂停",
  succeeded: "已完成",
  failed: "待继续"
};

function formatDuration(seconds: number | null) {
  if (seconds === null) return "--";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes < 60 ? `${minutes} 分 ${remaining} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatDate(value: string | null) {
  return formatDateTime(value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function defaultStopAfterStage(scenarioKey: string, scenarios: BatchTaskScenario[]) {
  const scenario = scenarios.find((item) => item.key === scenarioKey);
  if (!scenario) return "";
  if (scenarioKey === "rewrite" || scenarioKey === "novel" || scenarioKey === "replicate") {
    const trial = scenario.stages.find((stage) => stage.key === "trial_generate");
    if (trial) return trial.key;
  }
  return scenario.stages[scenario.stages.length - 1]?.key ?? "";
}

function createDraftTask(id: number, regions: TargetRegion[]): DraftTask {
  const region = regions[0];
  return {
    id,
    project_name: "",
    source_file: null,
    target_region: region?.key ?? "",
    extra_requirements: "",
    episode_duration: "",
    target_episode_count: "",
    maturity_target: DEFAULT_MATURITY_TARGET
  };
}

function optionalTaskFields(draft: DraftTask) {
  return Object.fromEntries(
    Object.entries({
      extra_requirements: draft.extra_requirements,
      episode_duration: draft.episode_duration,
      target_episode_count: draft.target_episode_count,
      maturity_target: draft.maturity_target
    }).flatMap(([field, value]) => {
      const normalized = value.trim();
      return normalized ? [[field, normalized]] : [];
    })
  );
}

function fileNameToProjectName(file: File | null) {
  return file?.name.replace(/\.[^.]+$/, "").trim() ?? "";
}

export function BatchTasksPage({ user }: { user: User }) {
  const rowId = useRef(1);
  const [tasks, setTasks] = useState<BatchTask[]>([]);
  const [scenarios, setScenarios] = useState<BatchTaskScenario[]>([]);
  const [regions, setRegions] = useState<TargetRegion[]>([]);
  const [maxParallel, setMaxParallel] = useState(2);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [batchName, setBatchName] = useState("");
  const [batchScenario, setBatchScenario] = useState("");
  const [batchStopAfterStage, setBatchStopAfterStage] = useState("");
  const [drafts, setDrafts] = useState<DraftTask[]>([]);
  const [advancedRows, setAdvancedRows] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<{ ids: number[]; label: string } | null>(null);

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const payload = await getBatchTasks({ scenario: scenarioFilter, status: statusFilter, query });
      setTasks(payload.tasks);
      setScenarios((current) => current.length ? current : payload.scenarios);
      setMaxParallel(payload.max_parallel);
      setSelectedIds((current) => new Set([...current].filter((id) => payload.tasks.some((task) => task.id === id))));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "批量任务加载失败");
    } finally {
      setLoading(false);
      if (showSpinner) setRefreshing(false);
    }
  }, [query, scenarioFilter, statusFilter]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getBatchTaskScenarios(), getBatchTasks()])
      .then(([metadata, payload]) => {
        if (cancelled) return;
        setScenarios(metadata.scenarios);
        setRegions(metadata.regions);
        setTasks(payload.tasks);
        setMaxParallel(payload.max_parallel);
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : "批量任务加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (loading) return;
    const timer = window.setTimeout(() => void refresh(), 220);
    return () => window.clearTimeout(timer);
  }, [query, scenarioFilter, statusFilter, loading, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const activeCount = useMemo(() => tasks.filter((task) => task.status === "running").length, [tasks]);
  const allSelected = tasks.length > 0 && tasks.every((task) => selectedIds.has(task.id));
  const visibleStopStages = useMemo(() => {
    const stages = scenarios.find((scenario) => scenario.key === batchScenario)?.stages ?? [];
    const domesticAdaptation = (batchScenario === "rewrite" || batchScenario === "novel" || batchScenario === "replicate")
      && drafts.some((draft) => regions.find((region) => region.key === draft.target_region)?.requires_translation === false);
    return domesticAdaptation ? stages.filter((stage) => stage.key !== "dialogue_translate") : stages;
  }, [batchScenario, drafts, regions, scenarios]);

  useEffect(() => {
    if (batchStopAfterStage && visibleStopStages.some((stage) => stage.key === batchStopAfterStage)) return;
    setBatchStopAfterStage(defaultStopAfterStage(batchScenario, [{ key: batchScenario, name: "", stages: visibleStopStages }]));
  }, [batchScenario, batchStopAfterStage, visibleStopStages]);

  function openEditor() {
    const scenario = scenarios[0]?.key ?? "";
    const first = createDraftTask(rowId.current++, regions);
    setDrafts([first]);
    setBatchName("");
    setBatchScenario(scenario);
    setBatchStopAfterStage(defaultStopAfterStage(scenario, scenarios));
    setAdvancedRows(new Set());
    setError(null);
    setEditorOpen(true);
  }

  function updateDraft(id: number, patch: Partial<DraftTask>) {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
  }

  function updateBatchScenario(scenario: string) {
    setBatchScenario(scenario);
    setBatchStopAfterStage(defaultStopAfterStage(scenario, scenarios));
  }

  function addDraft(copyFrom?: DraftTask) {
    const next = copyFrom
      ? { ...copyFrom, id: rowId.current++, project_name: "", source_file: null }
      : createDraftTask(rowId.current++, regions);
    setDrafts((current) => [...current, next]);
  }

  function removeDraft(id: number) {
    setDrafts((current) => current.length > 1 ? current.filter((draft) => draft.id !== id) : current);
    setAdvancedRows((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function updateRegion(draft: DraftTask, targetRegion: string) {
    updateDraft(draft.id, { target_region: targetRegion });
  }

  async function submitBatch() {
    const incomplete = drafts.find((draft) => !draft.project_name.trim() || !draft.source_file || !draft.target_region);
    if (!batchScenario || !batchStopAfterStage || incomplete) {
      setError("请补全批次的场景、运行至步骤，以及每条任务的名称、剧本文件和目标地区");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createBatchTasks(batchName, drafts.map((draft) => ({
        project_name: draft.project_name.trim(),
        source_file: draft.source_file!,
        scenario: batchScenario,
        stop_after_stage: batchStopAfterStage,
        target_region: draft.target_region,
        ...optionalTaskFields(draft)
      })));
      setEditorOpen(false);
      setNotice(`已录入 ${drafts.length} 条任务，系统会按顺序执行`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "批量任务创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function runTaskAction(action: Exclude<TaskAction, "delete">, task: BatchTask) {
    setBusyTaskId(task.id);
    setError(null);
    try {
      if (action === "start") await startBatchTask(task.id);
      if (action === "pause") await pauseBatchTask(task.id);
      if (action === "rerun") await rerunBatchTask(task.id);
      setNotice(
        action === "pause"
          ? "任务已暂停"
          : action === "start"
            ? "任务已重新排队，将从当前阶段继续"
            : "任务已重新排队，将从头创建新的工作台项目"
      );
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "任务操作失败");
    } finally {
      setBusyTaskId(null);
    }
  }

  async function startAll() {
    setBusy(true);
    setError(null);
    try {
      const result = await startAllBatchTasks();
      setNotice(`已安排 ${result.updated} 条未完成任务继续处理`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "全部开始失败");
    } finally {
      setBusy(false);
    }
  }

  async function runBulk(action: TaskAction, ids = [...selectedIds]) {
    if (!ids.length) return;
    setBusy(true);
    setBulkMenuOpen(false);
    setError(null);
    try {
      if (action === "delete") {
        await Promise.all(ids.map((id) => deleteBatchTask(id)));
      } else {
        const result = await batchTaskAction(action, ids);
        if (result.failures.length) setError(result.failures.map((item) => item.message).join("；"));
      }
      setSelectedIds(new Set());
      setNotice(
        action === "pause"
          ? "已暂停所选任务"
          : action === "start"
            ? "已将所选任务重新排队，将从当前阶段继续"
            : action === "rerun"
              ? "已重新安排所选任务，并将从头创建新的工作台项目"
              : "已删除所选批量记录，工作台项目会保留"
      );
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "批量操作失败");
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  }

  function toggleSelected(taskId: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(taskId) ? next.delete(taskId) : next.add(taskId);
      return next;
    });
  }

  if (loading) return <PageLoading label="正在加载批量任务" />;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <AppNav current="batch-tasks" user={user} />
          <span className={styles.headingIcon}><ListChecks size={20} /></span>
          <div><h1>批量任务</h1><p>同时执行 {maxParallel} 个任务，其余任务会依次进入处理队列</p></div>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.iconButton} type="button" onClick={() => void refresh(true)} aria-label="刷新任务列表" title="刷新任务列表" disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? styles.spinning : undefined} />
          </button>
          <button className={styles.primaryButton} type="button" onClick={openEditor}><Plus size={17} />新建批次</button>
          <span className={styles.identity}>{user.display_name || user.username}</span>
        </div>
      </header>

      <section className={styles.content}>
        {error ? <div className={styles.errorBanner} role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭提示" title="关闭提示"><X size={15} /></button></div> : null}
        {notice ? <div className={styles.noticeBanner} role="status">{notice}</div> : null}

        <div className={styles.summaryLine}>
          <span><i className={styles.runningDot} />正在执行 <strong>{activeCount}</strong> / {maxParallel}</span>
          <span>共 <strong>{tasks.length}</strong> 条任务</span>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.filters}>
            <label className={styles.searchBox}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务名称" /></label>
            <label className={styles.filterSelect}><Filter size={15} /><select value={scenarioFilter} onChange={(event) => setScenarioFilter(event.target.value)}><option value="">全部场景</option>{scenarios.map((scenario) => <option key={scenario.key} value={scenario.key}>{scenario.name}</option>)}</select></label>
            <select className={styles.statusSelect} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">全部状态</option>{Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          </div>
          <div className={styles.toolbarActions}>
            <button className={styles.secondaryButton} type="button" onClick={() => void startAll()} disabled={busy}><Play size={15} />继续全部任务</button>
            <div className={styles.bulkMenu}>
              <button className={styles.secondaryButton} type="button" onClick={() => setBulkMenuOpen((open) => !open)} disabled={!selectedIds.size || busy} aria-expanded={bulkMenuOpen}>
                批量操作 <ChevronDown size={15} />
              </button>
              {bulkMenuOpen ? <div className={styles.bulkMenuPanel} role="menu">
                <button type="button" role="menuitem" onClick={() => void runBulk("start")}><Play size={15} />继续所选任务</button>
                <button type="button" role="menuitem" onClick={() => void runBulk("pause")}><CirclePause size={15} />暂停所选任务</button>
                <button type="button" role="menuitem" onClick={() => void runBulk("rerun")}><RotateCcw size={15} />从头重新执行</button>
                <button type="button" role="menuitem" className={styles.dangerMenuItem} onClick={() => setConfirmDelete({ ids: [...selectedIds], label: `所选 ${selectedIds.size} 条任务` })}><Trash2 size={15} />删除所选记录</button>
              </div> : null}
            </div>
          </div>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <colgroup>
              <col className={styles.selectionColumn} />
              <col className={styles.nameColumn} />
              <col className={styles.creatorColumn} />
              <col className={styles.scenarioColumn} />
              <col className={styles.progressColumn} />
              <col className={styles.statusColumn} />
              <col className={styles.runtimeColumn} />
              <col className={styles.resultColumn} />
              <col className={styles.actionsColumn} />
            </colgroup>
            <thead><tr><th><input aria-label="全选任务" type="checkbox" checked={allSelected} onChange={() => setSelectedIds(allSelected ? new Set() : new Set(tasks.map((task) => task.id)))} /></th><th>任务</th><th>创建人</th><th>场景</th><th>进度与暂停点</th><th>状态</th><th>运行信息</th><th>处理结果</th><th>操作</th></tr></thead>
            <tbody>
              {tasks.map((task) => {
                const taskBusy = busyTaskId === task.id;
                return <tr key={task.id}>
                  <td><input aria-label={`选择 ${task.project_name}`} type="checkbox" checked={selectedIds.has(task.id)} onChange={() => toggleSelected(task.id)} /></td>
                  <td><div className={styles.nameCell}><strong>{task.project_name}</strong><small>{task.batch_name}{task.run_count > 1 ? ` · 第 ${task.run_count} 次` : ""}</small></div></td>
                  <td><span className={styles.creatorCell} title={task.creator_name}>{task.creator_name}</span></td>
                  <td><span className={styles.scenarioTag}>{task.scenario.name}</span></td>
                  <td><div className={styles.stageRoute}><span className={styles.currentStage} title={task.phase.file_name ?? undefined}>{task.phase.name}</span><span className={styles.routeArrow} aria-hidden="true">→</span><span className={styles.stopStage} title={task.pause_at.file_name ?? undefined}>{task.pause_at.key ? task.pause_at.name : "完整执行"}</span></div></td>
                  <td><span className={`${styles.statusTag} ${styles[`status_${task.status}`]}`}>{taskBusy ? <LoaderCircle size={12} className={styles.spinning} /> : null}{STATUS_LABELS[task.status]}</span></td>
                  <td><div className={styles.runtimeCell}><time>{formatDate(task.started_at)}</time><span>{formatDuration(task.duration_seconds)}</span></div></td>
                  <td><span className={task.status === "failed" ? styles.errorResult : styles.result} title={task.result}>{task.result}</span></td>
                  <td><div className={styles.rowActions}>
                    {task.project_id && !task.project_deleted ? <button className={styles.iconButton} type="button" onClick={() => window.open(`/workspace?project=${task.project_id}`, "_blank", "noopener,noreferrer")} aria-label="在新窗口查看详情" title="在新窗口查看详情"><ExternalLink size={15} /></button> : null}
                    {task.status === "paused" || task.status === "failed" ? <button className={styles.iconButton} type="button" onClick={() => void runTaskAction("start", task)} disabled={taskBusy} aria-label="继续任务" title="从当前阶段继续"><Play size={15} /></button> : null}
                    {task.status === "queued" || task.status === "running" ? <button className={styles.iconButton} type="button" onClick={() => void runTaskAction("pause", task)} disabled={taskBusy} aria-label="暂停任务" title="暂停任务"><CirclePause size={15} /></button> : null}
                    {task.status !== "running" ? <button className={styles.iconButton} type="button" onClick={() => void runTaskAction("rerun", task)} disabled={taskBusy} aria-label="从头重新执行" title="从头重新执行"><RotateCcw size={15} /></button> : null}
                    <button className={styles.dangerIconButton} type="button" onClick={() => setConfirmDelete({ ids: [task.id], label: `「${task.project_name}」` })} disabled={taskBusy} aria-label="删除批量任务记录" title="删除批量任务记录"><Trash2 size={15} /></button>
                  </div></td>
                </tr>;
              })}
              {!tasks.length ? <tr><td colSpan={9} className={styles.emptyCell}><FilePlus2 size={22} /><span>暂无批量任务</span><button className={styles.linkButton} type="button" onClick={openEditor}>录入第一批任务</button></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      {editorOpen ? <div className={styles.modalBackdrop} role="presentation">
        <section className={styles.editor} role="dialog" aria-modal="true" aria-label="新建批量任务">
          <header className={styles.editorHeader}><div><span className={styles.editorEyebrow}>批量录入</span><h2>新建批量任务</h2><p>先设置本批次的处理场景和暂停节点，再逐条录入剧本。</p></div><button className={styles.iconButton} type="button" onClick={() => !busy && setEditorOpen(false)} aria-label="关闭新建批次" title="关闭" disabled={busy}><X size={17} /></button></header>
          <div className={styles.editorMeta}><div className={styles.batchSettings}><label className={`${styles.batchField} ${styles.batchNameField}`}><span>批次名称</span><input value={batchName} onChange={(event) => setBatchName(event.target.value)} placeholder="例如：北美改写第一批" /></label><label className={styles.batchField}><span>场景</span><select value={batchScenario} onChange={(event) => updateBatchScenario(event.target.value)}>{scenarios.map((scenario) => <option key={scenario.key} value={scenario.key}>{scenario.name}</option>)}</select></label><label className={styles.batchField}><span>运行至</span><select value={batchStopAfterStage} onChange={(event) => setBatchStopAfterStage(event.target.value)}>{visibleStopStages.map((stage) => <option key={stage.key} value={stage.key}>{stage.name}</option>)}</select></label></div><span className={styles.taskCount}>{drafts.length} 条任务</span></div>
          <div className={styles.editorBody}>
            <div className={styles.draftList}>{drafts.map((draft, index) => <DraftRow
                key={draft.id}
                draft={draft}
                index={index}
                scenario={batchScenario}
                regions={regions}
                advanced={advancedRows.has(draft.id)}
                canRemove={drafts.length > 1}
                onChange={updateDraft}
                onRegionChange={updateRegion}
                onToggleAdvanced={() => setAdvancedRows((current) => { const next = new Set(current); next.has(draft.id) ? next.delete(draft.id) : next.add(draft.id); return next; })}
                onCopy={() => addDraft(draft)}
                onRemove={() => removeDraft(draft.id)}
              />)}</div>
          </div>
          <div className={styles.editorFooter}><button className={styles.secondaryButton} type="button" onClick={() => addDraft()} disabled={busy}><Plus size={15} />新增一行</button><div><button className={styles.textButton} type="button" onClick={() => setEditorOpen(false)} disabled={busy}>取消</button><button className={styles.primaryButton} type="button" onClick={() => void submitBatch()} disabled={busy}>{busy ? <LoaderCircle size={16} className={styles.spinning} /> : <Upload size={16} />}提交并开始排队</button></div></div>
        </section>
      </div> : null}

      {confirmDelete ? <div className={styles.modalBackdrop} role="presentation"><section className={styles.confirmDialog} role="dialog" aria-modal="true" aria-label="删除批量任务记录"><h2>删除批量任务记录？</h2><p>将删除 {confirmDelete.label} 的队列记录。关联的工作台项目和已生成内容会保留。</p><div><button className={styles.secondaryButton} type="button" onClick={() => setConfirmDelete(null)} disabled={busy}>取消</button><button className={styles.dangerButton} type="button" onClick={() => void runBulk("delete", confirmDelete.ids)} disabled={busy}>删除记录</button></div></section></div> : null}
    </main>
  );
}

function DraftRow({
  draft,
  index,
  scenario,
  regions,
  advanced,
  canRemove,
  onChange,
  onRegionChange,
  onToggleAdvanced,
  onCopy,
  onRemove
}: {
  draft: DraftTask;
  index: number;
  scenario: string;
  regions: TargetRegion[];
  advanced: boolean;
  canRemove: boolean;
  onChange: (id: number, patch: Partial<DraftTask>) => void;
  onRegionChange: (draft: DraftTask, targetRegion: string) => void;
  onToggleAdvanced: () => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const sourceLabel = scenario === "novel" ? "原始小说" : scenario === "replicate" ? "爆款分析报告" : scenario === "translate" ? "待翻译剧本" : scenario === "review" ? "待审剧本" : "原始剧本";
  return <section className={styles.draftRow} aria-label={`任务 ${index + 1}`}>
    <header className={styles.draftRowHeader}>
      <div className={styles.draftIdentity}><span className={styles.draftNumber}>{String(index + 1).padStart(2, "0")}</span><span>任务 {index + 1}</span></div>
      <div className={styles.draftActions}><button type="button" onClick={onCopy} aria-label="复制这条任务" title="复制这条任务"><Copy size={14} /></button><button type="button" onClick={onRemove} aria-label="删除这条任务" title={canRemove ? "删除这条任务" : "至少保留一条任务"} disabled={!canRemove}><Trash2 size={14} /></button></div>
    </header>
    <div className={styles.draftMainGrid}>
      <label className={`${styles.formField} ${styles.fieldProject}`}><span>任务名称</span><input value={draft.project_name} onChange={(event) => onChange(draft.id, { project_name: event.target.value })} placeholder="例如：北美改写第一批" /></label>
      <div className={`${styles.formField} ${styles.fieldSource}`}><span>{sourceLabel}</span><label className={styles.filePicker}><Upload size={16} /><span>{draft.source_file?.name || "选择文件"}</span><input type="file" accept=".pdf,.docx,.epub,.txt,.md,.markdown" aria-label={`选择${sourceLabel}`} onChange={(event) => { const file = event.target.files?.[0] ?? null; onChange(draft.id, { source_file: file, project_name: draft.project_name || fileNameToProjectName(file) }); }} /></label></div>
      <label className={styles.formField}><span>目标地区</span><select value={draft.target_region} onChange={(event) => onRegionChange(draft, event.target.value)}>{regions.map((region) => <option key={region.key} value={region.key}>{region.key}</option>)}</select></label>
      <label className={`${styles.formField} ${styles.fieldRequirements}`}><span>需求说明</span><textarea value={draft.extra_requirements} onChange={(event) => onChange(draft.id, { extra_requirements: event.target.value })} placeholder="选填，补充这条任务的特殊要求" /></label>
    </div>
    <button className={styles.advancedToggle} type="button" onClick={onToggleAdvanced} aria-expanded={advanced}><span><SlidersHorizontal size={14} />详细设置</span><ChevronDown size={15} className={advanced ? styles.chevronOpen : undefined} /></button>
    {advanced ? <div className={styles.advancedFields}><div className={styles.advancedGrid}>
      <label className={styles.formField}><span>单集规格</span><input value={draft.episode_duration} onChange={(event) => onChange(draft.id, { episode_duration: event.target.value })} placeholder="90 秒" /></label>
      <label className={styles.formField}><span>目标集数</span><input type="number" min="1" value={draft.target_episode_count} onChange={(event) => onChange(draft.id, { target_episode_count: event.target.value })} placeholder="例如：90" /></label>
      <label className={styles.formField}><span>目标分级</span><select value={draft.maturity_target} onChange={(event) => onChange(draft.id, { maturity_target: event.target.value })}>{MATURITY_TARGET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    </div></div> : null}
  </section>;
}
