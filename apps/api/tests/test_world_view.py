import unittest

from fastapi import HTTPException

from app.services.workspace_service import world_view_payload_from_content


class WorldViewPayloadTest(unittest.TestCase):
    def test_normalizes_complete_world_view(self) -> None:
        payload = world_view_payload_from_content(
            '{"世界观描述":"  一个以跨境媒体集团控制真相的现代都市。  ",'
            '"关键概念映射":[{"原剧本概念":" 家族密室 ","映射后概念":" 数据金库 "}]}'
        )

        self.assertEqual(payload["世界观描述"], "一个以跨境媒体集团控制真相的现代都市。")
        self.assertEqual(
            payload["关键概念映射"],
            [{"原剧本概念": "家族密室", "映射后概念": "数据金库"}],
        )

    def test_rejects_incomplete_mapping(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            world_view_payload_from_content(
                '{"世界观描述":"有效描述",'
                '"关键概念映射":[{"原剧本概念":"家族密室","映射后概念":""}]}'
            )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("第 1 条", raised.exception.detail)

    def test_accepts_empty_mappings(self) -> None:
        payload = world_view_payload_from_content(
            '{"世界观描述":"有效描述","关键概念映射":[]}'
        )

        self.assertEqual(payload["关键概念映射"], [])


if __name__ == "__main__":
    unittest.main()
