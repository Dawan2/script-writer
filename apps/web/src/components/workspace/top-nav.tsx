import { Bell, ChevronDown } from "lucide-react";
import type { User } from "@/lib/types";

type TopNavProps = {
  user?: User | null;
  onLogout?: () => void;
};

export function TopNav({ user, onLogout }: TopNavProps) {
  return (
    <header className="top-nav">
      <div className="brand-mark" aria-hidden="true">
        <img className="brand-logo" src="/logo.png" alt="" />
      </div>
      <div className="brand-copy">
        <strong>出海剧作家</strong>
      </div>
      <div className="nav-actions">
        <button className="icon-button" aria-label="通知">
          <Bell size={18} />
        </button>
        <button className="avatar-button" aria-label="用户菜单" onClick={onLogout}>
          <span className="avatar">{user?.display_name?.[0] ?? user?.username?.[0] ?? "赵"}</span>
          <ChevronDown size={16} />
        </button>
      </div>
    </header>
  );
}
