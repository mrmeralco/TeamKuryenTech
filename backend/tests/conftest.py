import io
import json
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

SPEC = json.loads((Path(__file__).resolve().parents[2] / "spec" / "calc-cases.json").read_text())


def render_text_image(lines: list[str], fmt: str = "PNG") -> bytes:
    font = None
    for candidate in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            font = ImageFont.truetype(candidate, 34)
            break
        except OSError:
            continue
    font = font or ImageFont.load_default()
    img = Image.new("RGB", (1500, 80 + 60 * len(lines)), "white")
    d = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        d.text((40, 40 + 60 * i), line, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


@pytest.fixture
def spec():
    return SPEC
