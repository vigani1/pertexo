import { FEDERATION_LIMITS } from '@pertexo/workflow-model';
import { z } from 'zod';
import { authenticationReturnPathSchema } from '../authentication.js';
import {
  federationDomainNameSchema,
  federationProtocolSchema,
} from './settings.js';

import { RESOURCE_NAME_MAX_LENGTH } from '@pertexo/workflow-model';
import { SECRET_TOKEN_CHARACTERS } from '../../shared/secret-token.js';

/** What a provider's sign-in callback may carry: a form post's size and each parameter's length. */
export const CALLBACK_LIMITS = Object.freeze({
  formBytes: 32 * 1_024,
  // Pertexo's own state is a journey token.
  stateCharacters: SECRET_TOKEN_CHARACTERS,
  codeCharacters: 4_096,
  issuerCharacters: 2_048,
});
export const federationDiscoveryQuerySchema = z
  .object({ domain: federationDomainNameSchema })
  .strict();
export const federationDiscoverySchema = z
  .object({
    required: z.boolean(),
    providers: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().min(1).max(RESOURCE_NAME_MAX_LENGTH),
            kind: federationProtocolSchema,
          })
          .strict(),
      )
      .max(FEDERATION_LIMITS.providers),
  })
  .strict();
export const federationSignInStartSchema = z
  .object({
    providerId: z.uuid(),
    domain: federationDomainNameSchema,
    returnPath: authenticationReturnPathSchema.optional(),
  })
  .strict();
export type FederationDiscovery = z.output<typeof federationDiscoverySchema>;
export type FederationSignInStart = z.output<
  typeof federationSignInStartSchema
>;
