"""The LaunchProduct setting must reach the spawned Riot Client.

Reported bug: "app only launches riot, it doesn't launch valorant at all" with
LaunchProduct set to VALORANT. The flag itself is now pinned here, together with
the watchdog that covers Riot dropping its own ``--launch-product`` request: the
client log showed the VALORANT page loading with no
``product-launcher: Launch starting`` line.
"""

import contextlib
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
    def test_default_setting_launches_valorant(self):
        manager = riot_client.RiotClientManager(_config(riot_client.LAUNCH_PRODUCT_VALORANT))
        self.assertEqual(
            manager.build_launch_args(),
            ["--launch-product=valorant", "--launch-patchline=live"],
        )

    def test_riot_setting_skips_the_game(self):
        manager = riot_client.RiotClientManager(_config(riot_client.LAUNCH_PRODUCT_RIOT))
        self.assertEqual(
            manager.build_launch_args(),
            ["--launch-product=riot", "--launch-patchline=live"],
        )

    def test_unknown_value_falls_back_to_valorant(self):
        manager = riot_client.RiotClientManager(_config("VALORANT"))
        self.assertEqual(manager.get_launch_product(), riot_client.LAUNCH_PRODUCT_VALORANT)


class TestLaunchClient(unittest.TestCase):
    def _manager(self, product):
        manager = riot_client.RiotClientManager(_config(product))
        manager.ensure_location = mock.MagicMock(return_value=CLIENT_FOLDER)
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
            args=("valorant", "live"),
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
    def _run(self, *, credentials, has_product, launch_product, grace=None, timeout=None):
        manager = riot_client.RiotClientManager(_config(riot_client.LAUNCH_PRODUCT_VALORANT))
        fake_time = FakeTime()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(riot_client, "time", fake_time))
            stack.enter_context(mock.patch.object(riot_client.local_api, "read_credentials", side_effect=credentials))
            stack.enter_context(mock.patch.object(riot_client.local_api, "has_product", side_effect=has_product))
            launch = stack.enter_context(
                mock.patch.object(riot_client.local_api, "launch_product", side_effect=launch_product)
            )
            if grace is not None:
                stack.enter_context(mock.patch.object(riot_client, "PRODUCT_LAUNCH_GRACE_S", grace))
            if timeout is not None:
                stack.enter_context(mock.patch.object(riot_client, "PRODUCT_LAUNCH_TIMEOUT_S", timeout))
            manager._confirm_product_launch("valorant", "live")
        return launch

    def test_does_nothing_when_the_game_session_already_exists(self):
        launch = self._run(
            credentials=lambda: (1234, "pw"),
            has_product=lambda *a: True,
            launch_product=lambda *a: True,
        )
        launch.assert_not_called()

    def test_starts_the_product_after_the_grace_window(self):
        launch = self._run(
            credentials=lambda: (1234, "pw"),
            has_product=lambda *a: False,
            launch_product=lambda *a: True,
        )
        # Grace window elapses, then at most PRODUCT_LAUNCH_MAX_ATTEMPTS calls,
        # each PRODUCT_LAUNCH_RETRY_S apart.
        self.assertEqual(launch.call_count, riot_client.PRODUCT_LAUNCH_MAX_ATTEMPTS)
        launch.assert_called_with(1234, "pw", "valorant", "live")

    def test_gives_up_when_the_client_api_never_answers(self):
        launch = self._run(
            credentials=lambda: None,
            has_product=lambda *a: False,
            launch_product=lambda *a: True,
        )
        launch.assert_not_called()

    def test_stops_after_one_attempt_when_the_game_appears(self):
        checks = []

        def has_product(*_args):
            checks.append(True)
            return len(checks) > 3

        launch = self._run(
            credentials=lambda: (1234, "pw"),
            has_product=has_product,
            launch_product=lambda *a: True,
            grace=2,
            timeout=60,
        )
        self.assertEqual(launch.call_count, 1)


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
