# QueueFlow

Restaurant queue management demo built with React, TypeScript, Vite, and a bundled Node mock backend.

This repo now also includes a merchant-provisioning foundation for a multi-store Queue SaaS:

- merchant self-service store creation in remote mode
- auto-generated unique `storeId` and temporary password
- per-store customer QR links
- merchant store profile and plan metadata
- shared queue operations across merchant devices

## Scripts

- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run test`
- `npm run preview`
- `npm run server`
- `npm run dev:remote`

## Go Live Preview

`Go Live` serves the built static preview from `app.html`.

- Run `npm run build` after source changes.
- Refresh Live Server to see the latest build output.
- Use `npm run dev` for normal Vite development with HMR.

## Sync Modes

### Local mode

Default mode. Queue state is stored in browser `localStorage`.

- Best for a single-device demo or kiosk.
- No backend is required.

### Remote mode

Shared multi-device mode backed by the bundled API server.

1. Copy [.env.remote.example](/c:/Users/Look Zhengyu/Desktop/quvery systerm/.env.remote.example:1) to `.env.local`.
2. Adjust any values you want to override.
3. Run `npm run dev:remote`.

Both the Vite frontend and the Node backend now load `.env.local`.

Public production deployments auto-target the same-origin `/api` backend when
`VITE_QUEUE_SYNC_MODE` is not set. Set `VITE_QUEUE_SYNC_MODE=local` if you want
to force a static local-only demo build.

Default remote values:

```bash
VITE_QUEUE_SYNC_MODE=remote
VITE_QUEUE_API_BASE_URL=http://127.0.0.1:8787
VITE_DEFAULT_STORE_ID=RESTO-001
DEFAULT_STORE_ID=RESTO-001
DEFAULT_STORE_PASSWORD=admin123
```

Optional frontend QR value:

```bash
VITE_PUBLIC_APP_URL=https://queue.yourdomain.com
```

If `VITE_PUBLIC_APP_URL` is set, merchant QR downloads point at that exact public app URL. If it is omitted, QR links fall back to the current browser origin and pathname.

Optional Gmail notification values:

```bash
QUEUE_GMAIL_USER=your@gmail.com
QUEUE_GMAIL_APP_PASSWORD=your-16-char-app-password
QUEUE_EMAIL_FROM=QueueFlow <your@gmail.com>
```

If Gmail is not configured, queue-call notifications are still logged, but marked as `skipped`.

Optional customer background push notification values:

```bash
VITE_WEB_PUSH_VAPID_PUBLIC_KEY=BK...
QUEUE_WEB_PUSH_VAPID_PUBLIC_KEY=BK...
QUEUE_WEB_PUSH_VAPID_PRIVATE_KEY=...
QUEUE_WEB_PUSH_SUBJECT=https://queue.yourdomain.com
```

Generate the VAPID keys once with:

```bash
npx web-push generate-vapid-keys --json
```

When these values are configured, customers who allow notifications can still receive a queue alert after closing the page.

iPhone and iPad requirements:

- Web push works only on iOS/iPadOS 16.4+ Home Screen web apps. Customers must open the QR link in Safari, tap Share, choose Add to Home Screen, then open QueueFlow from that Home Screen icon before enabling notifications.
- The live site must be HTTPS and must include the VAPID keys above. If these keys are missing, the app will now show a setup warning instead of pretending alerts are enabled.
- iOS notification sound and Focus behavior are controlled by the phone's notification settings. The app can request a visible alert, but it cannot force custom sound on every device.

Optional backend runtime values:

```bash
QUEUEFLOW_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
QUEUEFLOW_DATA_DIR=./server/.data
QUEUEFLOW_MAX_JSON_BODY_BYTES=65536
QUEUEFLOW_MAX_WEBHOOK_BODY_BYTES=524288
```

## Backend Capabilities

The mock backend now covers the core shared-queue workflow:

- SQLite persistence in `server/.data/queueflow.sqlite`
- legacy JSON migration from `server/.data/stores.json`
- hashed merchant credentials
- merchant session login/logout
- merchant self-service provisioning with auto-created store IDs
- merchant profile storage for owner, plan, billing cycle, and QR issuance
- public queue reads with customer phone and email redacted
- customer join with optional email capture
- customer web push subscription registration for background alerts
- customer token enforcement for public customer actions
- version-based conflict detection for merchant write actions
- notification log storage for email attempts
- queue activity history for merchant analytics
- optional Gmail send on `call customer`
- optional Web Push send on `call customer`
- automatic call expiry timer with table release
- queue clear operation that keeps the current table layout
- merchant-generated per-store customer QR links

Default merchant credentials:

- `RESTO-001 / admin123`

## Remote API Contract

### Merchant auth

- `POST /merchant/register`
- `POST /auth/login`
- `GET /auth/session`
- `POST /auth/logout`

### Merchant-only queue routes

- `GET /stores/:storeId/queue-state`
- `GET /stores/:storeId/profile`
- `POST /stores/:storeId/profile`
- `GET /stores/:storeId/notification-logs`
- `GET /stores/:storeId/queue-events`
- `POST /stores/:storeId/tables/configure`
- `POST /stores/:storeId/tables/:tableId/release`
- `POST /stores/:storeId/clear-queue`
- `POST /stores/:storeId/customers/:customerId/call`
- `POST /stores/:storeId/customers/:customerId/remove`
- `POST /stores/:storeId/reset`

Merchant write actions accept `expectedVersion`. If another device changed the queue first, the backend returns `409` with the latest state.

### Public/customer routes

- `GET /stores/:storeId/public-queue-state`
- `POST /stores/:storeId/customers/join`
- `POST /stores/:storeId/customers/:customerId/push-subscriptions`
- `POST /stores/:storeId/customers/:customerId/confirm`
- `POST /stores/:storeId/customers/:customerId/seat`
- `POST /stores/:storeId/customers/:customerId/expire`
- `POST /stores/:storeId/customers/:customerId/leave`

`POST /stores/:storeId/customers/join` returns a `customerToken`. Public customer actions must send that token in `X-Queue-Customer-Token`.

## Notes

- The frontend still caches queue state locally so the UI can survive refreshes or a temporary backend outage.
- Merchant auth is separate from the shared queue document.
- Merchant passwords are now stored as hashed credentials in SQLite.
- `public-queue-state` intentionally removes customer phone numbers and email addresses.
- Notification logs are merchant-only and include `pending`, `sent`, `skipped`, or `failed`.
- Activity history is merchant-only and powers the Recent Activity panel in remote mode.
- Merchant dashboard routes now use clean paths such as `/merchant`, `/merchant/tables`, `/merchant/logs`, and `/merchant/activity`.
- Customer QR links now use the format `/customer?store=RESTO-001`.
- A QR-scanned customer link opens the customer portal directly and keeps that store ID pinned for public queue actions.
- The merchant login screen in remote mode now supports `Create Store`, which provisions a new merchant account and signs it in immediately.
