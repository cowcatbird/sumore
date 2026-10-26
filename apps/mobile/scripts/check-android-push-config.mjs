import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

function containsPrivateCredential(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'service_account') return true;
  return Object.entries(value).some(([key, child]) =>
    key === 'private_key' || key === 'private_key_id' || containsPrivateCredential(child));
}

// This validates the public Android client config, not the private sending key.
// The matching FCM v1 service-account key belongs in EAS credentials, never here.
export function validateAndroidPushConfig(config, read = file => fs.readFileSync(file, 'utf8'), root = projectRoot, { required = true } = {}) {
  const file = config.android?.googleServicesFile;
  if (typeof file !== 'string' || !file.trim()) {
    if (!required) return null;
    throw new Error('Android push setup is incomplete: set SUMORE_ANDROID_GOOGLE_SERVICES_FILE (android.googleServicesFile) to your Firebase Android client JSON before distribution.');
  }
  let raw;
  try { raw = read(path.resolve(root, file)); } catch {
    throw new Error('The Firebase Android client JSON is missing from the build. Do not substitute a service-account key.');
  }
  let clientConfig;
  try { clientConfig = JSON.parse(raw); } catch {
    throw new Error('The Firebase Android client JSON is invalid. Download a fresh google-services.json; file contents are not logged.');
  }
  if (containsPrivateCredential(clientConfig) || /BEGIN (?:RSA )?PRIVATE KEY/.test(raw)) {
    throw new Error('A private service-account key must not be packaged in the app. Use the public google-services.json instead.');
  }
  const project = clientConfig?.project_info;
  const number = project?.project_number;
  if (typeof number !== 'string' || !/^\d+$/.test(number) || typeof project.project_id !== 'string' || !project.project_id.trim()) {
    throw new Error('The Firebase client config is missing its project ID or sender ID. Download it again from Firebase.');
  }
  const client = Array.isArray(clientConfig.client)
    ? clientConfig.client.find(entry => entry?.client_info?.android_client_info?.package_name === config.android.package)
    : undefined;
  if (!client || !new RegExp(`^1:${number}:android:[a-f0-9]+$`, 'i').test(client.client_info.mobilesdk_app_id ?? '')) {
    throw new Error('The Firebase Android client must match this app package and Firebase project. Register the existing Android package in Firebase.');
  }
  if (!Array.isArray(client.api_key) || !client.api_key.some(key => typeof key.current_key === 'string' && key.current_key.trim())) {
    throw new Error('The Firebase Android client is missing its public API key. Download its configuration again.');
  }
  const notifications = config.plugins?.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-notifications');
  if (notifications?.[1]?.defaultChannel !== 'default') {
    throw new Error('Android remote notifications must use the default channel created by the app.');
  }
  return { projectId: project.project_id, senderId: number };
}

export function run(args = process.argv.slice(2), env = process.env) {
  // This hook also runs for iOS; do not require Android configuration there.
  if (args.includes('--eas') && env.EAS_BUILD_PLATFORM !== 'android') return;
  const { getConfig } = require('@expo/config');
  const { exp } = getConfig(projectRoot);
  const required = args.includes('--required') || env.SUMORE_ANDROID_PUSH_REQUIRED === 'true';
  const result = validateAndroidPushConfig(exp, undefined, projectRoot, { required });
  if (!result) {
    console.log('Android remote push is not configured. Local development can continue without remote notifications.');
    return;
  }
  console.log('Android Firebase client configuration validated. Verify the matching FCM v1 credential in EAS before release.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
