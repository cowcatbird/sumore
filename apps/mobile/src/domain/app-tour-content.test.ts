/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { APP_TOUR_STEP_COUNT, appTourSlides } from './app-tour-content';

describe('short, accurate onboarding copy', () => {
  it('has exactly six brief illustrated steps matching the shared count, with no em dashes or future promises', () => {
    const slides = appTourSlides('ios');
    expect(APP_TOUR_STEP_COUNT).toBe(6);
    expect(slides).toHaveLength(APP_TOUR_STEP_COUNT);
    expect(slides.map(slide => slide.id)).toEqual(['circle', 'request', 'limits', 'reward', 'customize', 'login']);
    for (const platform of ['android', 'web']) expect(appTourSlides(platform)).toHaveLength(APP_TOUR_STEP_COUNT);
    for (const slide of slides) {
      const copy = `${slide.title} ${slide.body} ${slide.note}`;
      // 22 keeps most slides to a glance; the reward slide spends more words
      // because it has to state what loses a s'more, not just what earns one.
      expect(copy.split(/\s+/).length).toBeLessThanOrEqual(slide.id === 'reward' ? 30 : 22);
      expect(copy).not.toMatch(/—|coming soon|eventually/i);
      expect(copy).not.toMatch(/unique|in Friends|in Customize/);
    }
  });

  it('keeps request limits distinct from the personal daily app limit', () => {
    const sql = readFileSync(new URL('../../../../supabase/migrations/0002_app_api_and_invites.sql', import.meta.url), 'utf8');
    expect(sql).toContain("raise exception 'A request is already pending'");
    expect(sql).toContain("created_at > now() - interval '1 hour'");
    expect(sql).toContain(") >= 5 then raise exception 'Please wait before sending another request'");
    const limits = appTourSlides('ios').find(slide => slide.id === 'limits')!;
    expect(limits.title).toBe('Your daily limit');
    expect(limits.body).toBe('Choose apps to limit in the Screen Time tab');
    expect(limits.note).toBe('Choose between a shared or separate budget for app limits');
    expect(`${limits.title} ${limits.body} ${limits.note}`).not.toMatch(/group budget|circle budget/i);
    const requestHelp = readFileSync(new URL('../app/index.tsx', import.meta.url), 'utf8');
    expect(requestHelp).toContain('One pending request; up to five per hour');
  });

  it('describes no-request-day rewards, not measured usage or an unconditional daily gift', () => {
    const reward = appTourSlides('ios').find(slide => slide.id === 'reward')!;
    expect(reward.body).toContain('No requests from everyone for a whole day');
    expect(reward.body).toContain('one s’more');
    expect(reward.note).toContain('approved or rejected');
    expect(reward.body).not.toMatch(/under.*limit|measured|usage/i);
  });

  it('shows where to spend the shared wallet and what the group can unlock', () => {
    const customize = appTourSlides('ios').find(slide => slide.id === 'customize')!;
    expect(customize.body).toBe('Customize your camper from Camp');
    expect(customize.note).toContain('hats, colors and shared campsites');
  });

  it('offers real activities only on the friend and customization slides', () => {
    expect(appTourSlides('ios').filter(slide => slide.activity).map(({ id, activity }) => [id, activity]))
      .toEqual([['circle', 'friends'], ['customize', 'customize']]);
  });

  it('ends with the private account recovery key, without promising Apple-account sync', () => {
    const login = appTourSlides('ios').at(-1)!;
    expect(login.id).toBe('login');
    expect(login.body).toBe('Save your private key in Setup');
    expect(login.note).toContain('Enter its key to restore it');
    expect(`${login.title} ${login.body} ${login.note}`).not.toMatch(/Apple|iCloud|automatically|share/i);
  });

  it('states platform limitations directly', () => {
    const requestNote = (platform: string) => appTourSlides(platform).find(slide => slide.id === 'request')!.note;
    expect(requestNote('android')).toContain('Usage Access and Accessibility');
    expect(requestNote('web')).toContain('cannot block or unlock phone apps');
    expect(requestNote('ios')).toBe('Uses Screen Time access to limit apps');
    expect(appTourSlides('android')[1].body).toContain('15 or 30 extra minutes');
    expect(appTourSlides('web')[1].body).toContain('5, 10, 15 or 30');
    expect(appTourSlides('ios')[1].body).toContain('15 or 30 extra minutes');
  });

  it('keeps account recovery in Setup and daily limits in Screen Time on every platform', () => {
    for (const platform of ['ios', 'android', 'web']) {
      const slides = appTourSlides(platform);
      const limits = slides.find(slide => slide.id === 'limits')!;
      expect(limits.body).toContain('Screen Time');
      expect(`${limits.body} ${limits.note}`).not.toContain('Setup');
      expect(slides.find(slide => slide.id === 'login')!.body).toContain('in Setup');
      expect(slides.find(slide => slide.id === 'request')!.note).not.toContain('Setup');
    }
  });
});
