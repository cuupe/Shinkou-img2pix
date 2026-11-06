import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, parsePreferences } from './preferences';

describe('persisted application preferences', () => {
  it('recovers from missing, malformed and unsupported storage', () => {
    for (const raw of [null, '{broken', 'null', '[]', '42', '{"theme":"sepia","exportScale":999,"reducedMotion":"false"}']) {
      expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
    }
  });
  it('restores supported preferences without retaining unknown fields', () => {
    expect(parsePreferences(JSON.stringify({ theme: 'dark', accent: 'violet', reducedMotion: true, canvas: 'solid', exportFormat: 'webp', exportScale: 8, source: 'private-image' }))).toEqual({ theme: 'dark', accent: 'violet', reducedMotion: true, canvas: 'solid', exportFormat: 'webp', exportScale: 8 });
  });
});
