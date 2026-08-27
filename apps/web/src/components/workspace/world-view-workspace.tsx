"use client";

import { ArrowRight, Plus, Save, Trash2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { PageLoading } from "@/components/ui/page-loading";
import type { WorldView } from "@/lib/types";

type WorldViewWorkspaceProps = {
  title: string;
  value: WorldView;
  dirty: boolean;
  saving: boolean;
  generating?: boolean;
  locked?: boolean;
  lockReason?: "agent" | "archived" | "view";
  titleAction?: ReactNode;
  onChange: (value: WorldView) => void;
  onSave: () => void;
  onCancel: () => void;
  onLockedEditAttempt?: () => void;
};

const EMPTY_MAPPING = { "原剧本概念": "", "映射后概念": "" };

export function WorldViewWorkspace({
  title,
  value,
  dirty,
  saving,
  generating = false,
  locked = false,
  lockReason = "agent",
  titleAction,
  onChange,
  onSave,
  onCancel,
  onLockedEditAttempt,
}: WorldViewWorkspaceProps) {
  const mappings = Array.isArray(value["关键概念映射"]) ? value["关键概念映射"] : [];

  function updateDescription(description: string) {
    onChange({ ...value, "世界观描述": description });
  }

  function updateMapping(index: number, field: keyof WorldView["关键概念映射"][number], nextValue: string) {
    onChange({
      ...value,
      "关键概念映射": mappings.map((mapping, mappingIndex) => (
        mappingIndex === index ? { ...mapping, [field]: nextValue } : mapping
      )),
    });
  }

  function addMapping() {
    if (locked) {
      onLockedEditAttempt?.();
      return;
    }
    onChange({ ...value, "关键概念映射": [...mappings, { ...EMPTY_MAPPING }] });
  }

  function removeMapping(index: number) {
    if (locked) {
      onLockedEditAttempt?.();
      return;
    }
    onChange({ ...value, "关键概念映射": mappings.filter((_mapping, mappingIndex) => mappingIndex !== index) });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!locked) onSave();
  }

  return (
    <section className="glass-panel document-panel world-view-panel">
      <div className="document-toolbar">
        <div className="document-toolbar-title">
          <h1>{title}</h1>
          {titleAction}
        </div>
      </div>
      {generating ? (
        <PageLoading label="正在生成世界观" agentStage="world_view" />
      ) : (
        <>
          <form className="world-view-form" onSubmit={handleSubmit}>
            <fieldset disabled={locked || saving}>
              <section className="world-view-description-section" aria-labelledby="world-view-description-title">
                <div className="world-view-section-head">
                  <div className="world-view-section-copy">
                    <h2 id="world-view-description-title">世界观描述</h2>
                    <p>交代故事发生的环境、规则与核心冲突</p>
                  </div>
                </div>
                <label className="world-view-description-field">
                  <textarea
                    value={value["世界观描述"]}
                    onChange={(event) => updateDescription(event.target.value)}
                    placeholder=""
                    aria-label="世界观描述"
                  />
                </label>
              </section>

              <section className="world-view-mappings" aria-labelledby="world-view-mappings-title">
                <div className="world-view-section-head">
                  <div className="world-view-section-copy">
                    <h2 id="world-view-mappings-title">关键概念映射</h2>
                    <p>将原剧本概念转换为海外版本中的对应表达</p>
                  </div>
                  <button className="world-view-add-mapping" type="button" onClick={addMapping}>
                    <Plus size={15} />
                    添加映射
                  </button>
                </div>
                {mappings.length ? (
                  <div className="world-view-mapping-list">
                    {mappings.map((mapping, index) => (
                      <div className="world-view-mapping-row" key={index}>
                        <span className="world-view-mapping-index" aria-hidden="true">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <label className="world-view-mapping-field">
                          <span>原剧本概念</span>
                          <input
                            value={mapping["原剧本概念"]}
                            onChange={(event) => updateMapping(index, "原剧本概念", event.target.value)}
                            placeholder="例如：家族秘密"
                            aria-label={`第 ${index + 1} 条原剧本概念`}
                          />
                        </label>
                        <span className="world-view-mapping-arrow-wrap" aria-hidden="true">
                          <ArrowRight className="world-view-mapping-arrow" size={16} />
                        </span>
                        <label className="world-view-mapping-field">
                          <span>海外改编概念</span>
                          <input
                            value={mapping["映射后概念"]}
                            onChange={(event) => updateMapping(index, "映射后概念", event.target.value)}
                            placeholder="例如：品牌危机"
                            aria-label={`第 ${index + 1} 条海外改编概念`}
                          />
                        </label>
                        <button
                          className="world-view-remove-mapping"
                          type="button"
                          onClick={() => removeMapping(index)}
                          aria-label={`删除第 ${index + 1} 条映射`}
                          title="删除映射"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="world-view-empty-mappings">尚未添加概念映射</div>
                )}
              </section>
            </fieldset>

            {dirty && !locked ? (
              <div className="dirty-actions world-view-actions" aria-label="未保存修改操作">
                <button className="save-action" type="submit" disabled={saving}>
                  <Save size={13} />
                  {saving ? "保存中" : "保存"}
                </button>
                <button className="cancel-action" type="button" onClick={onCancel} disabled={saving}>取消</button>
              </div>
            ) : null}
          </form>
          {locked && lockReason === "agent" ? (
            <div className="world-view-locked" aria-live="polite">正在生成世界观</div>
          ) : null}
        </>
      )}
    </section>
  );
}
