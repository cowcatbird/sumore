import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Android local module Gradle configuration', () => {
  it('declares the library version required by the Expo SDK57 publication plugin', () => {
    const gradle = readFileSync(new URL('./build.gradle', import.meta.url), 'utf8');
    const defaults = gradle.match(/defaultConfig\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(defaults).toMatch(/versionCode\s+1\b/);
    expect(defaults).toMatch(/versionName\s+['"]1\.0\.0['"]/);
    expect(gradle).toContain("id 'expo-module-gradle-plugin'");
  });
});
