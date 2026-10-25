import type { AccessibleWorkspace } from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import {
  apiBase,
  fixtureIds,
  fixtureStatistics,
  fixtureWorkspace,
  identityHandlers,
  statisticsHandler,
} from '../../../support/fixtures/run';
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
    statisticsHandler(
      (query) =>
        fixtureStatistics({
          window: query.get('window') ?? '24h',
          byStatus: { succeeded: 6, failed: 2 },
          ...(query.get('breakdown') === 'workflow'
            ? {
                workflows: [
                  {
                    workflowId: fixtureIds.workflow,
                    workflowName: 'Daily intake',
                    total: 8,
                  },
                ],
              }
            : {}),
        }),
      seen,
    ),
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  return { reads: () => reads, seen };
}
