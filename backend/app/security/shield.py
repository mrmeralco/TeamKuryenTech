"""Browser challenge and attack mode, ported from the Spotibai reference (lib/shield.js).

Bot protection: a page request without a valid verification cookie gets a small "Checking your browser…" page
instead of the site. Its script (/__c.js, a separate file so the CSP holds) solves a SHA-256 proof-of-work puzzle
and sends the answer to /__v; the server then sets an HttpOnly cookie. Anything that can't run JavaScript never
gets past it, and the API refuses requests without the cookie. The puzzle token and the cookie are HMAC-signed
(BOT_SECRET) and the cookie is bound to the user agent, so nothing is stored: it works across serverless
instances. Search engines skip the challenge so the site stays indexed.

Attack mode: more than FLOOD_LIMIT requests in 10 s on one instance (or ATTACK_MODE=1) turns it on for 10 minutes:
the puzzle gets harder (4 instead of 3 leading zero hex digits) and every per-IP limit drops to a quarter. It
switches itself off when the flood stops.

Honest limit: a real browser (or a script that runs the puzzle) still passes; this raises the cost of bulk
scraping and floods, it does not make them impossible.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import re
import secrets
import time

logger = logging.getLogger("smartwatts.security")

COOKIE = "sw_v"
TOKEN_SECONDS = 5 * 60
FLOOD_LIMIT = 600            # requests one instance may see in 10 s before attack mode starts
ATTACK_SECONDS = 10 * 60


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class Shield:
    def __init__(self, secret: bytes, forced_attack: bool = False, clock=time.time):
        self._secret = secret
        self._forced = forced_attack
        self._clock = clock
        self._attack_until = 0.0
        self._bucket_start = 0.0
        self._bucket_count = 0

    # ---- attack mode ------------------------------------------------------------------------------------------
    def note_request(self) -> None:
        now = self._clock()
        if now - self._bucket_start > 10:
            self._bucket_start, self._bucket_count = now, 0
        self._bucket_count += 1
        if self._bucket_count > FLOOD_LIMIT:
            if now >= self._attack_until:
                logger.warning("shield: attack mode ON (%d requests in 10 s on this instance)", self._bucket_count)
            self._attack_until = now + ATTACK_SECONDS

    def attack_mode(self) -> bool:
        return self._forced or self._clock() < self._attack_until

    def scaled(self, limit: int) -> int:
        return max(5, math.ceil(limit / 4)) if self.attack_mode() else limit

    def difficulty(self) -> int:
        return 4 if self.attack_mode() else 3  # leading zero hex digits of sha256(token:n): ~4k / ~65k hashes

    # ---- signing ----------------------------------------------------------------------------------------------
    def _hmac(self, value: str) -> str:
        return hmac.new(self._secret, value.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _same(a: str, b: str) -> bool:
        return hmac.compare_digest(a.encode(), b.encode())

    @staticmethod
    def _ua_tag(user_agent: str) -> str:
        return _sha(user_agent)[:16]

    # ---- cookie -----------------------------------------------------------------------------------------------
    def cookie_value(self, user_agent: str) -> tuple[str, int]:
        ttl = 30 * 60 if self.attack_mode() else 60 * 60
        exp = int((self._clock() + ttl) * 1000)
        return f"{exp}.{self._hmac(f'v|{exp}|{self._ua_tag(user_agent)}')}", ttl

    def verified(self, cookie_header: str, user_agent: str) -> bool:
        value = ""
        for part in cookie_header.split(";"):
            name, _, rest = part.strip().partition("=")
            if name == COOKIE:
                value = rest
        exp, _, sig = value.partition(".")
        if not exp.isdigit() or not sig or int(exp) <= self._clock() * 1000:
            return False
        return self._same(sig, self._hmac(f"v|{exp}|{self._ua_tag(user_agent)}"))

    # ---- puzzle -----------------------------------------------------------------------------------------------
    def new_token(self) -> str:
        exp, rand, d = int((self._clock() + TOKEN_SECONDS) * 1000), secrets.token_hex(8), self.difficulty()
        return f"{exp}.{rand}.{d}.{self._hmac(f'c|{exp}|{rand}|{d}')}"

    def pow_ok(self, token: str, answer: str) -> bool:
        parts = token.split(".")
        if len(parts) != 4:
            return False
        exp, rand, d, sig = parts
        if not exp.isdigit() or not d.isdigit() or int(exp) <= self._clock() * 1000:
            return False
        if not self._same(sig, self._hmac(f"c|{exp}|{rand}|{d}")):
            return False
        if not re.fullmatch(r"\d{1,12}", answer or ""):
            return False
        return _sha(f"{token}:{answer}").startswith("0" * int(d))

    # ---- responses --------------------------------------------------------------------------------------------
    def challenge_page(self) -> bytes:
        token, d = self.new_token(), self.difficulty()
        return (
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
            '<title>Checking your browser…</title></head>'
            f'<body data-t="{token}" data-d="{d}" style="margin:0;min-height:100vh;display:grid;place-items:center;'
            'background:#fffaf2;color:#3d2a17;font:15px system-ui,sans-serif;text-align:center">'
            '<p id="m">Checking your browser…<noscript><br>Please enable JavaScript to continue.</noscript></p>'
            f'<script src="/__c.js?v={_sha(CLIENT_JS)[:8]}"></script></body></html>'
        ).encode()

    def token_json(self) -> bytes:
        return json.dumps({"t": self.new_token(), "d": self.difficulty()}).encode()


# Runs in the visitor's browser (served as a file: no inline scripts under the CSP).
CLIENT_JS = """(async()=>{
const b=document.body,t=b.dataset.t,d=+b.dataset.d,e=new TextEncoder(),m=document.getElementById("m");
try{const k=+sessionStorage.getItem("swTry")||0;sessionStorage.setItem("swTry",k+1);if(k>=4){m.textContent="Your browser is blocking cookies. Enable cookies for this site and reload.";return}}catch(_){}
const ok=h=>{for(let i=0;i<d;i++){if(((i&1)?h[i>>1]&15:h[i>>1]>>4)!==0)return false}return true};
for(let n=0;;n++){
const h=new Uint8Array(await crypto.subtle.digest("SHA-256",e.encode(t+":"+n)));
if(ok(h)){
const r=await fetch("/__v?t="+encodeURIComponent(t)+"&n="+n,{credentials:"same-origin"});
if(r.ok){try{sessionStorage.removeItem("swTry")}catch(_){}location.reload()}else m.textContent="Verification failed. Please reload the page.";
return}}
})();
"""
