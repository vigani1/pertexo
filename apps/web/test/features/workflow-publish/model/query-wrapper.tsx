import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
export function QueryWrapper({ children }: Readonly<{ children: ReactNode }>) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    children,
  );
}
