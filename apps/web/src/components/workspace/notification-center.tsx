"use client";

import { Bell, CheckCircle2, Megaphone, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/date-time";
import type { Notification } from "@/lib/types";


type NotificationCenterProps = {
  notifications: Notification[];
  hasUnread: boolean;
  compact?: boolean;
  onSelect: (notification: Notification) => void;
};


function notificationTime(value: string) {
  return formatDateTime(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }, "");
}


export function NotificationCenter({
  notifications,
  hasUnread,
  compact = false,
  onSelect
}: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function handleToggle() {
    setOpen((current) => !current);
  }

  return (
    <div className={`notification-shell${compact ? " compact" : ""}`} ref={shellRef}>
      <button
        ref={triggerRef}
        type="button"
        className={compact ? "rail-icon-button" : "icon-button"}
        aria-label={hasUnread ? "通知，有新提醒" : "通知"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="通知"
        onClick={handleToggle}
      >
        <Bell size={compact ? 16 : 18} />
        {hasUnread ? <span className="notification-unread-badge" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <section className="notification-panel" role="dialog" aria-label="消息列表">
          <header className="notification-panel-header">
            <strong>消息</strong>
            <span>{notifications.length} 条</span>
            <button type="button" aria-label="关闭消息" title="关闭" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </header>
          <div className="notification-list">
            {notifications.length ? notifications.map((notification) => (
              <button
                type="button"
                className={`notification-item${notification.read_at ? "" : " unread"}`}
                key={notification.id}
                onClick={() => {
                  setOpen(false);
                  onSelect(notification);
                }}
              >
                {notification.kind === "system" ? <Megaphone size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
                <span>
                  <strong>{notification.title}{notification.kind === "system" ? <em>系统通知</em> : null}</strong>
                  <small>{notification.message}</small>
                </span>
                <time dateTime={notification.created_at}>{notificationTime(notification.created_at)}</time>
              </button>
            )) : (
              <div className="notification-empty">暂时没有消息</div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
