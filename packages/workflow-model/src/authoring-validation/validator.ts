import {
  BoundedAuthoringJobOwner,
  type JobAdapter,
  type Limits,
  type AuthoringWorkerReply,
} from './bounded-job-owner.js';
export type { AuthoringWorkerReply } from './bounded-job-owner.js';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { z } from 'zod';
import { canonicalizeJson } from '../canonical-json.js';
import { parseWorkflowGraphDraft } from '../graph/preflight.js';
import type { GraphValidationResult } from '../graph/validation-contract.js';
import {
  AuthoringValidationUnavailableError,
  policyProjectionSchema,
  validationReportSchema,
  type WorkflowExpressionPolicyProjection,
} from './contracts.js';
import { assertReportBudget } from './validation.js';

const runtimeUrl = new URL(
  import.meta.url.endsWith('.ts')
    ? '../../dist/authoring-validation-worker-runtime.js'
    : '../authoring-validation-worker-runtime.js',
  import.meta.url,
);
const replySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }).strict(),
  z
    .object({ kind: z.literal('started'), id: z.number().int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal('result'),
      id: z.number().int().positive(),
      report: validationReportSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      id: z.number().int().positive(),
      reason: z.enum(['report_limit', 'worker_failed']),
    })
    .strict(),
]);

/** Trusted construction dependency, never supplied by a job caller. */
export interface CallableTargetWorkerAdapter {
  readonly purpose: 'callable-target-assessment-v1';
  spawn(resourceLimits: NonNullable<WorkerOptions['resourceLimits']>): Worker;
  prepare(snapshot: unknown): Readonly<{ payload: unknown; bytes: number }>;
  decodeReply(input: unknown): AuthoringWorkerReply;
  validateResult(report: unknown, prepared: unknown): unknown;
}
export interface CallableTargetJobSlot {
  assess(
    snapshot: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
}
type ValidatorOptions = Partial<Limits> &
  Readonly<{
    workerFactory?: (url: URL, options: WorkerOptions) => Worker;
  }>;

function structuralFacade(
  owner: BoundedAuthoringJobOwner,
  options: ValidatorOptions,
) {
  const workerFactory =
    options.workerFactory ??
    ((url: URL, workerOptions: WorkerOptions) =>
      new Worker(url, workerOptions));
  const adapter: JobAdapter = {
    retainPrepared: false,
    spawn: (resourceLimits) => workerFactory(runtimeUrl, { resourceLimits }),
    decodeReply: (input) => replySchema.parse(input),
    validateResult: (report) => {
      const parsed = validationReportSchema.parse(report);
      assertReportBudget(parsed);
      return parsed;
    },
  };
  return {
    async validate(
      graphInput: unknown,
      policyInput: WorkflowExpressionPolicyProjection,
      validateOptions: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<GraphValidationResult> {
      const submittedAt = performance.now();
      owner.assertOpen(validateOptions.signal);
      const graph = parseWorkflowGraphDraft(graphInput);
      let policies: WorkflowExpressionPolicyProjection;
      try {
        policies = policyProjectionSchema.parse(canonicalizeJson(policyInput));
        const definitions = new Set<string>();
        for (const { definition } of policies.definitions) {
          const identity = `${definition.key}\u0000${String(definition.version)}`;
          if (definitions.has(identity))
            throw new Error('Duplicate policy definition');
          definitions.add(identity);
        }
      } catch {
        throw new AuthoringValidationUnavailableError(
          'invalid_policy_projection',
        );
      }
      const payload = { graph, policies };
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      return validationReportSchema.parse(
        await owner.submit(
          payload,
          bytes,
          adapter,
          submittedAt,
          validateOptions,
        ),
      );
    },
  };
}

/** Source-compatible standalone structural validator with its own cleanup owner. */
export class WorkflowAuthoringValidator {
  readonly #owner: BoundedAuthoringJobOwner;
  readonly #facade: ReturnType<typeof structuralFacade>;
  constructor(options: ValidatorOptions = {}) {
    this.#owner = new BoundedAuthoringJobOwner(options);
    this.#facade = structuralFacade(this.#owner, options);
  }
  validate(
    graph: unknown,
    policies: WorkflowExpressionPolicyProjection,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<GraphValidationResult> {
    return this.#facade.validate(graph, policies, options);
  }
  diagnostics() {
    return this.#owner.diagnostics();
  }
  shutdown(): Promise<void> {
    return this.#owner.shutdown();
  }
}

/** Two fixed job slots share one FIFO admission and termination owner. */
export function createAuthoringJobRuntime(
  options: ValidatorOptions &
    Readonly<{ callableTargetAdapter?: CallableTargetWorkerAdapter }> = {},
) {
  if (options.callableTargetAdapter !== undefined)
    z.literal('callable-target-assessment-v1').parse(
      options.callableTargetAdapter.purpose,
    );
  const owner = new BoundedAuthoringJobOwner(options);
  const adapter = options.callableTargetAdapter;
  const callableTargets: CallableTargetJobSlot | undefined =
    adapter === undefined
      ? undefined
      : {
          async assess(snapshot, assessOptions = {}) {
            try {
              const submittedAt = performance.now();
              owner.assertOpen(assessOptions.signal);
              const prepared = adapter.prepare(snapshot);
              return await owner.submit(
                prepared.payload,
                prepared.bytes,
                adapter,
                submittedAt,
                assessOptions,
              );
            } catch (error: unknown) {
              if (
                error instanceof AuthoringValidationUnavailableError &&
                error.reason === 'canceled' &&
                assessOptions.signal?.aborted
              )
                throw assessOptions.signal.reason;
              throw error;
            }
          },
        };
  return {
    validator: structuralFacade(owner, options),
    callableTargets,
    diagnostics: () => owner.diagnostics(),
    shutdown: () => owner.shutdown(),
  };
}
