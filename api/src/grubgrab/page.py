"""Reads the standard recipe data a recipe page publishes for search engines (schema.org Recipe, as JSON-LD).

Most recipe sites include it: the title, yield and one line per ingredient, already separated from the
page's ads and life stories. When it's there, the AI only has to tidy those few lines instead of reading
the whole page, which is much faster and cheaper. When it isn't (or the page can't be read here), the
import falls back to the AI reading the page itself.

This is the one place the app downloads a page a person chose, so the download is fenced in:
  - http and https on the standard ports only, at most a few redirects, each one checked again;
  - the address must be a public internet address, and the connection goes to the address that was
    checked (so a name can't be re-pointed at an internal one in between);
  - HTML only, a few MB at most, and a hard time limit for the whole download.
Only the recipe fields below ever leave this module; nothing else from the page is kept.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import logging
import re
import socket
import ssl
import time
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

log = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 8.0  # per connect or read
_DEADLINE_SECONDS = 15.0  # for the whole download, however slowly the page trickles in
_MAX_BYTES = 3_000_000
_MAX_REDIRECTS = 3
_PORTS = {"http": 80, "https": 443}
_REDIRECTS = {301, 302, 303, 307, 308}
_USER_AGENT = "Mozilla/5.0 (compatible; GrubGrab recipe import)"

_MAX_LINES = 200  # ingredient lines, as the AI answer is capped
_MAX_LINE = 300
_MAX_TEXT = 200
_MAX_LIST = 10  # categories, cuisines, keywords


class Blocked(Exception):
    """The link points somewhere this app won't download from."""


# ---- downloading -----------------------------------------------------------------------------------


def _public_address(host: str, port: int) -> str:
    """The address to connect to, if every address the name resolves to is on the public internet."""
    addresses = [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
    if not addresses or not all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addresses):
        raise Blocked(host)
    return addresses[0]


class _PinnedHTTP(http.client.HTTPConnection):
    """Connects to an address checked beforehand, while still asking for the site by its name."""

    def __init__(self, host: str, port: int, address: str):
        super().__init__(host, port, timeout=_TIMEOUT_SECONDS)
        self.address = address

    def connect(self):
        self.sock = socket.create_connection((self.address, self.port), self.timeout)


class _PinnedHTTPS(_PinnedHTTP):
    default_port = 443

    def connect(self):
        super().connect()  # the certificate is still checked against the site's name
        self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.host)


def _connection(url: str) -> tuple[_PinnedHTTP, str]:
    parts = urlsplit(url)
    if parts.scheme not in _PORTS or not parts.hostname or parts.username or parts.password:
        raise Blocked(url)
    port = parts.port or _PORTS[parts.scheme]
    if port != _PORTS[parts.scheme]:
        raise Blocked(url)
    cls = _PinnedHTTPS if parts.scheme == "https" else _PinnedHTTP
    target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    return cls(parts.hostname, port, _public_address(parts.hostname, port)), target


def _read(response: http.client.HTTPResponse, deadline: float) -> bytes:
    body = b""
    while chunk := response.read(65536):
        body += chunk
        if len(body) > _MAX_BYTES or time.monotonic() > deadline:
            break  # read enough: the recipe data is usually near the top
    return body[:_MAX_BYTES]


def fetch_html(url: str) -> str | None:
    """The page's HTML, or None if it isn't an HTML page that loaded. Raises Blocked for links it won't follow."""
    deadline = time.monotonic() + _DEADLINE_SECONDS
    for _ in range(_MAX_REDIRECTS + 1):
        conn, target = _connection(url)
        try:
            conn.request(
                "GET",
                target,
                headers={"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "identity"},
            )
            response = conn.getresponse()
            if response.status in _REDIRECTS and response.getheader("Location"):
                url = urljoin(url, response.getheader("Location"))
                continue
            if response.status != 200 or "html" not in (response.getheader("Content-Type") or "").lower():
                return None
            body = _read(response, deadline)
            charset = response.headers.get_content_charset() or "utf-8"
        finally:
            conn.close()
        try:
            return body.decode(charset, errors="replace")
        except LookupError:  # a charset Python doesn't know
            return body.decode("utf-8", errors="replace")
    return None  # too many redirects


# ---- finding the recipe data -------------------------------------------------------------------------


class _JsonLdScripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.blocks: list[str] = []
        self.lang = ""
        self._inside = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html" and not self.lang:
            self.lang = (attrs.get("lang") or "").strip()
        if tag == "script" and (attrs.get("type") or "").split(";")[0].strip().lower() == "application/ld+json":
            self._inside = True
            self.blocks.append("")

    def handle_endtag(self, tag):
        if tag == "script":
            self._inside = False

    def handle_data(self, data):
        if self._inside:
            self.blocks[-1] += data


def _is_recipe(node: dict) -> bool:
    types = node.get("@type")
    types = types if isinstance(types, list) else [types]
    # "Recipe", "schema:Recipe" or "https://schema.org/Recipe"
    return any(isinstance(t, str) and re.split(r"[/:]", t)[-1] == "Recipe" for t in types)


def _recipes(node):
    if isinstance(node, list):
        for item in node:
            yield from _recipes(item)
    elif isinstance(node, dict):
        if _is_recipe(node):
            yield node
        for key in ("@graph", "mainEntity"):
            yield from _recipes(node.get(key))


def _clean(value, limit: int = _MAX_TEXT) -> str:
    """Plain text: some sites put HTML or HTML entities inside their recipe data."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return ""
    text = unescape(re.sub(r"<[^>]*>", " ", value))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _texts(value, limit: int = _MAX_TEXT, most: int = _MAX_LIST) -> list[str]:
    values = value if isinstance(value, list) else [value]
    texts = []
    for item in values:
        text = _clean(item, limit)
        if text and text not in texts:
            texts.append(text)
    return texts[:most]


def _keywords(value) -> list[str]:
    if isinstance(value, str):
        value = value.split(",")
    return _texts(value, 40)


def find_recipe(html: str) -> dict | None:
    """The page's recipe data, trimmed to what the import needs, or None if it has none with ingredients."""
    parser = _JsonLdScripts()
    parser.feed(html)
    parser.close()
    for block in parser.blocks:
        try:
            data = json.loads(block, strict=False)  # strict=False: some sites leave raw line breaks in strings
        except ValueError:
            continue
        for recipe in _recipes(data):
            lines = _texts(recipe.get("recipeIngredient") or recipe.get("ingredients"), _MAX_LINE, _MAX_LINES)
            if not lines:
                continue
            found = {
                "name": _clean(recipe.get("name")),
                "recipeYield": _texts(recipe.get("recipeYield"), 60, 3),
                "recipeIngredient": lines,
                "recipeCategory": _texts(recipe.get("recipeCategory")),
                "recipeCuisine": _texts(recipe.get("recipeCuisine")),
                "keywords": _keywords(recipe.get("keywords")),
                "inLanguage": _clean(recipe.get("inLanguage"), 20) or parser.lang[:20],
            }
            return {key: value for key, value in found.items() if value}
    return None


def recipe_data(link: str) -> dict | None:
    """The recipe data on the page at `link`, or None (for any reason: the AI then reads the page instead)."""
    try:
        html = fetch_html(link)
        return find_recipe(html) if html else None
    # The log says why, never which link (links stay out of the logs).
    except Blocked:
        log.warning("Not reading a page at a non-public address")
    except Exception as exc:  # unreachable, slow, odd HTML...: not worth failing the import over
        log.info("Couldn't read the page's recipe data (%s)", type(exc).__name__)
    return None
