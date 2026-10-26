import { NativeModule, requireNativeModule } from 'expo';

import type { ScreenTimeAuthorization, ScreenTimeNativeStatus, TemporaryGrantInput } from './ScreenTimeModule.types';

declare class ScreenTimeModule extends NativeModule {
  requestAuthorization(): Promise<ScreenTimeAuthorization>;
  getStatus(): Promise<ScreenTimeNativeStatus>;
  setAccount(accountId: string | null): Promise<ScreenTimeNativeStatus>;
  presentAppPicker(): Promise<ScreenTimeNativeStatus>;
  presentAppLimits(): Promise<ScreenTimeNativeStatus>;
  setBlockingEnabled(enabled: boolean): Promise<ScreenTimeNativeStatus>;
  clearSelection(): Promise<ScreenTimeNativeStatus>;
  configureDailyLimit(minutes: number): Promise<ScreenTimeNativeStatus>;
  requestDisable(): Promise<ScreenTimeNativeStatus>;
  cancelDisable(): Promise<ScreenTimeNativeStatus>;
  openUsageAccessSettings(): Promise<ScreenTimeNativeStatus>;
  openAccessibilitySettings(): Promise<ScreenTimeNativeStatus>;
  setDisclosureAccepted(accepted: boolean): Promise<ScreenTimeNativeStatus>;
  grantTemporaryAccess(input: TemporaryGrantInput): Promise<ScreenTimeNativeStatus>;
}

export default requireNativeModule<ScreenTimeModule>('ScreenTimeModule');
