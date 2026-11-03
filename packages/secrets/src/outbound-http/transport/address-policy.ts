import { isIP } from 'node:net';

import {
  BLOCKED_IPV4_PREFIXES,
  BLOCKED_IPV6_PREFIXES,
} from './iana-address-policy-snapshot.js';

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
      BLOCKED_IPV4_PREFIXES.some(([network, prefix]) =>
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
    if (
      BLOCKED_IPV6_PREFIXES.some(({ network, prefix }) =>
        matchesIpv6Prefix(words, network, prefix),
      )
    )
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
  const invalidCompression =
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1);
  if (invalidCompression) throw new Error('invalid IPv6 address');
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

export type AllowedPrivateNetwork = Readonly<{
  family: 4 | 6;
  words: readonly number[];
  prefix: number;
}>;

// Cloud metadata services hand out credentials; no allowlist reaches them.
const METADATA_NETWORKS = Object.freeze([
  Object.freeze({
    family: 4 as const,
    words: ipv4Words('169.254.0.0'),
    prefix: 16,
  }),
  Object.freeze({
    family: 6 as const,
    words: ipv6Words('fd00:ec2::'),
    prefix: 32,
  }),
]);

function ipv4Words(address: string): readonly number[] {
  const value = ipv4Number(address);
  return [(value >>> 16) & 0xffff, value & 0xffff];
}

/**
 * The operator's HTTP_ALLOWED_PRIVATE_NETWORKS: comma-separated CIDRs such as
 * `10.0.0.0/8,192.168.1.20/32,fd12::/48`. A malformed entry stops startup.
 */
export function parseAllowedPrivateNetworks(
  value: string | undefined,
): readonly AllowedPrivateNetwork[] {
  if (value === undefined || value.trim() === '') return Object.freeze([]);
  return Object.freeze(
    value.split(',').map((entry) => {
      const [address = '', prefixText = ''] = entry.trim().split('/');
      const family = isIP(address);
      const prefix = Number(prefixText);
      const invalidNetwork =
        (family !== 4 && family !== 6) ||
        !/^\d{1,3}$/u.test(prefixText) ||
        prefix > (family === 4 ? 32 : 128);
      if (invalidNetwork)
        throw new Error(
          `HTTP_ALLOWED_PRIVATE_NETWORKS has an invalid entry "${entry.trim()}"; use CIDRs such as 10.0.0.0/8.`,
        );
      return Object.freeze({
        family,
        words: family === 4 ? ipv4Words(address) : ipv6Words(address),
        prefix: family === 4 ? prefix + 96 : prefix,
      });
    }),
  );
}

function inNetwork(
  family: 4 | 6,
  words: readonly number[],
  network: AllowedPrivateNetwork,
): boolean {
  if (network.family !== family) return false;
  // IPv4 networks are stored behind 96 zero bits, so one matcher serves both.
  const padded = family === 4 ? [0, 0, 0, 0, 0, 0, ...words] : words;
  const base =
    network.family === 4 ? [0, 0, 0, 0, 0, 0, ...network.words] : network.words;
  return matchesIpv6Prefix(padded, base, network.prefix);
}

// IPv6 forms that carry an IPv4 address in their last 32 bits, which a wide
// allowlist such as ::/0 would otherwise wave through to the metadata service.
const TRAILING_IPV4_NETWORKS = Object.freeze(
  (
    [
      // IPv4-compatible and IPv4-mapped.
      ['::', 80],
      // IPv4-translated.
      ['::ffff:0:0:0', 96],
      // NAT64, well-known and local-use.
      ['64:ff9b::', 96],
      ['64:ff9b:1::', 48],
    ] as const
  ).map(([network, prefix]) => ({ network: ipv6Words(network), prefix })),
);
const SIX_TO_FOUR = Object.freeze(ipv6Words('2002::'));

function embeddedIpv4(words: readonly number[]): readonly number[] | undefined {
  if (matchesIpv6Prefix(words, SIX_TO_FOUR, 16)) return words.slice(1, 3);
  return TRAILING_IPV4_NETWORKS.some(({ network, prefix }) =>
    matchesIpv6Prefix(words, network, prefix),
  )
    ? words.slice(6)
    : undefined;
}

function isMetadataAddress(family: 4 | 6, words: readonly number[]): boolean {
  const embedded = family === 6 ? embeddedIpv4(words) : undefined;
  const [checkedFamily, checked] =
    embedded === undefined ? [family, words] : ([4, embedded] as const);
  return METADATA_NETWORKS.some((network) =>
    inNetwork(checkedFamily, checked, {
      ...network,
      prefix: network.family === 4 ? network.prefix + 96 : network.prefix,
    }),
  );
}

/** Whether the operator allowed this private address; metadata never is. */
export function isAllowedPrivateAddress(
  address: string,
  networks: readonly AllowedPrivateNetwork[],
): boolean {
  if (networks.length === 0) return false;
  const family = isIP(address);
  if (family !== 4 && family !== 6) return false;
  const words = family === 4 ? ipv4Words(address) : ipv6Words(address);
  if (isMetadataAddress(family, words)) return false;
  return networks.some((network) => inNetwork(family, words, network));
}
