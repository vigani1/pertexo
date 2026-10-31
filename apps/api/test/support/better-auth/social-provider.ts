import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import { beforeAll, afterAll, vi } from 'vitest';
import * as composition from '../../../src/platform/identity/better-auth-composition.js';
import { createBetterAuthRuntime } from '../../../src/authentication/better-auth/runtime.js';
import type { SocialProviderGateway } from '../../../src/authentication/providers/contract.js';

/** Replace the external provider at composition; the real API/session/database stay intact. */
export function useSocialProviderGateway(gateway: SocialProviderGateway) {
  let restore: (() => void) | undefined;
  let configuration: Parameters<typeof createBetterAuthRuntime>[0] | undefined;
  beforeAll(() => {
    const spy = vi
      .spyOn(composition, 'composeBetterAuthRuntime')
      .mockImplementation((input) => {
        if (input.authenticationMail === undefined)
          throw new Error('Fixture mail is required');
        const config = input.config;
        configuration = {
          baseUrl: config.publicWebOrigin,
          secret: config.betterAuth.secret,
          database: input.databaseConfig,
          secureCookies: config.session.secureCookie,
          sessionTtlSeconds: Math.floor(config.session.ttlMillis / 1000),
          trustedOrigins: [config.publicWebOrigin],
          mail: input.authenticationMail,
          signUpMode: config.betterAuth.signUpMode,
          socialProviders: config.betterAuth.providers,
          linkProviderGateway: gateway,
          ...(config.federationEncryption === undefined
            ? {}
            : {
                federation: {
                  envelope: createApplicationSecretEnvelope(
                    config.federationEncryption,
                  ),
                },
              }),
        };
        return input.acquire(createBetterAuthRuntime(configuration));
      });
    restore = () => {
      spy.mockRestore();
    };
  });
  afterAll(() => restore?.());
  return {
    createPeer: () => {
      if (configuration === undefined)
        throw new Error('Fixture runtime is not ready');
      return createBetterAuthRuntime(configuration);
    },
  };
}
