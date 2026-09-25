import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import type { RefObject } from 'react';
import type { ApiClient } from '@/lib/api/client';
import {
  abandonInvitation,
  completeInvitation,
  readInvitation,
  resolveInvitation,
  startInvitationOidc,
  verifyInvitationSession,
} from './invitation-acceptance.api';
import { isUnauthenticated } from '@/features/auth/session-identity.public';
import {
  acceptanceFailure,
  isProofExpired,
  DIFFERENT_INVITATION,
  NOT_JOINED_YET,
  SIGN_IN_AGAIN,
  type AcceptanceFailure,
} from './model/acceptance-failure';

type CompletionAttempt = Readonly<{
  intentId: string;
  expectedRevision: number;
  csrfToken: string;
  idempotencyKey: string;
}>;

/**
 * The mutable seams of one mounted journey. `lifecycle` counts effect runs
 * (StrictMode remounts); `ownership` changes whenever a new invitation link
 * takes over. A late answer only acts while both still match.
 */
export type JourneyRuntime = Readonly<{
  apiClient: ApiClient;
  token: RefObject<string | undefined>;
  lifecycle: RefObject<number>;
  ownership: RefObject<number>;
  bootstrapController: RefObject<AbortController | undefined>;
  oidcController: RefObject<AbortController | undefined>;
  cleanupController: RefObject<AbortController | undefined>;
  completion: RefObject<CompletionAttempt | undefined>;
  setJourney: (journey: InvitationAcceptanceJourney | undefined) => void;
  setError: (error: AcceptanceFailure | undefined) => void;
  setPending: (pending: boolean) => void;
  setTokenAvailable: (available: boolean) => void;
}>;

type Snapshot = Readonly<{ generation: number; ownership: number }>;

function snapshot(runtime: JourneyRuntime): Snapshot {
  return {
    generation: runtime.lifecycle.current,
    ownership: runtime.ownership.current,
  };
}

function stillOwned(
  runtime: JourneyRuntime,
  owned: Snapshot,
  signal?: AbortSignal,
): boolean {
  return (
    signal?.aborted !== true &&
    runtime.lifecycle.current === owned.generation &&
    runtime.ownership.current === owned.ownership
  );
}

function replaceController(
  slot: RefObject<AbortController | undefined>,
): AbortController {
  slot.current?.abort();
  const controller = new AbortController();
  slot.current = controller;
  return controller;
}

/** Unmounting retires the journey: nothing late may act on it any more. */
export function retireJourney(runtime: JourneyRuntime) {
  runtime.bootstrapController.current?.abort();
  runtime.oidcController.current?.abort();
  runtime.cleanupController.current?.abort();
  runtime.ownership.current += 1;
  runtime.token.current = undefined;
  runtime.completion.current = undefined;
}

/**
 * A fresh sign-in by the session authority proves the invited account
 * without another click; a missing or older session leaves sign-in to people.
 */
async function verifyQuietly(
  apiClient: ApiClient,
  journey: InvitationAcceptanceJourney,
  signal: AbortSignal,
): Promise<InvitationAcceptanceJourney | undefined> {
  if (journey.state !== 'sign_in_required') return undefined;
  try {
    return await verifyInvitationSession(apiClient, journey.csrfToken, signal);
  } catch {
    return undefined;
  }
}

/** Resolves the link token once, or reads the bound journey after reload. */
async function bootstrapJourney(
  runtime: JourneyRuntime,
  signal: AbortSignal,
  ownership: number,
  verifySession: boolean,
) {
  // Bootstrap outlives StrictMode's effect replay, so only ownership counts.
  const owned = () =>
    !signal.aborted && runtime.ownership.current === ownership;
  runtime.setPending(true);
  runtime.setError(undefined);
  try {
    const token = runtime.token.current;
    const read =
      token === undefined
        ? await readInvitation(runtime.apiClient, signal)
        : await resolveInvitation(runtime.apiClient, token, signal);
    const verified = verifySession
      ? await verifyQuietly(runtime.apiClient, read, signal)
      : undefined;
    if (!owned()) return;
    const state = verified ?? read;
    runtime.token.current = undefined;
    runtime.setTokenAvailable(false);
    const retained = runtime.completion.current;
    if (
      retained !== undefined &&
      (state.state === 'unavailable' || state.intentId !== retained.intentId)
    )
      runtime.completion.current = undefined;
    runtime.setJourney(state);
  } catch (cause) {
    if (owned()) runtime.setError(acceptanceFailure(cause));
  } finally {
    if (owned()) runtime.setPending(false);
  }
}

export function startBootstrap(
  runtime: JourneyRuntime,
  ownership: number,
  verifySession: boolean,
) {
  runtime.oidcController.current?.abort();
  const controller = replaceController(runtime.bootstrapController);
  void bootstrapJourney(runtime, controller.signal, ownership, verifySession);
}

/**
 * Proves the invited account from this browser's session (ADR 043). No
 * session goes to sign-in; an older one signs in again; both come back.
 */
export async function verifyJourneySession(
  runtime: JourneyRuntime,
  journey: InvitationAcceptanceJourney | undefined,
  navigate: Readonly<{ signIn: () => void; signInAgain: () => void }>,
) {
  if (journey === undefined || journey.state === 'unavailable') return;
  const controller = replaceController(runtime.oidcController);
  const owned = snapshot(runtime);
  runtime.setPending(true);
  runtime.setError(undefined);
  try {
    const verified = await verifyInvitationSession(
      runtime.apiClient,
      journey.csrfToken,
      controller.signal,
    );
    if (stillOwned(runtime, owned, controller.signal))
      runtime.setJourney(verified);
  } catch (cause) {
    if (!stillOwned(runtime, owned, controller.signal)) return;
    if (isUnauthenticated(cause)) navigate.signIn();
    else if (isProofExpired(cause)) navigate.signInAgain();
    else runtime.setError(acceptanceFailure(cause));
  } finally {
    if (stillOwned(runtime, owned, controller.signal))
      runtime.setPending(false);
  }
}

/** Verifies the invited account through the invitation's own sign-in. */
export async function startJourneySignIn(
  runtime: JourneyRuntime,
  journey: InvitationAcceptanceJourney | undefined,
  navigateToProvider: (url: string) => void,
) {
  if (journey === undefined || journey.state === 'unavailable') return;
  const controller = replaceController(runtime.oidcController);
  const owned = snapshot(runtime);
  runtime.setPending(true);
  runtime.setError(undefined);
  try {
    const result = await startInvitationOidc(
      runtime.apiClient,
      journey.csrfToken,
      controller.signal,
    );
    if (stillOwned(runtime, owned, controller.signal))
      navigateToProvider(result.authorizationUrl);
  } catch (cause) {
    if (stillOwned(runtime, owned, controller.signal))
      runtime.setError(acceptanceFailure(cause));
  } finally {
    if (stillOwned(runtime, owned, controller.signal))
      runtime.setPending(false);
  }
}

function reconciledFailure(
  state: InvitationAcceptanceJourney,
  retained: CompletionAttempt | undefined,
  sameIntent: boolean,
): AcceptanceFailure | undefined {
  if (state.state === 'completed') return undefined;
  if (state.state !== 'ready') return SIGN_IN_AGAIN;
  if (sameIntent) return NOT_JOINED_YET;
  return retained === undefined ? undefined : DIFFERENT_INVITATION;
}

/** Reads the authoritative journey after an uncertain or lost answer. */
export async function reconcileJourney(runtime: JourneyRuntime) {
  const owned = snapshot(runtime);
  runtime.oidcController.current?.abort();
  const controller = replaceController(runtime.bootstrapController);
  runtime.setPending(true);
  try {
    const state = await readInvitation(runtime.apiClient, controller.signal);
    if (!stillOwned(runtime, owned, controller.signal)) return;
    const retained = runtime.completion.current;
    const sameIntent =
      retained !== undefined &&
      state.state !== 'unavailable' &&
      retained.intentId === state.intentId;
    if (retained !== undefined && (!sameIntent || state.state === 'completed'))
      runtime.completion.current = undefined;
    runtime.setJourney(state);
    runtime.setError(reconciledFailure(state, retained, sameIntent));
  } catch (cause) {
    if (stillOwned(runtime, owned, controller.signal))
      runtime.setError(acceptanceFailure(cause, true));
  } finally {
    if (stillOwned(runtime, owned, controller.signal))
      runtime.setPending(false);
  }
}

/** Accepts once; an uncertain answer keeps the exact intent and key. */
export async function acceptJourney(
  runtime: JourneyRuntime,
  journey: InvitationAcceptanceJourney | undefined,
) {
  if (journey?.state !== 'ready') return;
  const attempt = runtime.completion.current ?? {
    intentId: journey.intentId,
    expectedRevision: journey.invitationRevision,
    csrfToken: journey.csrfToken,
    idempotencyKey: crypto.randomUUID(),
  };
  runtime.completion.current = attempt;
  const owned = snapshot(runtime);
  runtime.setPending(true);
  runtime.setError(undefined);
  try {
    const receipt = await completeInvitation(runtime.apiClient, attempt);
    if (!stillOwned(runtime, owned)) return;
    runtime.completion.current = undefined;
    runtime.setJourney({
      state: 'completed',
      intentId: journey.intentId,
      expiresAt: journey.expiresAt,
      csrfToken: journey.csrfToken,
      workspace: journey.workspace,
      role: receipt.role,
      membershipCreated: receipt.membershipCreated,
    });
  } catch (cause) {
    if (stillOwned(runtime, owned))
      runtime.setError(acceptanceFailure(cause, true));
  } finally {
    if (stillOwned(runtime, owned)) runtime.setPending(false);
  }
}

/**
 * Clears the journey's binding, then continues. `failure` is shown when the
 * binding couldn't be cleared; the membership (if any) is never undone.
 */
export async function leaveJourney(
  runtime: JourneyRuntime,
  csrfToken: string,
  failure: AcceptanceFailure,
  onLeft: () => void,
) {
  const controller = replaceController(runtime.cleanupController);
  const owned = snapshot(runtime);
  runtime.setPending(true);
  runtime.setError(undefined);
  try {
    await abandonInvitation(runtime.apiClient, csrfToken, controller.signal);
    if (stillOwned(runtime, owned, controller.signal)) onLeft();
  } catch {
    if (stillOwned(runtime, owned, controller.signal))
      runtime.setError(failure);
  } finally {
    if (stillOwned(runtime, owned, controller.signal))
      runtime.setPending(false);
  }
}
