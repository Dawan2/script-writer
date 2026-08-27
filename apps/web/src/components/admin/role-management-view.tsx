"use client";

import { LoaderCircle, Pencil, Plus, Search, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createAdminRole,
  deleteAdminRole,
  getAdminRoleManagement,
  updateAdminRole
} from "@/lib/admin-api";
import type { AdminRole, RolePermissionCatalog } from "@/lib/admin-types";
import { PageLoading } from "@/components/ui/page-loading";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

type RoleEditor = { mode: "create" | "edit"; role?: AdminRole } | null;

function permissionSet(role: AdminRole) {
  return new Set(role.permission_keys);
}

function permissionsEditable(role: AdminRole) {
  return !role.is_system || role.code === "default_creator";
}

function RoleNameEditor({
  editor,
  busy,
  onCancel,
  onSave
}: {
  editor: Exclude<RoleEditor, null>;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(editor.role?.name ?? "");
  const [description, setDescription] = useState(editor.role?.description ?? "");
  const isNew = editor.mode === "create";

  return (
    <AdminDialog
      title={isNew ? "新增角色" : `编辑角色「${editor.role?.name ?? ""}」`}
      confirmLabel={isNew ? "新增角色" : "保存修改"}
      busy={busy}
      confirmDisabled={!name.trim()}
      onCancel={onCancel}
      onConfirm={() => onSave(name.trim(), description.trim())}
    >
      <div className={styles.formGrid}>
        <label className={styles.fullField}>
          <span>角色名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 内容运营" autoFocus />
        </label>
        <label className={styles.fullField}>
          <span>角色说明</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明该角色适合承担的工作（可选）" maxLength={200} />
        </label>
      </div>
    </AdminDialog>
  );
}

function PermissionCell({
  role,
  items,
  label,
  saving,
  onChange
}: {
  role: AdminRole;
  items: Array<{ label: string; permission_key: string }>;
  label: string;
  saving: boolean;
  onChange: (permissionKeys: string[]) => void;
}) {
  const permissions = permissionSet(role);
  const allSelected = items.length > 0 && items.every((item) => permissions.has(item.permission_key));
  const disabled = !permissionsEditable(role) || saving;

  function changeAll(checked: boolean) {
    const next = new Set(role.permission_keys);
    for (const item of items) {
      if (checked) next.add(item.permission_key);
      else next.delete(item.permission_key);
    }
    onChange([...next]);
  }

  function changePermission(permissionKey: string, checked: boolean) {
    const next = new Set(role.permission_keys);
    if (checked) next.add(permissionKey);
    else next.delete(permissionKey);
    onChange([...next]);
  }

  return (
    <div className={styles.rolePermissionCell} aria-label={`${role.name}的${label}权限`}>
      {items.length > 1 ? (
        <label className={styles.rolePermissionSelectAll}>
          <input type="checkbox" checked={allSelected} disabled={disabled} onChange={(event) => changeAll(event.target.checked)} />
          <span>全部</span>
        </label>
      ) : null}
      <div className={styles.rolePermissionItems}>
        {items.map((item) => (
          <label key={item.permission_key} className={styles.rolePermissionItem}>
            <input
              type="checkbox"
              checked={permissions.has(item.permission_key)}
              disabled={disabled}
              onChange={(event) => changePermission(item.permission_key, event.target.checked)}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function AdminRoleManagementView({ onNotice }: { onNotice: (message: string) => void }) {
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [catalog, setCatalog] = useState<RolePermissionCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingRoleId, setSavingRoleId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<number>>(new Set());
  const [editor, setEditor] = useState<RoleEditor>(null);
  const [deleteRoleIds, setDeleteRoleIds] = useState<number[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await getAdminRoleManagement();
      setCatalog(payload.catalog);
      setRoles(payload.roles);
      setSelectedRoleIds((current) => new Set([...current].filter((id) => payload.roles.some((role) => role.id === id && !role.is_system))));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "角色加载失败");
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => { void load(); }, [load]);

  const filteredRoles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return roles;
    return roles.filter((role) => (
      role.name.toLocaleLowerCase("zh-CN").includes(normalized)
      || role.description.toLocaleLowerCase("zh-CN").includes(normalized)
    ));
  }, [query, roles]);
  const editableRoles = useMemo(() => filteredRoles.filter((role) => !role.is_system), [filteredRoles]);
  const allEditableSelected = editableRoles.length > 0 && editableRoles.every((role) => selectedRoleIds.has(role.id));
  const selectedEditableRoles = useMemo(
    () => roles.filter((role) => selectedRoleIds.has(role.id) && !role.is_system),
    [roles, selectedRoleIds]
  );

  function replaceRole(nextRole: AdminRole) {
    setRoles((current) => current.map((role) => role.id === nextRole.id ? nextRole : role));
  }

  async function saveRolePermissions(role: AdminRole, permissionKeys: string[], notice?: string) {
    if (!permissionsEditable(role) || savingRoleId !== null) return;
    setSavingRoleId(role.id);
    try {
      const result = await updateAdminRole(role.id, { permission_keys: permissionKeys });
      replaceRole(result.role);
      if (notice) onNotice(notice);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "权限保存失败");
    } finally {
      setSavingRoleId(null);
    }
  }

  async function saveRoleName(name: string, description: string) {
    if (!editor || savingRoleId !== null) return;
    setSavingRoleId(editor.role?.id ?? -1);
    try {
      if (editor.mode === "create") {
        const result = await createAdminRole({ name, description });
        setRoles((current) => [...current, result.role].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")));
        onNotice("角色已新增，请继续勾选可使用的功能");
      } else if (editor.role) {
        const result = await updateAdminRole(editor.role.id, { name, description });
        replaceRole(result.role);
        onNotice("角色信息已更新");
      }
      setEditor(null);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "角色保存失败");
    } finally {
      setSavingRoleId(null);
    }
  }

  async function updateSelectedPermissions(permissionKeys: string[], selected: boolean, completeMessage: string) {
    if (!selectedEditableRoles.length || bulkBusy) return;
    setBulkBusy(true);
    const updated: AdminRole[] = [];
    const failures: string[] = [];
    for (const role of selectedEditableRoles) {
      const next = new Set(role.permission_keys);
      for (const permissionKey of permissionKeys) {
        if (selected) next.add(permissionKey);
        else next.delete(permissionKey);
      }
      try {
        const result = await updateAdminRole(role.id, { permission_keys: [...next] });
        updated.push(result.role);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : role.name);
      }
    }
    if (updated.length) {
      setRoles((current) => current.map((role) => updated.find((item) => item.id === role.id) ?? role));
      onNotice(`${completeMessage} ${updated.length} 个角色`);
    }
    if (failures.length) onNotice(failures[0]);
    setBulkBusy(false);
  }

  async function confirmDelete() {
    const ids = deleteRoleIds ?? [];
    if (!ids.length || bulkBusy) return;
    setBulkBusy(true);
    const removed: number[] = [];
    const failures: string[] = [];
    for (const roleId of ids) {
      try {
        await deleteAdminRole(roleId);
        removed.push(roleId);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "角色删除失败");
      }
    }
    if (removed.length) {
      setRoles((current) => current.filter((role) => !removed.includes(role.id)));
      setSelectedRoleIds((current) => new Set([...current].filter((id) => !removed.includes(id))));
      onNotice(`已删除 ${removed.length} 个角色`);
    }
    if (failures.length) onNotice(failures[0]);
    setDeleteRoleIds(null);
    setBulkBusy(false);
  }

  function toggleSelectedRole(roleId: number, checked: boolean) {
    setSelectedRoleIds((current) => {
      const next = new Set(current);
      if (checked) next.add(roleId);
      else next.delete(roleId);
      return next;
    });
  }

  function toggleAllEditable(checked: boolean) {
    setSelectedRoleIds((current) => {
      const next = new Set(current);
      for (const role of editableRoles) {
        if (checked) next.add(role.id);
        else next.delete(role.id);
      }
      return next;
    });
  }

  if (loading && !catalog) return <PageLoading label="正在加载角色权限" />;
  if (!catalog) return null;

  const scenarioPermissionKeys = catalog.scenarios.map((item) => item.permission_key);
  const adminPermissionKeys = catalog.admin.map((item) => item.permission_key);

  return (
    <div className={`${styles.view} ${styles.roleManagementView}`}>
      <div className={styles.viewToolbar}>
        <div className={styles.searchBox}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索角色名称或说明" /></div>
        <button className={styles.primaryButton} type="button" onClick={() => setEditor({ mode: "create" })}><Plus size={16} />新增角色</button>
      </div>

      <div className={styles.roleManagementSummary}>
        <div><ShieldCheck size={17} /><span><strong>{roles.length}</strong> 个角色</span></div>
        <div><UsersRound size={17} /><span><strong>{roles.reduce((total, role) => total + role.assigned_user_count, 0)}</strong> 次角色分配</span></div>
        <p>保存后，新的操作将按当前权限生效；正在处理的任务不受影响。</p>
      </div>

      <div className={styles.roleBulkBar}>
        <span className={styles.selectionCount}>已选择 {selectedEditableRoles.length} 个角色</span>
        <div className={styles.roleBulkActions}>
          <button type="button" className={styles.secondaryButton} disabled={!selectedEditableRoles.length || bulkBusy} onClick={() => void updateSelectedPermissions(scenarioPermissionKeys, true, "已授予全部场景给")}>授予全部场景</button>
          <button type="button" className={styles.secondaryButton} disabled={!selectedEditableRoles.length || bulkBusy} onClick={() => void updateSelectedPermissions(scenarioPermissionKeys, false, "已移除全部场景权限：")}>移除场景</button>
          <button type="button" className={styles.secondaryButton} disabled={!selectedEditableRoles.length || bulkBusy} onClick={() => void updateSelectedPermissions([catalog.batch_task.permission_key], true, "已启用批量任务：")}>启用批量任务</button>
          <button type="button" className={styles.secondaryButton} disabled={!selectedEditableRoles.length || bulkBusy} onClick={() => void updateSelectedPermissions([catalog.batch_task.permission_key], false, "已关闭批量任务：")}>关闭批量任务</button>
          <button type="button" className={styles.secondaryButton} disabled={!selectedEditableRoles.length || bulkBusy} onClick={() => void updateSelectedPermissions(adminPermissionKeys, true, "已授予全部后台功能给")}>授予后台功能</button>
          <button type="button" className={styles.dangerButton} disabled={!selectedEditableRoles.length || bulkBusy} onClick={() => setDeleteRoleIds(selectedEditableRoles.map((role) => role.id))}><Trash2 size={15} />删除所选</button>
        </div>
      </div>

      <div className={styles.tableWrap} aria-busy={loading || bulkBusy}>
        <table className={`${styles.table} ${styles.roleManagementTable}`}>
          <thead>
            <tr>
              <th className={styles.selectionColumn}><input type="checkbox" aria-label="选择当前列表中的全部自定义角色" checked={allEditableSelected} disabled={!editableRoles.length || bulkBusy} onChange={(event) => toggleAllEditable(event.target.checked)} /></th>
              <th>角色名称</th>
              <th>场景</th>
              <th>批量任务</th>
              <th>管理后台</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {filteredRoles.map((role) => {
              const saving = savingRoleId === role.id || bulkBusy;
              return (
                <tr key={role.id} className={role.is_system ? styles.roleSystemRow : undefined}>
                  <td className={styles.selectionColumn}>
                    <input type="checkbox" aria-label={`选择角色${role.name}`} checked={selectedRoleIds.has(role.id)} disabled={role.is_system || bulkBusy} onChange={(event) => toggleSelectedRole(role.id, event.target.checked)} />
                  </td>
                  <td>
                    <div className={styles.roleNameCell}>
                      <div>
                        <strong>{role.name}</strong>
                        {role.is_system ? <span className={styles.roleSystemBadge}>{permissionsEditable(role) ? "内置 · 权限可配置" : "内置"}</span> : null}
                      </div>
                      <small>{role.description || "暂未填写角色说明"}</small>
                      <span>{role.assigned_user_count} 位用户正在使用</span>
                    </div>
                  </td>
                  <td><PermissionCell role={role} items={catalog.scenarios} label="场景" saving={saving} onChange={(keys) => void saveRolePermissions(role, keys)} /></td>
                  <td><PermissionCell role={role} items={[catalog.batch_task]} label="批量任务" saving={saving} onChange={(keys) => void saveRolePermissions(role, keys)} /></td>
                  <td><PermissionCell role={role} items={catalog.admin} label="管理后台" saving={saving} onChange={(keys) => void saveRolePermissions(role, keys)} /></td>
                  <td>
                    <div className={styles.rowActions}>
                      {savingRoleId === role.id ? <LoaderCircle className={styles.roleSavingSpinner} size={16} aria-label="正在保存" /> : null}
                      <button className={styles.iconButton} type="button" disabled={role.is_system || saving} onClick={() => setEditor({ mode: "edit", role })} aria-label={`编辑${role.name}`} title={role.is_system ? (role.code === "default_creator" ? "默认创作者名称不可编辑" : "内置角色不可编辑") : "编辑角色名称"}><Pencil size={15} /></button>
                      <button className={styles.iconButtonDanger} type="button" disabled={role.is_system || saving || role.assigned_user_count > 0} onClick={() => setDeleteRoleIds([role.id])} aria-label={`删除${role.name}`} title={role.is_system ? "内置角色不可删除" : role.assigned_user_count ? "请先调整已分配用户的角色" : "删除角色"}><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && !filteredRoles.length ? <tr><td className={styles.emptyCell} colSpan={6}>未找到匹配的角色</td></tr> : null}
          </tbody>
        </table>
      </div>

      {editor ? <RoleNameEditor key={`${editor.mode}-${editor.role?.id ?? "new"}`} editor={editor} busy={savingRoleId !== null} onCancel={() => setEditor(null)} onSave={(name, description) => void saveRoleName(name, description)} /> : null}

      {deleteRoleIds ? (
        <AdminDialog title={deleteRoleIds.length === 1 ? "删除角色" : `删除 ${deleteRoleIds.length} 个角色`} confirmLabel="删除角色" destructive busy={bulkBusy} onCancel={() => setDeleteRoleIds(null)} onConfirm={() => void confirmDelete()}>
          <p className={styles.dangerText}>删除后，角色的权限配置将无法恢复。已分配给用户的角色需要先在用户管理中调整。</p>
        </AdminDialog>
      ) : null}
    </div>
  );
}
