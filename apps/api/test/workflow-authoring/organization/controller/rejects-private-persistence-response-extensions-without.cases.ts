import 'reflect-metadata';
import { EventEmitter } from 'node:events';

import { expect, it } from 'vitest';

import { WorkflowOrganizationController } from '../../../../src/workflow-authoring/organization/controller.js';

import {
  workspaceId,
  actorId,
  sessionId,
  headers,
  prefix,
  tagResult,
  fixture,
  httpFixture,
} from './fixture.js';

export function registerRejectsPrivatePersistenceResponseExtensionsWithout(): void {
  it('rejects private persistence response extensions without exposing them', async () => {
    const f = await httpFixture();
    f.tags.createTag.mockResolvedValueOnce({
      ...tagResult,
      generation: 'private-generation',
      actorId,
    });
    const response = await f.app.inject({
      method: 'POST',
      url: prefix + '/workflow-tags',
      headers,
      payload: { key: 'release' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('request.invalid');
    expect(response.body).not.toContain('private-generation');
    expect(response.body).not.toContain('actorId');
  });

  it('propagates disconnect cancellation and removes request listeners (direct request seam)', async () => {
    const f = fixture();
    const raw = new EventEmitter();
    const request = {
      headers,
      identitySession: {
        userId: actorId,
        sessionId,
        expiresAt: new Date('2099-01-01'),
        clientMetadata: {},
      },
      raw,
    };
    let signal: AbortSignal | undefined;
    f.tags.createTag.mockImplementationOnce(
      (input: { signal?: AbortSignal }) => {
        signal = input.signal;
        raw.emit('aborted');
        input.signal?.throwIfAborted();
        return Promise.resolve(tagResult);
      },
    );
    await expect(
      new WorkflowOrganizationController(f.commands, f.reads).createTag(
        request,
        { workspaceId },
        { key: 'release' },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
    expect(raw.listenerCount('aborted')).toBe(0);
  });
}
