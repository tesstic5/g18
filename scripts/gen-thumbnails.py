#!/usr/bin/env python3
"""Upgraded cinematic thumbnail generator — rich layered SVG art per docs/21 art direction,
rendered to WebP 1200x675 by ImageMagick. Run: python3 scripts/gen-thumbnails.py
"""
import math, os

OUT = "apps/web/public/games"

def rad(d): return math.radians(d)
def cos(d): return math.cos(rad(d))
def sin(d): return math.sin(rad(d))

# ── helpers ────────────────────────────────────────────────────────────────
def stars(x0, y0, x1, y1, n, seed=1):
    import random
    rnd = random.Random(seed)
    s = ""
    for _ in range(n):
        x = x0 + rnd.random() * (x1 - x0)
        y = y0 + rnd.random() * (y1 - y0)
        r = 0.6 + rnd.random() * 1.6
        op = 0.25 + rnd.random() * 0.7
        col = "#ffffff" if rnd.random() > 0.15 else "#f5c842"
        s += f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="{col}" opacity="{op:.2f}"/>\n'
    return s

def glow(x, y, r, color, op=0.5):
    return (f'<radialGradient id="g{x:.0f}{y:.0f}" cx="50%" cy="50%" r="50%">'
            f'<stop offset="0%" stop-color="{color}" stop-opacity="{op}"/>'
            f'<stop offset="100%" stop-color="{color}" stop-opacity="0"/>'
            f'</radialGradient>'
            f'<circle cx="{x}" cy="{y}" r="{r}" fill="url(#g{x:.0f}{y:.0f})"/>')

def scene(slug):
    """Return (defs, body) drawn in a 1200x675 space, subject centered ~ (600,300)."""
    x, y = 600, 290
    defs, body = "", ""
    if slug == "aviator":
        body += glow(400, 260, 260, "#00d97e", 0.25)
        # rising curve
        pts = " ".join(f"{600+ (i-40)*8},{470 - 30*math.log1p(i)}" for i in range(1, 45))
        body += f'<polyline points="{pts}" fill="none" stroke="#00d97e" stroke-width="6" stroke-linecap="round"/>'
        body += f'<polyline points="{pts}" fill="none" stroke="#00d97e" stroke-width="14" opacity="0.25" stroke-linecap="round"/>'
        # jet
        body += (f'<g transform="translate(620,300) rotate(-18)">'
                 f'<polygon points="90,0 -70,-26 -30,0 -70,26" fill="#1c1c3a" stroke="#f5c842" stroke-width="3"/>'
                 f'<polygon points="30,-8 -60,-22 -30,-8" fill="#3a3a6a"/>'
                 f'<circle cx="40" cy="0" r="7" fill="#cfe8ff"/>'
                 f'<ellipse cx="-70" cy="0" rx="18" ry="10" fill="#ff8c00" opacity="0.9"/>'
                 f'</g>')
        body += glow(560, 300, 60, "#ff8c00", 0.6)
    elif slug == "plinko":
        body += glow(600, 160, 220, "#9b59ff", 0.3)
        # pegs triangle
        for r in range(9):
            for c in range(r + 1):
                px = 600 - r * 26 + c * 52
                py = 120 + r * 46
                body += f'<circle cx="{px}" cy="{py}" r="7" fill="#ffffff" opacity="0.75"/>'
                body += f'<circle cx="{px}" cy="{py}" r="12" fill="#ffffff" opacity="0.12"/>'
        # ball mid-air
        body += f'<circle cx="600" cy="360" r="20" fill="#f5c842"/>'
        body += f'<circle cx="594" cy="353" r="6" fill="#ffffff" opacity="0.8"/>'
        body += glow(600, 360, 60, "#f5c842", 0.7)
        # buckets
        for i, m in enumerate([10, 3, 1.5, 1, 0.5, 1, 1.5, 3, 10, 20]):
            bx = 280 + i * 71
            col = "#f5c842" if m >= 10 else "#00d97e" if m >= 3 else "#4d9fff" if m >= 1 else "#374151"
            body += f'<rect x="{bx-28}" y="500" width="52" height="80" rx="6" fill="{col}" opacity="0.3"/>'
            body += f'<rect x="{bx-28}" y="500" width="52" height="4" fill="{col}"/>'
    elif slug == "wingo":
        body += glow(600, 300, 240, "#9b59ff", 0.3)
        for i, col in enumerate(["#ff3b5c", "#00d97e", "#9b59ff"]):
            body += f'<circle cx="{430+i*170}" cy="300" r="78" fill="{col}" opacity="0.85"/>'
            body += f'<circle cx="{430+i*170}" cy="300" r="96" fill="none" stroke="{col}" stroke-width="4" opacity="0.4"/>'
        # timer ring
        body += f'<circle cx="600" cy="560" r="52" fill="none" stroke="#f5c842" stroke-width="7" stroke-dasharray="300 27"/>'
    elif slug == "mines":
        body += glow(600, 300, 240, "#00f090", 0.2)
        for r in range(5):
            for c in range(5):
                bx, by = 440 + c * 64, 180 + r * 64
                mine = (r * 5 + c) in (2, 7, 12, 19, 23)
                body += f'<rect x="{bx}" y="{by}" width="50" height="50" rx="8" fill="#161622" stroke="{ "#ff3b5c" if mine else "#2a2a44" }" stroke-width="2"/>'
                if (r * 5 + c) == 13:
                    body += f'<polygon points="{bx+25},{by+6} {bx+42},{by+20} {bx+36},{by+40} {bx+14},{by+40} {bx+8},{by+20}" fill="#00f090"/>'
                elif mine:
                    body += f'<circle cx="{bx+25}" cy="{by+25}" r="9" fill="#ff3b5c"/>'
    elif slug == "dice":
        body += glow(480, 260, 200, "#f5c842", 0.25)
        body += glow(720, 340, 200, "#4d9fff", 0.25)
        for cx, cy, dots, angle in [(460, 250, [(0, 0)], -14), (740, 330, [(-16, -16), (16, 16), (0, 0)], 12)]:
            body += f'<g transform="translate({cx},{cy}) rotate({angle})">'
            body += f'<rect x="-54" y="-54" width="108" height="108" rx="18" fill="#ffffff" opacity="0.94"/>'
            for dx, dy in dots:
                body += f'<circle cx="{dx}" cy="{dy}" r="12" fill="#1a1a2e"/>'
            body += f'</g>'
    elif slug == "wheel":
        body += glow(600, 300, 260, "#f5c842", 0.3)
        cols = ["#2a2a2a", "#1a3050", "#0d2a1a", "#1a2a1a", "#2a2000", "#2a1400", "#1a0a2a"]
        for i in range(12):
            a0, a1 = i * 30, (i + 1) * 30
            col = cols[i % 7]
            body += (f'<path d="M 600 300 L {600+260*cos(a0)} {300+260*sin(a0)} '
                     f'A 260 260 0 0 1 {600+260*cos(a1)} {300+260*sin(a1)} Z" fill="{col}" stroke="#f5c842" stroke-width="2" stroke-opacity="0.6"/>')
            body += (f'<text x="{600+180*cos((a0+a1)/2)}" y="{300+180*sin((a0+a1)/2)+14}" '
                     f'font-family="DejaVu-Sans" font-size="30" font-weight="bold" fill="#f5c842" text-anchor="middle">'
                     f'{["0","1.5","2","3","5","10","25","0","2","5","10","25"][i]}</text>')
        body += f'<circle cx="600" cy="300" r="46" fill="#1a1a2e" stroke="#f5c842" stroke-width="6"/>'
        body += f'<polygon points="600,40 580,90 620,90" fill="#f5c842"/>'
    elif slug == "coin-flip":
        body += glow(600, 300, 240, "#f5c842", 0.4)
        body += f'<circle cx="600" cy="300" r="150" fill="#f5c842"/>'
        body += f'<circle cx="600" cy="300" r="150" fill="none" stroke="#b8860b" stroke-width="14"/>'
        body += f'<circle cx="600" cy="300" r="104" fill="none" stroke="#b8860b" stroke-width="8"/>'
        body += f'<circle cx="600" cy="300" r="86" fill="#ffe066" opacity="0.4"/>'
        body += f'<text x="600" y="345" font-family="DejaVu-Sans" font-size="120" font-weight="bold" fill="#b8860b" text-anchor="middle">₨</text>'
    elif slug == "tower":
        body += glow(600, 200, 200, "#ff7c2a", 0.25)
        for f in range(9):
            bx = 600 - (9 - f) * 26
            body += f'<rect x="{bx-110}" y="{420-f*42}" width="220" height="30" rx="6" fill="#1c1c30" stroke="#ff7c2a" stroke-opacity="0.5"/>'
        body += f'<circle cx="600" cy="{420-8*42-30}" r="16" fill="#ff7c2a"/>'
        body += glow(600, 100, 80, "#ff7c2a", 0.7)
    elif slug == "hi-lo":
        body += glow(600, 300, 260, "#00d97e", 0.2)
        body += f'<rect x="0" y="0" width="1200" height="675" fill="#0d1f0d" opacity="0.6"/>'
        for i, (sx, sy) in enumerate([(380, 280), (470, 270), (560, 265)]):
            body += f'<rect x="{sx}" y="{sy}" width="150" height="210" rx="14" fill="#ffffff" opacity="{0.9-i*0.15}"/>'
            body += f'<text x="{sx+75}" y="{sy+120}" font-family="DejaVu-Sans" font-size="70" font-weight="bold" fill="#1a1a1a" text-anchor="middle">7</text>'
        body += f'<rect x="760" y="240" width="170" height="240" rx="14" fill="#ffffff"/>'
        body += f'<text x="845" y="330" font-family="DejaVu-Sans" font-size="80" font-weight="bold" fill="#e53e3e" text-anchor="middle">A</text>'
        body += f'<text x="845" y="420" font-family="DejaVu-Sans" font-size="70" fill="#e53e3e" text-anchor="middle">♥</text>'
    elif slug == "limbo":
        body += glow(600, 300, 260, "#4d9fff", 0.35)
        body += f'<text x="600" y="300" font-family="DejaVu-Sans" font-size="190" font-weight="bold" fill="#4d9fff" text-anchor="middle">2.4×</text>'
        body += f'<text x="600" y="410" font-family="DejaVu-Sans" font-size="64" font-weight="bold" fill="#ffffff" text-anchor="middle" opacity="0.9">LIMBO</text>'
    elif slug == "keno":
        body += glow(600, 300, 260, "#00d97e", 0.2)
        for r in range(5):
            for c in range(8):
                bx, by = 360 + c * 62, 190 + r * 58
                hit = (r * 8 + c) in (3, 9, 15, 21, 26, 32, 38)
                body += f'<circle cx="{bx}" cy="{by}" r="24" fill="{ "#00d97e" if hit else "#1a1a2e" }" stroke="#2a2a44" stroke-width="2"/>'
    elif slug == "dragon-tiger":
        body += glow(380, 300, 200, "#ff3b5c", 0.3)
        body += glow(820, 300, 200, "#ff7c2a", 0.3)
        body += f'<text x="360" y="330" font-family="DejaVu-Sans" font-size="170" fill="#ff3b5c" text-anchor="middle">龍</text>'
        body += f'<text x="840" y="330" font-family="DejaVu-Sans" font-size="170" fill="#ff7c2a" text-anchor="middle">虎</text>'
        body += f'<circle cx="600" cy="160" r="14" fill="#f5c842"/>'
        body += f'<path d="M 540 170 L 660 170" stroke="#f5c842" stroke-width="4" stroke-dasharray="8 8"/>'
    elif slug == "roulette":
        body += glow(600, 300, 260, "#ff3b5c", 0.3)
        for i in range(26):
            a0, a1 = i * 360 / 26, (i + 1) * 360 / 26
            col = "#e53e3e" if i % 2 == 0 else "#1a1a1a"
            body += (f'<path d="M 600 300 L {600+270*cos(a0)} {300+270*sin(a0)} '
                     f'A 270 270 0 0 1 {600+270*cos(a1)} {300+270*sin(a1)} Z" fill="{col}" stroke="#ffffff" stroke-width="1.5" stroke-opacity="0.5"/>')
        body += f'<circle cx="600" cy="300" r="60" fill="#00a860"/>'
        body += f'<polygon points="600,30 578,80 622,80" fill="#f5c842"/>'
    elif slug == "baccarat":
        body += glow(520, 300, 200, "#f5c842", 0.25)
        body += glow(700, 300, 200, "#f5c842", 0.25)
        for sx, suit in [(470, "♠"), (640, "♥"), (790, "♦")]:
            body += f'<rect x="{sx}" y="170" width="150" height="230" rx="14" fill="#ffffff"/>'
            body += f'<text x="{sx+75}" y="{y+150}" font-family="DejaVu-Sans" font-size="110" fill="{ "#e53e3e" if suit in "♥♦" else "#1a1a1a" }" text-anchor="middle">{suit}</text>'
        # chips
        for cx in [390, 820]:
            body += f'<ellipse cx="{cx}" cy="500" rx="60" ry="18" fill="#f5c842"/>'
            body += f'<ellipse cx="{cx}" cy="494" rx="60" ry="18" fill="#ffe066" stroke="#b8860b" stroke-width="4"/>'
    elif slug == "thimbles":
        body += glow(600, 300, 240, "#c9a227", 0.25)
        for i, dx in enumerate([-170, 0, 170]):
            body += (f'<path d="M {600+dx-58} 480 Q {600+dx-64} 260 {600+dx} 240 '
                     f'Q {600+dx+64} 260 {600+dx+58} 480 Z" fill="#b8b8cc" stroke="#8a8a9a" stroke-width="5"/>')
            body += f'<ellipse cx="{600+dx}" cy="240" rx="58" ry="14" fill="#d8d8e8"/>'
        body += f'<circle cx="600" cy="520" r="26" fill="#f5c842"/>'
        body += glow(600, 520, 60, "#f5c842", 0.6)
    elif slug == "ring-of-fortune":
        body += glow(600, 300, 240, "#9b59ff", 0.35)
        body += f'<circle cx="600" cy="300" r="210" fill="none" stroke="#9b59ff" stroke-width="64"/>'
        body += f'<circle cx="600" cy="300" r="210" fill="none" stroke="#f5c842" stroke-width="64" stroke-dasharray="180 480" stroke-dashoffset="40"/>'
        body += f'<circle cx="600" cy="300" r="70" fill="#1a1a2e" stroke="#f5c842" stroke-width="6"/>'
        body += f'<text x="600" y="325" font-family="DejaVu-Sans" font-size="52" font-weight="bold" fill="#f5c842" text-anchor="middle">25×</text>'
    elif slug == "crash-x":
        body += glow(600, 300, 260, "#9b59ff", 0.35)
        body += f'<ellipse cx="600" cy="320" rx="150" ry="34" fill="#9b59ff" opacity="0.9"/>'
        body += f'<path d="M 520 320 Q 550 210 600 195 Q 650 210 680 320 Z" fill="#c9c9ff"/>'
        body += f'<circle cx="600" cy="320" r="26" fill="#1a0a2e" stroke="#f5c842" stroke-width="4"/>'
        body += f'<circle cx="470" cy="330" r="10" fill="#4d9fff"/>'
        body += f'<circle cx="740" cy="300" r="12" fill="#ff3b5c"/>'
        body += glow(600, 195, 50, "#cfe8ff", 0.8)
    elif slug == "stairs":
        body += glow(600, 300, 240, "#4d9fff", 0.25)
        for i in range(8):
            body += f'<rect x="{260+i*78}" y="{480-i*52}" width="92" height="34" rx="6" fill="#1c1c30" stroke="#4d9fff" stroke-opacity="0.6"/>'
        body += f'<circle cx="{260+7*78+46}" cy="{480-7*52-30}" r="16" fill="#4d9fff"/>'
        body += glow(860, 120, 80, "#4d9fff", 0.7)
    elif slug == "scratch-card":
        body += glow(600, 300, 240, "#ff7c2a", 0.25)
        body += f'<rect x="430" y="130" width="340" height="420" rx="20" fill="#f5c842"/>'
        body += f'<rect x="470" y="170" width="260" height="340" rx="14" fill="#8a8a9a"/>'
        body += f'<text x="600" y="360" font-family="DejaVu-Sans" font-size="60" font-weight="bold" fill="#6a6a7a" text-anchor="middle">SCRATCH</text>'
        body += f'<rect x="500" y="240" width="110" height="70" rx="10" fill="#f5c842" opacity="0.85"/>'
    elif slug == "lucky-number":
        body += glow(600, 300, 260, "#ff7c2a", 0.3)
        body += f'<circle cx="600" cy="300" r="230" fill="none" stroke="#ff7c2a" stroke-width="10" stroke-dasharray="46 26" stroke-linecap="round"/>'
        body += f'<circle cx="600" cy="300" r="170" fill="none" stroke="#f5c842" stroke-width="4" stroke-dasharray="14 20" opacity="0.6"/>'
        body += f'<line x1="600" y1="300" x2="600" y2="120" stroke="#f5c842" stroke-width="12" stroke-linecap="round" transform="rotate(28 600 300)"/>'
        body += f'<circle cx="600" cy="300" r="74" fill="#1a1a2e" stroke="#ff7c2a" stroke-width="6"/>'
        body += f'<text x="600" y="330" font-family="DejaVu-Sans" font-size="72" font-weight="bold" fill="#ff7c2a" text-anchor="middle">42</text>'
    return defs, body

TITLES = {
    "aviator": "AVIATOR", "plinko": "PLINKO", "wingo": "WIN GO", "mines": "MINES",
    "dice": "DICE", "wheel": "WHEEL OF FORTUNE", "coin-flip": "COIN FLIP", "tower": "TOWER",
    "hi-lo": "HI-LO", "limbo": "LIMBO", "keno": "KENO", "dragon-tiger": "DRAGON TIGER",
    "roulette": "ROULETTE", "baccarat": "BACCARAT", "thimbles": "THIMBLES",
    "ring-of-fortune": "RING OF FORTUNE", "crash-x": "CRASH X", "stairs": "STAIRS",
    "scratch-card": "SCRATCH CARD", "lucky-number": "LUCKY NUMBER",
}
# per-game background gradients (top color, bottom color)
BGS = {
    "aviator": ("#140a2e", "#04040a"), "plinko": ("#180a2a", "#04040a"),
    "wingo": ("#081a2e", "#04040a"), "mines": ("#081f12", "#04040a"),
    "dice": ("#0a0e2e", "#04040a"), "wheel": ("#2a1a08", "#04040a"),
    "coin-flip": ("#2a2008", "#04040a"), "tower": ("#1a1626", "#04040a"),
    "hi-lo": ("#0a1a0a", "#04040a"), "limbo": ("#081a2e", "#04040a"),
    "keno": ("#062626", "#04040a"), "dragon-tiger": ("#2e0a08", "#04040a"),
    "roulette": ("#2e080a", "#04040a"), "baccarat": ("#18260a", "#04040a"),
    "thimbles": ("#1a0f06", "#04040a"), "ring-of-fortune": ("#1a082e", "#04040a"),
    "crash-x": ("#0a0a2e", "#04040a"), "stairs": ("#0c0a2e", "#04040a"),
    "scratch-card": ("#2e1a08", "#04040a"), "lucky-number": ("#2e0818", "#04040a"),
}

for slug, title in TITLES.items():
    c1, c2 = BGS[slug]
    _, body = scene(slug)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
<defs>
  <radialGradient id="bg" cx="50%" cy="30%" r="95%">
    <stop offset="0%" stop-color="{c1}"/>
    <stop offset="70%" stop-color="{c2}"/>
    <stop offset="100%" stop-color="#02020a"/>
  </radialGradient>
  <linearGradient id="veil" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
    <stop offset="55%" stop-color="#000000" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0.9"/>
  </linearGradient>
  <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#f5c842" stop-opacity="0.16"/>
    <stop offset="100%" stop-color="#f5c842" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#ffe98a"/>
    <stop offset="45%" stop-color="#f5c842"/>
    <stop offset="100%" stop-color="#c9962e"/>
  </linearGradient>
  <radialGradient id="vig" cx="50%" cy="42%" r="72%">
    <stop offset="55%" stop-color="#000000" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0.55"/>
  </radialGradient>
</defs>
<rect width="1200" height="675" fill="url(#bg)"/>
<rect width="1200" height="420" fill="url(#beam)"/>
{stars(0, 0, 1200, 420, 130, seed=hash(slug) % 9999)}
{body}
<rect width="1200" height="675" fill="url(#vig)"/>
<rect y="400" width="1200" height="275" fill="url(#veil)"/>
<text x="600" y="558" font-family="DejaVu-Sans" font-size="92" font-weight="bold" fill="url(#gold)" text-anchor="middle" letter-spacing="6" stroke="#000000" stroke-opacity="0.45" stroke-width="3">{title}</text>
<rect x="330" y="600" width="540" height="4" rx="2" fill="url(#gold)" opacity="0.55"/>
<text x="600" y="636" font-family="DejaVu-Sans" font-size="30" fill="#f5c842" text-anchor="middle" letter-spacing="10" opacity="0.9">2 WIN 2 PLAY</text>
<rect x="10" y="10" width="1180" height="655" fill="none" stroke="#f5c842" stroke-opacity="0.25" stroke-width="3" rx="18"/>
</svg>
'''
    d = os.path.join(OUT, slug)
    os.makedirs(d, exist_ok=True)
    import re as _re
    svg = _re.sub(r'<polyline points=\"([^\"]+)\"', lambda m: '<path d="M ' + m.group(1).strip().replace(' ', ' L ') + '"', svg)
    svg = svg.replace('/>', '/>')  # noop
    with open(os.path.join(d, "thumbnail.svg"), "w") as f:
        f.write(svg)
    import subprocess
    # D-087: ImageMagick's internal SVG renderer fails on url(#gradient) fills
    # (every thumbnail came out identical/near-black). Render with librsvg
    # (rsvg-convert — same engine that renders the logo correctly), then
    # ImageMagick only re-encodes PNG → WebP.
    subprocess.run(["rsvg-convert", "-w", "1200", "-h", "675", "-o", os.path.join(d, "thumbnail-big.png"),
                    os.path.join(d, "thumbnail.svg")], check=True)
    subprocess.run(["rsvg-convert", "-w", "240", "-h", "135", "-o", os.path.join(d, "thumbnail-small.png"),
                    os.path.join(d, "thumbnail.svg")], check=True)
    subprocess.run(["convert", os.path.join(d, "thumbnail-big.png"),
                    "-quality", "90", os.path.join(d, "thumbnail.webp")], check=True)
    os.remove(os.path.join(d, "thumbnail-big.png"))
    print("wrote", slug)
print("done —", len(TITLES))
