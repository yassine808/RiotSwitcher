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
             resolved=("valorant", "live"), valorant_running=False):
        manager = riot_client.RiotClientManager(_config(riot_client.LAUNCH_PRODUCT_VALORANT))
        self._manager = manager
        fake_time = FakeTime()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(riot_client, "time", fake_time))
            stack.enter_context(mock.patch.object(riot_client.rp, "is_running", return_value=valorant_running))
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
            stack.enter_context(mock.patch.object(riot_client.rp, "is_running", return_value=False))
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

    def test_stops_posting_after_an_accepted_request(self):
        """A 2xx means the client owns the launch; reposting restarts updates."""
        launch = self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: False,
            launch_status=lambda *a, **k: 200,
            timeout=60,
        )
        self.assertEqual(launch.call_count, 1)

    def test_backs_off_after_a_rejected_request(self):
        """A client that is still booting must not get a POST every second."""
        launch = self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: False,
            launch_status=lambda *a, **k: 404,
            timeout=30,
        )
        # Attempts at 0, 1, 3, 7, 15 and 25 seconds, then the timeout wins.
        self.assertEqual(launch.call_count, 6)

    def test_does_not_request_a_launch_when_the_game_is_already_running(self):
        launch = self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: False,
            launch_status=lambda *a, **k: 200,
            valorant_running=True,
        )
        launch.assert_not_called()

    def test_records_that_the_game_started(self):
        self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: True,
            launch_status=lambda *a, **k: 200,
        )
        self.assertTrue(self._manager.product_started())

    def test_product_started_is_false_when_the_game_never_appears(self):
        self._run(
            credentials=lambda *a, **k: (1234, "pw"),
            has_product=lambda *a, **k: False,
            launch_status=lambda *a, **k: 200,
            timeout=5,
        )
        self.assertFalse(self._manager.product_started())

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


class TestOrchestratorLaunchGuard(unittest.TestCase):
    """A repeated launch must not kill the client that is still starting."""

    def _orchestrator(self, *, running_profile="", valorant=False, client=True):
        riot = mock.MagicMock()
        riot.launch_client.return_value = 99
        riot.ensure_location.return_value = "C:/Riot Client"
        config = mock.MagicMock()
        config.get.side_effect = lambda key, default=None: (
            running_profile if key == "LastRunningProfile" else default
        )
        sessions = mock.MagicMock()
        sessions.session_has_login.return_value = True
        profiles = mock.MagicMock()
        profiles.get.return_value = {"directory_name": "one"}
        orchestrator = launch_orchestrator.LaunchOrchestrator(riot, sessions, profiles, config)

        def is_running(name):
            if name in launch_orchestrator.rp.VALORANT_PROCESSES:
                return valorant
            if name in launch_orchestrator.rp.RIOT_CLIENT_PROCESSES:
                return client
            return False

        running = mock.patch.object(launch_orchestrator.rp, "is_running", side_effect=is_running)
        running.start()
        self.addCleanup(running.stop)
        stop = mock.patch.object(launch_orchestrator.rp, "shutdown_stop", return_value=True)
        stop.start()
        self.addCleanup(stop.stop)
        return orchestrator, riot

    def test_second_launch_of_the_same_profile_is_skipped(self):
        orchestrator, riot = self._orchestrator()

        first = orchestrator.switch_to("One")
        second = orchestrator.switch_to("One")

        self.assertTrue(first["ok"])
        self.assertTrue(second["skipped"])
        self.assertEqual(second["code"], launch_orchestrator.LAUNCH_PENDING)
        riot.launch_client.assert_called_once()

    def test_switching_to_another_profile_is_still_allowed(self):
        orchestrator, riot = self._orchestrator()

        orchestrator.switch_to("One")
        result = orchestrator.switch_to("Two")

        self.assertTrue(result["ok"])
        self.assertEqual(riot.launch_client.call_count, 2)

    def test_running_profile_is_not_launched_again(self):
        orchestrator, riot = self._orchestrator(running_profile="One", valorant=True)

        result = orchestrator.switch_to("One")

        self.assertTrue(result["skipped"])
        self.assertEqual(result["code"], launch_orchestrator.ALREADY_RUNNING)
        riot.launch_client.assert_not_called()

    def test_other_profile_still_asks_to_quit_the_game(self):
        orchestrator, riot = self._orchestrator(running_profile="One", valorant=True)

        result = orchestrator.switch_to("Two")

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], launch_orchestrator.VALORANT_RUNNING)
        riot.launch_client.assert_not_called()

    def test_queued_second_click_is_skipped_before_the_client_shows_up(self):
        """The spawned client is not in the process table for a moment."""
        orchestrator, riot = self._orchestrator(client=False)

        orchestrator.switch_to("One")
        second = orchestrator.switch_to("One")

        self.assertTrue(second["skipped"])
        riot.launch_client.assert_called_once()

    def test_pending_launch_clears_when_the_client_is_gone(self):
        orchestrator, _ = self._orchestrator(client=False)
        orchestrator._mark_launch_pending("One")
        orchestrator._pending_at -= launch_orchestrator.LAUNCH_PENDING_PROCESS_GRACE_S + 1

        self.assertEqual(orchestrator._pending_launch(), "")

    def test_pending_launch_clears_after_the_game_started(self):
        orchestrator, riot = self._orchestrator()
        orchestrator._mark_launch_pending("One")
        riot.product_started.return_value = True

        self.assertEqual(orchestrator._pending_launch(), "")


if __name__ == "__main__":
    unittest.main()
