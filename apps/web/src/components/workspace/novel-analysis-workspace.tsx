"use client";

import {
  ChevronDown,
  ChevronUp,
  Plus,
  Save,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { PageLoading } from "@/components/ui/page-loading";
import type { NovelAnalysis, NovelAnalysisSection } from "@/lib/types";

type NovelAnalysisWorkspaceProps = {
  title: string;
  section: NovelAnalysisSection;
  value: NovelAnalysis;
  dirty: boolean;
  saving: boolean;
  generating?: boolean;
  locked?: boolean;
  lockReason?: "agent" | "archived" | "view";
  titleAction?: ReactNode;
  onChange: (value: NovelAnalysis) => void;
  onSave: () => void;
  onCancel: () => void;
};

const SECTION_TITLES: Record<NovelAnalysisSection, string> = {
  basic: "基础信息",
  characters: "主要角色",
  units: "剧情单元"
};

function manualUnitId() {
  return `unit-manual-${Date.now().toString(36)}`;
}

function decisionClass(recommendation: NovelAnalysis["剧情单元"][number]["改编建议"]) {
  if (recommendation === "删除") return "is-delete";
  if (recommendation === "合并") return "is-merge";
  return "is-keep";
}

export function NovelAnalysisWorkspace({
  title,
  section,
  value,
  dirty,
  saving,
  generating = false,
  locked = false,
  lockReason = "agent",
  titleAction,
  onChange,
  onSave,
  onCancel
}: NovelAnalysisWorkspaceProps) {
  const [collapsedUnits, setCollapsedUnits] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteCharacterTarget, setDeleteCharacterTarget] = useState<number | null>(null);
  const [editingUnitTitle, setEditingUnitTitle] = useState<string | null>(null);
  const [genreDraft, setGenreDraft] = useState("");
  const unitsInitializedRef = useRef(false);
  const characterNames = useMemo(() => value["关键人物"].map((item) => item["人物名称"]).filter(Boolean), [value]);

  useEffect(() => {
    if (unitsInitializedRef.current || !value["剧情单元"].length) return;
    unitsInitializedRef.current = true;
    setCollapsedUnits(new Set(value["剧情单元"].map((unit) => unit["单元ID"])));
  }, [value]);

  function updateBasicInfo(field: "小说名称" | "小说梗概" | "基调", nextValue: string) {
    onChange({
      ...value,
      "基础信息": { ...value["基础信息"], [field]: nextValue }
    });
  }

  function addGenres(rawValue = genreDraft) {
    const candidates = rawValue
      .split(/[，,、\n]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
    if (candidates.length) {
      const currentGenres = value["基础信息"]["题材"];
      const nextGenres = [...currentGenres];
      candidates.forEach((genre) => {
        if (!nextGenres.includes(genre)) nextGenres.push(genre);
      });
      onChange({
        ...value,
        "基础信息": { ...value["基础信息"], "题材": nextGenres }
      });
    }
    setGenreDraft("");
  }

  function handleGenreKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addGenres();
  }

  function removeGenre(genre: string) {
    onChange({
      ...value,
      "基础信息": {
        ...value["基础信息"],
        "题材": value["基础信息"]["题材"].filter((item) => item !== genre)
      }
    });
  }

  function updateCharacter(index: number, field: keyof NovelAnalysis["关键人物"][number], nextValue: string) {
    const currentName = value["关键人物"][index]?.["人物名称"];
    const renamedUnits = field === "人物名称" && currentName && currentName !== nextValue
      ? value["剧情单元"].map((unit) => ({
        ...unit,
        "关键人物": unit["关键人物"].map((role) => (
          role["人物名称"] === currentName ? { ...role, "人物名称": nextValue } : role
        ))
      }))
      : value["剧情单元"];
    onChange({
      ...value,
      "关键人物": value["关键人物"].map((item, itemIndex) => itemIndex === index ? { ...item, [field]: nextValue } : item),
      "剧情单元": renamedUnits
    });
  }

  function removeCharacter(index: number) {
    if (deleteCharacterTarget !== index) {
      setDeleteCharacterTarget(index);
      return;
    }
    const removedName = value["关键人物"][index]?.["人物名称"];
    onChange({
      ...value,
      "关键人物": value["关键人物"].filter((_entry, entryIndex) => entryIndex !== index),
      "剧情单元": removedName
        ? value["剧情单元"].map((unit) => ({
          ...unit,
          "关键人物": unit["关键人物"].filter((role) => role["人物名称"] !== removedName)
        }))
        : value["剧情单元"]
    });
    setDeleteCharacterTarget(null);
  }

  function updateUnit(index: number, nextUnit: NovelAnalysis["剧情单元"][number]) {
    onChange({
      ...value,
      "剧情单元": value["剧情单元"].map((item, itemIndex) => itemIndex === index ? nextUnit : item)
    });
  }

  function removeUnit(unitId: string) {
    if (deleteTarget !== unitId) {
      setDeleteTarget(unitId);
      return;
    }
    onChange({ ...value, "剧情单元": value["剧情单元"].filter((unit) => unit["单元ID"] !== unitId) });
    setDeleteTarget(null);
  }

  function toggleUnitMerge(unitId: string) {
    const sourceUnit = value["剧情单元"].find((unit) => unit["单元ID"] === unitId);
    if (!sourceUnit || sourceUnit["改编建议"] !== "合并") return;
    const targetUnit = value["剧情单元"].find((unit) => unit["单元ID"] === sourceUnit["合并目标单元ID"]);
    if (!sourceUnit["已确认合并"] && !targetUnit) return;
    onChange({
      ...value,
      "剧情单元": value["剧情单元"].map((unit) => unit["单元ID"] === unitId
        ? { ...unit, "已确认合并": !unit["已确认合并"] }
        : unit)
    });
  }

  function addUnit() {
    const unitId = manualUnitId();
    onChange({
      ...value,
      "剧情单元": [...value["剧情单元"], {
        "单元ID": unitId,
        "单元名称": "",
        "单元梗概": "",
        "主线推进": "",
        "关键人物": [],
        "关键信息": [],
        "高光时刻": [],
        "改编建议": "保留",
        "合并目标单元ID": "",
        "已确认合并": false,
        "建议原因": "手动新增的剧情单元，建议结合其对主线推进和高光产出的贡献决定是否保留。"
      }]
    });
    setCollapsedUnits((current) => {
      const next = new Set(current);
      next.delete(unitId);
      return next;
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!locked) onSave();
  }

  if (generating) {
    return (
      <section className="glass-panel document-panel novel-analysis-panel">
        <div className="document-toolbar">
          <div className="document-toolbar-title">
            <h1>{title}</h1>
            {titleAction}
          </div>
        </div>
        <PageLoading label="正在解读小说" agentStage="novel_analysis" />
      </section>
    );
  }

  return (
    <section className="glass-panel document-panel novel-analysis-panel">
      <div className="document-toolbar novel-analysis-toolbar">
        <div className="document-toolbar-title">
          <h1>{title} <span>/ {SECTION_TITLES[section]}</span></h1>
          {titleAction}
        </div>
      </div>

      <form id="novel-analysis-form" className="novel-workspace-form" onSubmit={handleSubmit}>
        <fieldset disabled={locked || saving}>
          {section === "basic" ? (
            <section className="novel-basic-workspace" aria-label="基础信息">
              <div className="novel-basic-meta-grid">
                <label className="novel-meta-title"><span>小说名称</span><input value={value["基础信息"]["小说名称"]} onChange={(event) => updateBasicInfo("小说名称", event.target.value)} /></label>
                <div className="novel-genre-editor">
                  <span>题材</span>
                  <div className="novel-genre-input-shell">
                    {value["基础信息"]["题材"].map((genre) => (
                      <span className="novel-genre-tag" key={genre}>
                        {genre}
                        <button type="button" aria-label={`删除题材：${genre}`} title={`删除题材：${genre}`} onClick={() => removeGenre(genre)}><X size={13} /></button>
                      </span>
                    ))}
                    <input value={genreDraft} placeholder="输入题材后按回车" aria-label="添加题材" onChange={(event) => setGenreDraft(event.target.value)} onKeyDown={handleGenreKeyDown} />
                    <button type="button" className="novel-genre-add" aria-label="添加题材" title="添加题材" onClick={() => addGenres()}><Plus size={15} /></button>
                  </div>
                </div>
                <label className="novel-meta-tone"><span>基调</span><input value={value["基础信息"]["基调"]} onChange={(event) => updateBasicInfo("基调", event.target.value)} /></label>
              </div>
              <label className="novel-editor-field"><span>小说梗概</span><textarea value={value["基础信息"]["小说梗概"]} onChange={(event) => updateBasicInfo("小说梗概", event.target.value)} rows={4} /></label>
              <label className="novel-editor-field"><span>核心卖点</span><textarea value={value["核心卖点"]} onChange={(event) => onChange({ ...value, "核心卖点": event.target.value })} rows={4} /></label>
              <label className="novel-editor-field"><span>故事主线</span><textarea value={value["故事主线"]} onChange={(event) => onChange({ ...value, "故事主线": event.target.value })} rows={5} /></label>
              <label className="novel-editor-field"><span>世界设定</span><textarea value={value["世界观"]} onChange={(event) => onChange({ ...value, "世界观": event.target.value })} rows={4} /></label>
            </section>
          ) : null}

          {section === "characters" ? (
            <section className="novel-characters-workspace" aria-label="主要角色">
              <div className="novel-workspace-heading">
                <strong>主要角色</strong>
              </div>
              <div className="novel-character-list">
                {!value["关键人物"].length ? <p className="novel-empty-state">暂无主要角色</p> : null}
                {value["关键人物"].map((character, index) => (
                  <article className="novel-character-row" key={`${character["人物名称"]}-${index}`}>
                    <header className="novel-character-header">
                      <span className="novel-row-index">{String(index + 1).padStart(2, "0")}</span>
                      <h2><input className="novel-character-name-input" value={character["人物名称"]} placeholder="未命名角色" aria-label={`第 ${index + 1} 个角色名称`} onChange={(event) => updateCharacter(index, "人物名称", event.target.value)} /></h2>
                      <button type="button" className={deleteCharacterTarget === index ? "confirm-delete" : ""} aria-label={`删除${character["人物名称"] || "当前角色"}`} title={`删除${character["人物名称"] || "当前角色"}`} onClick={() => removeCharacter(index)} onBlur={() => setDeleteCharacterTarget((current) => current === index ? null : current)}>{deleteCharacterTarget === index ? "确认删除" : <Trash2 size={15} />}</button>
                    </header>
                    <label className="novel-character-profile"><textarea aria-label={`${character["人物名称"] || `第 ${index + 1} 个角色`}的人物画像`} value={character["人物画像"]} onChange={(event) => updateCharacter(index, "人物画像", event.target.value)} rows={4} /></label>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

        </fieldset>

        {section === "units" ? (
          <section className="novel-units-workspace" aria-label="剧情单元">
            <div className="novel-workspace-heading">
              <strong>剧情单元</strong>
              <div className="novel-unit-header-actions">
                <button type="button" disabled={locked || saving} onClick={() => setCollapsedUnits(new Set(value["剧情单元"].map((unit) => unit["单元ID"]))) }>全部收起</button>
                <button type="button" disabled={locked || saving} onClick={() => setCollapsedUnits(new Set())}>全部展开</button>
                <button type="button" className="novel-add-action" disabled={locked || saving} onClick={addUnit}><Plus size={15} />添加单元</button>
              </div>
            </div>
            <datalist id="novel-character-names">{characterNames.map((name) => <option value={name} key={name} />)}</datalist>
            <div className="novel-unit-list">
              {!value["剧情单元"].length ? <p className="novel-empty-state">暂无剧情单元</p> : null}
              {value["剧情单元"].map((unit, index) => {
                const collapsed = collapsedUnits.has(unit["单元ID"]);
                const targetUnit = unit["改编建议"] === "合并"
                  ? value["剧情单元"].find((item) => item["单元ID"] === unit["合并目标单元ID"])
                  : null;
                const hasConfirmedMergeDependents = value["剧情单元"].some((item) => (
                  item["已确认合并"] && item["合并目标单元ID"] === unit["单元ID"]
                ));
                const recommendationClass = decisionClass(unit["改编建议"]);
                return (
                  <article className={`novel-unit-card${collapsed ? " collapsed" : ""}`} key={unit["单元ID"]}>
                    <header className="novel-unit-card-header">
                      <button type="button" className="novel-unit-collapse" aria-label={collapsed ? "展开剧情单元" : "收起剧情单元"} aria-expanded={!collapsed} onClick={() => setCollapsedUnits((current) => {
                        const next = new Set(current);
                        if (next.has(unit["单元ID"])) next.delete(unit["单元ID"]); else next.add(unit["单元ID"]);
                        return next;
                      })}>{collapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}</button>
                      <span className="novel-unit-number">{String(index + 1).padStart(2, "0")}</span>
                      {editingUnitTitle === unit["单元ID"] ? (
                        <input
                          autoFocus
                          className="novel-unit-title-input"
                          value={unit["单元名称"]}
                          placeholder="未命名剧情单元"
                          aria-label="单元名称"
                          onChange={(event) => updateUnit(index, { ...unit, "单元名称": event.target.value })}
                          onBlur={() => setEditingUnitTitle(null)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="novel-unit-title"
                          disabled={locked || saving}
                          title="编辑单元名称"
                          aria-label={`编辑单元名称：${unit["单元名称"] || "未命名剧情单元"}`}
                          onClick={() => setEditingUnitTitle(unit["单元ID"])}
                        >{unit["单元名称"] || "未命名剧情单元"}</button>
                      )}
                      <span className={`novel-unit-decision ${recommendationClass}`}>建议{unit["改编建议"]}</span>
                      {unit["已确认合并"] ? (
                        <span className="novel-unit-merge-confirmed">已确认并入</span>
                      ) : (
                        <span className="novel-unit-merge-confirmed is-placeholder" aria-hidden="true" />
                      )}
                      <small>{unit["关键人物"].length} 人 · {unit["高光时刻"].length} 高光</small>
                      <div className="novel-unit-card-actions">
                        {unit["改编建议"] === "合并" ? (
                          <button
                            type="button"
                            className={`novel-unit-merge-action${unit["已确认合并"] ? " is-confirmed" : ""}`}
                            disabled={locked || saving || (!targetUnit && !unit["已确认合并"])}
                            aria-label={unit["已确认合并"] ? `撤销${unit["单元名称"] || "当前剧情单元"}的合并` : `确认将${unit["单元名称"] || "当前剧情单元"}并入${targetUnit?.["单元名称"] || "目标单元"}`}
                            title={unit["已确认合并"] ? "撤销合并" : targetUnit ? `确认并入：${targetUnit["单元名称"] || "未命名剧情单元"}` : "原建议的目标单元已删除"}
                            onClick={() => toggleUnitMerge(unit["单元ID"])}
                          >
                            {unit["已确认合并"] ? "撤销" : "合并"}
                          </button>
                        ) : null}
                        <button type="button" disabled={locked || saving || hasConfirmedMergeDependents} className={deleteTarget === unit["单元ID"] ? "confirm-delete" : ""} aria-label={`删除${unit["单元名称"] || "当前剧情单元"}`} title={hasConfirmedMergeDependents ? "请先撤销并入此单元的确认" : `删除${unit["单元名称"] || "当前剧情单元"}`} onClick={() => removeUnit(unit["单元ID"])} onBlur={() => setDeleteTarget((current) => current === unit["单元ID"] ? null : current)}>{deleteTarget === unit["单元ID"] ? "确认删除" : "删除"}</button>
                      </div>
                    </header>
                    {!collapsed ? (
                      <fieldset className="novel-unit-editor" disabled={locked || saving}>
                        <div className="novel-unit-card-body">
                          <div className="novel-unit-main-fields">
                            <label><span>主线推进</span><input value={unit["主线推进"]} onChange={(event) => updateUnit(index, { ...unit, "主线推进": event.target.value })} /></label>
                            <label><span>单元梗概</span><textarea value={unit["单元梗概"]} onChange={(event) => updateUnit(index, { ...unit, "单元梗概": event.target.value })} rows={4} /></label>
                          </div>
                          <div className="novel-unit-block">
                            <strong>关键人物</strong>
                            {unit["关键人物"].map((role, roleIndex) => (
                              <div className="novel-unit-role-row" key={roleIndex}>
                                <input list="novel-character-names" value={role["人物名称"]} placeholder="人物名称" onChange={(event) => updateUnit(index, { ...unit, "关键人物": unit["关键人物"].map((item, itemIndex) => itemIndex === roleIndex ? { ...item, "人物名称": event.target.value } : item) })} />
                                <input value={role["单元作用与变化"]} placeholder="单元作用与变化" onChange={(event) => updateUnit(index, { ...unit, "关键人物": unit["关键人物"].map((item, itemIndex) => itemIndex === roleIndex ? { ...item, "单元作用与变化": event.target.value } : item) })} />
                                <button type="button" aria-label="删除单元关键人物" onClick={() => updateUnit(index, { ...unit, "关键人物": unit["关键人物"].filter((_item, itemIndex) => itemIndex !== roleIndex) })}><Trash2 size={14} /></button>
                              </div>
                            ))}
                            <button type="button" className="novel-add-action compact" onClick={() => updateUnit(index, { ...unit, "关键人物": [...unit["关键人物"], { "人物名称": "", "单元作用与变化": "" }] })}><Plus size={14} />添加人物</button>
                          </div>
                          <div className="novel-unit-columns">
                            <div className="novel-unit-block">
                              <strong>关键信息</strong>
                              {unit["关键信息"].map((info, infoIndex) => <div className="novel-unit-simple-row" key={infoIndex}><input value={info} onChange={(event) => updateUnit(index, { ...unit, "关键信息": unit["关键信息"].map((item, itemIndex) => itemIndex === infoIndex ? event.target.value : item) })} /><button type="button" aria-label="删除关键信息" onClick={() => updateUnit(index, { ...unit, "关键信息": unit["关键信息"].filter((_item, itemIndex) => itemIndex !== infoIndex) })}><Trash2 size={14} /></button></div>)}
                              <button type="button" className="novel-add-action compact" onClick={() => updateUnit(index, { ...unit, "关键信息": [...unit["关键信息"], ""] })}><Plus size={14} />添加信息</button>
                            </div>
                            <div className="novel-unit-block highlight-block">
                              <strong>高光时刻</strong>
                              {unit["高光时刻"].map((highlight, highlightIndex) => <div className="novel-unit-highlight-row" key={highlightIndex}><input value={highlight["名称"]} placeholder="高光名称" onChange={(event) => updateUnit(index, { ...unit, "高光时刻": unit["高光时刻"].map((item, itemIndex) => itemIndex === highlightIndex ? { ...item, "名称": event.target.value } : item) })} /><input className="source-index" value={highlight["原文索引"]} placeholder="L120-L145" pattern="L[0-9]+-L[0-9]+" title="请按 L起始行-L结束行 填写，例如 L120-L145" aria-label={`${highlight["名称"] || `第 ${highlightIndex + 1} 个高光`}的原文索引`} onChange={(event) => updateUnit(index, { ...unit, "高光时刻": unit["高光时刻"].map((item, itemIndex) => itemIndex === highlightIndex ? { ...item, "原文索引": event.target.value } : item) })} /><button type="button" aria-label="删除高光时刻" onClick={() => updateUnit(index, { ...unit, "高光时刻": unit["高光时刻"].filter((_item, itemIndex) => itemIndex !== highlightIndex) })}><Trash2 size={14} /></button></div>)}
                              <button type="button" className="novel-add-action compact" onClick={() => updateUnit(index, { ...unit, "高光时刻": [...unit["高光时刻"], { "名称": "", "原文索引": "" }] })}><Plus size={14} />添加高光</button>
                            </div>
                          </div>
                          <div className={`novel-unit-recommendation ${recommendationClass}`}>
                            <div className="novel-unit-recommendation-heading">
                              <strong>改编建议</strong>
                              <span className={`novel-unit-decision ${recommendationClass}`}>建议{unit["改编建议"]}</span>
                            </div>
                            {unit["改编建议"] === "合并" ? <span className="novel-unit-merge-target">{targetUnit ? `建议并入：${targetUnit["单元名称"] || "未命名剧情单元"}` : "原建议的目标单元已删除"}</span> : null}
                            {unit["已确认合并"] && targetUnit ? <span className="novel-unit-merge-confirmed">已确认并入</span> : null}
                            <p>{unit["建议原因"]}</p>
                          </div>
                        </div>
                      </fieldset>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

      </form>
      {dirty && !locked ? (
        <div className="dirty-actions novel-analysis-actions" aria-label="未保存修改操作">
          <button className="save-action" type="submit" form="novel-analysis-form" disabled={saving}><Save size={13} />{saving ? "保存中" : "保存"}</button>
          <button className="cancel-action" type="button" onClick={onCancel} disabled={saving}>放弃更改</button>
        </div>
      ) : null}
      {locked && lockReason === "agent" ? <div className="novel-analysis-locked">生成中</div> : null}
    </section>
  );
}
