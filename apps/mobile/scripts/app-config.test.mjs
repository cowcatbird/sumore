import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createAppConfig } = require('../app.config.js');
const { expo } = require('../app.json');
const eas = require('../eas.json');
const projectId = '12345678-abcd-1234-abcd-123456789012';

describe('fork configuration', () => {
  it('starts without production services or entitlements', () => {
    const config = createAppConfig(structuredClone(expo), {});
    expect(config.owner).toBeUndefined();
    expect(config.ios.bundleIdentifier).toBe('com.example.sumore');
    expect(config.android.package).toBe('com.example.sumore');
    expect(config.android.googleServicesFile).toBeUndefined();
    expect(config.extra.eas).toBeUndefined();
    expect(config.updates).toEqual({ enabled: false });
    expect(config.plugins.find(plugin => plugin[0] === './plugins/with-screen-time')[1]).toEqual({
      enabled: false, reportsEnabled: false, appGroupIdentifier: 'group.com.example.sumore',
    });
    expect(eas.submit.production).toEqual({});
  });

  it('configures services only for the fork owner and project', () => {
    const config = createAppConfig(structuredClone(expo), {
      SUMORE_EXPO_OWNER: 'example-owner',
      SUMORE_EAS_PROJECT_ID: projectId,
      SUMORE_ANDROID_GOOGLE_SERVICES_FILE: '/private/client-config.json',
      SUMORE_ANDROID_PACKAGE: 'org.example.android',
      SUMORE_IOS_BUNDLE_IDENTIFIER: 'org.example.ios',
      SUMORE_IOS_APPLE_TEAM_ID: 'EXAMPLETEAM',
      SUMORE_APP_SCHEME: 'example-sumore',
      SUMORE_APP_SLUG: 'example-sumore',
      SUMORE_EAS_UPDATES_ENABLED: 'true',
      SUMORE_SCREEN_TIME_ENABLED: 'true',
    });
    expect(config.owner).toBe('example-owner');
    expect(config.android.package).toBe('org.example.android');
    expect(config.android.googleServicesFile).toBe('/private/client-config.json');
    expect(config.ios.bundleIdentifier).toBe('org.example.ios');
    expect(config.ios.appleTeamId).toBe('EXAMPLETEAM');
    expect(config.scheme).toBe('example-sumore');
    expect(config.slug).toBe('example-sumore');
    expect(config.extra.eas.projectId).toBe(projectId);
    expect(config.updates.url).toBe(`https://u.expo.dev/${projectId}`);
    expect(config.updates.enabled).toBe(true);
    expect(config.plugins.find(plugin => plugin[0] === './plugins/with-screen-time')[1]).toEqual({
      enabled: true, reportsEnabled: false, appGroupIdentifier: 'group.org.example.ios',
    });
  });

  it('does not enable OTA just because push has an EAS project', () => {
    const config = createAppConfig(structuredClone(expo), { SUMORE_EAS_PROJECT_ID: projectId });
    expect(config.extra.eas.projectId).toBe(projectId);
    expect(config.updates).toEqual({ enabled: false });
  });

  it('accepts an EAS-init project in app.json without requiring an env override', () => {
    const config = createAppConfig({ ...structuredClone(expo), extra: { eas: { projectId } } }, {
      SUMORE_EAS_UPDATES_ENABLED: 'true',
    });
    expect(config.updates.url).toBe(`https://u.expo.dev/${projectId}`);
  });

  it('requires a real project identifier before enabling updates', () => {
    expect(() => createAppConfig(expo, { SUMORE_EAS_UPDATES_ENABLED: 'true' })).toThrow('before enabling');
    expect(() => createAppConfig(expo, { SUMORE_EAS_PROJECT_ID: 'not-a-project-uuid' })).toThrow('UUID');
  });

  it('preserves permission removals and requires push setup in distributed Android profiles', () => {
    const config = createAppConfig(structuredClone(expo), {});
    expect(config.android.blockedPermissions).toEqual([
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ]);
    expect(eas.build.preview.env.SUMORE_ANDROID_PUSH_REQUIRED).toBe('true');
    expect(eas.build.production.env.SUMORE_ANDROID_PUSH_REQUIRED).toBe('true');
    expect(eas.build.development.env?.SUMORE_ANDROID_PUSH_REQUIRED).toBeUndefined();
    expect(eas.build.production.env.SUMORE_SCREEN_TIME_ENABLED).toBeUndefined();
  });
});
