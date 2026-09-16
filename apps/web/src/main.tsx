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

const container = document.getElementById('root');
if (!container) throw new Error('Missing application root');
const queryClient = createQueryClient();
const apiClient = createBrowserApiClient();
const router = createAppRouter(queryClient, apiClient);

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
