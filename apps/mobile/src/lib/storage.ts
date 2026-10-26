import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const secureChunkSize = 1800;
const chunkCountSuffix = '__chunk_count';

function webStorage() {
  return typeof window === 'undefined' ? null : window.localStorage;
}

async function removeNativeChunks(key: string) {
  const countText = await SecureStore.getItemAsync(`${key}${chunkCountSuffix}`);
  const count = Number(countText ?? 0);
  await Promise.all(
    Array.from({ length: Number.isFinite(count) ? count : 0 }, (_, index) =>
      SecureStore.deleteItemAsync(`${key}__${index}`),
    ),
  );
  await SecureStore.deleteItemAsync(`${key}${chunkCountSuffix}`);
}

export const authStorage = {
  async getItem(key: string) {
    if (Platform.OS === 'web') return webStorage()?.getItem(key) ?? null;

    const countText = await SecureStore.getItemAsync(`${key}${chunkCountSuffix}`);
    const count = Number(countText ?? 0);
    if (!Number.isFinite(count) || count <= 0) return SecureStore.getItemAsync(key);

    const chunks = await Promise.all(
      Array.from({ length: count }, (_, index) => SecureStore.getItemAsync(`${key}__${index}`)),
    );
    return chunks.every((chunk) => chunk !== null) ? chunks.join('') : null;
  },

  async setItem(key: string, value: string) {
    if (Platform.OS === 'web') {
      webStorage()?.setItem(key, value);
      return;
    }

    await removeNativeChunks(key);
    if (value.length <= secureChunkSize) {
      await SecureStore.setItemAsync(key, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      return;
    }

    await SecureStore.deleteItemAsync(key);
    const chunks = Array.from(
      { length: Math.ceil(value.length / secureChunkSize) },
      (_, index) => value.slice(index * secureChunkSize, (index + 1) * secureChunkSize),
    );
    await Promise.all(
      chunks.map((chunk, index) =>
        SecureStore.setItemAsync(`${key}__${index}`, chunk, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      ),
    );
    await SecureStore.setItemAsync(`${key}${chunkCountSuffix}`, String(chunks.length));
  },

  async removeItem(key: string) {
    if (Platform.OS === 'web') {
      webStorage()?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
    await removeNativeChunks(key);
  },
};

export const appStorage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};
