import { problemResult } from '../../support/problem.js';
import { WebhookTriggerNotFoundError } from '@pertexo/database/testing';
import { webhookManagementCommandResponseSchema } from '@pertexo/contracts';

import { expect, it } from 'vitest';
import type { WebhookManagementService } from '../../../src/webhooks/management/service.js';
import {
  input,
  setup,
  publicHealthFixture,
  sealedEnvelope,
  expectWiped,
} from './fixture.js';

export function registerOperationDisclosesExactlyOriginalCredentialsWipes(): void {
  it.each([
    {
      operation: 'provision' as const,
      execute: (service: WebhookManagementService) => service.provision(input),
      disclosed: ['endpointKey', 'signingSecret'],
      materialCount: 2,
    },
    {
      operation: 'rotateEndpoint' as const,
      execute: (service: WebhookManagementService) =>
        service.rotateEndpoint(input),
      disclosed: ['endpointKey'],
      materialCount: 1,
    },
    {
      operation: 'rotateSecret' as const,
      execute: (service: WebhookManagementService) =>
        service.rotateSecret({ ...input, endpointKey: 'a'.repeat(43) }),
      disclosed: ['signingSecret'],
      materialCount: 1,
    },
  ])(
    '$operation discloses exactly its original credentials and wipes owned material',
    async ({ execute, disclosed, materialCount }) => {
      const fixture = setup(true);

      const result = await execute(fixture.service);

      expect(result.replayed).toBe(false);
      expect(
        Object.keys(result).filter((key) =>
          ['endpointKey', 'signingSecret'].includes(key),
        ),
      ).toEqual(disclosed);
      expect(webhookManagementCommandResponseSchema.parse(result)).toEqual(
        result,
      );
      expect(fixture.generated).toHaveLength(materialCount);
      expect(fixture.sealedInputs.every((value) => value.some(Boolean))).toBe(
        true,
      );
      expectWiped(fixture.generated);
    },
  );

  it.each([
    {
      operation: 'provision',
      execute: (service: WebhookManagementService) => service.provision(input),
    },
    {
      operation: 'rotateEndpoint',
      execute: (service: WebhookManagementService) =>
        service.rotateEndpoint(input),
    },
    {
      operation: 'rotateSecret',
      execute: (service: WebhookManagementService) =>
        service.rotateSecret({ ...input, endpointKey: 'a'.repeat(43) }),
    },
  ])(
    '$operation completed replay discloses no credentials',
    async ({ execute }) => {
      const fixture = setup(false);

      const result = await execute(fixture.service);

      expect(result).toEqual({
        trigger: publicHealthFixture(),
        replayed: true,
      });
      expect(webhookManagementCommandResponseSchema.parse(result)).toEqual(
        result,
      );
      expectWiped(fixture.generated);
    },
  );

  it.each([
    ['seal rejection', 'seal'] as const,
    ['persistence rejection', 'persistence'] as const,
  ])('wipes all provision material after %s', async (_name, stage) => {
    const fixture = setup(true);
    const failure = new Error(`${stage} failed`);
    if (stage === 'seal') fixture.seal.mockRejectedValueOnce(failure);
    if (stage === 'persistence')
      fixture.database.provision.mockRejectedValueOnce(failure);

    await expect(fixture.service.provision(input)).rejects.toBe(failure);

    expectWiped(fixture.generated);
  });

  it('wipes secret material and skips persistence when aborted after sealing', async () => {
    const fixture = setup(true);
    const abort = new AbortController();
    fixture.seal.mockImplementationOnce((secret: Uint8Array) => {
      fixture.sealedInputs.push(Uint8Array.from(secret));
      abort.abort();
      return Promise.resolve(sealedEnvelope());
    });

    await expect(
      fixture.service.rotateSecret({
        ...input,
        endpointKey: 'a'.repeat(43),
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fixture.database.rotateSecret).not.toHaveBeenCalled();
    expectWiped(fixture.generated);
  });

  it('maps hidden not-found and preserves an unknown command error', async () => {
    const hidden = setup(true);
    hidden.database.rotateEndpoint.mockRejectedValueOnce(
      new WebhookTriggerNotFoundError(),
    );
    await expect(
      problemResult(hidden.service.rotateEndpoint(input)),
    ).rejects.toMatchObject({
      code: 'resource.not_found',
    });

    const unknown = setup(true);
    const failure = new Error('unknown persistence failure');
    unknown.database.rotateEndpoint.mockRejectedValueOnce(failure);
    await expect(unknown.service.rotateEndpoint(input)).rejects.toBe(failure);
  });
}
