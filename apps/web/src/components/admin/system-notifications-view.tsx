"use client";

import { Megaphone, Plus, Send, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getAdminSystemNotifications, publishAdminSystemNotification } from "@/lib/admin-api";
import type { AdminSystemNotification } from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import { PageLoading } from "@/components/ui/page-loading";
import { AdminDialog } from "./admin-dialog";
import styles from "./admin.module.css";

function formatTime(value: string) {
  return formatDateTime(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function AdminSystemNotificationsView({ onNotice }: { onNotice: (message: string) => void }) {
  const [notifications, setNotifications] = useState<AdminSystemNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNotifications((await getAdminSystemNotifications()).notifications);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "系统通知加载失败");
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    void load();
  }, [load]);

  function openComposer() {
    setTitle("");
    setMessage("");
    setComposerOpen(true);
  }

  async function publish() {
    if (busy || !title.trim() || !message.trim()) return;
    setBusy(true);
    try {
      const result = await publishAdminSystemNotification({ title: title.trim(), message: message.trim() });
      setNotifications((current) => [result.notification, ...current]);
      setComposerOpen(false);
      onNotice(`通知已发送给 ${result.notification.recipient_count} 位用户`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "通知发送失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !notifications.length) return <PageLoading label="正在加载系统通知" />;

  return (
    <div className={`${styles.view} ${styles.systemNotificationsView}`}>
      <div className={styles.viewToolbar}>
        <div className={styles.systemNotificationIntro}>
          <Megaphone size={18} />
          <span>发布后，用户进入工作台会先看到通知，也可在消息列表中再次查看。</span>
        </div>
        <button className={styles.primaryButton} onClick={openComposer}><Plus size={16} />新建通知</button>
      </div>
      <div className={styles.summaryStrip}>
        <span><Megaphone size={16} /><b>{notifications.length}</b>条已发布</span>
        <span><UsersRound size={16} /><b>{notifications.reduce((total, notification) => total + notification.recipient_count, 0)}</b>人次已送达</span>
      </div>
      <div className={styles.tableWrap} aria-busy={loading}>
        <table className={`${styles.table} ${styles.systemNotificationTable}`}>
          <thead><tr><th>通知</th><th>发送对象</th><th>发布人</th><th>发布时间</th></tr></thead>
          <tbody>
            {notifications.map((notification) => (
              <tr key={notification.id}>
                <td>
                  <div className={styles.systemNotificationCell}>
                    <strong>{notification.title}</strong>
                    <small title={notification.message}>{notification.message}</small>
                  </div>
                </td>
                <td><span className={styles.systemRecipient}><UsersRound size={13} />全部用户 · {notification.recipient_count} 人</span></td>
                <td>{notification.created_by?.display_name ?? "已删除账号"}</td>
                <td><time dateTime={notification.published_at}>{formatTime(notification.published_at)}</time></td>
              </tr>
            ))}
            {!loading && !notifications.length ? <tr><td colSpan={4} className={styles.emptyCell}>尚未发布系统通知</td></tr> : null}
          </tbody>
        </table>
      </div>
      {composerOpen ? (
        <AdminDialog
          title="发布系统通知"
          confirmLabel="发布通知"
          busy={busy}
          confirmDisabled={!title.trim() || !message.trim()}
          onCancel={() => setComposerOpen(false)}
          onConfirm={() => void publish()}
        >
          <div className={styles.systemNotificationForm}>
            <label className={styles.field}>
              <span>通知标题</span>
              <input value={title} maxLength={120} autoFocus onChange={(event) => setTitle(event.target.value)} placeholder="例如：工作台将于本周更新" />
              <small>{title.length}/120</small>
            </label>
            <label className={styles.field}>
              <span>通知内容</span>
              <textarea value={message} maxLength={5000} rows={7} onChange={(event) => setMessage(event.target.value)} placeholder="填写需要告知所有用户的内容" />
              <small>{message.length}/5000</small>
            </label>
            <div className={styles.systemNotificationAudience}><UsersRound size={17} /><span>发布后将发送给所有当前可用的工作台用户。</span></div>
          </div>
        </AdminDialog>
      ) : null}
    </div>
  );
}
