"""Riot Client lifecycle management.

Owns everything about starting and stopping the Riot Client: locating the
install, building launch arguments from the LaunchProduct setting, killing the
running processes, waiting for them to fully exit, and launching the client.

Replaces the process/kill/launch concerns that lived in Godot's
RiotProcesses + ProfileGridController. Session-file swapping and profile
selection are wired in during Step 5; the launch primitive and argument builder
live here so the UI can reuse them.
"""

import json
import os
import subprocess
import sys
import threading
import time

import riot_local_api as local_api
import riot_processes as rp

CLIENT_EXE = "RiotClientServices.exe"

# Launch product values (matches the LaunchProduct setting).
LAUNCH_PRODUCT_RIOT = "riot"       # Riot client only, no game auto-launch.
LAUNCH_PRODUCT_VALORANT = "valorant"  # Auto-launch VALORANT after the client.
DEFAULT_LAUNCH_PRODUCT = LAUNCH_PRODUCT_VALORANT
LAUNCH_PATCHLINE = "live"  # fallback when the client's install record is unreadable

# Riot treats --launch-product as a hint: it reaches the product page and then
# sometimes never presses Play (seen in the client log: the VALORANT page loads,
# no "product-launcher: Launch starting" follows). Waiting for Riot costs
# 10-20 s even when it does work, so the watchdog does not wait: the moment the
# client's local API answers, it asks the product launcher itself. A client that
# is not ready yet rejects the request; the retry covers that.
PRODUCT_LAUNCH_RETRY_S = 1.0
PRODUCT_LAUNCH_MAX_ATTEMPTS = 60
PRODUCT_LAUNCH_POLL_S = 0.2
# The client stops answering while it boots; a 5 s socket timeout would turn
# every poll into a 5 s stall and push the retry out with it. Short calls keep
# the loop responsive, and a refused connection is simply "not ready yet".
PRODUCT_LAUNCH_API_TIMEOUT_S = 0.5
PRODUCT_LAUNCH_TIMEOUT_S = 150.0
# The client returns this when the product is already being launched.
HTTP_LOCKED = 423
# If a 423 never turns into a session, start posting again after this long.
PRODUCT_LAUNCH_RELOCK_S = 20.0

# Riot's canonical install manifest and metadata YAML.
RIOT_INSTALLS_JSON = r"C:/ProgramData/Riot Games/RiotClientInstalls.json"
RIOT_METADATA_YAML = r"C:/ProgramData/Riot Games/Metadata/Riot Client/Riot Client.product_settings.yaml"

# Registry keys where Riot registers install locations. Used for games; the
# Riot Client folder is derived as a sibling under <drive>/Riot Games/.
RIOT_GAME_REG_KEYS = [
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Riot Game valorant.live",
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Riot Game valorant.live",
    r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Riot Game valorant.live",
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Riot Game league_of_legends.live",
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Riot Game league_of_legends.live",
]

COMMON_DRIVES = ["D:", "C:", "E:", "F:", "G:"]
RIOT_CLIENT_DIR_NAME = "Riot Client"
COMMON_INSTALL_PATH = r"/Riot Games/" + RIOT_CLIENT_DIR_NAME

# Riot Client installs JSON carries the associated-game install path; the
# client's own folder is a sibling of those games under <drive>/Riot Games/.



class RiotClientError(Exception):
    """Raised when the Riot Client cannot be located or launched."""


def _log(message):
    """Write a watchdog diagnostic line to stderr.

    The Electron bridge forwards backend stderr into ``main.log``, so a failed
    auto-launch leaves evidence instead of a silent no-op.
    """
    try:
        sys.stderr.write(f"[watchdog] {message}\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


class _ProductLaunch:
    """State for one product-launch watchdog run.

    ``poll`` is called once per observation with fresh lockfile credentials.
    It answers whether the game is up, and otherwise sends a launch request
    when one is due. Keeping the counters here keeps the polling loop readable
    and the timing rules in one place.
    """

    def __init__(self, product, patchline, started_at):
        self.product = product
        self.patchline = patchline
        self.started_at = started_at
        self.attempts = 0
        self.last_attempt = 0.0
        self.resolved = False
        self.launching = False
        self.status = 0

    def elapsed(self, now):
        return now - self.started_at

    def poll(self, port, password, now):
        """Observe once. True once the client reports the product session."""
        if local_api.has_product(
            port, password, self.product, self.patchline,
            timeout=PRODUCT_LAUNCH_API_TIMEOUT_S,
        ):
            return True
        # A 423 says the client is already starting the product; stop
        # re-posting, but fall back to retrying if it never appears.
        if self.launching and now - self.last_attempt >= PRODUCT_LAUNCH_RELOCK_S:
            self.launching = False
        if self._request_due(now):
            self._ask(port, password, now)
        return False

    def _request_due(self, now):
        if self.launching or self.attempts >= PRODUCT_LAUNCH_MAX_ATTEMPTS:
            return False
        return self.attempts == 0 or now - self.last_attempt >= PRODUCT_LAUNCH_RETRY_S

    def _ask(self, port, password, now):
        self.attempts += 1
        self.last_attempt = now
        self.status = local_api.launch_product_status(
            port, password, self.product, self.patchline,
            timeout=PRODUCT_LAUNCH_API_TIMEOUT_S,
        )
        _log(
            f"watchdog: launch request {self.attempts} status={self.status} "
            f"after {self.elapsed(now):.1f}s"
        )
        if 200 <= self.status < 300 or self.status == HTTP_LOCKED:
            self.launching = True
        if not self.resolved and self.status:
            # The client answered, so its catalogue is readable.
            self._resolve(port, password)

    def _resolve(self, port, password):
        self.product, self.patchline = local_api.resolve_product(
            port, password, self.product, self.patchline,
            timeout=PRODUCT_LAUNCH_API_TIMEOUT_S,
        )
        self.resolved = True
        _log(f"watchdog: targeting {self.product}.{self.patchline}")


def _reg_install_location(reg_key):
    """Query a registry InstallLocation value, returning "" when absent."""
    try:
        result = subprocess.run(
            ["reg", "query", reg_key, "/v", "InstallLocation"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if result.returncode != 0:
        return ""
    for line in result.stdout.splitlines():
        if "InstallLocation" in line and "REG_SZ" in line:
            parts = line.split("REG_SZ", 1)
            if len(parts) >= 2:
                return parts[1].strip()
    return ""


def patchline_from_installs(default=LAUNCH_PATCHLINE):
    """Return the patchline the Riot Client installed for VALORANT.

    ``RiotClientInstalls.json`` records associated clients as
    ``C:/Riot Games/VALORANT/live/``: the last two segments are the game folder
    and its patchline. Reading it means the launch argument follows the
    installed client instead of assuming ``live``. Any read/parse failure keeps
    the default.
    """
    try:
        with open(RIOT_INSTALLS_JSON, encoding="utf-8", errors="replace") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return default
    associated = data.get("associated_client") if isinstance(data, dict) else None
    if not isinstance(associated, dict):
        return default
    for path in associated:
        parts = [part for part in str(path).replace("\\", "/").split("/") if part]
        if len(parts) >= 2 and parts[-2].lower() == "valorant":
            patchline = parts[-1].strip().lower()
            if patchline:
                return patchline
    return default


class RiotClientManager:
    """Locates, kills, waits for, and launches the Riot Client."""

    def __init__(self, config, client_exe=CLIENT_EXE):
        self._config = config
        self._client_exe = client_exe
        self._job_lock = threading.Lock()
        self._thread = None
        self._jobs = []
        self._last_error = None
        self._listener = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_listener(self, listener):
        """listener(status) is called after each kill/wait transition."""
        self._listener = listener

    def get_location(self):
        return str(self._config.get("RiotClientLocation", "") or "")

    def detect_install_dir(self):
        """Auto-locate the Riot Client install directory via install manifests,
        registry, metadata YAML, and common drive locations.

        Returns the absolute folder containing RiotClientServices.exe, or ""
        if it cannot be found.
        """
        # 1. Riot Client installs JSON -> <drive>/Riot Games/Riot Client.
        for candidate in self._client_dirs_from_installs_json():
            if self._is_client_dir(candidate):
                return candidate

        # 2. Registry InstallLocation of associated games -> sibling Riot Client.
        for key in RIOT_GAME_REG_KEYS:
            location = _reg_install_location(key)
            if location:
                # Game install -> parent Riot Games dir -> sibling Riot Client.
                parent = os.path.dirname(location.replace("\\", "/"))
                candidate = os.path.join(parent, RIOT_CLIENT_DIR_NAME).replace("\\", "/")
                if self._is_client_dir(candidate):
                    return candidate

        # 3. Metadata YAML product_install_full_path(sibling of Riot Client).
        for candidate in self._client_dirs_from_metadata_yaml():
            if self._is_client_dir(candidate):
                return candidate

        # 4. Common drive locations.
        for drive in COMMON_DRIVES:
            candidate = f"{drive}/Riot Games/{RIOT_CLIENT_DIR_NAME}"
            if self._is_client_dir(candidate):
                return candidate

        return ""

    def ensure_location(self):
        """Return the configured client location, auto-detecting it if unset.
        Raises RiotClientError if it still cannot be found."""
        location = self.get_location()
        if not location:
            detected = self.detect_install_dir()
            if detected:
                self._config.set("RiotClientLocation", detected)
                location = detected
        if not location:
            raise RiotClientError("Riot Client location is not set")
        return location

    # ------------------------------------------------------------------
    # Install discovery helpers
    # ------------------------------------------------------------------

    def _is_client_dir(self, folder):
        if not folder or not os.path.isdir(folder):
            return False
        return os.path.isfile(os.path.join(folder, self._client_exe))

    def _client_dirs_from_installs_json(self):
        """Derive candidate Riot Client install dirs from RiotClientInstalls.json.

        The JSON maps associated games to their install paths under
        <drive>/Riot Games/<game>. From any such path the client is its sibling
        at <drive>/Riot Games/Riot Client. Also handles keys that directly name
        a "Riot Client" path.
        """
        candidates = []
        if not os.path.isfile(RIOT_INSTALLS_JSON):
            return candidates
        try:
            with open(RIOT_INSTALLS_JSON, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return candidates
        if not isinstance(data, dict):
            return candidates

        paths = set()
        associated = data.get("associated_client", {})
        if isinstance(associated, dict):
            for path_key in associated:
                paths.add(str(path_key).replace("\\", "/").rstrip("/"))
        for _key, value in data.items():
            if isinstance(value, str) and "Riot" in str(value):
                paths.add(str(value).replace("\\", "/").rstrip("/"))

        for p in paths:
            if not p:
                continue
            if p.lower().endswith(RIOT_CLIENT_DIR_NAME.lower()):
                candidates.append(p)
                continue
            parent = os.path.dirname(p)
            candidates.append(os.path.join(parent, RIOT_CLIENT_DIR_NAME).replace("\\", "/"))
        return candidates

    def _client_dirs_from_metadata_yaml(self):
        """Candidates derived from the Riot Client metadata YAML install path."""
        paths = []
        if not os.path.isfile(RIOT_METADATA_YAML):
            return paths
        try:
            with open(RIOT_METADATA_YAML, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    stripped = line.strip()
                    if stripped.startswith("product_install_full_path:"):
                        parts = stripped.split(":", 1)
                        if len(parts) >= 2:
                            path = parts[1].strip().strip('"').strip("'")
                            path = path.replace("\\", "/").rstrip("/")
                            paths.append(path)
                            if not path.lower().endswith(RIOT_CLIENT_DIR_NAME.lower()):
                                parent = os.path.dirname(path)
                                paths.append(os.path.join(parent, RIOT_CLIENT_DIR_NAME).replace("\\", "/"))
        except OSError:
            pass
        return paths

    def set_location(self, folder):
        """Validate that RiotClientServices.exe exists, then persist.

        Returns the resolved executable path, or raises RiotClientError.
        """
        folder = (folder or "").strip()
        if not folder or not os.path.isdir(folder):
            raise RiotClientError("Riot Client folder does not exist")
        exe = os.path.join(folder, self._client_exe)
        if not os.path.isfile(exe):
            raise RiotClientError(f"{self._client_exe} not found in the selected folder")
        self._config.set("RiotClientLocation", folder)
        return exe

    def get_launch_product(self):
        value = str(self._config.get("LaunchProduct", DEFAULT_LAUNCH_PRODUCT))
        return value if value in (LAUNCH_PRODUCT_RIOT, LAUNCH_PRODUCT_VALORANT) else DEFAULT_LAUNCH_PRODUCT

    def build_launch_args(self, product=None, patchline=None):
        """Build the Riot Client launch arguments from the saved setting.

        ``product`` / ``patchline`` let the caller reuse values it already
        resolved (the watchdog needs the same patchline that was sent).
        """
        product = product or self.get_launch_product()
        patchline = patchline or patchline_from_installs()
        return [
            f"--launch-product={product}",
            f"--launch-patchline={patchline}",
        ]

    def launch_client(self, confirm_product=False):
        """Spawn the Riot Client with the configured launch arguments.

        The client location is auto-detected if not yet configured. Returns the
        PID on success. Raises RiotClientError if the client cannot be located
        or fails to spawn.

        ``confirm_product`` enables the launch watchdog described below. Profile
        launches set it; the Add Account flow does not, because opening the game
        while the user is expected to sign in would interrupt the flow.
        """
        exe = self.ensure_location()
        client_path = os.path.join(exe, self._client_exe)
        if not os.path.isfile(client_path):
            raise RiotClientError(f"{self._client_exe} not found in the selected folder")
        product = self.get_launch_product()
        patchline = patchline_from_installs()
        try:
            proc = subprocess.Popen(
                [client_path] + self.build_launch_args(product, patchline),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            raise RiotClientError(f"Failed to launch Riot Client: {exc}") from exc
        if confirm_product and product == LAUNCH_PRODUCT_VALORANT:
            threading.Thread(
                target=self._confirm_product_launch,
                args=(product, patchline, proc.pid),
                daemon=True,
            ).start()
        return proc.pid

    def _confirm_product_launch(self, product, patchline, client_pid=None):
        """Start the product as soon as the client's local API answers.

        Runs on a daemon thread so the launch request returns as soon as the
        client is spawned: the game can take 15-40 s to appear, and the UI must
        not wait for that. Polls the client's local API, which reports the real
        product session (``productId``/``patchlineId``) - more reliable than
        guessing from the process table. The product launcher endpoint is called
        on the first poll that has credentials (there is no grace window), then
        retried until the session appears or the timeout expires. A ``423``
        answer means the client is already starting the product, so it stops
        re-posting instead of fighting Riot's own auto-launch.

        Lockfile credentials are re-read on every poll and must belong to the
        client this launch spawned (``client_pid``). The previous client's
        lockfile can survive a force-kill; its port is dead, and caching it
        would silently disable every later request.

        The product/patchline pair is confirmed against the client's own
        catalogue once the API answers; the requested pair is only the
        fallback while the client is still starting.
        """
        started_at = time.monotonic()
        deadline = started_at + PRODUCT_LAUNCH_TIMEOUT_S
        launch = _ProductLaunch(product, patchline, started_at)
        while time.monotonic() < deadline:
            credentials = local_api.read_credentials(client_pid=client_pid)
            if credentials and launch.poll(credentials[0], credentials[1], time.monotonic()):
                if launch.attempts:
                    _log(
                        f"watchdog: {launch.product}.{launch.patchline} is up after "
                        f"{launch.attempts} launch request(s), "
                        f"{launch.elapsed(time.monotonic()):.1f}s after spawn"
                    )
                return
            time.sleep(PRODUCT_LAUNCH_POLL_S)
        _log(
            f"watchdog: gave up on {launch.product}.{launch.patchline} after "
            f"{launch.attempts} launch request(s), last status={launch.status}"
        )

    def is_running(self):
        """True while any known Riot process is running."""
        return rp.are_any_running()

    def status(self):
        """Return a snapshot of what is currently running."""
        running = rp.running_processes()
        return {
            "running": bool(running),
            "processes": running,
            "client_location": self.get_location(),
            "launch_product": self.get_launch_product(),
            "launch_args": self.build_launch_args(),
        }

    # ------------------------------------------------------------------
    # Non-blocking control
    # ------------------------------------------------------------------

    def kill_all(self):
        """Queue a background taskkill for every Riot process."""
        self._enqueue("kill")

    def kill_all_and_wait(self):
        """Stop the Riot Client and block until it is gone.

        The Add Account flow needs this: launching immediately after a
        fire-and-forget kill lets taskkill reach the *new* client process and
        kill it too, so no window ever appears. VALORANT is deliberately not
        part of it — the app never closes the game.
        """
        return rp.shutdown_stop()

    def stop_and_wait(self):
        """Queue a background stop of the Riot Client, leaving VALORANT alone.

        The "stop_riot_client" request is what the app issues when it shuts
        down, so it must never reach the game processes.
        """
        self._enqueue("stop")

    def _emit(self, status):
        if self._listener:
            try:
                self._listener(status)
            except Exception:  # noqa: BLE001
                pass

    def _enqueue(self, kind):
        with self._job_lock:
            self._jobs.append(kind)
            if not self._thread or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._worker, daemon=True)
                self._thread.start()

    def _worker(self):
        while True:
            with self._job_lock:
                if not self._jobs:
                    break
                kind = self._jobs.pop(0)
            if kind == "kill":
                rp.kill_all()
                self._emit("killed")
            elif kind == "stop":
                # Shutdown path: the Riot Client only. VALORANT is not ours to
                # close just because the switcher is going away.
                ok = rp.shutdown_stop()
                self._last_error = None if ok else "Timed out waiting for Riot processes to exit."
                self._emit("stopped" if ok else "stop_failed")
