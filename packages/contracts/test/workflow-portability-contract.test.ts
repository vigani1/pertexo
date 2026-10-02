import { describe, expect, it } from 'vitest';
import {
  workflowPortabilityClientContract,
  workflowPortabilityOpenApiDocument,
} from '../src/workflow-portability.js';

describe('portable workflow public HTTP contract', () => {
  it('owns authenticated CSRF export and preview plus an idempotent creation command', () => {
    const paths = workflowPortabilityOpenApiDocument.paths;
    for (const path of Object.values(paths)) {
      expect(path.post.security).toEqual([{ cookieSession: [] }]);
      expect(path.post.parameters).toContainEqual(
        expect.objectContaining({ name: 'x-csrf-token', in: 'header' }),
      );
    }
    const create = paths['/v1/workspaces/{workspaceId}/workflows/import'].post;
    expect(create.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', required: true }),
    );
    expect(create.responses['201'].headers).toHaveProperty('Location');
    expect(create.responses['201'].headers['Cache-Control'].schema.const).toBe(
      'private, no-store',
    );
    const exported =
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/export'].post;
    expect(
      exported.responses['200'].headers['Content-Disposition'].schema.const,
    ).toBe('attachment; filename="workflow.pertexo.json"');
    expect(exported.parameters).toContainEqual(
      expect.objectContaining({ name: 'If-Match', required: false }),
    );
    expect(workflowPortabilityClientContract.schemas).toHaveProperty(
      'WorkflowPortableManifest',
    );
  });
});
