"use client";

import {
  BrainCircuit,
  Bug,
  Check,
  CheckCircle2,
  FileText,
  Play,
  RefreshCcw,
  Users,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageLoading } from "@/components/ui/page-loading";
import {
  createAdminAgentEvolutionRun,
  dismissAdminAgentEvolutionRun,
  executeAdminAgentEvolutionRun,
  getAdminAgentEvolution,
  getAdminAgentEvolutionRun,
  removeAdminSystemWriterPreferences,
  retryAdminAgentEvolutionRun,
  setAdminSystemWriterPreferences,
  startAdminAgentEvolutionDebug
} from "@/lib/admin-api";
import type {
  AdminAgentEvolutionPayload,
  AdminAgentEvolutionRun,
  AdminWriterPreference,
  AgentEvolutionStatus
} from "@/lib/admin-types";
import type { AgentDebugSession } from "@/lib/types";
import { formatDateTime } from "@/lib/date-time";
import { renderMarkdown } from "@/lib/markdown";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

type EvolutionTab = "runs" | "preferences";

const STATUS_LABELS: Record<AgentEvolutionStatus, string> = {
  queued: "等待分析",
  analyzing: "分析中",
  awaiting_review: "待审核",
  applying: "执行中",
  completed: "已完成",
  dismissed: "不执行",
  failed: "分析失败",
  execution_failed: "执行失败"
};

const SCOPE_LABELS: Record<string, string> = {
  global: "全局创作观",
  world_view: "世界观构建",
  outline_rewrite: "梗概创作",
  character_rewrite: "人物塑造",
  trial_generate: "试稿创作",
  full_generate: "全稿创作",
  foreign_review: "AI 审稿",
  humanizer_zh: "剧本润色"
};

function formatDate(value?: string | null) {
  return formatDateTime(value, undefined, "首次分析起点");
}

function sourceLabel(preference: AdminWriterPreference) {
  if (preference.is_system_preference) return "系统偏好";
  if (preference.source === "manual") return "用户手动添加";
  const evidence = preference.evidence ?? {};
  return typeof evidence.project_name === "string"
    ? `归档项目「${evidence.project_name}」`
    : "归档偏好总结";
}

function preferenceKey(preference: AdminWriterPreference) {
  return preference.is_system_preference
    ? `system:${preference.system_preference_id ?? preference.id}`
    : `user:${preference.id}`;
}

function isActive(status: AgentEvolutionStatus) {
  return ["queued", "analyzing", "applying"].includes(status);
}

function debugSessionUrl(session: AgentDebugSession | null) {
  if (!session) return "";
  try {
    const url = new URL(session.url || `http://127.0.0.1:${session.port}`);
    if (typeof window !== "undefined") {
      const debugUrl = new URL(`/zdebug/${url.port}/`, window.location.origin);
      if (session.selected_log_id) debugUrl.searchParams.set("logid", session.selected_log_id);
      if (session.session_id) debugUrl.searchParams.set("sessionid", session.session_id);
      return debugUrl.toString();
    }
    if (session.selected_log_id) url.searchParams.set("logid", session.selected_log_id);
    if (session.session_id) url.searchParams.set("sessionid", session.session_id);
    return url.toString();
  } catch {
    return session.url;
  }
}

export function AdminAgentEvolutionView({ onNotice }: { onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<EvolutionTab>("runs");
  const [data, setData] = useState<AdminAgentEvolutionPayload>({ runs: [], preferences: [] });
  const [selectedRun, setSelectedRun] = useState<AdminAgentEvolutionRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [executeOpen, setExecuteOpen] = useState(false);
  const [requirements, setRequirements] = useState("");
  const [preferenceQuery, setPreferenceQuery] = useState("");
  const [selectedPreferenceKeys, setSelectedPreferenceKeys] = useState<Set<string>>(new Set());
  const [debugLoading, setDebugLoading] = useState(false);
  const selectAllPreferencesRef = useRef<HTMLInputElement>(null);

  const loadDetail = useCallback(async (runId: number, quiet = false) => {
    if (!quiet) setDetailLoading(true);
    try {
      const result = await getAdminAgentEvolutionRun(runId);
      setSelectedRun(result.run);
      return result.run;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "报告加载失败");
      return null;
    } finally {
      if (!quiet) setDetailLoading(false);
    }
  }, [onNotice]);

  const load = useCallback(async (preferredRunId?: number, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const payload = await getAdminAgentEvolution();
      setData(payload);
      const runId = preferredRunId ?? payload.runs[0]?.id;
      if (runId) await loadDetail(runId, quiet);
      else setSelectedRun(null);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Agent 进化数据加载失败");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [loadDetail, onNotice]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!data.runs.some((run) => isActive(run.status))) return;
    const timer = window.setInterval(() => void load(selectedRun?.id, true), 3000);
    return () => window.clearInterval(timer);
  }, [data.runs, load, selectedRun?.id]);

  const filteredPreferences = useMemo(() => {
    const normalized = preferenceQuery.trim().toLocaleLowerCase();
    if (!normalized) return data.preferences;
    return data.preferences.filter((item) => [
      item.content,
      item.user?.display_name ?? "系统",
      item.user?.username ?? "",
      sourceLabel(item),
      ...item.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope)
    ].some((value) => value.toLocaleLowerCase().includes(normalized)));
  }, [data.preferences, preferenceQuery]);
  const selectedPreferences = filteredPreferences.filter((preference) => selectedPreferenceKeys.has(preferenceKey(preference)));
  const selectedUserPreferenceIds = selectedPreferences
    .filter((preference) => !preference.is_system_preference)
    .map((preference) => preference.id);
  const selectedSystemPreferenceIds = selectedPreferences
    .filter((preference) => preference.is_system_preference)
    .map((preference) => preference.system_preference_id ?? preference.id);
  const allVisiblePreferencesSelected = filteredPreferences.length > 0 && selectedPreferences.length === filteredPreferences.length;
  const someVisiblePreferencesSelected = selectedPreferences.length > 0 && !allVisiblePreferencesSelected;

  useEffect(() => {
    if (selectAllPreferencesRef.current) selectAllPreferencesRef.current.indeterminate = someVisiblePreferencesSelected;
  }, [someVisiblePreferencesSelected]);

  function togglePreferenceSelection(preference: AdminWriterPreference) {
    const key = preferenceKey(preference);
    setSelectedPreferenceKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllVisiblePreferences() {
    setSelectedPreferenceKeys((current) => {
      const next = new Set(current);
      if (allVisiblePreferencesSelected) {
        filteredPreferences.forEach((preference) => next.delete(preferenceKey(preference)));
      } else {
        filteredPreferences.forEach((preference) => next.add(preferenceKey(preference)));
      }
      return next;
    });
  }

  async function triggerAnalysis() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await createAdminAgentEvolutionRun();
      onNotice("新一轮分析已开始");
      await load(result.run.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法开始分析");
    } finally {
      setBusy(false);
    }
  }

  async function retryAnalysis(runId: number) {
    if (busy) return;
    setBusy(true);
    try {
      await retryAdminAgentEvolutionRun(runId);
      onNotice(`分析 #${runId} 已重新开始`);
      await load(runId);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法重新分析");
    } finally {
      setBusy(false);
    }
  }

  async function openDebug(runId: number) {
    const debugWindow = window.open("about:blank", "_blank");
    if (!debugWindow) {
      onNotice("浏览器阻止了调试日志窗口，请允许新窗口后重试。");
      return;
    }
    debugWindow.opener = null;
    debugWindow.document.title = "ZDebug";
    debugWindow.document.body.textContent = "正在打开分析过程...";
    setDebugLoading(true);
    try {
      const result = await startAdminAgentEvolutionDebug(runId);
      const debugUrl = debugSessionUrl(result.debug);
      if (!debugUrl) throw new Error("无法获取分析过程地址");
      debugWindow.location.replace(debugUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法打开分析过程";
      if (!debugWindow.closed) debugWindow.document.body.textContent = message;
      onNotice(message);
    } finally {
      setDebugLoading(false);
    }
  }

  async function dismissRun() {
    if (!selectedRun || busy) return;
    setBusy(true);
    try {
      await dismissAdminAgentEvolutionRun(selectedRun.id);
      onNotice("该方案已标记为不执行");
      await load(selectedRun.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "方案状态更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function executeRun() {
    if (!selectedRun || busy || !requirements.trim()) return;
    setBusy(true);
    try {
      await executeAdminAgentEvolutionRun(selectedRun.id, requirements.trim());
      setExecuteOpen(false);
      setRequirements("");
      onNotice("优化执行已开始");
      await load(selectedRun.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法执行优化");
    } finally {
      setBusy(false);
    }
  }

  async function setSystemPreferences(preferenceIds: number[]) {
    if (!preferenceIds.length || busy) return;
    setBusy(true);
    try {
      const result = await setAdminSystemWriterPreferences(preferenceIds);
      setSelectedPreferenceKeys(new Set());
      onNotice(result.created_system_preference_ids.length
        ? `已设为 ${result.created_system_preference_ids.length} 条系统偏好`
        : "所选偏好已是系统偏好");
      setData((current) => ({ ...current, preferences: result.preferences }));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "系统偏好设置失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeSystemPreferences(preferenceIds: number[]) {
    if (!preferenceIds.length || busy) return;
    setBusy(true);
    try {
      const result = await removeAdminSystemWriterPreferences(preferenceIds);
      setSelectedPreferenceKeys(new Set());
      onNotice(`已取消 ${result.removed_system_preference_ids.length} 条系统偏好`);
      setData((current) => ({ ...current, preferences: result.preferences }));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "系统偏好取消失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data.runs.length && !data.preferences.length) {
    return <PageLoading label="正在加载 Agent 进化记录" />;
  }

  return (
    <div className={`${styles.view} ${styles.evolutionView}`}>
      <div className={styles.viewToolbar}>
        <div className={styles.segmented} aria-label="Agent 进化视图">
          <button className={tab === "runs" ? styles.segmentedActive : ""} onClick={() => setTab("runs")}><FileText size={14} />进化记录</button>
          <button className={tab === "preferences" ? styles.segmentedActive : ""} onClick={() => setTab("preferences")}><Users size={14} />用户偏好</button>
        </div>
        <div className={styles.toolbarRight}>
          <button className={styles.iconButton} onClick={() => void load(selectedRun?.id)} aria-label="刷新" title="刷新"><RefreshCcw size={15} /></button>
          {tab === "runs" ? <button className={styles.primaryButton} disabled={busy || data.runs.some((run) => isActive(run.status))} onClick={() => void triggerAnalysis()}><BrainCircuit size={16} />开始新一轮分析</button> : null}
        </div>
      </div>

      {tab === "runs" ? (
        <div className={styles.evolutionLayout}>
          <aside className={styles.evolutionRunList} aria-label="进化历史">
            <header><span>分析记录</span><strong>{data.runs.length}</strong></header>
            <div>
              {data.runs.map((run) => (
                <div key={run.id} className={`${styles.evolutionRunItem} ${selectedRun?.id === run.id ? styles.evolutionRunActive : ""}`}>
                  <button className={styles.evolutionRunSelect} onClick={() => void loadDetail(run.id)}>
                    <span><b>#{run.id}</b></span>
                    <time>{formatDate(run.created_at)}</time>
                    <small>{run.evidence_summary ? `${run.evidence_summary.job_count} 个任务 · ${run.evidence_summary.manual_change_count} 次人工调整` : "等待证据统计"}</small>
                  </button>
                  <div className={styles.evolutionRunTools}>
                    <i className={`${styles.badge} ${styles[`evolution_${run.status}`]}`}>{STATUS_LABELS[run.status]}</i>
                    {run.status === "failed" ? <button className={styles.evolutionRetryLink} disabled={busy} onClick={() => void retryAnalysis(run.id)}>重新分析</button> : null}
                    <button className={styles.evolutionDebugButton} disabled={debugLoading} onClick={() => void openDebug(run.id)} aria-label={`查看分析 #${run.id} 的过程`} title="查看分析过程"><Bug size={13} /></button>
                  </div>
                </div>
              ))}
              {!data.runs.length ? <div className={styles.evolutionEmpty}>尚未进行过系统优化分析</div> : null}
            </div>
          </aside>

          <section className={styles.evolutionDetail}>
            {detailLoading ? <PageLoading label="正在加载进化报告" /> : selectedRun ? (
              <>
                <header className={styles.evolutionDetailHeader}>
                  <div>
                    <div className={styles.evolutionStatusLine}>
                      <span className={`${styles.badge} ${styles[`evolution_${selectedRun.status}`]}`}>{STATUS_LABELS[selectedRun.status]}</span>
                      {selectedRun.status === "failed" ? <button className={styles.evolutionRetryLink} disabled={busy} onClick={() => void retryAnalysis(selectedRun.id)}>重新分析</button> : null}
                    </div>
                    <h2>Agent 进化分析 #{selectedRun.id}</h2>
                    <p>{formatDate(selectedRun.range_start)} 至 {formatDate(selectedRun.range_end)}</p>
                  </div>
                  <div className={styles.rowActions}>
                    <button className={styles.iconButton} disabled={debugLoading} onClick={() => void openDebug(selectedRun.id)} aria-label="查看分析过程" title="查看分析过程"><Bug size={15} /></button>
                    {selectedRun.status === "awaiting_review" ? <>
                      <button className={styles.secondaryButton} disabled={busy} onClick={() => void dismissRun()}><XCircle size={15} />不执行</button>
                      <button className={styles.primaryButton} disabled={busy} onClick={() => setExecuteOpen(true)}><Play size={15} />执行优化</button>
                    </> : null}
                  </div>
                </header>

                {selectedRun.evidence_summary ? <div className={styles.evolutionMetrics}>
                  <span><b>{selectedRun.evidence_summary.job_count}</b>任务</span>
                  <span><b>{selectedRun.evidence_summary.failed_job_count}</b>失败</span>
                  <span><b>{selectedRun.evidence_summary.retry_job_count}</b>重试</span>
                  <span><b>{selectedRun.evidence_summary.repeated_operation_count ?? selectedRun.evidence_summary.repeated_tool_chain_count ?? 0}</b>重复操作</span>
                  <span><b>{selectedRun.evidence_summary.manual_change_count}</b>人工调整</span>
                  <span><b>{selectedRun.evidence_summary.user_preference_count}</b>用户偏好</span>
                </div> : null}

                {selectedRun.error_message ? <div className={styles.evolutionFailure}>{selectedRun.error_message}</div> : null}
                {selectedRun.report_markdown ? <article className={styles.evolutionReport}>{renderMarkdown(selectedRun.report_markdown)}</article> : (
                  <div className={styles.evolutionPending}>
                    {isActive(selectedRun.status) ? <RefreshCcw size={20} /> : <FileText size={20} />}
                    <strong>{isActive(selectedRun.status) ? "正在整理证据并生成报告" : "未生成可查看的报告"}</strong>
                  </div>
                )}
                {selectedRun.execution_log ? <section className={styles.evolutionExecution}>
                  <h3><CheckCircle2 size={17} />执行记录</h3>
                  <div className={styles.evolutionReport}>{renderMarkdown(selectedRun.execution_log)}</div>
                </section> : null}
              </>
            ) : <div className={styles.evolutionPending}><BrainCircuit size={22} /><strong>选择一条记录查看报告</strong></div>}
          </section>
        </div>
      ) : (
        <div className={styles.evolutionPreferences}>
          <div className={styles.evolutionPreferenceToolbar}>
            <div className={styles.evolutionPreferenceSummary}><strong>所有偏好</strong><span>{data.preferences.length} 条</span>{selectedPreferences.length ? <span className={styles.selectionCount}>已选 {selectedPreferences.length} 条</span> : null}</div>
            <div className={styles.evolutionPreferenceBulkActions}>
              <button className={styles.secondaryButton} disabled={busy || !selectedUserPreferenceIds.length} onClick={() => void setSystemPreferences(selectedUserPreferenceIds)}>设为系统偏好</button>
              <button className={styles.secondaryButton} disabled={busy || !selectedSystemPreferenceIds.length} onClick={() => void removeSystemPreferences(selectedSystemPreferenceIds)}>取消系统偏好</button>
            </div>
            <input value={preferenceQuery} onChange={(event) => setPreferenceQuery(event.target.value)} placeholder="搜索用户、偏好、阶段或来源" />
          </div>
          <div className={styles.tableWrap}><table className={styles.table}>
            <colgroup>
              <col /><col /><col /><col /><col /><col /><col /><col /><col /><col />
            </colgroup>
            <thead><tr><th className={styles.selectionColumn}><input ref={selectAllPreferencesRef} aria-label="全选当前偏好" type="checkbox" checked={allVisiblePreferencesSelected} onChange={toggleAllVisiblePreferences} /></th><th>用户</th><th>偏好内容</th><th>适用范围</th><th>来源</th><th>系统偏好</th><th>状态</th><th>版本</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>{filteredPreferences.map((preference) => <tr key={preferenceKey(preference)}>
              <td className={styles.selectionColumn}><input aria-label={`选择${preference.content}`} type="checkbox" checked={selectedPreferenceKeys.has(preferenceKey(preference))} onChange={() => togglePreferenceSelection(preference)} /></td>
              <td>{preference.user ? <div className={styles.personCell}><span>{preference.user.display_name[0] ?? preference.user.username[0]}</span><div><strong>{preference.user.display_name}</strong><small>@{preference.user.username} · r{preference.profile_revision}</small></div></div> : <span className={styles.evolutionSystemOwner}>系统</span>}</td>
              <td><span className={styles.evolutionPreferenceContent} title={preference.content}>{preference.content}</span></td>
              <td><span className={styles.evolutionScopeList}>{preference.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join("、")}</span></td>
              <td><span className={styles.evolutionPreferenceSource}>{sourceLabel(preference)}</span></td>
              <td>{preference.is_system_preference ? <span className={styles.evolutionSystemCheck} aria-label="是系统偏好" title="系统偏好"><Check size={15} /></span> : <span className={styles.evolutionSystemEmpty}>--</span>}</td>
              <td><span className={`${styles.badge} ${preference.enabled ? styles.status_completed : ""}`}>{preference.is_system_preference ? "系统默认" : preference.enabled ? "已启用" : "待确认"}</span></td>
              <td className={styles.mono}>v{preference.version}</td>
              <td><time>{formatDate(preference.updated_at)}</time></td>
              <td><button className={styles.evolutionPreferenceAction} disabled={busy} onClick={() => void (preference.is_system_preference ? removeSystemPreferences([preference.system_preference_id ?? preference.id]) : setSystemPreferences([preference.id]))}>{preference.is_system_preference ? "取消系统偏好" : "设为系统偏好"}</button></td>
            </tr>)}{!filteredPreferences.length ? <tr><td colSpan={10} className={styles.emptyCell}>暂无符合条件的偏好</td></tr> : null}</tbody>
          </table></div>
        </div>
      )}

      {executeOpen && selectedRun ? <AdminDialog
        title={`执行 Agent 优化 #${selectedRun.id}`}
        confirmLabel="按要求执行"
        busy={busy}
        confirmDisabled={!requirements.trim()}
        onCancel={() => setExecuteOpen(false)}
        onConfirm={() => void executeRun()}
      >
        <label className={styles.field}>
          <span>本次执行要求</span>
          <textarea rows={7} maxLength={4000} value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="说明要执行哪些优化点、必须保留的行为、验收重点或禁止改动的范围" />
          <small>{requirements.length} / 4000</small>
        </label>
      </AdminDialog> : null}

    </div>
  );
}
