# Public assets — production requirements (docs/21 ASSET PRODUCTION REQUIREMENTS)

## Thumbnails — `/public/games/{slug}/thumbnail.webp`

20 files, WebP 1200×675 (2× of displayed 600×338), dark cinematic art per the docs/21 per-game
brief. Generated placeholder `.png` files exist in this folder (convertible via ImageMagick:
`magick thumbnail.png -quality 82 thumbnail.webp`). Art direction per game is in `docs/21 §ASSET`.

## Icons — `/public/games/{slug}/icon.svg`

40×40 SVG icons for category pills/shortcuts (plane, gem, mine, cup, ball, card-back, coin…).

## Sounds — `/public/sounds/*.mp3`

128kbps MP3s, named per `apps/web/src/lib/sound.ts` (the SoundManager silently no-ops on
missing files — the game never breaks). Critical files that must exist before launch:

```
bet_place.mp3  win.mp3  lose.mp3  crash_engine.mp3 (loops)  crash_boom.mp3
```

Full list: click, bet_place, cashout, win, win_big, lose, crash_engine, crash_boom,
plinko_peg, plinko_land, wheel_spin, wheel_stop, wheel_tick, mine_safe, mine_explode,
coin_flip, card_deal, card_flip, tower_step, tower_fall, notification, deposit_ok.

## Fonts

Loaded via `next/font` (preloaded, no FOUT) — Plus Jakarta Sans (display), Inter (UI/numeric),
JetBrains Mono (mono).

## Manifest (PWA)

`/manifest.json` + `/sw.js` per docs/19 §12 — icons under `/icons/`.
