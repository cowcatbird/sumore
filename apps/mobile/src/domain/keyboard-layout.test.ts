import { describe, expect, it } from 'vitest';

import { getInputRevealOffset, getKeyboardToolbarBottom } from './keyboard-layout';

const smallPhone = {
  inputTop: 470,
  inputHeight: 52,
  viewportTop: 0,
  viewportHeight: 320,
  keyboardTop: 364,
  scrollY: 0,
  gap: 16,
};

describe('keyboard-visible form geometry', () => {
  it('scrolls a covered field into a short iPhone viewport with room above the keyboard toolbar', () => {
    const offset = getInputRevealOffset(smallPhone);
    expect(offset).toBe(218);
    expect(smallPhone.inputTop - offset + smallPhone.inputHeight).toBe(304);
  });

  it('uses the actual keyboard edge when it overlaps a viewport before resize finishes', () => {
    expect(getInputRevealOffset({ ...smallPhone, viewportHeight: 700, keyboardTop: 300 })).toBe(238);
  });

  it('handles the resized Android viewport without subtracting keyboard height twice', () => {
    expect(getInputRevealOffset({ ...smallPhone, viewportHeight: 364, keyboardTop: 364 })).toBe(174);
  });

  it('leaves an already visible input alone after a second layout callback', () => {
    expect(getInputRevealOffset({ ...smallPhone, inputTop: 252, scrollY: 218 })).toBe(218);
  });

  it('scrolls back up when the focused input is above the viewport', () => {
    expect(getInputRevealOffset({ ...smallPhone, inputTop: 5, viewportTop: 44, scrollY: 218 })).toBe(163);
  });

  it('clamps overscroll and aligns the top when an unusually large field cannot entirely fit', () => {
    expect(getInputRevealOffset({ ...smallPhone, inputTop: 2, scrollY: 0 })).toBe(0);
    expect(getInputRevealOffset({ ...smallPhone, inputTop: 200, inputHeight: 150, viewportHeight: 120 })).toBe(184);
  });

  it('does not move the full-height screen after the keyboard is dismissed', () => {
    expect(getInputRevealOffset({ ...smallPhone, viewportHeight: 800, keyboardTop: Infinity })).toBe(0);
  });

  it('ignores a transient zero-height viewport while native layout is changing', () => {
    expect(getInputRevealOffset({ ...smallPhone, viewportHeight: 0, scrollY: 218 })).toBe(218);
  });

  it('reveals a field in a pageSheet using its window origin and the dismiss toolbar', () => {
    const sheet = { inputTop: 610, inputHeight: 54, viewportTop: 130, viewportHeight: 600, keyboardTop: 500, scrollY: 0, gap: 16, bottomObstruction: 44 };
    const offset = getInputRevealOffset(sheet);
    expect(offset).toBe(224);
    expect(sheet.inputTop - offset + sheet.inputHeight + sheet.gap).toBe(sheet.keyboardTop - 44);
    expect(getKeyboardToolbarBottom(130, 600, 500)).toBe(230);
  });

  it('readjusts after switching to a taller emoji keyboard without a second show event', () => {
    expect(getInputRevealOffset({ inputTop: 386, inputHeight: 54, viewportTop: 130, viewportHeight: 600, keyboardTop: 450, scrollY: 224, gap: 16, bottomObstruction: 44 })).toBe(274);
  });

  it('positions the dismiss toolbar at the resized Android edge without double keyboard padding', () => {
    expect(getKeyboardToolbarBottom(24, 476, 500)).toBe(0);
    expect(getInputRevealOffset({ ...smallPhone, viewportTop: 24, viewportHeight: 476, keyboardTop: 500, bottomObstruction: 44 })).toBe(82);
  });
});
