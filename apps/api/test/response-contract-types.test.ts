import type {
  nodeTestExecuteAcceptedResponseSchema,
  nodeValidationResponseSchema,
  previewRunResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts';
import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type {
  ListWorkflowVersionsUseCase,
  ValidateWorkflowDraftUseCase,
} from '../src/workflow-authoring/use-cases.js';
import type {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../src/node-testing/use-case.js';

describe('validated response contract types', () => {
  it('preserves exact workflow response outputs', () => {
    expectTypeOf<
      ReturnType<ValidateWorkflowDraftUseCase['execute']>
    >().toEqualTypeOf<
      Promise<z.output<typeof workflowValidateResponseSchema>>
    >();
    expectTypeOf<
      ReturnType<ListWorkflowVersionsUseCase['execute']>
    >().toEqualTypeOf<
      Promise<z.output<typeof workflowVersionsResponseSchema>>
    >();
  });

  it('preserves the node-test response union and preview output', () => {
    expectTypeOf<
      ReturnType<TestWorkflowNodeUseCase['execute']>
    >().toEqualTypeOf<
      Promise<
        | z.output<typeof nodeValidationResponseSchema>
        | z.output<typeof nodeTestExecuteAcceptedResponseSchema>
      >
    >();
    expectTypeOf<ReturnType<GetPreviewRunUseCase['execute']>>().toEqualTypeOf<
      Promise<z.output<typeof previewRunResponseSchema>>
    >();
  });
});
