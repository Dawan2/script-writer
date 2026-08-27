import {
  Bold,
  Check,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Maximize2,
  MessageCircle,
  MessagesSquare,
  Minimize2,
  Palette,
  PenLine,
  Quote,
  Strikethrough,
  Underline
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import {
  getMarkdownHeadings,
  MARKDOWN_TEXT_COLORS,
  renderMarkdown,
  type MarkdownHeading,
  type MarkdownTextColor
} from "@/lib/markdown";
import { ReviewReport } from "@/components/workspace/review-report";
import { CharacterRelationshipMap } from "@/components/workspace/character-relationship-map";
import { AgentLoadingMessage } from "@/components/ui/agent-loading-message";
import type { CharacterRelationshipGraph, DocumentCommentAnchor, DocumentCommentLayout, DocumentCommentThread } from "@/lib/types";

type MarkdownMode = "preview" | "markdown";
type CharacterWorkspaceView = "profile" | "graph";

type MarkdownWorkspaceProps = {
  title: string;
  content: string;
  draft: string;
  mode: MarkdownMode;
  dirty: boolean;
  saving: boolean;
  locked?: boolean;
  lockReason?: "agent" | "archived" | "view";
  reviewVisual?: boolean;
  characterView?: CharacterWorkspaceView;
  relationshipGraph?: CharacterRelationshipGraph | null;
  loadingStage?: string;
  showSceneMarker?: boolean;
  titleAction?: ReactNode;
  titleSupplement?: ReactNode;
  bodyHeader?: ReactNode;
  comments?: DocumentCommentThread[];
  activeCommentId?: number | null;
  commentNavigationTarget?: { threadId: number } | null;
  pendingCommentAnchor?: DocumentCommentAnchor | null;
  commentPanelOpen?: boolean;
  onModeChange: (mode: MarkdownMode) => void;
  onCharacterViewChange?: (view: CharacterWorkspaceView) => void;
  onDraftChange: (content: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onCommentCreate?: (anchor: DocumentCommentAnchor) => void;
  onAddToConversation?: (anchor: DocumentCommentAnchor) => void;
  onCommentSelect?: (thread: DocumentCommentThread) => void;
  onOpenCommentPanel?: () => void;
  onCommentLayoutChange?: (layout: DocumentCommentLayout) => void;
  onScrollElementChange?: (element: HTMLElement | null) => void;
  onLockedEditAttempt?: () => void;
};

type MarkdownFormat = "heading-1" | "heading-2" | "heading-3" | "bold" | "italic" | "underline" | "strike" | "quote" | "bullet-list" | "ordered-list" | "code";

type CommentSelection = {
  anchor: DocumentCommentAnchor;
  popupX: number;
  popupY: number;
};

type CommentRange = {
  start: number;
  end: number;
};

type CommentViewportAnchor = {
  mode: MarkdownMode;
  offset: number;
  viewportY: number;
};

function colorIdFromElement(element: HTMLElement) {
  const className = Array.from(element.classList).find((name) => name.startsWith("md-color-"));
  if (className) return className.slice("md-color-".length);

  const value = (element.style.color || element.getAttribute("color") || "").replace(/\s/g, "").toLowerCase();
  return MARKDOWN_TEXT_COLORS.find((color) => {
    const hex = color.value.toLowerCase();
    const red = Number.parseInt(hex.slice(1, 3), 16);
    const green = Number.parseInt(hex.slice(3, 5), 16);
    const blue = Number.parseInt(hex.slice(5, 7), 16);
    return value === hex || value === `rgb(${red},${green},${blue})`;
  })?.id;
}

function inlineMarkdownFromNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\u00a0/g, " ");
  }
  if (!(node instanceof HTMLElement)) return "";

  const content = Array.from(node.childNodes).map(inlineMarkdownFromNode).join("");
  const tagName = node.tagName.toLowerCase();

  if (tagName === "strong" || tagName === "b") return `**${content}**`;
  if (tagName === "em" || tagName === "i") return `*${content}*`;
  if (tagName === "u") return `<u>${content}</u>`;
  if (tagName === "del" || tagName === "s" || tagName === "strike") return `~~${content}~~`;
  if (tagName === "code") return `\`${content.replace(/`/g, "\\`")}\``;
  if (tagName === "a") return `[${content}](${node.getAttribute("href") ?? ""})`;
  if (tagName === "br") return "  \n";
  if (tagName === "input" && node.getAttribute("type") === "checkbox") {
    return (node as HTMLInputElement).checked ? "[x] " : "[ ] ";
  }
  if (tagName === "span" || tagName === "font") {
    const colorId = colorIdFromElement(node);
    return colorId ? `<span class="md-color-${colorId}">${content}</span>` : content;
  }
  return content;
}

function inlineMarkdownFromElement(element: Element) {
  return Array.from(element.childNodes).map(inlineMarkdownFromNode).join("").trim();
}

function tableMarkdownFromElement(table: Element) {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) => (
    Array.from(row.querySelectorAll(":scope > th, :scope > td"))
      .map((cell) => inlineMarkdownFromElement(cell).replace(/\|/g, "\\|"))
  ));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
  const renderRow = (row: string[]) => `| ${row.join(" | ")} |`;
  return [renderRow(normalizedRows[0]), renderRow(Array.from({ length: width }, () => "---")), ...normalizedRows.slice(1).map(renderRow)].join("\n");
}

function blockMarkdownFromElement(element: Element): string {
  const tagName = element.tagName.toLowerCase();
  const inline = inlineMarkdownFromElement(element);

  if (/^h[1-6]$/.test(tagName)) return `${"#".repeat(Number(tagName.slice(1)))} ${inline}`;
  if (tagName === "p") return inline;
  if (tagName === "hr") return "---";
  if (tagName === "pre") {
    const code = element.querySelector("code");
    const language = Array.from(code?.classList ?? []).find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    return `\`\`\`${language}\n${code?.textContent ?? element.textContent ?? ""}\n\`\`\``;
  }
  if (tagName === "blockquote") {
    const content = Array.from(element.children).map(blockMarkdownFromElement).filter(Boolean).join("\n\n") || inline;
    return content.split("\n").map((line) => `> ${line}`).join("\n");
  }
  if (tagName === "ul" || tagName === "ol") {
    return Array.from(element.children)
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((item, index) => `${tagName === "ol" ? `${index + 1}.` : "-"} ${inlineMarkdownFromElement(item)}`)
      .join("\n");
  }
  if (tagName === "table") return tableMarkdownFromElement(element);
  if (tagName === "div" && element.classList.contains("markdown-table-scroll")) {
    const table = element.querySelector("table");
    return table ? tableMarkdownFromElement(table) : "";
  }
  if (element.children.length && Array.from(element.children).some((child) => /^(div|p|h[1-6]|ul|ol|blockquote|pre|table)$/.test(child.tagName.toLowerCase()))) {
    return Array.from(element.children).map(blockMarkdownFromElement).filter(Boolean).join("\n\n");
  }
  return inline;
}

function markdownFromEditable(root: HTMLElement) {
  return Array.from(root.children)
    .map(blockMarkdownFromElement)
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function leadingWhitespaceLength(value: string) {
  return value.length - value.trimStart().length;
}

function trailingWhitespaceLength(value: string) {
  return value.length - value.trimEnd().length;
}

function sharedSuffixLength(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[left.length - 1 - index] !== right[right.length - 1 - index]) return index;
  }
  return length;
}

function sharedPrefixLength(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}

function resolveCommentRange(content: string, anchor: DocumentCommentAnchor): CommentRange | null {
  if (!anchor.text) return null;
  if (
    anchor.start >= 0
    && anchor.end >= anchor.start
    && content.slice(anchor.start, anchor.end) === anchor.text
  ) {
    return { start: anchor.start, end: anchor.end };
  }

  const candidates: CommentRange[] = [];
  let cursor = content.indexOf(anchor.text);
  while (cursor !== -1) {
    candidates.push({ start: cursor, end: cursor + anchor.text.length });
    cursor = content.indexOf(anchor.text, cursor + Math.max(anchor.text.length, 1));
  }
  if (!candidates.length) return null;

  return candidates.reduce((best, candidate) => {
    const bestScore = sharedSuffixLength(content.slice(0, best.start), anchor.prefix)
      + sharedPrefixLength(content.slice(best.end), anchor.suffix);
    const candidateScore = sharedSuffixLength(content.slice(0, candidate.start), anchor.prefix)
      + sharedPrefixLength(content.slice(candidate.end), anchor.suffix);
    return candidateScore > bestScore ? candidate : best;
  });
}

function resolveOutlineCommentRange(content: string, anchor: DocumentCommentAnchor): CommentRange | null {
  const directRange = resolveCommentRange(content, anchor);
  if (directRange) return directRange;

  const selectedText = anchor.text.trim();
  if (!selectedText) return null;
  const expression = selectedText
    .split(/(\s+)/)
    .map((segment) => {
      if (/^\s+$/.test(segment)) return "(?:\\s|[-*+>#|])+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const match = new RegExp(expression).exec(content);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

function commentCountsByHeading(
  content: string,
  headings: MarkdownHeading[],
  comments: DocumentCommentThread[]
) {
  const counts = new Map<string, number>();
  if (!headings.length || !comments.length) return counts;

  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") lineStarts.push(index + 1);
  }
  const headingStarts = headings.map((heading) => ({
    id: heading.id,
    start: lineStarts[heading.line - 1] ?? content.length
  }));

  comments.forEach((thread) => {
    const range = resolveOutlineCommentRange(content, thread.anchor);
    if (!range) return;
    let headingId: string | undefined;
    for (const heading of headingStarts) {
      if (heading.start > range.start) break;
      headingId = heading.id;
    }
    if (headingId) counts.set(headingId, (counts.get(headingId) ?? 0) + 1);
  });

  return counts;
}

function rangeOffsetWithin(root: HTMLElement, range: Range, boundary: "start" | "end") {
  const before = range.cloneRange();
  before.selectNodeContents(root);
  if (boundary === "start") before.setEnd(range.startContainer, range.startOffset);
  else before.setEnd(range.endContainer, range.endOffset);
  return before.toString().length;
}

function lastRangeRect(range: Range) {
  const rects = Array.from(range.getClientRects());
  return rects.at(-1) ?? range.getBoundingClientRect();
}

function textareaCursorViewportPosition(textarea: HTMLTextAreaElement, offset: number) {
  const style = window.getComputedStyle(textarea);
  const textareaRect = textarea.getBoundingClientRect();
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  Object.assign(mirror.style, {
    border: style.border,
    boxSizing: style.boxSizing,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    overflowWrap: "break-word",
    padding: style.padding,
    pointerEvents: "none",
    position: "fixed",
    tabSize: style.tabSize,
    top: `${textareaRect.top - textarea.scrollTop}px`,
    transform: `translateX(${-textarea.scrollLeft}px)`,
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    width: `${textarea.clientWidth}px`,
    wordBreak: "break-word",
    zIndex: "-1"
  });
  mirror.style.left = `${textareaRect.left}px`;
  mirror.textContent = textarea.value.slice(0, offset);
  mirror.append(marker);
  document.body.append(mirror);
  const markerRect = marker.getBoundingClientRect();
  mirror.remove();
  return {
    x: Math.max(textareaRect.left + 8, Math.min(markerRect.left, textareaRect.right - 82)),
    y: markerRect.bottom + 6,
    anchorY: markerRect.top
  };
}

function previewOffsetAtPoint(root: HTMLElement, x: number, y: number) {
  const caretPosition = document.caretPositionFromPoint?.(x, y);
  if (caretPosition && (caretPosition.offsetNode === root || root.contains(caretPosition.offsetNode))) {
    const range = document.createRange();
    range.setStart(caretPosition.offsetNode, caretPosition.offset);
    range.collapse(true);
    return rangeOffsetWithin(root, range, "start");
  }

  const caretRange = document.caretRangeFromPoint?.(x, y);
  if (caretRange && (caretRange.startContainer === root || root.contains(caretRange.startContainer))) {
    return rangeOffsetWithin(root, caretRange, "start");
  }
  return null;
}

function previewOffsetViewportY(root: HTMLElement, offset: number) {
  const nodes = previewTextNodes(root);
  const totalLength = nodes.at(-1)?.end ?? 0;
  const clampedOffset = Math.max(0, Math.min(offset, totalLength));
  const entry = nodes.find((item) => clampedOffset >= item.start && clampedOffset < item.end)
    ?? nodes.at(-1);
  if (!entry) return null;

  const localOffset = Math.max(0, Math.min(clampedOffset - entry.start, entry.node.length));
  const range = document.createRange();
  range.setStart(entry.node, localOffset);
  range.collapse(true);
  const caretRect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (caretRect.top || caretRect.left || caretRect.height || caretRect.width) return caretRect.top;

  const characterRange = document.createRange();
  if (localOffset < entry.node.length) {
    characterRange.setStart(entry.node, localOffset);
    characterRange.setEnd(entry.node, localOffset + 1);
  } else if (localOffset > 0) {
    characterRange.setStart(entry.node, localOffset - 1);
    characterRange.setEnd(entry.node, localOffset);
  } else {
    return null;
  }
  return characterRange.getClientRects()[0]?.top ?? characterRange.getBoundingClientRect().top;
}

function sourceHighlightContent(draft: string, comments: DocumentCommentThread[], activeCommentId?: number | null) {
  const resolved = comments
    .flatMap((thread) => {
      const range = resolveCommentRange(draft, thread.anchor);
      return range ? [{ thread, range }] : [];
    })
    .sort((left, right) => left.range.start - right.range.start || left.range.end - right.range.end);
  const fragments: ReactNode[] = [];
  let cursor = 0;
  for (const { thread, range } of resolved) {
    if (range.start < cursor) continue;
    if (range.start > cursor) fragments.push(draft.slice(cursor, range.start));
    fragments.push(
      <mark
        className={thread.id === activeCommentId ? "document-comment-highlight active" : "document-comment-highlight"}
        key={`${thread.id}-${range.start}`}
      >
        {draft.slice(range.start, range.end)}
      </mark>
    );
    cursor = range.end;
  }
  if (cursor < draft.length || !fragments.length) fragments.push(draft.slice(cursor));
  return fragments;
}

function previewTextNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    nodes.push({ node: node as Text, start: offset, end: offset + text.length });
    offset += text.length;
    node = walker.nextNode();
  }
  return nodes;
}

function markdownSelectionDisplayText(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?(?:span|u|strong|em|del|code)[^>]*>/gi, "")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/^\s*(?:#{1,6}|>|[-*+])\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\\([\\`*_[\]{}()#+\-.!])/g, "$1");
}

function resolvePreviewCommentRange(content: string, anchor: DocumentCommentAnchor): CommentRange | null {
  if (
    anchor.preview_start !== null
    && anchor.preview_end !== null
    && content.slice(anchor.preview_start, anchor.preview_end) === anchor.text
  ) {
    return { start: anchor.preview_start, end: anchor.preview_end };
  }
  const direct = resolveCommentRange(content, anchor);
  if (direct) return direct;
  const displayText = markdownSelectionDisplayText(anchor.text);
  return displayText && displayText !== anchor.text
    ? resolveCommentRange(content, { ...anchor, start: -1, end: -1, text: displayText })
    : null;
}

function removePreviewCommentHighlights(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-comment-thread-id]").forEach((highlight) => {
    const parent = highlight.parentNode;
    if (!parent) return;
    while (highlight.firstChild) parent.insertBefore(highlight.firstChild, highlight);
    parent.removeChild(highlight);
    parent.normalize();
  });
}

function applyPreviewCommentHighlights(root: HTMLElement, comments: DocumentCommentThread[], activeCommentId?: number | null) {
  removePreviewCommentHighlights(root);
  comments.forEach((thread) => {
    const range = resolvePreviewCommentRange(root.textContent ?? "", thread.anchor);
    if (!range || range.end <= range.start) return;
    const nodes = previewTextNodes(root)
      .filter((entry) => entry.start < range.end && entry.end > range.start);
    for (const entry of [...nodes].reverse()) {
      const start = Math.max(range.start, entry.start) - entry.start;
      const end = Math.min(range.end, entry.end) - entry.start;
      if (end <= start) continue;
      const textRange = document.createRange();
      textRange.setStart(entry.node, start);
      textRange.setEnd(entry.node, end);
      const highlight = document.createElement("mark");
      highlight.className = thread.id === activeCommentId
        ? "document-comment-highlight active"
        : "document-comment-highlight";
      highlight.dataset.commentThreadId = String(thread.id);
      textRange.surroundContents(highlight);
    }
  });
}

function previewAnchorViewportY(root: HTMLElement, anchor: DocumentCommentAnchor) {
  const range = resolvePreviewCommentRange(root.textContent ?? "", anchor);
  if (!range || range.end <= range.start) return null;
  const nodes = previewTextNodes(root).filter((entry) => entry.start < range.end && entry.end > range.start);
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first || !last) return null;
  const domRange = document.createRange();
  domRange.setStart(first.node, Math.max(range.start, first.start) - first.start);
  domRange.setEnd(last.node, Math.min(range.end, last.end) - last.start);
  return domRange.getBoundingClientRect().top;
}

function previewCommentLayout(
  preview: HTMLElement,
  comments: DocumentCommentThread[],
  pendingCommentAnchor?: DocumentCommentAnchor | null
): DocumentCommentLayout {
  const previewTop = preview.getBoundingClientRect().top;
  const anchorTops: Record<number, number> = {};

  comments.forEach((thread) => {
    const highlight = preview.querySelector<HTMLElement>(`[data-comment-thread-id="${thread.id}"]`);
    if (!highlight) return;
    anchorTops[thread.id] = Math.max(0, highlight.getBoundingClientRect().top - previewTop + preview.scrollTop);
  });

  const pendingViewportY = pendingCommentAnchor ? previewAnchorViewportY(preview, pendingCommentAnchor) : null;
  return {
    anchorTops,
    contentHeight: preview.scrollHeight,
    pendingAnchorTop: pendingViewportY === null ? undefined : Math.max(0, pendingViewportY - previewTop + preview.scrollTop),
    scrollTop: preview.scrollTop,
    viewportTop: previewTop
  };
}

function sourceCommentLayout(
  textarea: HTMLTextAreaElement,
  draft: string,
  comments: DocumentCommentThread[],
  pendingCommentAnchor?: DocumentCommentAnchor | null
): DocumentCommentLayout {
  const textareaTop = textarea.getBoundingClientRect().top;
  const anchorTops: Record<number, number> = {};

  function anchorTop(anchor: DocumentCommentAnchor) {
    const range = resolveCommentRange(draft, anchor);
    if (!range) return undefined;
    const position = textareaCursorViewportPosition(textarea, range.start);
    return Math.max(0, position.anchorY - textareaTop + textarea.scrollTop);
  }

  comments.forEach((thread) => {
    const top = anchorTop(thread.anchor);
    if (top !== undefined) anchorTops[thread.id] = top;
  });

  return {
    anchorTops,
    contentHeight: textarea.scrollHeight,
    pendingAnchorTop: pendingCommentAnchor ? anchorTop(pendingCommentAnchor) : undefined,
    scrollTop: textarea.scrollTop,
    viewportTop: textareaTop
  };
}

function sourceLineRange(textarea: HTMLTextAreaElement, draft: string) {
  const start = draft.lastIndexOf("\n", Math.max(0, textarea.selectionStart - 1)) + 1;
  const nextBreak = draft.indexOf("\n", textarea.selectionEnd);
  return { start, end: nextBreak === -1 ? draft.length : nextBreak };
}

function transformSourceLines(format: MarkdownFormat, lines: string[]) {
  const matchers: Partial<Record<MarkdownFormat, RegExp>> = {
    quote: /^>\s?/,
    "bullet-list": /^[-*+]\s+/,
    "ordered-list": /^\d+[.)]\s+/
  };
  const headingLevel = format.startsWith("heading-") ? Number(format.slice(-1)) : null;
  const matcher = headingLevel ? new RegExp(`^#{${headingLevel}}\\s+`) : matchers[format];
  if (!matcher) return lines;
  const remove = lines.every((line) => !line.trim() || matcher.test(line));

  return lines.map((line, index) => {
    if (!line.trim()) return line;
    if (remove) return line.replace(matcher, "");
    if (headingLevel) return `${"#".repeat(headingLevel)} ${line.replace(/^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")}`;
    if (format === "quote") return `> ${line.replace(/^>\s?/, "")}`;
    if (format === "bullet-list") return `- ${line.replace(/^([-*+]\s+|\d+[.)]\s+)/, "")}`;
    return `${index + 1}. ${line.replace(/^([-*+]\s+|\d+[.)]\s+)/, "")}`;
  });
}

function formatSourceSelection(
  textarea: HTMLTextAreaElement,
  draft: string,
  format: MarkdownFormat,
  onDraftChange: (content: string) => void,
  color?: MarkdownTextColor
) {
  const lineFormats: MarkdownFormat[] = ["heading-1", "heading-2", "heading-3", "quote", "bullet-list", "ordered-list"];
  let start = textarea.selectionStart;
  let end = textarea.selectionEnd;
  let replacement: string;
  let selectionStart: number;
  let selectionEnd: number;

  if (lineFormats.includes(format)) {
    const range = sourceLineRange(textarea, draft);
    start = range.start;
    end = range.end;
    replacement = transformSourceLines(format, draft.slice(start, end).split("\n")).join("\n");
    selectionStart = start;
    selectionEnd = start + replacement.length;
  } else {
    const selected = draft.slice(start, end);
    const multilineCode = format === "code" && selected.includes("\n");
    const wrappers: Record<Exclude<MarkdownFormat, "heading-1" | "heading-2" | "heading-3" | "quote" | "bullet-list" | "ordered-list">, [string, string, string]> = {
      bold: ["**", "**", "加粗文字"],
      italic: ["*", "*", "斜体文字"],
      underline: ["<u>", "</u>", "下划线文字"],
      strike: ["~~", "~~", "删除线文字"],
      code: multilineCode ? ["```\n", "\n```", "代码"] : ["`", "`", "代码"]
    };
    const [open, close, placeholder] = color
      ? [`<span class="md-color-${color.id}">`, "</span>", "彩色文字"]
      : wrappers[format as keyof typeof wrappers];
    const content = selected || placeholder;
    replacement = `${open}${content}${close}`;
    selectionStart = start + open.length;
    selectionEnd = selectionStart + content.length;
  }

  onDraftChange(`${draft.slice(0, start)}${replacement}${draft.slice(end)}`);
  window.requestAnimationFrame(() => {
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(selectionStart, selectionEnd);
  });
}

type MarkdownOutlineProps = {
  headings: MarkdownHeading[];
  activeHeadingId?: string;
  commentCounts: ReadonlyMap<string, number>;
  onSelect: (heading: MarkdownHeading) => void;
};

function MarkdownOutline({ headings, activeHeadingId, commentCounts, onSelect }: MarkdownOutlineProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const scrollFrameRef = useRef<number | null>(null);

  function cancelScheduledActiveItemScroll() {
    if (scrollFrameRef.current === null) return;
    window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = null;
  }

  function scrollActiveItemIntoView() {
    cancelScheduledActiveItemScroll();
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const list = listRef.current;
      const activeItem = activeItemRef.current;
      if (!list || !activeItem) return;
      const listRect = list.getBoundingClientRect();
      const itemRect = activeItem.getBoundingClientRect();
      const centeredTop = list.scrollTop + itemRect.top - listRect.top - (list.clientHeight - activeItem.offsetHeight) / 2;
      list.scrollTo({ top: Math.max(0, centeredTop), behavior: "auto" });
    });
  }

  useEffect(() => () => cancelScheduledActiveItemScroll(), []);

  return (
    <nav
      className="markdown-outline"
      aria-label="Markdown 目录"
      onMouseEnter={scrollActiveItemIntoView}
    >
      <div
        className={headings.length > 36 ? "markdown-outline-rail dense" : "markdown-outline-rail"}
        aria-hidden="true"
        style={{ "--outline-count": Math.max(headings.length, 1) } as CSSProperties}
      >
        {headings.length ? headings.map((heading) => {
          const commentCount = commentCounts.get(heading.id) ?? 0;
          return (
            <button
              className={[
                "markdown-outline-node",
                `level-${heading.level}`,
                activeHeadingId === heading.id ? "active" : "",
                commentCount ? "has-comments" : ""
              ].filter(Boolean).join(" ")}
              key={heading.id}
              tabIndex={-1}
              onClick={() => onSelect(heading)}
              title={commentCount ? `${heading.text}，${commentCount} 条评论` : heading.text}
            >
              <span />
            </button>
          );
        }) : (
          <span className="markdown-outline-empty-dot" />
        )}
      </div>
      <div className="markdown-outline-popover">
        <div className="markdown-outline-head">
          <span>目录</span>
          <span>{headings.length}</span>
        </div>
        <div
          className="markdown-outline-list"
          ref={listRef}
          onPointerDown={cancelScheduledActiveItemScroll}
          onWheel={cancelScheduledActiveItemScroll}
        >
          {headings.length ? headings.map((heading) => {
            const commentCount = commentCounts.get(heading.id) ?? 0;
            return (
              <button
                className={[
                  "markdown-outline-item",
                  `level-${heading.level}`,
                  activeHeadingId === heading.id ? "active" : "",
                  commentCount ? "has-comments" : ""
                ].filter(Boolean).join(" ")}
                key={heading.id}
                ref={activeHeadingId === heading.id ? activeItemRef : undefined}
                onClick={() => onSelect(heading)}
              >
                <span className="outline-caret">{heading.level === 1 ? "⌄" : ""}</span>
                <span className="outline-title">{heading.text}</span>
                {commentCount ? <span className="outline-comment-count">{commentCount}条评论</span> : null}
                <span className="outline-level">H{heading.level}</span>
              </button>
            );
          }) : (
            <span className="markdown-outline-empty">暂无标题</span>
          )}
        </div>
      </div>
    </nav>
  );
}

type MarkdownFormatToolbarProps = {
  draft: string;
  mode: MarkdownMode;
  showSceneMarker: boolean;
  previewRef: React.RefObject<HTMLElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (content: string) => void;
};

function MarkdownFormatToolbar({ draft, mode, showSceneMarker, previewRef, textareaRef, onDraftChange }: MarkdownFormatToolbarProps) {
  const [colorOpen, setColorOpen] = useState(false);
  const savedPreviewRangeRef = useRef<Range | null>(null);
  const actions: { format: MarkdownFormat; label: string; icon: ReactNode }[] = [
    { format: "heading-1", label: "一级标题", icon: <Heading1 size={15} /> },
    { format: "heading-2", label: "二级标题", icon: <Heading2 size={15} /> },
    { format: "heading-3", label: "三级标题", icon: <Heading3 size={15} /> },
    { format: "bold", label: "加粗", icon: <Bold size={15} /> },
    { format: "italic", label: "斜体", icon: <Italic size={15} /> },
    { format: "underline", label: "下划线", icon: <Underline size={15} /> },
    { format: "strike", label: "删除线", icon: <Strikethrough size={15} /> },
    { format: "quote", label: "引用", icon: <Quote size={15} /> },
    { format: "bullet-list", label: "无序列表", icon: <List size={15} /> },
    { format: "ordered-list", label: "有序列表", icon: <ListOrdered size={15} /> },
    { format: "code", label: "代码", icon: <Code2 size={15} /> }
  ];

  function preserveSelection(event: React.MouseEvent<HTMLButtonElement>) {
    if (mode === "preview") {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && previewRef.current?.contains(range.commonAncestorContainer)) {
        savedPreviewRangeRef.current = range.cloneRange();
      }
    }
    event.preventDefault();
  }

  function applyPreviewFormat(format: MarkdownFormat, color?: MarkdownTextColor) {
    const preview = previewRef.current;
    if (!preview) return;

    preview.focus({ preventScroll: true });
    const selection = window.getSelection();
    const savedRange = savedPreviewRangeRef.current;
    if (selection && savedRange) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }

    if (color) {
      document.execCommand("foreColor", false, color.value);
    } else {
      const commands: Record<MarkdownFormat, [string, string | undefined]> = {
        "heading-1": ["formatBlock", "h1"],
        "heading-2": ["formatBlock", "h2"],
        "heading-3": ["formatBlock", "h3"],
        bold: ["bold", undefined],
        italic: ["italic", undefined],
        underline: ["underline", undefined],
        strike: ["strikeThrough", undefined],
        quote: ["formatBlock", "blockquote"],
        "bullet-list": ["insertUnorderedList", undefined],
        "ordered-list": ["insertOrderedList", undefined],
        code: ["formatBlock", "pre"]
      };
      const [command, value] = commands[format];
      document.execCommand(command, false, value);
    }

    onDraftChange(markdownFromEditable(preview));
    const nextSelection = window.getSelection();
    savedPreviewRangeRef.current = nextSelection?.rangeCount ? nextSelection.getRangeAt(0).cloneRange() : null;
  }

  function applyFormat(format: MarkdownFormat, color?: MarkdownTextColor) {
    if (mode === "markdown") {
      const textarea = textareaRef.current;
      if (textarea) formatSourceSelection(textarea, draft, format, onDraftChange, color);
    } else {
      applyPreviewFormat(format, color);
    }
    setColorOpen(false);
  }

  function insertSceneMarker() {
    if (mode === "markdown") {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      onDraftChange(`${draft.slice(0, start)}△${draft.slice(end)}`);
      window.requestAnimationFrame(() => {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(start + 1, start + 1);
      });
      return;
    }

    const preview = previewRef.current;
    if (!preview) return;
    preview.focus({ preventScroll: true });
    const selection = window.getSelection();
    const savedRange = savedPreviewRangeRef.current;
    if (selection && savedRange) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    document.execCommand("insertText", false, "△");
    onDraftChange(markdownFromEditable(preview));
    const nextSelection = window.getSelection();
    savedPreviewRangeRef.current = nextSelection?.rangeCount ? nextSelection.getRangeAt(0).cloneRange() : null;
  }

  return (
    <div className="markdown-format-toolbar" role="toolbar" aria-label="文本格式">
      <div className="markdown-format-group">
        {actions.slice(0, 3).map((action) => (
          <button
            type="button"
            key={action.format}
            aria-label={action.label}
            title={action.label}
            onMouseDown={preserveSelection}
            onClick={() => applyFormat(action.format)}
          >
            {action.icon}
          </button>
        ))}
      </div>
      <span className="markdown-format-divider" aria-hidden="true" />
      <div className="markdown-format-group">
        {actions.slice(3, 7).map((action) => (
          <button
            type="button"
            key={action.format}
            aria-label={action.label}
            title={action.label}
            onMouseDown={preserveSelection}
            onClick={() => applyFormat(action.format)}
          >
            {action.icon}
          </button>
        ))}
      </div>
      <span className="markdown-format-divider" aria-hidden="true" />
      <div className="markdown-format-group">
        {actions.slice(7).map((action) => (
          <button
            type="button"
            key={action.format}
            aria-label={action.label}
            title={action.label}
            onMouseDown={preserveSelection}
            onClick={() => applyFormat(action.format)}
          >
            {action.icon}
          </button>
        ))}
      </div>
      {showSceneMarker ? (
        <>
          <span className="markdown-format-divider" aria-hidden="true" />
          <div className="markdown-format-group">
            <button
              type="button"
              aria-label="插入动作标记 △"
              title="插入动作标记 △"
              onMouseDown={preserveSelection}
              onClick={insertSceneMarker}
            >
              △
            </button>
          </div>
        </>
      ) : null}
      <span className="markdown-format-divider" aria-hidden="true" />
      <div className="markdown-color-control">
        <button
          type="button"
          className={colorOpen ? "active" : ""}
          aria-label="文字颜色"
          aria-expanded={colorOpen}
          title="文字颜色"
          onMouseDown={preserveSelection}
          onClick={() => setColorOpen((current) => !current)}
        >
          <Palette size={15} />
        </button>
        {colorOpen ? (
          <div className="markdown-color-menu" role="menu" aria-label="选择文字颜色">
            {MARKDOWN_TEXT_COLORS.map((color) => (
              <button
                type="button"
                key={color.id}
                role="menuitem"
                aria-label={color.label}
                title={color.label}
                onMouseDown={preserveSelection}
                onClick={() => applyFormat("bold", color)}
              >
                <span style={{ backgroundColor: color.value }} />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type MarkdownSourceEditorProps = {
  draft: string;
  comments: DocumentCommentThread[];
  activeCommentId?: number | null;
  pendingCommentAnchor?: DocumentCommentAnchor | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (content: string) => void;
  onSelectionChange?: (selection: CommentSelection | null) => void;
  onCommentSelect?: (thread: DocumentCommentThread, offset: number, viewportY: number) => void;
  onCommentLayoutChange?: (layout: DocumentCommentLayout) => void;
};

function MarkdownSourceEditor({
  draft,
  comments,
  activeCommentId,
  pendingCommentAnchor,
  textareaRef,
  onDraftChange,
  onSelectionChange,
  onCommentSelect,
  onCommentLayoutChange
}: MarkdownSourceEditorProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const highlightsRef = useRef<HTMLPreElement>(null);
  const lineCount = Math.max(1, draft.split(/\r?\n/).length);
  const lineNumbers = Array.from({ length: lineCount }, (_, index) => index + 1);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    onCommentLayoutChange?.(sourceCommentLayout(textarea, draft, comments, pendingCommentAnchor));
  }, [comments, draft, onCommentLayoutChange, pendingCommentAnchor, textareaRef]);

  function updateSelection() {
    const textarea = textareaRef.current;
    if (!textarea || textarea.selectionStart === textarea.selectionEnd) {
      onSelectionChange?.(null);
      return;
    }
    const rawSelection = draft.slice(textarea.selectionStart, textarea.selectionEnd);
    const leading = leadingWhitespaceLength(rawSelection);
    const trailing = trailingWhitespaceLength(rawSelection);
    const text = rawSelection.trim();
    if (!text) {
      onSelectionChange?.(null);
      return;
    }
    const start = textarea.selectionStart + leading;
    const end = textarea.selectionEnd - trailing;
    const position = textareaCursorViewportPosition(textarea, end);
    onSelectionChange?.({
      anchor: {
        start,
        end,
        text,
        prefix: draft.slice(Math.max(0, start - 120), start),
        suffix: draft.slice(end, end + 120),
        preview_start: null,
        preview_end: null
      },
      popupX: position.x,
      popupY: position.y
    });
  }

  function selectCommentAtCursor() {
    const textarea = textareaRef.current;
    if (!textarea || textarea.selectionStart !== textarea.selectionEnd) return;
    const cursor = textarea.selectionStart;
    const thread = comments.find((item) => {
      const range = resolveCommentRange(draft, item.anchor);
      return Boolean(range && cursor >= range.start && cursor <= range.end);
    });
    if (!thread) return;
    onSelectionChange?.(null);
    onCommentSelect?.(thread, cursor, textareaCursorViewportPosition(textarea, cursor).anchorY);
  }

  function syncSourceScroll(textarea: HTMLTextAreaElement) {
    if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop;
    if (highlightsRef.current) {
      highlightsRef.current.scrollTop = textarea.scrollTop;
      highlightsRef.current.scrollLeft = textarea.scrollLeft;
    }
    onCommentLayoutChange?.(sourceCommentLayout(textarea, draft, comments, pendingCommentAnchor));
  }

  return (
    <div className="markdown-source-frame">
      <div className="markdown-line-gutter" ref={gutterRef} aria-hidden="true">
        {lineNumbers.map((line) => <span key={line}>{line}</span>)}
      </div>
      <div className="markdown-source-layer">
        <pre className="markdown-source-highlights" ref={highlightsRef} aria-hidden="true">
          {sourceHighlightContent(draft, comments, activeCommentId)}
        </pre>
        <textarea
          ref={textareaRef}
          className="markdown-source"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onClick={selectCommentAtCursor}
          onKeyUp={updateSelection}
          onPointerDown={() => onSelectionChange?.(null)}
          onPointerUp={updateSelection}
          onScroll={(event) => syncSourceScroll(event.currentTarget)}
        />
      </div>
    </div>
  );
}

type MarkdownPreviewFrameProps = {
  children: ReactNode;
  displayContent: string;
  editable?: boolean;
  previewRef: React.RefObject<HTMLElement | null>;
  onInput?: (event: FormEvent<HTMLElement>) => void;
  onScroll: () => void;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
};

function MarkdownPreviewFrame({
  children,
  displayContent,
  editable = false,
  previewRef,
  onInput,
  onScroll,
  onClick
}: MarkdownPreviewFrameProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const initialEditableChildrenRef = useRef(children);
  const lineCount = Math.max(1, displayContent.split(/\r?\n/).length);
  const lineNumbers = Array.from({ length: lineCount }, (_, index) => index + 1);

  return (
    <div className="markdown-preview-frame">
      <div className="markdown-line-gutter" ref={gutterRef} aria-hidden="true">
        {lineNumbers.map((line) => <span key={line}>{line}</span>)}
      </div>
      <article
        ref={previewRef}
        className={editable ? "markdown-preview markdown-preview-editable" : "markdown-preview"}
        contentEditable={editable || undefined}
        suppressContentEditableWarning={editable}
        onClick={onClick}
        onInput={onInput}
        onScroll={(event) => {
          if (event.target !== event.currentTarget) return;
          if (gutterRef.current) {
            gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }
          onScroll();
        }}
      >
        {editable ? initialEditableChildrenRef.current : children}
      </article>
    </div>
  );
}

export function MarkdownWorkspace({
  title,
  content,
  draft,
  mode,
  dirty,
  saving,
  locked = false,
  lockReason = "agent",
  reviewVisual = false,
  characterView,
  relationshipGraph,
  loadingStage,
  showSceneMarker = false,
  titleAction,
  titleSupplement,
  bodyHeader,
  comments = [],
  activeCommentId,
  commentNavigationTarget,
  pendingCommentAnchor,
  commentPanelOpen = false,
  onModeChange,
  onCharacterViewChange,
  onDraftChange,
  onSave,
  onCancel,
  onCommentCreate,
  onAddToConversation,
  onCommentSelect,
  onOpenCommentPanel,
  onCommentLayoutChange,
  onScrollElementChange,
  onLockedEditAttempt
}: MarkdownWorkspaceProps) {
  const [previewEditing, setPreviewEditing] = useState(false);
  const [lockCollapsed, setLockCollapsed] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | undefined>();
  const [pendingOutlineHeading, setPendingOutlineHeading] = useState<MarkdownHeading | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [commentSelection, setCommentSelection] = useState<CommentSelection | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const sourceTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previewSelectionInProgressRef = useRef(false);
  const commentViewportAnchorRef = useRef<CommentViewportAnchor | null>(null);
  const displayContent = dirty ? draft : content;
  const headings = useMemo(() => getMarkdownHeadings(displayContent), [displayContent]);
  const headingCommentCounts = useMemo(
    () => commentCountsByHeading(displayContent, headings, comments),
    [comments, displayContent, headings]
  );
  const previewContent = useMemo(
    () => renderMarkdown(displayContent, headings, { preserveLineBreaks: true }),
    [displayContent, headings]
  );

  useEffect(() => {
    setPreviewEditing(false);
    setPendingOutlineHeading(null);
    setCommentSelection(null);
  }, [title, mode]);

  useLayoutEffect(() => {
    const scrollElement = characterView === "graph"
      ? null
      : mode === "markdown" && !reviewVisual
        ? sourceTextareaRef.current
        : previewRef.current;
    onScrollElementChange?.(scrollElement);
    return () => onScrollElementChange?.(null);
  }, [characterView, mode, onScrollElementChange, previewEditing, reviewVisual, title]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview || mode === "markdown") return;
    applyPreviewCommentHighlights(preview, comments, activeCommentId);
    onCommentLayoutChange?.(previewCommentLayout(preview, comments, pendingCommentAnchor));
  }, [activeCommentId, comments, displayContent, mode, onCommentLayoutChange, pendingCommentAnchor, previewEditing]);

  useLayoutEffect(() => {
    const anchor = commentViewportAnchorRef.current;
    if (!commentPanelOpen || !anchor || anchor.mode !== mode) return;
    const scrollElement = mode === "markdown" ? sourceTextareaRef.current : previewRef.current;
    if (!scrollElement) return;
    const viewportAnchor: CommentViewportAnchor = anchor;
    const anchorScrollElement: HTMLElement = scrollElement;

    let frame: number | null = null;
    let settleTimer: number | null = null;

    function restoreAnchorPosition() {
      frame = null;
      const currentY = viewportAnchor.mode === "markdown"
        ? sourceTextareaRef.current
          ? textareaCursorViewportPosition(sourceTextareaRef.current, viewportAnchor.offset).anchorY
          : null
        : previewRef.current
          ? previewOffsetViewportY(previewRef.current, viewportAnchor.offset)
          : null;
      if (currentY === null) return;
      const delta = currentY - viewportAnchor.viewportY;
      if (Math.abs(delta) > 0.25) anchorScrollElement.scrollTop += delta;
    }

    function scheduleRestore() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(restoreAnchorPosition);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        restoreAnchorPosition();
        if (commentViewportAnchorRef.current === viewportAnchor) commentViewportAnchorRef.current = null;
      }, 180);
    }

    restoreAnchorPosition();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleRestore);
    observer?.observe(scrollElement);
    scheduleRestore();

    return () => {
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (commentViewportAnchorRef.current === viewportAnchor) commentViewportAnchorRef.current = null;
    };
  }, [commentPanelOpen, mode]);

  useLayoutEffect(() => {
    if (!commentNavigationTarget) return;
    const thread = comments.find((item) => item.id === commentNavigationTarget.threadId);
    if (!thread) return;

    if (mode === "markdown") {
      const textarea = sourceTextareaRef.current;
      const range = resolveCommentRange(draft, thread.anchor);
      if (!textarea || !range) return;
      const anchorY = textareaCursorViewportPosition(textarea, range.start).anchorY;
      textarea.scrollTop = Math.max(0, textarea.scrollTop + anchorY - textarea.getBoundingClientRect().top - 12);
      onCommentLayoutChange?.(sourceCommentLayout(textarea, draft, comments, pendingCommentAnchor));
      return;
    }

    const preview = previewRef.current;
    const highlight = preview?.querySelector<HTMLElement>(`[data-comment-thread-id="${thread.id}"]`);
    if (!preview || !highlight) return;
    const anchorTop = highlight.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop;
    preview.scrollTop = Math.max(0, anchorTop - 12);
    onCommentLayoutChange?.(previewCommentLayout(preview, comments, pendingCommentAnchor));
  }, [commentNavigationTarget]);

  useLayoutEffect(() => {
    const reportCommentLayout = onCommentLayoutChange;
    if (!reportCommentLayout || typeof ResizeObserver === "undefined") return;
    const scrollElement = mode === "markdown" ? sourceTextareaRef.current : previewRef.current;
    if (!scrollElement) return;
    let frame: number | null = null;

    function reportLayout() {
      frame = null;
      if (mode === "markdown") {
        const textarea = sourceTextareaRef.current;
        if (textarea) reportCommentLayout?.(sourceCommentLayout(textarea, draft, comments, pendingCommentAnchor));
        return;
      }
      const preview = previewRef.current;
      if (preview) reportCommentLayout?.(previewCommentLayout(preview, comments, pendingCommentAnchor));
    }

    const observer = new ResizeObserver(() => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(reportLayout);
    });
    observer.observe(scrollElement);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [comments, draft, displayContent, mode, onCommentLayoutChange, pendingCommentAnchor, previewEditing]);

  useEffect(() => {
    if ((!onCommentCreate && !onAddToConversation) || mode === "markdown") return;

    let selectionFrame: number | null = null;

    function updatePreviewSelection() {
      const preview = previewRef.current;
      const selection = window.getSelection();
      if (!preview || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setCommentSelection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!preview.contains(range.commonAncestorContainer)) {
        setCommentSelection(null);
        return;
      }
      const selectedText = selection.toString();
      const leading = leadingWhitespaceLength(selectedText);
      const trailing = trailingWhitespaceLength(selectedText);
      const text = selectedText.trim();
      if (!text) {
        setCommentSelection(null);
        return;
      }
      const previewStart = rangeOffsetWithin(preview, range, "start") + leading;
      const previewEnd = rangeOffsetWithin(preview, range, "end") - trailing;
      const sourceRange = resolveCommentRange(draft, {
        start: 0,
        end: 0,
        text,
        prefix: "",
        suffix: "",
        preview_start: previewStart,
        preview_end: previewEnd
      });
      const sourceStart = sourceRange?.start ?? 0;
      const sourceEnd = sourceRange?.end ?? text.length;
      const rect = lastRangeRect(range);
      setCommentSelection({
        anchor: {
          start: sourceStart,
          end: sourceEnd,
          text,
          prefix: sourceRange ? draft.slice(Math.max(0, sourceStart - 120), sourceStart) : "",
          suffix: sourceRange ? draft.slice(sourceEnd, sourceEnd + 120) : "",
          preview_start: previewStart,
          preview_end: previewEnd
        },
        popupX: Math.max(12, Math.min(rect.right, window.innerWidth - 220)),
        popupY: rect.bottom + 6
      });
    }

    function handleSelectionChange() {
      if (previewSelectionInProgressRef.current) return;
      updatePreviewSelection();
    }

    function handlePreviewPointerDown(event: PointerEvent) {
      const preview = previewRef.current;
      if (!preview || !(event.target instanceof Node) || !preview.contains(event.target)) return;
      if (selectionFrame !== null) {
        window.cancelAnimationFrame(selectionFrame);
        selectionFrame = null;
      }
      previewSelectionInProgressRef.current = true;
      setCommentSelection(null);
    }

    function handlePreviewPointerUp() {
      if (!previewSelectionInProgressRef.current) return;
      previewSelectionInProgressRef.current = false;
      selectionFrame = window.requestAnimationFrame(() => {
        selectionFrame = null;
        if (!previewSelectionInProgressRef.current) updatePreviewSelection();
      });
    }

    function handlePreviewPointerCancel() {
      if (!previewSelectionInProgressRef.current) return;
      previewSelectionInProgressRef.current = false;
      setCommentSelection(null);
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerdown", handlePreviewPointerDown);
    document.addEventListener("pointerup", handlePreviewPointerUp);
    document.addEventListener("pointercancel", handlePreviewPointerCancel);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerdown", handlePreviewPointerDown);
      document.removeEventListener("pointerup", handlePreviewPointerUp);
      document.removeEventListener("pointercancel", handlePreviewPointerCancel);
      if (selectionFrame !== null) window.cancelAnimationFrame(selectionFrame);
      previewSelectionInProgressRef.current = false;
    };
  }, [draft, mode, onAddToConversation, onCommentCreate]);

  useLayoutEffect(() => {
    if (!pendingOutlineHeading) return;

    const heading = headings.find((item) => item.id === pendingOutlineHeading.id);
    if (!heading) {
      setPendingOutlineHeading(null);
      return;
    }

    if (mode === "markdown") {
      const textarea = sourceTextareaRef.current;
      if (!textarea) return;
      const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
      textarea.scrollTo({ top: Math.max(0, (heading.line - 1) * lineHeight - 12), behavior: "auto" });
      textarea.focus({ preventScroll: true });
      setPendingOutlineHeading(null);
      return;
    }

    const preview = previewRef.current;
    const target = preview?.querySelector<HTMLElement>(`#${CSS.escape(heading.id)}`);
    if (!preview || !target) return;
    const targetTop = target.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop;
    preview.scrollTo({ top: Math.max(0, targetTop - 14), behavior: "auto" });
    setPendingOutlineHeading(null);
  }, [headings, mode, pendingOutlineHeading]);

  useEffect(() => {
    if (reviewVisual && mode !== "preview") {
      onModeChange("preview");
      setPreviewEditing(false);
      return;
    }
    if (!locked) {
      setLockCollapsed(false);
      return;
    }
    setPreviewEditing(false);
    if (mode !== "preview") {
      onModeChange("preview");
    }
  }, [locked, mode, onModeChange, reviewVisual]);

  useEffect(() => {
    setActiveHeadingId(headings[0]?.id);
  }, [headings]);

  useEffect(() => {
    if (!focusMode) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setFocusMode(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [focusMode]);

  function handleOutlineSelect(heading: MarkdownHeading) {
    setActiveHeadingId(heading.id);
    setPendingOutlineHeading(heading);
  }

  function handleModeRequest(nextMode: MarkdownMode) {
    if (locked && nextMode === "markdown") {
      onLockedEditAttempt?.();
      return;
    }
    onModeChange(nextMode);
  }

  function handlePreviewEditRequest() {
    if (locked) {
      onLockedEditAttempt?.();
      return;
    }
    setPreviewEditing((current) => !current);
  }

  function handlePreviewScroll() {
    const preview = previewRef.current;
    if (!preview) return;
    onCommentLayoutChange?.(previewCommentLayout(preview, comments, pendingCommentAnchor));
    if (!headings.length) return;
    const headingElements = headings
      .map((heading) => ({
        heading,
        element: preview.querySelector<HTMLElement>(`#${CSS.escape(heading.id)}`)
      }))
      .filter((item): item is { heading: MarkdownHeading; element: HTMLElement } => Boolean(item.element));

    const previewTop = preview.getBoundingClientRect().top;
    const current = headingElements.reduce((best, item) => {
      const offset = item.element.getBoundingClientRect().top - previewTop;
      if (offset <= 40) return item;
      return best;
    }, headingElements[0]);
    setActiveHeadingId(current?.heading.id);
  }

  function handlePreviewCommentClick(event: React.MouseEvent<HTMLElement>) {
    if (!window.getSelection()?.isCollapsed) return;
    const target = event.target instanceof Element ? event.target : null;
    const highlight = target?.closest<HTMLElement>("[data-comment-thread-id]");
    const threadId = Number(highlight?.dataset.commentThreadId);
    const thread = comments.find((item) => item.id === threadId);
    if (!highlight || !thread) return;
    event.preventDefault();
    setCommentSelection(null);
    if (!commentPanelOpen && onCommentSelect) {
      const preview = previewRef.current;
      const fallbackOffset = preview
        ? resolvePreviewCommentRange(preview.textContent ?? "", thread.anchor)?.start ?? null
        : null;
      const offset = preview ? previewOffsetAtPoint(preview, event.clientX, event.clientY) ?? fallbackOffset : null;
      const viewportY = preview && offset !== null ? previewOffsetViewportY(preview, offset) : null;
      if (offset !== null && viewportY !== null) {
        commentViewportAnchorRef.current = { mode: "preview", offset, viewportY };
      }
    }
    onCommentSelect?.(thread);
  }

  function handleSourceCommentSelect(thread: DocumentCommentThread, offset: number, viewportY: number) {
    if (!commentPanelOpen && onCommentSelect) {
      commentViewportAnchorRef.current = { mode: "markdown", offset, viewportY };
    }
    onCommentSelect?.(thread);
  }

  function handleCommentSelectionAction(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!commentSelection) return;
    onCommentCreate?.(commentSelection.anchor);
    window.getSelection()?.removeAllRanges();
    setCommentSelection(null);
  }

  function handleAddToConversationAction(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!commentSelection) return;
    onAddToConversation?.(commentSelection.anchor);
    window.getSelection()?.removeAllRanges();
    setCommentSelection(null);
  }

  function handleCancelChanges() {
    onCancel();
    if (previewEditing) setPreviewEditing(false);
  }

  const panelClassName = [
    "glass-panel",
    "document-panel",
    focusMode ? "focus-mode" : "",
    reviewVisual ? "review-mode" : ""
  ].filter(Boolean).join(" ");

  return (
    <section className={panelClassName}>
      <div className="document-toolbar">
        <div className="document-toolbar-title">
          {characterView && onCharacterViewChange ? (
            <div className="character-workspace-switch" role="group" aria-label="人物资料视图">
              <button
                type="button"
                className={characterView === "profile" ? "active" : ""}
                aria-pressed={characterView === "profile"}
                onClick={() => onCharacterViewChange("profile")}
              >
                人物小传
              </button>
              <button
                type="button"
                className={characterView === "graph" ? "active" : ""}
                aria-pressed={characterView === "graph"}
                onClick={() => onCharacterViewChange("graph")}
              >
                关系图谱
              </button>
            </div>
          ) : <><h1>{title}</h1>{titleSupplement}</>}
          {titleAction}
        </div>
        <div className="document-controls">
          {mode === "markdown" && !dirty && !saving ? (
            <span className="autosave">
              <Check size={12} />
              已保存
            </span>
          ) : null}
          {characterView !== "graph" ? (
            <div className="mode-controls">
              {comments.length && !commentPanelOpen && onOpenCommentPanel ? (
                <button
                  type="button"
                  className="document-comment-panel-toggle"
                  aria-label={`打开评论，共 ${comments.length} 条`}
                  title="打开评论"
                  onClick={onOpenCommentPanel}
                >
                  <MessageCircle size={15} />
                  <span className="document-comment-badge" aria-hidden="true" />
                </button>
              ) : null}
              {!reviewVisual && mode === "preview" ? (
                <button
                  className={previewEditing ? "preview-edit-toggle active" : "preview-edit-toggle"}
                  onClick={handlePreviewEditRequest}
                >
                  <PenLine size={12} />
                  {previewEditing ? "退出编辑" : "编辑"}
                </button>
              ) : null}
              {!reviewVisual ? <div className="mode-switch" aria-label="Markdown 显示模式">
                <button className={mode === "preview" ? "active" : ""} onClick={() => handleModeRequest("preview")}>
                  预览
                </button>
                <button className={mode === "markdown" ? "active" : ""} onClick={() => handleModeRequest("markdown")}>
                  Markdown
                </button>
              </div> : null}
            </div>
          ) : null}
          <button
            className="document-fullscreen-toggle"
            aria-label={focusMode ? "退出全屏查看" : "全屏查看"}
            onClick={() => setFocusMode((current) => !current)}
          >
            {focusMode ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>

      {reviewVisual ? (
        <div className="markdown-body-shell review-report-shell">
          <MarkdownOutline
            headings={headings}
            activeHeadingId={activeHeadingId}
            commentCounts={headingCommentCounts}
            onSelect={handleOutlineSelect}
          />
          <div
            className="review-report-scroll"
            ref={previewRef as React.RefObject<HTMLDivElement | null>}
            onClick={handlePreviewCommentClick}
            onScroll={handlePreviewScroll}
          >
            <ReviewReport content={displayContent} />
          </div>
        </div>
      ) : characterView === "graph" ? (
        <CharacterRelationshipMap graph={relationshipGraph} />
      ) : (
        <div className="document-body-stack">
          {bodyHeader}
          <div className="markdown-body-shell">
            <MarkdownOutline
              headings={headings}
              activeHeadingId={activeHeadingId}
              commentCounts={headingCommentCounts}
              onSelect={handleOutlineSelect}
            />
            <div className={`markdown-editor-stack${mode === "markdown" || previewEditing ? " editing" : ""}`}>
              {mode === "markdown" || previewEditing ? (
                <MarkdownFormatToolbar
                  draft={draft}
                  mode={mode}
                  showSceneMarker={showSceneMarker}
                  previewRef={previewRef}
                  textareaRef={sourceTextareaRef}
                  onDraftChange={onDraftChange}
                />
              ) : null}
              {mode === "markdown" ? (
                <MarkdownSourceEditor
                  draft={draft}
                  comments={comments}
                  activeCommentId={activeCommentId}
                  pendingCommentAnchor={pendingCommentAnchor}
                  textareaRef={sourceTextareaRef}
                  onDraftChange={onDraftChange}
                  onSelectionChange={setCommentSelection}
                  onCommentSelect={handleSourceCommentSelect}
                  onCommentLayoutChange={onCommentLayoutChange}
                />
              ) : previewEditing ? (
                <MarkdownPreviewFrame
                  key={`editable-${title}`}
                  displayContent={displayContent}
                  editable
                  previewRef={previewRef}
                  onInput={(event) => onDraftChange(markdownFromEditable(event.currentTarget))}
                  onScroll={handlePreviewScroll}
                  onClick={handlePreviewCommentClick}
                >
                  {previewContent}
                </MarkdownPreviewFrame>
              ) : (
                <MarkdownPreviewFrame
                  key={`preview-${title}`}
                  displayContent={displayContent}
                  previewRef={previewRef}
                  onScroll={handlePreviewScroll}
                  onClick={handlePreviewCommentClick}
                >
                  {previewContent}
                </MarkdownPreviewFrame>
              )}
            </div>
          </div>
        </div>
      )}

      {commentSelection && (onCommentCreate || onAddToConversation) && characterView !== "graph" ? (
        <div
          className="document-selection-actions"
          style={{ left: commentSelection.popupX, top: commentSelection.popupY }}
          role="toolbar"
          aria-label="已选文本操作"
          onMouseDown={(event) => event.preventDefault()}
        >
          {onCommentCreate ? (
            <button type="button" onClick={handleCommentSelectionAction}>
              <MessageCircle size={14} />
              评论
            </button>
          ) : null}
          {onAddToConversation ? (
            <button type="button" onClick={handleAddToConversationAction}>
              <MessagesSquare size={14} />
              添加到对话
            </button>
          ) : null}
        </div>
      ) : null}

      {locked && lockReason === "agent" && !lockCollapsed ? (
        <div className="document-agent-lock" aria-live="polite" aria-label="Agent 正在执行，文档暂不可编辑">
          <span className="document-lock-loader" aria-hidden="true" />
          {loadingStage ? (
            <AgentLoadingMessage stage={loadingStage} className="document-lock-subtitle" />
          ) : (
            <span className="document-lock-subtitle">内容正在处理中，请稍候。</span>
          )}
          <button
            className="document-lock-collapse"
            type="button"
            onClick={() => setLockCollapsed(true)}
          >
            收起
          </button>
        </div>
      ) : null}

      {dirty && !locked ? (
        <div className="dirty-actions" aria-label="未保存修改操作">
          <button className="save-action" onClick={onSave} disabled={saving}>
            <PenLine size={13} />
            {saving ? "保存中" : "保存"}
          </button>
          <button className="cancel-action" onClick={handleCancelChanges} disabled={saving}>取消</button>
        </div>
      ) : null}
    </section>
  );
}
