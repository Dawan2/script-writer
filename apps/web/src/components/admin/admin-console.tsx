"use client";

import {
  Activity,
  BrainCircuit,
  CloudUpload,
  Coins,
  Cpu,
  FileClock,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  MapPinned,
  Megaphone,
  ScrollText,
  ShieldCheck,
  Users
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppNav } from "@/components/navigation/app-nav";
import type { User } from "@/lib/types";
import { AdminAuditView } from "./audit-view";
import { AdminAgentEvolutionView } from "./agent-evolution-view";
import { AdminDashboardView } from "./dashboard-view";
import { AdminModelManagementView } from "./model-management-view";
import { AdminCreditsView } from "./credits-view";
import { AdminJobsView } from "./jobs-view";
import { AdminProjectsView } from "./projects-view";
import { AdminRegionsView } from "./regions-view";
import { AdminScriptSyncView } from "./script-sync-view";
import { AdminScriptDistillationView } from "./script-distillation-view";
import { AdminSystemNotificationsView } from "./system-notifications-view";
import { AdminUsersView } from "./users-view";
import { AdminRoleManagementView } from "./role-management-view";
import styles from "./admin.module.css";

type AdminSection = "dashboard" | "users" | "roles" | "notifications" | "credits" | "regions" | "projects" | "models" | "scriptSync" | "distillation" | "jobs" | "evolution" | "audit";

const NAV_ITEMS: Array<{ key: AdminSection; label: string; permission: string; icon: typeof LayoutDashboard }> = [
  { key: "dashboard", label: "经营概览", permission: "admin:dashboard", icon: LayoutDashboard },
  { key: "users", label: "用户管理", permission: "admin:users", icon: Users },
  { key: "roles", label: "角色管理", permission: "admin:roles", icon: ShieldCheck },
  { key: "notifications", label: "系统通知", permission: "admin:notifications", icon: Megaphone },
  { key: "credits", label: "创作额度", permission: "admin:credits", icon: Coins },
  { key: "regions", label: "地区规则", permission: "admin:regions", icon: MapPinned },
  { key: "projects", label: "项目管理", permission: "admin:projects", icon: FolderKanban },
  { key: "models", label: "模型管理", permission: "admin:models", icon: Cpu },
  { key: "scriptSync", label: "剧本同步", permission: "admin:script_sync", icon: CloudUpload },
  { key: "distillation", label: "剧本蒸馏", permission: "admin:distillation", icon: FlaskConical },
  { key: "jobs", label: "任务运行", permission: "admin:jobs", icon: Activity },
  { key: "evolution", label: "Agent 进化", permission: "admin:evolution", icon: BrainCircuit },
  { key: "audit", label: "审计日志", permission: "admin:audit", icon: ScrollText }
];

export function AdminConsole({ user }: { user: User }) {
  const availableNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => user.permissions.includes(item.permission)),
    [user.permissions]
  );
  const [section, setSection] = useState<AdminSection>(() => availableNavItems[0]?.key ?? "dashboard");
  const [notice, setNotice] = useState<string | null>(null);
  const current = availableNavItems.find((item) => item.key === section) ?? availableNavItems[0] ?? NAV_ITEMS[0];

  useEffect(() => {
    if (!availableNavItems.some((item) => item.key === section) && availableNavItems[0]) {
      setSection(availableNavItems[0].key);
    }
  }, [availableNavItems, section]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((value) => value === message ? null : value), 3500);
  }, []);

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <img src="/logo.png" alt="" />
          <span>
            <strong>出海剧作家</strong>
            <small>ADMIN</small>
          </span>
        </div>
        <nav className={styles.nav} aria-label="后台导航">
          {availableNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.key} className={section === item.key ? styles.navActive : ""} onClick={() => setSection(item.key)}>
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className={styles.sidebarFooter}>
          <div className={styles.adminIdentity}>
            <span>{user.display_name?.[0] ?? user.username[0]}</span>
            <div><strong>{user.display_name}</strong><small>@{user.username}</small></div>
          </div>
        </div>
      </aside>
      <section className={styles.main}>
        <header className={styles.topbar}>
          <div>
            <current.icon size={19} />
            <h1>{current.label}</h1>
          </div>
          <AppNav current="admin" user={user} />
          <span className={styles.liveStatus}><i />系统在线</span>
        </header>
        <div className={styles.content}>
          {section === "dashboard" ? <AdminDashboardView onNotice={showNotice} /> : null}
          {section === "users" ? <AdminUsersView currentUser={user} onNotice={showNotice} /> : null}
          {section === "roles" ? <AdminRoleManagementView onNotice={showNotice} /> : null}
          {section === "notifications" ? <AdminSystemNotificationsView onNotice={showNotice} /> : null}
          {section === "credits" ? <AdminCreditsView onNotice={showNotice} /> : null}
          {section === "regions" ? <AdminRegionsView onNotice={showNotice} /> : null}
          {section === "projects" ? <AdminProjectsView onNotice={showNotice} /> : null}
          {section === "models" ? <AdminModelManagementView onNotice={showNotice} /> : null}
          {section === "scriptSync" ? <AdminScriptSyncView onNotice={showNotice} /> : null}
          {section === "distillation" ? <AdminScriptDistillationView onNotice={showNotice} /> : null}
          {section === "jobs" ? <AdminJobsView onNotice={showNotice} /> : null}
          {section === "evolution" ? <AdminAgentEvolutionView onNotice={showNotice} /> : null}
          {section === "audit" ? <AdminAuditView onNotice={showNotice} /> : null}
        </div>
      </section>
      {notice ? <div className={styles.toast} role="status"><FileClock size={16} />{notice}</div> : null}
    </main>
  );
}
