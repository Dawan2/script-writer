from __future__ import annotations

import re
import unicodedata
from typing import Iterable


# Some PDF extractors emit Unicode radical glyphs instead of the equivalent
# Chinese characters. NFKC handles Kangxi radicals, but not these simplified
# CJK radical forms.
PDF_RADICAL_EQUIVALENTS = str.maketrans({
    "⻘": "青",
    "⻢": "马",
    "⻰": "龙",
    "⻩": "黄",
    "⻅": "见",
    "⻔": "门",
    "⻋": "车",
    "⻓": "长",
    "⻤": "鬼",
    "⻛": "风",
    "⺟": "母",
    "⻄": "西",
    "⻬": "齐",
    "⻆": "角",
    "⻣": "骨",
    "⻝": "食",
    "⻮": "齿",
    "⻁": "虎",
    "⻥": "鱼",
    "⻜": "飞",
    "⻉": "贝",
    "⻦": "鸟",
})


def normalize_pdf_characters(value: str) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).translate(PDF_RADICAL_EQUIVALENTS)


def source_lookup_key(value: str) -> str:
    normalized = normalize_pdf_characters(value)
    return "".join(character for character in normalized if not character.isspace()).casefold()


def source_term_display(value: str) -> str:
    normalized = normalize_pdf_characters(value)
    return "".join(character for character in normalized if not character.isspace()).strip()


def source_terms_found_in_text(terms: Iterable[str], source_text: str, *, limit: int = 30) -> list[str]:
    source_key = source_lookup_key(source_text)
    result: list[str] = []
    seen: set[str] = set()
    for raw in terms:
        term = source_term_display(str(raw or ""))
        key = source_lookup_key(term)
        if len(term) < 2 or not key or key not in source_key or key in seen:
            continue
        result.append(term)
        seen.add(key)
        if len(result) >= limit:
            break
    return result


def model_readable_source(value: str) -> str:
    """Remove PDF glyph artifacts while preserving paragraph boundaries."""
    normalized = normalize_pdf_characters(value)
    horizontal_space = r"[\t \u00a0\u3000]+"
    previous = ""
    while previous != normalized:
        previous = normalized
        normalized = re.sub(
            rf"(?<=[\u3400-\u9fff]){horizontal_space}(?=[\u3400-\u9fff])",
            "",
            normalized,
        )
    normalized = re.sub(
        r"(?<![A-Za-z])[A-Za-z](?:[\t \u00a0\u3000]+[A-Za-z])+(?![A-Za-z])",
        lambda match: re.sub(horizontal_space, "", match.group(0)),
        normalized,
    )
    return normalized
