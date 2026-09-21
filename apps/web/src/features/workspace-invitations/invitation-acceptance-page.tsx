import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  abandonInvitation,
  completeInvitation,
  readInvitation,
  resolveInvitation,
  startInvitationOidc,
} from './invitation-acceptance.api';

type AcceptanceFailure = Readonly<{
  kind:
    'authentication' | 'cleanup' | 'definite' | 'uncertain' | 'verification';
  message: string;
}>;

export function InvitationAcceptancePage(
  props: Readonly<{
    apiClient: ApiClient;
    initialToken?: string;
    clearFragment: () => void;
    navigateToProvider: (url: string) => void;
    openWorkspace: (workspaceId: string) => void;
    openSignIn: () => void;
    openWorkspaceDiscovery: () => void;
  }>,
) {
  const {
    apiClient,
    clearFragment,
    navigateToProvider,
    openSignIn,
    openWorkspace,
    openWorkspaceDiscovery,
  } = props;
  const [journey, setJourney] = useState<InvitationAcceptanceJourney>();
  const [error, setError] = useState<AcceptanceFailure>();
  const [pending, setPending] = useState(false);
  const [initialToken] = useState(props.initialToken);
  const [tokenAvailable, setTokenAvailable] = useState(
    initialToken !== undefined,
  );
  const token = useRef<string | undefined>(initialToken);
  const observedRouteToken = useRef(props.initialToken);
  const started = useRef(false);
  const lifecycle = useRef(0);
  const journeyOwnership = useRef(1);
  const bootstrapController = useRef<AbortController | undefined>(undefined);
  const oidcController = useRef<AbortController | undefined>(undefined);
  const cleanupController = useRef<AbortController | undefined>(undefined);
  const completion = useRef<
    | {
        intentId: string;
        expectedRevision: number;
        csrfToken: string;
        idempotencyKey: string;
      }
    | undefined
  >(undefined);

  const bootstrap = useCallback(
    async (signal: AbortSignal, ownership: number) => {
      setPending(true);
      setError(undefined);
      try {
        const state =
          token.current === undefined
            ? await readInvitation(apiClient, signal)
            : await resolveInvitation(apiClient, token.current, signal);
        if (signal.aborted || journeyOwnership.current !== ownership) return;
        token.current = undefined;
        setTokenAvailable(false);
        if (
          completion.current !== undefined &&
          (state.state === 'unavailable' ||
            state.intentId !== completion.current.intentId)
        )
          completion.current = undefined;
        setJourney(state);
      } catch (cause) {
        if (signal.aborted || journeyOwnership.current !== ownership) return;
        setError(acceptanceError(cause));
      } finally {
        if (!signal.aborted && journeyOwnership.current === ownership)
          setPending(false);
      }
    },
    [apiClient],
  );

  const startBootstrap = useCallback(
    (ownership = journeyOwnership.current) => {
      bootstrapController.current?.abort();
      oidcController.current?.abort();
      const controller = new AbortController();
      bootstrapController.current = controller;
      void bootstrap(controller.signal, ownership);
    },
    [bootstrap],
  );

  useEffect(() => {
    const generation = ++lifecycle.current;
    if (!started.current) {
      started.current = true;
      if (initialToken !== undefined) clearFragment();
      startBootstrap();
    }
    const ownedLifecycle = lifecycle;
    return () => {
      queueMicrotask(() => {
        if (ownedLifecycle.current !== generation) return;
        bootstrapController.current?.abort();
        oidcController.current?.abort();
        cleanupController.current?.abort();
        journeyOwnership.current += 1;
        token.current = undefined;
        completion.current = undefined;
      });
    };
  }, [clearFragment, initialToken, startBootstrap]);

  useEffect(() => {
    const nextToken = props.initialToken;
    const previousToken = observedRouteToken.current;
    observedRouteToken.current = nextToken;
    if (nextToken === undefined || nextToken === previousToken) return;
    const ownership = ++journeyOwnership.current;
    bootstrapController.current?.abort();
    oidcController.current?.abort();
    cleanupController.current?.abort();
    completion.current = undefined;
    token.current = nextToken;
    setTokenAvailable(true);
    setJourney(undefined);
    setError(undefined);
    setPending(false);
    clearFragment();
    startBootstrap(ownership);
  }, [clearFragment, props.initialToken, startBootstrap]);

  async function startSignIn() {
    if (journey === undefined || journey.state === 'unavailable') return;
    oidcController.current?.abort();
    const controller = new AbortController();
    oidcController.current = controller;
    const generation = lifecycle.current;
    const ownership = journeyOwnership.current;
    const intentId = journey.intentId;
    setPending(true);
    setError(undefined);
    try {
      const result = await startInvitationOidc(
        apiClient,
        journey.csrfToken,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        lifecycle.current !== generation ||
        journeyOwnership.current !== ownership ||
        journey.intentId !== intentId
      )
        return;
      navigateToProvider(result.authorizationUrl);
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        lifecycle.current === generation &&
        journeyOwnership.current === ownership
      )
        setError(acceptanceError(cause));
    } finally {
      if (
        !controller.signal.aborted &&
        lifecycle.current === generation &&
        journeyOwnership.current === ownership
      )
        setPending(false);
    }
  }

  async function reconcile() {
    const generation = lifecycle.current;
    const ownership = journeyOwnership.current;
    const controller = new AbortController();
    bootstrapController.current?.abort();
    oidcController.current?.abort();
    bootstrapController.current = controller;
    setPending(true);
    try {
      const state = await readInvitation(apiClient, controller.signal);
      if (
        controller.signal.aborted ||
        lifecycle.current !== generation ||
        journeyOwnership.current !== ownership
      )
        return;
      const retainedAttempt = completion.current;
      const sameIntent =
        retainedAttempt !== undefined &&
        state.state !== 'unavailable' &&
        retainedAttempt.intentId === state.intentId;
      if (retainedAttempt !== undefined && !sameIntent)
        completion.current = undefined;
      if (state.state === 'completed') {
        setJourney(state);
        completion.current = undefined;
        setError(undefined);
      } else if (state.state === 'ready') {
        setJourney(state);
        setError(
          sameIntent
            ? {
                kind: 'uncertain',
                message:
                  'Acceptance is not confirmed yet. Retry uses the exact original command.',
              }
            : retainedAttempt === undefined
              ? undefined
              : {
                  kind: 'definite',
                  message:
                    'A different invitation is now selected. Review it before accepting.',
                },
        );
      } else {
        setJourney(state);
        setError({
          kind: 'authentication',
          message:
            'Sign in again with the invited account, then check the acceptance status.',
        });
      }
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        lifecycle.current === generation &&
        journeyOwnership.current === ownership
      )
        setError(acceptanceError(cause, true));
    } finally {
      if (
        !controller.signal.aborted &&
        lifecycle.current === generation &&
        journeyOwnership.current === ownership
      )
        setPending(false);
    }
  }

  async function accept() {
    if (journey?.state !== 'ready') return;
    const attempt = completion.current ?? {
      intentId: journey.intentId,
      expectedRevision: journey.invitationRevision,
      csrfToken: journey.csrfToken,
      idempotencyKey: crypto.randomUUID(),
    };
    completion.current = attempt;
    const generation = lifecycle.current;
    const ownership = journeyOwnership.current;
    setPending(true);
    setError(undefined);
    try {
      const receipt = await completeInvitation(apiClient, attempt);
      if (
        lifecycle.current !== generation ||
        journeyOwnership.current !== ownership
      )
        return;
      completion.current = undefined;
      setJourney({
        state: 'completed',
        intentId: journey.intentId,
        expiresAt: journey.expiresAt,
        csrfToken: journey.csrfToken,
        workspace: journey.workspace,
        role: receipt.role,
        membershipCreated: receipt.membershipCreated,
      });
    } catch (cause) {
      if (
        lifecycle.current === generation &&
        journeyOwnership.current === ownership
      )
        setError(acceptanceError(cause, true));
    } finally {
      if (
        lifecycle.current === generation &&
        journeyOwnership.current === ownership
      )
        setPending(false);
    }
  }

  async function openAcceptedWorkspace(workspaceId: string, csrfToken: string) {
    cleanupController.current?.abort();
    const controller = new AbortController();
    cleanupController.current = controller;
    const generation = lifecycle.current;
    const ownership = journeyOwnership.current;
    const intentId =
      journey?.state === 'completed' ? journey.intentId : undefined;
    setPending(true);
    setError(undefined);
    try {
      await abandonInvitation(apiClient, csrfToken, controller.signal);
      if (
        controller.signal.aborted ||
        lifecycle.current !== generation ||
        journeyOwnership.current !== ownership ||
        journey?.state !== 'completed' ||
        journey.intentId !== intentId
      )
        return;
      openWorkspace(workspaceId);
    } catch {
      if (
        controller.signal.aborted ||
        lifecycle.current !== generation ||
        journeyOwnership.current !== ownership
      )
        return;
      setError({
        kind: 'cleanup',
        message:
          'Your invitation was accepted, but local cleanup did not finish. Continue through normal workspace access.',
      });
    } finally {
      if (
        !controller.signal.aborted &&
        lifecycle.current === generation &&
        journeyOwnership.current === ownership
      )
        setPending(false);
    }
  }

  return (
    <main
      id="main"
      className="app-stage grid min-h-svh place-items-center px-5 py-12"
    >
      <section className="glass-panel w-full max-w-xl rounded-2xl p-7 sm:p-10">
        <p className="font-mono text-xs tracking-[0.2em] text-secondary">
          PERTEXO INVITATION
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          Workspace invitation
        </h1>
        {pending && journey === undefined ? (
          <p role="status" className="mt-5 text-sm text-muted-foreground">
            Checking your invitation…
          </p>
        ) : null}
        <JourneyContent
          {...(journey === undefined ? {} : { journey })}
          pending={pending}
          onSignIn={() => {
            void startSignIn();
          }}
          onAccept={() => {
            void accept();
          }}
          onOpenWorkspace={(workspaceId, csrfToken) => {
            void openAcceptedWorkspace(workspaceId, csrfToken);
          }}
          onSignInNormally={openSignIn}
          onDiscoverWorkspaces={openWorkspaceDiscovery}
          cleanupFailed={error?.kind === 'cleanup'}
        />
        {error === undefined ? null : (
          <div role="alert" className="mt-5">
            <p className="text-sm text-destructive">{error.message}</p>
            {error.kind === 'authentication' ||
            error.kind === 'uncertain' ||
            error.kind === 'verification' ? (
              <div className="mt-4 flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    void reconcile();
                  }}
                >
                  Check acceptance status
                </Button>
                {(error.kind === 'authentication' ||
                  error.kind === 'verification') &&
                journey !== undefined &&
                journey.state !== 'unavailable' ? (
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      void startSignIn();
                    }}
                  >
                    {error.kind === 'verification'
                      ? 'Verify invited account again'
                      : 'Sign in again'}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {error.kind === 'cleanup' && journey?.state === 'completed' ? (
              <div className="mt-4 flex flex-wrap gap-3">
                <Button
                  type="button"
                  onClick={() => {
                    openWorkspace(journey.workspace.id);
                  }}
                >
                  Open workspace
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={openWorkspaceDiscovery}
                >
                  Find my workspaces
                </Button>
              </div>
            ) : null}
            {journey === undefined && tokenAvailable ? (
              <Button
                className="mt-4"
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  startBootstrap();
                }}
              >
                Retry invitation link
              </Button>
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}

function JourneyContent(
  props: Readonly<{
    journey?: InvitationAcceptanceJourney;
    pending: boolean;
    onSignIn: () => void;
    onAccept: () => void;
    onOpenWorkspace: (workspaceId: string, csrfToken: string) => void;
    onSignInNormally: () => void;
    onDiscoverWorkspaces: () => void;
    cleanupFailed: boolean;
  }>,
) {
  const journey = props.journey;
  if (journey === undefined) return null;
  if (journey.state === 'unavailable')
    return (
      <>
        <p className="mt-5 text-sm text-muted-foreground">
          This invitation continuation is unavailable. Sign in normally to
          discover any workspace access that was already granted, or reopen the
          latest invitation email.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button type="button" onClick={props.onSignInNormally}>
            Sign in
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={props.onDiscoverWorkspaces}
          >
            Find my workspaces
          </Button>
        </div>
      </>
    );
  if (journey.state === 'sign_in_required' || journey.state === 'wrong_account')
    return (
      <>
        <p className="mt-5 text-sm text-muted-foreground">
          {journey.state === 'wrong_account'
            ? 'This signed-in account does not match the invited verified address.'
            : 'Sign in with the address that received this invitation.'}
        </p>
        <Button
          className="mt-6"
          type="button"
          disabled={props.pending}
          onClick={props.onSignIn}
        >
          {journey.state === 'wrong_account'
            ? 'Use another account'
            : 'Continue with sign in'}
        </Button>
      </>
    );
  if (journey.state === 'ready')
    return (
      <>
        <p className="mt-5 text-sm text-muted-foreground">
          Join{' '}
          <strong className="text-foreground">{journey.workspace.name}</strong>{' '}
          as <strong className="text-foreground">{journey.role}</strong>. Your
          older Pertexo sessions will be signed out if this grants new access.
        </p>
        <Button
          className="mt-6"
          type="button"
          disabled={props.pending}
          onClick={props.onAccept}
        >
          {props.pending ? 'Accepting…' : 'Accept invitation'}
        </Button>
      </>
    );
  if (journey.state === 'completed')
    return (
      <>
        <p className="mt-5 text-sm text-muted-foreground">
          You {journey.membershipCreated ? 'joined' : 'already belong to'}{' '}
          <strong className="text-foreground">{journey.workspace.name}</strong>{' '}
          as {journey.role}.
        </p>
        {props.cleanupFailed ? null : (
          <Button
            className="mt-6"
            type="button"
            disabled={props.pending}
            onClick={() => {
              props.onOpenWorkspace(journey.workspace.id, journey.csrfToken);
            }}
          >
            {props.pending ? 'Opening…' : 'Open workspace'}
          </Button>
        )}
      </>
    );
  return (
    <p className="mt-5 text-sm text-muted-foreground">
      This invitation is {journey.state}. Ask a workspace manager for a new
      invitation.
    </p>
  );
}

function acceptanceError(error: unknown, uncertain = false): AcceptanceFailure {
  if (
    isApiError(error) &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'protocol')
  )
    return {
      kind: uncertain ? 'uncertain' : 'definite',
      message: uncertain
        ? 'The result is uncertain. Retry checks the same acceptance intent and command key.'
        : 'The invitation service could not be reached. Try again.',
    };
  if (isApiError(error) && error.status === 401)
    return {
      kind: 'authentication',
      message:
        'Your session was lost. Check whether acceptance completed, or sign in again with the invited account.',
    };
  if (isApiError(error) && error.status === 409)
    if (error.problem?.code === 'workspace.invitation_proof_expired')
      return {
        kind: 'verification',
        message:
          'Your invitation verification expired. Verify the invited account again.',
      };
  if (isApiError(error) && error.status === 409)
    return {
      kind: 'definite',
      message: 'This invitation changed or is no longer available.',
    };
  return {
    kind: uncertain ? 'uncertain' : 'definite',
    message: 'The invitation could not be processed. Try again.',
  };
}
