import { isDeepStrictEqual } from 'node:util';
import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';
import { workflowControlOutputKind } from '@pertexo/workflow-model/graph';
import { WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1 } from '@pertexo/workflow-model/observation-window';
import { callableValueWorkStopSchema } from '@pertexo/workflow-model/workflow-call-contract';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import { ownCompletedFields } from '../completed-output-fields.js';
import {
  normalizeBoundedEngineJson,
  type WorkflowExecutableNodeV2,
} from '../executable-workflow.js';
import { exactKeys, operationError, record } from '../operation-values.js';
import type { parseCheckpoint } from '../checkpoint/checkpoint.js';
import type { WorkflowObservation } from '../types.js';
import type { LoadCoordinatorControlDeclaration } from './control-declaration-demand.js';
import { CallableCompletionStoppedError } from './workflow-call-demand.js';
import { branchSelectionObservations } from './coordinator-observations.js';
import { forEachCoordinatorObservations } from './coordinator-loop-observations.js';
import {
  completedOutputReference,
  parseCompletedOutputItemsV3,
} from './coordinator-output.js';

function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new CallableCompletionStoppedError({ kind: 'context_aborted' });
}

function required(
  value: Readonly<Record<string, JsonValue>>,
  key: string,
): JsonValue {
  const field = value[key];
  if (field === undefined)
    operationError('observation_invalid', 'control metadata is missing');
  return field;
}

function factIdentity(outcome: Readonly<Record<string, JsonValue>>) {
  if (
    typeof outcome.sequence !== 'number' ||
    !Number.isSafeInteger(outcome.sequence) ||
    outcome.sequence < 1 ||
    typeof outcome.attemptId !== 'string' ||
    typeof outcome.invocationKey !== 'string'
  )
    operationError('observation_invalid', 'control fact identity is invalid');
  return {
    sequence: outcome.sequence,
    attemptId: outcome.attemptId,
    invocationKey: outcome.invocationKey,
  };
}

/** Closed identity is original-byte metadata, never a re-encoded semantic digest. */
function originalIdentity(
  value: JsonValue,
  output: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const identity = record(value, 'observation_invalid', 'original identity');
  exactKeys(identity, ['reference', 'sha256', 'byteLength']);
  const reference = record(
    required(identity, 'reference'),
    'observation_invalid',
    'reference',
  );
  const physical = record(output, 'observation_invalid', 'physical output');
  exactKeys(
    reference,
    reference.kind === 'artifact'
      ? ['schemaVersion', 'kind', 'artifactId']
      : ['schemaVersion', 'kind'],
  );
  if (
    reference.schemaVersion !== 1 ||
    reference.kind !== physical.kind ||
    (reference.kind !== 'inline' && reference.kind !== 'artifact') ||
    (reference.kind === 'artifact' &&
      reference.artifactId !== physical.artifactId) ||
    typeof identity.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(identity.sha256) ||
    typeof identity.byteLength !== 'number' ||
    !Number.isSafeInteger(identity.byteLength) ||
    identity.byteLength < 1 ||
    identity.byteLength > NODE_JSON_LIMITS_V1.bytes
  )
    operationError(
      'observation_invalid',
      'control original identity is invalid',
    );
  return identity;
}

async function readDeclaration(
  load: LoadCoordinatorControlDeclaration,
  identity: Parameters<LoadCoordinatorControlDeclaration>[0],
  outcome: Readonly<Record<string, JsonValue>>,
  signal: AbortSignal,
) {
  assertActive(signal);
  const reply = ownCompletedFields(
    await load(structuredClone(identity), signal),
    'observation_invalid',
  );
  assertActive(signal);
  if (
    reply.kind === 'stopped' &&
    Object.keys(reply).length === 2 &&
    Object.hasOwn(reply, 'stop')
  ) {
    const stop = callableValueWorkStopSchema.safeParse(
      normalizeBoundedEngineJson(reply.stop),
    );
    if (!stop.success)
      operationError('observation_invalid', 'control stop is invalid');
    throw new CallableCompletionStoppedError(stop.data);
  }
  if (
    reply.kind !== 'ready' ||
    Object.keys(reply).length !== 2 ||
    !Object.hasOwn(reply, 'material')
  )
    operationError(
      'observation_invalid',
      'control material envelope is invalid',
    );
  const fields = ownCompletedFields(reply.material, 'observation_invalid');
  if (
    Object.keys(fields).length !== 6 ||
    ![
      'sequence',
      'attemptId',
      'invocationKey',
      'output',
      'valueIdentity',
      'value',
    ].every((key) => Object.hasOwn(fields, key))
  )
    operationError(
      'observation_invalid',
      'control material fields are invalid',
    );
  const { value, ...metadataFields } = fields;
  const metadata = record(
    normalizeBoundedEngineJson(metadataFields),
    'observation_invalid',
    'control metadata',
  );
  if (
    metadata.sequence !== identity.sequence ||
    metadata.attemptId !== identity.attemptId ||
    metadata.invocationKey !== identity.invocationKey ||
    !isDeepStrictEqual(metadata.output, outcome.output)
  )
    operationError(
      'observation_invalid',
      'control physical fact identity differs',
    );
  const valueIdentity = originalIdentity(
    required(metadata, 'valueIdentity'),
    required(metadata, 'output'),
  );
  const items = parseCompletedOutputItemsV3([{ ...identity, value }]);
  return {
    items,
    original: {
      ...identity,
      output: required(metadata, 'output'),
      valueIdentity,
    },
  };
}

/** Engine-owned serial preparation. Only small private observations survive a read. */
export async function prepareNativeControlObservations(
  input: Readonly<{
    load: LoadCoordinatorControlDeclaration | undefined;
    signal: AbortSignal;
    outcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>;
    checkpoint: ReturnType<typeof parseCheckpoint>;
    invocations: ReadonlyMap<
      string,
      ReturnType<typeof parseCheckpoint>['invocations'][number]
    >;
    nodes: ReadonlyMap<string, WorkflowExecutableNodeV2>;
    controlCanceled: boolean;
    controlDeadline: boolean;
  }>,
) {
  const selected = [...input.outcomes.entries()]
    .filter(([, outcome]) => {
      const invocation = input.invocations.get(
        factIdentity(outcome).invocationKey,
      );
      const node = input.nodes.get(invocation?.nodeId ?? '');
      return workflowControlOutputKind(node?.definition) !== undefined;
    })
    .sort(
      ([, left], [, right]) => Number(left.sequence) - Number(right.sequence),
    );
  if (selected.length > WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.facts)
    operationError(
      'observation_invalid',
      'control facts exceed the existing bound',
    );
  const identities = selected.map(([, outcome]) => factIdentity(outcome));
  normalizeBoundedEngineJson(identities);
  const branches: WorkflowObservation[] = [];
  const loops: WorkflowObservation[] = [];
  const originals: JsonValue[] = [];
  const declarations = new Set<string>();
  const attempts = new Set<string>();
  const invocations = new Set<string>();
  let sequence = 0;
  for (const [index, [key, outcome]] of selected.entries()) {
    const identity = identities[index];
    if (identity === undefined)
      operationError('observation_invalid', 'control fact identity is missing');
    if (
      identity.sequence <= sequence ||
      attempts.has(identity.attemptId) ||
      invocations.has(identity.invocationKey)
    )
      operationError('observation_invalid', 'control facts conflict');
    sequence = identity.sequence;
    attempts.add(identity.attemptId);
    invocations.add(identity.invocationKey);
    if (input.controlCanceled || input.controlDeadline) {
      const invocation = input.invocations.get(identity.invocationKey);
      const node = input.nodes.get(invocation?.nodeId ?? '');
      if (workflowControlOutputKind(node?.definition) === 'for_each') {
        if (
          invocation?.status !== 'running' ||
          input.checkpoint.loops.some(
            ({ controlInvocationKey }) =>
              controlInvocationKey === identity.invocationKey,
          )
        )
          operationError(
            'observation_invalid',
            'control declaration is not fresh',
          );
        const output = completedOutputReference(outcome, identity.attemptId);
        if (output === undefined)
          operationError('observation_invalid', 'control output is missing');
        declarations.add(identity.invocationKey);
        loops.push({
          kind: 'outcome',
          invocationKey: identity.invocationKey,
          status: input.controlCanceled ? 'canceled' : 'timed_out',
          output,
          coordinatorDerived: true,
        });
      }
      continue;
    }
    if (input.load === undefined)
      operationError(
        'observation_invalid',
        'control material loader is missing',
      );
    const material = await readDeclaration(
      input.load,
      identity,
      outcome,
      input.signal,
    );
    const oneOutcome = new Map([[key, outcome]]);
    branches.push(
      ...branchSelectionObservations(
        material.items,
        oneOutcome,
        input.invocations,
        input.nodes,
      ),
    );
    const forEach = forEachCoordinatorObservations(
      material.items,
      [],
      oneOutcome,
      { ...input.checkpoint, loops: [] },
      input.invocations,
      input.nodes,
    );
    loops.push(...forEach.observations);
    for (const invocationKey of forEach.declarationInvocationKeys) {
      if (declarations.has(invocationKey))
        operationError('observation_invalid', 'control declaration conflicts');
      declarations.add(invocationKey);
    }
    originals.push(material.original);
    normalizeBoundedEngineJson({ branches, loops, originals });
    assertActive(input.signal);
  }
  return { branches, loops, declarations };
}
