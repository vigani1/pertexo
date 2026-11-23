import { z, type ZodType } from 'zod';
import { inlineExecutorFailureSchema } from './node-failure.schemas.js';
import { ARTIFACT_INPUT_CAPABILITY } from '../artifacts/reference.js';
import {
  pinRegistrations,
  type PinnedNodeDefinition,
  type PinnedNodeExecutor,
} from './registry-pins.js';

import type {
  InlineNodeRequest,
  InlineNodeResult,
  NodeExecutionRequest,
  NodeExecutionResult,
  NodeExecutionRuntime,
  NodeRegistryOptions,
} from './node-execution.types.js';
import {
  DefinitionNotFoundError,
  ExecutorNotFoundError,
  InvalidBoundedJsonError,
  NodeConfigValidationError,
  NodeDispatchEvidenceError,
  NodeExecutionAbortedError,
  NodeExecutionRuntimeRequiredError,
  NodeInputValidationError,
  NodeOutputValidationError,
  NodeRegistryCompatibilityError,
  type NodeSdkError,
} from './node-execution.errors.js';
import {
  canonicalizeBoundedJson,
  isJsonObject,
} from '../values/bounded-json.js';

import {
  type DefinitionIdentity,
  definitionIdentitySchema,
  type ExecutorIdentity,
  executorIdentitySchema,
  type NodeManifest,
  TERMINATES_RUN_CAPABILITY,
} from '../definitions/catalog.js';
import { identityToken, sameIdentity } from '../definitions/identity.js';
import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from './executor-binding.js';

export interface InlineNodeRegistry {
  readonly canExecuteInline: (definition: DefinitionIdentity) => boolean;
  readonly executeInline: (request: InlineNodeRequest) => InlineNodeResult;
}

export interface NodeRegistry {
  readonly dispatchMode: (
    request: Pick<NodeExecutionRequest, 'definition' | 'executor'>,
  ) => 'before_execute' | 'executor_controlled';
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
}

// A step names at most this many connection slots.
const MAX_CONNECTION_REFERENCES = 16;
const connectionRefsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u), z.uuid())
  .refine((value) => Object.keys(value).length <= MAX_CONNECTION_REFERENCES)
  .transform((value) => Object.freeze({ ...value }));

function mapSchemaError(
  error: unknown,
  kind: 'config' | 'input' | 'output',
): NodeSdkError {
  if (kind === 'config') return new NodeConfigValidationError(error);
  if (kind === 'input') return new NodeInputValidationError(error);
  return new NodeOutputValidationError(error);
}

function parseExecutionValue(
  schema: ZodType,
  value: unknown,
  kind: 'config' | 'input' | 'output',
): unknown {
  try {
    return schema.parse(value);
  } catch (error) {
    throw mapSchemaError(error, kind);
  }
}

export function admitNodeExecutionInput(schema: ZodType, value: unknown) {
  return canonicalizeBoundedJson(
    parseExecutionValue(schema, canonicalizeBoundedJson(value), 'input'),
  );
}

function parseExecutionOutput(schema: ZodType, value: unknown) {
  try {
    return canonicalizeBoundedJson(
      schema.parse(canonicalizeBoundedJson(value)),
    );
  } catch (error) {
    throw mapSchemaError(error, 'output');
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new NodeExecutionAbortedError();
}

function assertDefinitionExecutorBinding(
  manifest: Pick<NodeManifest, 'definition' | 'executor'>,
  requestedExecutor: ExecutorIdentity,
): void {
  if (!sameIdentity(manifest.executor, requestedExecutor))
    throw new NodeRegistryCompatibilityError(
      `definition ${manifest.definition.key}@${String(manifest.definition.version)} is not bound to executor ${requestedExecutor.key}@${String(requestedExecutor.version)}`,
    );
}

export function createNodeRegistry(options: NodeRegistryOptions): NodeRegistry {
  const { dispatchMode, execute } = pinNodeRegistry(options);
  return Object.freeze({ dispatchMode, execute });
}

export function createInlineNodeRegistry(
  options: NodeRegistryOptions,
): InlineNodeRegistry {
  const { canExecuteInline, executeInline } = pinNodeRegistry(options);
  return Object.freeze({ canExecuteInline, executeInline });
}

function pinNodeRegistry(
  options: NodeRegistryOptions,
): NodeRegistry & InlineNodeRegistry {
  const { definitionMap, executorMap } = pinRegistrations(options);
  const resolveDefinition = (
    definition: DefinitionIdentity,
  ): PinnedNodeDefinition => {
    const parsed = definitionIdentitySchema.parse(definition);
    const resolved = definitionMap.get(identityToken(parsed));
    if (resolved === undefined) throw new DefinitionNotFoundError(parsed);
    return resolved;
  };
  const resolveExecutor = (executor: ExecutorIdentity): PinnedNodeExecutor => {
    const parsed = executorIdentitySchema.parse(executor);
    const pinned = executorMap.get(identityToken(parsed));
    if (pinned === undefined) throw new ExecutorNotFoundError(parsed);
    return pinned;
  };
  const dispatchMode = (
    request: Pick<NodeExecutionRequest, 'definition' | 'executor'>,
  ): 'before_execute' | 'executor_controlled' => {
    const executor = resolveExecutor(request.executor);
    const definition = resolveDefinition(request.definition);
    assertDefinitionExecutorBinding(definition.manifest, request.executor);
    return executor.manifest.abiVersion === DISPATCH_AWARE_EXECUTOR_ABI_VERSION
      ? 'executor_controlled'
      : 'before_execute';
  };
  const execute = async (
    request: NodeExecutionRequest,
  ): Promise<NodeExecutionResult> => {
    assertNotAborted(request.signal);
    const executor = resolveExecutor(request.executor);
    const definition = resolveDefinition(request.definition);
    assertDefinitionExecutorBinding(definition.manifest, request.executor);
    const { config, input, connectionRefs } = admitExecutionEnvelope(
      definition,
      request,
    );
    const dispatchAware =
      executor.manifest.abiVersion === DISPATCH_AWARE_EXECUTOR_ABI_VERSION;
    if (dispatchAware && request.runtime === undefined)
      throw new NodeExecutionRuntimeRequiredError();
    const dispatchState: {
      value: 'unused' | 'in_flight' | 'committed' | 'failed';
    } = { value: 'unused' };
    const runtime =
      request.runtime === undefined
        ? undefined
        : Object.freeze({
            ...request.runtime,
            ...(request.runtime.artifacts?.read === undefined ||
            definition.manifest.capabilities.includes(ARTIFACT_INPUT_CAPABILITY)
              ? {}
              : {
                  artifacts: Object.freeze({
                    write: request.runtime.artifacts.write.bind(
                      request.runtime.artifacts,
                    ),
                  }),
                }),
            beforeDispatch: async (
              input?: Parameters<NodeExecutionRuntime['beforeDispatch']>[0],
            ): Promise<void> => {
              if (dispatchState.value !== 'unused')
                throw new NodeDispatchEvidenceError('duplicate_dispatch');
              dispatchState.value = 'in_flight';
              try {
                await request.runtime?.beforeDispatch(input);
                dispatchState.value = 'committed';
              } catch (error) {
                dispatchState.value = 'failed';
                throw error;
              }
            },
          });
    const result = await executor.execute({
      config,
      input,
      connectionRefs,
      signal: request.signal,
      ...(runtime === undefined ? {} : { runtime }),
    });
    if (dispatchAware && dispatchState.value !== 'committed')
      throw new NodeDispatchEvidenceError('dispatch_evidence_missing');
    return {
      kind: definition.manifest.capabilities.includes(TERMINATES_RUN_CAPABILITY)
        ? 'terminal_success'
        : 'succeeded',
      output: parseExecutionOutput(definition.outputSchema, result),
    };
  };
  return Object.freeze({
    dispatchMode,
    execute,
    ...bindInlineExecution(options, definitionMap, resolveDefinition),
  });
}

function bindInlineExecution(
  options: NodeRegistryOptions,
  definitionMap: ReadonlyMap<string, PinnedNodeDefinition>,
  resolveDefinition: (identity: DefinitionIdentity) => PinnedNodeDefinition,
): InlineNodeRegistry {
  const inlineBindings = new Map(
    options.core?.executors.map(({ executor, executeInline }) => [
      identityToken(executor),
      executeInline,
    ]),
  );
  return Object.freeze({
    canExecuteInline: (identity: DefinitionIdentity) =>
      definitionMap.get(identityToken(identity))?.manifest.execution ===
      'inline',
    executeInline(request: InlineNodeRequest): InlineNodeResult {
      const definition = resolveDefinition(request.definition);
      assertDefinitionExecutorBinding(definition.manifest, request.executor);
      const kernel = inlineBindings.get(identityToken(request.executor));
      if (definition.manifest.execution !== 'inline' || kernel === undefined)
        throw new NodeRegistryCompatibilityError(
          'definition has no inline executor',
        );
      const { config, input } = admitExecutionEnvelope(definition, request);
      const invocation = Object.freeze({
        config: canonicalizeBoundedJson(config),
        input: canonicalizeBoundedJson(input),
        now: request.now,
      });
      const result = kernel(invocation);
      if (result.kind === 'succeeded')
        return {
          kind: 'succeeded',
          output: parseExecutionOutput(definition.outputSchema, result.output),
        };
      const failure = inlineExecutorFailureSchema.parse(result.failure);
      return { kind: 'failed', failure };
    },
  });
}

function admitExecutionEnvelope(
  definition: PinnedNodeDefinition,
  request: Pick<
    NodeExecutionRequest,
    'config' | 'input' | 'connectionRefs' | 'inputAdmission'
  >,
) {
  const bounded = canonicalizeBoundedJson({
    config: request.config,
    input: request.input,
    connectionRefs: request.connectionRefs ?? {},
  });
  if (!isJsonObject(bounded))
    throw new InvalidBoundedJsonError('execution envelope is not an object');
  const config = parseExecutionValue(
    definition.configSchema,
    bounded.config,
    'config',
  );
  const input =
    request.inputAdmission === 'persisted_agent'
      ? bounded.input
      : parseExecutionValue(definition.inputSchema, bounded.input, 'input');
  let connectionRefs: Readonly<Record<string, string>>;
  try {
    connectionRefs = connectionRefsSchema.parse(bounded.connectionRefs);
  } catch (error) {
    throw mapSchemaError(error, 'config');
  }
  return { config, input, connectionRefs };
}
