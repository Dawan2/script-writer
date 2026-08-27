"use client";

import { ChevronDown, ChevronUp, MessageCircle, Send, Trash2, X } from "lucide-react";
import { type FormEvent, type WheelEvent as ReactWheelEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "@/lib/date-time";
import type { DocumentCommentAnchor, DocumentCommentLayout, DocumentCommentMessage, DocumentCommentThread } from "@/lib/types";

export type PendingDocumentComment = {
  anchor: DocumentCommentAnchor;
};

type DocumentCommentPanelProps = {
  threads: DocumentCommentThread[];
  activeThreadId?: number | null;
  pendingComment: PendingDocumentComment | null;
  layout: DocumentCommentLayout;
  currentUserId?: number;
  onClose: () => void;
  onCancelPending: () => void;
  onCreate: (content: string) => Promise<void>;
  onReply: (threadId: number, content: string) => Promise<void>;
  onDeleteMessage: (threadId: number, messageId: number) => Promise<void>;
  onNavigateThread: (thread: DocumentCommentThread) => void;
  onContentScroll: (deltaY: number) => boolean;
};

function displayTime(value: string) {
  return formatDateTime(value, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function authorInitial(name: string) {
  return name.trim().slice(0, 1) || "我";
}

type CommentMessageProps = {
  message: DocumentCommentMessage;
  currentUserId?: number;
  onDelete: () => Promise<void>;
};

function CommentMessage({ message, currentUserId, onDelete }: CommentMessageProps) {
  const [deleting, setDeleting] = useState(false);
  const canDelete = currentUserId === message.author.id;

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className={message.is_root ? "document-comment-message root" : "document-comment-message"}>
      <header className="document-comment-message-head">
        <span className="document-comment-avatar" aria-hidden="true">{authorInitial(message.author.display_name)}</span>
        <span className="document-comment-author-meta">
          <strong>{message.author.display_name}</strong>
          <time dateTime={message.created_at}>{displayTime(message.created_at)}</time>
        </span>
        {canDelete ? (
          <button
            type="button"
            className="document-comment-delete"
            aria-label="删除这条评论"
            title="删除这条评论"
            disabled={deleting}
            onClick={() => void handleDelete()}
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </header>
      <p>{message.content}</p>
    </article>
  );
}

type ReplyComposerProps = {
  onSubmit: (content: string) => Promise<void>;
};

function ReplyComposer({ onSubmit }: ReplyComposerProps) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const value = content.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
      setContent("");
    } catch {
      // The workspace presents the request error in its persistent notice area.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="document-comment-reply" onSubmit={handleSubmit}>
      <textarea
        value={content}
        placeholder="补充评论"
        aria-label="补充评论"
        maxLength={4000}
        rows={2}
        onChange={(event) => setContent(event.target.value)}
      />
      <button type="submit" aria-label="发送补充评论" title="发送补充评论" disabled={!value || busy}>
        <Send size={15} />
      </button>
    </form>
  );
}

type NewCommentComposerProps = {
  pendingComment: PendingDocumentComment;
  onCreate: (content: string) => Promise<void>;
  onCancel: () => void;
};

function NewCommentComposer({ pendingComment, onCreate, onCancel }: NewCommentComposerProps) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const value = content.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onCreate(value);
      setContent("");
    } catch {
      // The workspace presents the request error in its persistent notice area.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="document-comment-card document-comment-new" onSubmit={handleSubmit}>
      <div className="document-comment-new-head">
        <span className="document-comment-new-icon" aria-hidden="true"><MessageCircle size={15} /></span>
        <strong>添加评论</strong>
      </div>
      <blockquote title={pendingComment.anchor.text}>{pendingComment.anchor.text}</blockquote>
      <textarea
        autoFocus
        value={content}
        placeholder="写下评论"
        aria-label="评论内容"
        maxLength={4000}
        rows={4}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="document-comment-new-actions">
        <button type="button" className="document-comment-cancel" onClick={onCancel}>取消</button>
        <button type="submit" className="document-comment-submit" disabled={!value || busy}>
          {busy ? "添加中" : "添加评论"}
        </button>
      </div>
    </form>
  );
}

type CommentThreadCardProps = {
  thread: DocumentCommentThread;
  active: boolean;
  currentUserId?: number;
  onReply: (threadId: number, content: string) => Promise<void>;
  onDeleteMessage: (threadId: number, messageId: number) => Promise<void>;
};

function CommentThreadCard({
  thread,
  active,
  currentUserId,
  onReply,
  onDeleteMessage
}: CommentThreadCardProps) {
  return (
    <section
      className={active ? "document-comment-card active" : "document-comment-card"}
      data-comment-card-id={thread.id}
    >
      <div className="document-comment-reference" title={thread.anchor.text}>
        {thread.anchor.text}
      </div>
      {thread.messages.map((message) => (
        <CommentMessage
          key={message.id}
          message={message}
          currentUserId={currentUserId}
          onDelete={() => onDeleteMessage(thread.id, message.id)}
        />
      ))}
      <ReplyComposer onSubmit={(content) => onReply(thread.id, content)} />
    </section>
  );
}

type CommentCardEntry = {
  key: string;
  anchorTop?: number;
  pendingComment?: PendingDocumentComment;
  thread?: DocumentCommentThread;
};

export function DocumentCommentPanel({
  threads,
  activeThreadId,
  pendingComment,
  layout,
  currentUserId,
  onClose,
  onCancelPending,
  onCreate,
  onReply,
  onDeleteMessage,
  onNavigateThread,
  onContentScroll
}: DocumentCommentPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardNodesRef = useRef(new Map<string, HTMLDivElement>());
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [scrollViewportTop, setScrollViewportTop] = useState(0);

  const entries = useMemo(() => {
    const next: CommentCardEntry[] = threads.map((thread) => ({
      key: `thread-${thread.id}`,
      anchorTop: layout.anchorTops[thread.id],
      thread
    }));
    if (pendingComment) {
      next.push({
        key: "pending",
        anchorTop: layout.pendingAnchorTop ?? Math.max(12, layout.scrollTop + 12),
        pendingComment
      });
    }

    next.sort((left, right) => {
      const leftTop = left.anchorTop ?? Number.MAX_SAFE_INTEGER;
      const rightTop = right.anchorTop ?? Number.MAX_SAFE_INTEGER;
      return leftTop - rightTop || left.key.localeCompare(right.key);
    });

    let fallbackTop = Math.max(layout.contentHeight, 12);
    return next.map((entry) => {
      if (entry.anchorTop !== undefined) return entry;
      const positionedEntry = { ...entry, anchorTop: fallbackTop };
      fallbackTop += 24;
      return positionedEntry;
    });
  }, [layout.anchorTops, layout.contentHeight, layout.pendingAnchorTop, layout.scrollTop, pendingComment, threads]);

  const entryKeys = entries.map((entry) => entry.key).join(",");
  const orderedThreads = entries.flatMap((entry) => entry.thread ? [entry.thread] : []);
  const activeThreadIndex = activeThreadId !== null && activeThreadId !== undefined
    ? orderedThreads.findIndex((thread) => thread.id === activeThreadId)
    : -1;
  const previousThread = activeThreadIndex >= 0
    ? orderedThreads[activeThreadIndex - 1]
    : [...entries].reverse().find((entry) => (
      entry.thread && (entry.anchorTop ?? Number.MAX_SAFE_INTEGER) < layout.scrollTop
    ))?.thread;
  const nextThread = activeThreadIndex >= 0
    ? orderedThreads[activeThreadIndex + 1]
    : entries.find((entry) => (
      entry.thread && (entry.anchorTop ?? Number.MAX_SAFE_INTEGER) >= layout.scrollTop
    ))?.thread;

  useLayoutEffect(() => {
    const nodes = [...cardNodesRef.current.entries()];
    if (!nodes.length) return;

    function measureCards() {
      setCardHeights((current) => {
        const next: Record<string, number> = {};
        let changed = Object.keys(current).length !== nodes.length;
        nodes.forEach(([key, node]) => {
          const height = Math.ceil(node.getBoundingClientRect().height);
          next[key] = height;
          if (current[key] !== height) changed = true;
        });
        return changed ? next : current;
      });
    }

    measureCards();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureCards);
    nodes.forEach(([, node]) => observer.observe(node));
    return () => observer.disconnect();
  }, [entryKeys]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const scrollElement = scroll;

    function updateScrollViewportTop() {
      const next = scrollElement.getBoundingClientRect().top;
      setScrollViewportTop((current) => Math.abs(current - next) > 0.5 ? next : current);
    }

    updateScrollViewportTop();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScrollViewportTop);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, []);

  const viewportOffset = (layout.viewportTop ?? 0) - scrollViewportTop;

  const positionedEntries = useMemo(() => {
    let previousBottom = 0;
    return entries.map((entry) => {
      const anchorTop = (entry.anchorTop ?? 12) + viewportOffset;
      const top = Math.max(12, anchorTop, previousBottom ? previousBottom + 12 : 0);
      previousBottom = top + (cardHeights[entry.key] ?? 0);
      return { ...entry, top };
    });
  }, [cardHeights, entries, viewportOffset]);

  const trackHeight = useMemo(() => {
    const cardsBottom = positionedEntries.reduce((bottom, entry) => (
      Math.max(bottom, entry.top + (cardHeights[entry.key] ?? 0))
    ), 0);
    return Math.max(layout.contentHeight, cardsBottom + 64, 1);
  }, [cardHeights, layout.contentHeight, positionedEntries]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const nextScrollTop = Math.min(layout.scrollTop, maxScrollTop);
    if (Math.abs(scroll.scrollTop - nextScrollTop) > 0.5) scroll.scrollTop = nextScrollTop;
  }, [layout.scrollTop, trackHeight]);

  useLayoutEffect(() => {
    if (!pendingComment) return;
    const scroll = scrollRef.current;
    const composer = cardNodesRef.current.get("pending");
    if (!scroll || !composer || !scroll.clientHeight) return;

    // Keep the new-comment form usable when its anchor sits near the bottom edge.
    const padding = 12;
    const top = composer.offsetTop;
    const bottom = top + composer.offsetHeight;
    const visibleTop = scroll.scrollTop + padding;
    const visibleBottom = scroll.scrollTop + scroll.clientHeight - padding;
    let nextScrollTop = scroll.scrollTop;

    if (top < visibleTop) nextScrollTop = top - padding;
    else if (bottom > visibleBottom) nextScrollTop = bottom - scroll.clientHeight + padding;

    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    nextScrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    if (Math.abs(scroll.scrollTop - nextScrollTop) > 0.5) scroll.scrollTop = nextScrollTop;
  }, [layout.scrollTop, pendingComment, positionedEntries, trackHeight]);

  useEffect(() => {
    if (threads.length || pendingComment) return;
    onClose();
  }, [onClose, pendingComment, threads.length]);

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    let deltaY = event.deltaY;
    if (!deltaY) return;

    if (event.target instanceof HTMLTextAreaElement) {
      const textarea = event.target;
      const canScrollUp = deltaY < 0 && textarea.scrollTop > 0;
      const canScrollDown = deltaY > 0
        && textarea.scrollTop + textarea.clientHeight < textarea.scrollHeight - 1;
      if (canScrollUp || canScrollDown) return;
    }

    if (event.deltaMode === 1) deltaY *= 16;
    else if (event.deltaMode === 2) deltaY *= event.currentTarget.clientHeight;
    if (onContentScroll(deltaY)) event.preventDefault();
  }

  return (
    <aside className="glass-panel document-comment-panel" aria-label="评论">
      <header className="document-comment-panel-head">
        <h2>评论</h2>
        {threads.length ? <span>{threads.length}</span> : null}
        {threads.length ? (
          <div className="document-comment-navigation" role="group" aria-label="评论导航">
            <button
              type="button"
              aria-label="上一条评论"
              title="上一条评论"
              disabled={!previousThread}
              onClick={() => previousThread && onNavigateThread(previousThread)}
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              aria-label="下一条评论"
              title="下一条评论"
              disabled={!nextThread}
              onClick={() => nextThread && onNavigateThread(nextThread)}
            >
              <ChevronDown size={16} />
            </button>
          </div>
        ) : null}
        <button type="button" aria-label="关闭评论" title="关闭评论" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="document-comment-scroll" ref={scrollRef} onWheel={handleWheel}>
        <div className="document-comment-card-track" style={{ minHeight: trackHeight }}>
          {positionedEntries.map((entry) => (
            <div
              className="document-comment-card-position"
              key={entry.key}
              ref={(node) => {
                if (node) cardNodesRef.current.set(entry.key, node);
                else cardNodesRef.current.delete(entry.key);
              }}
              style={{ top: entry.top }}
            >
              {entry.pendingComment ? (
                <NewCommentComposer
                  pendingComment={entry.pendingComment}
                  onCreate={onCreate}
                  onCancel={onCancelPending}
                />
              ) : entry.thread ? (
                <CommentThreadCard
                  thread={entry.thread}
                  active={entry.thread.id === activeThreadId}
                  currentUserId={currentUserId}
                  onReply={onReply}
                  onDeleteMessage={onDeleteMessage}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
