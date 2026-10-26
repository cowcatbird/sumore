import { describe, expect, it } from 'vitest';
import { trustedClientAddress } from '../../../../supabase/functions/account-access/client-address';

describe('verified hosted client address selection', () => {
  it('does not change buckets when the gateway proxy suffix rotates', () => {
    expect(trustedClientAddress('198.51.100.7, 10.0.0.1, 10.0.0.2')).toBe('198.51.100.7');
    expect(trustedClientAddress('198.51.100.7, 10.1.0.1, 10.1.0.2')).toBe('198.51.100.7');
  });
  it('keeps different verified client addresses separate', () => {
    expect(trustedClientAddress('198.51.100.7')).not.toBe(trustedClientAddress('203.0.113.8'));
  });
  it('normalizes whitespace and IPv4 leading zeros', () => {
    expect(trustedClientAddress(' 198.051.100.007 , 10.0.0.1')).toBe('198.51.100.7');
  });
  it('normalizes equivalent plain IPv6 addresses', () => {
    expect(trustedClientAddress('2001:0DB8:0:0:0:0:0:1, ::1')).toBe('2001:db8::1');
    expect(trustedClientAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(trustedClientAddress('::FFFF:192.0.2.1')).toBe('::ffff:c000:201');
  });
  it.each([null, '', ' ', ', 198.51.100.7', 'unknown, 198.51.100.7',
    '256.1.1.1', '1.2.3', '1.2.3.4:8080', '2001:db8:::1', '[2001:db8::1]:8080',
    'fe80::1%eth0', 'example.com', 'https://198.51.100.7/', 'x'.repeat(129)])(
    'uses the same fallback for missing or invalid first value (%s)', input => {
      expect(trustedClientAddress(input)).toBe('unknown');
    },
  );
});
