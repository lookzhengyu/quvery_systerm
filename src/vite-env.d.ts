/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_QUEUE_SYNC_MODE?: 'local' | 'remote';
  readonly VITE_QUEUE_API_BASE_URL?: string;
  readonly VITE_DEFAULT_STORE_ID?: string;
  readonly VITE_PUBLIC_APP_URL?: string;
  readonly VITE_WEB_PUSH_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
