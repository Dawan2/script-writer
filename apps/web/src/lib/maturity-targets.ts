export const MATURITY_TARGET_OPTIONS = [
  {
    label: "全年龄段（适合所有人）",
    value: "全年龄段影片，适合所有人"
  },
  {
    label: "PG-13（家长陪同）",
    value: "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头"
  },
  {
    label: "R（限制级）",
    value: "R限制级影片，允许大量血腥暴力、性爱画面、持续粗口、毒品描写"
  },
  {
    label: "NC-17（成人级）",
    value: "NC-17 ，成人级影片，允许露骨性爱、极端血腥"
  }
] as const;

export const DEFAULT_MATURITY_TARGET = MATURITY_TARGET_OPTIONS[1].value;
