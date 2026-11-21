import type {
  ConnectionFormDefinition,
  ParsedConnectionCredential,
} from '@pertexo/contracts';
import type { z } from 'zod';

type AuthRecipe =
  | Readonly<{ kind: 'header_map'; field: string }>
  | Readonly<{ kind: 'named_header'; name: string; field: string }>
  | Readonly<{ kind: 'query'; name: string; field: string }>
  | Readonly<{ kind: 'basic'; username: string; password: string }>
  | Readonly<{ kind: 'bearer'; field: string }>
  | Readonly<{ kind: 'oauth2' | 'postgres' | 'smtp' | 'signing' }>;

type TestRecipe =
  | Readonly<{ kind: 'http' | 'oauth2'; method: 'GET'; target: 'entered_url' }>
  | Readonly<{ kind: 'slack'; method: 'POST'; target: string }>
  | Readonly<{
      kind: 'resend';
      method: 'POST';
      target: string;
      requiresConsent: true;
    }>
  | Readonly<{ kind: 'postgres' | 'smtp' | 'signing' }>;

export interface ConnectionDefinition {
  readonly presentation: Readonly<{
    choice: string;
    pickerOrder?: number;
    name: string;
    purpose: string;
    credential: string;
    savedCredential: string;
    usedBy: string;
    nameSuffix: string;
    variant?: string;
    variantPrompt?: string;
    requirement?: string;
  }>;
  readonly authType: string;
  readonly schema: z.ZodType<ParsedConnectionCredential>;
  readonly presets?: ConnectionFormDefinition['presets'];
  readonly fields: z.ZodType;
  readonly auth: AuthRecipe;
  readonly test: TestRecipe;
  readonly slot: Readonly<{ key: string; primary: boolean }>;
}
