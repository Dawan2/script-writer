"use client";

import { CheckCircle2, CloudUpload, ExternalLink, FileCheck2, Link2, LoaderCircle, RefreshCcw, Save, Search, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  completeAdminScriptSyncAuthorization,
  enqueueAdminScriptSyncJobs,
  getActiveAdminScriptSyncJobs,
  getAdminScriptSyncConfig,
  getAdminScriptSyncScripts,
  ignoreAdminScriptSync,
  saveAdminScriptSyncConfig,
  startAdminScriptSyncAuthorization,
  testAdminScriptSyncTarget
} from "@/lib/admin-api";
import type { ScriptSyncConfig, ScriptSyncField, ScriptSyncMapping, ScriptSyncScript, ScriptSyncStatus, ScriptSyncTargetTest } from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import { PageLoading } from "@/components/ui/page-loading";
import styles from "./admin.module.css";

type SyncTab = "scripts" | "configuration";

type MappingDraft = Pick<ScriptSyncMapping, "source_key" | "target_field_id" | "auto_create">;

type SyncTarget = Pick<ScriptSyncTargetTest, "table" | "fields">;

const SCENARIO_LABELS = { rewrite: "剧本改写", novel: "小说改编", replicate: "爆款复刻" } as const;

const STATUS_LABELS: Record<ScriptSyncStatus, string> = {
  pending: "待同步",
  synced: "已同步",
  needs_update: "待更新",
  failed: "同步失败",
  ignored: "已忽略"
};

const FIELD_KIND_LABELS = {
  text: "文本",
  number: "数字",
  datetime: "日期时间",
  select: "单选",
  attachment: "附件"
} as const;

function cloneMappings(mappings: Array<Pick<ScriptSyncMapping, "source_key" | "target_field_id" | "auto_create">>) {
  return mappings.map((mapping) => ({
    source_key: mapping.source_key,
    target_field_id: mapping.target_field_id,
    auto_create: mapping.auto_create
  }));
}

function readableDate(value: string | null) {
  return formatDateTime(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function compatibleField(kind: ScriptSyncMapping["kind"], field: ScriptSyncField) {
  if (!field.writable) return false;
  if (kind === "attachment") return field.type === "attachment";
  if (kind === "select") return field.type === "select" && !field.multiple;
  return field.type !== "attachment";
}

function mappingFor(mappings: MappingDraft[], sourceKey: string) {
  return mappings.find((mapping) => mapping.source_key === sourceKey) ?? {
    source_key: sourceKey,
    target_field_id: null,
    auto_create: false
  };
}

export function AdminScriptSyncView({ onNotice }: { onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<SyncTab>("scripts");
  const [scripts, setScripts] = useState<ScriptSyncScript[]>([]);
  const [config, setConfig] = useState<ScriptSyncConfig | null>(null);
  const [scriptLoading, setScriptLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [syncingIds, setSyncingIds] = useState<Set<number>>(new Set());
  const [ignoringIds, setIgnoringIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [scenario, setScenario] = useState<"" | "rewrite" | "novel" | "replicate">("");
  const [operator, setOperator] = useState("");
  const [statuses, setStatuses] = useState<ScriptSyncStatus[]>([]);
  const [filterOptions, setFilterOptions] = useState<{ scenarios: Array<"rewrite" | "novel" | "replicate">; operators: string[] }>({ scenarios: ["rewrite", "novel", "replicate"], operators: [] });
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState<SyncTarget | null>(null);
  const [mappings, setMappings] = useState<MappingDraft[]>([]);
  const [testResult, setTestResult] = useState<ScriptSyncTargetTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const next = await getAdminScriptSyncConfig();
      setConfig(next);
      setUrl(next.url);
      if (next.table && next.fields.length) {
        setTarget({ table: next.table, fields: next.fields });
        setMappings(cloneMappings(next.mappings));
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步配置加载失败");
    } finally {
      setConfigLoading(false);
    }
  }, [onNotice]);

  const loadScripts = useCallback(async () => {
    setScriptLoading(true);
    try {
      const result = await getAdminScriptSyncScripts({ query, scenario: scenario || undefined, operator: operator || undefined, statuses });
      setScripts(result.scripts);
      setFilterOptions({ scenarios: result.filters.scenarios, operators: result.filters.operators });
      setSelectedIds(new Set());
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "剧本列表加载失败");
    } finally {
      setScriptLoading(false);
    }
  }, [onNotice, operator, query, scenario, statuses]);

  const loadActiveSyncJobs = useCallback(async () => {
    try {
      const result = await getActiveAdminScriptSyncJobs();
      const activeIds = new Set(result.jobs.map((job) => job.project_id));
      setSyncingIds(activeIds);
      return activeIds;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步任务状态加载失败");
      return new Set<number>();
    }
  }, [onNotice]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  useEffect(() => { void loadActiveSyncJobs(); }, [loadActiveSyncJobs]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadScripts(), 220);
    return () => window.clearTimeout(timer);
  }, [loadScripts]);

  useEffect(() => {
    if (!syncingIds.size) return;
    const poll = async () => {
      const activeIds = await loadActiveSyncJobs();
      if (!activeIds.size) await loadScripts();
    };
    const timer = window.setInterval(() => { void poll(); }, 2500);
    return () => window.clearInterval(timer);
  }, [loadActiveSyncJobs, loadScripts, syncingIds.size]);

  const selectableScripts = useMemo(() => scripts.filter((script) => script.sync_status !== "ignored"), [scripts]);
  const selectedScripts = useMemo(
    () => selectableScripts.filter((script) => selectedIds.has(script.project_id)),
    [selectableScripts, selectedIds]
  );
  const allVisibleSelected = selectableScripts.length > 0 && selectedScripts.length === selectableScripts.length;
  const someVisibleSelected = selectedScripts.length > 0 && !allVisibleSelected;
  const statusSummary = statuses.length ? statuses.map((status) => STATUS_LABELS[status]).join("、") : "全部状态";
  const hasScriptNameMapping = Boolean(mappingFor(mappings, "script_name").target_field_id || mappingFor(mappings, "script_name").auto_create);
  const canSave = Boolean(target && url.trim() && hasScriptNameMapping);

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
    setSelectedIds(allVisibleSelected ? new Set() : new Set(selectableScripts.map((script) => script.project_id)));
  }

  function toggleStatus(status: ScriptSyncStatus) {
    setStatuses((current) => current.includes(status) ? current.filter((item) => item !== status) : [...current, status]);
  }

  async function syncSelected() {
    if (!selectedScripts.length || syncingIds.size || ignoringIds.size) return;
    if (!config?.is_ready) {
      setTab("configuration");
      onNotice("请先完成同步配置并保存字段映射");
      return;
    }

    try {
      const result = await enqueueAdminScriptSyncJobs(selectedScripts.map((script) => script.project_id));
      setSyncingIds(new Set(result.jobs.filter((job) => job.status === "queued" || job.status === "running").map((job) => job.project_id)));
      setSelectedIds(new Set());
      await loadScripts();
      onNotice(`已提交 ${selectedScripts.length} 个剧本，正在后台同步`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步提交失败");
    }
  }

  async function syncScript(script: ScriptSyncScript) {
    if (script.sync_status === "ignored" || syncingIds.size || ignoringIds.size) return;
    if (!config?.is_ready) {
      setTab("configuration");
      onNotice("请先完成同步配置并保存字段映射");
      return;
    }

    try {
      const result = await enqueueAdminScriptSyncJobs([script.project_id]);
      setSyncingIds((current) => new Set([
        ...current,
        ...result.jobs.filter((job) => job.status === "queued" || job.status === "running").map((job) => job.project_id)
      ]));
      onNotice(`已提交「${script.script_name}」，正在后台同步`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步提交失败");
    }
  }

  async function ignoreScript(script: ScriptSyncScript) {
    if (script.sync_status === "ignored" || syncingIds.size || ignoringIds.size) return;

    setIgnoringIds(new Set([script.project_id]));
    try {
      await ignoreAdminScriptSync(script.project_id);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(script.project_id);
        return next;
      });
      onNotice(`已忽略「${script.script_name}」`);
      await loadScripts();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "忽略未完成");
    } finally {
      setIgnoringIds(new Set());
    }
  }

  function applyTestResult(result: ScriptSyncTargetTest) {
    setTestResult(result);
    if (!result.authorized || !result.table) {
      setTarget(null);
      setMappings([]);
      return;
    }
    setTarget({ table: result.table, fields: result.fields });
    setMappings(cloneMappings(result.mappings));
  }

  async function testTarget() {
    if (!url.trim()) {
      onNotice("请先填写飞书多维表格链接");
      return;
    }
    setTesting(true);
    try {
      applyTestResult(await testAdminScriptSyncTarget(url.trim()));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "链接测试失败");
    } finally {
      setTesting(false);
    }
  }

  async function beginAuthorization() {
    setAuthorizing(true);
    try {
      const result = await startAdminScriptSyncAuthorization();
      setTestResult((current) => current ? { ...current, authorization_url: result.authorization_url } : {
        reachable: true,
        authorized: false,
        message: "需要完成飞书授权后才能读取字段。",
        authorization_url: result.authorization_url,
        table: null,
        fields: [],
        mappings: []
      });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "暂时无法发起飞书授权");
    } finally {
      setAuthorizing(false);
    }
  }

  async function finishAuthorization() {
    setAuthorizing(true);
    try {
      await completeAdminScriptSyncAuthorization();
      onNotice("飞书授权已完成，正在重新读取字段");
      await testTarget();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "尚未检测到授权完成");
    } finally {
      setAuthorizing(false);
    }
  }

  function updateMapping(sourceKey: string, patch: Partial<MappingDraft>) {
    setMappings((current) => {
      const existing = mappingFor(current, sourceKey);
      const next = current.filter((mapping) => mapping.source_key !== sourceKey);
      return [...next, { ...existing, ...patch }];
    });
  }

  async function saveConfiguration() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const next = await saveAdminScriptSyncConfig({ url: url.trim(), mappings });
      setConfig(next);
      setUrl(next.url);
      if (next.table) setTarget({ table: next.table, fields: next.fields });
      setMappings(cloneMappings(next.mappings));
      setTestResult((current) => current ? { ...current, message: "同步配置已保存。" } : current);
      onNotice("同步配置已保存");
      await loadScripts();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步配置保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (configLoading && scriptLoading && !config) return <PageLoading label="正在加载剧本同步" />;

  return (
    <div className={`${styles.view} ${styles.scriptSyncView}`}>
      <div className={styles.scriptSyncTabs} role="tablist" aria-label="剧本同步功能">
        <button type="button" role="tab" aria-selected={tab === "scripts"} className={tab === "scripts" ? styles.scriptSyncTabActive : ""} onClick={() => setTab("scripts")}>
          <CloudUpload size={16} />剧本同步
        </button>
        <button type="button" role="tab" aria-selected={tab === "configuration"} className={tab === "configuration" ? styles.scriptSyncTabActive : ""} onClick={() => setTab("configuration")}>
          <Settings2 size={16} />同步配置
        </button>
      </div>

      {tab === "scripts" ? <section className={styles.scriptSyncContent} aria-busy={scriptLoading}>
        <div className={styles.viewToolbar}>
          <div className={styles.filterRow}>
            <div className={styles.searchBox}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索剧本名称" aria-label="按剧本名称搜索" /></div>
            <select value={scenario} onChange={(event) => setScenario(event.target.value as "" | "rewrite" | "novel" | "replicate")} aria-label="按场景筛选">
              <option value="">全部场景</option>
              {filterOptions.scenarios.map((item) => <option key={item} value={item}>{SCENARIO_LABELS[item]}</option>)}
            </select>
            <select value={operator} onChange={(event) => setOperator(event.target.value)} aria-label="按操作人筛选">
              <option value="">全部操作人</option>
              {filterOptions.operators.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <details className={styles.syncStatusMenu}>
              <summary>{statusSummary}</summary>
              <div>
                <label><input type="checkbox" checked={!statuses.length} onChange={() => setStatuses([])} />全部</label>
                {(Object.keys(STATUS_LABELS) as ScriptSyncStatus[]).map((item) => <label key={item}><input type="checkbox" checked={statuses.includes(item)} onChange={() => toggleStatus(item)} />{STATUS_LABELS[item]}</label>)}
              </div>
            </details>
          </div>
          <div className={styles.toolbarRight}>
            {selectedScripts.length ? <span className={styles.selectionCount}>已选 {selectedScripts.length} 个</span> : null}
            <button className={styles.iconButton} type="button" onClick={() => void loadScripts()} disabled={scriptLoading || syncingIds.size > 0 || ignoringIds.size > 0} aria-label="刷新剧本列表" title="刷新"><RefreshCcw size={15} /></button>
            <button className={styles.primaryButton} type="button" disabled={!selectedScripts.length || syncingIds.size > 0 || ignoringIds.size > 0} title={config?.is_ready ? "同步所选剧本" : "请先完成同步配置"} onClick={() => void syncSelected()}>
              {syncingIds.size ? <LoaderCircle className={styles.syncSpinner} size={16} /> : <CloudUpload size={16} />} {syncingIds.size ? "正在同步" : "同步"}
            </button>
          </div>
        </div>

        <div className={styles.scriptSyncScope}><FileCheck2 size={15} />仅显示已完成审稿报告的剧本改写、小说改编和爆款复刻任务</div>
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.scriptSyncTable}`}>
            <thead><tr><th className={styles.selectionColumn}><input ref={selectAllRef} type="checkbox" aria-label="全选当前剧本" checked={allVisibleSelected} disabled={!selectableScripts.length || syncingIds.size > 0 || ignoringIds.size > 0} onChange={toggleAllVisible} /></th><th>剧本名称</th><th>场景</th><th>创建人</th><th>最后修改人</th><th>最后修改时间</th><th>同步状态</th><th>同步时间</th><th>操作</th></tr></thead>
            <tbody>
              {scripts.map((script) => <tr key={script.project_id}>
                <td className={styles.selectionColumn}><input type="checkbox" aria-label={`选择 ${script.script_name}`} checked={selectedIds.has(script.project_id)} disabled={script.sync_status === "ignored" || syncingIds.has(script.project_id) || ignoringIds.has(script.project_id)} onChange={() => toggleSelected(script.project_id)} /></td>
                <td><a className={styles.scriptSyncName} href={`/workspace?project=${script.project_id}`} target="_blank" rel="noreferrer">{script.script_name}<ExternalLink size={14} /></a></td>
                <td>{SCENARIO_LABELS[script.scenario]}</td>
                <td>{script.creator}</td>
                <td>{script.last_modifier}</td>
                <td><time>{readableDate(script.last_modified_at)}</time></td>
                <td><span className={`${styles.badge} ${styles[`sync_${script.sync_status}`]}`}>{syncingIds.has(script.project_id) ? "同步中" : STATUS_LABELS[script.sync_status]}</span>{script.sync_error ? <small className={styles.errorMessage} title={script.sync_error}>{script.sync_error}</small> : null}</td>
                <td><time>{readableDate(script.sync_time)}</time></td>
                <td><div className={styles.scriptSyncRowActions}>
                  <button className={`${styles.scriptSyncTextButton} ${styles.scriptSyncIgnoreButton}`} type="button" disabled={script.sync_status === "ignored" || syncingIds.size > 0 || ignoringIds.size > 0} title={script.sync_status === "ignored" ? "已忽略的剧本不会同步" : "忽略该剧本"} onClick={() => void ignoreScript(script)}>{ignoringIds.has(script.project_id) ? "正在忽略" : "忽略"}</button>
                  <button className={styles.scriptSyncTextButton} type="button" disabled={script.sync_status === "ignored" || syncingIds.size > 0 || ignoringIds.size > 0} title={script.sync_status === "ignored" ? "已忽略的剧本不会同步" : "同步该剧本"} onClick={() => void syncScript(script)}>{syncingIds.has(script.project_id) ? "同步中" : "同步"}</button>
                </div></td>
              </tr>)}
              {!scriptLoading && !scripts.length ? <tr><td colSpan={9} className={styles.emptyCell}>暂无符合条件的剧本</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section> : null}

      {tab === "configuration" ? <section className={styles.scriptSyncContent} aria-busy={configLoading}>
        <div className={styles.scriptSyncConfigHeader}>
          <div><strong>飞书多维表格</strong><span>{config?.is_ready ? `当前已连接：${config.table?.name ?? "数据表"}` : "请先测试链接，再设置字段映射"}</span></div>
          {config?.verified_at ? <small>上次验证：{readableDate(config.verified_at)}</small> : null}
        </div>

        <section className={styles.scriptSyncConfigSection}>
          <div className={styles.scriptSyncSectionHeading}><span>多维表格链接</span><small>填写需要接收剧本数据的飞书多维表格链接</small></div>
          <div className={styles.scriptSyncUrlRow}>
            <label className={styles.scriptSyncUrlInput}><Link2 size={17} /><input value={url} onChange={(event) => { setUrl(event.target.value); setTestResult(null); setTarget(null); setMappings([]); }} placeholder="粘贴飞书多维表格链接" aria-label="飞书多维表格链接" /></label>
            <button className={styles.secondaryButton} type="button" onClick={() => void testTarget()} disabled={testing || authorizing}>{testing ? <LoaderCircle className={styles.syncSpinner} size={16} /> : <CheckCircle2 size={16} />}{testing ? "正在测试" : "测试链接"}</button>
          </div>
          {testResult ? <div className={`${styles.scriptSyncTestResult} ${testResult.authorized ? styles.scriptSyncTestSuccess : styles.scriptSyncTestAttention}`}>
            <div><strong>{testResult.authorized ? "链接可用" : testResult.reachable ? "需要飞书授权" : "链接暂时无法读取"}</strong><span>{testResult.message}</span></div>
            {!testResult.authorized ? <div className={styles.scriptSyncAuthorizationActions}>
              {testResult.authorization_url ? <a className={styles.secondaryButton} href={testResult.authorization_url} target="_blank" rel="noreferrer"><ExternalLink size={15} />前往飞书授权</a> : <button className={styles.secondaryButton} type="button" onClick={() => void beginAuthorization()} disabled={authorizing}>{authorizing ? "正在准备授权" : "获取授权链接"}</button>}
              <button className={styles.primaryButton} type="button" onClick={() => void finishAuthorization()} disabled={authorizing}>{authorizing ? <LoaderCircle className={styles.syncSpinner} size={16} /> : <CheckCircle2 size={16} />}授权完成后重新测试</button>
            </div> : null}
          </div> : null}
        </section>

        {target ? <section className={styles.scriptSyncConfigSection}>
          <div className={styles.scriptSyncMappingHeading}>
            <div><span>字段映射</span><small>同步到「{target.table?.name ?? "数据表"}」；同名可写字段已自动匹配</small></div>
            <span>{target.fields.length} 个可用字段</span>
          </div>
          <div className={styles.scriptSyncMappingTable}>
            <div className={styles.scriptSyncMappingHead}><span>待同步字段</span><span>飞书多维表格字段</span><span>缺失时处理</span></div>
            {(config?.system_fields ?? []).map((systemField) => {
              const mapping = mappingFor(mappings, systemField.key);
              const selectableFields = target.fields.filter((field) => compatibleField(systemField.kind, field));
              const sameNamedField = target.fields.find((field) => field.name === systemField.label);
              const canAutoCreate = !sameNamedField;
              return <div className={styles.scriptSyncMappingRow} key={systemField.key}>
                <div><strong>{systemField.label}</strong><small>{FIELD_KIND_LABELS[systemField.kind]}</small></div>
                <select value={mapping.target_field_id ?? ""} disabled={mapping.auto_create} onChange={(event) => updateMapping(systemField.key, { target_field_id: event.target.value || null, auto_create: false })} aria-label={`${systemField.label}映射字段`}>
                  <option value="">暂不同步</option>
                  {selectableFields.map((field) => <option key={field.id} value={field.id}>{field.name}（{field.type}{field.multiple ? "，多值" : ""}）</option>)}
                </select>
                <label className={styles.scriptSyncAutoCreate} title={canAutoCreate ? "在多维表格中自动添加同名字段" : "已存在同名字段，请直接选择或检查字段类型"}>
                  <input type="checkbox" checked={mapping.auto_create} disabled={!canAutoCreate} onChange={(event) => updateMapping(systemField.key, { auto_create: event.target.checked, target_field_id: event.target.checked ? null : mapping.target_field_id })} />自动添加
                </label>
              </div>;
            })}
          </div>
          {!hasScriptNameMapping ? <p className={styles.scriptSyncMappingHint}>请至少为「剧本名称」选择一个字段，或设置为自动添加。</p> : null}
        </section> : <div className={styles.scriptSyncEmptyMapping}>测试链接成功后，可在这里设置字段映射。</div>}

        <div className={styles.scriptSyncConfigActions}>
          <button className={styles.primaryButton} type="button" onClick={() => void saveConfiguration()} disabled={!canSave || saving}>{saving ? <LoaderCircle className={styles.syncSpinner} size={16} /> : <Save size={16} />}{saving ? "正在保存" : "保存同步配置"}</button>
        </div>
      </section> : null}
    </div>
  );
}
