import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GovernanceController } from '../../src/governance/controller.js';
import {
  GOVERNANCE_AUTHORIZATION,
  GovernanceGuard,
} from '../../src/governance/guard.js';
import { GOVERNANCE_STORE } from '../../src/governance/tokens.js';
import { CsvExportAdmission } from '../../src/platform/http/csv/admission.js';
import {
  browserHeaders,
  foreignWorkspaceId,
  sessionActorId,
  sessionHttpApp,
  sessionWorkspaceId,
} from '../support/session-http.js';

const settings = { revision: 2, auditRetentionDays: 90 };
const update = { expectedRevision: 1, auditRetentionDays: 90 };

async function* audit() {
  yield await Promise.resolve('"action"\r\n');
}

const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function governanceApp() {
  const governance = {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    settings: vi.fn().mockResolvedValue(settings),
    configure: vi.fn().mockResolvedValue(settings),
    exportCsv: vi.fn(
      async (
        input: Readonly<{
          consume: (
            csv: AsyncIterable<string>,
            metadata: Readonly<{ filename: string; storedBytes: number }>,
          ) => Promise<void>;
        }>,
      ) => {
        await input.consume(audit(), { filename: 'audit.csv', storedBytes: 9 });
      },
    ),
  };
  const exports = {
    run: vi.fn((_workspaceId: string, work: () => Promise<unknown>) => work()),
  };
  const fixture = await sessionHttpApp({
    controller: GovernanceController,
    guards: [{ guard: GovernanceGuard, token: GOVERNANCE_AUTHORIZATION }],
    providers: [
      { provide: GOVERNANCE_STORE, useValue: governance },
      { provide: CsvExportAdmission, useValue: exports },
    ],
    fields: { governance, exports },
  });
  apps.push(fixture.app);
  return { ...fixture, governance };
}

const base = (workspaceId = sessionWorkspaceId) =>
  `/v1/workspaces/${workspaceId}/governance`;

describe('governance over HTTP', () => {
  it('needs a signed-in session', async () => {
    const { app, governance } = await governanceApp();
    const response = await app.inject({
      method: 'GET',
      url: `${base()}/settings`,
    });
    expect(response.statusCode).toBe(401);
    expect(governance.settings).not.toHaveBeenCalled();
  });

  it('hides a workspace the person is not a member of', async () => {
    const { app, governance } = await governanceApp();
    const response = await app.inject({
      method: 'GET',
      url: `${base(foreignWorkspaceId)}/audit`,
      headers: browserHeaders({ csrf: false }),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'resource.not_found' });
    expect(governance.list).not.toHaveBeenCalled();
  });

  it('refuses a settings change without the CSRF pair', async () => {
    const { app, governance } = await governanceApp();
    const response = await app.inject({
      method: 'PUT',
      url: `${base()}/settings`,
      headers: browserHeaders({ csrf: false, idempotencyKey: 'k' }),
      payload: update,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'auth.forbidden' });
    expect(governance.configure).not.toHaveBeenCalled();
  });

  it('changes settings for the signed-in person', async () => {
    const { app, governance } = await governanceApp();
    const response = await app.inject({
      method: 'PUT',
      url: `${base()}/settings`,
      headers: browserHeaders({ idempotencyKey: 'settings-1' }),
      payload: update,
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(governance.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: sessionWorkspaceId,
        actorId: sessionActorId,
        ...update,
        idempotencyKey: 'settings-1',
      }),
    );
  });

  it('refuses an audit export without the CSRF token', async () => {
    const { app, governance } = await governanceApp();
    const response = await app.inject({
      method: 'POST',
      url: `${base()}/audit/export`,
      headers: browserHeaders({ csrf: false }),
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(governance.exportCsv).not.toHaveBeenCalled();
  });

  it('starts an audit export once the CSRF token matches', async () => {
    const { app, governance } = await governanceApp();
    const response = await app.inject({
      method: 'POST',
      url: `${base()}/audit/export`,
      headers: browserHeaders(),
      payload: {},
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.payload).toBe('"action"\r\n');
    expect(governance.exportCsv).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: sessionWorkspaceId,
        actorId: sessionActorId,
      }),
    );
  });

  it('authorizes audit reads as audit:read', async () => {
    const { app, authorized } = await governanceApp();
    const response = await app.inject({
      method: 'GET',
      url: `${base()}/audit`,
      headers: browserHeaders({ csrf: false }),
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(authorized).toEqual(['audit:read']);
  });

  // api-14: settings writes are a governance:manage action, not an audit read.
  it('authorizes a settings change as governance:manage', async () => {
    const { app, authorized } = await governanceApp();
    const response = await app.inject({
      method: 'PUT',
      url: `${base()}/settings`,
      headers: browserHeaders({ idempotencyKey: 'settings-2' }),
      payload: update,
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(authorized).toEqual(['governance:manage']);
  });
});
