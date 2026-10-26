/**
 * For the verified hosted gateway contract: the first X-Forwarded-For value
 * is the client address; later values are changing intermediary proxies.
 * Do not reuse this trust assumption behind a different/unverified ingress.
 * Invalid/missing values share a conservative bucket, never a caller string.
 */
export function trustedClientAddress(forwardedFor: string | null): string {
  const first = forwardedFor?.split(',', 1)[0]?.trim() ?? '';
  if (!first || first.length > 128) return 'unknown';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(first)) {
    const parts = first.split('.').map(Number);
    return parts.every(part => part <= 255) ? parts.join('.') : 'unknown';
  }
  // URL's IPv6 parser rejects invalid groups and normalizes equivalent forms.
  // Only plain IP characters are allowed: no zones, ports, hostnames or URLs.
  if (!first.includes(':') || !/^[0-9a-f:.]+$/i.test(first)) return 'unknown';
  try {
    const hostname = new URL(`http://[${first}]/`).hostname;
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1).toLowerCase() : 'unknown';
  } catch { return 'unknown'; }
}
