import {
  allowsAllSourceIps,
  parseAllowedSourceCidrs,
  resolveAllowedSourceCidrs,
  sourceIpMatchesCidrs,
} from '../../main/auth/sourceIp';

describe('sourceIp', () => {
  test('parseAllowedSourceCidrs returns null for empty or invalid input', () => {
    expect(parseAllowedSourceCidrs(undefined)).toBeNull();
    expect(parseAllowedSourceCidrs('')).toBeNull();
    expect(parseAllowedSourceCidrs('not-json')).toBeNull();
    expect(parseAllowedSourceCidrs('[]')).toBeNull();
  });

  test('parseAllowedSourceCidrs parses JSON array', () => {
    expect(parseAllowedSourceCidrs('["203.0.113.42/32"]')).toEqual(['203.0.113.42/32']);
  });

  test('0.0.0.0/0 allows any source IP', () => {
    expect(allowsAllSourceIps(['0.0.0.0/0'])).toBe(true);
    expect(sourceIpMatchesCidrs('198.51.100.1', ['0.0.0.0/0'])).toBe(true);
  });

  test('matches specific CIDR', () => {
    expect(sourceIpMatchesCidrs('203.0.113.42', ['203.0.113.0/24'])).toBe(true);
    expect(sourceIpMatchesCidrs('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
  });

  test('resolveAllowedSourceCidrs prefers user override when present', () => {
    expect(resolveAllowedSourceCidrs('["198.51.100.42/32"]', '["203.0.113.0/24"]', true)).toEqual([
      '198.51.100.42/32',
    ]);
  });

  test('resolveAllowedSourceCidrs falls back to partner when user override absent', () => {
    expect(resolveAllowedSourceCidrs(undefined, '["203.0.113.0/24"]', false)).toEqual([
      '203.0.113.0/24',
    ]);
  });

  test('resolveAllowedSourceCidrs falls back to partner when user override is empty', () => {
    expect(resolveAllowedSourceCidrs('[]', '["203.0.113.0/24"]', true)).toEqual(['203.0.113.0/24']);
  });
});
