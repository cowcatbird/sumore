import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState } from 'react-native';

import { getScreenTimeStatus, unavailableScreenTimeStatus } from '@/native/screen-time';

/** Read native truth while this screen is visible; never prompt for permission. */
export function useScreenTimeStatus(enabled = true) {
  const [status, setStatus] = useState(unavailableScreenTimeStatus);
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    let active = true;
    let refreshing = false;
    const refresh = () => {
      if (!active || refreshing || (AppState.currentState && AppState.currentState !== 'active')) return;
      refreshing = true;
      void getScreenTimeStatus().then(next => { if (active) setStatus(next); }).finally(() => { refreshing = false; });
    };
    refresh();
    const subscription = AppState.addEventListener('change', value => { if (value === 'active') refresh(); });
    const timer = setInterval(refresh, 3_000);
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [enabled]));
  return status;
}
