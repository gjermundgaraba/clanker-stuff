import unittest

import pane


class Ready(unittest.TestCase):
    def test_waits_for_shown_text_and_for_loading_markers_to_go(self):
        self.assertTrue(pane.ready("Up to date  21\n12 updates", ["Up to date"], ["loading…"]))
        self.assertFalse(pane.ready("Up to date  3\n⠋ loading…", ["Up to date"], ["loading…"]))
        self.assertFalse(pane.ready("discovering", ["Up to date"], []))

    def test_needs_every_shown_text(self):
        self.assertFalse(pane.ready("Up to date", ["Up to date", "✓ ok"], []))
        self.assertTrue(pane.ready("Up to date ✓ ok", ["Up to date", "✓ ok"], []))


if __name__ == "__main__":
    unittest.main()
