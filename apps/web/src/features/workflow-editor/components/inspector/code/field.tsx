import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isChunkLoadError } from '@/components/patterns/app-update/lazy';
import { AppUpdatedNotice } from '@/components/patterns/app-update/notice';
import {
  createCodeEditor,
  type CodeFieldProps,
  type CodeEditor,
} from './editor';

/** CodeMirror owns the view; the workflow draft owns the document. */
export function CodeField(props: CodeFieldProps) {
  const latest = useRef(props);
  const editor = useRef<CodeEditor | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'updated' | 'failed'
  >('loading');
  const attach = useCallback((parent: HTMLDivElement | null) => {
    if (parent === null) return;
    const lifetime = new AbortController();
    void createCodeEditor(parent, () => latest.current, lifetime.signal)
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
    latest.current = props;
    editor.current?.sync(props);
  }, [props]);
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-input bg-input/30 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
      {status === 'loading' ? (
        <p role="status" className="p-3 text-xs text-muted-foreground">
          Loading JavaScript editor…
        </p>
      ) : null}
      {status === 'updated' ? (
        <div className="p-2">
          <AppUpdatedNotice />
        </div>
      ) : null}
      {status === 'failed' ? (
        <p role="alert" className="p-3 text-xs text-destructive">
          Couldn’t load the JavaScript editor. Reload the page to try again.
        </p>
      ) : null}
      <div ref={attach} />
    </div>
  );
}
