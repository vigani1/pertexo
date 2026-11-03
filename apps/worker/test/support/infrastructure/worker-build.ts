import { existsSync } from 'node:fs';
import ts from 'typescript';

/** Uses the compiler's project graph, so referenced package edits also invalidate the worker. */
export function requireCurrentWorkerBuild(project: string): void {
  const diagnostics: ts.Diagnostic[] = [];
  const report = (diagnostic: ts.Diagnostic) => diagnostics.push(diagnostic);
  const host = ts.createSolutionBuilderHost(undefined, undefined, report);
  const pending = ts
    .createSolutionBuilder(host, [project], {})
    .getNextInvalidatedProject();
  const config = ts.getParsedCommandLineOfConfigFile(
    project,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: report,
    },
  );
  // Incremental status alone can miss a deleted JS file when build info survives.
  const outputsExist = config?.fileNames.every((source) =>
    ts
      .getOutputFileNames(config, source, !ts.sys.useCaseSensitiveFileNames)
      .every(existsSync),
  );
  if (pending !== undefined || diagnostics.length > 0 || !outputsExist)
    throw new Error(
      'Worker build is missing or stale. Run pnpm build:packages --force before the For Each integration test.',
    );
}
