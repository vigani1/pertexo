export const hooks = {
  readPackage(pkg) {
    if (pkg.name === 'better-auth') {
      // Pertexo uses neither Better Auth's test helpers nor its schema CLI.
      for (const name of ['vitest', 'drizzle-kit']) {
        delete pkg.peerDependencies?.[name];
        delete pkg.peerDependenciesMeta?.[name];
      }
    }
    return pkg;
  },
};
