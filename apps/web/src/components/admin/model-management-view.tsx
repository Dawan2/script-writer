"use client";

import { Bot, ExternalLink, ImagePlus, LoaderCircle, Pencil, Plus, RefreshCcw, Settings2, TestTube2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAdminModelConfig,
  deleteAdminModelConfig,
  getAdminModelManagement,
  testAdminModelConfig,
  updateAdminFunctionModelRoute,
  updateAdminFunctionModelRoutes,
  updateAdminModelConfig
} from "@/lib/admin-api";
import type { FunctionModelRoute, ModelApiProtocol, ModelConfig, ModelConfigTestResult, ModelConfigType, ModelThinkingLevel } from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import { PageLoading } from "@/components/ui/page-loading";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

type ManagementTab = "functions" | "models";
type EditorState = { mode: "create" | "edit"; model: ModelConfig | null };

type ModelDraft = {
  name: string;
  modelType: ModelConfigType;
  requestUrl: string;
  apiKey: string;
  modelName: string;
  apiProtocol: ModelApiProtocol;
  thinkingLevel: ModelThinkingLevel;
  imageSize: string;
  imageOutputFormat: ModelConfig["image_output_format"];
  imageWatermark: boolean;
  fallbackModelId: number | null;
  isEnabled: boolean;
};

const MODEL_TYPE_LABELS: Record<ModelConfigType, string> = {
  claude_code: "Claude Code 模型",
  image: "生图模型"
};

const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高"
};

const EMPTY_DRAFT: ModelDraft = {
  name: "",
  modelType: "claude_code",
  requestUrl: "",
  apiKey: "",
  modelName: "",
  apiProtocol: "anthropic",
  thinkingLevel: "medium",
  imageSize: "2K",
  imageOutputFormat: "png",
  imageWatermark: false,
  fallbackModelId: null,
  isEnabled: true
};

function modelDraft(model: ModelConfig | null): ModelDraft {
  if (!model) return { ...EMPTY_DRAFT };
  return {
    name: model.name,
    modelType: model.model_type,
    requestUrl: model.request_url,
    apiKey: "",
    modelName: model.model_name,
    apiProtocol: model.api_protocol,
    thinkingLevel: model.thinking_level,
    imageSize: model.image_size || "2K",
    imageOutputFormat: model.image_output_format,
    imageWatermark: model.image_watermark,
    fallbackModelId: model.fallback_model_id,
    isEnabled: model.is_enabled
  };
}

function readableDate(value: string | null) {
  return formatDateTime(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function modelDisplayName(model: ModelConfig) {
  return model.model_name ? `${model.name} (${model.model_name})` : model.name;
}

function routeKey(route: Pick<FunctionModelRoute, "scenario_key" | "action_key">) {
  return `${route.scenario_key}:${route.action_key}`;
}

function ModelEditor({
  editor,
  models,
  busy,
  onCancel,
  onSave
}: {
  editor: EditorState;
  models: ModelConfig[];
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: ModelDraft, apiKeyChanged: boolean) => void;
}) {
  const [draft, setDraft] = useState<ModelDraft>(() => modelDraft(editor.model));
  const [apiKeyChanged, setApiKeyChanged] = useState(false);
  const isNew = editor.mode === "create";
  const fallbackOptions = models.filter((model) => model.model_type === draft.modelType && model.id !== editor.model?.id && model.is_enabled);
  const valid = Boolean(draft.name.trim() && (draft.modelType !== "image" || (draft.requestUrl.trim() && draft.modelName.trim() && draft.imageSize.trim())));

  function update(patch: Partial<ModelDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  return (
    <AdminDialog
      title={isNew ? "新增模型" : `编辑「${editor.model?.name ?? "模型"}」`}
      confirmLabel={isNew ? "保存模型" : "保存修改"}
      confirmDisabled={!valid}
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => onSave(draft, apiKeyChanged)}
    >
      <div className={`${styles.formGrid} ${styles.modelFormGrid}`}>
        <label>
          <span>配置名称</span>
          <input value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如 高质量剧本模型" autoFocus />
        </label>
        <label>
          <span>模型类型</span>
          <select value={draft.modelType} disabled={!isNew} onChange={(event) => update({ modelType: event.target.value as ModelConfigType, fallbackModelId: null })}>
            <option value="claude_code">Claude Code 模型</option>
            <option value="image">生图模型</option>
          </select>
        </label>
        <label className={styles.modelFullField}>
          <span>请求地址</span>
          <input value={draft.requestUrl} onChange={(event) => update({ requestUrl: event.target.value })} placeholder={draft.modelType === "image" ? "https://example.com/api/v3" : "https://example.com"} />
        </label>
        <label className={styles.modelFullField}>
          <span>API Key</span>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => { setApiKeyChanged(true); update({ apiKey: event.target.value }); }}
            placeholder={editor.model?.api_key_configured ? "已保存，留空则不修改" : "输入 API Key"}
            autoComplete="new-password"
          />
        </label>
        <label className={draft.modelType === "image" ? "" : styles.modelFullField}>
          <span>模型名称</span>
          <input value={draft.modelName} onChange={(event) => update({ modelName: event.target.value })} placeholder={draft.modelType === "image" ? "例如 doubao-seedream-5.0-lite" : "例如 claude-sonnet-4-5"} />
        </label>
        {draft.modelType === "claude_code" ? (
          <>
            <label>
              <span>文本接口协议</span>
              <select value={draft.apiProtocol} onChange={(event) => update({ apiProtocol: event.target.value as ModelApiProtocol })}>
                <option value="anthropic">Anthropic Messages</option>
                <option value="openai">OpenAI Chat Completions</option>
              </select>
            </label>
            <label>
              <span>思考强度</span>
              <select value={draft.thinkingLevel} onChange={(event) => update({ thinkingLevel: event.target.value as ModelThinkingLevel })}>
                {Object.entries(THINKING_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              <span>图片尺寸</span>
              <input value={draft.imageSize} onChange={(event) => update({ imageSize: event.target.value })} placeholder="例如 2K 或 1024x1536" />
            </label>
            <label>
              <span>输出格式</span>
              <select value={draft.imageOutputFormat} onChange={(event) => update({ imageOutputFormat: event.target.value as ModelConfig["image_output_format"] })}>
                <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
              </select>
            </label>
          </>
        )}
        <label className={styles.modelCheckboxField}>
          <input type="checkbox" checked={draft.isEnabled} onChange={(event) => update({ isEnabled: event.target.checked })} />
          <span>启用此模型</span>
        </label>
        {draft.modelType === "image" ? (
          <label className={styles.modelCheckboxField}>
            <input type="checkbox" checked={!draft.imageWatermark} onChange={(event) => update({ imageWatermark: !event.target.checked })} />
            <span>去除水印</span>
          </label>
        ) : null}
        <label className={styles.modelFullField}>
          <span>兜底模型</span>
          <select value={draft.fallbackModelId ?? ""} onChange={(event) => update({ fallbackModelId: event.target.value ? Number(event.target.value) : null })}>
            <option value="">不设置</option>
            {fallbackOptions.map((model) => <option key={model.id} value={model.id}>{modelDisplayName(model)}</option>)}
          </select>
        </label>
      </div>
    </AdminDialog>
  );
}

export function AdminModelManagementView({ onNotice }: { onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<ManagementTab>("functions");
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [routes, setRoutes] = useState<FunctionModelRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingRoute, setSavingRoute] = useState<string | null>(null);
  const [savingRoutes, setSavingRoutes] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [testingModelId, setTestingModelId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<ModelConfigTestResult | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelConfig | null>(null);
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [modelTypeFilter, setModelTypeFilter] = useState<"" | ModelConfigType>("");
  const [selectedRouteKeys, setSelectedRouteKeys] = useState<Set<string>>(new Set());
  const [batchModelId, setBatchModelId] = useState("");
  const selectAllRoutesRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await getAdminModelManagement();
      setModels(payload.models);
      setRoutes(payload.routes);
      setSelectedRouteKeys((current) => new Set(
        [...current].filter((key) => payload.routes.some((route) => routeKey(route) === key))
      ));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "模型配置加载失败");
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => { void load(); }, [load]);

  const scenarios = useMemo(() => Array.from(new Set(routes.map((route) => route.scenario_label))), [routes]);
  const actions = useMemo(() => Array.from(new Set(routes.map((route) => route.action_label))), [routes]);
  const filteredRoutes = useMemo(() => routes.filter((route) => (
    (!scenarioFilter || route.scenario_label === scenarioFilter)
    && (!actionFilter || route.action_label === actionFilter)
    && (!modelFilter || String(route.model_config_id ?? "") === modelFilter)
  )), [actionFilter, modelFilter, routes, scenarioFilter]);
  const filteredModels = useMemo(() => models.filter((model) => !modelTypeFilter || model.model_type === modelTypeFilter), [modelTypeFilter, models]);
  const selectedRoutes = useMemo(
    () => routes.filter((route) => selectedRouteKeys.has(routeKey(route))),
    [routes, selectedRouteKeys]
  );
  const selectedRouteModelType = useMemo(() => {
    if (!selectedRoutes.length) return null;
    const [first] = selectedRoutes;
    return selectedRoutes.every((route) => route.model_type === first.model_type) ? first.model_type : null;
  }, [selectedRoutes]);
  const batchModelOptions = useMemo(
    () => models.filter((model) => model.is_enabled && model.model_type === selectedRouteModelType),
    [models, selectedRouteModelType]
  );
  const allVisibleRoutesSelected = filteredRoutes.length > 0 && filteredRoutes.every((route) => selectedRouteKeys.has(routeKey(route)));
  const someVisibleRoutesSelected = filteredRoutes.some((route) => selectedRouteKeys.has(routeKey(route)));

  useEffect(() => {
    if (selectAllRoutesRef.current) {
      selectAllRoutesRef.current.indeterminate = !allVisibleRoutesSelected && someVisibleRoutesSelected;
    }
  }, [allVisibleRoutesSelected, someVisibleRoutesSelected]);

  useEffect(() => {
    if (batchModelId && !batchModelOptions.some((model) => String(model.id) === batchModelId)) {
      setBatchModelId("");
    }
  }, [batchModelId, batchModelOptions]);

  async function changeRoute(route: FunctionModelRoute, modelConfigId: number) {
    const key = routeKey(route);
    if (route.model_config_id === modelConfigId || savingRoute || savingRoutes) return;
    setSavingRoute(key);
    try {
      const result = await updateAdminFunctionModelRoute(route.scenario_key, route.action_key, modelConfigId);
      setRoutes((current) => current.map((item) => item.scenario_key === route.scenario_key && item.action_key === route.action_key
        ? { ...item, ...result.route, updated_at: new Date().toISOString() }
        : item));
      onNotice(`已更新「${route.scenario_label} / ${route.action_label}」的模型`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "功能模型更新失败");
    } finally {
      setSavingRoute(null);
    }
  }

  function toggleRouteSelection(route: FunctionModelRoute) {
    const key = routeKey(route);
    setSelectedRouteKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllVisibleRoutes() {
    setSelectedRouteKeys((current) => {
      const next = new Set(current);
      if (allVisibleRoutesSelected) {
        filteredRoutes.forEach((route) => next.delete(routeKey(route)));
      } else {
        filteredRoutes.forEach((route) => next.add(routeKey(route)));
      }
      return next;
    });
  }

  async function applyBatchModel() {
    if (!batchModelId || !selectedRouteModelType || !selectedRoutes.length || savingRoute || savingRoutes) return;
    const modelConfigId = Number(batchModelId);
    const model = models.find((item) => item.id === modelConfigId);
    if (!model) return;
    setSavingRoutes(true);
    try {
      const result = await updateAdminFunctionModelRoutes({
        model_config_id: modelConfigId,
        route_keys: selectedRoutes.map((route) => ({
          scenario_key: route.scenario_key,
          action_key: route.action_key
        }))
      });
      const updatedByKey = new Map(result.routes.map((route) => [routeKey(route), route]));
      setRoutes((current) => current.map((route) => updatedByKey.get(routeKey(route)) ?? route));
      setSelectedRouteKeys(new Set());
      setBatchModelId("");
      onNotice(result.updated_count
        ? `已为 ${result.updated_count} 个动作配置「${modelDisplayName(model)}」`
        : "所选动作已使用该模型");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "批量配置模型失败");
    } finally {
      setSavingRoutes(false);
    }
  }

  async function saveModel(draft: ModelDraft, apiKeyChanged: boolean) {
    if (!editor || savingModel) return;
    setSavingModel(true);
    const base = {
      name: draft.name.trim(),
      request_url: draft.requestUrl.trim(),
      model_name: draft.modelName.trim(),
      api_protocol: draft.apiProtocol,
      thinking_level: draft.thinkingLevel,
      image_size: draft.imageSize.trim(),
      image_output_format: draft.imageOutputFormat,
      image_watermark: draft.imageWatermark,
      fallback_model_id: draft.fallbackModelId,
      is_enabled: draft.isEnabled
    };
    try {
      if (editor.mode === "create") {
        await createAdminModelConfig({ ...base, model_type: draft.modelType, api_key: draft.apiKey.trim() });
        onNotice("模型已添加，可在功能配置中选用");
      } else if (editor.model) {
        await updateAdminModelConfig(editor.model.id, apiKeyChanged ? { ...base, api_key: draft.apiKey.trim() } : base);
        onNotice("模型配置已保存，后续任务将使用新设置");
      }
      setEditor(null);
      await load();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "模型保存失败");
    } finally {
      setSavingModel(false);
    }
  }

  async function removeModel() {
    if (!deleteTarget || savingModel) return;
    setSavingModel(true);
    try {
      await deleteAdminModelConfig(deleteTarget.id);
      onNotice(`已删除「${deleteTarget.name}」`);
      setDeleteTarget(null);
      await load();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "模型删除失败");
    } finally {
      setSavingModel(false);
    }
  }

  async function testModel(model: ModelConfig) {
    if (testingModelId !== null || savingModel) return;
    setTestingModelId(model.id);
    setTestResult(null);
    try {
      const response = await testAdminModelConfig(model.id);
      setTestResult(response.result);
      setModels((current) => current.map((item) => item.id === model.id
        ? { ...item, last_tested_at: response.result.last_tested_at }
        : item));
      onNotice(`「${model.name}」${response.result.message}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "模型测试失败");
    } finally {
      setTestingModelId(null);
    }
  }

  if (loading && !models.length && !routes.length) return <PageLoading label="正在加载模型配置" />;

  return (
    <div className={`${styles.view} ${styles.modelManagementView}`} aria-busy={loading}>
      <div className={styles.viewToolbar}>
        <div className={styles.segmented} aria-label="模型管理页签">
          <button className={tab === "functions" ? styles.segmentedActive : ""} onClick={() => setTab("functions")}><Settings2 size={14} />功能配置</button>
          <button className={tab === "models" ? styles.segmentedActive : ""} onClick={() => setTab("models")}><Bot size={14} />模型配置</button>
        </div>
        <div className={styles.toolbarRight}>
          {tab === "models" ? <button className={styles.primaryButton} onClick={() => setEditor({ mode: "create", model: null })}><Plus size={16} />新增模型</button> : null}
          <button className={styles.iconButton} onClick={() => void load()} disabled={loading || Boolean(savingRoute) || savingRoutes || savingModel || testingModelId !== null} aria-label="刷新" title="刷新"><RefreshCcw size={16} /></button>
        </div>
      </div>

      {tab === "functions" ? (
        <>
          <div className={styles.modelFunctionControls}>
            <div className={styles.filterRow}>
              <select value={scenarioFilter} onChange={(event) => setScenarioFilter(event.target.value)}><option value="">全部场景</option>{scenarios.map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}><option value="">全部动作</option>{actions.map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}><option value="">全部模型</option>{models.map((model) => <option key={model.id} value={model.id}>{modelDisplayName(model)}</option>)}</select>
              <span className={styles.totalLabel}>{filteredRoutes.length} 个调用动作</span>
            </div>
            {selectedRoutes.length ? <div className={styles.modelRouteBulkToolbar}>
              <span className={styles.selectionCount}>已选 {selectedRoutes.length} 项</span>
              <select
                value={batchModelId}
                disabled={!selectedRouteModelType || savingRoute !== null || savingRoutes || !batchModelOptions.length}
                onChange={(event) => setBatchModelId(event.target.value)}
                aria-label="为所选动作选择模型"
              >
                <option value="">{selectedRouteModelType ? "选择要配置的模型" : "请分别选择同一类型的动作"}</option>
                {batchModelOptions.map((model) => <option key={model.id} value={model.id}>{modelDisplayName(model)}</option>)}
              </select>
              <button className={styles.secondaryButton} type="button" disabled={!batchModelId || !selectedRouteModelType || savingRoute !== null || savingRoutes} onClick={() => void applyBatchModel()}>应用模型</button>
            </div> : null}
          </div>
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.modelRouteTable}`}>
              <thead><tr><th className={styles.selectionColumn}><input ref={selectAllRoutesRef} type="checkbox" aria-label="全选当前功能动作" checked={allVisibleRoutesSelected} disabled={savingRoute !== null || savingRoutes || !filteredRoutes.length} onChange={toggleAllVisibleRoutes} /></th><th>场景</th><th>动作</th><th>模型</th><th>最近更新</th></tr></thead>
              <tbody>
                {filteredRoutes.map((route) => {
                  const key = routeKey(route);
                  const options = models.filter((model) => model.model_type === route.model_type && model.is_enabled);
                  return <tr key={key}>
                    <td className={styles.selectionColumn}><input type="checkbox" aria-label={`选择${route.scenario_label}${route.action_label}`} checked={selectedRouteKeys.has(key)} disabled={savingRoute !== null || savingRoutes} onChange={() => toggleRouteSelection(route)} /></td>
                    <td><span className={styles.routeScenario}>{route.scenario_label}</span></td>
                    <td>{route.action_label}</td>
                    <td>
                      <select
                        className={styles.routeModelSelect}
                        value={route.model_config_id ?? ""}
                        disabled={savingRoute !== null || savingRoutes || !options.length}
                        onChange={(event) => event.target.value && void changeRoute(route, Number(event.target.value))}
                        aria-label={`${route.scenario_label}${route.action_label}使用的模型`}
                      >
                        {!route.model_config_id ? <option value="">请选择模型</option> : null}
                        {options.map((model) => <option key={model.id} value={model.id}>{modelDisplayName(model)}</option>)}
                      </select>
                    </td>
                    <td><time>{readableDate(route.updated_at)}</time></td>
                  </tr>;
                })}
                {!filteredRoutes.length ? <tr><td colSpan={5} className={styles.emptyCell}>没有符合条件的功能配置</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p className={styles.modelApplyHint}>保存后，新发起的任务会使用所选模型。</p>
        </>
      ) : (
        <>
          <div className={styles.modelConfigurationControls}>
            <div className={styles.filterRow}>
              <select value={modelTypeFilter} onChange={(event) => setModelTypeFilter(event.target.value as "" | ModelConfigType)}>
                <option value="">全部模型类型</option><option value="claude_code">Claude Code 模型</option><option value="image">生图模型</option>
              </select>
              <span className={styles.totalLabel}>{filteredModels.length} 个模型</span>
            </div>
            {testResult ? <div className={styles.modelTestResult} role="status">
              <div><strong>{testResult.model_type === "image" ? "生图测试完成" : "Claude Code 测试完成"}</strong><span>{testResult.message}</span></div>
              {testResult.image_url ? <a className={styles.secondaryButton} href={testResult.image_url} target="_blank" rel="noreferrer"><ExternalLink size={14} />查看测试图片</a> : null}
              <button className={styles.iconButton} type="button" onClick={() => setTestResult(null)} aria-label="关闭测试结果" title="关闭"><X size={15} /></button>
            </div> : null}
          </div>
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.modelConfigTable}`}>
              <thead><tr><th>配置名称</th><th>类型</th><th>模型名称</th><th>思考强度</th><th>兜底模型</th><th>密钥</th><th>状态</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {filteredModels.map((model) => <tr key={model.id}>
                  <td><div className={styles.modelNameCell}><strong>{model.name}</strong>{model.last_tested_at ? <span className={styles.modelTestedBadge}>成功 {readableDate(model.last_tested_at)}</span> : null}</div></td>
                  <td><span className={`${styles.modelTypeBadge} ${model.model_type === "image" ? styles.modelTypeImage : ""}`}>{model.model_type === "image" ? <ImagePlus size={13} /> : <Bot size={13} />}{MODEL_TYPE_LABELS[model.model_type]}</span></td>
                  <td className={styles.mono}>{model.model_name || "使用现有设置"}</td>
                  <td>{model.model_type === "claude_code" ? THINKING_LABELS[model.thinking_level] : "--"}</td>
                  <td>{model.fallback_model_name ?? "--"}</td>
                  <td>{model.api_key_configured ? <span className={styles.configuredKey}>已保存</span> : <span className={styles.unconfiguredKey}>未填写</span>}</td>
                  <td><span className={`${styles.badge} ${model.is_enabled ? styles.modelEnabled : styles.modelDisabled}`}>{model.is_enabled ? "启用" : "停用"}</span></td>
                  <td><div className={styles.rowActions}><button className={styles.iconButton} onClick={() => void testModel(model)} disabled={testingModelId !== null || savingModel} aria-label={`测试${model.name}链接`} title={testingModelId === model.id ? "正在测试链接" : "测试链接"}>{testingModelId === model.id ? <LoaderCircle className={styles.modelTestSpinner} size={15} /> : <TestTube2 size={15} />}</button><button className={styles.iconButton} onClick={() => setEditor({ mode: "edit", model })} disabled={testingModelId !== null || savingModel} aria-label={`编辑${model.name}`} title="编辑"><Pencil size={15} /></button><button className={styles.iconButtonDanger} onClick={() => setDeleteTarget(model)} disabled={testingModelId !== null || savingModel} aria-label={`删除${model.name}`} title="删除"><Trash2 size={15} /></button></div></td>
                </tr>)}
                {!filteredModels.length ? <tr><td colSpan={8} className={styles.emptyCell}>暂无模型配置</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editor ? <ModelEditor editor={editor} models={models} busy={savingModel} onCancel={() => setEditor(null)} onSave={(draft, apiKeyChanged) => void saveModel(draft, apiKeyChanged)} /> : null}
      {deleteTarget ? <AdminDialog title={`删除「${deleteTarget.name}」`} confirmLabel="删除模型" destructive busy={savingModel} onCancel={() => setDeleteTarget(null)} onConfirm={() => void removeModel()}><p className={styles.dangerText}>删除后将无法恢复。正在被功能或兜底设置使用的模型不能删除。</p></AdminDialog> : null}
    </div>
  );
}
