import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function requiredMajor(value, pattern, label) {
  const match = pattern.exec(value);
  if (!match) {
    throw new Error(`${label} must declare an explicit Node major`);
  }
  return Number(match[1]);
}

export function validateRuntimeMajorSurfaces({
  packageJson,
  workflows,
  dockerfile,
}) {
  const engineRange = packageJson.engines?.node ?? '';
  const engineMatch = /^>=(\d+)\.\d+\.\d+ <(\d+)\.\d+\.\d+$/.exec(engineRange);
  if (!engineMatch || Number(engineMatch[2]) !== Number(engineMatch[1]) + 1) {
    throw new Error('engines.node must select a single Node major');
  }

  const expectedMajor = Number(engineMatch[1]);
  const expectedLabel = `Node ${expectedMajor}`;
  const ambientMajor = requiredMajor(
    packageJson.devDependencies?.['@types/node'] ?? '',
    /^(\d+)\./,
    '@types/node',
  );
  if (ambientMajor !== expectedMajor) {
    throw new Error(`@types/node must match ${expectedLabel}`);
  }

  const workflowMajors = [];
  for (const [file, contents] of workflows) {
    for (const match of contents.matchAll(/node-version:\s*["']?(\d+)/g)) {
      workflowMajors.push([file, Number(match[1])]);
    }
  }
  if (workflowMajors.length === 0) {
    throw new Error('CI must declare at least one setup-node version');
  }
  for (const [file, major] of workflowMajors) {
    if (major !== expectedMajor) {
      throw new Error(`${file} setup-node must use ${expectedLabel}`);
    }
  }

  const containerMajors = [...dockerfile.matchAll(/^FROM\s+node:(\d+)/gm)].map(
    (match) => Number(match[1]),
  );
  if (containerMajors.length === 0) {
    throw new Error('Dockerfile must declare at least one Node base image');
  }
  for (const major of containerMajors) {
    if (major !== expectedMajor) {
      throw new Error(`Dockerfile base images must use ${expectedLabel}`);
    }
  }

  return expectedMajor;
}

async function readRepositorySurfaces(rootDirectory) {
  const packageJson = JSON.parse(
    await readFile(new URL('package.json', rootDirectory), 'utf8'),
  );
  const workflowDirectory = new URL('.github/workflows/', rootDirectory);
  const workflowNames = (await readdir(workflowDirectory)).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  const workflows = new Map(
    await Promise.all(
      workflowNames.map(async (name) => [
        name,
        await readFile(new URL(name, workflowDirectory), 'utf8'),
      ]),
    ),
  );
  const dockerfile = await readFile(
    new URL('Dockerfile', rootDirectory),
    'utf8',
  );
  return { packageJson, workflows, dockerfile };
}

export async function validateRepositoryRuntimeMajor(rootDirectory) {
  return validateRuntimeMajorSurfaces(
    await readRepositorySurfaces(rootDirectory),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = new URL('../', import.meta.url);
  const major = await validateRepositoryRuntimeMajor(repositoryRoot);
  console.log(`Runtime surfaces consistently target Node ${major}.`);
}
