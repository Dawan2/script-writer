const UNSAFE_FILE_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/gu;
const DOMESTIC_TARGET_REGIONS = new Set(["国内", "中国大陆", "China", "Mainland China"]);
const ADAPTATION_TASK_TYPES = new Set(["rewrite", "novel", "replicate"]);

export function hasCompletedFullScript(project, fullProgress) {
  const taskType = typeof project?.task_type === "string" ? project.task_type.trim() : "";
  return ADAPTATION_TASK_TYPES.has(taskType || "rewrite") && (
    fullProgress?.completed_once === true
    || ["completed", "approved", "stale"].includes(fullProgress?.status)
  );
}

export function shouldRenameScriptTitle(project) {
  const taskType = typeof project?.task_type === "string" ? project.task_type.trim() : "";
  return ["rewrite", "replicate"].includes(taskType || "rewrite");
}

export function projectScriptTitle(project) {
  return typeof project?.project_name === "string" ? project.project_name.trim() : "";
}

export function scriptTitle(outline) {
  return typeof outline?.["剧本名称"] === "string" ? outline["剧本名称"].trim() : "";
}

export function englishScriptTitle(outline) {
  return typeof outline?.["英文剧本名称"] === "string" ? outline["英文剧本名称"].trim() : "";
}

export function shouldIncludeEnglishScriptTitle(project) {
  const targetRegion = typeof project?.target_region === "string" ? project.target_region.trim() : "";
  return shouldRenameScriptTitle(project) && !DOMESTIC_TARGET_REGIONS.has(targetRegion);
}

function comparableTitle(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

export function rewrittenTitleIssue(title, sourceTitle) {
  if (!title) return "剧本名称必须是非空字符串";
  if (title.length > 80) return "剧本名称不得超过 80 个字符";
  if (!comparableTitle(title)) return "剧本名称至少包含一个文字或数字";
  const source = String(sourceTitle || "").trim();
  if (source && comparableTitle(title) === comparableTitle(source)) {
    return `剧本名称必须重新命名，不能沿用原剧本名称“${source}”`;
  }
  return "";
}

export function retainedProjectTitleIssue(title, project) {
  const expectedTitle = projectScriptTitle(project);
  if (!expectedTitle) return "非剧本改写或爆款复刻项目缺少项目名称，无法确定剧本名称";
  if (title !== expectedTitle) {
    return `非剧本改写或爆款复刻项目的剧本名称必须保持为项目名称“${expectedTitle}”，不得在故事梗概阶段重命名`;
  }
  return "";
}

export function englishScriptTitleIssue(title, { requiresEnglishTitle = true } = {}) {
  if (!requiresEnglishTitle) {
    return title ? "国内项目无需填写英文剧本名称" : "";
  }
  if (!title) return "海外项目缺少英文剧本名称；请依据中文剧本名称和目标地区补充自然、可发行的英文剧本名称";
  if (title.length > 80) return "英文剧本名称不得超过 80 个字符";
  if (/[^\p{Script=Latin}\p{N}\s\p{P}\p{S}]/u.test(title) || /[\p{Script=Han}]/u.test(title)) {
    return "英文剧本名称只能使用拉丁字母、数字、空格和常用标点";
  }
  if (!/\p{Script=Latin}/u.test(title)) return "英文剧本名称至少包含一个拉丁字母";
  return "";
}

export function safeScriptFileTitle(title) {
  return String(title || "").trim().replace(/\s+/gu, "-")
    .replace(UNSAFE_FILE_CHARACTERS, "-").slice(0, 80) || "未命名剧本";
}

export function outlineDocumentRelativePath(outline) {
  const title = scriptTitle(outline);
  return title ? `output/${safeScriptFileTitle(title)}-故事梗概.md` : "output/剧本大纲.md";
}

export function fullScriptRelativePath(outline) {
  const title = scriptTitle(outline);
  return title ? `output/${safeScriptFileTitle(title)}-剧本全稿.md` : "output/剧本全稿.md";
}

export function dialogueTranslationRelativePath(outline, userInput) {
  const project = userInput?.project && typeof userInput.project === "object" ? userInput.project : {};
  const title = scriptTitle(outline)
    || (typeof project.source_script?.display_name === "string" ? project.source_script.display_name.trim() : "")
    || (typeof project.project_name === "string" ? project.project_name.trim() : "");
  return title ? `output/${safeScriptFileTitle(title)}-台词译稿.md` : "output/台词译稿.md";
}

export function outlineDocumentHeading(outline) {
  return `# ${scriptTitle(outline)} - 故事梗概`;
}

export function fullScriptHeading(outline) {
  return `# ${scriptTitle(outline)} - 剧本全稿`;
}

export function dialogueTranslationHeading(outline, userInput) {
  const project = userInput?.project && typeof userInput.project === "object" ? userInput.project : {};
  const title = scriptTitle(outline)
    || (typeof project.source_script?.display_name === "string" ? project.source_script.display_name.trim() : "")
    || (typeof project.project_name === "string" ? project.project_name.trim() : "")
    || "未命名剧本";
  return `# ${title} - 台词译稿`;
}
