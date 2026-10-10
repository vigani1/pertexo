import { useState, type ReactNode } from 'react';
import { createEditorStore } from './store';
import { EditorStoreContext } from './context';

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
