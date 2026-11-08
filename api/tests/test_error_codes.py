"""Every message code the API can send has a translation in the app (web/src/i18n/locales/en.ts, which
every other language must match), so no one sees an untranslated server message."""

import ast
import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "grubgrab"
EN = Path(__file__).resolve().parents[2] / "web" / "src" / "i18n" / "locales" / "en.ts"

# Built at run time by _require(found, what) and _text(value, field): every `what` / `field` used.
NOT_FOUND = {"invite_code", "recipe", "item", "import", "request"}
FIELDS = {"title", "notes", "link", "tag", "name", "unit", "ingredient_name", "code"}
DYNAMIC = {f"{what}_not_found" for what in NOT_FOUND}


def translated(prefix: str) -> set[str]:
    return set(re.findall(rf"'{prefix}\.(\w+)'", EN.read_text()))


def codes_in_source() -> set[str]:
    """The literal code of every ApiError(status, "code", ...) and ExtractionError("code", ...)."""
    codes = set()
    for path in SRC.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) in ("ApiError", "ExtractionError"):
                position = 1 if node.func.id == "ApiError" else 0
                arg = node.args[position]
                if isinstance(arg, ast.Constant):
                    codes.add(arg.value)
            if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "finish_import_job":
                for kw in node.keywords:
                    if kw.arg == "error_code" and isinstance(kw.value, ast.Constant):
                        codes.add(kw.value.value)
    return codes


def test_every_code_the_api_sends_is_translated():
    codes = codes_in_source() | DYNAMIC
    assert len(codes) > 30  # the scan really found them
    assert codes - translated("error") == set()


def second_args(function: str) -> set[str]:
    """The constant second argument of every call to `function` in the handler, as a translation key."""
    found = set()
    for node in ast.walk(ast.parse((SRC / "handler.py").read_text())):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == function and len(node.args) > 1:
            if isinstance(node.args[1], ast.Constant):
                found.add(node.args[1].value.lower().replace(" ", "_"))
    return found


def test_every_not_found_and_field_name_is_covered():
    used_whats, used_fields = second_args("_require"), second_args("_text")
    assert used_whats == NOT_FOUND
    assert used_fields == FIELDS
    assert FIELDS <= translated("field")
