import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const plugin = require('./with-screen-time-android.js');
const { withDesugaring } = plugin;
const appConfig = require('../app.json').expo;
const { AndroidConfig } = require('expo/config-plugins');

const appGradle = `apply plugin: "com.android.application"
android {
    namespace "com.example.sumore"
    defaultConfig { minSdkVersion rootProject.ext.minSdkVersion }
    compileOptions { sourceCompatibility JavaVersion.VERSION_17 }
}
dependencies { implementation("com.facebook.react:react-android") }
`;

describe('Android app-limit consumer desugaring', () => {
  it('enables API24/25 java.time support in the app without changing minimum OS or JVM target', () => {
    const result = withDesugaring(appGradle);
    expect(result).toContain('coreLibraryDesugaringEnabled true');
    expect(result).toContain("coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'");
    expect(result).toContain(appGradle.trimEnd());
    expect(result).toContain('minSdkVersion rootProject.ext.minSdkVersion');
    expect(result).toContain('sourceCompatibility JavaVersion.VERSION_17');
  });
  it('is idempotent across repeated prebuilds', () => {
    const once = withDesugaring(appGradle);
    expect(withDesugaring(once)).toBe(once);
    expect(once.match(/desugar_jdk_libs:2\.1\.5/g)).toHaveLength(1);
  });
  it('does not duplicate an existing matching consumer dependency', () => {
    const withDependency = `${appGradle}\ndependencies { coreLibraryDesugaring('com.android.tools:desugar_jdk_libs:2.1.5') }\n`;
    const result = withDesugaring(withDependency);
    expect(result.match(/desugar_jdk_libs:2\.1\.5/g)).toHaveLength(1);
    expect(withDesugaring(result)).toBe(result);
  });
  it('rejects an unexpected file instead of silently editing the wrong Gradle target', () => {
    expect(() => withDesugaring('plugins { id "base" }')).toThrow('could not find');
  });
  it('registers only an Android appBuildGradle mod', () => {
    const config = plugin({ name: 'sumore', slug: 'sumore' });
    expect(config.mods.android.appBuildGradle).toBeTypeOf('function');
    expect(config.mods.ios).toBeUndefined();
  });
});

describe('Android least-privilege release configuration', () => {
  const unnecessary = [
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ];

  it('blocks inherited storage and general overlay permissions in every prebuild', () => {
    expect(appConfig.android.blockedPermissions).toEqual(unnecessary);
    const manifest = { manifest: { 'uses-permission': [
      ...unnecessary.map(name => ({ $: { 'android:name': name, 'android:maxSdkVersion': '32' } })),
      { $: { 'android:name': 'android.permission.INTERNET' } },
      { $: { 'android:name': 'android.permission.PACKAGE_USAGE_STATS' } },
      { $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } },
    ] } };
    const result = AndroidConfig.Permissions.addBlockedPermissions(manifest, appConfig.android.blockedPermissions);
    for (const name of unnecessary) {
      expect(result.manifest['uses-permission'].filter((item: { $: Record<string, string> }) => item.$['android:name'] === name))
        .toEqual([{ $: { 'android:name': name, 'tools:node': 'remove' } }]);
    }
    for (const name of ['INTERNET', 'PACKAGE_USAGE_STATS', 'POST_NOTIFICATIONS']) {
      expect(result.manifest['uses-permission']).toContainEqual({ $: { 'android:name': `android.permission.${name}` } });
    }
  });

  it('retains the accessibility-specific overlay and does not replace it with system alert windows', () => {
    const service = readFileSync(new URL('../modules/screen-time/android/src/main/java/expo/modules/screentime/SumoreAccessibilityService.kt', import.meta.url), 'utf8');
    expect(service).toContain('WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY');
    expect(service).not.toMatch(/TYPE_APPLICATION_OVERLAY|SYSTEM_ALERT_WINDOW|canDrawOverlays/);
    const moduleManifest = readFileSync(new URL('../modules/screen-time/android/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
    expect(moduleManifest).toContain('android.permission.BIND_ACCESSIBILITY_SERVICE');
    expect(moduleManifest).toContain('android.permission.PACKAGE_USAGE_STATS');
    for (const permission of unnecessary) expect(moduleManifest).not.toContain(permission);
  });
});
