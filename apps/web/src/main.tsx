import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/hanken-grotesk/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createQueryClient } from './app/query-client';
import { createAppRouter } from './app/router';
import { createBrowserApiClient } from './lib/api/browser-client';
import { subscribeSessionChanges } from './features/auth/session-sync.public';

const container = document.getElementById('root');
if (!container) throw new Error('Missing application root');
const queryClient = createQueryClient();
const apiClient = createBrowserApiClient();
const router = createAppRouter(queryClient, apiClient);

subscribeSessionChanges(() => {
  const editorIsOpen = router.state.matches.some(
    (match) => match.routeId === '/w/$workspaceId/workflows/$workflowId',
  );
  void queryClient.cancelQueries().then(() => {
    queryClient.clear();
    // The editor owns a recoverable in-memory draft and pauses on this same
    // signal. Invalidating its route here would discard unapplied scratch.
    if (!editorIsOpen) void router.invalidate();
  });
});

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
