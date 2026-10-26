export type ScreenTimeAuthorization = 'approved' | 'denied';

export type ScreenTimeNativeStatus = {
  engineAvailable: boolean;
  authorized: boolean;
  shielded: boolean;
  authorizationStatus: ScreenTimeAuthorization | 'notDetermined';
  blockingEnabled: boolean;
  selection: { applications: number; categories: number; webDomains: number };
  appliedGrantId: string | null;
  temporaryAccessExpiresAt: string | null;
  reason: string | null;
  requiresReset?: boolean;
  customLimitAvailable?: boolean;
  selectionDisplayAvailable?: boolean;
  reportAvailable?: boolean;
  limitMode?: 'shared' | 'perApp';
  allocatedMinutes?: number | null;
  appliedRequestId?: string | null;
  mode?: 'manual' | 'daily';
  dailyLimitMinutes?: number | null;
  dailyLimitReached?: boolean;
  dailyUsageNote?: string | null;
  usageMinutesToday?: number | null;
  usageAccessGranted?: boolean;
  accessibilityEnabled?: boolean;
  consentGranted?: boolean;
  settingsChangeAllowedAt?: string | null;
};

export type TemporaryGrantInput = {
  grantId: string;
  requesterId: string;
  requestId: string;
  startedAt: string;
  expiresAt: string;
  serverNow: string;
};
