import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import { NeonBucksProvider } from './NeonBucksStore.tsx';
import { AppPrivyProvider } from './providers/AppPrivyProvider.tsx';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

// Silence Three.js Clock deprecation warnings originating from @react-three/fiber upstream package
const originalWarn = console.warn;
console.warn = (...args) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('THREE.Clock: This module has been deprecated') ||
     args[0].includes('THREE.Clock'))
  ) {
    return;
  }
  originalWarn(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost so even a provider crash shows the error screen, not white */}
    <AppErrorBoundary>
      {/* Privy wraps everything so any component can call usePrivy()/useWallets() */}
      <AppPrivyProvider>
        <QueryClientProvider client={queryClient}>
          <NeonBucksProvider>
            <App />
          </NeonBucksProvider>
        </QueryClientProvider>
      </AppPrivyProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
