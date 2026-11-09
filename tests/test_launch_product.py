"""The LaunchProduct setting must reach the spawned Riot Client.

Reported bug: "app only launches riot, it doesn't launch valorant at all" with
LaunchProduct set to VALORANT. The flag itself is now pinned here, together with
the watchdog that covers Riot dropping its own ``--launch-product`` request: the
client log showed the VALORANT page loading with no
``product-launcher: Launch starting`` line.
"""

import contextlib
import json
import os
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "backend"))

import launch_orchestrator  # noqa: E402
import riot_client  # noqa: E402

CLIENT_FOLDER = "C:/Riot Games/Riot Client"


class FakeTime:
    """Deterministic clock so the watchdog test is instant."""

    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def _config(product):
    return mock.MagicMock(**{"get.return_value": product})


class TestBuildLaunchArgs(unittest.TestCase):
    def _manager(self, product):
        manager = riot_client.RiotClientManager(_config(product))
        patcher = mock.patch.object(riot_client, "patchline_from_installs", return_value="live")
        patcher.start()
        self.addCleanup(patcher.stop)
        return manager

    def test_default_setting_launches_valorant(self):
        manager = self._manager(riot_client.LAUNCH_PRODUCT_VALORANT)
        self.assertEqual(
            manager.build_launch_args(),
            ["--launch-product=valorant", "--launch-patchline=live"],
        )

    def test_riot_setting_skips_the_game(self):
        manager = self._manager(riot_client.LAUNCH_PRODUCT_RIOT)
        self.assertEqual(
            manager.build_launch_args(),
            ["--launch-product=riot", "--launch-patchline=live"],
        )

    def test_unknown_value_falls_back_to_valorant(self):
        manager = self._manager("VALORANT")
        self.assertEqual(manager.get_launch_product(), riot_client.LAUNCH_PRODUCT_VALORANT)


class TestPatchlineFromInstalls(unittest.TestCase):
    """The launch patchline comes from the client's install record, not "live"."""

    def _patchline(self, payload):
        with mock.patch("builtins.open", mock.mock_open(read_data=json.dumps(payload))):
            return riot_client.patchline_from_installs()

    def test_reads_the_installed_game_patchline(self):
        payload = {"associated_client": {"C:/Riot Games/VALORANT/pbe/": "client.exe"}}
        self.assertEqual(self._patchline(payload), "pbe")

    def test_accepts_windows_separators(self):
        payload = {"associated_client": {"D:\\Riot Games\\VALORANT\\live\\": "client.exe"}}
        self.assertEqual(self._patchline(payload), "live")

    def test_falls_back_when_the_game_is_absent(self):
        payload = {"associated_client": {"C:/Riot Games/League of Legends/live/": "client.exe"}}
        self.assertEqual(self._patchline(payload), riot_client.LAUNCH_PATCHLINE)

    def test_falls_back_when_the_manifest_is_unreadable(self):
        with mock.patch("builtins.open", side_effect=OSError("missing")):
            self.assertEqual(riot_client.patchline_from_installs(), riot_client.LAUNCH_PATCHLINE)


class TestLaunchClient(unittest.TestCase):
    def _manager(self, product):
        manager = riot_client.RiotClientManager(_config(product))
        manager.ensure_location = mock.MagicMock(return_value=CLIENT_FOLDER)
        patcher = mock.patch.object(riot_client, "patchline_from_installs", return_value="live")
        patcher.start()
        self.addCleanup(patcher.stop)
        return manager

    def test_spawns_the_client_with_the_product_argument(self):
        manager = self._manager(riot_client.LAUNCH_PRODUCT_VALORANT)
        proc = mock.MagicMock(pid=4242)
        with mock.patch.object(riot_client.os.path, "isfile", return_value=True), \
                mock.patch.object(riot_client.subprocess, "Popen", return_value=proc) as popen:
            self.assertEqual(manager.launch_client(), 4242)

        popen.assert_called_once_with(
            [
                os.path.join(CLIENT_FOLDER, "RiotClientServices.exe"),
                "--launch-product=valorant",
                "--launch-patchline=live",
            ],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    def test_profile_launch_starts_the_product_watchdog(self):
        manager = self._manager(riot_client.LAUNCH_PRODUCT_VALORANT)
        thread = mock.MagicMock()
        with mock.patch.object(riot_client.os.path, "isfile", return_value=True), \
                mock.patch.object(riot_client.subprocess, "Popen", return_value=mock.MagicMock(pid=7)), \
                mock.patch.object(riot_client.threading, "Thread", return_value=thread) as thread_cls:
            manager.launch_client(confirm_product=True)

        thread_cls.assert_called_once_with(
            target=manager._confirm_product_launch,
            args=("valorant", "live", 7),
            daemon=True,
        )
        thread.start.assert_called_once()

    def test_add_account_launch_does_not_start_the_watchdog(self):
        """Add Account launches the client so the user can sign in; the game
        must not open underneath that flow."""
        manager = self._manager(riot_client.LAUNCH_PRODUCT_VALORANT)
        with mock.patch.object(riot_client.os.path, "isfile", return_value=True), \
                mock.patch.object(riot_client.subprocess, "Popen", return_value=mock.MagicMock(pid=7)), \
                mock.patch.object(riot_client.threading, "Thread") as thread_cls:
            manager.launch_client()

        thread_cls.assert_not_called()

    def test_riot_only_setting_never_starts_the_watchdog(self):
        manager = self._manager(riot_client.LAUNCH_PRODUCT_RIOT)
        with mock.patch.object(riot_client.os.path, "isfile", return_value=True), \
                mock.patch.object(riot_client.subprocess, "Popen", return_value=mock.MagicMock(pid=7)), \
                mock.patch.object(riot_client.threading, "Thread") as thread_cls:
            manager.launch_client(confirm_product=True)

        thread_cls.assert_not_called()


class TestProductWatchdog(unittest.TestCase):
    def _run(self, *, credentials, has_product, launch_status, timeout=None,
             resolved=("valorant", "live")):
        manager = riot_client.RiotClientManager(_config(riot_client.LAUNCH_PRODUCT_VALORANT))
        fake_time = FakeTime()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(riot_client, "time", fake_time))
            stack.enter_context(mock.patch.object(riot_client.local_api, "read_credentials", side_effect=credentials))
            stack.enter_context(mock.patch.object(riot_client.local_api, "resolve_product", return_value=resolved))
            stack.enter_context(mock.patch.object(riot_client.local_api, "has_product", side_effect=has_product))
            launch = stack.enter_context(
                mock.patch.object(riot_client.local_api, "launch_product_status", side_effect=launch_status)
            )
            if timeout is not None:
                stack.enter_context(mock.patch.object(riot_client, "PRODUCT_LAUNCH_TIMEOUT_S", timeout))
            manager._confirm_product_launch("valorant", "live", 4242)
        return launch

    def test_does_nothing_when_the_game_session_already_exists(self):
        launch = self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: True,
            launch_status=lambda *a, **k: 200,
        )
        launch.assert_not_called()

    def test_starts_the_product_on_the_first_poll(self):
        launch = self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: False,
            launch_status=lambda *a, **k: 0,
        )
        # No grace window: the first poll with credentials sends immediately,
        # then at most PRODUCT_LAUNCH_MAX_ATTEMPTS calls, each RETRY_S apart.
        self.assertEqual(launch.call_count, riot_client.PRODUCT_LAUNCH_MAX_ATTEMPTS)
        launch.assert_called_with(1234, "pw", "valorant", "live", timeout=mock.ANY)

    def test_first_launch_request_happens_without_delay(self):
        """Riot's own auto-launch costs 10-20 s; the watchdog must not add to it."""
        clock = FakeTime()
        manager = riot_client.RiotClientManager(_config(riot_client.LAUNCH_PRODUCT_VALORANT))
        sent_at = []

        def sent(*_args, **_kwargs):
            sent_at.append(clock.monotonic())
            return 0

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(riot_client, "time", clock))
            stack.enter_context(mock.patch.object(riot_client.local_api, "read_credentials",
                                                  return_value=(1234, "pw")))
            stack.enter_context(mock.patch.object(riot_client.local_api, "resolve_product",
                                                  return_value=("valorant", "live")))
            stack.enter_context(mock.patch.object(riot_client.local_api, "has_product",
                                                  return_value=False))
            stack.enter_context(mock.patch.object(riot_client.local_api, "launch_product_status",
                                                  side_effect=sent))
            stack.enter_context(mock.patch.object(riot_client, "PRODUCT_LAUNCH_TIMEOUT_S", 1.0))
            manager._confirm_product_launch("valorant", "live", 4242)

        self.assertEqual(sent_at, [0.0])

    def test_gives_up_when_the_client_api_never_answers(self):
        launch = self._run(
            credentials=lambda *a, **k: None,
            has_product=lambda *a, **k: False,
            launch_status=lambda *a, **k: 0,
        )
        launch.assert_not_called()

    def test_stops_after_one_attempt_when_the_game_appears(self):
        checks = []

        def has_product(*_args, **_kwargs):
            checks.append(True)
            return len(checks) > 2

        launch = self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=has_product,
            launch_status=lambda *a, **k: 200,
            timeout=60,
        )
        self.assertEqual(launch.call_count, 1)

    def test_stops_posting_when_the_client_says_locked(self):
        """423 = the client is already starting the game; do not fight it."""
        launch = self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: False,
            launch_status=lambda *a, **k: riot_client.HTTP_LOCKED,
            timeout=10,
        )
        self.assertEqual(launch.call_count, 1)

    def test_ignores_a_lockfile_from_the_previous_client(self):
        """A stale lockfile (other PID) is not the client this launch spawned."""
        seen = []

        def credentials(*_args, **kwargs):
            seen.append(kwargs.get("client_pid"))
            return None

        launch = self._run(
            credentials=credentials,
            has_product=lambda *a, **k: False,
            launch_status=lambda *a, **k: 0,
            timeout=5,
        )
        launch.assert_not_called()
        self.assertEqual(set(seen), {4242})

    def test_retries_with_the_clients_own_patchline(self):
        """The first attempt uses the fallback; the retry follows the client."""
        answers = []

        def status(*_args, **_kwargs):
            answers.append(True)
            return 404 if len(answers) == 1 else 200

        launch = self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: False,
            launch_status=status,
            resolved=("valorant", "pbe"),
            timeout=5,
        )
        self.assertEqual(launch.call_count, 2)
        launch.assert_called_with(1234, "pw", "valorant", "pbe", timeout=mock.ANY)


class TestOrchestratorConfirmsProduct(unittest.TestCase):
    def test_switch_launch_asks_for_product_confirmation(self):
        riot = mock.MagicMock()
        riot.launch_client.return_value = 99
        orchestrator = launch_orchestrator.LaunchOrchestrator(
            riot, mock.MagicMock(), mock.MagicMock(), mock.MagicMock()
        )

        result = orchestrator._launch_client("Main")

        riot.launch_client.assert_called_once_with(confirm_product=True)
        self.assertEqual(result["pid"], 99)


if __name__ == "__main__":
    unittest.main()
