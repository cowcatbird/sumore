import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { appTourSlides } from '@/domain/app-tour-content';

describe('release-facing app copy', () => {
  it('keeps version and update information without a beta label', () => {
    const notice = readFileSync(new URL('./app-update-notice.tsx', import.meta.url), 'utf8');
    expect(notice).not.toMatch(/sumore beta|test build|prototype/i);
    expect(notice.match(/sumore · \{APP_REVISION\}/g)).toHaveLength(2);
    expect(notice).toContain('Check for app update');
    expect(notice).toContain('Restart to apply update');
  });

  it('explains real shared rewards without promising test currency', () => {
    const camp = readFileSync(new URL('../app/index.tsx', import.meta.url), 'utf8');
    expect(camp).toContain('S’mores and unlocked items are shared by everyone in your circle.');
    expect(camp).toContain('Any request skips that day, even if denied or cancelled.');
    expect(camp).not.toMatch(/99 test s’mores|test s’mores to start/);
  });

  it('keeps demo balances and controls isolated behind both development gates', () => {
    const provider = readFileSync(new URL('../features/local-art-preview.tsx', import.meta.url), 'utf8');
    const preview = readFileSync(new URL('../features/preview-circle-shop.ts', import.meta.url), 'utf8');
    expect(provider).toContain("isLocalArtPreview = __DEV__ && process.env.EXPO_PUBLIC_LOCAL_ART_PREVIEW === '1'");
    expect(provider).toContain('if (!isLocalArtPreview)');
    expect(preview).toContain("id: 'local-art-preview-circle'");
    expect(preview).toContain('balance: 0');
    expect(preview).not.toContain('balance: 200');
  });

  it('keeps onboarding accurate without beta copy or hiding platform limitations', () => {
    for (const platform of ['ios', 'android', 'web']) {
      expect(appTourSlides(platform).map(slide => `${slide.title} ${slide.body} ${slide.note}`).join(' '))
        .not.toMatch(/beta|prototype|test currency|99 test/i);
    }
    expect(appTourSlides('android')[1].note).toContain('Usage Access and Accessibility');
    expect(appTourSlides('web')[1].note).toContain('cannot block or unlock phone apps');
  });
});
