import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

/** Uses the compiler's project graph, so referenced package edits also invalidate the worker. */
export function requireCurrentWorkerBuild(
  project: string,
  fixture: string,
): void {
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
  if (
    config?.options.outDir !== undefined &&
    config.options.rootDir !== undefined
  ) {
    const module = ts.createSourceFile(
      fixture,
      readFileSync(fixture, 'utf8'),
      ts.ScriptTarget.Latest,
    );
    for (const statement of module.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;
      const output = resolve(dirname(fixture), specifier);
      const source = resolve(
        config.options.rootDir,
        relative(config.options.outDir, output),
      ).replace(/\.js$/u, '.ts');
      if (!existsSync(source))
        throw new Error(
          `Worker source ${source} is missing. Update the fixture import and rebuild with pnpm build:packages --force.`,
        );
      if (
        !existsSync(output) ||
        statSync(source).mtimeMs > statSync(output).mtimeMs
      )
        throw new Error(
          `Worker output ${output} is missing or stale. Rebuild with pnpm build:packages --force.`,
        );
    }
  }
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
