"""Minimal client for the Riot Client's local HTTPS API.

The client writes ``Config/lockfile`` (``name:pid:port:password:https``) once it
is up and serves a loopback API authenticated with HTTP Basic ``riot:<password>``.
The app uses exactly two calls from it:

* ``GET /product-session/v1/sessions`` - tells us whether the requested product
  (VALORANT) actually got a session, which is more precise than watching the
  process table.
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


def lockfile_path():
    """Return the Riot Client lockfile path, or "" when LOCALAPPDATA is unset."""
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if not local_app_data:
        return ""
    return os.path.join(local_app_data, "Riot Games", "Riot Client", "Config", "lockfile")


def read_credentials(path=None):
    """Return ``(port, password)`` from the lockfile, or ``None``.

    The lockfile is rewritten on every client start, so it is read per call
    rather than cached. A missing/stale file (client not running) is a normal
    state, not an error.
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
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
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


def launch_product(port, password, product, patchline, timeout=REQUEST_TIMEOUT_S):
    """Ask the client to start the product. True when the request was accepted."""
    path = f"/product-launcher/v1/products/{product}/patchlines/{patchline}"
    status, _ = _request(port, password, path, method="POST", timeout=timeout)
    return 200 <= status < 300
