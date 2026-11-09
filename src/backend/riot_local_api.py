"""Minimal client for the Riot Client's local HTTPS API.

The client writes ``Config/lockfile`` (``name:pid:port:password:https``) once it
is up and serves a loopback API authenticated with HTTP Basic ``riot:<password>``.
The app uses three calls from it:

* ``GET /product-session/v1/sessions`` - tells us whether the requested product
  (VALORANT) actually got a session, which is more precise than watching the
  process table.
* ``GET /product-metadata/v2/products`` - the client's own catalogue, so the
  product id and patchline come from the installed client instead of a
  hard-coded assumption.
* ``POST /product-launcher/v1/products/<product>/patchlines/<patchline>`` -
  starts the product explicitly when Riot's own ``--launch-product`` request
  was dropped.

Only loopback traffic is possible: the host is hard-coded to ``127.0.0.1`` and
the port comes from Riot's own lockfile. The client certificate is self-signed,
so verification is disabled for that one connection.
"""

import base64
import json
import os
import ssl
import urllib.error
import urllib.request

LOCKFILE_MIN_PARTS = 5
REQUEST_TIMEOUT_S = 5.0
# The client's own catalogue: product id -> its patchlines. The app does not
# keep its own copy of "valorant"/"live"; whatever the installed client reports
# is what the product launcher is asked for.
PRODUCT_METADATA_PATH = "/product-metadata/v2/products"


def lockfile_path():
    """Return the Riot Client lockfile path, or "" when LOCALAPPDATA is unset."""
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if not local_app_data:
        return ""
    return os.path.join(local_app_data, "Riot Games", "Riot Client", "Config", "lockfile")


def read_credentials(path=None, client_pid=None):
    """Return ``(port, password)`` from the lockfile, or ``None``.

    The lockfile is rewritten on every client start, so it is read per call
    rather than cached. A missing/stale file (client not running) is a normal
    state, not an error.

    ``client_pid`` makes the check strict: the lockfile carries the owning
    client's PID (``name:pid:port:password:https``), so a file left behind by
    the client the switch just killed cannot be mistaken for the new one. The
    port changes between starts, and a cached read of the old file would make
    every later request hit a dead port.
    """
    path = path or lockfile_path()
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            parts = fh.read().strip().split(":")
    except OSError:
        return None
    if len(parts) < LOCKFILE_MIN_PARTS:
        return None
    if client_pid is not None:
        try:
            if int(parts[1]) != int(client_pid):
                return None
        except ValueError:
            return None
    try:
        port = int(parts[2])
    except ValueError:
        return None
    password = parts[3]
    if port <= 0 or not password:
        return None
    return port, password


def _request(port, password, path, method="GET", timeout=REQUEST_TIMEOUT_S):
    """Call the loopback API. Returns ``(status, body_text)``; ``0`` on failure."""
    token = base64.b64encode(f"riot:{password}".encode()).decode()
    headers = {"Authorization": f"Basic {token}"}
    data = None
    if method == "POST":
        # The product launcher takes no parameters; an explicit empty body
        # avoids servers that reject a body-less POST.
        data = b""
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"https://127.0.0.1:{port}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    # Riot's local API answers on loopback with a certificate generated for the
    # local install, which no public CA signs: hostname verification against
    # 127.0.0.1 would reject every call. The socket never leaves the machine and
    # every request carries the lockfile token, which is the real authenticator.
    context = ssl.create_default_context()  # NOSONAR
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE  # NOSONAR
    try:
        with urllib.request.urlopen(request, context=context, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, ""
    except (OSError, ValueError):
        return 0, ""


def product_sessions(port, password, timeout=REQUEST_TIMEOUT_S):
    """Return the client's session map (``productId`` -> session dict).

    ``{}`` means the call failed or the client has no sessions yet; callers
    treat that as "not started".
    """
    status, text = _request(port, password, "/product-session/v1/sessions", timeout=timeout)
    if status != 200 or not text:
        return {}
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def has_product(port, password, product, patchline, timeout=REQUEST_TIMEOUT_S):
    """True when the client reports a session for this product/patchline."""
    for session in product_sessions(port, password, timeout).values():
        if not isinstance(session, dict):
            continue
        if session.get("productId") == product and session.get("patchlineId") == patchline:
            return True
    return False


def product_patchlines(port, password, timeout=REQUEST_TIMEOUT_S):
    """Return ``{productId: [patchlineId, ...]}`` from the client's metadata.

    ``{}`` means the call failed or the client has not published its catalogue
    yet; callers keep their own defaults in that case.
    """
    status, text = _request(port, password, PRODUCT_METADATA_PATH, timeout=timeout)
    if status != 200 or not text:
        return {}
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    products = data.get("products") if isinstance(data, dict) else None
    if not isinstance(products, dict):
        return {}
    catalogue = {}
    for product_id, entry in products.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("patchlines"), dict):
            continue
        prefix = product_id + "."
        catalogue[product_id] = [
            key[len(prefix):] for key in entry["patchlines"] if key.startswith(prefix)
        ]
    return catalogue


def resolve_product(port, password, product, patchline, timeout=REQUEST_TIMEOUT_S):
    """Return the ``(product, patchline)`` pair the client itself expects.

    The requested patchline wins when the client lists it; otherwise the
    client's first patchline for that product is used. Without metadata the
    caller's pair is returned unchanged.
    """
    patchlines = product_patchlines(port, password, timeout=timeout).get(product) or []
    if patchline in patchlines:
        return product, patchline
    if patchlines:
        return product, patchlines[0]
    return product, patchline


def launch_product_status(port, password, product, patchline, timeout=REQUEST_TIMEOUT_S):
    """Ask the client to start the product. Returns the HTTP status (0 = no answer).

    ``423 Locked`` is the client's way of saying the product is already being
    started, so the watchdog treats it like a success instead of retrying.
    """
    path = f"/product-launcher/v1/products/{product}/patchlines/{patchline}"
    status, _ = _request(port, password, path, method="POST", timeout=timeout)
    return status


def launch_product(port, password, product, patchline, timeout=REQUEST_TIMEOUT_S):
    """Ask the client to start the product. True when the request was accepted."""
    return 200 <= launch_product_status(port, password, product, patchline, timeout) < 300
