import shutil

import pytest

from app import ocr
from tests.conftest import render_text_image

BILL_TEXT = """MERALCO
Account No. 1234567890
JUAN DELA CRUZ
123 Sampaguita St, Quezon City
Billing Period  Jan 15, 2026 to Feb 14, 2026
Total kWh Used  280 kWh
Generation Charge  1,620.40
Transmission Charge  250.10
Distribution Charge  410.75
Total Amount Due  P 3,500.00
"""


def test_parse_bill_text_extracts_only_needed_numbers():
    f = ocr.parse_bill_text(BILL_TEXT)
    assert (f.periodStart, f.periodEnd) == ("2026-01-15", "2026-02-14")
    assert f.kwh == 280
    assert f.totalAmountPhp == 3500.00
    assert {c["key"]: c["amountPhp"] for c in f.charges} == {"generation": 1620.40, "transmission": 250.10, "distribution": 410.75}
    assert f.warnings == []
    dumped = repr(f.__dict__)
    assert "1234567890" not in dumped and "JUAN" not in dumped and "Sampaguita" not in dumped


def test_parse_bill_numeric_dates_and_missing_fields():
    f = ocr.parse_bill_text("BILL PERIOD 03/01/2026 - 03/31/2026\nsomething blurry")
    assert (f.periodStart, f.periodEnd) == ("2026-03-01", "2026-03-31")
    assert f.kwh is None and f.totalAmountPhp is None
    assert any("total amount" in w for w in f.warnings)
    assert any("kWh" in w for w in f.warnings)


def test_parse_bill_rejects_implausible_period():
    f = ocr.parse_bill_text("Billing Period Jan 1, 2025 to Jan 1, 2026")
    assert f.periodStart is None
    assert any("billing period" in w.lower() for w in f.warnings)


def test_parse_bill_zero_consumption_is_kept():
    f = ocr.parse_bill_text("Total kWh Used 0 kWh\nTotal Amount Due P 45.00")
    assert f.kwh == 0 and f.totalAmountPhp == 45.0


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Electric Fan\n220V~ 60Hz\nRated Power: 65W", 65),
        ("Input 220-240V 50/60Hz 1.2kW", 1200),
        ("Model X\n230V 60Hz 45 W", 45),
    ],
)
def test_parse_label(text, expected):
    assert ocr.parse_label_text(text)["suggestedWattage"] == expected


def test_parse_label_ignores_kwh_and_reports_missing():
    r = ocr.parse_label_text("Energy use 150 kWh/year")
    assert r["suggestedWattage"] is None and r["warnings"]


def test_load_image_rejects_garbage_and_oversize():
    with pytest.raises(ocr.ImageRejected):
        ocr.load_image(b"not an image", 1000)
    with pytest.raises(ocr.ImageRejected):
        ocr.load_image(b"", 1000)
    png = render_text_image(["x"])
    with pytest.raises(ocr.ImageRejected):
        ocr.load_image(png, 10)


def test_load_image_rejects_gif():
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buf, format="GIF")
    with pytest.raises(ocr.ImageRejected):
        ocr.load_image(buf.getvalue(), 10**6)


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract binary not installed")
def test_real_tesseract_reads_rendered_bill():
    png = render_text_image(BILL_TEXT.strip().splitlines())
    text = ocr.run_tesseract(ocr.load_image(png, 10**7))
    f = ocr.parse_bill_text(text)
    assert f.kwh == 280
    assert f.totalAmountPhp == 3500.00
    assert f.periodStart == "2026-01-15" and f.periodEnd == "2026-02-14"
