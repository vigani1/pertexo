import { z } from 'zod';
import type {
  AuthenticationMailDeliveryClaim,
  AuthenticationMailDeliveryStore,
} from '@pertexo/database/execution';
import type {
  ApplicationSecretEnvelope,
  ResendApiResult,
  ResendClient,
} from '@pertexo/integrations/server';

const payload = z
  .object({
    fromEmail: z.email().max(320),
    toEmail: z.email().max(320),
    subject: z.string().min(1).max(998),
    text: z.string().min(1).max(32_768),
  })
  .strict();

export interface AuthenticationMailDeliveryHandler {
  runOnce(signal?: AbortSignal): Promise<number>;
}

export function createAuthenticationMailDeliveryHandler(
  dependencies: Readonly<{
    store: AuthenticationMailDeliveryStore;
    envelope: Pick<ApplicationSecretEnvelope, 'open'>;
    email: Pick<ResendClient, 'sendNotification'>;
    apiKey: string;
    timeoutMillis: number;
    workerId: string;
    now?: () => Date;
    random?: () => number;
  }>,
): AuthenticationMailDeliveryHandler {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  return Object.freeze({
    runOnce: async (signal?: AbortSignal) => {
      const claims = await dependencies.store.claim({
        workerId: dependencies.workerId,
        limit: 1,
      });
      for (const claim of claims) {
        if (signal?.aborted === true) break;
        await deliverClaim(dependencies, claim, now, random, signal);
      }
      return claims.length;
    },
  });
}

async function deliverClaim(
  dependencies: Parameters<typeof createAuthenticationMailDeliveryHandler>[0],
  claim: AuthenticationMailDeliveryClaim,
  now: () => Date,
  random: () => number,
  signal?: AbortSignal,
): Promise<void> {
  if (now().getTime() >= claim.expiresAt.getTime()) {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'reconciliation_required',
      failureCode: 'delivery.expired_before_dispatch',
    });
    return;
  }
  const associatedData = `pertexo/authentication-mail/v1/${claim.purpose}/${claim.id}/${claim.expiresAt.toISOString()}`;
  const message = payload.parse(
    JSON.parse(
      dependencies.envelope.open(claim.sealedPayload, associatedData),
    ) as unknown,
  );
  let result: ResendApiResult;
  try {
    result = await dependencies.email.sendNotification({
      apiKey: dependencies.apiKey,
      fromEmail: message.fromEmail,
      toEmail: message.toEmail,
      subject: message.subject,
      text: message.text,
      idempotencyKey: `authentication-mail:v1:${claim.id}`,
      timeoutMillis: dependencies.timeoutMillis,
      beforeDispatch: () => Promise.resolve(),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    await settleRetry(
      dependencies.store,
      claim,
      now,
      random,
      'delivery.transport',
    );
    return;
  }
  if (result.kind === 'succeeded') {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'submitted',
      providerReference: result.emailId,
    });
    return;
  }
  if (
    result.kind === 'rejected' &&
    result.status >= 400 &&
    result.status < 500 &&
    ![408, 409, 425, 429].includes(result.status) &&
    result.error !== 'concurrent_idempotent_requests'
  ) {
    await dependencies.store.settle({
      ...claimIdentity(claim),
      outcome: 'failed',
      failureCode: 'delivery.provider_rejected',
    });
    return;
  }
  await settleRetry(
    dependencies.store,
    claim,
    now,
    random,
    'delivery.outcome_unknown',
  );
}

function settleRetry(
  store: AuthenticationMailDeliveryStore,
  claim: AuthenticationMailDeliveryClaim,
  now: () => Date,
  random: () => number,
  failureCode: string,
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

function claimIdentity(claim: AuthenticationMailDeliveryClaim) {
  return {
    id: claim.id,
    leaseToken: claim.leaseToken,
    leaseGeneration: claim.leaseGeneration,
  } as const;
}
