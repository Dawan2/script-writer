from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any


AUTO_ADAPT_TAG = "自动适配"
CREATIVE_TASK_TYPES = frozenset({"rewrite", "novel", "replicate"})
TAG_FIELDS = ("theme", "setting", "background", "audience")
TAG_LABELS = {"theme": "主题", "setting": "设定", "background": "背景", "audience": "受众"}
TAG_LIMITS = {"theme": 4, "setting": 4, "background": 4, "audience": 1}
TAG_TAXONOMY: dict[str, tuple[str, ...]] = {
    "theme": (
        "现代言情", "女性成长", "脑洞", "奇幻", "玄幻", "古风言情", "战神", "宫斗", "仙侠", "权谋",
        "种田", "年代爱情", "悬疑", "喜剧", "志怪", "民国爱情", "灵异", "家国情怀", "法律", "刑侦",
        "抗战", "武侠", "民国传奇", "求生", "动作", "科幻", "恐怖", "商战",
    ),
    "setting": (
        "打脸虐渣", "大男主", "大女主", "马甲", "重生", "穿越", "系统", "先婚后爱", "家长里短", "小人物",
        "破镜重圆", "神豪", "豪门", "强者回归", "异能", "虐恋", "传承觉醒", "医生", "强强联合", "赘婿逆袭",
        "甜宠", "娱乐圈", "神医", "青梅竹马", "姐弟恋", "玄学", "追妻火葬场", "业界精英", "一见钟情", "福宝",
        "捞偏门", "反派主角", "萌宠", "双向救赎", "方言", "白月光", "灵魂互换", "病娇", "暴富", "黑道",
        "丧尸", "特种兵",
    ),
    "background": ("现代", "都市", "古代", "乡村", "年代", "架空", "职场", "民国", "校园", "宫廷", "荒岛"),
    "audience": ("男频", "女频"),
}
CONTROLLED_TAG_VALUES = frozenset(value for values in TAG_TAXONOMY.values() for value in values)
BACKGROUND_ERA_TAGS = frozenset({"现代", "古代", "年代", "民国"})


class ScriptTagValidationError(ValueError):
    pass


def tag_taxonomy() -> dict[str, list[str]]:
    return {kind: list(values) for kind, values in TAG_TAXONOMY.items()}


def normalize_tag_values(values: Any) -> list[str]:
    if isinstance(values, str):
        source = re.split(r"[,，]", values)
    elif isinstance(values, (list, tuple)):
        source = values
    elif values is None:
        source = []
    else:
        source = [values]
    result: list[str] = []
    for value in source:
        item = re.sub(r"\s+", " ", str(value or "").strip())
        if item and item not in result:
            result.append(item)
    return result


def script_profile_errors(
    profile: dict[str, Any],
    *,
    allow_auto: bool,
    user_selected_fields: Iterable[str] | None = None,
) -> list[str]:
    errors: list[str] = []
    normalized: dict[str, list[str]] = {}
    selected_fields = frozenset(user_selected_fields or ()).intersection(TAG_FIELDS)
    for kind in TAG_FIELDS:
        values = normalize_tag_values(profile.get(kind))
        normalized[kind] = values
        label = TAG_LABELS[kind]
        if not values:
            errors.append(f"{label}不能为空")
            continue
        if AUTO_ADAPT_TAG in values:
            if not allow_auto:
                errors.append(f"{label}仍为自动适配")
            if len(values) > 1:
                errors.append(f"{label}选择自动适配时不能同时选择其他标签")
            continue
        invalid = [value for value in values if value not in TAG_TAXONOMY[kind]]
        if invalid:
            errors.append(f"{label}标签不在受控词表中：{'、'.join(invalid)}")
        if len(values) > TAG_LIMITS[kind]:
            errors.append(f"{label}最多选择 {TAG_LIMITS[kind]} 项")

    eras = [value for value in normalized["background"] if value in BACKGROUND_ERA_TAGS]
    if len(eras) > 1 and "background" not in selected_fields:
        errors.append(f"背景不能同时标注{'、'.join(eras)}，应以主要剧情时空为准")

    themes = set(normalized["theme"])
    backgrounds = set(normalized["background"])
    if not {"theme", "background"}.issubset(selected_fields):
        if "现代言情" in themes and backgrounds.intersection({"古代", "宫廷", "年代", "民国"}):
            errors.append("现代言情与古代、宫廷、年代或民国主背景不一致")
        if "古风言情" in themes and backgrounds.intersection({"现代", "都市", "职场", "校园"}):
            errors.append("古风言情与现代、都市、职场或校园主背景不一致")
        if "年代爱情" in themes and backgrounds.intersection({"现代", "古代", "民国"}):
            errors.append("年代爱情与当前主背景不一致")
        if "民国爱情" in themes and backgrounds.intersection({"现代", "古代", "年代"}):
            errors.append("民国爱情与当前主背景不一致")
    return list(dict.fromkeys(errors))


def normalize_script_profile(
    task_type: str,
    values: dict[str, Any] | None,
    *,
    default_auto: bool,
    allow_auto: bool = True,
    user_selected_fields: Iterable[str] | None = None,
) -> dict[str, list[str]]:
    if task_type not in CREATIVE_TASK_TYPES:
        return {}
    source = values if isinstance(values, dict) else {}
    profile = {
        kind: normalize_tag_values(source.get(kind)) or ([AUTO_ADAPT_TAG] if default_auto else [])
        for kind in TAG_FIELDS
    }
    errors = script_profile_errors(
        profile,
        allow_auto=allow_auto,
        user_selected_fields=user_selected_fields,
    )
    if errors:
        raise ScriptTagValidationError("；".join(errors))
    return profile
