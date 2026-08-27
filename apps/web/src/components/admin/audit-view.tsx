"use client";

import { RefreshCcw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PageLoading } from "@/components/ui/page-loading";
import { getAuditLogs } from "@/lib/admin-api";
import type { AuditLog, Pagination } from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import styles from "./admin.module.css";

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "登录成功",
  "auth.logout": "退出登录",
  "auth.password_change": "修改密码",
  "authorization.denied": "访问被拒绝",
  "user.create": "创建用户",
  "user.update": "修改用户",
  "user.delete": "删除用户",
  "credits.adjust": "调整创作额度",
  "credits.plan.update": "设置用户套餐",
  "credits.plan.grant": "发放套餐额度",
  "credits.prices.update": "更新阶段额度",
  "project.create": "创建项目",
  "project.rename": "重命名项目",
  "project.update": "修改项目",
  "project.reinitialize": "重新初始化项目",
  "project.distribution_brief.update": "更新发行任务书",
  "project.permission.grant": "授予项目权限",
  "project.permission.update": "调整项目权限",
  "project.permission.revoke": "移除项目权限",
  "project.archive": "归档项目",
  "project.reopen": "重新开启项目",
  "project.trash": "移入回收站",
  "project.restore": "恢复项目",
  "project.purge": "彻底删除项目",
  "stage.approve": "确认阶段结果",
  "stage.approval.invalidate": "撤销阶段确认",
  "document.edit": "编辑文档",
  "document.generated": "生成文档",
  "document.agent_edit": "智能修改文档",
  "artifact.download": "导出文件",
  "source.download": "下载原始文件",
  "agent_job.create": "创建任务",
  "agent_job.started": "任务开始处理",
  "agent_job.running": "任务运行中",
  "agent_job.succeeded": "任务完成",
  "agent_job.failed": "任务失败",
  "agent_job.canceled": "任务已取消",
  "agent_job.retry": "重试任务",
  "agent_job.resumed": "恢复任务",
  "agent_job.execution.reclaimed": "接管任务执行",
  "agent_job.cancel": "取消任务",
  "agent_job.debug.start": "打开任务调试记录",
  "batch_task.create": "创建批量任务",
  "batch_task.started": "批量任务开始处理",
  "batch_task.start": "启动批量任务",
  "batch_task.resume": "恢复批量任务",
  "batch_task.pause": "暂停批量任务",
  "batch_task.rerun": "重新执行批量任务",
  "batch_task.delete": "删除批量任务",
  "batch_task.start_all": "启动全部批量任务",
  "batch_task.stage.advance": "推进批量任务阶段",
  "batch_task.awaiting_approval": "等待阶段确认",
  "batch_task.stop_after_stage": "按阶段暂停",
  "batch_task.retry_scheduled": "安排批量任务重试",
  "batch_task.complete": "批量任务完成",
  "batch_task.failed": "批量任务失败",
  "writer_preference.create": "新增创作偏好",
  "writer_preference.update": "修改创作偏好",
  "writer_preference.delete": "删除创作偏好",
  "writer_preference.reorder": "调整创作偏好顺序",
  "writer_preference.import": "导入创作偏好",
  "writer_preference.export": "导出创作偏好",
  "writer_preference.summary.started": "开始整理创作偏好",
  "writer_preference.summary.completed": "完成创作偏好整理",
  "writer_preference.summary.failed": "创作偏好整理失败",
  "region_rules.update": "更新地区规则",
  "agent_evolution.trigger": "开始 Agent 进化分析",
  "agent_evolution.retry": "重新分析 Agent 进化",
  "agent_evolution.debug.start": "打开进化分析调试记录",
  "agent_evolution.analysis.started": "开始进化分析",
  "agent_evolution.analysis.completed": "进化分析完成",
  "agent_evolution.analysis.failed": "进化分析失败",
  "agent_evolution.dismiss": "不执行进化方案",
  "agent_evolution.execute": "执行 Agent 优化",
  "agent_evolution.execution.started": "开始执行 Agent 优化",
  "agent_evolution.execution.completed": "Agent 优化完成",
  "agent_evolution.execution.failed": "Agent 优化失败"
};

const OUTCOME_LABELS: Record<AuditLog["outcome"], string> = {
  success: "成功",
  failure: "失败",
  denied: "已拒绝"
};

const SOURCE_LABELS: Record<AuditLog["source"], string> = {
  web: "网页操作",
  api: "接口调用",
  system: "系统处理"
};

const STAGE_LABELS: Record<string, string> = {
  project_init: "项目初始化",
  novel_analysis: "小说解读",
  world_view: "世界观",
  outline_rewrite: "故事梗概",
  character_rewrite: "角色设定",
  trial_generate: "剧本试稿",
  full_generate: "完整剧本",
  dialogue_translate: "台词翻译",
  foreign_review: "海外审稿",
  humanizer_zh: "剧本润色"
};

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stageLabel(value: unknown) {
  const stage = textValue(value);
  return STAGE_LABELS[stage] ?? stage;
}

function detailSummary(log: AuditLog) {
  const details = log.details;
  const stage = stageLabel(details.stage ?? details.target_stage);
  const change = textValue(details.change_summary);

  if (log.action === "user.delete") return `${details.project_count ?? 0} 个项目已移交`;
  if (log.action === "region_rules.update") {
    return `新增 ${(details.added_regions as unknown[] | undefined)?.length ?? 0} 项，更新 ${(details.updated_regions as unknown[] | undefined)?.length ?? 0} 项，移除 ${(details.removed_regions as unknown[] | undefined)?.length ?? 0} 项`;
  }
  if (log.action === "project.rename") {
    const before = details.before as { name?: unknown } | undefined;
    const after = details.after as { name?: unknown } | undefined;
    return `${textValue(before?.name) || "原名称"} 改为 ${textValue(after?.name) || "新名称"}`;
  }
  if (log.action === "artifact.download") return [stage, textValue(details.format)].filter(Boolean).join(" · ") || "已导出";
  if (log.action === "document.edit" || log.action === "document.generated" || log.action === "document.agent_edit") {
    return [stage, change || "内容已更新"].filter(Boolean).join(" · ");
  }
  if (log.action.startsWith("agent_job.")) return stage || "查看详情";
  if (log.action.startsWith("batch_task.")) return stage || "查看详情";
  if (log.action.startsWith("writer_preference.")) {
    const count = details.created_count ?? details.preference_count ?? details.suggested_count;
    return typeof count === "number" ? `${count} 条创作偏好` : "查看详情";
  }
  if (Object.prototype.hasOwnProperty.call(details, "before") || Object.prototype.hasOwnProperty.call(details, "after")) return "已记录变更";
  return Object.keys(details).length ? "查看详情" : "--";
}

function validProjectId(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function AdminAuditView({ onNotice }: { onNotice: (message: string) => void }) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, page_size: 30, total: 0, total_pages: 1 });
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState<"" | AuditLog["outcome"]>("");
  const [source, setSource] = useState<"" | AuditLog["source"]>("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const result = await getAuditLogs({
        query,
        action,
        projectId: validProjectId(projectId),
        outcome: outcome || undefined,
        source: source || undefined,
        page
      });
      setLogs(result.logs);
      setPagination(result.pagination);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [action, onNotice, outcome, projectId, query, source]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(1), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loading && !logs.length) return <PageLoading label="正在加载审计日志" />;

  return <div className={styles.view}>
    <div className={styles.viewToolbar}>
      <div className={styles.filterRow}>
        <div className={styles.searchBox}>
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索操作人、对象或编号" />
        </div>
        <input className={styles.auditProjectFilter} value={projectId} inputMode="numeric" onChange={(event) => setProjectId(event.target.value)} placeholder="项目编号" />
        <select value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="">全部操作</option>
          {Object.entries(ACTION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select value={outcome} onChange={(event) => setOutcome(event.target.value as "" | AuditLog["outcome"])}>
          <option value="">全部结果</option>
          {Object.entries(OUTCOME_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select value={source} onChange={(event) => setSource(event.target.value as "" | AuditLog["source"])}>
          <option value="">全部来源</option>
          {Object.entries(SOURCE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      <div className={styles.toolbarRight}>
        <span className={styles.totalLabel}>{pagination.total} 条记录</span>
        <button className={styles.iconButton} onClick={() => void load(pagination.page)} aria-label="刷新" title="刷新"><RefreshCcw size={16} /></button>
      </div>
    </div>
    <div className={styles.tableWrap} aria-busy={loading}>
      <table className={styles.table}>
        <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>结果</th><th>来源</th><th>对象</th><th>编号</th><th>变更摘要</th></tr></thead>
        <tbody>
          {logs.map((log) => <tr key={log.id}>
            <td><time>{formatDateTime(log.created_at)}</time></td>
            <td>@{log.actor_username}</td>
            <td><span className={styles.auditAction}>{ACTION_LABELS[log.action] ?? log.action}</span></td>
            <td><span className={`${styles.auditMeta} ${log.outcome === "success" ? styles.auditSuccess : styles.auditWarning}`}>{OUTCOME_LABELS[log.outcome] ?? log.outcome}</span></td>
            <td><span className={styles.auditMeta}>{SOURCE_LABELS[log.source] ?? log.source}</span></td>
            <td>{log.target_label ?? log.target_type}</td>
            <td className={styles.mono}>{log.target_id ?? "--"}</td>
            <td><details className={styles.auditDetails}><summary>{detailSummary(log)}</summary><pre>{JSON.stringify(log.details, null, 2)}</pre></details></td>
          </tr>)}
          {!loading && !logs.length ? <tr><td colSpan={8} className={styles.emptyCell}>暂无审计日志</td></tr> : null}
        </tbody>
      </table>
    </div>
    <div className={styles.pagination}>
      <button disabled={pagination.page <= 1} onClick={() => void load(pagination.page - 1)}>上一页</button>
      <span>{pagination.page} / {pagination.total_pages}</span>
      <button disabled={pagination.page >= pagination.total_pages} onClick={() => void load(pagination.page + 1)}>下一页</button>
    </div>
  </div>;
}
