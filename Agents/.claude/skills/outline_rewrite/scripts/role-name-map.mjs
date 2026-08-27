export const ROLE_NAME_MAPPING_KEY = "关键角色名称映射";

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`3.1-outline.json 的${label}必须是非空字符串`);
  }
  return value.trim();
}

export function roleNameMappings(outline) {
  const mappings = outline?.[ROLE_NAME_MAPPING_KEY];
  if (!Array.isArray(mappings) || !mappings.length) {
    throw new Error(`3.1-outline.json 缺少${ROLE_NAME_MAPPING_KEY}`);
  }
  const englishNames = new Set();
  const localizedNames = new Set();
  return mappings.map((mapping, index) => {
    const label = `${ROLE_NAME_MAPPING_KEY}第 ${index + 1} 项`;
    const chineseName = requiredText(mapping?.["中文名称"], `${label}的中文名称`);
    const englishName = requiredText(mapping?.["英文名称"], `${label}的英文名称`);
    if (localizedNames.has(chineseName)) {
      throw new Error(`3.1-outline.json 的${ROLE_NAME_MAPPING_KEY}中文名称“${chineseName}”重复`);
    }
    if (englishNames.has(englishName.toLocaleLowerCase("en-US"))) {
      throw new Error(`3.1-outline.json 的${ROLE_NAME_MAPPING_KEY}英文名称“${englishName}”重复`);
    }
    localizedNames.add(chineseName);
    englishNames.add(englishName.toLocaleLowerCase("en-US"));
    return { chineseName, englishName };
  });
}

export function englishNameByChineseName(outline) {
  return new Map(roleNameMappings(outline).map(({ chineseName, englishName }) => [chineseName, englishName]));
}

export function targetDialogueNameIssues(outline, text, documentLabel) {
  const targetLines = String(text).split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[（(].+[）)]$/u.test(line));
  const issues = new Set();
  roleNameMappings(outline).forEach(({ chineseName, englishName }) => {
    if (targetLines.some((line) => line.includes(chineseName))) {
      issues.add(`${documentLabel}的目标语台词仍使用中文名称“${chineseName}”，请改为“${englishName}”`);
    }
  });
  return [...issues];
}
