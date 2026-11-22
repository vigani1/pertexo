import { workflowMcpSettingsSchema } from '@pertexo/contracts';
import { expect } from 'vitest';
import type { StackOwner } from '../support/real-stack/owner.js';

export async function readExposure(owner: StackOwner, path: string) {
  const response = await owner.send('GET', `${path}/mcp`);
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return workflowMcpSettingsSchema.parse(JSON.parse(body));
}

export async function expose(
  owner: StackOwner,
  workflow: Readonly<{ path: string; versionId: string }>,
  name: string,
) {
  const settings = await readExposure(owner, workflow.path);
  expect(settings).toMatchObject({
    eligible: true,
    publishedVersionId: workflow.versionId,
  });
  const exposure = await owner.send('PUT', `${workflow.path}/mcp`, {
    kind: 'expose',
    name,
    description: 'Return the declared greeting.',
    expectedVersionId: workflow.versionId,
    expectedRevision: settings.exposure?.revision ?? null,
  });
  const body = await exposure.text();
  expect(exposure.status, body).toBe(200);
  expect(JSON.parse(body)).toMatchObject({
    exposure: { name, versionId: workflow.versionId },
  });
}
