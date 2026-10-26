import Constants from 'expo-constants';
import { nativeBuildVersion } from 'expo-application';
import * as Device from 'expo-device';
import type * as ExpoNotifications from 'expo-notifications';
import { type Href, router } from 'expo-router';
import { Platform } from 'react-native';

import type { NotificationReadiness } from '@/types/domain';
import { requireSupabase } from '@/lib/supabase';
import { upsertPushToken } from '@/services/supabase-backend';
import { captureDevicePushRegistration, readDevicePushReceipt, saveDevicePushReceipt } from '@/services/push-device-registration';

type NotificationsModule = typeof ExpoNotifications;

// Expo Go reports the literal `expo` ownership value. Avoid importing the
// deprecated AppOwnership enum in code that every route loads on Android.
const isExpoGo = Constants.appOwnership === 'expo';
let notificationsPromise: Promise<NotificationsModule> | null = null;
const operationTimeoutMs = 25_000;
let registration: { ownerId: string; promise: Promise<void> } | null = null;

class NotificationSetupError extends Error {
  constructor(message: string, readonly readiness: NotificationReadiness = 'permission-granted') { super(message); }
}

/** Never show SDK messages, response bodies, tokens, or credential paths. */
export function notificationErrorMessage(error: unknown, local = false): string {
  if (error instanceof NotificationSetupError) return error.message;
  if (!local && error instanceof Error && /firebase|google-services|fcm|invalid.sender|project.?id|apns|aps-environment/i.test(error.message)) {
    return 'Notifications need an app update. Install the latest version, then try Enable again.';
  }
  return local ? 'Could not schedule the device test. Check notification permission and try again.'
    : 'Could not connect notifications. Check your connection and try Enable again.';
}

export function notificationErrorReadiness(error: unknown): NotificationReadiness {
  if (error instanceof NotificationSetupError) return error.readiness;
  return error instanceof Error && /firebase|google-services|fcm|invalid.sender|project.?id|apns|aps-environment/i.test(error.message)
    ? 'needs-update' : 'unknown';
}

export function notificationStatusLabel(status: NotificationReadiness): string {
  switch (status) {
    case 'registered': return 'Registered on this device';
    case 'permission-granted': return 'Permission allowed. Not connected yet.';
    case 'denied': return 'Permission is off in phone Settings.';
    case 'needs-update': return 'App update needed to connect notifications.';
    case 'needs-development-build': return 'Available in the installed app on a phone.';
    case 'unknown': return 'Registration not confirmed';
    default: return 'Not enabled';
  }
}

function buildId(): string {
  // Native values survive OTA updates; do not reuse another binary's receipt.
  return `${Platform.OS}:${nativeBuildVersion ?? 'development'}`;
}

async function assertOwner(ownerId: string, isCurrent: () => boolean) {
  if (!isCurrent()) throw new NotificationSetupError('Registration was interrupted. Try Enable again.', 'unknown');
  const { data, error } = await requireSupabase().auth.getSession();
  if (error || data.session?.user.id !== ownerId || !isCurrent()) {
    throw new NotificationSetupError('The active account changed. Try Enable again.', 'unknown');
  }
}

async function withDeadline<T>(operation: (current: () => boolean) => Promise<T>, isCurrent = () => true): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(() => !expired && isCurrent()), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new NotificationSetupError('Connecting took too long. Check your connection and try again.', 'unknown')); }, operationTimeoutMs);
    })]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}

function notificationsUnavailable() {
  return Platform.OS === 'web' || isExpoGo;
}

async function loadNotifications() {
  if (notificationsUnavailable()) {
    throw new Error('Push notifications require the installed app.');
  }

  notificationsPromise ??= import('expo-notifications').then((Notifications) => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: false,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    return Notifications;
  }).catch(error => { notificationsPromise = null; throw error; });
  return notificationsPromise;
}

async function configureAndroidChannel(Notifications: NotificationsModule) {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('default', {
    name: 'Friend requests',
    description: 'Requests and decisions from your trusted circle.',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250],
  });
}

function projectId() {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

export async function getNotificationReadiness(ownerId: string): Promise<NotificationReadiness> {
  if (notificationsUnavailable() || !Device.isDevice) return 'needs-development-build';
  const Notifications = await loadNotifications();
  const permissions = await Notifications.getPermissionsAsync();
  if (permissions.status === 'denied') return 'denied';
  if (!projectId()) return 'needs-update';
  if (permissions.status !== 'granted') return 'available';
  // Reading Settings must not prompt or register a native token. Permission
  // and a project ID alone say nothing about FCM/APNs or a saved backend row.
  return withDeadline(async current => {
    const receipt = await readDevicePushReceipt();
    if (!receipt || receipt.ownerId !== ownerId || receipt.projectId !== projectId() || receipt.buildId !== buildId()
      || typeof receipt.token !== 'string' || !/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(receipt.token)) return 'permission-granted';
    await assertOwner(ownerId, current);
    const { data, error } = await requireSupabase().from('device_push_tokens')
      .select('user_id, disabled_at').eq('user_id', ownerId).eq('token', receipt.token).maybeSingle();
    await assertOwner(ownerId, current);
    if (error) return 'unknown';
    return data?.user_id === ownerId && data.disabled_at === null ? 'registered' : 'permission-granted';
  });
}

export function registerForPushNotifications(ownerId: string, isCurrent = () => true): Promise<void> {
  if (registration) return registration.ownerId === ownerId ? registration.promise
    : Promise.reject(new NotificationSetupError('Another registration is finishing. Try again shortly.', 'unknown'));
  const current = captureDevicePushRegistration(isCurrent);
  const promise = withDeadline(active => registerDevice(ownerId, active), current).finally(() => {
    if (registration?.promise === promise) registration = null;
  });
  registration = { ownerId, promise };
  return promise;
}

async function registerDevice(ownerId: string, isCurrent: () => boolean) {
  if (notificationsUnavailable() || !Device.isDevice) {
    throw new NotificationSetupError('Push notifications require the installed app on a phone.', 'needs-development-build');
  }

  await assertOwner(ownerId, isCurrent);
  const Notifications = await loadNotifications();
  await configureAndroidChannel(Notifications);
  await assertOwner(ownerId, isCurrent);
  const current = await Notifications.getPermissionsAsync();
  await assertOwner(ownerId, isCurrent);
  const result = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (result.status !== 'granted') throw new NotificationSetupError('Allow notifications in your phone Settings, then try Enable again.', 'denied');
  await assertOwner(ownerId, isCurrent);

  const easProjectId = projectId();
  if (!easProjectId) {
    throw new NotificationSetupError('Notifications need an app update. Install the latest version, then try Enable again.', 'needs-update');
  }
  const token = (await Notifications.getExpoPushTokenAsync({ projectId: easProjectId })).data;
  if (!/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token)) throw new NotificationSetupError('Could not register this device. Try Enable again.');
  await assertOwner(ownerId, isCurrent);
  await upsertPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android', ownerId, isCurrent);
  await assertOwner(ownerId, isCurrent);
  await saveDevicePushReceipt({ ownerId, projectId: easProjectId, buildId: buildId(), token }, isCurrent);
  await assertOwner(ownerId, isCurrent);
}

export function scheduleNotificationPreview(isCurrent = () => true) {
  return withDeadline(current => scheduleDeviceTest(current), isCurrent);
}

async function scheduleDeviceTest(isCurrent: () => boolean) {
  if (notificationsUnavailable()) {
    throw new Error('Notifications require the installed app.');
  }
  const Notifications = await loadNotifications();
  await configureAndroidChannel(Notifications);
  if (!isCurrent()) return;
  const current = await Notifications.getPermissionsAsync();
  if (!isCurrent()) return;
  const result = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (result.status !== 'granted') throw new NotificationSetupError('Allow notifications in your phone Settings, then try again.', 'denied');
  if (!isCurrent()) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'sumore device test',
      body: 'This checks this phone only, not friend notification delivery.',
      data: { url: '/' },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 2 },
  });
}

function openNotification(notification: ExpoNotifications.Notification) {
  const url = notification.request.content.data?.url;
  if (url === '/requests') {
    router.push({ pathname: '/friends', params: { section: 'requests' } });
    return;
  }
  if (url === '/' || url === '/screen-time' || url === '/friends' || url === '/settings') {
    router.push(url as Href);
  }
}

export async function observeNotificationNavigation() {
  if (notificationsUnavailable()) return () => undefined;

  const Notifications = await loadNotifications();
  const lastResponse = Notifications.getLastNotificationResponse();
  if (lastResponse?.notification) openNotification(lastResponse.notification);

  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    openNotification(response.notification);
  });
  return () => subscription.remove();
}
