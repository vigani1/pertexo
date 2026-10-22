import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isChunkLoadError } from '@/components/patterns/app-update/lazy';
import { AppUpdatedNotice } from '@/components/patterns/app-update/notice';
import type { CodeSyntaxIssue } from '@pertexo/node-sdk';
import { FieldError } from '@/components/ui/field';
import {
  createCodeEditor,
  type CodeFieldProps,
  type CodeEditor,
} from './editor';

/** CodeMirror owns the view; the workflow draft owns the document. */
export function CodeField(props: CodeFieldProps) {
  const [syntax, setSyntax] =
    useState<Readonly<{ source: string; issue: CodeSyntaxIssue }>>();
  const issue =
    props.language === 'python' && syntax?.source === props.value
      ? syntax.issue
      : undefined;
  const effective = {
    ...props,
    invalid: props.invalid || issue !== undefined,
    describedBy:
      props.describedBy +
      (issue === undefined ? '' : ` ${props.id}-syntax-error`),
  };
  const latest = useRef(effective);
  const editor = useRef<CodeEditor | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'updated' | 'failed'
  >('loading');
  const attach = useCallback((parent: HTMLDivElement | null) => {
    if (parent === null) return;
    const lifetime = new AbortController();
    void createCodeEditor(
      parent,
      () => latest.current,
      lifetime.signal,
      (source, issue) => {
        if (!lifetime.signal.aborted)
          setSyntax(issue === undefined ? undefined : { source, issue });
      },
    )
      .then((created) => {
        if (created === undefined) return;
        if (lifetime.signal.aborted) {
          created.destroy();
          return;
        }
        editor.current = created;
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!lifetime.signal.aborted)
          setStatus(isChunkLoadError(error) ? 'updated' : 'failed');
      });
    return () => {
      lifetime.abort();
      editor.current?.destroy();
      editor.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    latest.current = effective;
    editor.current?.sync(effective);
  });
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-input bg-input/30 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
      {status === 'loading' ? (
        <p role="status" className="p-3 text-xs text-muted-foreground">
          Loading code editor…
        </p>
      ) : null}
      {status === 'updated' ? (
        <div className="p-2">
          <AppUpdatedNotice />
        </div>
      ) : null}
      {status === 'failed' ? (
        <p role="alert" className="p-3 text-xs text-destructive">
          Couldn’t load the code editor. Reload the page to try again.
        </p>
      ) : null}
      <div ref={attach} />
      {issue === undefined ? null : (
        <FieldError id={`${props.id}-syntax-error`} className="px-3 pb-3">
          Line {issue.line}, column {issue.column}: {issue.message}
        </FieldError>
      )}
    </div>
  );
}
