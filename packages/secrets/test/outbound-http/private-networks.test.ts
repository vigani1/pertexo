import { describe, expect, it, vi } from 'vitest';

import {
  isAllowedPrivateAddress,
  parseAllowedPrivateNetworks,
} from '../../src/outbound-http/transport/address-policy.js';
import {
  SecureHttpClient,
  type SecureHttpRequest,
  type SecureHttpTransportResponse,
} from '../../src/server.js';

const networks = parseAllowedPrivateNetworks(
  ' 10.0.0.0/8, 192.168.1.20/32 ,fd12:3456::/48,127.0.0.1/32,0.0.0.0/0',
);

function client(answers: Record<string, string>) {
  const dispatch = vi.fn((): Promise<SecureHttpTransportResponse> =>
    Promise.resolve({
      status: 200,
      headers: {},
      body: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield new TextEncoder().encode('ok');
        },
      },
      close: vi.fn(),
    }),
  );
  return {
    dispatch,
    http: new SecureHttpClient(
      {
        resolve: (hostname: string) => {
          const address = answers[hostname];
          return address === undefined
            ? Promise.reject(new Error('missing DNS fixture'))
            : Promise.resolve([
                { address, family: address.includes(':') ? 6 : 4 },
              ]);
        },
      },
      { dispatch },
      undefined,
      { allowedPrivateNetworks: parseAllowedPrivateNetworks('10.0.0.0/8') },
    ),
  };
}

const call = (url: string): SecureHttpRequest => ({
  url,
  method: 'GET',
  timeoutMillis: 1_000,
  maxRedirects: 0,
  maxResponseBytes: 1_024,
  beforeDispatch: () => Promise.resolve(),
});

describe('operator-allowed private networks', () => {
  // S7: the docs promise metadata stays blocked; an operator listing all of IPv6
  // must not open it through a mapped or NAT64 spelling of the same address.
  it.each(['::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe'])(
    'S7 %s stays blocked with ::/0 listed',
    (address) => {
      expect(
        isAllowedPrivateAddress(address, parseAllowedPrivateNetworks('::/0')),
      ).toBe(false);
    },
  );

  it('matches listed IPv4 and IPv6 networks and nothing else', () => {
    for (const address of [
      '10.1.2.3',
      '192.168.1.20',
      'fd12:3456:0:1::5',
      '127.0.0.1',
    ])
      expect(isAllowedPrivateAddress(address, networks)).toBe(true);
    expect(isAllowedPrivateAddress('192.168.1.21', [])).toBe(false);
    expect(
      isAllowedPrivateAddress(
        '192.168.1.21',
        parseAllowedPrivateNetworks('192.168.1.20/32'),
      ),
    ).toBe(false);
  });

  it('never reaches cloud metadata, even under a catch-all entry', () => {
    expect(isAllowedPrivateAddress('169.254.169.254', networks)).toBe(false);
    expect(
      isAllowedPrivateAddress(
        'fd00:ec2::254',
        parseAllowedPrivateNetworks('fd00::/8'),
      ),
    ).toBe(false);
  });

  it('refuses a malformed entry instead of guessing', () => {
    for (const value of ['10.0.0.0', '10.0.0.0/33', 'internal/8', '::1/129'])
      expect(() => parseAllowedPrivateNetworks(value)).toThrow(
        /HTTP_ALLOWED_PRIVATE_NETWORKS/u,
      );
    expect(parseAllowedPrivateNetworks(undefined)).toEqual([]);
    expect(parseAllowedPrivateNetworks('  ')).toEqual([]);
  });

  it('sends plain http into an allowed network, but not to the internet or other private hosts', async () => {
    const { http, dispatch } = client({
      'billing.internal': '10.4.0.7',
      'other.internal': '172.16.0.9',
      'api.example.test': '93.184.216.34',
    });
    await expect(
      http.execute(call('http://billing.internal/invoices')),
    ).resolves.toMatchObject({ status: 200 });
    expect(dispatch).toHaveBeenCalledOnce();
    for (const url of [
      'http://api.example.test/',
      'https://other.internal/',
      'http://169.254.169.254/latest/meta-data/',
    ])
      await expect(http.execute(call(url))).rejects.toMatchObject({
        code: 'ssrf_blocked',
        possiblyDispatched: false,
      });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

const metadataEndpoints = [
  [
    'AWS, GCP, Azure, Oracle, DigitalOcean, Hetzner and OpenStack IPv4',
    '169.254.169.254',
  ],
  ['Alibaba', '100.100.100.200'],
  ['Azure WireServer', '168.63.129.16'],
  ['AWS IPv6', 'fd00:ec2::254'],
  ['GCP IPv6', 'fd20:ce::254'],
  ['OpenStack IPv6', 'fe80::a9fe:a9fe'],
  ['Akamai/Linode IPv6', 'fd00:a9fe:a9fe::1'],
  ['GKE metadata proxy', '169.254.169.252'],
  ['EKS Pod Identity', '169.254.170.23'],
  ['EKS Pod Identity IPv6', 'fd00:ec2::23'],
  ['Kubernetes link-local', '169.254.1.1'],
  ['Alibaba mapped IPv4', '::ffff:100.100.100.200'],
  ['Alibaba compatible IPv4', '::100.100.100.200'],
  ['Alibaba translated IPv4', '::ffff:0:100.100.100.200'],
  ['Alibaba NAT64', '64:ff9b::6464:64c8'],
  ['Alibaba local NAT64', '64:ff9b:1::6464:64c8'],
  ['Alibaba 6to4', '2002:6464:64c8::'],
] as const;

it.each(metadataEndpoints)(
  'blocks %s before transport, including under the broadest operator allowlist',
  async (_provider, address) => {
    for (const allowed of [undefined, '0.0.0.0/0,::/0']) {
      const allowlist = parseAllowedPrivateNetworks(allowed);
      expect(isAllowedPrivateAddress(address, allowlist)).toBe(false);
      const dispatch = vi.fn(() =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: (async function* () {
            await Promise.resolve();
            yield new Uint8Array();
          })(),
          close: () => undefined,
        }),
      );
      const http = new SecureHttpClient(
        {
          resolve: () =>
            Promise.resolve([
              { address, family: address.includes(':') ? 6 : 4 },
            ]),
        },
        { dispatch },
        undefined,
        { allowedPrivateNetworks: allowlist },
      );
      await expect(
        http.execute(call('https://metadata.example.test/')),
      ).rejects.toMatchObject({
        code: 'ssrf_blocked',
        possiblyDispatched: false,
      });
      expect(dispatch).not.toHaveBeenCalled();
    }
  },
);

it('keeps explicitly allowed services beside the metadata endpoints reachable', () => {
  const allowlist = parseAllowedPrivateNetworks('0.0.0.0/0,::/0');
  for (const address of [
    '100.100.100.199',
    '100.100.100.201',
    '168.63.129.15',
    'fd20:ce::253',
    'fe80::1',
    'fd00:a9fe:a9fe::2',
  ])
    expect(isAllowedPrivateAddress(address, allowlist)).toBe(true);
});
