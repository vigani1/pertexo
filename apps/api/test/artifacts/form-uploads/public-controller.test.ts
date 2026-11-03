import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { formUploadRoutes as routes } from '@pertexo/contracts/server';
import { PublicFormUploadsController } from '../../../src/artifacts/form-uploads/public.controller.js';
import { routeInput } from '../../support/route-input.js';
import type { FormUploadService } from '../../../src/artifacts/form-uploads/form-upload.service.js';
import type { HttpRateLimitAdmission } from '../../../src/platform/rate-limit/admission.js';

const publicId = randomUUID();
const grant = {
  workspaceId: randomUUID(),
  workflowId: randomUUID(),
  publicId,
  nodeId: 'form',
  capabilityHash: 'c'.repeat(64),
};
const request = { ip: '203.0.113.7', headers: {} } as unknown as FastifyRequest;
const headers = {
  'x-pertexo-form-key': 'K'.repeat(43),
  'x-pertexo-form-session': 'S'.repeat(43),
};
const begin = routeInput<typeof routes.publicBegin>({
  params: { publicId },
  body: {
    versionId: randomUUID(),
    fieldId: 'invoice',
    filename: 'invoice.pdf',
    byteLength: 4,
    sha256: 'a'.repeat(64),
  },
  idempotencyKey: 'begin-1',
  headers,
});

function setup(admit = vi.fn().mockResolvedValue(undefined)) {
  const uploads = {
    discover: vi.fn().mockResolvedValue(grant),
    begin: vi.fn().mockResolvedValue({}),
    finalize: vi.fn().mockResolvedValue({}),
  };
  const controller = new PublicFormUploadsController(
    uploads as unknown as FormUploadService,
    { admit } as unknown as HttpRateLimitAdmission,
  );
  return { uploads, admit, controller };
}

describe('public form uploads', () => {
  it('spends the upload budget per client, link and workspace before each step', async () => {
    const { uploads, admit, controller } = setup();
    await controller.begin(request, begin);
    await controller.finalize(
      request,
      routeInput<typeof routes.publicFinalize>({
        params: { publicId, uploadId: randomUUID() },
        body: {},
        headers,
      }),
    );
    expect(admit).toHaveBeenCalledTimes(2);
    expect(admit).toHaveBeenCalledWith('form_upload', {
      clientAddress: '203.0.113.7',
      formId: publicId,
      workspaceId: grant.workspaceId,
    });
    expect(uploads.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'public_form', grant },
        session: 'S'.repeat(43),
        idempotencyKey: 'begin-1',
      }),
    );
  });

  it('stops before any upload work once the budget is spent', async () => {
    const limited = new Error('rate limited');
    const { uploads, controller } = setup(vi.fn().mockRejectedValue(limited));
    await expect(controller.begin(request, begin)).rejects.toBe(limited);
    expect(uploads.begin).not.toHaveBeenCalled();
  });
});
