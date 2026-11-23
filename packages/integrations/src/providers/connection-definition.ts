import type {
  ConnectionFormDefinition,
  ParsedConnectionCredential,
} from '@pertexo/contracts';
import type { z } from 'zod';
import type { ProviderHttpRequest } from './http-client.js';

export type AuthRecipe =
  | Readonly<{ kind: 'header_map'; field: string }>
  | Readonly<{ kind: 'named_header'; name: string; field: string }>
  | Readonly<{ kind: 'query'; name: string; field: string }>
  | Readonly<{ kind: 'basic'; username: string; password: string }>
  | Readonly<{ kind: 'bearer'; field: string }>
  | Readonly<{ kind: 'oauth2' | 'postgres' | 'smtp' | 'signing' }>;

type JsonScalar = string | number | boolean | null;

type HttpTestRecipe<Credential> = Readonly<{
  kind: 'http';
  method: ProviderHttpRequest['method'];
  approvedOrigin?: string;
  target:
    | string
    | Readonly<{
        resolve(credential: Credential): Readonly<{
          url: string;
          headers: Readonly<Record<string, string>>;
        }>;
      }>;
  headers?: Readonly<Record<string, string>>;
  body?: Readonly<{
    fields: Readonly<Record<string, JsonScalar | readonly JsonScalar[]>>;
    credentialFields: Readonly<Record<string, string>>;
    idempotencyHeader: string;
  }>;
  success: Readonly<{
    status: '2xx';
    reportStatus?: 200;
    json?: Readonly<{
      schema?: z.ZodType;
      equals?: Readonly<{ pointer: string; value: JsonScalar }>;
      rejection?: Readonly<{
        pointer: string;
        rateLimited?: string;
        reauthorization: Readonly<Record<string, string>>;
      }>;
    }>;
  }>;
  credentialRejection?: false;
}> &
  (
    | Readonly<{ requiresConsent: true; consentMessage: string }>
    | Readonly<{ requiresConsent?: false }>
  );

type TestRecipe<Credential> =
  | HttpTestRecipe<Credential>
  | Readonly<{ kind: 'lookup'; key: string }>
  | Readonly<{ kind: 'oauth2'; method: 'GET'; target: 'entered_url' }>
  | Readonly<{ kind: 'postgres' | 'smtp' | 'signing' }>;

export interface ConnectionDefinition<
  Credential extends ParsedConnectionCredential = ParsedConnectionCredential,
> {
  readonly presentation: ConnectionFormDefinition['presentation'];
  readonly authType: string;
  readonly schema: z.ZodType<Credential>;
  readonly presets?: ConnectionFormDefinition['presets'];
  readonly fields: z.ZodType;
  readonly auth:
    AuthRecipe | Readonly<{ resolve(credential: Credential): AuthRecipe }>;
  readonly test: TestRecipe<Credential> & Readonly<{ automatic?: true }>;
  readonly slot: Readonly<{ key: string; primary: boolean }>;
}
