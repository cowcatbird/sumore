function configured(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function createAppConfig(config, env = process.env) {
  const owner = configured(env.SUMORE_EXPO_OWNER) || config.owner;
  const projectId = configured(env.SUMORE_EAS_PROJECT_ID) || config.extra?.eas?.projectId;
  const googleServicesFile = configured(env.SUMORE_ANDROID_GOOGLE_SERVICES_FILE) || config.android?.googleServicesFile;
  const bundleIdentifier = configured(env.SUMORE_IOS_BUNDLE_IDENTIFIER) || config.ios?.bundleIdentifier;
  const updatesEnabled = env.SUMORE_EAS_UPDATES_ENABLED === 'true';

  if (projectId && !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(projectId)) {
    throw new Error('SUMORE_EAS_PROJECT_ID must be the UUID of your own EAS project.');
  }
  if (updatesEnabled && !projectId) {
    throw new Error('Set SUMORE_EAS_PROJECT_ID before enabling EAS updates.');
  }

  return {
    ...config,
    ...(owner ? { owner } : {}),
    slug: configured(env.SUMORE_APP_SLUG) || config.slug,
    scheme: configured(env.SUMORE_APP_SCHEME) || config.scheme,
    ios: {
      ...config.ios,
      bundleIdentifier,
      ...(configured(env.SUMORE_IOS_APPLE_TEAM_ID) ? { appleTeamId: configured(env.SUMORE_IOS_APPLE_TEAM_ID) } : {}),
    },
    android: {
      ...config.android,
      package: configured(env.SUMORE_ANDROID_PACKAGE) || config.android?.package,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}),
    },
    // A fresh checkout never downloads updates from another project's service.
    updates: updatesEnabled ? {
      enabled: true,
      url: `https://u.expo.dev/${projectId}`,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 3000,
    } : { enabled: false },
    plugins: [
      ...(config.plugins || []),
      'expo-mail-composer',
      './plugins/with-screen-time-android',
      ['./plugins/with-screen-time', {
        // Apple approval and provisioning are required separately for each target.
        enabled: env.SUMORE_SCREEN_TIME_ENABLED === 'true',
        reportsEnabled: env.SUMORE_SCREEN_TIME_REPORTS_ENABLED === 'true',
        appGroupIdentifier: configured(env.SUMORE_IOS_APP_GROUP) || `group.${bundleIdentifier}`,
      }],
    ],
  };
}

module.exports = ({ config }) => createAppConfig(config);
module.exports.createAppConfig = createAppConfig;
