import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

// Re-emits every built project's JavaScript with source maps beside it, after
// a plain `pnpm build:packages`. Building with `tsc --build --sourceMap`
// instead records the extra option in each project's build info, and the
// worker tests' freshness check (`requireCurrentWorkerBuild`) then rightly
// sees a build that differs from the configured one. This pass writes no
// build info and no declarations, so the recorded build stays the configured
// one and the JavaScript only gains its map comment.

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function emitSourceMaps(solution = `${repositoryRoot}tsconfig.json`) {
  const problems = [];
  const report = (diagnostic) => problems.push(diagnostic);
  const builder = ts.createSolutionBuilder(
    ts.createSolutionBuilderHost(undefined, undefined, report),
    [solution],
    {},
  );
  for (const project of builder.getBuildOrder()) {
    const config = ts.getParsedCommandLineOfConfigFile(
      project,
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: report },
    );
    if (!config || config.options.noEmit || config.options.emitDeclarationOnly)
      continue;
    const program = ts.createProgram({
      rootNames: config.fileNames,
      projectReferences: config.projectReferences,
      options: {
        ...config.options,
        sourceMap: true,
        composite: false,
        incremental: false,
        declaration: false,
        declarationMap: false,
        tsBuildInfoFile: undefined,
      },
    });
    const { diagnostics, emitSkipped } = program.emit();
    problems.push(...diagnostics);
    if (emitSkipped) throw new Error(`${project} emitted nothing`);
  }
  if (problems.length > 0)
    throw new Error(
      ts.formatDiagnostics(problems, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => repositoryRoot,
        getNewLine: () => '\n',
      }),
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  emitSourceMaps();
}
