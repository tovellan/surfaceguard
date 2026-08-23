import { describe, expect, it } from 'vitest';

import { matchesGlob } from '../src/glob.js';

describe('glob matching', () => {
  it.each([
    ['/staff/console', '/staff/**', true],
    ['/staff', '/staff/**', false],
    ['.env', '**/.env*', true],
    ['nested/.env.production', '**/.env*', true],
    ['static/app.js', 'static/*.js', true],
    ['static/nested/app.js', 'static/*.js', false],
    ['/item/a', '/item/?', true],
    ['/item/4', '/item/[0-9]', true],
  ])('%s against %s is %s', (value, glob, expected) => {
    expect(matchesGlob(value, glob)).toBe(expected);
  });
});
