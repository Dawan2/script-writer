"use client";

import Link from "next/link";
import { ExternalLink, RefreshCcw, RotateCcw, Search, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cancelAdminJob, getAdminJobs, retryAdminJob } from "@/lib/admin-api";
import type { AdminJob, Pagination } from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import { PageLoading } from "@/components/ui/page-loading";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

const STATUS_LABELS: Record<string, string> = { queued: "排队中", running: "运行中", succeeded: "成功", failed: "失败", canceled: "已取消" };
const STAGE_LABELS: Record<string, string> = { next: "下一阶段", all: "全流程", chat_edit: "对话修改", novel_analysis: "小说解读", world_view: "世界观", outline_rewrite: "故事梗概", character_rewrite: "人物小传", trial_generate: "剧本试稿", full_generate: "完整剧本", dialogue_translate: "台词翻译", foreign_review: "海外审稿", humanizer_zh: "剧本润色" };

function formatDuration(seconds?: number | null) {
  if (seconds == null) return "--";
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function AdminJobsView({ onNotice }: { onNotice: (message: string) => void }) {
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, page_size: 25, total: 0, total_pages: 1 });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ type: "cancel" | "retry"; job: AdminJob } | null>(null);

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const result = await getAdminJobs({ query, status: statusFilter, page });
      setJobs(result.jobs); setPagination(result.pagination);
    } catch (error) { onNotice(error instanceof Error ? error.message : "任务加载失败"); }
    finally { setLoading(false); }
  }, [onNotice, query, statusFilter]);

  useEffect(() => { const timer = window.setTimeout(() => void load(1), 250); return () => window.clearTimeout(timer); }, [load]);

  async function confirmAction() {
    if (!action || busy) return;
    setBusy(true);
    try {
      if (action.type === "cancel") await cancelAdminJob(action.job.id);
      else await retryAdminJob(action.job.id);
      onNotice(action.type === "cancel" ? "Agent 任务已取消" : "Agent 任务已重新排队");
      setAction(null); await load(pagination.page);
    } catch (error) { onNotice(error instanceof Error ? error.message : "任务操作失败"); }
    finally { setBusy(false); }
  }

  if (loading && !jobs.length) return <PageLoading label="正在加载任务" />;

  return (
    <div className={styles.view}>
      <div className={styles.viewToolbar}>
        <div className={styles.filterRow}><div className={styles.searchBox}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、用户或任务 ID" /></div><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">全部状态</option>{Object.entries(STATUS_LABELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></div>
        <div className={styles.toolbarRight}><span className={styles.totalLabel}>{pagination.total} 个任务</span><button className={styles.iconButton} onClick={() => void load(pagination.page)} aria-label="刷新" title="刷新"><RefreshCcw size={16} /></button></div>
      </div>
      <div className={styles.tableWrap} aria-busy={loading}><table className={styles.table}>
        <thead><tr><th>ID</th><th>项目</th><th>阶段</th><th>发起人</th><th>状态</th><th>耗时</th><th>开始时间</th><th>结果</th><th aria-label="操作" /></tr></thead>
        <tbody>{jobs.map((job) => <tr key={job.id}>
          <td className={styles.mono}>#{job.id}</td><td><div className={styles.projectCell}><strong>{job.project_name}</strong><small>#{job.project_id}</small></div></td>
          <td>{STAGE_LABELS[job.target_stage ?? job.stage] ?? job.target_stage ?? job.stage}</td><td>@{job.requested_by_username}</td>
          <td><span className={`${styles.badge} ${styles[`job_${job.status}`]}`}>{STATUS_LABELS[job.status] ?? job.status}</span></td>
          <td className={styles.mono}>{formatDuration(job.duration_seconds)}</td><td><time>{formatDateTime(job.started_at)}</time></td>
          <td><span className={job.error_message ? styles.errorMessage : styles.cellSub} title={job.error_message ?? ""}>{job.error_message ?? (job.status === "succeeded" ? "已完成" : "--")}</span></td>
          <td><div className={styles.rowActions}><Link className={styles.iconLink} href={`/workspace?project=${job.project_id}`} aria-label="打开项目" title="打开项目"><ExternalLink size={15} /></Link>{["queued", "running"].includes(job.status) ? <button className={styles.iconButtonDanger} onClick={() => setAction({ type: "cancel", job })} aria-label="取消任务" title="取消任务"><Square size={14} /></button> : null}{["failed", "canceled"].includes(job.status) && job.project_status !== "completed" && !job.project_deleted_at ? <button className={styles.iconButton} onClick={() => setAction({ type: "retry", job })} aria-label="重试任务" title="重试"><RotateCcw size={15} /></button> : null}</div></td>
        </tr>)}{!loading && !jobs.length ? <tr><td colSpan={9} className={styles.emptyCell}>暂无任务</td></tr> : null}</tbody>
      </table></div>
      <div className={styles.pagination}><button disabled={pagination.page <= 1} onClick={() => void load(pagination.page - 1)}>上一页</button><span>{pagination.page} / {pagination.total_pages}</span><button disabled={pagination.page >= pagination.total_pages} onClick={() => void load(pagination.page + 1)}>下一页</button></div>
      {action ? <AdminDialog title={`${action.type === "cancel" ? "取消" : "重试"} Agent 任务 #${action.job.id}`} confirmLabel={action.type === "cancel" ? "取消任务" : "重新排队"} destructive={action.type === "cancel"} busy={busy} onCancel={() => setAction(null)} onConfirm={() => void confirmAction()}><p className={styles.dialogText}>{action.type === "cancel" ? "当前进程将被停止，已生成的阶段文件不会自动删除。" : "将使用原任务的阶段和提示词创建一个新任务。"}</p></AdminDialog> : null}
    </div>
  );
}
