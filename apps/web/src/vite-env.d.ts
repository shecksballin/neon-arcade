/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Hono API base URL (default http://localhost:3002) */
  readonly VITE_API_URL?: string
  /** Socket.io URL (default http://localhost:3002) */
  readonly VITE_WS_URL?: string
  /** Public 25-char app id from dashboard.privy.io — enables wallet login */
  readonly VITE_PRIVY_APP_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
