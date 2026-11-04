import { expectTypeOf, it } from 'vitest';
import type { WorkflowRunDatabase } from '@pertexo/core/runs';
import type {
  WorkflowRunReadRecord,
  WorkflowRunReadModel,
  WorkflowRunListRecord,
} from '../../src/workflow-runs/ports.js';

type StoredRead = NonNullable<Awaited<ReturnType<WorkflowRunDatabase['get']>>>;
it('requires the real core lineage and failed-step fields at the API read port', () => {
  expectTypeOf<WorkflowRunReadRecord>().toEqualTypeOf<StoredRead['run']>();
  expectTypeOf<WorkflowRunReadModel>().toEqualTypeOf<StoredRead>();
  expectTypeOf<WorkflowRunListRecord>().toEqualTypeOf<
    Awaited<ReturnType<WorkflowRunDatabase['list']>>['items'][number]
  >();
});
