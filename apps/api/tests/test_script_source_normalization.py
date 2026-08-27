from __future__ import annotations

import unittest

from app.services.script_source_normalization import model_readable_source, source_terms_found_in_text


class ScriptSourceNormalizationTest(unittest.TestCase):
    def test_pdf_characters_and_layout_spaces_are_normalized_for_model_reading(self) -> None:
        self.assertEqual(model_readable_source("景 司 ⾠"), "景司辰")

    def test_only_terms_present_in_normalized_source_are_kept(self) -> None:
        source = "景 司 ⾠ 住 在 海 天 ⻛ 月，血 型 为 R H 阴 性 ⾎。"

        found = source_terms_found_in_text(
            ["海天风月", "RH阴性血", "毒针管", "景司珉", "血库约定"],
            source,
        )

        self.assertEqual(found, ["海天风月", "RH阴性血"])


if __name__ == "__main__":
    unittest.main()
