"use client";

import { Check, LoaderCircle, ShieldCheck, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  addProjectMemberPermission,
  getProjectMembers,
  removeProjectMemberPermission,
  setProjectMemberPermission
} from "@/lib/api-client";
import type { Project, ProjectMember } from "@/lib/types";

type ProjectPermissionsDialogProps = {
  project: Project;
  onClose: () => void;
};

type ProjectPermission = "view" | "edit";

function permissionLabel(permission: ProjectMember["access_level"]) {
  if (permission === "owner") return "项目所有者";
  return permission === "edit" ? "编辑" : "查看";
}

function sortMembers(members: ProjectMember[]) {
  return [...members].sort((left, right) => {
    if (left.is_owner !== right.is_owner) return left.is_owner ? -1 : 1;
    if (left.access_level !== right.access_level) return left.access_level === "edit" ? -1 : 1;
    return left.display_name.localeCompare(right.display_name, "zh-CN");
  });
}

function trapFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)")
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function ProjectPermissionsDialog({ project, onClose }: ProjectPermissionsDialogProps) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [username, setUsername] = useState("");
  const [newPermission, setNewPermission] = useState<ProjectPermission>("view");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busyMemberId, setBusyMemberId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  onCloseRef.current = onClose;
  busyRef.current = adding || busyMemberId !== null;

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setUsername("");

    void getProjectMembers(project.id)
      .then((payload) => {
        if (!current) return;
        setMembers(sortMembers(payload.members));
      })
      .catch((reason) => {
        if (!current) return;
        setError(reason instanceof Error ? reason.message : "成员权限加载失败");
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [project.id]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) onCloseRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  async function handleAddMember() {
    const normalizedUsername = username.trim();
    if (!normalizedUsername || adding || busyMemberId !== null) return;

    setAdding(true);
    setError("");
    try {
      const member = await addProjectMemberPermission(project.id, normalizedUsername, newPermission);
      setMembers((current) => sortMembers([
        ...current.filter((item) => item.id !== member.id),
        member
      ]));
      setUsername("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "添加成员失败");
    } finally {
      setAdding(false);
    }
  }

  async function handlePermissionChange(member: ProjectMember, permission: ProjectPermission) {
    if (member.access_level === permission || busyMemberId !== null) return;

    setBusyMemberId(member.id);
    setError("");
    try {
      const updated = await setProjectMemberPermission(project.id, member.id, permission);
      setMembers((current) => sortMembers(current.map((item) => item.id === member.id ? updated : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新权限失败");
    } finally {
      setBusyMemberId(null);
    }
  }

  async function handleRemoveMember(member: ProjectMember) {
    if (busyMemberId !== null) return;

    setBusyMemberId(member.id);
    setError("");
    try {
      await removeProjectMemberPermission(project.id, member.id);
      setMembers((current) => current.filter((item) => item.id !== member.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "移除成员失败");
    } finally {
      setBusyMemberId(null);
    }
  }

  const addingDisabled = loading || adding || busyMemberId !== null || username.trim().length < 2;

  return (
    <div
      className="modal-backdrop project-permissions-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !adding && busyMemberId === null) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="project-permissions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-permissions-title"
        aria-describedby="project-permissions-description"
        onKeyDown={(event) => trapFocus(event, dialogRef.current)}
      >
        <header className="project-permissions-header">
          <span className="project-permissions-mark" aria-hidden="true"><ShieldCheck size={20} /></span>
          <div>
            <span>项目协作</span>
            <h2 id="project-permissions-title">权限管理</h2>
            <p id="project-permissions-description" title={project.name}>{project.name}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="project-permissions-close"
            aria-label="关闭权限管理"
            title="关闭"
            disabled={adding || busyMemberId !== null}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="project-permissions-body" aria-busy={loading}>
          <section className="project-permissions-add" aria-labelledby="project-permissions-add-title">
            <div className="project-permissions-section-heading">
              <span className="project-permissions-section-icon" aria-hidden="true"><UserPlus size={15} /></span>
              <div>
                <h3 id="project-permissions-add-title">添加成员</h3>
                <p>输入对方的登录账号，并设置访问权限</p>
              </div>
            </div>
            <form
              className="project-permissions-add-controls"
              onSubmit={(event) => {
                event.preventDefault();
                void handleAddMember();
              }}
            >
              <input
                aria-label="用户账号"
                autoCapitalize="none"
                autoComplete="off"
                disabled={loading || adding || busyMemberId !== null}
                maxLength={40}
                minLength={2}
                placeholder="输入用户账号"
                spellCheck={false}
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  if (error) setError("");
                }}
              />
              <div className="project-permissions-segmented" role="group" aria-label="新增成员的权限">
                <button
                  type="button"
                  className={newPermission === "view" ? "active" : undefined}
                  disabled={loading || adding || busyMemberId !== null}
                  onClick={() => setNewPermission("view")}
                >
                  查看
                </button>
                <button
                  type="button"
                  className={newPermission === "edit" ? "active" : undefined}
                  disabled={loading || adding || busyMemberId !== null}
                  onClick={() => setNewPermission("edit")}
                >
                  编辑
                </button>
              </div>
              <button
                type="submit"
                className="project-permissions-add-button"
                disabled={addingDisabled}
              >
                {adding ? <LoaderCircle className="button-spinner" size={15} /> : <UserPlus size={15} />}
                {adding ? "正在添加" : "添加"}
              </button>
            </form>
          </section>

          <section className="project-permissions-members" aria-labelledby="project-permissions-members-title">
            <div className="project-permissions-members-heading">
              <div>
                <span className="project-permissions-section-icon" aria-hidden="true"><UsersRound size={15} /></span>
                <h3 id="project-permissions-members-title">已获权限的成员</h3>
              </div>
              {!loading ? <span>{members.length} 人</span> : null}
            </div>

            {loading ? (
              <div className="project-permissions-state"><LoaderCircle className="project-permissions-spinner" size={20} /><span>正在读取成员权限</span></div>
            ) : members.length ? (
              <div className="project-permissions-member-list">
                {members.map((member) => {
                  const memberBusy = busyMemberId === member.id;
                  return (
                    <div className="project-permissions-member" key={member.id} data-access={member.access_level}>
                      <span className="project-permissions-avatar" aria-hidden="true">{member.display_name[0] ?? member.username[0]}</span>
                      <div className="project-permissions-member-copy">
                        <strong>{member.display_name}</strong>
                        <span>{member.username}</span>
                      </div>
                      {member.is_owner ? (
                        <span className="project-permissions-owner"><Check size={13} />{permissionLabel(member.access_level)}</span>
                      ) : (
                        <div className="project-permissions-member-actions">
                          <select
                            aria-label={`设置${member.display_name}的权限`}
                            value={member.access_level}
                            disabled={memberBusy || adding}
                            onChange={(event) => void handlePermissionChange(member, event.target.value as ProjectPermission)}
                          >
                            <option value="view">查看</option>
                            <option value="edit">编辑</option>
                          </select>
                          <button
                            type="button"
                            className="project-permissions-remove"
                            aria-label={`移除${member.display_name}的权限`}
                            title="移除权限"
                            disabled={memberBusy || adding}
                            onClick={() => void handleRemoveMember(member)}
                          >
                            {memberBusy ? <LoaderCircle className="button-spinner" size={15} /> : <Trash2 size={15} />}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="project-permissions-state empty"><UsersRound size={20} /><span>还没有可访问此项目的成员</span></div>
            )}
          </section>

          {error ? <div className="project-permissions-error" role="alert">{error}</div> : null}
        </div>
      </section>
    </div>
  );
}
