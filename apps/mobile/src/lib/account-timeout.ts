export const ACCOUNT_LOAD_TIMEOUT_MS = 20_000;

/** Bound readonly account work; do not use this to abandon a pending signup. */
export function withAccountTimeout<T>(request: PromiseLike<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), ACCOUNT_LOAD_TIMEOUT_MS);
    Promise.resolve(request).then(
      value => { clearTimeout(timeout); resolve(value); },
      error => { clearTimeout(timeout); reject(error); },
    );
  });
}
