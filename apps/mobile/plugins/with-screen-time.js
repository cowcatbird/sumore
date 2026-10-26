/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const { withInfoPlist, withEntitlementsPlist, withDangerousMod, withXcodeProject } = require('expo/config-plugins');
const plist = require('@expo/plist');

const TARGET_NAME = 'SumoreActivityMonitor';
const REPORT_TARGET_NAME = 'SumoreActivityReport';
const FAMILY_CONTROLS = 'com.apple.developer.family-controls';
const APP_GROUPS = 'com.apple.security.application-groups';

function extensionConfiguration(config, options) {
  const bundle = config.ios?.bundleIdentifier;
  if (!bundle) throw new Error('Screen Time requires ios.bundleIdentifier.');
  const appGroupIdentifier = options.appGroupIdentifier || `group.${bundle}`;
  if (!/^group\.[A-Za-z0-9.-]+$/.test(appGroupIdentifier)) throw new Error('Invalid Screen Time App Group identifier.');
  return {
    targetName: TARGET_NAME,
    bundleIdentifier: `${bundle}.ActivityMonitor`,
    appGroupIdentifier,
    entitlements: { [FAMILY_CONTROLS]: true, [APP_GROUPS]: [appGroupIdentifier] },
  };
}

function reportConfiguration(config, options) {
  const extension = extensionConfiguration(config, options);
  return { ...extension, targetName: REPORT_TARGET_NAME, bundleIdentifier: `${config.ios.bundleIdentifier}.ActivityReport` };
}

function addExtensionTarget(project, extension, config, sources) {
  const targetName = extension.targetName;
  const objects = project.hash.project.objects;
  let entry = Object.entries(objects.PBXNativeTarget).find(([key, value]) => !key.endsWith('_comment') && value.name?.replaceAll('"', '') === targetName);
  let target;
  if (entry) target = { uuid: entry[0], pbxNativeTarget: entry[1] };
  else {
    objects.PBXTargetDependency ||= {};
    objects.PBXContainerItemProxy ||= {};
    // xcode's app_extension target also creates embedding and target dependency.
    target = project.addTarget(targetName, 'app_extension', targetName, extension.bundleIdentifier);
    for (const [key, value] of Object.entries(objects.PBXBuildFile)) {
      if (!key.endsWith('_comment') && value.fileRef === target.pbxNativeTarget.productReference) {
        value.settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] };
      }
    }
    project.addBuildPhase(
      sources.map((source) => `${targetName}/${source}`),
      'PBXSourcesBuildPhase', 'Sources', target.uuid,
    );
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    for (const framework of ['DeviceActivity', 'FamilyControls', 'ManagedSettings', ...(targetName === REPORT_TARGET_NAME ? ['SwiftUI'] : [])]) {
      project.addFramework(`${framework}.framework`, { target: target.uuid });
    }
    const group = project.addPbxGroup(
      [...sources.map((source) => `${targetName}/${source}`), `${targetName}/${targetName}.entitlements`, `${targetName}/${targetName}-Info.plist`],
      targetName,
      '.',
      '"SOURCE_ROOT"',
    );
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  }
  // Also repair an already-generated target on an incremental prebuild.
  const sourceGroup = project.pbxGroupByName(targetName);
  if (sourceGroup) { sourceGroup.path = '.'; sourceGroup.sourceTree = '"SOURCE_ROOT"'; }
  const main = project.getFirstTarget().firstTarget;
  const mainConfigList = objects.XCConfigurationList[main.buildConfigurationList];
  const mainBuild = objects.XCBuildConfiguration[mainConfigList.buildConfigurations[0].value].buildSettings;
  const list = objects.XCConfigurationList[target.pbxNativeTarget.buildConfigurationList];
  for (const item of list.buildConfigurations) {
    const settings = objects.XCBuildConfiguration[item.value].buildSettings;
    Object.assign(settings, {
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      CLANG_ENABLE_MODULES: 'YES',
      CODE_SIGN_ENTITLEMENTS: `"${targetName}/${targetName}.entitlements"`,
      CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: config.ios?.buildNumber || mainBuild.CURRENT_PROJECT_VERSION || '1',
      GENERATE_INFOPLIST_FILE: 'NO',
      INFOPLIST_FILE: `"${targetName}/${targetName}-Info.plist"`,
      IPHONEOS_DEPLOYMENT_TARGET: '16.4',
      // Expo writes config.version directly to the app Info.plist; the Xcode
      // template's MARKETING_VERSION may still say 1.0, so it is not authoritative.
      MARKETING_VERSION: config.version || mainBuild.MARKETING_VERSION || '1.0.0',
      PRODUCT_BUNDLE_IDENTIFIER: `"${extension.bundleIdentifier}"`,
      PRODUCT_NAME: `"${targetName}"`,
      SDKROOT: 'iphoneos',
      SKIP_INSTALL: 'YES',
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
    });
    if (mainBuild.DEVELOPMENT_TEAM || config.ios?.appleTeamId) settings.DEVELOPMENT_TEAM = mainBuild.DEVELOPMENT_TEAM || config.ios.appleTeamId;
  }
  return project;
}

function addMonitorTarget(project, extension, config) {
  return addExtensionTarget(project, extension, config, ['SumoreActivityMonitor.swift', 'ScreenTimeEngine.swift', 'ScreenTimeGrant.swift']);
}

function addReportTarget(project, extension, config) {
  return addExtensionTarget(project, extension, config, ['SumoreActivityReport.swift', 'ScreenTimeGrant.swift']);
}

function withScreenTime(config, options = {}) {
  // Never infer Apple's distribution approval from a configured capability.
  // Default beta builds remain unentitled and report engineAvailable:false.
  if (options.enabled !== true) return config;
  const extension = extensionConfiguration(config, options);
  // A new report bundle requires its own approved distribution provisioning.
  // Keep it explicit so existing signed monitor-only builds remain valid.
  const report = options.reportsEnabled === true ? reportConfiguration(config, options) : null;
  config.extra ||= {};
  config.extra.eas ||= {};
  config.extra.eas.build ||= {};
  config.extra.eas.build.experimental ||= {};
  config.extra.eas.build.experimental.ios ||= {};
  const ios = config.extra.eas.build.experimental.ios;
  const declared = ios.appExtensions || [];
  ios.appExtensions = [
    ...declared.filter((entry) => entry.targetName !== TARGET_NAME && entry.targetName !== REPORT_TARGET_NAME),
    { targetName: extension.targetName, bundleIdentifier: extension.bundleIdentifier, entitlements: extension.entitlements },
    ...(report ? [{ targetName: report.targetName, bundleIdentifier: report.bundleIdentifier, entitlements: report.entitlements }] : []),
  ];

  config = withInfoPlist(config, (mod) => {
    mod.modResults.SumoreScreenTimeEnabled = true;
    mod.modResults.SumoreScreenTimeAppGroup = extension.appGroupIdentifier;
    mod.modResults.SumoreScreenTimeReportsEnabled = report !== null;
    return mod;
  });
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults[FAMILY_CONTROLS] = true;
    mod.modResults[APP_GROUPS] = [...new Set([...(mod.modResults[APP_GROUPS] || []), extension.appGroupIdentifier])];
    return mod;
  });
  config = withDangerousMod(config, ['ios', async (mod) => {
    const output = path.join(mod.modRequest.platformProjectRoot, TARGET_NAME);
    fs.mkdirSync(output, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'screen-time', 'SumoreActivityMonitor.swift'), path.join(output, 'SumoreActivityMonitor.swift'));
    for (const source of ['ScreenTimeEngine.swift', 'ScreenTimeGrant.swift']) {
      fs.copyFileSync(path.join(__dirname, '..', 'modules', 'screen-time', 'ios', source), path.join(output, source));
    }
    fs.writeFileSync(path.join(output, `${TARGET_NAME}.entitlements`), plist.default.build(extension.entitlements));
    fs.writeFileSync(path.join(output, `${TARGET_NAME}-Info.plist`), plist.default.build({
      CFBundleDisplayName: 'sumore Screen Time',
      CFBundleExecutable: '$(EXECUTABLE_NAME)',
      CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
      CFBundleInfoDictionaryVersion: '6.0',
      CFBundleName: '$(PRODUCT_NAME)',
      CFBundlePackageType: 'XPC!',
      CFBundleShortVersionString: '$(MARKETING_VERSION)',
      CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
      NSExtension: {
        NSExtensionPointIdentifier: 'com.apple.deviceactivity.monitor-extension',
        NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).SumoreActivityMonitor',
      },
      SumoreScreenTimeEnabled: true,
      SumoreScreenTimeAppGroup: extension.appGroupIdentifier,
    }));
    if (report) {
      const reportOutput = path.join(mod.modRequest.platformProjectRoot, REPORT_TARGET_NAME);
      fs.mkdirSync(reportOutput, { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'screen-time', 'SumoreActivityReport.swift'), path.join(reportOutput, 'SumoreActivityReport.swift'));
      fs.copyFileSync(path.join(__dirname, '..', 'modules', 'screen-time', 'ios', 'ScreenTimeGrant.swift'), path.join(reportOutput, 'ScreenTimeGrant.swift'));
      fs.writeFileSync(path.join(reportOutput, `${REPORT_TARGET_NAME}.entitlements`), plist.default.build(report.entitlements));
      fs.writeFileSync(path.join(reportOutput, `${REPORT_TARGET_NAME}-Info.plist`), plist.default.build({
        CFBundleDisplayName: 'sumore Time Remaining',
        CFBundleExecutable: '$(EXECUTABLE_NAME)',
        CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
        CFBundleInfoDictionaryVersion: '6.0',
        CFBundleName: '$(PRODUCT_NAME)',
        CFBundlePackageType: 'XPC!',
        CFBundleShortVersionString: '$(MARKETING_VERSION)',
        CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
        NSExtension: { NSExtensionPointIdentifier: 'com.apple.deviceactivityui.report-extension' },
        SumoreScreenTimeAppGroup: report.appGroupIdentifier,
      }));
    }
    return mod;
  }]);
  return withXcodeProject(config, (mod) => {
    mod.modResults = addMonitorTarget(mod.modResults, extension, config);
    if (report) mod.modResults = addReportTarget(mod.modResults, report, config);
    return mod;
  });
}

module.exports = withScreenTime;
module.exports.extensionConfiguration = extensionConfiguration;
module.exports.addMonitorTarget = addMonitorTarget;
module.exports.reportConfiguration = reportConfiguration;
module.exports.addReportTarget = addReportTarget;
