import {
  inspectCodeSource,
  CODE_LIMITS,
  type CodeSettings,
} from '@pertexo/node-sdk';
import { CodeField } from './field';
import { formatByteLength } from '@/lib/format/bytes';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
} from '@/components/ui/field';
import type { NodeConfig } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { SchemaField } from '../fields/schema-field';

/** Syntax checks never execute code; previews use the ordinary worker path. */
export function CodeSetup({
  config,
  form,
  settings,
}: Readonly<{
  config: NodeConfig;
  form: NodeFormApi;
  settings: CodeSettings | undefined;
}>) {
  const id = fieldControlId(form.nodeId, 'code');
  const source = typeof config.code === 'string' ? config.code : '';
  const issue = inspectCodeSource(source);
  const defaultSeconds =
    settings === undefined
      ? undefined
      : Math.min(CODE_LIMITS.defaultTimeoutSeconds, settings.maximumSeconds);
  return (
    <>
      <Field data-invalid={issue !== undefined}>
        <p
          id={`${id}-label`}
          className="text-[0.8rem] font-semibold text-foreground/85"
        >
          JavaScript
        </p>
        <FieldControl>
          <CodeField
            id={id}
            value={source}
            editable={form.editable}
            invalid={issue !== undefined}
            describedBy={`${id}-hint${issue === undefined ? '' : ` ${id}-error`}`}
            onChange={(code) => {
              form.commit(
                (node) => ({ config: { ...node.config, code } }),
                `${form.nodeId}:config:code`,
              );
            }}
          />
        </FieldControl>
        <FieldDescription id={`${id}-hint`}>
          Return JSON from input and $vars. Await is supported. Code runs in an
          isolated process without network access. Use HTTP Request to contact a
          service.
        </FieldDescription>
        {issue === undefined ? null : (
          <FieldError id={`${id}-error`}>
            Line {issue.line}, column {issue.column}: {issue.message}
          </FieldError>
        )}
        <p className="font-mono text-[0.7rem] text-subtle-foreground">
          {formatByteLength(new TextEncoder().encode(source).byteLength)} /{' '}
          {formatByteLength(CODE_LIMITS.sourceBytes)} · Tab moves focus
        </p>
      </Field>
      <SchemaField
        config={config}
        form={form}
        field={{
          key: 'timeoutSeconds',
          label: 'Time limit (seconds)',
          kind: 'integer',
          minimum: 1,
          ...(settings === undefined
            ? {}
            : { maximum: settings.maximumSeconds }),
          required: false,
          description:
            defaultSeconds === undefined
              ? 'Instance time limits are unavailable.'
              : `Defaults to ${String(defaultSeconds)} seconds. Maximum ${String(settings?.maximumSeconds)} seconds.`,
        }}
      />
      <p className="text-xs text-muted-foreground">
        {settings === undefined
          ? 'Instance limits are unavailable. Reload to try again.'
          : !settings.enabled
            ? 'Code steps are disabled on this instance.'
            : `${String(settings.memoryMiB)} MB heap · ${String(settings.concurrency)} Code tasks at once. No network or credentials.`}
      </p>
    </>
  );
}
