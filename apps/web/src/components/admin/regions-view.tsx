"use client";

import { Globe2, Languages, MapPin, MapPinned, Plus, RefreshCcw, RotateCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAdminRegions, saveAdminRegions } from "@/lib/admin-api";
import type { RegionRule, RegionRulesConfig, RegionRulesPayload } from "@/lib/admin-types";
import { PageLoading } from "@/components/ui/page-loading";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

type DiscardMode = "reload" | "reset";

const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function cloneConfig(config: RegionRulesConfig): RegionRulesConfig {
  return JSON.parse(JSON.stringify(config)) as RegionRulesConfig;
}

function cleanList(items: string[]) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function normalizeConfig(config: RegionRulesConfig): RegionRulesConfig {
  return {
    schema_version: "1.2.0",
    regions: Object.fromEntries(Object.entries(config.regions).map(([key, region]) => [
      key.trim(),
      {
        aliases: cleanList(region.aliases),
        default_market: region.default_market.trim(),
        default_locale: region.default_locale.trim(),
        rules: cleanList(region.rules),
        stage_overrides: Object.fromEntries(Object.entries(region.stage_overrides ?? {}).map(([stage, override]) => [
          stage.trim(),
          { rules: cleanList(override.rules) }
        ])),
        translation_context: cleanList(region.translation_context),
        requires_translation: region.requires_translation !== false
      }
    ]))
  };
}

function getRegionCode(locale: string) {
  const parts = locale.trim().split("-").filter(Boolean);
  return (parts.at(-1) ?? "--").slice(0, 3).toUpperCase();
}

function ListEditor({
  label,
  description,
  icon: Icon,
  value,
  onChange
}: {
  label: string;
  description: string;
  icon: typeof Globe2;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  function update(index: number, next: string) {
    onChange(value.map((item, itemIndex) => itemIndex === index ? next : item));
  }

  return (
    <section className={styles.ruleListEditor} aria-label={label}>
      <div className={styles.ruleListHeading}>
        <span className={styles.ruleListIcon}><Icon size={17} /></span>
        <div><span>{label}</span><small>{description}</small></div>
        <span className={styles.ruleCount}>{cleanList(value).length}</span>
        <button type="button" className={styles.ruleAddButton} onClick={() => onChange([...value, ""])}>
          <Plus size={14} />添加
        </button>
      </div>
      <div className={styles.ruleListRows}>
        {value.map((item, index) => (
          <div className={styles.ruleListRow} key={index}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <input
              value={item}
              placeholder={`输入${label}`}
              aria-label={`${label}第 ${index + 1} 条`}
              aria-invalid={!item.trim()}
              onChange={(event) => update(index, event.target.value)}
            />
            <button
              type="button"
              className={styles.ruleRowDelete}
              onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
              aria-label={`删除${label}第 ${index + 1} 条`}
              title="删除"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!value.length ? <div className={styles.ruleListEmpty}>暂无条目</div> : null}
      </div>
    </section>
  );
}

export function AdminRegionsView({ onNotice }: { onNotice: (message: string) => void }) {
  const [source, setSource] = useState<RegionRulesPayload | null>(null);
  const [draft, setDraft] = useState<RegionRulesConfig | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMarket, setNewMarket] = useState("");
  const [newLocale, setNewLocale] = useState("");
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [discardMode, setDiscardMode] = useState<DiscardMode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await getAdminRegions();
      const nextDraft = cloneConfig(payload.config);
      const keys = Object.keys(nextDraft.regions);
      setSource(payload);
      setDraft(nextDraft);
      setSelected((current) => current && nextDraft.regions[current] ? current : keys[0] ?? null);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "地区规则加载失败");
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => { void load(); }, [load]);

  const dirty = useMemo(
    () => Boolean(source && draft && JSON.stringify(draft) !== JSON.stringify(source.config)),
    [draft, source]
  );
  const invalidRegions = useMemo(() => {
    const invalid = new Set<string>();
    Object.entries(draft?.regions ?? {}).forEach(([key, region]) => {
      if (!key.trim()
        || !region.default_market.trim()
        || !LANGUAGE_CODE_PATTERN.test(region.default_locale.trim())
        || region.aliases.some((item) => !item.trim())
        || region.rules.some((item) => !item.trim())
        || Object.entries(region.stage_overrides ?? {}).some(([stage, override]) => (
          !stage.trim() || override.rules.some((item) => !item.trim())
        ))) {
        invalid.add(key);
      }
    });
    return invalid;
  }, [draft]);
  const configValid = Boolean(draft && Object.keys(draft.regions).length && !invalidRegions.size);
  const region = selected ? draft?.regions[selected] : null;
  const selectedUsage = selected ? source?.usage[selected] ?? 0 : 0;

  function updateRegion(patch: Partial<RegionRule>) {
    if (!draft || !selected || !draft.regions[selected]) return;
    setDraft({
      ...draft,
      regions: { ...draft.regions, [selected]: { ...draft.regions[selected], ...patch } }
    });
  }

  async function save() {
    if (!draft || !source || busy || !configValid) return;
    setBusy(true);
    try {
      const payload = await saveAdminRegions(normalizeConfig(draft), source.content_hash);
      setSource(payload);
      setDraft(cloneConfig(payload.config));
      onNotice("地区规则已保存");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "地区规则保存失败");
    } finally {
      setBusy(false);
    }
  }

  function addRegion() {
    if (!draft || !newName.trim() || !newMarket.trim() || !LANGUAGE_CODE_PATTERN.test(newLocale.trim())) return;
    const key = newName.trim();
    if (draft.regions[key]) {
      onNotice("地区名称已存在");
      return;
    }
    setDraft({
      ...draft,
      regions: {
        ...draft.regions,
        [key]: {
          aliases: [],
          default_market: newMarket.trim(),
          default_locale: newLocale.trim(),
          rules: [],
          stage_overrides: {},
          translation_context: [],
          requires_translation: true
        }
      }
    });
    setSelected(key);
    setAdding(false);
    setNewName("");
    setNewMarket("");
    setNewLocale("");
  }

  function removeRegion() {
    if (!draft || !deleteKey) return;
    const regions = { ...draft.regions };
    delete regions[deleteKey];
    setDraft({ ...draft, regions });
    setSelected(Object.keys(regions)[0] ?? null);
    setDeleteKey(null);
  }

  function discardChanges() {
    if (!source || !discardMode) return;
    const mode = discardMode;
    setDiscardMode(null);
    if (mode === "reload") {
      void load();
      return;
    }
    const nextDraft = cloneConfig(source.config);
    setDraft(nextDraft);
    setSelected((current) => current && nextDraft.regions[current] ? current : Object.keys(nextDraft.regions)[0] ?? null);
  }

  if (loading && !draft) return <PageLoading label="正在加载地区规则" />;
  if (!draft || !source) {
    return <div className={styles.view}><div className={styles.emptyCell}>地区规则暂时无法读取</div></div>;
  }

  const statusLabel = invalidRegions.size
    ? `${invalidRegions.size} 个地区待补全`
    : dirty ? "存在未保存修改" : "已同步";

  return (
    <div className={`${styles.view} ${styles.regionView}`} aria-busy={loading}>
      <div className={styles.viewToolbar}>
        <div className={`${styles.ruleState} ${invalidRegions.size ? styles.ruleStateInvalid : ""}`}>
          <i className={dirty ? styles.ruleDirty : ""} />
          <div><span>{statusLabel}</span><small>{dirty ? "保存后将用于后续项目" : "当前配置已生效"}</small></div>
        </div>
        <div className={styles.toolbarRight}>
          <button className={styles.iconButton} onClick={() => dirty ? setDiscardMode("reload") : void load()} disabled={busy || loading} aria-label="重新加载" title="重新加载"><RefreshCcw size={16} /></button>
          {dirty ? <button className={styles.secondaryButton} onClick={() => setDiscardMode("reset")} disabled={busy}><RotateCcw size={15} />撤销修改</button> : null}
          <button className={styles.primaryButton} disabled={!dirty || busy || !configValid} onClick={() => void save()}><Save size={16} />{busy ? "正在保存" : "保存并生效"}</button>
        </div>
      </div>

      <div className={styles.regionLayout}>
        <aside className={styles.regionNav}>
          <div className={styles.regionNavSummary}><span>规则范围</span><strong>{Object.keys(draft.regions).length} 个地区</strong></div>
          <div className={styles.regionNavScroll}>
            <div className={styles.regionNavHeading}>
              <span>地区配置</span>
              <button className={styles.iconButton} onClick={() => setAdding(true)} aria-label="新增地区" title="新增地区"><Plus size={15} /></button>
            </div>
            {Object.keys(draft.regions).map((key) => (
              <button key={key} className={`${styles.regionScopeButton} ${selected === key ? styles.regionNavActive : ""}`} onClick={() => setSelected(key)}>
                <span className={styles.regionCode}>{getRegionCode(draft.regions[key].default_locale)}</span>
                <span><strong>{key}</strong><small>{source.usage[key] ?? 0} 个项目</small></span>
                {invalidRegions.has(key) ? <i className={styles.regionNavInvalid} title="配置未完成" /> : null}
              </button>
            ))}
          </div>
        </aside>

        <section className={styles.regionEditor}>
          {region && selected ? (
            <>
              <header className={styles.regionEditorHeader}>
                <div className={styles.editorIdentity}>
                  <span className={styles.editorIdentityIcon}><MapPinned size={21} /></span>
                  <div><small>地区配置</small><h2>{selected}</h2><p>{region.default_market || "未设置市场"} · {region.default_locale || "未设置语言"} · {selectedUsage} 个项目 · {cleanList(region.rules).length} 条规则</p></div>
                </div>
                <button className={styles.iconButtonDanger} disabled={selectedUsage > 0 || Object.keys(draft.regions).length <= 1} onClick={() => setDeleteKey(selected)} aria-label={`删除${selected}`} title={selectedUsage > 0 ? "请先迁移使用该地区的项目" : "删除地区"}><Trash2 size={16} /></button>
              </header>
              <div className={styles.regionEditorBody}>
                <div className={styles.editorSectionStack}>
                  <section className={styles.regionBasicsSection}>
                    <div className={styles.editorSectionHeading}><div><span>基础信息</span><small>项目创建和剧本改写时使用</small></div></div>
                    <div className={styles.regionBasics}>
                      <div className={styles.regionReadOnlyField}><span>地区名称</span><div><MapPin size={15} />{selected}</div></div>
                      <label><span>默认目标市场</span><input value={region.default_market} aria-invalid={!region.default_market.trim()} onChange={(event) => updateRegion({ default_market: event.target.value })} /><small className={!region.default_market.trim() ? styles.fieldError : ""}>例如 美国</small></label>
                      <label><span>默认语言区域代码</span><input value={region.default_locale} aria-invalid={!LANGUAGE_CODE_PATTERN.test(region.default_locale.trim())} onChange={(event) => updateRegion({ default_locale: event.target.value })} /><small className={!LANGUAGE_CODE_PATTERN.test(region.default_locale.trim()) ? styles.fieldError : ""}>例如 en-US</small></label>
                      <label><span>台词翻译</span><select value={region.requires_translation !== false ? "required" : "skip"} onChange={(event) => updateRegion({ requires_translation: event.target.value === "required" })}><option value="required">需要翻译</option><option value="skip">不需要翻译</option></select><small>改编项目完成全稿后是否进入台词翻译</small></label>
                    </div>
                  </section>
                  <ListEditor label="地区别名" description="用于识别同一地区的常用名称" icon={Languages} value={region.aliases} onChange={(aliases) => updateRegion({ aliases })} />
                  <ListEditor label="改编规则" description="该地区剧本改写与审稿时遵循的要求" icon={Globe2} value={region.rules} onChange={(rules) => updateRegion({ rules })} />
                  <ListEditor label="翻译语境" description="台词翻译和剧本润色时参考的语言、关系与文化边界" icon={Languages} value={region.translation_context} onChange={(translation_context) => updateRegion({ translation_context })} />
                </div>
              </div>
            </>
          ) : null}
        </section>
      </div>

      {adding ? <AdminDialog title="新增地区" confirmLabel="创建地区" confirmDisabled={!newName.trim() || !newMarket.trim() || !LANGUAGE_CODE_PATTERN.test(newLocale.trim())} onCancel={() => setAdding(false)} onConfirm={addRegion}><div className={styles.formGrid}><label><span>地区名称</span><input value={newName} onChange={(event) => setNewName(event.target.value)} /></label><label><span>默认目标市场</span><input value={newMarket} placeholder="美国" onChange={(event) => setNewMarket(event.target.value)} /></label><label><span>默认语言区域代码</span><input value={newLocale} placeholder="en-US" onChange={(event) => setNewLocale(event.target.value)} /></label></div></AdminDialog> : null}
      {deleteKey ? <AdminDialog title={`删除地区「${deleteKey}」`} confirmLabel="删除地区" destructive onCancel={() => setDeleteKey(null)} onConfirm={removeRegion}><p className={styles.dangerText}>保存后，新项目将不能再选择该地区。</p></AdminDialog> : null}
      {discardMode ? <AdminDialog title={discardMode === "reload" ? "重新加载地区规则" : "撤销未保存修改"} confirmLabel={discardMode === "reload" ? "重新加载" : "撤销修改"} destructive onCancel={() => setDiscardMode(null)} onConfirm={discardChanges}><p className={styles.dangerText}>当前未保存的修改将被丢弃。</p></AdminDialog> : null}
    </div>
  );
}
