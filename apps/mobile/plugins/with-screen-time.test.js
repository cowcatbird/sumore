import { describe, it, expect } from 'vitest';
import xcode from 'xcode';
import withScreenTime from './with-screen-time';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plist from '@expo/plist';

function fixture() {
  const project = xcode.project('/unused/test.pbxproj');
  project.hash = { project: { rootObject: 'PROJECT', objects: {
    PBXProject: { PROJECT: { isa: 'PBXProject', mainGroup: 'MAIN', targets: [{ value: 'APP' }] } },
    PBXNativeTarget: { APP: { isa: 'PBXNativeTarget', name: 'sumore', buildConfigurationList: 'CONFIGS', buildPhases: [], dependencies: [], productName: 'sumore' } },
    PBXGroup: { MAIN: { isa: 'PBXGroup', children: [], sourceTree: '"<group>"' } },
    PBXBuildFile: {}, PBXFileReference: {},
    XCConfigurationList: { CONFIGS: { buildConfigurations: [{ value: 'DEBUG' }, { value: 'RELEASE' }] } },
    XCBuildConfiguration: {
      DEBUG: { isa: 'XCBuildConfiguration', name: 'Debug', buildSettings: { CURRENT_PROJECT_VERSION: '42', MARKETING_VERSION: '1.2.0', DEVELOPMENT_TEAM: 'TESTTEAM' } },
      RELEASE: { isa: 'XCBuildConfiguration', name: 'Release', buildSettings: { CURRENT_PROJECT_VERSION: '42', MARKETING_VERSION: '1.2.0' } },
    },
  } } };
  return project;
}

const config = () => ({ name: 'sumore', slug: 'sumore', version: '1.2.0', ios: { bundleIdentifier: 'com.example.sumore' } });

describe('Screen Time native build gate', () => {
  it('does nothing by default or when disabled; no unapproved entitlement is inferred', () => {
    for (const options of [{}, { enabled: false }]) {
      const app = config();
      expect(withScreenTime(app, options)).toEqual(config());
    }
  });
  it('declares the extension credentials only for explicit opt-in and preserves unrelated extensions', () => {
    const app = config();
    app.extra = { eas: { projectId: 'project', build: { experimental: { ios: { appExtensions: [{ targetName: 'Other', bundleIdentifier: 'com.example.other' }] } } } } };
    const output = withScreenTime(app, { enabled: true });
    expect(output.extra.eas.projectId).toBe('project');
    expect(output.extra.eas.build.experimental.ios.appExtensions).toEqual([
      { targetName: 'Other', bundleIdentifier: 'com.example.other' },
      { targetName: 'SumoreActivityMonitor', bundleIdentifier: 'com.example.sumore.ActivityMonitor', entitlements: {
        'com.apple.developer.family-controls': true,
        'com.apple.security.application-groups': ['group.com.example.sumore'],
      } },
    ]);
  });
  it('adds one embedded extension, three Swift sources, a target dependency, and matching version/signing', () => {
    const project = fixture();
    const extension = withScreenTime.extensionConfiguration(config(), {});
    withScreenTime.addMonitorTarget(project, extension, config());
    withScreenTime.addMonitorTarget(project, extension, config());
    const objects = project.hash.project.objects;
    const targets = Object.entries(objects.PBXNativeTarget).filter(([key]) => !key.endsWith('_comment'));
    expect(targets).toHaveLength(2);
    const [, monitor] = targets.find(([key]) => key !== 'APP');
    expect(objects.PBXNativeTarget.APP.dependencies).toHaveLength(1);
    const phases = monitor.buildPhases.map((phase) => ({ phase, object: Object.values(objects).map((section) => section[phase.value]).find(Boolean) }));
    expect(phases.find(({ object }) => object.isa === 'PBXSourcesBuildPhase').object.files).toHaveLength(3);
    const copyPhase = Object.values(objects.PBXCopyFilesBuildPhase).find((value) => typeof value === 'object');
    expect(Number(copyPhase.dstSubfolderSpec)).toBe(13);
    expect(copyPhase.files).toHaveLength(1);
    const build = objects.XCBuildConfiguration[objects.XCConfigurationList[monitor.buildConfigurationList].buildConfigurations[0].value].buildSettings;
    expect(build.CURRENT_PROJECT_VERSION).toBe('42');
    expect(build.MARKETING_VERSION).toBe('1.2.0');
    expect(build.DEVELOPMENT_TEAM).toBe('TESTTEAM');
    expect(build.APPLICATION_EXTENSION_API_ONLY).toBe('YES');
    expect(build.CODE_SIGN_ENTITLEMENTS).toContain('SumoreActivityMonitor.entitlements');
    expect(project.writeSync()).toContain('com.example.sumore.ActivityMonitor');
    const group = project.pbxGroupByName('SumoreActivityMonitor');
    expect(group.path).toBe('.');
    expect(group.sourceTree).toBe('"SOURCE_ROOT"');
    for (const { value } of phases.find(({ object }) => object.isa === 'PBXSourcesBuildPhase').object.files) {
      const source = objects.PBXFileReference[objects.PBXBuildFile[value].fileRef];
      const relative = path.join(group.path.replaceAll('"', ''), source.path.replaceAll('"', ''));
      expect(relative).toMatch(/^SumoreActivityMonitor\/(ScreenTimeEngine|ScreenTimeGrant|SumoreActivityMonitor)\.swift$/);
      expect(relative).not.toContain('undefined');
    }
  });
  it('writes a valid monitor bundle with the same App Group and all shared Swift sources', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumore-screen-time-plugin-test-'));
    try {
      const app = withScreenTime(config(), { enabled: true });
      await app.mods.ios.dangerous({ ...app, modRequest: { platformProjectRoot: temp } });
      const folder = path.join(temp, 'SumoreActivityMonitor');
      const info = plist.parse(fs.readFileSync(path.join(folder, 'SumoreActivityMonitor-Info.plist'), 'utf8'));
      const entitlements = plist.parse(fs.readFileSync(path.join(folder, 'SumoreActivityMonitor.entitlements'), 'utf8'));
      expect(info.NSExtension).toEqual({ NSExtensionPointIdentifier: 'com.apple.deviceactivity.monitor-extension', NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).SumoreActivityMonitor' });
      expect(info.SumoreScreenTimeAppGroup).toBe(entitlements['com.apple.security.application-groups'][0]);
      expect(info.SumoreScreenTimeEnabled).toBe(true);
      for (const source of ['SumoreActivityMonitor.swift', 'ScreenTimeEngine.swift', 'ScreenTimeGrant.swift']) {
        expect(fs.readFileSync(path.join(folder, source), 'utf8').length).toBeGreaterThan(100);
      }
      const mainInfo = await app.mods.ios.infoPlist({ ...app, modResults: {}, modRequest: {} });
      expect(mainInfo.modResults.SumoreScreenTimeAppGroup).toBe(info.SumoreScreenTimeAppGroup);
      const mainEntitlements = await app.mods.ios.entitlements({ ...app, modResults: { 'com.apple.security.application-groups': ['group.other'] }, modRequest: {} });
      expect(mainEntitlements.modResults['com.apple.security.application-groups']).toEqual(['group.other', 'group.com.example.sumore']);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  it('uses Expo app version/build rather than stale Xcode template versions', () => {
    const project = fixture();
    const app = { ...config(), version: '1.1.0', ios: { ...config().ios, buildNumber: '73' } };
    withScreenTime.addMonitorTarget(project, withScreenTime.extensionConfiguration(app, {}), app);
    const objects = project.hash.project.objects;
    const monitor = Object.entries(objects.PBXNativeTarget).find(([key, value]) => !key.endsWith('_comment') && value.name?.includes('SumoreActivityMonitor'))[1];
    for (const { value } of objects.XCConfigurationList[monitor.buildConfigurationList].buildConfigurations) {
      expect(objects.XCBuildConfiguration[value].buildSettings.MARKETING_VERSION).toBe('1.1.0');
      expect(objects.XCBuildConfiguration[value].buildSettings.CURRENT_PROJECT_VERSION).toBe('73');
    }
  });

  it('adds a separately gated report with its own embedding, sources, and signing metadata', async () => {
    const project = fixture();
    const app = withScreenTime(config(), { enabled: true, reportsEnabled: true });
    expect(app.extra.eas.build.experimental.ios.appExtensions.map(item => item.targetName)).toEqual(['SumoreActivityMonitor', 'SumoreActivityReport']);
    const report = withScreenTime.reportConfiguration(config(), {});
    withScreenTime.addMonitorTarget(project, withScreenTime.extensionConfiguration(config(), {}), config());
    withScreenTime.addReportTarget(project, report, config());
    withScreenTime.addReportTarget(project, report, config());
    const objects = project.hash.project.objects;
    const targets = Object.entries(objects.PBXNativeTarget).filter(([key]) => !key.endsWith('_comment'));
    expect(targets).toHaveLength(3);
    expect(objects.PBXNativeTarget.APP.dependencies).toHaveLength(2);
    const reportTarget = targets.find(([, value]) => value.name?.includes('SumoreActivityReport'))[1];
    const sources = reportTarget.buildPhases.map(({ value }) => objects.PBXSourcesBuildPhase?.[value]).find(Boolean);
    expect(sources.files).toHaveLength(2);
    expect(project.writeSync()).toContain('com.example.sumore.ActivityReport');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumore-report-plugin-test-'));
    try {
      await app.mods.ios.dangerous({ ...app, modRequest: { platformProjectRoot: temp } });
      const info = plist.parse(fs.readFileSync(path.join(temp, 'SumoreActivityReport/SumoreActivityReport-Info.plist'), 'utf8'));
      const entitlements = plist.parse(fs.readFileSync(path.join(temp, 'SumoreActivityReport/SumoreActivityReport.entitlements'), 'utf8'));
      expect(info.NSExtension).toEqual({ NSExtensionPointIdentifier: 'com.apple.deviceactivityui.report-extension' });
      expect(entitlements).toEqual(report.entitlements);
      for (const source of ['SumoreActivityReport.swift', 'ScreenTimeGrant.swift']) {
        expect(fs.readFileSync(path.join(temp, 'SumoreActivityReport', source), 'utf8').length).toBeGreaterThan(100);
      }
      const mainInfo = await app.mods.ios.infoPlist({ ...app, modResults: {}, modRequest: {} });
      expect(mainInfo.modResults.SumoreScreenTimeReportsEnabled).toBe(true);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
});
