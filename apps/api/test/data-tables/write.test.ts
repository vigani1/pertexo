import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { DataTablesController } from '../../src/data-tables/controller.js';
import type { DataTablesService } from '../../src/data-tables/service.js';
import type { CsvExportAdmission } from '../../src/platform/http/csv/admission.js';
import type { CsrfProtectionGuard } from '../../src/workspaces/index.js';

const workspaceId = randomUUID();
const tableId = randomUUID();
const rowId = randomUUID();
const actorId = randomUUID();
const update = {
  operation: 'update',
  table: 'Orders',
  query: {},
  values: { amount: 1 },
};

function setup() {
  const write = vi
    .fn<(input: Readonly<Record<string, unknown>>) => Promise<unknown>>()
    .mockResolvedValue({ affected: 1 });
  const controller = new DataTablesController(
    { store: { write } } as unknown as DataTablesService,
    {} as CsrfProtectionGuard,
    {} as CsvExportAdmission,
  );
  const request = {
    headers: { 'idempotency-key': 'write-1' },
    identitySession: {
      userId: actorId,
      sessionId: randomUUID(),
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      clientMetadata: {},
    },
  };
  const send = (body: unknown) =>
    controller.write(request, workspaceId, tableId, body);
  return { write, send };
}

describe('data-table row writes', () => {
  it('edits one row at the revision the person saw', async () => {
    const { write, send } = setup();
    await send({ command: update, rowId, expectedRevision: 4 });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        tableId,
        command: expect.objectContaining({
          operation: 'update',
          table: 'Orders',
        }) as unknown,
        rowId,
        expectedRevision: 4,
        idempotencyKey: 'write-1',
      }),
    );
  });

  it('runs a table command with no row or revision', async () => {
    const { write, send } = setup();
    await send({ command: update });
    const [input] = write.mock.calls[0] ?? [];
    expect(input).not.toHaveProperty('rowId');
    expect(input).not.toHaveProperty('expectedRevision');
  });

  it.each([{ rowId }, { expectedRevision: 4 }])(
    'refuses a row edit without both its row and revision (%o)',
    (fields) => {
      const { write, send } = setup();
      expect(() => send({ command: update, ...fields })).toThrow(ZodError);
      expect(write).not.toHaveBeenCalled();
    },
  );
});
