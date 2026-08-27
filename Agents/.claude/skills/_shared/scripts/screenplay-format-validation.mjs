import fs from "node:fs/promises";

export function normalizeActionLineSpacing(text) {
  let repairedLineCount = 0;
  const content = String(text || "").replace(/^△(?=\S)/gmu, () => {
    repairedLineCount += 1;
    return "△ ";
  });
  return { content, repairedLineCount };
}

export async function normalizeActionLineSpacingFile(filePath) {
  const original = await fs.readFile(filePath, "utf8");
  const normalized = normalizeActionLineSpacing(original);
  if (normalized.repairedLineCount > 0) {
    await fs.writeFile(filePath, normalized.content, "utf8");
  }
  return normalized;
}

export function actionLineIssues(lines, label) {
  const actionLines = lines.filter((line) => line.startsWith("△"));
  const validActionLines = actionLines.filter((line) => /^△\s*\S/u.test(line));
  const emptyActionLines = actionLines.filter((line) => /^△\s*$/u.test(line));

  if (validActionLines.length === 0) {
    if (emptyActionLines.length > 0) {
      return [`${label}的动作行只有“△”标记，没有动作内容；请在“△”后写明具体可拍动作，例如“△ 玛雅推开房门。”`];
    }
    return [`${label}没有检测到可拍动作；请至少添加一行以“△ ”开头的具体动作，例如“△ 玛雅推开房门。”`];
  }
  if (emptyActionLines.length > 0) {
    return [`${label}有 ${emptyActionLines.length} 行空动作；“△”后必须填写具体可拍动作。`];
  }
  return [];
}
