import { CLIENT_ERROR_CODES } from "@/lib/error-codes";

export type ApiErrorCategory =
  | "auth"
  | "permission"
  | "input"
  | "conflict"
  | "capacity"
  | "billing"
  | "quality"
  | "runtime";

type ErrorEnvelope = {
  code?: unknown;
  category?: unknown;
  retryable?: unknown;
  message?: unknown;
  hint?: unknown;
  traceId?: unknown;
  details?: unknown;
};

const CATEGORIES: readonly ApiErrorCategory[] = [
  "auth",
  "permission",
  "input",
  "conflict",
  "capacity",
  "billing",
  "quality",
  "runtime"
];

/** 界面在读不到错误码时的兜底文案，与服务端注册表同一批措辞。 */
const UNREADABLE_RESPONSE = {
  message: "这次请求的返回内容无法读取。",
  hint: "重试一次；如果还不行，把提示里的追踪号发给客服。"
};

export class ApiError extends Error {
  readonly code: string;
  readonly category: ApiErrorCategory;
  readonly retryable: boolean;
  readonly hint: string;
  readonly traceId: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    category: ApiErrorCategory;
    retryable: boolean;
    message: string;
    hint: string;
    traceId: string;
    status: number;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.category = input.category;
    this.retryable = input.retryable;
    this.hint = input.hint;
    this.traceId = input.traceId;
    this.status = input.status;
    this.details = input.details;
  }
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function category(value: unknown): ApiErrorCategory | "" {
  return CATEGORIES.includes(value as ApiErrorCategory) ? (value as ApiErrorCategory) : "";
}

function envelopeOf(body: unknown): ErrorEnvelope | null {
  if (!body || typeof body !== "object") return null;
  const candidate = (body as { error?: unknown }).error;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as ErrorEnvelope;
}

/**
 * 把失败响应变成带错误码的错误对象。
 * 信封读不出来时给出 RESPONSE_UNREADABLE，文案里不带 HTTP 状态码。
 */
export function apiErrorFromResponse(
  status: number,
  body: unknown,
  traceIdHeader: string | null
): ApiError {
  const envelope = envelopeOf(body);
  const headerTraceId = text(traceIdHeader);
  const code = text(envelope?.code);
  const resolvedCategory = category(envelope?.category);
  const message = text(envelope?.message);

  if (!code || !resolvedCategory || !message) {
    return new ApiError({
      code: CLIENT_ERROR_CODES.RESPONSE_UNREADABLE,
      category: "runtime",
      retryable: true,
      message: UNREADABLE_RESPONSE.message,
      hint: UNREADABLE_RESPONSE.hint,
      traceId: headerTraceId || text(envelope?.traceId),
      status
    });
  }

  const details = envelope?.details;
  return new ApiError({
    code,
    category: resolvedCategory,
    retryable: envelope?.retryable === true,
    message,
    hint: text(envelope?.hint),
    traceId: headerTraceId || text(envelope?.traceId),
    status,
    details: details && typeof details === "object" ? (details as Record<string, unknown>) : undefined
  });
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** 按错误码分支的唯一入口，禁止对错误文案做字符串匹配。 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return isApiError(error) && error.code === code;
}
