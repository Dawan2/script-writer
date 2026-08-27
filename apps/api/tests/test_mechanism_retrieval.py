import unittest

from app.services.mechanism_retrieval import retrieval_confidence


class MechanismRetrievalTest(unittest.TestCase):
    def test_high_confidence_requires_a_clear_lead(self):
        decision = retrieval_confidence(
            [{"id": "m-1", "score": 0.08}, {"id": "m-2", "score": 0.04}],
            score_threshold=0.05,
            margin_threshold=0.02,
        )
        self.assertIsNotNone(decision)
        self.assertEqual(decision["id"], "m-1")
        self.assertIsNone(
            retrieval_confidence(
                [{"id": "m-1", "score": 0.08}, {"id": "m-2", "score": 0.07}],
                score_threshold=0.05,
                margin_threshold=0.02,
            )
        )

    def test_low_absolute_overlap_stays_with_model(self):
        self.assertIsNone(
            retrieval_confidence(
                [{"id": "m-1", "score": 0.03}, {"id": "m-2", "score": 0.01}]
            )
        )


if __name__ == "__main__":
    unittest.main()
