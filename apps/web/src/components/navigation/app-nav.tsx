import Link from "next/link";
import { FileText, ListChecks, Settings2, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { User } from "@/lib/types";
import styles from "./app-nav.module.css";

export type AppNavPage = "workspace" | "preferences" | "batch-tasks" | "admin";

type AppNavEntry = {
  page: AppNavPage;
  href: string;
  label: string;
  icon: LucideIcon;
  visible: (user?: User | null) => boolean;
};

const APP_NAV_ENTRIES: readonly AppNavEntry[] = [
  { page: "workspace", href: "/workspace", label: "剧本工作台", icon: FileText, visible: () => true },
  { page: "preferences", href: "/preferences", label: "创作偏好", icon: Settings2, visible: () => true },
  {
    page: "batch-tasks",
    href: "/batch-tasks",
    label: "批量任务",
    icon: ListChecks,
    visible: (user) => Boolean(user?.permissions.includes("batch_tasks"))
  },
  {
    page: "admin",
    href: "/admin",
    label: "管理后台",
    icon: ShieldCheck,
    visible: (user) => Boolean(user?.permissions.some((permission) => permission.startsWith("admin:")))
  }
];

type AppNavProps = {
  current: AppNavPage;
  user?: User | null;
  compact?: boolean;
};

export function AppNav({ current, user, compact = false }: AppNavProps) {
  return (
    <nav className={compact ? `${styles.nav} ${styles.compact}` : styles.nav} aria-label="页面导航">
      {APP_NAV_ENTRIES.filter((entry) => entry.visible(user)).map((entry) => {
        const Icon = entry.icon;
        const isCurrent = entry.page === current;
        return (
          <Link
            key={entry.page}
            className={isCurrent ? `${styles.item} ${styles.current}` : styles.item}
            href={entry.href}
            aria-current={isCurrent ? "page" : undefined}
            aria-label={entry.label}
            title={entry.label}
          >
            <Icon size={15} />
            {compact ? null : <span>{entry.label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
