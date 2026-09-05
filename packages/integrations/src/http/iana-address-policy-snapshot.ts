/**
 * Human-reviewed normalization of the IANA special-purpose registries.
 * Upstream byte drift is checked by infrastructure/validate-iana-address-registry.mjs.
 */
export const IANA_ADDRESS_REGISTRY_SNAPSHOT = Object.freeze({
  approvedAt: '2026-09-05',
  ipv4: Object.freeze({
    updated: '2025-10-09',
    url: 'https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xml',
    sha256: 'cf24e11f41b7d42c68debe2d18b97cac815084ec413ebb3b244f704028a16f20',
  }),
  ipv6: Object.freeze({
    updated: '2025-10-09',
    url: 'https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xml',
    sha256: 'c17f4380ba84fb2160dae82ebfd8bd155a5853cfab624ed3a9fd251638a8be02',
  }),
});

export const BLOCKED_IPV4_PREFIXES = Object.freeze([
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
] as const);

export const BLOCKED_IPV6_PREFIXES = Object.freeze([
  Object.freeze({ network: Object.freeze([0x2001, 0x0]), prefix: 23 }),
  Object.freeze({ network: Object.freeze([0x2001, 0x0db8]), prefix: 32 }),
  Object.freeze({ network: Object.freeze([0x2002]), prefix: 16 }),
  Object.freeze({ network: Object.freeze([0x3fff]), prefix: 20 }),
]);
