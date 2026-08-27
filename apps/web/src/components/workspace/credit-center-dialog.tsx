"use client";

import { BadgeCheck, CircleHelp, Coins, Gauge, History, PackageCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatDateTime } from "@/lib/date-time";
import type { CreditSummary, CreditTransaction } from "@/lib/types";

function transactionLabel(item: CreditTransaction, stageLabel?: string) {
  if (item.kind === "plan_grant") return "套餐额度";
  if (item.kind === "plan_expire") return "当天套餐额度清零";
  if (item.kind === "manual_adjustment") return item.delta > 0 ? "临时补充" : "临时扣减";
  if (item.kind === "release") return stageLabel ? `${stageLabel} · 额度退还` : "任务退还";
  if (item.kind === "reserve" && item.job_credit_status === "settled") return stageLabel ? `${stageLabel} · 创作完成` : "创作完成";
  if (item.kind === "reserve" && item.job_credit_status === "released") return stageLabel ? `${stageLabel} · 已退还` : "任务预留（已退还）";
  if (item.kind === "reserve") return stageLabel ? `${stageLabel} · 处理中` : "任务预留";
  return item.note || "额度变动";
}

function formatCreditTime(value: string) {
  return formatDateTime(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function planTermLabel(summary: CreditSummary) {
  const term = summary.plan_term;
  if (term.status === "unlimited") return "体验额度长期有效";
  if (term.status === "expired") return `${summary.plan.label}已于 ${term.expires_on?.replaceAll("-", "/") ?? "--"} 到期`;
  return `有效至 ${term.expires_on?.replaceAll("-", "/") ?? "--"} · 剩余 ${term.days_remaining ?? 0} 天`;
}

export function CreditCenterDialog({ summary, onClose }: { summary: CreditSummary; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const balance = summary.balance ?? 0;
  const balances = summary.balances ?? { experience: 0, supplemental: 0, plan: 0 };
  const stageLabels = new Map(summary.prices.map((item) => [item.stage, item.label]));
  const planGrantText = summary.plan_term.status === "expired"
    ? "套餐已到期，今日额度不再发放"
    : summary.plan_grant?.granted
    ? summary.plan.cadence === "once" ? `体验额度已发放 ${summary.plan_grant.granted_credits} 额度` : `今日套餐额度已发放 ${summary.plan_grant.granted_credits} 额度`
    : summary.plan.cadence === "once" ? "体验额度待发放" : "今日套餐额度待发放";

  return (
    <div className="credit-center-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="credit-center" role="dialog" aria-modal="true" aria-labelledby="credit-center-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="credit-center-header">
          <div>
            <span className="credit-center-icon"><Coins size={20} /></span>
            <div><h2 id="credit-center-title">我的创作额度</h2><p>每次创作前清楚知道花费，额度变化全程可查。</p></div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭创作额度" title="关闭"><X size={18} /></button>
        </header>

        <div className="credit-center-overview">
          <div className="credit-balance-card">
            <span>当前可用</span>
            <strong>{balance}</strong>
            <small>创作额度</small>
            <div className="credit-balance-sources">
              <span>体验 {balances.experience}</span>
              {balances.supplemental > 0 ? <span>补充 {balances.supplemental}</span> : null}
              <span>今日套餐 {balances.plan}</span>
            </div>
          </div>
          <div className="credit-plan-card">
            <span><PackageCheck size={15} />当前套餐</span>
            <strong>{summary.plan.label}</strong>
            <p>{summary.plan.allowance_label} · {summary.plan.description}</p>
            <small className={`credit-plan-term ${summary.plan_term.status}`}>{planTermLabel(summary)}</small>
            <div className={`credit-concurrency-status${summary.concurrency.reached ? " reached" : ""}`}>
              <div><Gauge size={14} /><span>同时运行</span><strong>{summary.concurrency.active} / {summary.concurrency.limit}</strong></div>
              <small>{summary.concurrency.reached
                ? "当前运行名额已满，任务完成或取消后即可继续。"
                : `还可启动 ${summary.concurrency.available} 个 AI 任务。`}</small>
            </div>
            <small className={summary.plan_grant?.granted ? "granted" : "pending"}>
              {summary.plan_grant?.granted ? <BadgeCheck size={13} /> : <CircleHelp size={13} />}{planGrantText}
            </small>
          </div>
        </div>

        <div className="credit-settlement-note">
          <CircleHelp size={16} />
          <p><strong>额度如何结算？</strong>任务开始时先预留，优先使用体验额度；成功后完成扣除，执行失败或主动取消时会按原额度来源退回。跨日的套餐额度按每日规则到期。</p>
        </div>

        <section className="credit-center-section">
          <div className="credit-center-section-title"><div><h3>功能额度</h3><p>对话调整、重新生成和失败重试，均按所处理的文件阶段计费。</p></div></div>
          <div className="credit-price-list">
            {summary.prices.map((item) => <div key={item.stage}><span>{item.label}</span><strong>{item.credits}</strong><small>额度 / 次</small></div>)}
          </div>
        </section>

        <section className="credit-center-section credit-history-section">
          <div className="credit-center-section-title"><div><h3>最近明细</h3><p>展示最近的套餐发放、临时补充、创作消耗和失败退还。</p></div><History size={16} /></div>
          <div className="credit-history-list">
            {summary.transactions.length ? summary.transactions.map((item) => (
              <div className="credit-history-row" key={item.id}>
                <time>{formatCreditTime(item.created_at)}</time>
                <div><strong>{transactionLabel(item, item.stage ? stageLabels.get(item.stage) : undefined)}</strong><small>{item.project_name || item.note || "账户额度"}</small></div>
                <span className={item.delta > 0 ? "increase" : "decrease"}>{item.delta > 0 ? `+${item.delta}` : item.delta}</span>
                <small>余额 {item.balance_after}</small>
              </div>
            )) : <div className="credit-history-empty"><History size={22} /><span>暂无额度记录</span><small>套餐额度发放或开始创作后，明细会显示在这里。</small></div>}
          </div>
        </section>

        <footer className="credit-center-footer">体验额度和临时补充长期有效；当天套餐额度会在每日零点清零后重新发放。初级和高级套餐连续发放 30 天后到期。</footer>
      </section>
    </div>
  );
}
