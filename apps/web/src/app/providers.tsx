'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { ToastProvider } from '@/components/ui';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Server state changes arrive over the websocket, so aggressive
            // polling is unnecessary — but a short stale time keeps tab
            // switches feeling instant.
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            retry: (failureCount, error) => {
              // Never retry a 401/403/404: the answer will not change, and
              // retrying an auth failure just delays the redirect to login.
              if (error instanceof ApiError && error.status < 500) return false;
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
