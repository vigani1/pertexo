import { z } from 'zod';
import { authenticationReturnPathSchema } from '../authentication.js';
import {
  federationDomainNameSchema,
  FEDERATION_LIMITS,
  federationProtocolSchema,
} from './settings.js';
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
            name: z.string().min(1).max(128),
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
