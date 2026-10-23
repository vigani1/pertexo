import { expect, vi } from 'vitest';

import * as browserSessionBoundary from '../../../../src/authentication/better-auth/trusted-sessions.js';
import { required } from '../requests.js';
import type {
  ProviderLinkScenario,
  ProviderLinkStart,
  CallbackOrdering,
  CallbackFailure,
} from './contract.js';

export async function dispatchProviderLinkCallbacks({
  scenario,
  started,
  ordering,
  firstCallbackFailure,
}: Readonly<{
  scenario: ProviderLinkScenario;
  started: ProviderLinkStart;
  ordering: CallbackOrdering;
  firstCallbackFailure?: CallbackFailure | undefined;
}>) {
  const { bothProviderProofs, proofState, originalCookie, linkRequest } =
    scenario;
  const { binding, callback } = started;
  const loserEnteredAuthentication = Promise.withResolvers<undefined>();
  const winnerCommitted = Promise.withResolvers<undefined>();
  const originalAuthenticate =
    browserSessionBoundary.authenticateBrowserRequest;
  let authenticationCalls = 0;
  const authenticationProbe =
    ordering === 'loser authentication after commit'
      ? vi
          .spyOn(browserSessionBoundary, 'authenticateBrowserRequest')
          .mockImplementation(async (...args) => {
            authenticationCalls += 1;
            if (authenticationCalls === 1) {
              await loserEnteredAuthentication.promise;
            } else if (authenticationCalls === 2) {
              loserEnteredAuthentication.resolve(undefined);
              await winnerCommitted.promise;
            }
            return originalAuthenticate(...args);
          })
      : undefined;
  proofState.gated = ordering === 'both provider proofs before commit';
  const pendingCallbacks: Promise<Response>[] = [];
  let first: Response;
  let second: Response;
  try {
    let firstCallback;
    if (firstCallbackFailure === 'early-return') {
      firstCallback = Promise.resolve(new Response(null, { status: 401 }));
    } else if (firstCallbackFailure === 'early-rejection') {
      firstCallback = Promise.reject(
        new Error('Fixture callback rejected before authentication'),
      );
    } else {
      firstCallback = linkRequest({
        path: callback,
        method: 'GET',
        session: originalCookie ?? '',
        binding: binding,
      });
    }
    pendingCallbacks.push(
      firstCallback.finally(() => {
        loserEnteredAuthentication.resolve(undefined);
        winnerCommitted.resolve(undefined);
        bothProviderProofs.resolve(undefined);
      }),
      linkRequest({
        path: callback,
        method: 'GET',
        session: originalCookie ?? '',
        binding: binding,
      }).finally(() => {
        loserEnteredAuthentication.resolve(undefined);
        winnerCommitted.resolve(undefined);
        bothProviderProofs.resolve(undefined);
      }),
    );
    [first, second] = await Promise.all([
      required(pendingCallbacks[0]),
      required(pendingCallbacks[1]),
    ]);
  } finally {
    loserEnteredAuthentication.resolve(undefined);
    winnerCommitted.resolve(undefined);
    bothProviderProofs.resolve(undefined);
    try {
      const settled = await Promise.allSettled(pendingCallbacks);
      if (firstCallbackFailure !== undefined) {
        const survivingCallback = required(settled[1]);
        expect(survivingCallback.status).toBe('fulfilled');
        if (survivingCallback.status === 'fulfilled') {
          expect(survivingCallback.value.status).toBe(302);
          expect(survivingCallback.value.headers.get('location')).toBe(
            'http://pertexo.test/account/security?linked=true',
          );
        }
      }
    } finally {
      authenticationProbe?.mockRestore();
      proofState.gated = false;
    }
  }

  return { first, second, authenticationCalls };
}
