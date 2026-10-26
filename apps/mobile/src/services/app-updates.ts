export const APP_REVISION = 'welcome-swipe-1';

type UpdateClient = {
  checkForUpdateAsync: () => Promise<{ isAvailable: boolean; isRollBackToEmbedded?: boolean }>;
  fetchUpdateAsync: () => Promise<{ isNew: boolean; isRollBackToEmbedded?: boolean }>;
};

/** Only download here. Applying an update must be a separate, deliberate tap. */
export async function downloadAppUpdate(client: UpdateClient, timeoutMs = 30_000): Promise<'ready' | 'current'> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error('The update check took too long. Check your connection and try again.');
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(timeoutError);
    }, timeoutMs);
  });
  const operation = async () => {
    const check = await client.checkForUpdateAsync();
    if (expired) throw timeoutError;
    if (!check.isAvailable && !check.isRollBackToEmbedded) return 'current' as const;
    const download = await client.fetchUpdateAsync();
    if (expired) throw timeoutError;
    if (!download.isNew && !download.isRollBackToEmbedded) {
      throw new Error('The update could not be downloaded. Please try again.');
    }
    return 'ready' as const;
  };
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
