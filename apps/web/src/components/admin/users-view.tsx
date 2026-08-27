"use client";

import { KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2, UserRound, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createAdminUser, deleteAdminUser, getAdminUsers, updateAdminUser } from "@/lib/admin-api";
import type { AdminRole, AdminUser } from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import type { User } from "@/lib/types";
import { PageLoading } from "@/components/ui/page-loading";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

type EditorState = { mode: "create" | "edit"; user?: AdminUser } | null;

function RoleBadges({ roles }: { roles: AdminUser["roles"] }) {
  if (!roles.length) return <span className={styles.cellSub}>未配置角色</span>;
  return (
    <div className={styles.userRoleBadges}>
      {roles.map((role) => <span key={role.id} className={`${styles.badge} ${role.code === "system_administrator" ? styles.badgeAdmin : ""}`}>{role.name}</span>)}
    </div>
  );
}

export function AdminUsersView({ currentUser, onNotice }: { currentUser: User; onNotice: (message: string) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [assignableRoles, setAssignableRoles] = useState<AdminRole[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [transferTo, setTransferTo] = useState<number | "">("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [roleIds, setRoleIds] = useState<number[]>([]);

  const load = useCallback(async (search = query) => {
    setLoading(true);
    try {
      const payload = await getAdminUsers(search);
      setUsers(payload.users);
      setAssignableRoles(payload.assignable_roles);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "用户加载失败");
    } finally {
      setLoading(false);
    }
  }, [onNotice, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 250);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const assignableRoleIds = useMemo(() => new Set(assignableRoles.map((role) => role.id)), [assignableRoles]);
  const systemAdminCount = users.filter((user) => user.roles.some((role) => role.code === "system_administrator")).length;
  const transferCandidates = useMemo(() => users.filter((user) => user.id !== deleteTarget?.id && user.is_active), [deleteTarget?.id, users]);
  const lockedRoles = useMemo(() => (
    editor?.user?.roles.filter((role) => !assignableRoleIds.has(role.id)) ?? []
  ), [assignableRoleIds, editor?.user?.roles]);
  const roleRequired = editor?.mode === "create" && assignableRoles.length > 0 && roleIds.length === 0;

  function openCreate() {
    const defaultCreatorRole = assignableRoles.find((role) => role.code === "default_creator");
    setEditor({ mode: "create" });
    setUsername("");
    setDisplayName("");
    setPassword("");
    setRoleIds(defaultCreatorRole ? [defaultCreatorRole.id] : []);
  }

  function openEdit(user: AdminUser, resetPassword = false) {
    setEditor({ mode: "edit", user });
    setUsername(user.username);
    setDisplayName(user.display_name);
    setPassword("");
    setRoleIds(user.roles.filter((role) => assignableRoleIds.has(role.id)).map((role) => role.id));
    if (resetPassword) window.setTimeout(() => document.getElementById("admin-user-password")?.focus(), 0);
  }

  function toggleRole(roleId: number, checked: boolean) {
    setRoleIds((current) => checked
      ? [...current, roleId]
      : current.filter((id) => id !== roleId));
  }

  async function saveUser() {
    if (!editor || busy) return;
    setBusy(true);
    try {
      if (editor.mode === "create") {
        await createAdminUser({
          username: username.trim(),
          display_name: displayName.trim(),
          password,
          role_ids: roleIds
        });
        onNotice("用户已创建");
      } else if (editor.user) {
        await updateAdminUser(editor.user.id, {
          display_name: displayName.trim(),
          role_ids: roleIds,
          ...(password ? { password } : {})
        });
        onNotice("用户信息已更新");
      }
      setEditor(null);
      await load();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "用户保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      const result = await deleteAdminUser(deleteTarget.id, transferTo === "" ? undefined : transferTo);
      onNotice(result.transferred_projects ? `账号已删除，${result.transferred_projects} 个项目已移交` : "账号已删除");
      setDeleteTarget(null);
      setTransferTo("");
      await load();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "用户删除失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !users.length) return <PageLoading label="正在加载用户" />;

  return (
    <div className={styles.view}>
      <div className={styles.viewToolbar}>
        <div className={styles.searchBox}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户名或显示名称" /></div>
        <button className={styles.primaryButton} type="button" onClick={openCreate}><Plus size={16} />新增用户</button>
      </div>
      <div className={styles.summaryStrip}>
        <span><UserRound size={16} /><b>{users.length}</b>个账号</span>
        <span><ShieldCheck size={16} /><b>{systemAdminCount}</b>位系统管理员</span>
        <span><UsersRound size={16} /><b>{users.reduce((sum, user) => sum + user.roles.length, 0)}</b>项角色分配</span>
        <span><KeyRound size={16} /><b>{users.reduce((sum, user) => sum + user.job_count, 0)}</b>次任务</span>
      </div>
      <div className={styles.tableWrap} aria-busy={loading}>
        <table className={styles.table}>
          <thead><tr><th>用户</th><th>角色</th><th>项目</th><th>已完成</th><th>Agent 任务</th><th>创建时间</th><th aria-label="操作" /></tr></thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td><div className={styles.personCell}><span>{user.display_name[0] ?? user.username[0]}</span><div><strong>{user.display_name}</strong><small>@{user.username}{user.id === currentUser.id ? " · 当前账号" : ""}</small></div></div></td>
                <td><RoleBadges roles={user.roles} /></td>
                <td>{user.project_count}</td><td>{user.completed_project_count}</td><td>{user.job_count}</td>
                <td><time>{formatDateTime(user.created_at, { year: "numeric", month: "2-digit", day: "2-digit" })}</time></td>
                <td><div className={styles.rowActions}>
                  <button className={styles.iconButton} type="button" onClick={() => openEdit(user)} aria-label={`编辑 ${user.display_name}`} title="编辑"><Pencil size={15} /></button>
                  <button className={styles.iconButton} type="button" onClick={() => openEdit(user, true)} aria-label={`重置 ${user.display_name} 的密码`} title="重置密码"><KeyRound size={15} /></button>
                  <button className={styles.iconButtonDanger} type="button" disabled={user.id === currentUser.id} onClick={() => { setDeleteTarget(user); setTransferTo(""); }} aria-label={`删除 ${user.display_name}`} title={user.id === currentUser.id ? "不能删除当前账号" : "删除"}><Trash2 size={15} /></button>
                </div></td>
              </tr>
            ))}
            {!loading && !users.length ? <tr><td colSpan={7} className={styles.emptyCell}>暂无用户</td></tr> : null}
          </tbody>
        </table>
      </div>

      {editor ? (
        <AdminDialog
          title={editor.mode === "create" ? "新增用户" : `编辑 ${editor.user?.display_name}`}
          confirmLabel={editor.mode === "create" ? "创建用户" : "保存修改"}
          busy={busy}
          confirmDisabled={!displayName.trim() || roleRequired || (editor.mode === "create" && (!username.trim() || password.length < 8))}
          onCancel={() => setEditor(null)}
          onConfirm={() => void saveUser()}
        >
          <div className={styles.formGrid}>
            <label><span>账号</span><input value={username} disabled={editor.mode === "edit"} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></label>
            <label><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <label className={styles.fullField}><span>{editor.mode === "create" ? "初始密码" : "重置密码"}</span><input id="admin-user-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editor.mode === "edit" ? "留空则不修改" : "至少 8 个字符"} autoComplete="new-password" /></label>
            <fieldset className={styles.roleAssignmentField}>
              <legend>角色</legend>
              {assignableRoles.length ? (
                <div className={styles.roleAssignmentList}>
                  {assignableRoles.map((role) => (
                    <label key={role.id} className={styles.roleAssignmentOption}>
                      <input type="checkbox" checked={roleIds.includes(role.id)} onChange={(event) => toggleRole(role.id, event.target.checked)} />
                      <span><strong>{role.name}</strong><small>{role.description || "未填写角色说明"}</small></span>
                    </label>
                  ))}
                </div>
              ) : <p className={styles.roleAssignmentEmpty}>当前账号没有可分配的角色。</p>}
              {lockedRoles.length ? <div className={styles.roleAssignmentLocked}>保留角色：{lockedRoles.map((role) => role.name).join("、")}</div> : null}
              {roleRequired ? <p className={styles.roleAssignmentEmpty}>请至少选择一个角色。</p> : null}
            </fieldset>
          </div>
        </AdminDialog>
      ) : null}

      {deleteTarget ? (
        <AdminDialog title={`删除账号 @${deleteTarget.username}`} confirmLabel="移交并删除" destructive busy={busy} confirmDisabled={deleteTarget.project_count > 0 && transferTo === ""} onCancel={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()}>
          <div className={styles.deleteSummary}><strong>{deleteTarget.project_count}</strong><span>个项目将在删除账号前完成移交</span></div>
          {deleteTarget.project_count > 0 ? <label className={styles.field}><span>移交给</span><select value={transferTo} onChange={(event) => setTransferTo(event.target.value ? Number(event.target.value) : "")}><option value="">选择项目接收人</option>{transferCandidates.map((user) => <option key={user.id} value={user.id}>{user.display_name} (@{user.username})</option>)}</select></label> : null}
          <p className={styles.dangerText}>账号凭证、个人偏好和上传缓存将被永久删除。</p>
        </AdminDialog>
      ) : null}
    </div>
  );
}
