import type {
  CoordinatorAdvanceDelivery,
  CoordinatorRunStore,
} from '@pertexo/database/execution';
import { parseCheckpoint } from '@pertexo/workflow-engine';
import type { CoordinatorAdvanceEngine } from './coordinator-handler.js';
import {
  createCoordinatorValueWorkLifetime,
  type CoordinatorValueWorkPolicy,
} from './coordinator-value-work-lifetime.js';
import { loadSelectedCoordinatorMaterial } from './coordinator-selected-material.js';
import type { createWorkflowExecutionValueCodec } from './workflow-execution-value-codec.js';
import {
  hydrateCoordinatorCallDeclarations,
  type createCoordinatorCallDeclarationHydration,
} from './coordinator-call-declaration-hydration.js';
import type { createCoordinatorControlSourceHydration } from './coordinator-control-source-hydration.js';
import { createCoordinatorControlDeclarationLoader } from './coordinator-control-demand.js';

export type CoordinatorNativeValueWork = Readonly<{
  policy: CoordinatorValueWorkPolicy;
  hydrateCallDeclaration?: ReturnType<
    typeof createCoordinatorCallDeclarationHydration
  >;
  hydrateSource?: ReturnType<
    typeof createWorkflowExecutionValueCodec
  >['hydrateSource'];
  hydrateControlSource?: ReturnType<
    typeof createCoordinatorControlSourceHydration
  >;
}>;

/** One lazy demand scope remains owned until engine evaluation has joined. */
export async function advanceNativeCoordinator(
  input: Readonly<{
    engine: CoordinatorAdvanceEngine;
    advance: Parameters<CoordinatorAdvanceEngine['advance']>[0];
    workspaceId: string;
    delivery: CoordinatorAdvanceDelivery;
    runStore: CoordinatorRunStore;
    valueWork: CoordinatorNativeValueWork;
  }>,
): ReturnType<CoordinatorAdvanceEngine['advance']> {
  const owner = Object.freeze({
    workspaceId: input.workspaceId,
    runId: input.advance.runId,
    workflowVersionId: input.advance.workflowVersionId,
    delivery: Object.freeze({ ...input.delivery }),
    expectedRevision: parseCheckpoint(input.advance.checkpoint).revision,
  });
  const valueWork = Object.freeze({
    ...input.valueWork,
    policy: Object.freeze({ ...input.valueWork.policy }),
  });
  const inspectOwner = input.runStore.inspectCoordinatorValueReadOwner;
  const lifetime = createCoordinatorValueWorkLifetime({
    policy: valueWork.policy,
    ...(inspectOwner === undefined
      ? {}
      : {
          inspectOwner: (request) => inspectOwner.call(input.runStore, request),
        }),
  });
  const outcome = await lifetime.withValueWork(
    owner,
    input.advance.signal,
    async (session) => {
      const demandState = { started: false };
      let workflowCalls = input.advance.workflowCalls;
      if (
        workflowCalls?.declarations.some(
          ({ artifactSource }) => artifactSource !== undefined,
        )
      ) {
        demandState.started = true;
        workflowCalls = await hydrateCoordinatorCallDeclarations(
          workflowCalls,
          owner,
          session,
          valueWork.hydrateCallDeclaration,
        );
      }
      const loadControl = createCoordinatorControlDeclarationLoader({
        owner,
        window: input.advance.controlDeclarations,
        session,
        runStore: input.runStore,
        readTimeoutMillis: valueWork.policy.controlReadTimeoutMillis,
        hydrate: valueWork.hydrateControlSource,
      });
      const advanced = await input.engine.advance({
        ...input.advance,
        ...(workflowCalls === undefined ? {} : { workflowCalls }),
        signal: session.signal,
        loadCoordinatorControlDeclaration: (identity, signal) => {
          demandState.started = true;
          return loadControl(identity, signal);
        },
        loadCallableCompletion: (demand, signal) => {
          demandState.started = true;
          if (
            demand.expectedRevision !== owner.expectedRevision ||
            signal !== session.signal ||
            demand.sources.length > 1_000
          )
            throw new TypeError('Coordinator demand revision does not agree');
          return loadSelectedCoordinatorMaterial({
            owner,
            demand: structuredClone(demand),
            session,
            runStore: input.runStore,
            valueWork,
          });
        },
      });
      if (demandState.started) await session.perform(() => Promise.resolve());
      return advanced;
    },
  );
  return outcome.kind === 'stopped'
    ? { kind: 'value_work_stopped', stop: outcome.stop }
    : outcome.value;
}
