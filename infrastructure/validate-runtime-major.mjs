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

function leadingSpaces(line) {
  return /^ */u.exec(line)?.[0].length ?? 0;
}

function setupNodeStepRanges(file, lines) {
  const ranges = [];
  for (const [usesIndex, line] of lines.entries()) {
    const uses = /^( *)(-\s*)?uses:\s*actions\/setup-node@/u.exec(line);
    if (uses === null) continue;

    const usesIndent = uses[1].length;
    let stepStart = uses[2] === undefined ? -1 : usesIndex;
    if (stepStart === -1) {
      for (let index = usesIndex - 1; index >= 0; index -= 1) {
        const item = /^( *)-\s+/u.exec(lines[index]);
        if (item !== null && item[1].length < usesIndent) {
          stepStart = index;
          break;
        }
      }
    }
    if (stepStart === -1) {
      throw new Error(`${file} setup-node must be declared in a workflow step`);
    }

    const stepIndent = leadingSpaces(lines[stepStart]);
    let stepEnd = lines.length;
    for (let index = stepStart + 1; index < lines.length; index += 1) {
      const item = /^( *)-\s+/u.exec(lines[index]);
      if (item !== null && item[1].length === stepIndent) {
        stepEnd = index;
        break;
      }
    }
    ranges.push({ stepStart, stepEnd });
  }
  return ranges;
}

function setupNodeMajor(file, lines, { stepStart, stepEnd }) {
  let withIndex;
  let withIndent;
  for (let index = stepStart; index < stepEnd; index += 1) {
    if (/^\s*with\s*:\s*(?:#.*)?$/u.test(lines[index])) {
      withIndex = index;
      withIndent = leadingSpaces(lines[index]);
      break;
    }
  }
  if (withIndex === undefined || withIndent === undefined) {
    throw new Error(
      `${file} must give each setup-node step one literal selector`,
    );
  }

  let selector;
  for (let index = withIndex + 1; index < stepEnd; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    if (leadingSpaces(line) <= withIndent) break;
    if (/^\s*node-version-file\s*:/u.test(line)) {
      throw new Error(
        `${file} node-version-file is unsupported; CI must declare a literal Node major`,
      );
    }
    const candidate = /^\s*node-version\s*:\s*(.*?)\s*$/u.exec(line)?.[1];
    if (candidate !== undefined) {
      if (selector !== undefined) {
        throw new Error(
          `${file} must give each setup-node step one literal selector`,
        );
      }
      selector = candidate;
    }
  }
  if (selector === undefined) {
    throw new Error(
      `${file} must give each setup-node step one literal selector`,
    );
  }

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
  return Number(match[1]);
}

function workflowNodeMajors(file, contents) {
  const lines = contents.split('\n');
  return setupNodeStepRanges(file, lines).map((range) =>
    setupNodeMajor(file, lines, range),
  );
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
