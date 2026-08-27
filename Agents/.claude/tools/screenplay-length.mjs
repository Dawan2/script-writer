export const DEFAULT_EPISODE_DURATION_SECONDS = 90;
export const REFERENCE_EPISODE_DURATION_SECONDS = 90;
export const REFERENCE_MINIMUM_CHINESE_BODY_CHARACTERS = 600;

function numericValues(value) {
  return [...String(value || "").matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]))
    .filter((item) => Number.isFinite(item) && item > 0);
}

export function episodeDurationSeconds(value) {
  const text = String(value || "").trim();
  if (!text) return DEFAULT_EPISODE_DURATION_SECONDS;
  const minute = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min(?:ute)?s?)/iu);
  const second = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|sec(?:ond)?s?)/iu);
  if (minute && second) return Math.round(Number(minute[1]) * 60 + Number(second[1]));
  const values = numericValues(text);
  if (!values.length) return DEFAULT_EPISODE_DURATION_SECONDS;
  const minimum = Math.min(...values);
  const multiplier = /(分钟|分|min(?:ute)?s?)/iu.test(text) ? 60 : 1;
  return Math.max(1, Math.round(minimum * multiplier));
}

export function screenplayLengthContract(userInput) {
  const duration = userInput?.project?.distribution_brief?.episode_duration;
  const seconds = episodeDurationSeconds(duration);
  return {
    episode_duration_seconds: seconds,
    minimum_episode_characters: Math.ceil(
      seconds * REFERENCE_MINIMUM_CHINESE_BODY_CHARACTERS / REFERENCE_EPISODE_DURATION_SECONDS
    )
  };
}

export function countChineseBodyCharacters(content) {
  const text = String(content || "").split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed
        && !trimmed.startsWith("#")
        && !/^人物[：:]/u.test(trimmed)
        && !/^[（(].+[）)]$/u.test(trimmed);
    })
    .join("");
  return (text.match(/\p{Script=Han}/gu) || []).length;
}

export function underLengthEpisodes(sections, minimumCharacters) {
  return sections.filter((section) => countChineseBodyCharacters(section.content) < minimumCharacters)
    .map((section) => section.episode);
}

export function underLengthIssue(episodes, minimumCharacters) {
  return `${episodes.map((episode) => `第${episode}集`).join("、")}的字数数量不满足${minimumCharacters}字，需要进一步高质量的填充剧集内容`;
}
