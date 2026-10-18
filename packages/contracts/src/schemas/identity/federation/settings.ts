import { z } from 'zod';
import { utf8ByteLength } from '../../shared/text.js';
import { delegatedWorkspaceRoleSchema } from '../membership.js';

export const FEDERATION_LIMITS = Object.freeze({
  workspaces: 10,
  domains: 20,
  providers: 10,
  secretBytes: 8192,
});

export const federationDomainNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .transform((value, context) => {
    try {
      if (/[\s/%@:#?\\[\]]/u.test(value)) throw new Error('Invalid domain');
      const domain = new URL(`https://${value}`).hostname
        .replace(/\.$/u, '')
        .toLowerCase();
      if (
        domain.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
          domain,
        )
      )
        throw new Error('Invalid domain');
      return domain;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Enter an exact DNS domain, without a scheme, port or path.',
      });
      return z.NEVER;
    }
  });
const revision = z.number().int().positive().max(2147483647);
const name = z.string().trim().min(1).max(128);
const issuer = z
  .url({ protocol: /^https$/u })
  .trim()
  .max(2048)
  .pipe(
    z
      .string()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === '' &&
          !/[\s?#]/u.test(value)
        );
      }, 'Use the exact HTTPS issuer without credentials, query or fragment.'),
  );
const claimName = z.string().trim().min(1).max(256);
const secret = z
  .string()
  .min(1)
  .max(8192)
  .refine(
    (value) => utf8ByteLength(value) <= FEDERATION_LIMITS.secretBytes,
    'Client secret is too large.',
  );
export const oidcConfigurationSchema = z
  .object({
    clientId: z.string().trim().min(1).max(512),
    emailClaim: claimName.default('email'),
    nameClaim: claimName.default('name'),
    jitEnabled: z.boolean().default(false),
  })
  .strict();
export type OidcConfiguration = z.output<typeof oidcConfigurationSchema>;

export const federationOrganizationCreateSchema = z.object({ name }).strict();
export const federationWorkspaceLinkSchema = z
  .object({
    workspaceId: z.uuid(),
    defaultRole: delegatedWorkspaceRoleSchema.default('viewer'),
    expectedRevision: revision,
  })
  .strict();
export const federationRevisionCommandSchema = z
  .object({ expectedRevision: revision })
  .strict();
export const federationDomainCreateSchema = z
  .object({ domain: federationDomainNameSchema, expectedRevision: revision })
  .strict();
export const federationEnforcementSchema = z
  .object({ required: z.boolean(), expectedRevision: revision })
  .strict();
export const oidcProviderCreateSchema = z
  .object({
    kind: z.literal('oidc'),
    name,
    issuer,
    configuration: oidcConfigurationSchema,
    clientSecret: secret,
    enabled: z.boolean().default(false),
    expectedRevision: revision,
  })
  .strict();
export const oidcProviderUpdateSchema = z
  .object({
    name,
    configuration: oidcConfigurationSchema,
    clientSecret: secret.optional(),
    enabled: z.boolean(),
    expectedRevision: revision,
  })
  .strict();
export const federationTestStartSchema = z
  .object({ workspaceId: z.uuid(), domainId: z.uuid(), providerId: z.uuid() })
  .strict();

const provider = z
  .object({
    id: z.uuid(),
    kind: z.literal('oidc'),
    name,
    issuer,
    configuration: oidcConfigurationSchema,
    enabled: z.boolean(),
    revision,
    secretConfigured: z.boolean(),
  })
  .strict();
const domain = z
  .object({
    id: z.uuid(),
    domain: z.string(),
    revision,
    verifiedAt: z.iso.datetime().nullable(),
    requireSso: z.boolean(),
    challenge: z
      .object({
        recordName: z.string(),
        value: z.string(),
        expiresAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    checks: z
      .array(
        z
          .object({
            providerId: z.uuid(),
            providerRevision: revision,
            testedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(FEDERATION_LIMITS.providers),
  })
  .strict();
export const federationSettingsSchema = z
  .object({
    configured: z.boolean(),
    reason: z.string().nullable(),
    canManage: z.boolean(),
    organization: z
      .object({
        id: z.uuid(),
        name,
        revision,
        controlWorkspaceId: z.uuid(),
        workspaces: z
          .array(
            z
              .object({
                workspaceId: z.uuid(),
                name,
                defaultRole: delegatedWorkspaceRoleSchema,
              })
              .strict(),
          )
          .max(FEDERATION_LIMITS.workspaces),
        domains: z.array(domain).max(FEDERATION_LIMITS.domains),
        providers: z.array(provider).max(FEDERATION_LIMITS.providers),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type FederationSettings = z.output<typeof federationSettingsSchema>;
export type OidcProviderCreate = z.output<typeof oidcProviderCreateSchema>;
export type OidcProviderUpdate = z.output<typeof oidcProviderUpdateSchema>;

export type FederationOrganizationCreate = z.output<
  typeof federationOrganizationCreateSchema
>;
export type FederationWorkspaceLink = z.output<
  typeof federationWorkspaceLinkSchema
>;
export type FederationDomainCreate = z.output<
  typeof federationDomainCreateSchema
>;
export type FederationRevisionCommand = z.output<
  typeof federationRevisionCommandSchema
>;
export type FederationEnforcement = z.output<
  typeof federationEnforcementSchema
>;
