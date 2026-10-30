import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { PublicFormsController } from '../../src/forms/public.controller.js';
import type { FormService } from '../../src/forms/service.js';
import type { HttpRateLimitAdmission } from '../../src/platform/rate-limit/admission.js';

const publicId = randomUUID();
const grant = {
  workspaceId: randomUUID(),
  workflowId: randomUUID(),
  publicId,
  nodeId: 'form',
  capabilityHash: 'c'.repeat(64),
};
const capability = 'K'.repeat(43);
const uploadSession = 'S'.repeat(43);
const body = { versionId: randomUUID(), values: { name: 'Ada' } };

function request(headers: Readonly<Record<string, string>> = {}) {
  return {
    ip: '203.0.113.7',
    headers: {
      'x-pertexo-form-key': capability,
      'idempotency-key': 'submit-1',
      ...headers,
    },
  } as unknown as FastifyRequest;
}

function setup(admit = vi.fn().mockResolvedValue(undefined)) {
  const forms = {
    discover: vi.fn().mockResolvedValue(grant),
    submit: vi.fn().mockResolvedValue({ runId: randomUUID() }),
  };
  const controller = new PublicFormsController(
    forms as unknown as FormService,
    { admit } as unknown as HttpRateLimitAdmission,
  );
  return { forms, admit, controller };
}

describe('public form submission', () => {
  it('spends the workspace submission budget of the form it opened', async () => {
    const { forms, admit, controller } = setup();
    await controller.submit(request(), { publicId }, body);
    expect(forms.discover).toHaveBeenCalledWith(
      expect.objectContaining({ publicId, capability }),
    );
    expect(admit).toHaveBeenCalledExactlyOnceWith('form_workspace_submission', {
      workspaceId: grant.workspaceId,
    });
    expect(forms.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: grant.workspaceId,
        workflowId: grant.workflowId,
        versionId: body.versionId,
        values: body.values,
        idempotencyKey: 'submit-1',
      }),
      grant,
    );
  });

  it('starts no run once the workspace budget is spent', async () => {
    const limited = new Error('rate limited');
    const { forms, controller } = setup(vi.fn().mockRejectedValue(limited));
    await expect(controller.submit(request(), { publicId }, body)).rejects.toBe(
      limited,
    );
    expect(forms.submit).not.toHaveBeenCalled();
  });

  it('passes the response session that owns the uploaded files', async () => {
    const { forms, controller } = setup();
    await controller.submit(
      request({ 'x-pertexo-form-session': uploadSession }),
      { publicId },
      body,
    );
    expect(forms.submit).toHaveBeenCalledWith(
      expect.objectContaining({ uploadSession }),
      grant,
    );
  });

  it('submits a response without uploads with no session', async () => {
    const { forms, controller } = setup();
    await controller.submit(request(), { publicId }, body);
    expect(forms.submit.mock.calls[0]?.[0]).not.toHaveProperty('uploadSession');
  });
});
