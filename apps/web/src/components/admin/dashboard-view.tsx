"use client";

import { Activity, Clock3, Coins, FilePenLine, FileText, RefreshCcw, Users, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Funnel,
  FunnelChart,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { getAdminDashboard, getAdminUsers } from "@/lib/admin-api";
import type { AdminDashboard, AdminUser, DashboardMetricKey, DashboardPeriod, DashboardTaskType } from "@/lib/admin-types";
import { PageLoading } from "@/components/ui/page-loading";
import styles from "./admin.module.css";

const COLORS = ["#176b70", "#d76545", "#d0a83c", "#58705f", "#4d7f98", "#8d6779", "#728443"];
const OPERATION_COLORS: Record<string, string> = {
  automatic: "#176b70",
  manual_edit: "#d76545",
  conversation: "#d0a83c",
  regenerate: "#58705f",
  empty: "#d8dfd9"
};
const STAGE_LABELS: Record<string, string> = {
  project_init: "原始剧本",
  novel_analysis: "小说解读",
  world_view: "世界观",
  outline_rewrite: "故事梗概",
  character_rewrite: "人物小传",
  trial_generate: "剧本试稿",
  full_generate: "完整剧本",
  dialogue_translate: "台词翻译",
  foreign_review: "审稿报告",
  humanizer_zh: "剧本润色"
};
const OPERATION_LABELS: Record<string, string> = {
  automatic: "自动生成",
  manual_edit: "手动编辑",
  conversation: "对话操作",
  regenerate: "重新生成",
  empty: "暂无操作"
};
const TREND_LABELS: Record<DashboardMetricKey, string> = {
  scripts: "维护剧本数",
  writers: "参与编剧数",
  preferences: "用户偏好数",
  script_duration_p95_seconds: "单篇耗时 P95",
  tokens: "Token 消耗",
  cost_usd: "费用消耗"
};
const SCENARIO_OPTIONS: Array<{ value: DashboardTaskType; label: string }> = [
  { value: "rewrite", label: "剧本改写" },
  { value: "novel", label: "小说改编" },
  { value: "replicate", label: "爆款复刻" },
  { value: "review", label: "剧本审核" },
  { value: "translate", label: "台词翻译" },
  { value: "humanize", label: "剧本润色" }
];

function durationLabel(seconds: number) {
  if (!seconds) return "--";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  }
  return `${Math.round(seconds / 60)} 分钟`;
}

function compactNumber(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return `${Math.round(value)}`;
}

function moneyLabel(value: number) {
  if (!value) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function localDateValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultCustomRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  return { start: localDateValue(start), end: localDateValue(end) };
}

function trendValueLabel(metric: DashboardMetricKey, value: number) {
  if (metric === "script_duration_p95_seconds") return durationLabel(value);
  if (metric === "cost_usd") return moneyLabel(value);
  return Number(value).toLocaleString("zh-CN");
}

export function AdminDashboardView({ onNotice }: { onNotice: (message: string) => void }) {
  const [period, setPeriod] = useState<DashboardPeriod>("30d");
  const [operatorUserId, setOperatorUserId] = useState<number | "">("");
  const [taskType, setTaskType] = useState<DashboardTaskType | "">("");
  const [customRange, setCustomRange] = useState(defaultCustomRange);
  const [trendMetric, setTrendMetric] = useState<DashboardMetricKey>("scripts");
  const [efficiencyMode, setEfficiencyMode] = useState<"total" | "p95">("total");
  const [selectedOperationStage, setSelectedOperationStage] = useState("world_view");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const updateCustomRange = useCallback((field: "start" | "end", nextValue: string) => {
    setCustomRange((value) => ({ ...value, [field]: nextValue }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getAdminDashboard({
        period,
        operatorUserId: operatorUserId || undefined,
        taskType: taskType || undefined,
        startDate: period === "custom" ? customRange.start : undefined,
        endDate: period === "custom" ? customRange.end : undefined
      }));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "仪表板加载失败");
    } finally {
      setLoading(false);
    }
  }, [customRange.end, customRange.start, onNotice, operatorUserId, period, taskType]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void getAdminUsers()
      .then((payload) => setUsers(payload.users))
      .catch((error) => onNotice(error instanceof Error ? error.message : "用户列表加载失败"));
  }, [onNotice]);

  const summary = data?.summary;
  const executionAggregate = data?.execution.aggregate;
  const aggregateLabel = efficiencyMode === "total" ? "累计汇总" : "P95 汇总";
  const stageMetrics = data?.execution.stage_metrics.map((item) => ({ ...item, name: STAGE_LABELS[item.key] ?? item.key })) ?? [];
  const funnelData = data?.execution.funnel.map((item) => ({ ...item, name: STAGE_LABELS[item.key] ?? item.key })) ?? [];
  const operationStageData = data?.execution.operations.by_stage.map((item) => ({ ...item, name: STAGE_LABELS[item.key] ?? item.key })) ?? [];
  const activeOperationStage = operationStageData.some((item) => item.key === selectedOperationStage && item.value > 0)
    ? selectedOperationStage
    : operationStageData.find((item) => item.value > 0)?.key ?? selectedOperationStage;
  const selectedOperationData = useMemo(() => {
    const breakdown = data?.execution.operations.by_stage_kind ?? [];
    return ["automatic", "manual_edit", "conversation", "regenerate"].map((key) => ({
      key,
      name: OPERATION_LABELS[key],
      value: breakdown.find((item) => item.stage === activeOperationStage && item.key === key)?.value ?? 0
    }));
  }, [activeOperationStage, data?.execution.operations.by_stage_kind]);
  const childPieData = selectedOperationData.some((item) => item.value > 0)
    ? selectedOperationData.filter((item) => item.value > 0)
    : [{ key: "empty", name: OPERATION_LABELS.empty, value: 1 }];
  const parentPieData = operationStageData.some((item) => item.value > 0)
    ? operationStageData.filter((item) => item.value > 0)
    : [{ key: "empty", name: OPERATION_LABELS.empty, value: 1 }];

  const metricCards = [
    { key: "scripts" as const, label: "剧本总数", value: summary?.scripts_total ?? 0, detail: "按任务创建统计", icon: FileText },
    { key: "writers" as const, label: "编剧人数", value: summary?.writers_total ?? 0, detail: "当前用户范围", icon: Users },
    { key: "preferences" as const, label: "用户偏好数", value: summary?.preferences_total ?? 0, detail: "启用中的偏好", icon: FilePenLine },
    { key: "script_duration_p95_seconds" as const, label: "单篇耗时 P95", value: durationLabel(summary?.script_duration_p95_seconds ?? 0), detail: `${summary?.completed_pipeline_count ?? 0} 个已生成审稿报告`, icon: Clock3 },
    { key: "tokens" as const, label: "Token 累计", value: compactNumber(summary?.tokens_total ?? 0), detail: `${summary?.metered_job_count ?? 0} 次有用量记录`, icon: Coins },
    { key: "cost_usd" as const, label: "费用累计", value: moneyLabel(summary?.cost_usd_total ?? 0), detail: `${summary?.costed_job_count ?? 0} 次有费用记录`, icon: WalletCards }
  ];

  if (loading && !data) return <PageLoading label="正在加载仪表板" />;

  return (
    <div className={styles.view}>
      <div className={styles.dashboardFilterBar}>
        <div className={styles.segmented} aria-label="时间范围">
          {([
            ["today", "今天"],
            ["yesterday", "昨天"],
            ["7d", "近 7 天"],
            ["30d", "近 30 天"],
            ["custom", "指定时间"]
          ] as Array<[DashboardPeriod, string]>).map(([key, label]) => (
            <button key={key} className={period === key ? styles.segmentedActive : ""} onClick={() => setPeriod(key)}>{label}</button>
          ))}
        </div>
        <div className={styles.toolbarRight}>
          {period === "custom" ? <>
            <input className={styles.dashboardDateInput} type="date" value={customRange.start} max={customRange.end} onInput={(event) => updateCustomRange("start", event.currentTarget.value)} aria-label="开始日期" />
            <span className={styles.dateSeparator}>至</span>
            <input className={styles.dashboardDateInput} type="date" value={customRange.end} min={customRange.start} onInput={(event) => updateCustomRange("end", event.currentTarget.value)} aria-label="结束日期" />
          </> : null}
          <select className={styles.dashboardScenarioFilter} value={taskType} onChange={(event) => setTaskType(event.target.value as DashboardTaskType | "")} aria-label="场景筛选">
            <option value="">全部场景</option>
            {SCENARIO_OPTIONS.map((scenario) => <option key={scenario.value} value={scenario.value}>{scenario.label}</option>)}
          </select>
          <select className={styles.dashboardUserFilter} value={operatorUserId} onChange={(event) => setOperatorUserId(event.target.value ? Number(event.target.value) : "")} aria-label="操作人筛选">
            <option value="">全部操作人</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.display_name} (@{user.username})</option>)}
          </select>
          <button className={styles.iconButton} onClick={() => void load()} disabled={loading} aria-label="刷新" title="刷新"><RefreshCcw size={16} /></button>
        </div>
      </div>

      <section className={styles.dashboardSection} aria-labelledby="dashboard-core-metrics">
        <div className={styles.dashboardSectionHeader}><h2 id="dashboard-core-metrics">核心指标</h2></div>
        <div className={styles.metricsGrid} aria-busy={loading}>
          {metricCards.map((metric) => {
            const Icon = metric.icon;
            return <button key={metric.key} className={`${styles.metric} ${styles.metricButton} ${trendMetric === metric.key ? styles.metricActive : ""}`} onClick={() => setTrendMetric(metric.key)} aria-pressed={trendMetric === metric.key}>
              <Icon /><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small>
            </button>;
          })}
        </div>
        <div className={`${styles.panel} ${styles.panelFull} ${styles.trendPanel}`}>
          <div className={styles.panelHeader}><div><span>{TREND_LABELS[trendMetric]}</span><strong>{data?.filters.trend_start_date} 至 {data?.filters.trend_end_date}</strong></div></div>
          <div className={styles.chartLarge}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data?.trend ?? []} margin={{ top: 12, right: 20, left: 4, bottom: 0 }}>
                <CartesianGrid stroke="#e4e8e4" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#68746f" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#68746f" }} axisLine={false} tickLine={false} width={50} tickFormatter={(value) => trendMetric === "cost_usd" ? `$${Number(value).toFixed(2)}` : compactNumber(Number(value))} />
                <Tooltip formatter={(value) => [trendValueLabel(trendMetric, Number(value)), TREND_LABELS[trendMetric]]} contentStyle={{ border: "1px solid #cad5ce", borderRadius: 4, fontSize: 11 }} />
                <Line type="monotone" dataKey={trendMetric} name={TREND_LABELS[trendMetric]} stroke="#176b70" strokeWidth={2.5} dot={{ r: 2, fill: "#176b70" }} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className={styles.dashboardSection} aria-labelledby="dashboard-execution">
        <div className={styles.dashboardSectionHeader}><h2 id="dashboard-execution">执行情况</h2></div>
        <div className={`${styles.panel} ${styles.panelFull} ${styles.efficiencyPanel}`}>
          <div className={styles.panelHeader}>
            <div><span>成本与效率</span><strong>{efficiencyMode === "total" ? "累计" : "P95"}</strong></div>
            <div className={styles.segmented} aria-label="统计口径">
              <button className={efficiencyMode === "total" ? styles.segmentedActive : ""} onClick={() => setEfficiencyMode("total")}>累计</button>
              <button className={efficiencyMode === "p95" ? styles.segmentedActive : ""} onClick={() => setEfficiencyMode("p95")}>P95</button>
            </div>
          </div>
          <div className={styles.stageMetricCharts}>
            <div className={styles.stageMetricChart}>
              <div className={styles.stageMetricSummary}><div><h3>Token 消耗</h3><span>{aggregateLabel}</span></div><strong>{compactNumber(efficiencyMode === "total" ? executionAggregate?.total_tokens ?? 0 : executionAggregate?.p95_tokens ?? 0)}</strong></div>
              <div className={styles.stageMetricCanvas}><ResponsiveContainer width="100%" height="100%"><BarChart data={stageMetrics} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}><CartesianGrid stroke="#e4e8e4" horizontal={false} /><XAxis type="number" tickFormatter={(value) => compactNumber(Number(value))} tick={{ fontSize: 10, fill: "#68746f" }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="name" width={68} tick={{ fontSize: 10, fill: "#52605a" }} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => [Number(value).toLocaleString("zh-CN"), efficiencyMode === "total" ? "累计 Token" : "P95 Token"]} contentStyle={{ border: "1px solid #cad5ce", borderRadius: 4, fontSize: 11 }} /><Bar dataKey={efficiencyMode === "total" ? "total_tokens" : "p95_tokens"} fill="#176b70" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>
            </div>
            <div className={styles.stageMetricChart}>
              <div className={styles.stageMetricSummary}><div><h3>费用消耗（USD）</h3><span>{aggregateLabel}</span></div><strong>{moneyLabel(efficiencyMode === "total" ? executionAggregate?.total_cost_usd ?? 0 : executionAggregate?.p95_cost_usd ?? 0)}</strong></div>
              <div className={styles.stageMetricCanvas}><ResponsiveContainer width="100%" height="100%"><BarChart data={stageMetrics} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}><CartesianGrid stroke="#e4e8e4" horizontal={false} /><XAxis type="number" tickFormatter={(value) => moneyLabel(Number(value))} tick={{ fontSize: 10, fill: "#68746f" }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="name" width={68} tick={{ fontSize: 10, fill: "#52605a" }} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => [moneyLabel(Number(value)), efficiencyMode === "total" ? "累计费用" : "P95 费用"]} contentStyle={{ border: "1px solid #cad5ce", borderRadius: 4, fontSize: 11 }} /><Bar dataKey={efficiencyMode === "total" ? "total_cost_usd" : "p95_cost_usd"} fill="#d76545" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>
            </div>
            <div className={styles.stageMetricChart}>
              <div className={styles.stageMetricSummary}><div><h3>时间消耗（秒）</h3><span>{aggregateLabel}</span></div><strong>{durationLabel(efficiencyMode === "total" ? executionAggregate?.total_duration_seconds ?? 0 : executionAggregate?.p95_duration_seconds ?? 0)}</strong></div>
              <div className={styles.stageMetricCanvas}><ResponsiveContainer width="100%" height="100%"><BarChart data={stageMetrics} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}><CartesianGrid stroke="#e4e8e4" horizontal={false} /><XAxis type="number" tickFormatter={(value) => durationLabel(Number(value))} tick={{ fontSize: 10, fill: "#68746f" }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="name" width={68} tick={{ fontSize: 10, fill: "#52605a" }} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => [durationLabel(Number(value)), efficiencyMode === "total" ? "累计耗时" : "P95 耗时"]} contentStyle={{ border: "1px solid #cad5ce", borderRadius: 4, fontSize: 11 }} /><Bar dataKey={efficiencyMode === "total" ? "total_duration_seconds" : "p95_duration_seconds"} fill="#d0a83c" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>
            </div>
          </div>
        </div>

        <div className={styles.executionGrid}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}><div><span>项目分布</span><strong>阶段停留</strong></div></div>
            <div className={styles.funnelCanvas}>
              <ResponsiveContainer width="100%" height="100%"><FunnelChart><Tooltip formatter={(value) => [Number(value), "剧本数"]} contentStyle={{ border: "1px solid #cad5ce", borderRadius: 4, fontSize: 11 }} /><Funnel dataKey="value" data={funnelData} isAnimationActive={false}>{funnelData.map((item, index) => <Cell key={item.key} fill={COLORS[index % COLORS.length]} />)}<LabelList dataKey="name" position="right" fill="#52605a" fontSize={10} /></Funnel></FunnelChart></ResponsiveContainer>
            </div>
          </div>
          <div className={`${styles.panel} ${styles.operationPanel}`}>
            <div className={styles.panelHeader}><div><span>阶段操作占比</span><strong>{data?.execution.operations.total ?? 0}</strong></div></div>
            <div className={styles.operationPieGrid}>
              <div className={styles.operationPie}><span className={styles.operationPieCaption}>各阶段</span><div className={styles.operationPieCanvas}><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={parentPieData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={68} paddingAngle={2} onClick={(_item, index) => { const stage = parentPieData[index]?.key; if (stage && stage !== "empty") setSelectedOperationStage(stage); }}>{parentPieData.map((item, index) => <Cell key={item.key} fill={item.key === "empty" ? OPERATION_COLORS.empty : COLORS[index % COLORS.length]} fillOpacity={item.key === activeOperationStage ? 1 : 0.46} cursor={item.key === "empty" ? "default" : "pointer"} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer></div></div>
              <div className={styles.operationPie}><span className={styles.operationPieCaption}>{STAGE_LABELS[activeOperationStage] ?? "当前阶段"}</span><div className={styles.operationPieCanvas}><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={childPieData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={68} paddingAngle={2}>{childPieData.map((item) => <Cell key={item.key} fill={OPERATION_COLORS[item.key]} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer></div></div>
            </div>
            <div className={styles.operationLegend}>{operationStageData.map((item, index) => <button key={item.key} className={activeOperationStage === item.key ? styles.operationStageActive : ""} onClick={() => setSelectedOperationStage(item.key)} aria-pressed={activeOperationStage === item.key}><i style={{ background: COLORS[index % COLORS.length] }} /><span>{item.name}</span><b>{item.value}</b></button>)}</div>
          </div>
        </div>
      </section>

      <section className={styles.dashboardSection} aria-labelledby="dashboard-people">
        <div className={styles.dashboardSectionHeader}><h2 id="dashboard-people">人员情况</h2></div>
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.dashboardPeopleTable}`}>
            <thead><tr><th>姓名</th><th>参与任务数</th><th>操作次数</th><th>Token 消耗</th><th>费用累计</th></tr></thead>
            <tbody>{(data?.people ?? []).map((person) => <tr key={person.id}><td><div className={styles.personCell}><span>{person.name.slice(0, 1)}</span><div><strong>{person.name}</strong><small>@{person.username}</small></div></div></td><td>{person.task_count}</td><td>{person.operation_count}</td><td className={styles.mono}>{person.tokens.toLocaleString("zh-CN")}</td><td className={styles.mono}>{moneyLabel(person.cost_usd)}</td></tr>)}{(data?.people.length ?? 0) === 0 ? <tr><td className={styles.emptyCell} colSpan={5}>暂无可展示的人员数据</td></tr> : null}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
