import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const engine = readFileSync(new URL('../ios/ScreenTimeEngine.swift', import.meta.url), 'utf8');
const helpers = readFileSync(new URL('../ios/ScreenTimeGrant.swift', import.meta.url), 'utf8');

// Source integration guards complement executable Foundation-only Swift tests.
// They do not simulate Apple's framework, daemon timings, or a physical iPhone.
describe('native restriction no-op write optimization', () => {
  it('uses synthesized full-state equality, including nested grant and policy values', () => {
    expect(engine).toContain('private struct ScreenTimeState: Codable, Equatable');
    for (const type of ['ScreenTimeGrant', 'ScreenTimeDailyPolicy', 'ScreenTimeAppAllocation', 'ScreenTimePerAppPolicy']) {
      expect(helpers).toContain(`struct ${type}: Codable, Equatable`);
    }
  });

  it('compares fresh locked state and only skips an already-durable unchanged commit', () => {
    const transaction = engine.slice(engine.indexOf('private func withState'), engine.indexOf('private func persist'));
    expect(transaction.indexOf('Data(contentsOf: path)')).toBeGreaterThan(transaction.indexOf('flock(descriptor, LOCK_EX | LOCK_NB)'));
    expect(transaction.indexOf('hasDurableOriginal = true')).toBeGreaterThan(transaction.indexOf('try state.perApp?.validateStored()'));
    expect(transaction.indexOf('let original = state')).toBeLessThan(transaction.indexOf('for entry in pending'));
    expect(transaction).toContain('ScreenTimeWritePolicy.commitIfChanged(original: original, updated: state,');
    expect(transaction).toContain('hasDurableOriginal: hasDurableOriginal) { try persist(state, to: path) }');
    expect(transaction.indexOf('try persist(state')).toBeLessThan(transaction.indexOf('applyShields(state)'));
    expect(transaction.indexOf('applyShields(state)')).toBeLessThan(transaction.indexOf('journal.acknowledge(pending)'));
    expect(transaction).toContain('requiresReset: true');
  });

  it('reads every live shield field before deciding to mutate it; never caches the last settings', () => {
    const update = engine.slice(engine.indexOf('private func updateShields'), engine.indexOf('private func reconcile'));
    for (const field of ['applications', 'applicationCategories', 'webDomains', 'webDomainCategories']) {
      expect(update).toContain(`ScreenTimeWritePolicy.updateIfChanged(current: store.shield.${field}, desired: ${field})`);
      expect(update).toContain(`store.shield.${field} = $0`);
    }
    const hasShields = engine.slice(engine.indexOf('private var hasShields'), engine.indexOf('private func updateShields'));
    for (const field of ['applications', 'applicationCategories', 'webDomains', 'webDomainCategories']) {
      expect(hasShields).toContain(`store.shield.${field} != nil`);
    }
    const apply = engine.slice(engine.indexOf('private func applyShields'), engine.indexOf('private var hasShields'));
    expect(apply.match(/if hasShields \{ store\.clearAllSettings\(\) \}/g)).toHaveLength(2);
    expect(apply.indexOf('shouldPreserveShields')).toBeLessThan(apply.indexOf('if hasShields'));
    expect(engine).not.toMatch(/(?:lastApplied|cachedShields|lastShield)/);
  });

  it('keeps live monitor repair and rollback rather than caching restriction status', () => {
    expect(engine).toContain('let installed = Set(monitor.activities)');
    expect(engine).toContain('!monitor.activities.contains(Self.monitorName)');
    expect(engine).toContain('let previousActivities = Set(monitor.activities)');
    expect(engine).toContain('!previousActivities.contains($0)');
    expect(engine).toContain('try registerDaily(state, now: now)');
    expect(engine).toContain('try registerGrant(state, now: now)');
  });
});
