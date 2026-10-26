import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { run, validateAndroidPushConfig } from './check-android-push-config.mjs';

const require = createRequire(import.meta.url);
const { expo } = require('../app.json');
const config = {
  android: { package: 'com.example.app', googleServicesFile: './google-services.json' },
  plugins: [['expo-notifications', { defaultChannel: 'default' }]],
};
const valid = () => ({
  project_info: { project_number: '123456', project_id: 'test-project' },
  client: [{
    client_info: { mobilesdk_app_id: '1:123456:android:abc123', android_client_info: { package_name: 'com.example.app' } },
    api_key: [{ current_key: 'public-client-key' }],
  }],
});
const read = value => () => JSON.stringify(value);

describe('Android push build preflight', () => {
  it('validates a matching public Android client config without returning keys', () => {
    expect(validateAndroidPushConfig(config, read(valid()))).toEqual({ projectId: 'test-project', senderId: '123456' });
  });
  it('fails builds with missing configuration or missing files', () => {
    expect(() => validateAndroidPushConfig({ android: {} })).toThrow('android.googleServicesFile');
    expect(() => validateAndroidPushConfig(config, () => { throw new Error('ENOENT'); })).toThrow('missing from the build');
  });
  it('allows unconfigured local development but still rejects broken opt-in configuration', () => {
    const noRead = vi.fn();
    expect(validateAndroidPushConfig({ android: {} }, noRead, '/project', { required: false })).toBeNull();
    expect(noRead).not.toHaveBeenCalled();
    expect(() => validateAndroidPushConfig(config, () => { throw new Error('ENOENT'); }, '/project', { required: false }))
      .toThrow('missing from the build');
    expect(() => validateAndroidPushConfig(config, read({ ...valid(), private_key: 'secret' }), '/project', { required: false }))
      .toThrow('must not be packaged');
  });
  it('rejects malformed files without echoing their contents', () => {
    expect(() => validateAndroidPushConfig(config, () => 'secret malformed content')).toThrow('contents are not logged');
  });
  it('refuses private credentials even if the file also has client fields', () => {
    for (const privateFields of [{ type: 'service_account' }, { private_key: 'secret' }, { private_key_id: 'secret' }]) {
      expect(() => validateAndroidPushConfig(config, read({ ...valid(), ...privateFields }))).toThrow('must not be packaged');
    }
    expect(() => validateAndroidPushConfig(config, () =>
      JSON.stringify({ ...valid(), private_key: 'secret' }).replace('private_key', 'pri\\u0076ate_key'))).toThrow('must not be packaged');
    expect(() => validateAndroidPushConfig(config, read({ ...valid(), nested: { private_key: 'secret' } }))).toThrow('must not be packaged');
  });
  it('rejects incorrect package, project number, app ID, and absent public API key', () => {
    for (const change of [
      value => { value.client[0].client_info.android_client_info.package_name = 'com.other.app'; },
      value => { value.project_info.project_number = 'other'; },
      value => { value.client[0].client_info.mobilesdk_app_id = '1:987:android:other'; },
      value => { value.client[0].client_info.mobilesdk_app_id = '1:123456:android'; },
      value => { value.client[0].client_info.mobilesdk_app_id = '1:123456:android:'; },
      value => { value.client[0].api_key = []; },
    ]) {
      const value = valid();
      change(value);
      expect(() => validateAndroidPushConfig(config, read(value))).toThrow();
    }
  });
  it('keeps remote messages on the runtime-created Android channel', () => {
    expect(expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-notifications')[1].defaultChannel).toBe('default');
    expect(() => validateAndroidPushConfig({ ...config, plugins: [] }, read(valid()))).toThrow('default channel');
  });
  it('does not run the Android check in the iOS EAS hook', () => {
    const log = vi.spyOn(console, 'log');
    expect(() => run(['--eas'], { EAS_BUILD_PLATFORM: 'ios' })).not.toThrow();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
