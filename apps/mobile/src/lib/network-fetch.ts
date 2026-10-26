export const NETWORK_TIMEOUT_MS = 20_000;

/** Bound auth/save requests as well as reads; preserve a caller's cancellation. */
export async function networkFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
  const cancel = () => controller.abort();
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener('abort', cancel, { once: true });

  const timeoutError = new Error('The connection took too long. Check your internet connection and try again.');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, NETWORK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(input, { ...init, signal: controller.signal });
        // Supabase auth/RPC responses are small JSON payloads. Fetch resolving
        // only means headers arrived; hold the deadline through the body too.
        // Read a clone so the SDK still gets an unread original response.
        await response.clone().text();
        return response;
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', cancel);
  }
}
