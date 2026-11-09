"""The loopback Riot Client API used to confirm a product launch."""

import base64
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "backend"))

import riot_local_api  # noqa: E402


class _Response:
    def __init__(self, status, body=""):
        self.status = status
        self._body = body.encode("utf-8")

    def read(self, *_args):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class TestLockfile(unittest.TestCase):
    def _read(self, content):
        with mock.patch.object(riot_local_api.os.path, "isfile", return_value=True), \
                mock.patch("builtins.open", mock.mock_open(read_data=content)):
            return riot_local_api.read_credentials("lockfile")

    def test_reads_port_and_password(self):
        self.assertEqual(self._read("Riot Client:7016:11108:secret:https"), (11108, "secret"))

    def test_missing_file_is_not_an_error(self):
        self.assertIsNone(riot_local_api.read_credentials("does-not-exist"))

    def test_rejects_a_truncated_lockfile(self):
        self.assertIsNone(self._read("Riot Client:7016"))

    def test_rejects_a_non_numeric_port(self):
        self.assertIsNone(self._read("Riot Client:7016:notaport:secret:https"))

    def test_lockfile_path_follows_localappdata(self):
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": r"C:\Users\Test\AppData\Local"}):
            path = riot_local_api.lockfile_path()
        self.assertTrue(path.endswith(os.path.join("Riot Client", "Config", "lockfile")))
        self.assertIn("Riot Games", path)


class TestProductSessions(unittest.TestCase):
    def test_matches_product_and_patchline(self):
        sessions = {
            "host_app": {"productId": "riot_client", "patchlineId": ""},
            "abc": {"productId": "valorant", "patchlineId": "live", "phase": "Gameplay"},
        }
        with mock.patch.object(riot_local_api, "product_sessions", return_value=sessions):
            self.assertTrue(riot_local_api.has_product(1, "pw", "valorant", "live"))
            self.assertFalse(riot_local_api.has_product(1, "pw", "valorant", "pbe"))
            self.assertFalse(riot_local_api.has_product(1, "pw", "league_of_legends", "live"))

    def test_empty_session_map_means_not_started(self):
        with mock.patch.object(riot_local_api, "product_sessions", return_value={}):
            self.assertFalse(riot_local_api.has_product(1, "pw", "valorant", "live"))


class TestLaunchProduct(unittest.TestCase):
    def test_posts_to_the_product_launcher(self):
        with mock.patch.object(riot_local_api, "_request", return_value=(204, "")) as request:
            self.assertTrue(riot_local_api.launch_product(11108, "secret", "valorant", "live"))

        request.assert_called_once_with(
            11108,
            "secret",
            "/product-launcher/v1/products/valorant/patchlines/live",
            method="POST",
            timeout=riot_local_api.REQUEST_TIMEOUT_S,
        )

    def test_reports_rejection(self):
        with mock.patch.object(riot_local_api, "_request", return_value=(400, "")):
            self.assertFalse(riot_local_api.launch_product(11108, "secret", "valorant", "live"))


class TestRequest(unittest.TestCase):
    def test_uses_loopback_https_and_basic_auth(self):
        response = _Response(200, '{"ok": true}')
        with mock.patch.object(riot_local_api.urllib.request, "urlopen", return_value=response) as urlopen:
            status, text = riot_local_api._request(11108, "secret", "/product-session/v1/sessions")

        self.assertEqual((status, text), (200, '{"ok": true}'))
        sent = urlopen.call_args[0][0]
        self.assertEqual(sent.full_url, "https://127.0.0.1:11108/product-session/v1/sessions")
        token = base64.b64encode(b"riot:secret").decode()
        self.assertEqual(sent.get_header("Authorization"), f"Basic {token}")

    def test_http_error_is_a_status_not_an_exception(self):
        error = riot_local_api.urllib.error.HTTPError("url", 404, "not found", {}, None)
        with mock.patch.object(riot_local_api.urllib.request, "urlopen", side_effect=error):
            self.assertEqual(riot_local_api._request(1, "pw", "/x"), (404, ""))

    def test_connection_refused_returns_zero(self):
        with mock.patch.object(riot_local_api.urllib.request, "urlopen", side_effect=OSError("refused")):
            self.assertEqual(riot_local_api._request(1, "pw", "/x"), (0, ""))


if __name__ == "__main__":
    unittest.main()
