import type {
  nodeTestExecuteAcceptedResponseSchema,
  nodeValidationResponseSchema,
  previewRunResponseSchema,
} from '@pertexo/contracts/node-testing';
import type {
  workflowValidateResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts/workflow-authoring';
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
import type {
  AuthenticatedRequestSession,
  IdentityWorkspaceRequest,
} from '../src/identity-workspace/types.js';
import type { WorkflowAuthoringRequest } from '../src/workflow-authoring/types.js';
import type { WorkflowRunsRequest } from '../src/workflow-runs/controllers.js';

describe('validated response contract types', () => {
  it('keeps authenticated request fields owned by the identity request contract', () => {
    expectTypeOf<WorkflowAuthoringRequest>().toEqualTypeOf<
      Readonly<
        Pick<
          IdentityWorkspaceRequest,
          | 'authorizedWorkspace'
          | 'cookies'
          | 'headers'
          | 'identitySession'
          | 'method'
          | 'params'
          | 'query'
          | 'requestId'
          | 'traceId'
        >
      >
    >();
    expectTypeOf<WorkflowRunsRequest>().toEqualTypeOf<
      Readonly<
        Pick<
          IdentityWorkspaceRequest,
          | 'authorizedWorkspace'
          | 'cookies'
          | 'headers'
          | 'identitySession'
          | 'method'
          | 'reauthorizeIdentitySession'
          | 'requestId'
          | 'traceId'
        > & {
          raw?: Readonly<{
            once(event: 'close', listener: () => void): unknown;
            off(event: 'close', listener: () => void): unknown;
          }>;
        }
      >
    >();
    expectTypeOf<
      NonNullable<WorkflowRunsRequest['identitySession']>
    >().toEqualTypeOf<AuthenticatedRequestSession>();
  });
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
