export const MAX_DISPLAY_NAME_LENGTH = 60;

/** Names are labels, not unique identifiers. Preserve spelling and interior
 * spaces; friends are identified by their private account ID and friend code.
 */
export function normalizeDisplayName(displayName: string): string {
  return displayName.trim();
}

export function isValidDisplayName(displayName: string): boolean {
  // PostgreSQL char_length counts Unicode code points, unlike JS string.length.
  const length = [...normalizeDisplayName(displayName)].length;
  return length >= 1 && length <= MAX_DISPLAY_NAME_LENGTH;
}
