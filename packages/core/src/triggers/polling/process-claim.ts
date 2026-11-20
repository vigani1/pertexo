import {
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import { HTTP_POLL_CONFIG_SCHEMA } from '@pertexo/workflow-model';
import { lockWorkspaceRunAdmission } from '../../shared/access/workspace-fence.repository.js';
import {
  commandKeyHash,
  commandRequestHash,
} from '../../shared/command-fingerprints.js';
import { decodeStoredValue } from '../../shared/stored-values.js';
import type { PollRunInput } from '../../shared/run-records/poll-run-input.js';
import { acceptWorkflowRun } from '../../runs/commands/acceptance/accept.js';
import { readWorkflowRunAcceptanceReplay } from '../../runs/commands/acceptance/read-replay.js';
import {
  WorkflowAlreadyRunningError,
  WorkspaceRunQuotaExceededError,
} from '../../runs/commands/acceptance/run-admission.errors.js';
import { releaseClaims } from '../schedules/retire.js';
import { admissionRetrySeconds } from '../schedules/retirement-plan.js';
import type {
  PollClaim,
  ScannerResources,
  ScanDueInput,
} from '../schedules/scanning/schedule-scanning.types.js';
import {
  POLL_MAX_ITEMS,
  POLL_MAX_PAGES,
  POLL_MAX_SEEN_KEYS,
  newPollItems,
  type FetchPoll,
} from './items.js';
import { PollClaimLostError } from './poll.errors.js';
import {
  completePoll,
  lockPollPublication,
  readPollObservation,
  recordPollKeys,
} from './progress.repository.js';

const SECONDS_PER_MINUTE = 60;

export async function processPollClaim(
  resources: ScannerResources,
  claim: PollClaim,
  input: ScanDueInput,
  fetchPoll: FetchPoll,
): Promise<'accepted' | 'deferred' | 'skipped'> {
  const inWorkspace = <T>(
    operation: (transaction: WorkspaceTransaction) => Promise<T>,
  ) =>
    withWorkspaceTransaction(
      resources.acceptancePool,
      claim.workspace_id,
      operation,
      input.signal === undefined ? {} : { signal: input.signal },
    );

  try {
    const observation = await inWorkspace((transaction) =>
      readPollObservation(transaction, claim),
    );
    if (observation === undefined) throw new PollClaimLostError();
    const config = decodeStoredValue(() =>
      HTTP_POLL_CONFIG_SCHEMA.parse(observation.config),
    );
    const seenKeys =
      observation.seenKeys?.map((key) => key.toString('hex')) ?? [];
    const leaseSignal = AbortSignal.timeout(
      Math.max(
        0,
        claim.lease_expires_at.getTime() - observation.observedAt.getTime(),
      ),
    );
    const signal =
      input.signal === undefined
        ? leaseSignal
        : AbortSignal.any([leaseSignal, input.signal]);
    const fetched = await fetchPoll({
      workspaceId: claim.workspace_id,
      triggerId: claim.trigger_id,
      config,
      seenKeys,
      maxItems: POLL_MAX_ITEMS,
      maxPages: POLL_MAX_PAGES,
      signal,
    }).catch((error: unknown) => {
      input.signal?.throwIfAborted();
      if (leaseSignal.aborted) throw new PollClaimLostError();
      throw error;
    });
    input.signal?.throwIfAborted();
    if (leaseSignal.aborted) throw new PollClaimLostError();
    const candidates = newPollItems(fetched, seenKeys);
    const withLivePoll = <T>(
      operation: (
        transaction: WorkspaceTransaction,
        current: NonNullable<Awaited<ReturnType<typeof lockPollPublication>>>,
      ) => Promise<T>,
    ) =>
      inWorkspace(async (transaction) => {
        if (
          (await lockWorkspaceRunAdmission(
            transaction.db,
            claim.workspace_id,
          )) !== 'active'
        )
          throw new PollClaimLostError();
        const current = await lockPollPublication(
          transaction,
          claim,
          observation.pauseRevision,
        );
        if (current === undefined) throw new PollClaimLostError();
        return operation(transaction, current);
      });

    const intervalSeconds = config.intervalMinutes * SECONDS_PER_MINUTE;
    if (observation.seenKeys === null) {
      await withLivePoll(async (transaction) => {
        await storeKeys(
          transaction,
          claim,
          candidates.map(({ hash }) => Buffer.from(hash, 'hex')),
        );
        await finishPoll(transaction, claim, intervalSeconds, true);
      });
      return 'skipped';
    }

    try {
      for (const candidate of candidates) {
        await withLivePoll(
          async (transaction, { published, seenKeys: recorded }) => {
            await admitPollItem(
              transaction,
              { triggerId: claim.trigger_id, published, candidate },
              input.checkpointFactory,
            );
            await storeKeys(
              transaction,
              claim,
              [...(recorded ?? []), Buffer.from(candidate.hash, 'hex')].slice(
                -POLL_MAX_SEEN_KEYS,
              ),
            );
          },
        );
      }
    } catch (error: unknown) {
      if (!(
        error instanceof WorkspaceRunQuotaExceededError ||
        error instanceof WorkflowAlreadyRunningError
      ))
        throw error;
      const retrySeconds = admissionRetrySeconds(error.retryAfterSeconds);
      await withLivePoll((transaction) =>
        finishPoll(transaction, claim, retrySeconds, false),
      );
      return 'deferred';
    }

    await withLivePoll((transaction) =>
      finishPoll(transaction, claim, intervalSeconds, true),
    );
    return candidates.length === 0 ? 'skipped' : 'accepted';
  } catch (error: unknown) {
    await releaseClaims(resources.claimPool, [claim]);
    if (error instanceof PollClaimLostError) return 'deferred';
    throw error;
  }
}

async function storeKeys(
  transaction: WorkspaceTransaction,
  claim: PollClaim,
  keys: readonly Buffer[],
) {
  if (!(await recordPollKeys(transaction, claim, keys)))
    throw new PollClaimLostError();
}

async function finishPoll(
  transaction: WorkspaceTransaction,
  claim: PollClaim,
  delaySeconds: number,
  healthy: boolean,
) {
  if (!(await completePoll(transaction, claim, delaySeconds, healthy)))
    throw new PollClaimLostError();
}

async function admitPollItem(
  transaction: WorkspaceTransaction,
  {
    triggerId,
    published,
    candidate: { hash, item },
  }: Readonly<{
    triggerId: string;
    published: NonNullable<
      Awaited<ReturnType<typeof lockPollPublication>>
    >['published'];
    candidate: ReturnType<typeof newPollItems>[number];
  }>,
  checkpointFactory: ScanDueInput['checkpointFactory'],
) {
  const command = {
    keyHash: commandKeyHash(hash),
    operation: 'workflow.run.accept',
    requestHash: commandRequestHash({
      triggerId,
      keyHash: hash,
    }),
    scope: `polling:${triggerId}`,
  } as const;
  if (await readWorkflowRunAcceptanceReplay(transaction, command)) return;
  const initial = checkpointFactory(published);
  await acceptWorkflowRun(transaction, {
    ...command,
    initialCheckpoint: initial.checkpoint,
    validateInput: initial.validateInput,
    triggerType: 'polling',
    workflowId: published.workflowId,
    workflowVersionId: published.id,
    runInput: {
      triggerId,
      nodeId: published.nodeId,
      item,
    } satisfies PollRunInput,
  });
}
