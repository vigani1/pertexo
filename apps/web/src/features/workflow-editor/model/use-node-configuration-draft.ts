import { useMemo, useRef, useState } from 'react';
import {
  applyNumericScratch,
  applyOrdinaryFieldScratch,
  isJsonObject,
  numericScratchFor,
  ordinaryFieldScratchFor,
  parseJson,
  type NodeConfig,
  type SchemaFieldSpec,
} from './inspector-draft';

type ValidationResult =
  | Readonly<{ kind: 'valid'; config: NodeConfig }>
  | Readonly<{ kind: 'json' }>
  | Readonly<{ kind: 'field'; firstInvalidKey: string | undefined }>;

/** Owns the two editing surfaces for one keyed inspector form. */
export function useNodeConfigurationDraft(
  initialConfig: NodeConfig,
  fields: readonly SchemaFieldSpec[],
) {
  const [json, setJson] = useState(() =>
    JSON.stringify(initialConfig, null, 2),
  );
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const initialNumericScratch = useMemo(
    () => numericScratchFor(initialConfig, fields),
    [fields, initialConfig],
  );
  const [numericScratch, setNumericScratch] = useState(initialNumericScratch);
  const numericScratchOwners = useRef(new Set<string>());
  const initialOrdinaryScratch = useMemo(
    () => ordinaryFieldScratchFor(initialConfig, fields),
    [fields, initialConfig],
  );
  const [ordinaryScratch, setOrdinaryScratch] = useState(
    initialOrdinaryScratch,
  );
  const [ordinaryScratchOwners, setOrdinaryScratchOwners] = useState<
    ReadonlySet<string>
  >(new Set());
  const latestValidJsonConfig = useRef<NodeConfig>(initialConfig);
  const parsed = parseJson(json);
  const config = isJsonObject(parsed) ? parsed : initialConfig;
  const dirty =
    JSON.stringify(parsed) !== JSON.stringify(initialConfig) ||
    JSON.stringify(numericScratch) !== JSON.stringify(initialNumericScratch) ||
    JSON.stringify(ordinaryScratch) !== JSON.stringify(initialOrdinaryScratch);

  function validate(): ValidationResult {
    const candidate = parseJson(json);
    if (candidate === undefined || !isJsonObject(candidate)) {
      setError('Configuration must be a valid JSON object.');
      return { kind: 'json' };
    }
    const reconciled = applyOrdinaryFieldScratch(
      candidate,
      ordinaryScratch,
      ordinaryScratchOwners,
    );
    const numeric = applyNumericScratch(
      reconciled,
      fields,
      numericScratch,
      numericScratchOwners.current,
    );
    if (numeric.config === undefined) {
      setFieldErrors(numeric.errors);
      return {
        kind: 'field',
        firstInvalidKey: fields.find(
          (field) => numeric.errors[field.key] !== undefined,
        )?.key,
      };
    }
    return { kind: 'valid', config: numeric.config };
  }

  function updateField(key: string, value: NodeConfig[string]) {
    setOrdinaryScratch((current) => ({ ...current, [key]: value }));
    const candidate = parseJson(json);
    if (!isJsonObject(candidate)) {
      setOrdinaryScratchOwners((current) => new Set(current).add(key));
      return;
    }
    setOrdinaryScratchOwners(
      (current) => new Set([...current].filter((fieldKey) => fieldKey !== key)),
    );
    const next = { ...candidate, [key]: value };
    latestValidJsonConfig.current = next;
    setJson(JSON.stringify(next, null, 2));
  }

  function updateNumber(field: SchemaFieldSpec, value: string) {
    setNumericScratch((current) => ({ ...current, [field.key]: value }));
    setFieldErrors((current) => {
      if (current[field.key] === undefined) return current;
      return Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== field.key),
      );
    });
    const candidate = parseJson(json);
    if (!isJsonObject(candidate)) {
      numericScratchOwners.current.add(field.key);
      return;
    }
    const applied = applyNumericScratch(candidate, [field], {
      [field.key]: value,
    });
    if (applied.config === undefined) {
      numericScratchOwners.current.add(field.key);
      return;
    }
    numericScratchOwners.current.delete(field.key);
    latestValidJsonConfig.current = applied.config;
    setJson(JSON.stringify(applied.config, null, 2));
  }

  function updateJson(value: string) {
    setJson(value);
    const candidate = parseJson(value);
    if (!isJsonObject(candidate)) return;
    const previous = latestValidJsonConfig.current;
    latestValidJsonConfig.current = candidate;
    const ordinaryChanges = fields.flatMap((field) => {
      if (field.kind === 'number' || field.kind === 'integer') return [];
      const wasPresent = Object.prototype.hasOwnProperty.call(
        previous,
        field.key,
      );
      const isPresent = Object.prototype.hasOwnProperty.call(
        candidate,
        field.key,
      );
      if (
        wasPresent === isPresent &&
        Object.is(previous[field.key], candidate[field.key])
      )
        return [];
      return [[field.key, candidate[field.key]] as const];
    });
    if (ordinaryChanges.length > 0) {
      const changedKeys = new Set(
        ordinaryChanges.map(([fieldKey]) => fieldKey),
      );
      setOrdinaryScratchOwners(
        (current) =>
          new Set(
            [...current].filter((fieldKey) => !changedKeys.has(fieldKey)),
          ),
      );
      setOrdinaryScratch((current) => {
        const next = { ...current };
        for (const [fieldKey, scratchValue] of ordinaryChanges)
          next[fieldKey] = scratchValue;
        return next;
      });
    }
    const numericChanges = fields.flatMap((field) => {
      if (field.kind !== 'number' && field.kind !== 'integer') return [];
      const wasPresent = Object.prototype.hasOwnProperty.call(
        previous,
        field.key,
      );
      const isPresent = Object.prototype.hasOwnProperty.call(
        candidate,
        field.key,
      );
      if (
        wasPresent === isPresent &&
        Object.is(previous[field.key], candidate[field.key])
      )
        return [];
      const candidateValue = candidate[field.key];
      return [
        [
          field.key,
          typeof candidateValue === 'number' && Number.isFinite(candidateValue)
            ? String(candidateValue)
            : '',
        ] as const,
      ];
    });
    for (const [fieldKey] of numericChanges)
      numericScratchOwners.current.delete(fieldKey);
    if (numericChanges.length === 0) return;
    setNumericScratch((current) => {
      const next = { ...current };
      for (const [fieldKey, scratchValue] of numericChanges)
        next[fieldKey] = scratchValue;
      return next;
    });
  }

  function discard() {
    setJson(JSON.stringify(initialConfig, null, 2));
    setNumericScratch(initialNumericScratch);
    setOrdinaryScratch(initialOrdinaryScratch);
    numericScratchOwners.current.clear();
    setOrdinaryScratchOwners(new Set());
    latestValidJsonConfig.current = initialConfig;
    clearErrors();
  }

  function clearErrors() {
    setError(undefined);
    setFieldErrors({});
  }

  return {
    json,
    config,
    numericScratch,
    ordinaryScratch,
    ordinaryScratchOwners,
    error,
    fieldErrors,
    dirty,
    validate,
    updateField,
    updateNumber,
    updateJson,
    discard,
    clearErrors,
  } as const;
}
