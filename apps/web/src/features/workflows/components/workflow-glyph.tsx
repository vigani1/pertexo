import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { workflowShapeQueryOptions } from '../workflows.queries';
import { PatternGlyph, PatternGlyphPlaceholder } from './pattern-glyph';

/**
 * A workflow's pattern glyph drawn from its draft's shape, the same cached
 * read the Workflows list uses. Unpublished drafts are drawn muted.
 */
export function WorkflowGlyph({
  apiClient,
  userId,
  workspaceId,
  workflow,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflow: Pick<WorkflowSummary, 'id' | 'publishedVersionId'>;
}>) {
  const shape = useQuery(
    workflowShapeQueryOptions(apiClient, userId, workspaceId, workflow.id),
  );
  if (shape.data === undefined)
    return (
      <PatternGlyphPlaceholder
        state={shape.isError ? 'unavailable' : 'loading'}
      />
    );
  return (
    <PatternGlyph
      graph={shape.data}
      muted={workflow.publishedVersionId === null}
    />
  );
}
