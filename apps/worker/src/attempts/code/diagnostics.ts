import type { CodeDiagnostics } from '@pertexo/node-sdk';
/** Diagnostics accompany the same fenced completion as the outcome. */
export function codeCompletionFields(
  environment:
    Readonly<{ codeDiagnostics(): CodeDiagnostics | undefined }> | undefined,
) {
  const codeDiagnostics = environment?.codeDiagnostics();
  return codeDiagnostics === undefined ? {} : { codeDiagnostics };
}
