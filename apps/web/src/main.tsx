import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import { NeonBucksProvider } from './NeonBucksStore.tsx';
import { CurrencyProvider } from './CurrencyStore.tsx';
import { DeferredAuthProvider } from './auth';
import { NotificationsProvider } from './notifications/NotificationsStore.tsx';
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
      {/* Auth is DEFERRED, not absent: this renders <App/> immediately and
          streams the ~800 kB (gzipped) Privy/wallet stack in on idle, then
          publishes its state through useAuth(). Components call useAuth(),
          never usePrivy() — see src/auth/index.tsx for the whole story. */}
      <DeferredAuthProvider>
        <QueryClientProvider client={queryClient}>
          <NeonBucksProvider>
            {/* Display currency (AUD/USD/…): read by every real-money
                amount on screen. Inside NeonBucks because practice bucks
                are unaffected by it, outside App so the sidebar, wallet
                panel and settings all share one source of truth. */}
            <CurrencyProvider>
              {/* Invites / messages / friend requests, in ONE place: the nav
                  bell, the sidebar's JOIN button and the in-app pop-ups all
                  read this store, and exactly one socket listener writes to
                  it. Above <App/> because the pop-up queue must survive every
                  view change — an invite that arrives mid-match is replayed
                  when the match ends, not lost with the screen. */}
              <NotificationsProvider>
                <App />
              </NotificationsProvider>
            </CurrencyProvider>
          </NeonBucksProvider>
        </QueryClientProvider>
      </DeferredAuthProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
