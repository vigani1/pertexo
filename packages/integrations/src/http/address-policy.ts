import { isIP } from 'node:net';

const IPV4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

export type ResolvedAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export function normalizeUrlHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export function assertPublicAddress(address: string): 4 | 6 {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (
      IPV4_BLOCKS.some(([network, prefix]) =>
        matchesIpv4Prefix(value, ipv4Number(network), prefix),
      )
    )
      throw new Error('blocked address');
    return 4;
  }
  if (family === 6) {
    const words = ipv6Words(address);
    const first = words[0] ?? 0;
    if ((first & 0xe000) !== 0x2000) throw new Error('blocked address');
    if (matchesIpv6Prefix(words, [0x2001, 0x0], 23))
      throw new Error('blocked address');
    if (matchesIpv6Prefix(words, [0x2001, 0x0db8], 32))
      throw new Error('blocked address');
    if (matchesIpv6Prefix(words, [0x2002], 16))
      throw new Error('blocked address');
    if (matchesIpv6Prefix(words, [0x3fff], 20))
      throw new Error('blocked address');
    return 6;
  }
  throw new Error('invalid address');
}

function ipv4Number(address: string): number {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    throw new Error('invalid IPv4 address');
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

function matchesIpv4Prefix(
  address: number,
  network: number,
  prefix: number,
): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

function ipv6Words(address: string): readonly number[] {
  const normalized = address.toLowerCase();
  if (normalized.includes('%')) throw new Error('scoped IPv6 is blocked');
  const halves = normalized.split('::');
  if (halves.length > 2) throw new Error('invalid IPv6 address');
  const left = parseIpv6Half(halves[0] ?? '');
  const right = parseIpv6Half(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    throw new Error('invalid IPv6 address');
  return [
    ...left,
    ...new Array<number>(Math.max(0, missing)).fill(0),
    ...right,
  ];
}

function parseIpv6Half(value: string): readonly number[] {
  if (value === '') return [];
  const segments = value.split(':');
  return segments.flatMap((segment, index) => {
    if (segment.includes('.')) {
      if (index !== segments.length - 1)
        throw new Error('invalid embedded IPv4 address');
      const ipv4 = ipv4Number(segment);
      return [(ipv4 >>> 16) & 0xffff, ipv4 & 0xffff];
    }
    if (!/^[0-9a-f]{1,4}$/u.test(segment))
      throw new Error('invalid IPv6 segment');
    return [Number.parseInt(segment, 16)];
  });
}

function matchesIpv6Prefix(
  address: readonly number[],
  network: readonly number[],
  prefix: number,
): boolean {
  const wholeWords = Math.floor(prefix / 16);
  for (let index = 0; index < wholeWords; index += 1) {
    if ((address[index] ?? 0) !== (network[index] ?? 0)) return false;
  }
  const remaining = prefix % 16;
  if (remaining === 0) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return (
    ((address[wholeWords] ?? 0) & mask) === ((network[wholeWords] ?? 0) & mask)
  );
}
