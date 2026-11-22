import { useState } from 'react';
import {
  MCP_STATUS_TOOL_NAME,
  mcpToolNameSchema,
  type WorkflowMcpSettings,
} from '@pertexo/contracts';
import { useMcpExposureCommand } from '../data/mcp-exposure.mutations';

type Scope = Parameters<typeof useMcpExposureCommand>[0];
type Draft = Readonly<{
  name: string;
  description: string;
  expectedVersionId: string | null;
  expectedRevision: string | null;
}>;

export function useMcpExposureDraft(
  scope: Scope,
  settings: WorkflowMcpSettings,
) {
  const { exposure, publishedVersionId } = settings;
  const [draft, setDraft] = useState<Draft>();
  const command = useMcpExposureCommand(scope);
  const expected = {
    expectedVersionId: publishedVersionId,
    expectedRevision: exposure?.revision ?? null,
  };
  const current = draft ?? {
    ...expected,
    name: exposure?.name ?? '',
    description: exposure?.description ?? '',
  };
  const reviewRequired =
    current.expectedVersionId !== expected.expectedVersionId ||
    current.expectedRevision !== expected.expectedRevision;
  const exposed =
    exposure !== null && exposure.versionId === publishedVersionId;
  const { name, description } = current;
  const changed =
    !exposed || name !== exposure.name || description !== exposure.description;
  const canExpose =
    settings.eligible &&
    changed &&
    !reviewRequired &&
    !command.pending &&
    name !== MCP_STATUS_TOOL_NAME &&
    mcpToolNameSchema.safeParse(name).success &&
    description.trim() !== '';

  return {
    name,
    description,
    reviewRequired,
    exposed,
    canExpose,
    pending: command.pending,
    failure: command.failure,
    reviewCurrentVersion() {
      setDraft({ ...current, ...expected });
    },
    setName(name: string) {
      setDraft({ ...current, name });
    },
    setDescription(description: string) {
      setDraft({ ...current, description });
    },
    async expose() {
      if (canExpose && (await command.send({ ...current, kind: 'expose' })))
        setDraft(undefined);
    },
    async revoke() {
      if (
        !command.pending &&
        (await command.send({ ...expected, kind: 'unexpose' }))
      )
        setDraft(undefined);
    },
  };
}
