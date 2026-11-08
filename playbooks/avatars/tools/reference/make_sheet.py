"""Resize the six Higgsfield candidates to 512 px and build a labelled contact sheet."""
from PIL import Image, ImageDraw

cells = []
for i in range(1, 7):
    im = Image.open(f"raw/candidate-{i}.png").convert("RGBA")
    im = im.resize((512, 512), Image.LANCZOS)
    im.save(f"candidate-{i}.png")
    cells.append(im)

pad, label = 24, 40
w = 3 * 512 + 4 * pad
h = 2 * (512 + label) + 3 * pad
for name, bg in (("contact-sheet.png", (244, 241, 234, 255)), ("contact-sheet-dark.png", (28, 30, 36, 255))):
    sheet = Image.new("RGBA", (w, h), bg)
    d = ImageDraw.Draw(sheet)
    fg = (40, 40, 40) if bg[0] > 128 else (230, 230, 230)
    for n, im in enumerate(cells):
        x = pad + (n % 3) * (512 + pad)
        y = pad + (n // 3) * (512 + label + pad)
        d.text((x, y + 8), f"{n + 1}", fill=fg, font_size=28)
        sheet.alpha_composite(im, (x, y + label))
    sheet.convert("RGB").save(name)
