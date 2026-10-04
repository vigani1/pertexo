import { workflowControlOutputKind } from './graph/control-output-selection.js';
import { canonicalizeJson } from './canonical-json.js';

export function configuredBranchOutputPorts(
  node: Readonly<{
    definition?: Readonly<{ key: string; version: number }>;
    config?: unknown;
  }>,
): readonly string[] | undefined {
  if (workflowControlOutputKind(node.definition) !== 'branch') return undefined;
  if (
    node.definition?.key === 'core.condition' &&
    node.definition.version === 1
  )
    return ['false', 'true'];
  if (node.definition?.key !== 'core.switch' || node.definition.version !== 1)
    return undefined;
  if (
    typeof node.config !== 'object' ||
    node.config === null ||
    Array.isArray(node.config)
  )
    return undefined;
  const cases = Reflect.get(node.config, 'cases') as unknown;
  if (!Array.isArray(cases)) return undefined;
  const ports = cases.map((item): unknown =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Reflect.get(item, 'id')
      : undefined,
  );
  if (
    ports.some(
      (port) =>
        typeof port !== 'string' || !/^case-(?:0[1-9]|1[0-6])$/u.test(port),
    ) ||
    new Set(ports).size !== ports.length
  )
    return undefined;
  return [...(ports as string[]), 'default'];
}

export function configuredParallelOutputPorts(
  node: Readonly<{
    definition?: Readonly<{ key: string; version: number }>;
    config?: unknown;
  }>,
): readonly string[] | undefined {
  if (
    workflowControlOutputKind(node.definition) !== 'parallel' ||
    typeof node.config !== 'object' ||
    node.config === null ||
    Array.isArray(node.config)
  )
    return undefined;
  const branches = Reflect.get(node.config, 'branches') as unknown;
  if (!Array.isArray(branches)) return undefined;
  const ports = branches.map((item): unknown =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Reflect.get(item, 'id')
      : undefined,
  );
  if (
    ports.length < 2 ||
    ports.some(
      (port) =>
        typeof port !== 'string' || !/^branch-(?:0[1-9]|1[0-6])$/u.test(port),
    ) ||
    new Set(ports).size !== ports.length
  )
    return undefined;
  return ports as string[];
}

/** Pure output semantics; callers retain byte bounds and pinned scheduling policy. */
export function inspectBranchSelection(
  value: unknown,
  ports: readonly string[],
): string {
  const output = canonicalizeJson(value);
  if (
    output === null ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    Object.keys(output).join(',') !== 'selectedPort' ||
    typeof Reflect.get(output, 'selectedPort') !== 'string'
  )
    throw new TypeError('Branch output is invalid');
  const selected: unknown = Reflect.get(output, 'selectedPort');
  if (typeof selected !== 'string' || !ports.includes(selected))
    throw new TypeError('Branch output is invalid');
  return selected;
}

export function inspectParallelDeclaration(
  value: unknown,
  ports: readonly string[],
): void {
  const output = canonicalizeJson(value);
  if (
    output === null ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    Object.keys(output).join(',') !== 'branchIds'
  )
    throw new TypeError('Parallel output is invalid');
  const ids: unknown = Reflect.get(output, 'branchIds');
  if (
    !Array.isArray(ids) ||
    ids.length !== ports.length ||
    ids.some((id, index) => id !== ports[index])
  )
    throw new TypeError('Parallel output is invalid');
}
