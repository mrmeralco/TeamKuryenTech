"""OCR for Meralco bills and appliance rating labels.

Privacy design (flowchart step 6 / Data Privacy Act):
- Images are decoded in memory and never written to our own files or logs.
  (pytesseract internally uses a temp file that it deletes after each call.)
- Only the structured numbers SmartWatts needs are returned. Account numbers,
  names and addresses are never extracted, and raw OCR text is not returned.
- OCR output is a suggestion; the user must confirm every value (step 4/5).
"""

from __future__ import annotations

import io
import re
import warnings
from dataclasses import dataclass, field
from datetime import date

from PIL import Image, ImageOps, UnidentifiedImageError

ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
MAX_PIXELS = 40_000_000

MONTHS = {
    m: i + 1
    for i, names in enumerate(
        [
            ("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"),
            ("may",), ("jun", "june"), ("jul", "july"), ("aug", "august"),
            ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"), ("dec", "december"),
        ]
    )
    for m in names
}

CHARGE_LABELS = [
    ("generation", r"generation\s+charge"),
    ("transmission", r"transmission\s+charge"),
    ("system_loss", r"system\s+loss\s+charge"),
    ("distribution", r"distribution\s+charge"),
    ("supply", r"supply\s+charge"),
    ("metering", r"metering\s+charge"),
    ("taxes", r"(?:government\s+)?taxes"),
    ("universal", r"universal\s+charges?"),
]


class ImageRejected(ValueError):
    pass


class OcrUnavailable(RuntimeError):
    pass


def load_image(data: bytes, max_bytes: int) -> Image.Image:
    if not data:
        raise ImageRejected("The file is empty.")
    if len(data) > max_bytes:
        raise ImageRejected(f"The image is larger than {max_bytes // (1024 * 1024)} MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            probe = Image.open(io.BytesIO(data))
            fmt = probe.format
            probe.verify()
            img = Image.open(io.BytesIO(data))
            if img.width * img.height > MAX_PIXELS:
                raise ImageRejected("The image resolution is too large.")
            img.load()
    except (UnidentifiedImageError, Image.DecompressionBombWarning, Image.DecompressionBombError, OSError, SyntaxError):
        raise ImageRejected("This file is not a readable JPEG, PNG or WebP image.") from None
    if fmt not in ALLOWED_FORMATS:
        raise ImageRejected("Only JPEG, PNG or WebP images are supported.")
    return img


def preprocess(img: Image.Image) -> Image.Image:
    img = ImageOps.exif_transpose(img).convert("L")
    if img.width < 1400:
        scale = 1400 / img.width
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    return ImageOps.autocontrast(img)


LOW_CONFIDENCE = 70.0


@dataclass
class OcrText:
    text: str
    confidence: float | None  # mean Tesseract word confidence 0-100, None when no words were found


def read_text(img: Image.Image) -> OcrText:
    """Run Tesseract once and return the text plus its mean word confidence."""
    try:
        import pytesseract

        data = pytesseract.image_to_data(
            preprocess(img), lang="eng", config="--psm 6", timeout=30, output_type=pytesseract.Output.DICT
        )
    except (ImportError, EnvironmentError) as exc:  # binary missing
        raise OcrUnavailable("The text-recognition engine is not available on the server.") from exc
    except RuntimeError as exc:  # pytesseract timeout
        raise OcrUnavailable("Reading the image took too long.") from exc

    lines: dict[tuple[int, int, int], list[str]] = {}
    confs: list[float] = []
    for i, word in enumerate(data["text"]):
        word = (word or "").strip()
        if not word:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append(word)
        try:
            c = float(data["conf"][i])
        except (TypeError, ValueError):
            continue
        if c >= 0:
            confs.append(c)
    text = "\n".join(" ".join(words) for _, words in sorted(lines.items()))
    return OcrText(text=text, confidence=round(sum(confs) / len(confs), 1) if confs else None)


def run_tesseract(img: Image.Image) -> str:
    return read_text(img).text


def field_status(fields: "BillFields") -> dict[str, str]:
    """Per-field outcome so the UI can point the user at values that were not read."""
    return {
        "periodStart": "read" if fields.periodStart else "not_found",
        "periodEnd": "read" if fields.periodEnd else "not_found",
        "kwh": "read" if fields.kwh is not None else "not_found",
        "totalAmountPhp": "read" if fields.totalAmountPhp is not None else "not_found",
    }


# ---------------------------------------------------------------- parsing

_NUM = r"(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)"
_DATE_PATTERNS = [
    # Jan 15, 2026 / January 15 2026
    (re.compile(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b"), "mdy_name"),
    # 15 Jan 2026
    (re.compile(r"\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b"), "dmy_name"),
    # 2026-01-15
    (re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b"), "iso"),
    # 01/15/2026 (Meralco prints month first)
    (re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b"), "mdy_num"),
]


def _to_float(s: str) -> float:
    return float(s.replace(",", "").replace(" ", ""))


def _safe_date(y: int, m: int, d: int) -> date | None:
    try:
        if y < 100:
            y += 2000
        return date(y, m, d)
    except ValueError:
        return None


def find_dates(text: str) -> list[tuple[int, date]]:
    found: list[tuple[int, date]] = []
    for rx, kind in _DATE_PATTERNS:
        for m in rx.finditer(text):
            g = m.groups()
            dt: date | None = None
            if kind == "mdy_name" and g[0].lower() in MONTHS:
                dt = _safe_date(int(g[2]), MONTHS[g[0].lower()], int(g[1]))
            elif kind == "dmy_name" and g[1].lower() in MONTHS:
                dt = _safe_date(int(g[2]), MONTHS[g[1].lower()], int(g[0]))
            elif kind == "iso":
                dt = _safe_date(int(g[0]), int(g[1]), int(g[2]))
            elif kind == "mdy_num":
                dt = _safe_date(int(g[2]), int(g[0]), int(g[1]))
            if dt and not any(pos == m.start() for pos, _ in found):
                found.append((m.start(), dt))
    found.sort(key=lambda t: t[0])
    return found


@dataclass
class BillFields:
    periodStart: str | None = None
    periodEnd: str | None = None
    kwh: float | None = None
    totalAmountPhp: float | None = None
    charges: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def parse_bill_text(text: str) -> BillFields:
    out = BillFields()
    lowered = text.lower()

    # Billing period: prefer dates on/after a "period" keyword.
    anchor = re.search(r"(bill(?:ing)?\s+period|period\s+covered|service\s+period)", lowered)
    dates = find_dates(text)
    if anchor:
        after = [d for pos, d in dates if pos >= anchor.start()]
        candidates = after[:2] if len(after) >= 2 else [d for _, d in dates][:2]
    else:
        candidates = [d for _, d in dates][:2]
    if len(candidates) == 2:
        start, end = sorted(candidates)
        if 0 < (end - start).days <= 45:
            out.periodStart, out.periodEnd = start.isoformat(), end.isoformat()
        else:
            out.warnings.append("Found dates, but they do not look like one billing period.")

    # Total amount due.
    m = re.search(r"total\s+amount\s+due[^\d\n]{0,20}" + _NUM, lowered) or re.search(
        r"amount\s+due[^\d\n]{0,20}" + _NUM, lowered
    ) or re.search(r"total\s+(?:current\s+)?(?:bill|charges)[^\d\n]{0,20}" + _NUM, lowered)
    if m:
        out.totalAmountPhp = _to_float(m.group(1))

    # Consumption in kWh.
    m = (
        re.search(r"(?:total\s+)?(?:kwh\s+(?:used|consumed|consumption)|consumption)[^\d\n]{0,25}" + _NUM + r"\s*kwh?", lowered)
        or re.search(r"(?:total\s+)?(?:kwh\s+(?:used|consumed|consumption)|consumption)[^\d\n]{0,25}" + _NUM, lowered)
        or re.search(_NUM + r"\s*kwh\b", lowered)
    )
    if m:
        out.kwh = _to_float(m.group(1))

    for key, label_rx in CHARGE_LABELS:
        cm = re.search(label_rx + r"[^\d\n]{0,20}" + _NUM, lowered)
        if cm:
            out.charges.append({"key": key, "amountPhp": _to_float(cm.group(1))})

    if out.totalAmountPhp is None:
        out.warnings.append("Could not read the total amount.")
    if out.kwh is None:
        out.warnings.append("Could not read the kWh consumption.")
    if out.periodStart is None:
        out.warnings.append("Could not read the billing period.")
    return out


_WATT_RX = re.compile(r"(\d{1,5}(?:\.\d{1,2})?)\s*(k?w)(?![a-z])", re.IGNORECASE)
_POWER_LINE = re.compile(r"(rated\s+power|input\s+power|power\s+input|power\s+consumption|consumption|power|wattage|input)", re.I)


def parse_label_text(text: str) -> dict:
    """Return wattage candidates from an appliance rating label, best first."""
    preferred: list[float] = []
    others: list[float] = []
    for line in text.splitlines():
        for m in _WATT_RX.finditer(line):
            value = float(m.group(1))
            if m.group(2).lower() == "kw":
                value *= 1000
            if not (0 < value <= 10000):
                continue
            (preferred if _POWER_LINE.search(line) else others).append(round(value, 2))
    seen: list[float] = []
    for v in preferred + others:
        if v not in seen:
            seen.append(v)
    return {
        "suggestedWattage": seen[0] if seen else None,
        "candidates": seen[:5],
        "warnings": [] if seen else ["No wattage value (e.g. 65W) was found on the label."],
    }
