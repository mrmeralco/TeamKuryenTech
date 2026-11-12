"""Security headers sent on every response (pages, API, errors and 404s).

The same list is mirrored in vercel.json (a test keeps them identical).

Third-party sources the Content-Security-Policy has to allow, and why:
  script-src  'unsafe-eval'       landing-page runtime (landing/support.js) compiles its templates with new Function,
                                  and the obfuscated production build (scripts/protect-build.mjs) uses eval for its
                                  self-defending checks
              'wasm-unsafe-eval'  OCR (tesseract.js) and PDF (pdf.js) decoders are WebAssembly
              www.gstatic.com     Firebase Auth SDK modules imported by landing/auth.js
              apis.google.com     Firebase Google sign-in popup helper
              cdn.jsdelivr.net    tesseract.js worker and core scripts (bill / appliance-label OCR)
  style-src   fonts.googleapis.com  Google Fonts stylesheets
  font-src    fonts.gstatic.com   Google Fonts files
  connect-src *.googleapis.com    Firebase Auth / Firestore / Storage / Installations
              api.mapbox.com, events.mapbox.com   Business Centers map tiles, geocoding, telemetry
              tessdata.projectnaptha.com, cdn.jsdelivr.net   OCR language data and WebAssembly core
  frame-src   *.firebaseapp.com   Firebase Auth hidden iframe used by Google sign-in
  worker-src  blob:               Mapbox GL and tesseract.js start their web workers from blob: URLs
  img-src     https: blob:        map tiles, camera captures and previews
"""

from __future__ import annotations

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://www.gstatic.com https://apis.google.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' data: blob: https://*.googleapis.com https://api.mapbox.com https://events.mapbox.com "
    "https://tessdata.projectnaptha.com https://cdn.jsdelivr.net",
    "font-src 'self' data: https://fonts.gstatic.com",
    "frame-src https://*.firebaseapp.com",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
])

SECURITY_HEADERS: dict[str, str] = {
    "Content-Security-Policy": CSP,
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    # camera / geolocation stay available to the site itself: the bill scanner uses the camera and the
    # Business Centers map can use the visitor's location. Everything else is off.
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(self), payment=()",
    # same-origin-allow-popups (not same-origin): Firebase Google sign-in talks to its popup window.
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Cross-Origin-Resource-Policy": "same-site",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-DNS-Prefetch-Control": "off",
}

# Headers that reveal the server or framework; stripped from every response.
REMOVED_HEADERS = frozenset({b"server", b"x-powered-by"})


def security_header_items() -> list[tuple[bytes, bytes]]:
    return [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in SECURITY_HEADERS.items()]
