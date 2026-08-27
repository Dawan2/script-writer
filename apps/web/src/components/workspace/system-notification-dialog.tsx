"use client";

import { BellRing, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatDateTime } from "@/lib/date-time";
import type { Notification } from "@/lib/types";

type SystemNotificationDialogProps = {
  notification: Notification;
  onClose: () => void;
};

function notificationTime(value: string) {
  return formatDateTime(value, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }, "");
}

export function SystemNotificationDialog({ notification, onClose }: SystemNotificationDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="system-notification-backdrop" role="presentation">
      <section className="system-notification-dialog" role="dialog" aria-modal="true" aria-labelledby="system-notification-title">
        <header className="system-notification-dialog-header">
          <span className="system-notification-dialog-icon"><BellRing size={20} aria-hidden="true" /></span>
          <div>
            <span>系统通知</span>
            <time dateTime={notification.created_at}>{notificationTime(notification.created_at)}</time>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭通知" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="system-notification-dialog-body">
          <h2 id="system-notification-title">{notification.title}</h2>
          <p>{notification.message}</p>
        </div>
        <footer className="system-notification-dialog-footer">
          <button type="button" className="primary-action" onClick={onClose}>我知道了</button>
        </footer>
      </section>
    </div>
  );
}
