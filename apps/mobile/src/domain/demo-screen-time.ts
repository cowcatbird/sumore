import { DEFAULT_DAILY_LIMIT, validDailyLimit } from '@/domain/daily-limit-controls';
import { allowedGrantMinutes, type GrantMinutes } from '@/types/domain';

export const DEMO_APPS = ['Social feed', 'Short videos', 'Games'] as const;
export type DemoApp = typeof DEMO_APPS[number];
export type DemoState = {
  apps: DemoApp[];
  minutes: number;
  allocations: Record<DemoApp, number>;
  mode: 'shared' | 'perApp';
  enabled: boolean;
  choosing: boolean;
  used: number;
  approvedMinutes: number;
};
export type DemoAction = { type: 'choose' | 'done' | 'enable' | 'stop' | 'simulate' | 'reset' }
  | { type: 'toggle'; app: DemoApp }
  | { type: 'minutes'; minutes: number }
  | { type: 'perApp'; allocations: Partial<Record<DemoApp, number>> }
  | { type: 'grant'; minutes: number };

export const createDemoLimitState = (): DemoState => ({
  apps: [], minutes: DEFAULT_DAILY_LIMIT,
  allocations: { 'Social feed': 30, 'Short videos': 30, Games: 30 },
  mode: 'shared', enabled: false, choosing: false, used: 0, approvedMinutes: 0,
});
export const demoLimitBaseTotal = (state: DemoState) => state.mode === 'perApp'
  ? state.apps.reduce((total, app) => total + state.allocations[app], 0) : state.minutes;
export const demoLimitTotal = (state: DemoState) => demoLimitBaseTotal(state) + state.approvedMinutes;
export const demoLimitRemaining = (state: DemoState) => Math.max(0, demoLimitTotal(state) - state.used);

export function demoAskBlockReason(state: DemoState): string | null {
  if (!state.enabled || !state.apps.length) return 'Set up a daily allowance in Screen Time before asking.';
  if (demoLimitRemaining(state) > 0) return 'Use your remaining time before asking for more.';
  return null;
}

export function parseDemoMinutes(text: string): number | null {
  return /^\d+$/.test(text) && validDailyLimit(Number(text)) ? Number(text) : null;
}

/** Pure session-only accounting. Never grants time on a real device. */
export function demoLimitReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'reset': return createDemoLimitState();
    case 'choose': return state.enabled ? state : { ...state, choosing: !state.choosing };
    case 'done': return { ...state, choosing: false };
    case 'toggle': return state.enabled || !DEMO_APPS.includes(action.app) ? state : { ...state, used: 0, approvedMinutes: 0,
      apps: state.apps.includes(action.app) ? state.apps.filter(app => app !== action.app) : [...state.apps, action.app] };
    case 'minutes': return state.enabled || !validDailyLimit(action.minutes) ? state
      : { ...state, minutes: action.minutes, mode: 'shared', used: 0, approvedMinutes: 0 };
    case 'perApp': return state.enabled || !state.apps.length || state.apps.some(app => !validDailyLimit(action.allocations[app])) ? state
      : { ...state, allocations: Object.fromEntries(DEMO_APPS.map(app => [app,
        state.apps.includes(app) ? action.allocations[app]! : state.allocations[app]])) as Record<DemoApp, number>,
      mode: 'perApp', enabled: true, choosing: false, used: 0, approvedMinutes: 0 };
    case 'enable': return !state.enabled && state.apps.length ? { ...state, enabled: true, choosing: false, used: 0, approvedMinutes: 0 } : state;
    case 'stop': return state.enabled ? { ...state, enabled: false } : state;
    case 'simulate': return state.enabled ? { ...state, used: Math.min(demoLimitTotal(state), state.used + 5) } : state;
    case 'grant': return !state.enabled || !state.apps.length || !allowedGrantMinutes.includes(action.minutes as GrantMinutes) ||
      !Number.isSafeInteger(state.approvedMinutes + action.minutes) ? state
      : { ...state, approvedMinutes: state.approvedMinutes + action.minutes };
  }
}
