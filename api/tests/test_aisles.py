import re
from pathlib import Path

from grubgrab.aisles import AISLES

WEB = Path(__file__).resolve().parents[2] / "web" / "src"


def test_same_aisles_in_the_same_order_as_the_app():
    source = (WEB / "lib" / "aisles.ts").read_text()
    listed = re.search(r"export const AISLES = \[([^\]]+)\]", source).group(1)
    assert tuple(re.findall(r"'(\w+)'", listed)) == AISLES


def test_every_aisle_has_a_name_in_every_language():
    for lang in ("en", "pl", "lt"):
        text = (WEB / "i18n" / "locales" / f"{lang}.ts").read_text()
        assert all(f"'aisle.{a}':" in text for a in AISLES), lang
