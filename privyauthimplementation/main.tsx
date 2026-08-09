/**
 * main.tsx — where the provider mounts
 * =====================================
 * AppPrivyProvider wraps everything. It must be high in the tree
 * so any component can call usePrivy() / useWallets().
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppPrivyProvider } from './providers/AppPrivyProvider'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppPrivyProvider>
      <App />
    </AppPrivyProvider>
  </React.StrictMode>
)
