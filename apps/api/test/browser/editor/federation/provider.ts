import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SocialProviderGateway } from '../../../../src/authentication/providers/contract.js';

/** Synthetic provider only; Pertexo still verifies, persists and signs in normally. */
export function createBrowserIdentityProvider() {
  let origin = '';
  const journeys = new Map<
    string,
    Parameters<SocialProviderGateway['authorize']>[0]
  >();
  const codes = new Map<string, { state: string; email: string }>();
  const gateway: SocialProviderGateway = {
    available: ['google', 'github', 'apple'],
    authorize: (input) => {
      journeys.set(input.state, input);
      return Promise.resolve(
        `${origin}/identity-provider?state=${input.state}`,
      );
    },
    verify: (input) => {
      const code = codes.get(input.code);
      codes.delete(input.code);
      const journey = code === undefined ? undefined : journeys.get(code.state);
      if (
        code === undefined ||
        journey?.provider !== input.provider ||
        journey.redirectUri !== input.redirectUri ||
        journey.nonce !== input.nonce ||
        journey.codeVerifier !== input.codeVerifier ||
        input.issuer !== null
      )
        return Promise.resolve(undefined);
      journeys.delete(code.state);
      return Promise.resolve({
        accountId: `fixture:${code.email}`,
        email: code.email,
        emailVerified: true,
        displayName: 'Provider Person',
      });
    },
  };
  return {
    gateway,
    setOrigin: (value: string) => {
      origin = value;
    },
    handle: (request: IncomingMessage, response: ServerResponse): boolean => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/identity-provider') return false;
      const state = url.searchParams.get('state') ?? '';
      const journey = journeys.get(state);
      if (request.method !== 'GET' || journey === undefined) {
        response.writeHead(400).end();
        return true;
      }
      const email = url.searchParams.get('email');
      if (email === null) {
        response
          .writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          .end(
            `<main><h1>Local identity provider</h1><form method="get"><input name="state" type="hidden" value="${state}"><label>Provider email<input name="email" type="email" required></label><button>Verify identity</button></form></main>`,
          );
      } else if (
        !/^[a-zA-Z0-9@._+-]{1,320}$/u.test(email) ||
        !email.endsWith('@integration.test')
      ) {
        response.writeHead(400).end();
      } else {
        const code = randomUUID();
        codes.set(code, { state, email });
        const callback = new URL(journey.redirectUri);
        callback.searchParams.set('state', state);
        callback.searchParams.set('code', code);
        if (journey.provider === 'apple') {
          response
            .writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            })
            .end(
              `<main><h1>Verified local identity</h1><form method="post" action="${journey.redirectUri}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="code" value="${code}"><input type="hidden" name="id_token" value="untrusted-front-channel-token"><button>Continue to Pertexo</button></form></main>`,
            );
          return true;
        }
        response
          .writeHead(302, {
            location: callback.toString(),
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          .end();
      }
      return true;
    },
  };
}
