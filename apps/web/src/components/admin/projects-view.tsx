"use client";

import Link from "next/link";
import { Archive, ExternalLink, Pencil, RotateCcw, Search, Trash2, UserRoundCog } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  bulkAdminProjectAction,
  getAdminProjects,
  getAdminRegions,
  getAdminUsers,
  purgeAdminProject,
  restoreAdminProject,
  trashAdminProject,
  updateAdminProject
} from "@/lib/admin-api";
import { archiveProject, reopenProject } from "@/lib/api-client";
import type { AdminProject, AdminUser, Pagination, ProjectLifecycle, RegionRulesPayload } from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import { PageLoading } from "@/components/ui/page-loading";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

type ProjectAction = { type: "archive" | "reopen" | "trash" | "restore" | "purge"; project: AdminProject } | null;

const LIFECYCLE_LABELS: Record<ProjectLifecycle, string> = { active: "进行中", completed: "已完成", trash: "回收站" };
const STAGE_LABELS: Record<string, string> = { project_init: "原始剧本", novel_analysis: "小说解读", world_view: "世界观", outline_rewrite: "故事梗概", character_rewrite: "人物小传", trial_generate: "剧本试稿", full_generate: "剧本全稿", dialogue_translate: "台词翻译", foreign_review: "审稿报告", humanizer_zh: "剧本润色" };

function finalStageForTask(taskType: AdminProject["task_type"]) {
  if (taskType === "translate") return "dialogue_translate";
  if (taskType === "humanize") return "humanizer_zh";
  if (taskType === "replicate") return "foreign_review";
  return "foreign_review";
}

function taskTypeLabel(taskType: AdminProject["task_type"]) {
  if (taskType === "novel") return "小说改编";
  if (taskType === "replicate") return "爆款复刻";
  if (taskType === "review") return "剧本审核";
  if (taskType === "translate") return "台词翻译";
  if (taskType === "humanize") return "剧本润色";
  return "剧本改写";
}

function stageLabel(taskType: AdminProject["task_type"], stage: string) {
  if (taskType === "replicate" && stage === "project_init") return "爆款分析报告";
  return STAGE_LABELS[stage] ?? stage;
}

export function AdminProjectsView({ onNotice }: { onNotice: (message: string) => void }) {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [regions, setRegions] = useState<RegionRulesPayload | null>(null);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, page_size: 25, total: 0, total_pages: 1 });
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState<"all" | ProjectLifecycle>("all");
  const [taskType, setTaskType] = useState<"" | AdminProject["task_type"]>("");
  const [owner, setOwner] = useState<number | "">("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AdminProject | null>(null);
  const [action, setAction] = useState<ProjectAction>(null);
  const [bulkAction, setBulkAction] = useState<"archive" | "trash" | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [editName, setEditName] = useState("");
  const [editOwner, setEditOwner] = useState<number | "">("");
  const [editRegion, setEditRegion] = useState("");
  const selectAllRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const [projectResult, userResult, regionResult] = await Promise.allSettled([
        getAdminProjects({ query, lifecycle, taskType: taskType || undefined, ownerUserId: owner || undefined, page }),
        getAdminUsers(),
        getAdminRegions()
      ]);
      if (projectResult.status === "rejected") throw projectResult.reason;

      setProjects(projectResult.value.projects);
      setPagination(projectResult.value.pagination);
      setSelectedIds(new Set());

      const unavailable: string[] = [];
      if (userResult.status === "fulfilled") setUsers(userResult.value.users);
      else unavailable.push("负责人信息");
      if (regionResult.status === "fulfilled") setRegions(regionResult.value);
      else unavailable.push("地区信息");
      if (unavailable.length) onNotice(`项目已加载，${unavailable.join("和")}暂时无法读取`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "项目加载失败");
    } finally {
      setLoading(false);
    }
  }, [lifecycle, onNotice, owner, query, taskType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(1), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedProjects = projects.filter((project) => selectedIds.has(project.id));
  const allVisibleSelected = projects.length > 0 && selectedProjects.length === projects.length;
  const someVisibleSelected = selectedProjects.length > 0 && !allVisibleSelected;
  const canBulkArchive = selectedProjects.length > 0 && selectedProjects.every(
    (project) => project.lifecycle_status === "active" && project.current_stage === finalStageForTask(project.task_type) && !project.has_running_agent
  );
  const canBulkTrash = selectedProjects.length > 0 && selectedProjects.every((project) => project.lifecycle_status !== "trash");

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  function toggleSelected(projectId: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(projects.map((project) => project.id)));
  }

  function openEditor(project: AdminProject) {
    setEditing(project); setEditName(project.name); setEditOwner(project.owner_user_id); setEditRegion(project.target_region ?? "");
  }

  async function saveProject() {
    if (!editing || !editOwner || busy) return;
    setBusy(true);
    try {
      await updateAdminProject(editing.id, { name: editName.trim(), owner_user_id: editOwner, target_region: editRegion });
      onNotice("项目信息已更新"); setEditing(null); await load(pagination.page);
    } catch (error) { onNotice(error instanceof Error ? error.message : "项目保存失败"); }
    finally { setBusy(false); }
  }

  async function confirmAction() {
    if (!action || busy) return;
    setBusy(true);
    try {
      if (action.type === "archive") await archiveProject(action.project.id);
      if (action.type === "reopen") await reopenProject(action.project.id);
      if (action.type === "trash") await trashAdminProject(action.project.id);
      if (action.type === "restore") await restoreAdminProject(action.project.id);
      if (action.type === "purge") await purgeAdminProject(action.project.id);
      onNotice({ archive: "项目已归档", reopen: "项目已重新开启", trash: "项目已移入回收站", restore: "项目已恢复", purge: "项目已彻底删除" }[action.type]);
      setAction(null); await load(pagination.page);
    } catch (error) { onNotice(error instanceof Error ? error.message : "项目操作失败"); }
    finally { setBusy(false); }
  }

  async function confirmBulkAction() {
    if (!bulkAction || busy || !selectedProjects.length) return;
    const projectIds = selectedProjects.map((project) => project.id);
    setBusy(true);
    try {
      const result = await bulkAdminProjectAction(bulkAction, projectIds);
      const verb = bulkAction === "archive" ? "归档" : "移入回收站";
      if (result.failed.length) {
        const firstFailure = result.failed[0]?.message;
        onNotice(result.succeeded.length
          ? `已${verb} ${result.succeeded.length} 个项目；${result.failed.length} 个未完成${firstFailure ? `（${firstFailure}）` : ""}`
          : `${result.failed.length} 个项目未完成${firstFailure ? `（${firstFailure}）` : ""}`);
      } else {
        onNotice(`已${verb} ${result.succeeded.length} 个项目`);
      }
      setBulkAction(null); await load(pagination.page);
    } catch (error) { onNotice(error instanceof Error ? error.message : "批量操作失败"); }
    finally { setBusy(false); }
  }

  const actionLabel = action ? { archive: "归档项目", reopen: "重新开启", trash: "移入回收站", restore: "恢复项目", purge: "彻底删除" }[action.type] : "";

  if (loading && !projects.length) return <PageLoading label="正在加载项目" />;

  return (
    <div className={styles.view}>
      <div className={styles.viewToolbar}>
        <div className={styles.filterRow}>
          <div className={styles.searchBox}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或负责人" /></div>
          <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as "all" | ProjectLifecycle)}><option value="all">全部状态</option><option value="active">进行中</option><option value="completed">已完成</option><option value="trash">回收站</option></select>
          <select value={taskType} onChange={(event) => setTaskType(event.target.value as typeof taskType)}><option value="">全部场景</option><option value="rewrite">剧本改写</option><option value="novel">小说改编</option><option value="replicate">爆款复刻</option><option value="review">剧本审核</option><option value="translate">台词翻译</option><option value="humanize">剧本润色</option></select>
          <select value={owner} onChange={(event) => setOwner(event.target.value ? Number(event.target.value) : "")}><option value="">全部负责人</option>{users.map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}</select>
        </div>
        <div className={styles.toolbarRight}>
          {selectedProjects.length ? <span className={styles.selectionCount}>已选 {selectedProjects.length} 个</span> : null}
          <button className={styles.secondaryButton} disabled={!canBulkArchive || busy} onClick={() => setBulkAction("archive")} title={canBulkArchive ? "归档所选项目" : "请选择已完成海外审稿且未运行任务的进行中项目"}><Archive size={15} />归档所选</button>
          <button className={styles.dangerButton} disabled={!canBulkTrash || busy} onClick={() => setBulkAction("trash")} title={canBulkTrash ? "将所选项目移入回收站" : "请选择未在回收站中的项目"}><Trash2 size={15} />移入回收站</button>
          <span className={styles.totalLabel}>{pagination.total} 个项目</span>
        </div>
      </div>
      <div className={styles.tableWrap} aria-busy={loading}>
        <table className={styles.table}>
          <thead><tr><th className={styles.selectionColumn}><input ref={selectAllRef} aria-label="全选当前页项目" type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} /></th><th>项目</th><th>负责人</th><th>地区</th><th>场景</th><th>状态</th><th>当前阶段</th><th>任务</th><th>更新时间</th><th aria-label="操作" /></tr></thead>
          <tbody>{projects.map((project) => <tr key={project.id}>
            <td className={styles.selectionColumn}><input aria-label={`选择 ${project.name}`} type="checkbox" checked={selectedIds.has(project.id)} onChange={() => toggleSelected(project.id)} /></td>
            <td><div className={styles.projectCell}><strong>{project.name}</strong><small>#{project.id}</small></div></td>
            <td>{project.owner_display_name}<small className={styles.cellSub}>@{project.owner_username}</small></td>
            <td>{project.target_region ?? "--"}</td><td>{taskTypeLabel(project.task_type)}</td>
            <td><span className={`${styles.badge} ${styles[`status_${project.lifecycle_status}`]}`}>{LIFECYCLE_LABELS[project.lifecycle_status]}</span></td>
            <td>{stageLabel(project.task_type, project.current_stage)}{project.has_running_agent ? <small className={styles.runningText}>运行中</small> : null}</td>
            <td>{project.job_count}<small className={project.failed_job_count ? styles.errorSub : styles.cellSub}>{project.failed_job_count} 失败</small></td>
            <td><time>{formatDateTime(project.updated_at, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></td>
            <td><div className={styles.rowActions}>
              {project.lifecycle_status !== "trash" ? <Link className={styles.iconLink} href={`/workspace?project=${project.id}`} aria-label={`打开 ${project.name}`} title="打开工作台"><ExternalLink size={15} /></Link> : null}
              {project.lifecycle_status !== "trash" ? <button className={styles.iconButton} onClick={() => openEditor(project)} aria-label="编辑项目" title="编辑"><Pencil size={15} /></button> : null}
              {project.lifecycle_status === "active" ? <button className={styles.iconButton} disabled={project.current_stage !== finalStageForTask(project.task_type) || project.has_running_agent} onClick={() => setAction({ type: "archive", project })} aria-label="归档项目" title="归档"><Archive size={15} /></button> : null}
              {project.lifecycle_status === "completed" ? <button className={styles.iconButton} onClick={() => setAction({ type: "reopen", project })} aria-label="重新开启项目" title="重新开启"><RotateCcw size={15} /></button> : null}
              {project.lifecycle_status !== "trash" ? <button className={styles.iconButtonDanger} onClick={() => setAction({ type: "trash", project })} aria-label="移入回收站" title="移入回收站"><Trash2 size={15} /></button> : null}
              {project.lifecycle_status === "trash" ? <><button className={styles.iconButton} onClick={() => setAction({ type: "restore", project })} aria-label="恢复项目" title="恢复"><RotateCcw size={15} /></button><button className={styles.iconButtonDanger} onClick={() => setAction({ type: "purge", project })} aria-label="彻底删除" title="彻底删除"><Trash2 size={15} /></button></> : null}
            </div></td>
          </tr>)}{!loading && !projects.length ? <tr><td colSpan={10} className={styles.emptyCell}>暂无项目</td></tr> : null}</tbody>
        </table>
      </div>
      <div className={styles.pagination}><button disabled={pagination.page <= 1} onClick={() => void load(pagination.page - 1)}>上一页</button><span>{pagination.page} / {pagination.total_pages}</span><button disabled={pagination.page >= pagination.total_pages} onClick={() => void load(pagination.page + 1)}>下一页</button></div>

      {editing ? <AdminDialog title="编辑项目" confirmLabel="保存修改" busy={busy} confirmDisabled={!editName.trim() || !editOwner || !editRegion} onCancel={() => setEditing(null)} onConfirm={() => void saveProject()}><div className={styles.formGrid}><label className={styles.fullField}><span>项目名称</span><input value={editName} onChange={(event) => setEditName(event.target.value)} /></label><label><span>负责人</span><select value={editOwner} onChange={(event) => setEditOwner(Number(event.target.value))}>{users.map((user) => <option key={user.id} value={user.id}>{user.display_name} (@{user.username})</option>)}</select></label><label><span>目标地区</span><select value={editRegion} onChange={(event) => setEditRegion(event.target.value)}>{Object.keys(regions?.config.regions ?? {}).map((key) => <option key={key} value={key}>{key}</option>)}</select></label></div><div className={styles.transferNote}><UserRoundCog size={16} />移交后，新负责人将立即看到该项目。</div></AdminDialog> : null}
      {bulkAction ? <AdminDialog title={`${bulkAction === "archive" ? "归档" : "移入回收站"}所选 ${selectedProjects.length} 个项目`} confirmLabel={bulkAction === "archive" ? "归档项目" : "移入回收站"} destructive={bulkAction === "trash"} busy={busy} confirmDisabled={!selectedProjects.length} onCancel={() => setBulkAction(null)} onConfirm={() => void confirmBulkAction()}><p className={bulkAction === "trash" ? styles.dangerText : styles.dialogText}>{bulkAction === "archive" ? "归档后，所选项目将进入只读状态。" : "所选项目将进入 30 天回收站，可在到期前恢复。"}</p></AdminDialog> : null}
      {action ? <AdminDialog title={`${actionLabel}「${action.project.name}」`} confirmLabel={actionLabel} destructive={action.type === "purge" || action.type === "trash"} busy={busy} onCancel={() => setAction(null)} onConfirm={() => void confirmAction()}><p className={action.type === "purge" ? styles.dangerText : styles.dialogText}>{action.type === "archive" ? "归档后项目将标记为已完成并进入只读状态。" : action.type === "reopen" ? "重新开启后可继续编辑文档并运行 Agent。" : action.type === "trash" ? "项目将进入 30 天回收站。" : action.type === "restore" ? "项目将恢复到原来的生命周期状态。" : "项目工作目录、上传件、日志和数据库记录将永久删除。"}</p></AdminDialog> : null}
    </div>
  );
}
