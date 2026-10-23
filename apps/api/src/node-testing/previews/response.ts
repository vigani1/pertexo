import {
  nodeTestExecuteAcceptedResponseSchema,
  type NodeTestExecuteAcceptedResponse,
} from '@pertexo/contracts';

import type { NodeTestingPersistence } from '../ports.js';

type PreviewOutput = NonNullable<
  Awaited<ReturnType<NodeTestingPersistence['readPreview']>>
>['output'];

export type PreviewRunRecord = NonNullable<
  Awaited<ReturnType<NodeTestingPersistence['resolvePreviewReplay']>>
>;

type PreviewAcceptanceView = Pick<
  PreviewRunRecord,
  | 'id'
  | 'workspaceId'
  | 'workflowId'
  | 'draftRevision'
  | 'nodeId'
  | 'status'
  | 'sideEffectClass'
  | 'mayContactProvider'
  | 'mayCauseExternalSideEffect'
  | 'dryRun'
  | 'createdAt'
  | 'expiresAt'
  | 'pinnedSampleId'
  | 'output'
  | 'completedAt'
  | 'codeDiagnostics'
>;

type PreviewOutputView =
  | null
  | Readonly<{
      kind: 'inline';
      value: Extract<PreviewOutput, Readonly<{ kind: 'inline' }>>['value'];
    }>
  | Readonly<{
      kind: 'artifact';
      artifactId: Extract<
        PreviewOutput,
        Readonly<{ kind: 'artifact' }>
      >['artifactId'];
    }>;

export function previewOutputResponse(
  output: PreviewOutput,
): PreviewOutputView {
  if (output === null) return null;
  if (output.kind === 'inline')
    return { kind: 'inline' as const, value: output.value };
  return { kind: 'artifact' as const, artifactId: output.artifactId };
}

export function previewAcceptanceResponse(
  preview: PreviewAcceptanceView,
  { replayed }: Readonly<{ replayed: boolean }>,
): NodeTestExecuteAcceptedResponse {
  return nodeTestExecuteAcceptedResponseSchema.parse({
    mode: 'test_execute',
    replayed,
    preview: {
      id: preview.id,
      workspaceId: preview.workspaceId,
      workflowId: preview.workflowId,
      draftRevision: preview.draftRevision,
      nodeId: preview.nodeId,
      status: preview.status,
      disclosure: {
        sideEffectClass: preview.sideEffectClass,
        mayContactProvider: preview.mayContactProvider,
        mayCauseExternalSideEffect: preview.mayCauseExternalSideEffect,
        dryRun: preview.dryRun,
      },
      output:
        preview.output === undefined || preview.output === null
          ? null
          : previewOutputResponse(preview.output),
      ...(preview.codeDiagnostics === undefined
        ? {}
        : { codeDiagnostics: preview.codeDiagnostics }),
      ...(preview.pinnedSampleId == null
        ? {}
        : { pinnedSampleId: preview.pinnedSampleId }),
      safeErrorCode: null,
      createdAt: preview.createdAt.toISOString(),
      startedAt: null,
      completedAt: preview.completedAt?.toISOString() ?? null,
      expiresAt: preview.expiresAt.toISOString(),
    },
  });
}
