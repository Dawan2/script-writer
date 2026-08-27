"use client";

import { BadgeCheck, Coins, Gauge, History, PackageCheck, Plus, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adjustAdminCredits, getAdminCredits, updateAdminCreditPlan, updateAdminCreditPrices } from "@/lib/admin-api";
import type { AdminCreditAccount, AdminCreditsPayload } from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import { PageLoading } from "@/components/ui/page-loading";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

const transactionLabels: Record<string, string> = {
  manual_adjustment: "手工调整",
  plan_grant: "套餐发放",
  plan_expire: "套餐额度清零",
  reserve: "任务预留",
  release: "额度退还",
};

function transactionLabel(kind: string, status: string | null, delta: number, stageLabel?: string) {
  if (kind === "manual_adjustment") return delta > 0 ? "临时补充" : "临时扣减";
  if (kind === "reserve" && status === "settled") return stageLabel ? `${stageLabel} · 已完成` : "已完成创作";
  if (kind === "reserve" && status === "released") return stageLabel ? `${stageLabel} · 已退还` : "已退还预留";
  if (kind === "reserve" && stageLabel) return `${stageLabel} · 已预留`;
  if (kind === "release" && stageLabel) return `${stageLabel} · 额度退还`;
  return transactionLabels[kind] ?? kind;
}

function formatCreditTime(value: string | null | undefined) {
  return formatDateTime(value);
}

function planTermLabel(account: AdminCreditAccount) {
  const term = account.plan_term;
  if (term.status === "unlimited") return "长期有效";
  if (term.status === "expired") return `已于 ${term.expires_on?.replaceAll("-", "/") ?? "--"} 到期`;
  return `有效至 ${term.expires_on?.replaceAll("-", "/") ?? "--"} · 余 ${term.days_remaining ?? 0} 天`;
}

export function AdminCreditsView({ onNotice }: { onNotice: (message: string) => void }) {
  const [payload, setPayload] = useState<AdminCreditsPayload | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<AdminCreditAccount | null>(null);
  const [planTarget, setPlanTarget] = useState<AdminCreditAccount | null>(null);
  const [planCode, setPlanCode] = useState<"free" | "basic" | "advanced">("free");
  const [delta, setDelta] = useState("10");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getAdminCredits();
      setPayload(next);
      setPrices(Object.fromEntries(next.prices.map((item) => [item.stage, String(item.credits)])));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "额度信息加载失败");
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => { void load(); }, [load]);

  const totalBalance = useMemo(
    () => payload?.accounts.reduce((sum, account) => sum + (account.balance ?? 0), 0) ?? 0,
    [payload],
  );
  const stageLabels = useMemo(
    () => new Map(payload?.prices.map((item) => [item.stage, item.label]) ?? []),
    [payload?.prices],
  );

  function openAdjust(account: AdminCreditAccount) {
    setAdjustTarget(account);
    setDelta("10");
    setNote("");
  }

  function openPlan(account: AdminCreditAccount) {
    setPlanTarget(account);
    setPlanCode(account.plan.code);
  }

  async function savePrices() {
    if (!payload || busy) return;
    const next = Object.fromEntries(payload.prices.map((item) => [item.stage, Number(prices[item.stage])])) as Record<string, number>;
    if (Object.values(next).some((value) => !Number.isInteger(value) || value < 1)) {
      onNotice("每项额度必须是大于 0 的整数");
      return;
    }
    setBusy(true);
    try {
      const result = await updateAdminCreditPrices(next);
      setPayload((current) => current ? { ...current, prices: result.prices } : current);
      setPrices(Object.fromEntries(result.prices.map((item) => [item.stage, String(item.credits)])));
      onNotice("阶段额度已保存");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "阶段额度保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveAdjustment() {
    const amount = Number(delta);
    if (!adjustTarget || busy || !Number.isInteger(amount) || amount === 0) return;
    setBusy(true);
    try {
      const result = await adjustAdminCredits(adjustTarget.user_id, amount, note.trim());
      setPayload((current) => current ? {
        ...current,
        accounts: current.accounts.map((account) => account.user_id === result.account.user_id
          ? { ...account, managed: true, balance: result.account.balance }
          : account),
      } : current);
      setAdjustTarget(null);
      onNotice(amount > 0 ? "创作额度已发放" : "创作额度已扣减");
      await load();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "额度调整失败");
    } finally {
      setBusy(false);
    }
  }

  async function savePlan() {
    if (!planTarget || busy) return;
    setBusy(true);
    try {
      await updateAdminCreditPlan(planTarget.user_id, planCode);
      setPlanTarget(null);
      onNotice("用户套餐已更新，额度已按套餐规则处理");
      await load();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "用户套餐保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !payload) return <PageLoading label="正在加载创作额度" />;
  if (!payload) return null;

  return (
    <div className={styles.view}>
      <div className={styles.summaryStrip}>
        <span><Coins size={16} /><b>{totalBalance}</b>可用创作额度</span>
        <span><PackageCheck size={16} /><b>{payload.accounts.length}</b>个套餐账号</span>
        <span><History size={16} /><b>{payload.transactions.length}</b>条最近记录</span>
      </div>

      <section className={styles.creditPlanSection}>
        <div className={styles.creditSectionHeader}>
          <div><h2>套餐规则</h2><p>体验套餐首次开通即发放一次；初级和高级套餐开通当日立即发放，之后每日零点先清零未使用的当天套餐额度，再发放当天额度，连续 30 天后到期。套餐额度按套餐标准发放，不会随功能额度调整自动变化。</p></div>
        </div>
        <div className={styles.creditPlanGrid}>
          {payload.plans.map((plan) => (
            <article key={plan.code} className={styles.creditPlanCard} data-plan={plan.code}>
              <span>{plan.label}</span>
              <strong>{plan.allowance_label}</strong>
              <p>{plan.description}</p>
              <div className={styles.creditPlanLimit}><Gauge size={14} />最多同时运行 {plan.max_concurrent_jobs} 个 AI 任务</div>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.creditSettings}>
        <div className={styles.creditSectionHeader}>
          <div><h2>阶段额度</h2><p>用户每次发起创作时，按对应阶段消耗额度。</p></div>
          <button className={styles.primaryButton} disabled={busy} onClick={() => void savePrices()}><Save size={16} />保存额度规则</button>
        </div>
        <div className={styles.creditPriceGrid}>
          {payload.prices.map((item) => (
            <label key={item.stage} className={styles.creditPriceItem}>
              <span>{item.label}</span>
              <div><input inputMode="numeric" value={prices[item.stage] ?? ""} onChange={(event) => setPrices((current) => ({ ...current, [item.stage]: event.target.value }))} /><small>额度</small></div>
            </label>
          ))}
        </div>
      </section>

      <section className={styles.creditSettings}>
        <div className={styles.creditSectionHeader}><div><h2>用户套餐与额度</h2><p>保存套餐后，系统会按规则自动发放额度；临时补充不会改变套餐或有效期。</p></div></div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>用户</th><th>当前套餐</th><th>运行任务</th><th>有效期与额度</th><th>可用额度</th><th>最近更新</th><th aria-label="操作" /></tr></thead>
            <tbody>{payload.accounts.map((account) => (
              <tr key={account.user_id}>
                <td><strong>{account.display_name}</strong><small className={styles.cellSub}>@{account.username}</small></td>
                <td><span className={styles.creditPlanBadge}>{account.plan.label}</span><small className={styles.cellSub}>{account.plan.allowance_label}</small></td>
                <td><strong className={account.concurrency.reached ? styles.concurrencyReached : styles.concurrencyAvailable}>{account.concurrency.active} / {account.concurrency.limit}</strong><small className={styles.cellSub}>{account.concurrency.reached ? "运行名额已满" : `还可启动 ${account.concurrency.available} 个`}</small></td>
                <td><strong className={account.plan_term.status === "expired" ? styles.concurrencyReached : undefined}>{planTermLabel(account)}</strong><small className={styles.cellSub}>{account.plan_term.status === "expired" ? "不再自动发放套餐额度" : account.plan_grant.granted ? <span className={styles.creditGrantDone}><BadgeCheck size={14} />{account.plan.cadence === "once" ? `已发放 ${account.plan_grant.granted_credits} 额度` : `今日已发放 ${account.plan_grant.granted_credits} 额度`}</span> : "等待本次套餐额度发放"}</small></td>
                <td><strong className={styles.creditBalance}>{account.balance ?? 0}</strong><small className={styles.cellSub}>体验 {account.balances?.experience ?? 0} · 补充 {account.balances?.supplemental ?? 0} · 今日套餐 {account.balances?.plan ?? 0}</small></td>
                <td><time>{formatCreditTime(account.updated_at)}</time></td>
                <td><div className={styles.rowActions}>
                  <button className={styles.iconButton} onClick={() => openPlan(account)} aria-label={`设置 ${account.display_name} 的套餐`} title="设置套餐"><PackageCheck size={15} /></button>
                  <button className={styles.iconButton} onClick={() => openAdjust(account)} aria-label={`临时调整 ${account.display_name} 的创作额度`} title="临时补充或扣减额度"><Plus size={15} /></button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className={styles.creditSettings}>
        <div className={styles.creditSectionHeader}><div><h2>额度记录</h2><p>展示最近的发放、消耗与退还记录。</p></div></div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>时间</th><th>用户</th><th>类型</th><th>变动</th><th>余额</th><th>说明</th></tr></thead>
            <tbody>{payload.transactions.map((item) => (
              <tr key={item.id}>
                <td><time>{formatCreditTime(item.created_at)}</time></td>
                <td>{item.display_name}</td>
                <td>{transactionLabel(item.kind, item.job_credit_status, item.delta, item.stage ? stageLabels.get(item.stage) : undefined)}</td>
                <td className={item.delta > 0 ? styles.creditIncrease : styles.creditDecrease}>{item.delta > 0 ? `+${item.delta}` : item.delta}</td>
                <td>{item.balance_after}</td>
                <td><span className={styles.cellSub}>{item.note || item.project_name || "--"}</span></td>
              </tr>
            ))}{!payload.transactions.length ? <tr><td colSpan={6} className={styles.emptyCell}>暂无额度记录</td></tr> : null}</tbody>
          </table>
        </div>
      </section>

      {adjustTarget ? (
        <AdminDialog title={`临时调整 ${adjustTarget.display_name} 的额度`} confirmLabel="确认调整" busy={busy} confirmDisabled={!Number.isInteger(Number(delta)) || Number(delta) === 0} onCancel={() => setAdjustTarget(null)} onConfirm={() => void saveAdjustment()}>
          <div className={styles.formGrid}>
            <label><span>当前可用</span><input value={String(adjustTarget.balance ?? 0)} disabled /></label>
            <label><span>调整额度</span><input type="number" step="1" value={delta} onChange={(event) => setDelta(event.target.value)} placeholder="正数发放，负数扣减" /></label>
            <label className={styles.fullField}><span>调整原因</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：活动赠送、服务补偿或误发回收" /></label>
            <p className={`${styles.formHint} ${styles.fullField}`}>正数会立即增加可用额度，负数会立即扣减；余额不能低于 0。所有调整都会进入额度记录和审计日志。</p>
          </div>
        </AdminDialog>
      ) : null}

      {planTarget ? (
        <AdminDialog title={`设置 ${planTarget.display_name} 的套餐`} confirmLabel="保存套餐" busy={busy} onCancel={() => setPlanTarget(null)} onConfirm={() => void savePlan()}>
          <div className={styles.formGrid}>
            <label className={styles.fullField}><span>用户套餐</span><select value={planCode} onChange={(event) => setPlanCode(event.target.value as typeof planCode)}>{payload.plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.label} · {plan.allowance_label}</option>)}</select></label>
            <div className={`${styles.planPreview} ${styles.fullField}`}>
              <PackageCheck size={18} />
              <div><strong>{payload.plans.find((plan) => plan.code === planCode)?.label}</strong><p>{payload.plans.find((plan) => plan.code === planCode)?.description}</p><small>最多同时运行 {payload.plans.find((plan) => plan.code === planCode)?.max_concurrent_jobs} 个 AI 任务</small></div>
            </div>
            <p className={`${styles.formHint} ${styles.fullField}`}>{planCode === "free" ? "保存体验套餐后，如用户尚未领取体验额度，系统会立即发放一次，额度长期有效。" : "保存后立即发放今天的套餐额度，并从今天起连续 30 天在每日零点先清零未使用的当天套餐额度，再发放当天额度。相同套餐在有效期内不会重复发放；到期后再次保存会开启新的 30 天有效期。"}</p>
          </div>
        </AdminDialog>
      ) : null}
    </div>
  );
}
