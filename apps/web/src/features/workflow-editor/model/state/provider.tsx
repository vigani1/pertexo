import { useState, type ReactNode } from 'react';
import { createEditorStore } from './store';
import { EditorStoreContext, useEditorStoreApi } from './context';
import type { EditorSession } from './session';

export function EditorProvider({
  children,
  initial,
}: Readonly<{
  children: ReactNode;
  initial: Parameters<typeof createEditorStore>[0];
}>) {
  const [store] = useState(() => createEditorStore(initial));
  return <EditorStoreContext value={{ store }}>{children}</EditorStoreContext>;
}

/** Populate the existing scope after the session's live queries and commands are ready. */
export function EditorSessionProvider({
  children,
  ...session
}: EditorSession & Readonly<{ children: ReactNode }>) {
  const store = useEditorStoreApi();
  return (
    <EditorStoreContext value={{ store, session }}>
      {children}
    </EditorStoreContext>
  );
}
