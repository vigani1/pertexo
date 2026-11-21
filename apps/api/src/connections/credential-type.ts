import type { ParsedConnectionCredential } from '@pertexo/contracts';

/** Project a credential already parsed by the registry into a built-in format. */
export function hasCredentialType<
  Credential extends ParsedConnectionCredential,
>(
  credential: ParsedConnectionCredential,
  schema: {
    readonly _output: Credential;
    unwrap(): {
      readonly shape: { readonly type: { readonly value: Credential['type'] } };
    };
  },
): credential is Credential {
  return credential.type === schema.unwrap().shape.type.value;
}
