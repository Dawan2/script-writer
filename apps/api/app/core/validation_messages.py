"""校验失败的中文化：错误类型说明与字段标签。

两张表都只服务于"用户看得懂"这一件事：`reason` 不出现校验库的原文，
`label` 查不到时省略而不回落成后端字段名。
"""

from __future__ import annotations

from typing import Any, Optional

_DEFAULT_REASON = "填写的内容不符合要求"

# 键是校验库的错误类型标识，只在服务端内部用于查表。
_REASONS: dict[str, str] = {
    "missing": "必填",
    "missing_argument": "必填",
    "string_type": "需要填文字",
    "string_too_short": "字数太少",
    "string_too_long": "字数太多",
    "string_pattern_mismatch": "格式不符合要求",
    "int_parsing": "需要填整数",
    "int_type": "需要填整数",
    "int_from_float": "需要填整数",
    "float_parsing": "需要填数字",
    "float_type": "需要填数字",
    "bool_parsing": "只能选是或否",
    "bool_type": "只能选是或否",
    "greater_than": "数值太小",
    "greater_than_equal": "数值太小",
    "less_than": "数值太大",
    "less_than_equal": "数值太大",
    "too_short": "数量太少",
    "too_long": "数量太多",
    "enum": "只能从给出的选项里选",
    "literal_error": "只能从给出的选项里选",
    "value_error": "填写的内容不符合要求",
    "json_invalid": "内容格式不正确",
    "json_type": "内容格式不正确",
    "dict_type": "内容格式不正确",
    "list_type": "内容格式不正确",
    "model_attributes_type": "内容格式不正确",
    "extra_forbidden": "不接受这一项",
    "url_parsing": "链接格式不正确",
    "datetime_parsing": "时间格式不正确",
    "date_parsing": "日期格式不正确",
    "decimal_parsing": "需要填数字",
    "uuid_parsing": "编号格式不正确",
}

# 用户真正会填表的入口，按字段名登记中文标签。
_LABELS: dict[str, str] = {
    "username": "登录账号",
    "password": "登录密码",
    "current_password": "当前密码",
    "new_password": "新密码",
    "project_name": "项目名称",
    "target_region": "目标地区",
    "episode_duration": "单集时长",
    "target_episode_count": "目标集数",
    "maturity_target": "成熟度目标",
    "theme": "题材",
    "setting": "设定",
    "background": "故事背景",
    "audience": "目标观众",
    "extra_requirements": "补充要求",
    "task_type": "项目类型",
    "source_file": "原始文件",
    "content": "文档内容",
    "expected_hash": "文档版本标记",
    "tasks": "任务清单",
    "batch_name": "批次名称",
    "task_ids": "所选任务",
    "action": "批量操作",
}


def validation_reason(error_type: str, ctx: Optional[dict[str, Any]] = None) -> str:
    """把校验库的错误类型换成一句中文；查不到时也不吐原文。"""
    reason = _REASONS.get(error_type)
    if reason:
        return _with_limits(reason, error_type, ctx)
    return _DEFAULT_REASON


def _with_limits(reason: str, error_type: str, ctx: Optional[dict[str, Any]]) -> str:
    if not isinstance(ctx, dict):
        return reason
    if error_type in {"string_too_short", "too_short"} and "min_length" in ctx:
        return f"{reason}，至少 {ctx['min_length']} 个"
    if error_type in {"string_too_long", "too_long"} and "max_length" in ctx:
        return f"{reason}，最多 {ctx['max_length']} 个"
    return reason


def field_label(path_parts: list[str]) -> str:
    """查不到标签时返回空串，绝不回落成字段路径。"""
    for part in reversed(path_parts):
        label = _LABELS.get(part)
        if label:
            return label
    return ""
