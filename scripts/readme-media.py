"""Turns the frames from scripts/readme-media.test.ts (docs/readme/shots/) into the README's images.

  python -I scripts/readme-media.py

Writes docs/readme/hero.png, needs-you.png, ticket.png (PNG-8, 1280 wide) and
docs/readme/demo.gif (the demo Story from Grill to Shipped) and docs/readme/setup.gif (the setup
wizard, from scripts/readme-setup.test.ts), both 960 wide and captioned.
Needs Pillow.
"""
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "readme", "shots")
OUT = os.path.join(ROOT, "docs", "readme")


def shot(name, prefix=""):
    hits = sorted(glob.glob(os.path.join(SHOTS, f"{prefix}*-{name}.png")))
    if not hits:
        sys.exit(f"no frame named {name} in {SHOTS}")
    return Image.open(hits[-1]).convert("RGB")


def font(size, bold=False):
    for f in [r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def still(name, out, width=1280):
    im = shot(name)
    im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(os.path.join(OUT, out), optimize=True)
    print(out, im.size, os.path.getsize(os.path.join(OUT, out)) // 1024, "KB")


# The story the GIF tells: one caption per beat, in order.
BEATS = [
    ("home-grill", "1. A Story waits at Grill on the board."),
    ("needs-you-grill-ask", "2. The griller Agent asks you two questions in Needs you."),
    ("needs-you-spec-gate", "3. The spec is written. You approve the Gate."),
    ("project-tickets", "4. Tickets are cut. Each one gets its own worktree."),
    ("project-review", "5. Ticket 01 is implemented, tested and reviewed."),
    ("needs-you-review-gate", "6. The review findings wait for your approval."),
    ("project-implementing-02", "7. Kiln merges 01 to main. Ticket 02 unblocks and starts."),
    ("project-shipped", "8. Both Tickets merged, tests green, Story shipped."),
]


# The setup wizard's steps, in order.
SETUP_BEATS = [
    ("login", "1. Login: this PC only, or your tailnet with roles."),
    ("knowledge", "2. Knowledge store: a markdown folder, or your Obsidian vault."),
    ("install", "3. Install: what pays for the work. Budgets come with it."),
    ("agents", "4. Agents: install Claude Code or Pi from the Widget repo."),
    ("models", "5. Models: each one draws from a Budget."),
    ("roles", "6. Workflow roles: a model and a fallback for each role."),
    ("demo", "7. Demo: Replay plays a Story with no models at all."),
    ("board", "8. Finish. The board is up and the demo Story waits at Grill."),
]


def caption(im, text):
    W, H = im.size
    bar_h = 64
    out = Image.new("RGB", (W, H + bar_h), (14, 15, 18))
    out.paste(im, (0, 0))
    d = ImageDraw.Draw(out)
    d.text((22, H + bar_h // 2), text, font=font(26, True), fill=(240, 240, 244), anchor="lm")
    return out


def gif(beats, out, prefix="", width=960):
    frames, durs = [], []
    # The beats mix full Shell frames and clipped boards, so each one is scaled to fit the GIF's
    # width and centred on a canvas as tall as the tallest, on the Shell's background colour.
    scaled = []
    for name, _ in beats:
        im = shot(name, prefix)
        scaled.append(im.resize((width, round(im.height * width / im.width)), Image.LANCZOS))
    height = max(im.height for im in scaled)
    stills = []
    for im, (_, text) in zip(scaled, beats):
        canvas = Image.new("RGB", (width, height), im.getpixel((im.width - 2, 2)))
        canvas.paste(im, (0, (height - im.height) // 2))
        stills.append(caption(canvas, text))
    nfade = 4
    for i, s in enumerate(stills):
        frames.append(s); durs.append(2600)
        nxt = stills[(i + 1) % len(stills)]
        for k in range(1, nfade + 1):
            frames.append(Image.blend(s, nxt, k / (nfade + 1))); durs.append(60)
    sheet = Image.new("RGB", (stills[0].width, stills[0].height * 3))
    for j, idx in enumerate([0, 1, 4]):
        sheet.paste(stills[idx], (0, stills[0].height * j))
    pal = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    path = os.path.join(OUT, out)
    q[0].save(path, save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True, disposal=1)
    print(out, len(q), "frames", round(os.path.getsize(path) / 1e6, 2), "MB")


if __name__ == "__main__":
    still("home-review", "hero.png")
    still("needs-you-review-gate", "needs-you.png")
    still("ticket-thread", "ticket.png")
    gif(BEATS, "demo.gif")
    gif(SETUP_BEATS, "setup.gif", prefix="setup-")
