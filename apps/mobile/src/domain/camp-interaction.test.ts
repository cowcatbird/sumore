import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('camp-based customization', () => {
  it('opens customization from the own camper and retains a discoverable button', () => {
    const camp = read('../app/index.tsx');
    expect(camp).toContain("onPressYourCamper={() => router.push('/customize')}");
    expect(camp).toContain('accessibilityLabel="Customize your camper"');
    expect(read('../components/campfire.tsx')).toContain('onPressYourCamper={onPressYourCamper}');
    const scene = read('../components/campsite-scene.tsx');
    expect(scene).toContain('onPressYourCamper && seats.slice(0, 6).map((seat, i) => seat.isYou ?');
    expect(scene).toContain('camperRect(width, positions[i])');
    expect(scene).toContain('accessibilityLabel="Edit your camper at the campfire"');
    expect(scene).toContain('accessible={!onPressYourCamper}');
  });

  it('has an obvious return path now that customization is not a main tab', () => {
    const customize = read('../app/customize.tsx');
    expect(customize).toContain('accessibilityLabel="Back to Camp"');
    expect(customize).toContain("router.replace('/')");
  });

  it('reserves the same space for the saving spinner, saved dot and retry control', () => {
    const customize = read('../app/customize.tsx');
    expect(customize).toContain('saveNotice: { minHeight: 44');
    expect(customize).toContain('statusIcon: { width: 20, height: 20');
    expect(customize).toContain('<View style={styles.statusIcon}>');
    expect(customize).toContain('retry: { minHeight: 44');
  });
});
