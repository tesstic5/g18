// apps/web/src/lib/sound.ts — Howler sound manager (docs/19 §11 canonical).
// Gracefully no-ops when a file is missing (assets land in /public/sounds — see manifest).
'use client';
import { Howl, Howler } from 'howler';
import { safeStorage } from './safe-storage';

const SOUNDS = {
  click: { src: '/sounds/click.mp3', volume: 0.5 },
  bet_place: { src: '/sounds/bet_place.mp3', volume: 0.7 },
  cashout: { src: '/sounds/cashout.mp3', volume: 0.8 },
  win: { src: '/sounds/win.mp3', volume: 0.8 },
  win_big: { src: '/sounds/win_big.mp3', volume: 1.0 },
  lose: { src: '/sounds/lose.mp3', volume: 0.4 },
  crash_engine: { src: '/sounds/crash_engine.mp3', volume: 0.5, loop: true },
  crash_boom: { src: '/sounds/crash_boom.mp3', volume: 0.9 },
  plinko_peg: { src: '/sounds/plinko_peg.mp3', volume: 0.3 },
  plinko_land: { src: '/sounds/plinko_land.mp3', volume: 0.5 },
  wheel_spin: { src: '/sounds/wheel_spin.mp3', volume: 0.6, loop: true },
  wheel_stop: { src: '/sounds/wheel_stop.mp3', volume: 0.7 },
  wheel_tick: { src: '/sounds/wheel_tick.mp3', volume: 0.2 },
  mine_safe: { src: '/sounds/mine_safe.mp3', volume: 0.5 },
  mine_explode: { src: '/sounds/mine_explode.mp3', volume: 0.8 },
  coin_flip: { src: '/sounds/coin_flip.mp3', volume: 0.6 },
  card_deal: { src: '/sounds/card_deal.mp3', volume: 0.5 },
  card_flip: { src: '/sounds/card_flip.mp3', volume: 0.4 },
  tower_step: { src: '/sounds/tower_step.mp3', volume: 0.5 },
  tower_fall: { src: '/sounds/tower_fall.mp3', volume: 0.7 },
  notification: { src: '/sounds/notification.mp3', volume: 0.5 },
  deposit_ok: { src: '/sounds/deposit_ok.mp3', volume: 0.7 },
} as const;

type SoundKey = keyof typeof SOUNDS;

class SoundManager {
  private sounds = new Map<string, Howl>();
  private enabled = true;
  private volume = 1;

  constructor() {
    if (typeof window === 'undefined') return;
    this.enabled = safeStorage.get('sound_enabled') !== 'false';
    this.volume = parseFloat(safeStorage.get('sound_volume') || '1');
    Howler.volume(this.volume);
  }

  private get(key: SoundKey): Howl | null {
    const config = SOUNDS[key];
    let howl = this.sounds.get(key);
    if (!howl) {
      try {
        howl = new Howl({
          src: [config.src],
          volume: config.volume,
          loop: 'loop' in config && !!config.loop,
          onloaderror: () => {
            /* missing file — silent */
          },
        });
        this.sounds.set(key, howl);
      } catch {
        return null;
      }
    }
    return howl;
  }

  play(key: SoundKey): number | null {
    if (!this.enabled || typeof window === 'undefined') return null;
    return this.get(key)?.play() ?? null;
  }
  stop(key: SoundKey, id?: number) {
    const h = this.get(key);
    if (!h) return;
    if (id !== undefined) h.stop(id);
    else h.stop();
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    safeStorage.set('sound_enabled', String(enabled));
    Howler.mute(!enabled);
  }
  toggle() {
    this.setEnabled(!this.enabled);
  }
}

export const sound = new SoundManager();
export type { SoundKey };
