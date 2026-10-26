import { describe, expect, it } from 'vitest';

import { isValidDisplayName, MAX_DISPLAY_NAME_LENGTH, normalizeDisplayName } from './profile';

describe('name-only profiles', () => {
  it('trims boundary whitespace without rewriting spelling, punctuation, or interior spaces', () => {
    expect(normalizeDisplayName(' \t Zoë  O’Connor-Jones! \n')).toBe('Zoë  O’Connor-Jones!');
    expect(normalizeDisplayName('\u00A0\u3000小明 🌙\uFEFF')).toBe('小明 🌙');
  });

  it.each(['Alex', 'Alex', '李 小明', 'María-José', 'O’Connor', 'Sam & Jo', '🌙', 'A'])('accepts a non-unique name: %s', name => {
    expect(isValidDisplayName(name)).toBe(true);
  });

  it.each(['', '  ', '\n\t\r', '\u00A0\u3000\uFEFF'])('rejects a blank name', name => {
    expect(isValidDisplayName(name)).toBe(false);
  });

  it('matches the database limit by counting code points instead of UTF-16 units', () => {
    expect(MAX_DISPLAY_NAME_LENGTH).toBe(60);
    expect(isValidDisplayName('A'.repeat(60))).toBe(true);
    expect(isValidDisplayName('A'.repeat(61))).toBe(false);
    expect(isValidDisplayName(`  ${'🌙'.repeat(60)}  `)).toBe(true);
    expect(isValidDisplayName('🌙'.repeat(61))).toBe(false);
    // A combining mark is a separate code point in both JS and PostgreSQL.
    expect(isValidDisplayName('e\u0301'.repeat(30))).toBe(true);
    expect(isValidDisplayName('e\u0301'.repeat(31))).toBe(false);
  });
});
