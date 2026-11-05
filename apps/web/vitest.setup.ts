import { vi } from 'vitest';

// jsdom intentionally does not implement media playback. Game sound effects are
// not the subject of component state tests; mock them so Howler cannot produce
// unhandled test errors after otherwise-passing assertions.
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  value: vi.fn().mockResolvedValue(undefined),
});
Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  value: vi.fn(),
});
