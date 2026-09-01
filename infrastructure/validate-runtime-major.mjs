import { readFile, readdir } from 'node:fs/promises';
import console from 'node:console';
import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';

function requiredMajor(value, pattern, label) {
  const match = pattern.exec(value);
  if (!match) {
    throw new Error(`${label} must declare an explicit Node major`);
  }
  return Number(match[1]);
}

function workflowNodeMajors(file, contents) {
  const majors = [];
  const setupNodeUses =
    contents.match(/\buses:\s*actions\/setup-node@/gu) ?? [];
  for (const line of contents.split('\n')) {
    if (/^\s*node-version-file\s*:/u.test(line)) {
      throw new Error(
        `${file} node-version-file is unsupported; CI must declare a literal Node major`,
      );
    }
    const selector = /^\s*node-version\s*:\s*(.*?)\s*$/u.exec(line)?.[1];
    if (selector === undefined) continue;
    const withoutComment = selector.replace(/\s+#.*$/u, '').trim();
    const unquoted = (
      /^(['"]).*\1$/u.test(withoutComment)
        ? withoutComment.slice(1, -1)
        : withoutComment
    ).trim();
    const match = /^(\d+)(?:\.\d+(?:\.\d+)?)?$/u.exec(unquoted);
    if (match === null) {
      throw new Error(`${file} setup-node must use a literal Node major`);
    }
    majors.push(Number(match[1]));
  }
  if (setupNodeUses.length > 0 && majors.length !== setupNodeUses.length) {
    throw new Error(
      `${file} must give each setup-node step one literal selector`,
    );
  }
  return majors;
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
    for (const major of workflowNodeMajors(file, contents)) {
      workflowMajors.push([file, major]);
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
