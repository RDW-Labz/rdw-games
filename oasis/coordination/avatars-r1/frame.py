"""Round-one portrait post-step (decision #193): same framing for every portrait.

Crop to the alpha bounding box, scale the subject to 92 % of the canvas height
(8 % above the head), centre it, feet on the bottom line. Writes the framed
master, a 683x1024 app copy (must be <= 2 MB) and edge stats.

usage: uv run --no-project --with pillow python frame.py <in.png> <out_dir> <id>
"""

import json
import statistics
import sys
from pathlib import Path

from PIL import Image

MAX_APP_BYTES = 2 * 1024 * 1024


def frame(src: Path, out_dir: Path, ident: str) -> dict[str, object]:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    alpha = im.getchannel("A")
    box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    if box is None:
        return {"id": ident, "ok": False, "error": "no subject (empty alpha)"}
    left, top, right, bottom = box
    subject = im.crop(box)
    scale = (0.92 * h) / (bottom - top)
    subject = subject.resize(
        (round((right - left) * scale), round((bottom - top) * scale)), Image.LANCZOS
    )
    if subject.width > w:  # very wide subject: fit width instead, keep feet down
        k = w * 0.84 / subject.width
        subject = subject.resize((round(subject.width * k), round(subject.height * k)), Image.LANCZOS)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.alpha_composite(subject, ((w - subject.width) // 2, h - subject.height))
    out_dir.mkdir(parents=True, exist_ok=True)
    out.save(out_dir / f"{ident}-master.png")
    app = out.resize((683, 1024), Image.LANCZOS)
    app_path = out_dir / f"{ident}-1024.png"
    app.save(app_path, optimize=True)
    a2 = out.getchannel("A")
    l2, t2, r2, b2 = a2.point(lambda v: 255 if v > 8 else 0).getbbox() or (0, 0, 0, 0)
    hist = a2.histogram()
    semi, opaque = sum(hist[9:247]), sum(hist[247:])
    px = out.load()
    edge_lum = [
        0.3 * px[x, y][0] + 0.59 * px[x, y][1] + 0.11 * px[x, y][2]
        for y in range(0, h, 4)
        for x in range(0, w, 4)
        if 20 < px[x, y][3] < 230
    ]
    size = app_path.stat().st_size
    return {
        "id": ident,
        "ok": size <= MAX_APP_BYTES and (100 * (w - r2) / w) >= 0 and (100 * l2 / w) >= 0,
        "src_size": [w, h],
        "margins_pct": {
            "top": round(100 * t2 / h, 1),
            "bottom": round(100 * (h - b2) / h, 1),
            "left": round(100 * l2 / w, 1),
            "right": round(100 * (w - r2) / w, 1),
        },
        "semi_alpha_pct": round(100 * semi / max(1, semi + opaque), 2),
        "edge_mean_lum": round(statistics.mean(edge_lum)) if edge_lum else None,
        "app_bytes": size,
    }


if __name__ == "__main__":
    print(json.dumps(frame(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])))
