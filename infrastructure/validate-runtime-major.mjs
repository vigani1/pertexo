import { readFile, readdir } from 'node:fs/promises';
import console from 'node:console';
import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

function requiredMajor(value, pattern, label) {
  const match = pattern.exec(value);
  if (!match) {
    throw new Error(`${label} must declare an explicit Node major`);
  }
  return Number(match[1]);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkflow(file, contents) {
  try {
    const workflow = parse(contents);
    if (!isRecord(workflow)) {
      throw new Error('workflow root must be a mapping');
    }
    return workflow;
  } catch (error) {
    throw new Error(`${file} must contain valid workflow YAML`, {
      cause: error,
    });
  }
}

function workflowSteps(workflow) {
  if (!isRecord(workflow.jobs)) return [];
  return Object.values(workflow.jobs).flatMap((job) =>
    isRecord(job) && Array.isArray(job.steps) ? job.steps : [],
  );
}

function setupNodeMajor(file, step) {
  if (!isRecord(step.with)) {
    throw new Error(
      `${file} must give each setup-node step one literal selector`,
    );
  }
  if (Object.hasOwn(step.with, 'node-version-file')) {
    throw new Error(
      `${file} node-version-file is unsupported; CI must declare a literal Node major`,
    );
  }
  if (!Object.hasOwn(step.with, 'node-version')) {
    throw new Error(
      `${file} must give each setup-node step one literal selector`,
    );
  }

  const selector = step.with['node-version'];
  const match = /^(\d+)(?:\.\d+(?:\.\d+)?)?$/u.exec(String(selector));
  if (match === null) {
    throw new Error(`${file} setup-node must use a literal Node major`);
  }
  return Number(match[1]);
}

function workflowNodeMajors(file, contents) {
  const workflow = parseWorkflow(file, contents);
  return workflowSteps(workflow)
    .filter(
      (step) =>
        isRecord(step) &&
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/setup-node@'),
    )
    .map((step) => setupNodeMajor(file, step));
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
