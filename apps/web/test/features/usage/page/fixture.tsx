import type { AccessibleWorkspace } from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import {
  apiBase,
  fixtureIds,
  fixtureWorkspace,
  identityHandlers,
} from '../../../support/fixtures/run';
import { fixtureUsageTrends } from '../../../support/fixtures/usage-trends';
import { mockServer } from '../../../support/mock-server';
export const path = `/w/${fixtureIds.workspace}/settings/usage`;

const capabilities: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'run:read',
  'artifact:read',
  'workflow:read',
];

export const capacity = {
  asOf: '2026-09-15T10:00:00.123456Z',
  execution: {
    activeRuns: 2,
    reservedActiveSlots: 1,
    activeCapacityConsumed: 3,
    queuedRuns: 4,
    policy: {
      state: 'active',
      version: 1,
      activeRunLimit: 5,
      queuedRunLimit: 100,
    },
  },
  artifacts: {
    chargedBytes: '9007199254740993',
    byteLimit: '9223372036854775807',
    chargedCount: 2,
    artifactCountLimit: 1000,
    source: 'stored',
  },
};

export function install(
  options: Readonly<{
    caps?: Readonly<AccessibleWorkspace['capabilities']>;
    state?: string;
    snapshot?: unknown;
    capacityResponse?: () => Response;
    trendsResponse?: () => Response;
  }> = {},
) {
  let reads = 0;
  const seen: URLSearchParams[] = [];
  mockServer.use(
    ...(options.state === undefined
      ? []
      : [
          http.get('http://pertexo.test/v1/workspaces', () =>
            HttpResponse.json({
              items: [
                {
                  ...fixtureWorkspace(options.caps ?? capabilities),
                  status: options.state,
                },
              ],
              nextCursor: null,
            }),
          ),
        ]),
    ...identityHandlers(options.caps ?? capabilities),
    http.get(`${apiBase}/usage-capacity`, () => {
      reads += 1;
      return (
        options.capacityResponse?.() ??
        HttpResponse.json(options.snapshot ?? capacity)
      );
    }),
    http.get(`${apiBase}/usage-trends`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      seen.push(query);
      return (
        options.trendsResponse?.() ??
        HttpResponse.json(
          fixtureUsageTrends(
            query.get('period') === '90d' ? '90d' : '30d',
            fixtureIds.workflow,
          ),
        )
      );
    }),
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  return { reads: () => reads, seen };
}
