import { useState, type ReactNode } from 'react';
import { createEditorStore } from './store';
import { EditorStoreContext, EditorSessionContext } from './context';
import type { EditorSession } from './session';

export function EditorProvider({
  children,
  initial,
}: Readonly<{
  children: ReactNode;
  initial: Parameters<typeof createEditorStore>[0];
}>) {
  const [store] = useState(() => createEditorStore(initial));
  return <EditorStoreContext value={store}>{children}</EditorStoreContext>;
}

/** Keep live session references separate from the stable draft-store context. */
export function EditorSessionProvider({
  children,
  ...session
}: EditorSession & Readonly<{ children: ReactNode }>) {
  return (
    <EditorSessionContext value={session}>{children}</EditorSessionContext>
  );
}
