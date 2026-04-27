"""
Auth module for the HYPR Report Hub backend.

Threat model recap
------------------
The Cloud Function exposes two classes of operations:

* Public reads — `?token=<short>` returns a campaign report. The short_token
  itself is the ticket. We do not protect these because the existing /report/
  links already in clients' inboxes must keep working unchanged.

* Admin writes — save_logo, save_loom, save_survey, save_upload, save_comment
  with author="HYPR", and the campaigns list (?list=true). These were
  previously open: anyone hitting the function with curl could write or list.
  This module gates all of them.

Auth flow
---------
1. HYPR member signs in to the front-end with Google OAuth and receives a
   Google id_token (JWT signed by Google, ~1h TTL).
2. Front calls POST ?action=issue_admin_token with
   `Authorization: Bearer <google_id_token>`. The backend validates the
   id_token via Google's tokeninfo endpoint and confirms the email ends
   in @hypr.mobi, then issues a short-lived custom JWT (5min, HS256).
3. For any admin write, front sends the custom JWT in
   `Authorization: Bearer <custom_jwt>`. Backend verifies signature,
   issuer, expiry and the admin claim before executing.

Why a custom JWT instead of just forwarding the Google id_token:
* 5min lifetime limits exposure if the URL leaks.
* No round-trip to Google on every admin write (verifying signature
  is local).
* Decouples our admin model from Google's OAuth specifics.

JWT is implemented with stdlib HMAC-SHA256 (no PyJWT dependency) to keep
the Cloud Function package small and cold-starts fast. ~40 lines, no magic.

Backwards compatibility
-----------------------
While the old front-end is still cached or being rolled out, the legacy
`?ak=hypr2026` query string still grants admin. This is intentional and
temporary. Once production traffic migrates, the legacy path is removed
in a follow-up commit.
"""

import os
import time
import json
import hmac
import hashlib
import base64
import urllib.request
import urllib.parse
from typing import Optional, Dict, Any


# ─── Config ──────────────────────────────────────────────────────────────────
JWT_SECRET = os.environ.get("JWT_SECRET", "")
JWT_TTL_SECONDS = 5 * 60       # 5 min — short to limit exposure if leaked.
JWT_ISSUER = "hypr-report-hub"
ADMIN_EMAIL_DOMAIN = "@hypr.mobi"

# Legacy admin key (DEPRECATED — remove after migration is verified).
LEGACY_ADMIN_KEY = "hypr2026"


# ─── Base64url helpers ───────────────────────────────────────────────────────
def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


# ─── HS256 JWT (compact, stdlib only) ────────────────────────────────────────
def _sign_hs256(secret: str, msg: bytes) -> bytes:
    return hmac.new(secret.encode(), msg, hashlib.sha256).digest()


def _encode_jwt(payload: Dict[str, Any], secret: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    h = _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
    p = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    sig = _sign_hs256(secret, f"{h}.{p}".encode())
    return f"{h}.{p}.{_b64url_encode(sig)}"


def _decode_and_verify_jwt(token: str, secret: str) -> Optional[Dict[str, Any]]:
    """Verify signature, issuer and expiry. Returns payload or None.

    Uses hmac.compare_digest to mitigate timing attacks on signature comparison.
    """
    try:
        h, p, s = token.split(".")
    except ValueError:
        return None
    expected_sig = _sign_hs256(secret, f"{h}.{p}".encode())
    try:
        actual_sig = _b64url_decode(s)
    except Exception:
        return None
    if not hmac.compare_digest(expected_sig, actual_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(p).decode())
    except Exception:
        return None
    if payload.get("iss") != JWT_ISSUER:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


# ─── Public API ──────────────────────────────────────────────────────────────
def issue_admin_jwt(email: str) -> str:
    """Mint a short-lived admin JWT for the given email.

    Caller is responsible for proving the email is legitimate (e.g. via
    `verify_google_id_token`). This function does not re-verify.
    """
    if not JWT_SECRET:
        raise RuntimeError("JWT_SECRET environment variable is not set")
    now = int(time.time())
    payload = {
        "iss": JWT_ISSUER,
        "sub": email,
        "admin": True,
        "iat": now,
        "exp": now + JWT_TTL_SECONDS,
    }
    return _encode_jwt(payload, JWT_SECRET)


def verify_google_id_token(id_token: str) -> Optional[Dict[str, Any]]:
    """Validate a Google-issued id_token via the tokeninfo endpoint.

    Returns the token payload if the token is valid AND
    `email_verified` is true AND email ends with @hypr.mobi.
    Otherwise None.

    Note: tokeninfo is an HTTP call (~50-150ms). This runs only once per
    admin login (when issuing our custom JWT), not on every admin action.
    """
    if not id_token:
        return None
    try:
        url = (
            "https://oauth2.googleapis.com/tokeninfo?id_token="
            + urllib.parse.quote(id_token)
        )
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"[WARN verify_google_id_token] {e}")
        return None

    email = (data.get("email") or "").lower()
    if not email.endswith(ADMIN_EMAIL_DOMAIN):
        return None
    # Google returns this as the string "true" in tokeninfo, not a boolean.
    if str(data.get("email_verified", "")).lower() != "true":
        return None
    return data


def authenticate_admin(request) -> Optional[Dict[str, Any]]:
    """Return admin identity dict if request is authenticated, else None.

    Two accepted modes:
      1. `Authorization: Bearer <custom_jwt>` (preferred, post-migration).
      2. `?ak=hypr2026` legacy (deprecated, removed once migration completes).

    Identity dict shape:
      {"email": "...", "admin": True, "source": "jwt" | "legacy"}
    """
    # Mode 1 — custom JWT in Authorization header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[len("Bearer "):].strip()
        payload = _decode_and_verify_jwt(token, JWT_SECRET)
        if payload and payload.get("admin") is True:
            return {
                "email": payload.get("sub", ""),
                "admin": True,
                "source": "jwt",
            }

    # Mode 2 — legacy query string (DEPRECATED)
    if request.args.get("ak") == LEGACY_ADMIN_KEY:
        return {
            "email": "legacy",
            "admin": True,
            "source": "legacy",
        }

    return None
