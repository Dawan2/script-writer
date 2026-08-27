export type DateTimeValue = string | Date | null | undefined;

const LEGACY_SQLITE_UTC = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const DEFAULT_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
};

export function parseDateTime(value: DateTimeValue): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;

  const raw = value.trim();
  const source = LEGACY_SQLITE_UTC.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDateTime(
  value: DateTimeValue,
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE_TIME_OPTIONS,
  fallback = "--"
) {
  const parsed = parseDateTime(value);
  if (!parsed) return fallback;
  return new Intl.DateTimeFormat("zh-CN", options).format(parsed);
}
