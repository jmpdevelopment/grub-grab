import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from grubgrab import page
from grubgrab.page import Blocked, fetch_html, find_recipe, recipe_data


def html(*blocks, lang="pl", extra=""):
    scripts = "".join(f'<script type="application/ld+json">{b if isinstance(b, str) else json.dumps(b)}</script>' for b in blocks)
    return f'<!doctype html><html lang="{lang}"><head>{scripts}</head><body>{extra}<p>My grandmother...</p></body></html>'


SOUP = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    "name": "Zupa fasolkowa",
    "recipeYield": ["4", "4 porcje"],
    "recipeIngredient": ["2 łyżki masła", "1 cebula", "500 g fasolki szparagowej"],
    "recipeCategory": "Zupy",
    "recipeCuisine": ["Polska"],
    "keywords": "zupa, fasolka,  , obiad",
}


# ---- finding the recipe data ------------------------------------------------------------------------


class TestFindRecipe:
    def test_reads_the_fields_the_import_needs(self):
        assert find_recipe(html(SOUP)) == {
            "name": "Zupa fasolkowa",
            "recipeYield": ["4", "4 porcje"],
            "recipeIngredient": ["2 łyżki masła", "1 cebula", "500 g fasolki szparagowej"],
            "recipeCategory": ["Zupy"],
            "recipeCuisine": ["Polska"],
            "keywords": ["zupa", "fasolka", "obiad"],
            "inLanguage": "pl",  # from the page when the data doesn't say
        }

    def test_the_datas_own_language_wins(self):
        assert find_recipe(html({**SOUP, "inLanguage": "en-GB"}))["inLanguage"] == "en-GB"

    @pytest.mark.parametrize(
        "data",
        [
            {"@context": "https://schema.org", "@graph": [{"@type": "WebPage"}, SOUP]},  # Yoast and friends
            [{"@type": "BreadcrumbList"}, SOUP],
            {"@type": "WebPage", "mainEntity": SOUP},
            {**SOUP, "@type": ["Recipe", "NewsArticle"]},
            {**SOUP, "@type": "schema:Recipe"},
            {**SOUP, "@type": "https://schema.org/Recipe"},
        ],
    )
    def test_finds_the_recipe_wherever_the_site_puts_it(self, data):
        assert find_recipe(html(data))["name"] == "Zupa fasolkowa"

    def test_skips_broken_blocks_and_recipes_without_ingredients(self):
        page_html = html("{not json", {"@type": "Recipe", "name": "Empty", "recipeIngredient": []}, [{"@type": "Person"}], SOUP)
        assert find_recipe(page_html)["name"] == "Zupa fasolkowa"

    def test_tolerates_line_breaks_inside_strings(self):
        raw = '{"@type": "Recipe", "name": "Two\nlines", "recipeIngredient": ["1 egg"]}'
        assert find_recipe(html(raw))["name"] == "Two lines"

    def test_only_json_ld_scripts_count(self):
        other = f'<script type="text/javascript">{json.dumps(SOUP)}</script><script>x</script>'
        assert find_recipe(html(extra=other)) is None
        typed = f'<script type="Application/LD+JSON; charset=utf-8">{json.dumps(SOUP)}</script>'
        assert find_recipe(html(extra=typed))["name"] == "Zupa fasolkowa"

    def test_no_recipe_data(self):
        assert find_recipe("<html><body>Just a blog</body></html>") is None

    def test_cleans_html_and_entities_out_of_the_text(self):
        data = {
            "@type": "Recipe",
            "name": "Mac &amp; cheese",
            "recipeYield": 4,
            "ingredients": ["<b>200 g</b>   pasta", "200 g pasta", "", None, 5, True],  # the old field name
            "keywords": ["quick", {"x": 1}],
        }
        assert find_recipe(html(data, lang="")) == {
            "name": "Mac & cheese",
            "recipeYield": ["4"],
            "recipeIngredient": ["200 g pasta", "5"],
            "keywords": ["quick"],
        }

    def test_caps_what_it_keeps(self):
        data = {"@type": "Recipe", "name": "x" * 500, "recipeIngredient": [f"{n} g flour {'y' * 400}" for n in range(300)]}
        found = find_recipe(html(data))
        assert len(found["name"]) == 200
        assert len(found["recipeIngredient"]) == 200 and all(len(line) == 300 for line in found["recipeIngredient"])


# ---- downloading ----------------------------------------------------------------------------------


class Site(BaseHTTPRequestHandler):
    routes: dict = {}

    def do_GET(self):
        status, headers, body = self.routes.get(self.path, (404, {}, b""))
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def site(monkeypatch):
    """A local web server standing in for a recipe site; its name resolves to a 'public' address."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    monkeypatch.setattr(page, "_PORTS", {"http": port, "https": 443})
    monkeypatch.setattr(page, "_public_address", lambda host, p: "127.0.0.1")
    Site.routes = {}
    yield Site.routes, f"http://recipes.test:{port}"
    server.shutdown()


HTML = {"Content-Type": "text/html; charset=utf-8"}


class TestFetchHtml:
    def test_reads_an_html_page(self, site):
        routes, base = site
        routes["/soup?x=1"] = (200, HTML, html(SOUP).encode())
        assert "Zupa fasolkowa" in fetch_html(f"{base}/soup?x=1")

    def test_asks_for_the_site_by_name(self, site):
        routes, base = site
        seen = {}
        original = Site.do_GET

        def spy(self):
            seen["host"] = self.headers["Host"]
            original(self)

        routes["/"] = (200, HTML, b"<html></html>")
        try:
            Site.do_GET = spy
            fetch_html(base)  # no path: asks for /
        finally:
            Site.do_GET = original
        assert seen["host"].startswith("recipes.test")

    @pytest.mark.parametrize(
        "reply",
        [(404, HTML, b"gone"), (200, {"Content-Type": "application/pdf"}, b"%PDF"), (200, {}, b"<html>"), (302, {}, b"")],
    )
    def test_only_a_page_that_loaded(self, site, reply):
        routes, base = site
        routes["/x"] = reply
        assert fetch_html(f"{base}/x") is None

    def test_follows_a_few_redirects(self, site):
        routes, base = site
        routes["/a"] = (301, {"Location": "/b"}, b"")
        routes["/b"] = (302, {"Location": f"{base}/c"}, b"")
        routes["/c"] = (200, HTML, b"<html>ok</html>")
        assert fetch_html(f"{base}/a") == "<html>ok</html>"

    def test_gives_up_on_a_redirect_loop(self, site):
        routes, base = site
        routes["/loop"] = (307, {"Location": "/loop"}, b"")
        assert fetch_html(f"{base}/loop") is None

    def test_checks_where_a_redirect_goes(self, site):
        routes, base = site
        routes["/sneaky"] = (301, {"Location": "file:///etc/passwd"}, b"")
        with pytest.raises(Blocked):
            fetch_html(f"{base}/sneaky")

    def test_decodes_the_pages_charset(self, site):
        routes, base = site
        routes["/latin"] = (200, {"Content-Type": "text/html; charset=iso-8859-2"}, "<p>żurek</p>".encode("iso-8859-2"))
        routes["/odd"] = (200, {"Content-Type": "text/html; charset=no-such-charset"}, "<p>šaltibarščiai</p>".encode())
        assert fetch_html(f"{base}/latin") == "<p>żurek</p>"
        assert fetch_html(f"{base}/odd") == "<p>šaltibarščiai</p>"

    def test_reads_a_few_mb_at_most(self, site, monkeypatch):
        routes, base = site
        monkeypatch.setattr(page, "_MAX_BYTES", 100_000)
        routes["/big"] = (200, HTML, b"a" * 300_000)
        assert len(fetch_html(f"{base}/big")) == 100_000

    def test_stops_at_the_deadline(self, site, monkeypatch):
        routes, base = site
        monkeypatch.setattr(page, "_DEADLINE_SECONDS", -1)
        routes["/slow"] = (200, HTML, b"a" * 300_000)
        assert len(fetch_html(f"{base}/slow")) == 65536  # the first chunk, then it stops


class TestWhereItWontGo:
    @pytest.mark.parametrize(
        "url",
        ["ftp://e.com/x", "file:///etc/passwd", "javascript:alert(1)", "https:///nohost", "https://user:pw@e.com/", "https://e.com:8443/"],
    )
    def test_only_plain_web_links(self, url):
        with pytest.raises(Blocked):
            page._connection(url)

    @pytest.mark.parametrize(
        "addresses",
        [
            ["127.0.0.1"],
            ["10.0.0.5"],
            ["169.254.169.254"],  # cloud metadata
            ["192.168.1.1"],
            ["::1"],
            ["fe80::1%eth0"],
            ["::ffff:127.0.0.1"],
            ["93.184.216.34", "10.0.0.5"],  # one bad address is enough
            [],
        ],
    )
    def test_only_public_addresses(self, monkeypatch, addresses):
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, 443)) for a in addresses]
        monkeypatch.setattr(page.socket, "getaddrinfo", lambda *a, **k: infos)
        with pytest.raises(Blocked):
            page._public_address("e.com", 443)

    def test_connects_to_the_checked_address(self, monkeypatch):
        infos = [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1::1", 443, 0, 0)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        monkeypatch.setattr(page.socket, "getaddrinfo", lambda *a, **k: infos)
        conn, target = page._connection("https://e.com/przepis?id=1")
        assert isinstance(conn, page._PinnedHTTPS)
        assert (conn.host, conn.port, conn.address, target) == ("e.com", 443, "2606:2800:220:1::1", "/przepis?id=1")

    def test_https_checks_the_certificate_for_the_sites_name(self, monkeypatch):
        listener = socket.create_server(("127.0.0.1", 0))
        wrapped = {}

        class Context:
            def wrap_socket(self, sock, server_hostname):
                wrapped["name"] = server_hostname
                return sock

        monkeypatch.setattr(page.ssl, "create_default_context", Context)
        conn = page._PinnedHTTPS("e.com", listener.getsockname()[1], "127.0.0.1")
        conn.connect()
        assert wrapped == {"name": "e.com"} and conn.sock.getpeername()[0] == "127.0.0.1"
        conn.close()
        listener.close()

    def test_https_really_checks_certificates(self):
        assert page.ssl.create_default_context().verify_mode == page.ssl.CERT_REQUIRED


# ---- the whole step ------------------------------------------------------------------------------


class TestRecipeData:
    def test_the_recipe_from_the_page(self, site):
        routes, base = site
        routes["/soup"] = (200, HTML, html(SOUP).encode())
        assert recipe_data(f"{base}/soup")["recipeIngredient"][0] == "2 łyżki masła"

    def test_nothing_when_the_page_has_no_recipe_data_or_did_not_load(self, site):
        routes, base = site
        routes["/blog"] = (200, HTML, b"<html><body>no data</body></html>")
        assert recipe_data(f"{base}/blog") is None
        assert recipe_data(f"{base}/missing") is None

    def test_nothing_for_internal_addresses(self, caplog):
        assert recipe_data("http://localhost/admin") is None
        assert "non-public address" in caplog.text and "localhost" not in caplog.text

    def test_nothing_when_anything_goes_wrong(self, monkeypatch, caplog):
        def boom(url):
            raise TimeoutError("too slow")

        monkeypatch.setattr(page, "fetch_html", boom)
        with caplog.at_level("INFO"):
            assert recipe_data("https://e.com/x") is None
        assert "TimeoutError" in caplog.text and "e.com" not in caplog.text
