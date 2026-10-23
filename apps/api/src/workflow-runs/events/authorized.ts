import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import type {
  WorkflowRunEventFrame,
  WorkflowRunEventStreamer,
  WorkflowRunPersistence,
} from '../ports.js';

import {
  createStreamAuthorizationLifetime,
  nextFrameOrAuthorizationLoss,
  type StreamAuthorizationLifetime,
} from './sse-authorization-lifetime.js';
import {
  NO_STREAM_FAILURE,
  preserveFailureDuringStreamCleanup,
  streamProducerFailureReason,
  type StreamFailure,
} from './stream-cleanup.js';

import type { StreamRunEventsInput } from '../access/contract.js';
import { WorkflowRunNotFoundError, authorize } from '../access/authorize.js';

/** Maximum time an open stream may rely on a previously verified access fact. */
const SSE_REAUTHORIZATION_INTERVAL_MS = 5_000;

export class StreamRunEventsUseCase {
  public constructor(
    private readonly persistence: Pick<
      WorkflowRunPersistence,
      'get' | 'canRead'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly streamer: WorkflowRunEventStreamer,
  ) {}

  public async execute(
    input: StreamRunEventsInput,
  ): Promise<AsyncIterable<WorkflowRunEventFrame>> {
    await authorize(input, 'run:read', this.authorization, [
      'active',
      'suspended',
      'pending_deletion',
    ]);
    const run = await this.persistence.get({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
      includeWorkflowName: false,
    });
    if (run === undefined) throw new WorkflowRunNotFoundError();
    return authorizedStreamFrames(this.streamer, input, {
      authorization: this.authorization,
      intervalMs: SSE_REAUTHORIZATION_INTERVAL_MS,
      canRead: (identity) => this.persistence.canRead(identity),
    });
  }
}

async function* authorizedStreamFrames(
  streamer: WorkflowRunEventStreamer,
  input: StreamRunEventsInput,
  {
    authorization,
    intervalMs,
    canRead,
  }: Readonly<{
    authorization: WorkspaceAuthorizationSource;
    intervalMs: number;
    canRead: WorkflowRunPersistence['canRead'];
  }>,
): AsyncGenerator<WorkflowRunEventFrame> {
  let iterator: AsyncIterator<WorkflowRunEventFrame> | undefined;
  let lifetimeController: AbortController | undefined;
  let authorizationLifetime: StreamAuthorizationLifetime | undefined;
  let primary: StreamFailure = NO_STREAM_FAILURE;
  try {
    lifetimeController = new AbortController();
    const lifetimeSignal = AbortSignal.any([
      input.signal,
      lifetimeController.signal,
    ]);
    const frames = streamer.stream({
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
      lastEventId: input.lastEventId,
      signal: lifetimeSignal,
      onProducerFailure: (error: unknown) => {
        input.abortStream(streamProducerFailureReason(error));
      },
    });
    iterator = frames[Symbol.asyncIterator]();
    authorizationLifetime = createStreamAuthorizationLifetime(
      {
        ...input,
        signal: lifetimeSignal,
        reauthorizeResource: async (signal) => {
          if (
            !(await canRead({
              actorId: input.actor.actorId,
              workspaceId: input.routeWorkspaceId,
              runId: input.runId,
              signal,
            }))
          )
            throw new WorkflowRunNotFoundError();
        },
      },
      authorization,
      intervalMs,
      lifetimeController,
    );
    while (!input.signal.aborted) {
      const outcome = await nextFrameOrAuthorizationLoss(
        iterator,
        authorizationLifetime.authorizationLost,
      );
      if (outcome.kind === 'authorization_lost') throw outcome.error;
      if (outcome.result.done) return;
      await authorizationLifetime.reauthorize();
      yield outcome.result.value;
    }
  } catch (error) {
    primary = { error, failed: true };
    throw error;
  } finally {
    // Authorization loss must cancel a pending producer read before awaiting
    // iterator cleanup. Otherwise an idle Redis/database read can keep the
    // authorization failure—and therefore the HTTP close—pending forever.
    await preserveFailureDuringStreamCleanup(primary, [
      () => {
        lifetimeController?.abort();
      },
      () => authorizationLifetime?.stop(),
      async () => {
        await iterator?.return?.();
      },
    ]);
  }
}
