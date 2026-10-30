import { authenticationMailAssociatedData } from '@pertexo/database/platform';
import { z } from 'zod';
import type {
  SystemMailDeliveryClaim,
  SystemMailDeliveryStore,
} from '@pertexo/database/platform';
import type {
  ApplicationSecretEnvelope,
  SystemMailResult,
  SystemMailClient,
} from '@pertexo/integrations/server';

const payload = z
  .object({
    fromEmail: z.email().max(320),
    toEmail: z.email().max(320),
    subject: z.string().min(1).max(998),
    text: z.string().min(1).max(32_768),
    unsubscribeUrl: z
      .url({ protocol: /^https?$/u })
      .max(8192)
      .optional(),
  })
  .strict();

export interface SystemMailDeliveryHandler {
  runOnce(signal?: AbortSignal): Promise<number>;
}

export function createSystemMailDeliveryHandler(
  dependencies: Readonly<{
    store: SystemMailDeliveryStore;
    envelope: Pick<ApplicationSecretEnvelope, 'open'>;
    email: SystemMailClient;
    timeoutMillis: number;
    workerId: string;
    now?: () => Date;
    random?: () => number;
    notices?: Readonly<{
      prepare(signal?: AbortSignal): Promise<number>;
      authorize(id: string): Promise<boolean>;
    }>;
  }>,
): SystemMailDeliveryHandler {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  return Object.freeze({
    runOnce: async (signal?: AbortSignal) => {
      let claims = await dependencies.store.claim({
        workerId: dependencies.workerId,
        limit: 1,
      });
      if (claims.length === 0 && dependencies.notices !== undefined) {
        await dependencies.notices.prepare(signal);
        claims = await dependencies.store.claim({
          workerId: dependencies.workerId,
          limit: 1,
        });
      }
      for (const claim of claims) {
        if (signal?.aborted) break;
        await deliverClaim(dependencies, claim, {
          now: now,
          random: random,
          signal: signal,
        });
      }
      return claims.length;
    },
  });
}

async function deliverClaim(
  dependencies: Parameters<typeof createSystemMailDeliveryHandler>[0],
  claim: SystemMailDeliveryClaim,
  {
    now,
    random,
    signal,
  }: Readonly<{
    now: () => Date;
    random: () => number;
    signal?: AbortSignal | undefined;
  }>,
): Promise<void> {
  if (claim.recoveredUnknown && !dependencies.email.deduplicates) {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'reconciliation_required',
      failureCode: 'delivery.recovered_unknown',
    });
    return;
  }
  if (now().getTime() >= claim.expiresAt.getTime()) {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'reconciliation_required',
      failureCode: 'delivery.expired_before_dispatch',
    });
    return;
  }
  // Durable ciphertext and provider identities predate the system-mail table name.
  const associatedData = authenticationMailAssociatedData(
    claim.purpose,
    claim.id,
    claim.expiresAt,
  );
  const message = payload.parse(
    JSON.parse(
      dependencies.envelope.open(claim.sealedPayload, associatedData),
    ) as unknown,
  );
  let result: SystemMailResult;
  const authorization = { superseded: false };
  try {
    result = await dependencies.email.sendNotification({
      fromEmail: message.fromEmail,
      toEmail: message.toEmail,
      subject: message.subject,
      text: message.text,
      ...(message.unsubscribeUrl === undefined
        ? {}
        : { unsubscribeUrl: message.unsubscribeUrl }),
      idempotencyKey: `authentication-mail:${claim.id}`,
      timeoutMillis: dependencies.timeoutMillis,
      beforeDispatch: async () => {
        if (
          claim.purpose === 'workspace_notice' &&
          (dependencies.notices === undefined ||
            !(await dependencies.notices.authorize(claim.id)))
        ) {
          authorization.superseded = true;
          throw new Error('Notice no longer eligible');
        }
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    if (authorization.superseded) {
      await dependencies.store.settle({
        ...claimIdentity(claim),
        outcome: 'failed',
        failureCode: 'notice.superseded',
      });
      return;
    }
    if (!dependencies.email.deduplicates) {
      await dependencies.store.settle({
        ...claimIdentity(claim),
        outcome: 'reconciliation_required',
        failureCode: 'delivery.transport',
      });
      return;
    }
    await settleRetry(dependencies.store, claim, {
      now: now,
      random: random,
      failureCode: 'delivery.transport',
    });
    return;
  }
  if (authorization.superseded) {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'failed',
      failureCode: 'notice.superseded',
    });
    return;
  }
  if (result.kind === 'submitted') {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'submitted',
      providerReference: result.reference,
    });
    return;
  }
  if (result.kind === 'failed') {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'failed',
      failureCode: 'delivery.provider_rejected',
    });
    return;
  }
  if (result.kind === 'unknown') {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'reconciliation_required',
      failureCode: 'delivery.outcome_unknown',
    });
    return;
  }
  await settleRetry(dependencies.store, claim, {
    now: now,
    random: random,
    failureCode: 'delivery.retryable',
  });
}

function settleRetry(
  store: SystemMailDeliveryStore,
  claim: SystemMailDeliveryClaim,
  {
    now,
    random,
    failureCode,
  }: Readonly<{ now: () => Date; random: () => number; failureCode: string }>,
): Promise<boolean> {
  const base = Math.min(3_600_000, 1_000 * 2 ** (claim.attemptCount - 1));
  const delay = Math.round(base + base * 0.25 * random());
  return store.settle({
    ...claimIdentity(claim),
    outcome: 'retry',
    failureCode,
    retryAt: new Date(now().getTime() + delay),
  });
}

function claimIdentity(claim: SystemMailDeliveryClaim) {
  return {
    id: claim.id,
    leaseToken: claim.leaseToken,
    leaseGeneration: claim.leaseGeneration,
  } as const;
}
