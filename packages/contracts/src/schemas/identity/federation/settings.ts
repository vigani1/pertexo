import { FEDERATION_LIMITS } from '@pertexo/workflow-model';
export { FEDERATION_LIMITS };
import { z } from 'zod';
import { utf8ByteLength } from '../../shared/text.js';
import { delegatedWorkspaceRoleSchema } from '../membership.js';

export const federationProtocolSchema = z.enum(['oidc', 'saml']);
export type FederationProtocol = z.output<typeof federationProtocolSchema>;

/** Why a provider's proof was refused: a fixed code, never what the proof said. */
export const federationFailureReasonSchema = z.enum([
  'saml_unreadable',
  'saml_destination',
  'saml_request',
  'saml_issuer',
  'saml_status',
  'saml_assertion_count',
  'saml_signature_count',
  'saml_signature_algorithm',
  'saml_signature_invalid',
  'saml_certificate',
  'saml_time',
  'saml_audience',
  'saml_name_id',
  'saml_subject_confirmation',
  'oidc_provider',
  'oidc_token',
  'oidc_email_unverified',
  'identity_claims',
  'email_domain',
  'account_refused',
  'callback_invalid',
  'attempt_unavailable',
  'test_owner',
  'unavailable',
]);
export type FederationFailureReason = z.output<
  typeof federationFailureReasonSchema
>;

const samlXmlBytes = 256 * 1024;
export const SAML_LIMITS = Object.freeze({
  metadataBytes: 64 * 1024,
  formBytes: 512 * 1024,
  xmlBytes: samlXmlBytes,
  encodedCharacters: 4 * Math.ceil(samlXmlBytes / 3),
  nodes: 8192,
  elements: 2048,
  depth: 32,
  attributes: 64,
  certificateCharacters: 16384,
  certificates: 2,
  assertionAgeMillis: 5 * 60000,
  clockSkewMillis: 2 * 60000,
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
        const exactIssuer =
          url.protocol === 'https:' &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === '' &&
          !/[\s?#]/u.test(value);
        return exactIssuer;
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
const oidcProviderUpdateSchema = z
  .object({
    name,
    configuration: oidcConfigurationSchema,
    clientSecret: secret.optional(),
    enabled: z.boolean(),
    expectedRevision: revision,
  })
  .strict();
export const samlConfigurationSchema = z
  .object({
    signInUrl: z
      .url({ protocol: /^https$/u })
      .trim()
      .max(2048)
      .pipe(
        z.string().refine((value) => {
          const url = new URL(value);
          const safeSignInUrl =
            url.username === '' &&
            url.password === '' &&
            url.hash === '' &&
            !url.searchParams.has('SAMLRequest') &&
            !url.searchParams.has('RelayState');
          return safeSignInUrl;
        }, 'Use an HTTPS sign-in URL without credentials, fragment or reserved SAML parameters.'),
      ),
    certificates: z
      .array(z.string().trim().min(1).max(SAML_LIMITS.certificateCharacters))
      .min(1)
      .max(SAML_LIMITS.certificates),
    emailAttribute: claimName.default('email'),
    nameAttribute: claimName.default('name'),
    jitEnabled: z.boolean().default(false),
  })
  .strict();
export type SamlConfiguration = z.output<typeof samlConfigurationSchema>;
const samlIssuer = z
  .url()
  .trim()
  .max(2048)
  .pipe(
    z
      .string()
      .refine(
        (value) =>
          ['http:', 'https:', 'urn:'].includes(new URL(value).protocol),
        'Enter the exact HTTP, HTTPS or URN IdP entity ID.',
      ),
  );
export const samlProviderCreateSchema = z
  .object({
    kind: z.literal('saml'),
    name,
    issuer: samlIssuer,
    configuration: samlConfigurationSchema,
    enabled: z.boolean().default(false),
    expectedRevision: revision,
  })
  .strict();
const samlProviderUpdateSchema = samlProviderCreateSchema.omit({
  issuer: true,
});
export const federationProviderCreateSchema = z.discriminatedUnion('kind', [
  oidcProviderCreateSchema,
  samlProviderCreateSchema,
]);
// Existing OIDC updates omit kind; their strict shape remains compatible.
export const federationProviderUpdateSchema = z.union([
  oidcProviderUpdateSchema,
  samlProviderUpdateSchema,
]);
export type FederationProviderCreate = z.output<
  typeof federationProviderCreateSchema
>;
export type FederationProviderUpdate = z.output<
  typeof federationProviderUpdateSchema
>;

export const federationTestStartSchema = z
  .object({ workspaceId: z.uuid(), domainId: z.uuid(), providerId: z.uuid() })
  .strict();

const oidcProvider = z
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
const provider = z.discriminatedUnion('kind', [
  oidcProvider,
  oidcProvider.omit({ secretConfigured: true }).extend({
    kind: z.literal('saml'),
    issuer: samlIssuer,
    configuration: samlConfigurationSchema,
  }),
]);
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

/** Public SP identity is available before an IdP is configured; providers keep separate trust. */
export function samlServiceProviderUrls(
  publicOrigin: string,
  organizationId: string,
) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:')
    throw new Error('SAML requires an HTTPS public app address');
  return {
    entityId: new URL(
      `/v1/auth/federation/saml/organizations/${encodeURIComponent(organizationId)}`,
      origin,
    ).toString(),
    redirectUri: new URL(
      '/v1/auth/federation/saml/callback',
      origin,
    ).toString(),
  };
}

export const samlMetadataSchema = z
  .object({
    entityId: z.url({ protocol: /^https$/u }).max(2048),
    redirectUri: z.url({ protocol: /^https$/u }).max(2048),
    xml: z.string().min(1).max(SAML_LIMITS.metadataBytes),
  })
  .strict();
