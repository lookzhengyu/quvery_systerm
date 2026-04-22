# QueueFlow Live Setup

This project already supports live merchant subscriptions and real customer email alerts.
What still needs to be added before production is environment configuration.

## 1. Public app URL

Set the frontend app URL so generated QR codes point to your real domain:

```env
VITE_PUBLIC_APP_URL=https://queue.yourdomain.com/app.html
```

Do not print the merchant QR while it still points to `localhost`, `127.0.0.1`, or a private LAN address.
Use an HTTPS URL for production so customer access and browser notifications work reliably.

## 2. Email delivery

Recommended for production:

```env
QUEUE_SMTP_HOST=smtp.yourprovider.com
QUEUE_SMTP_PORT=587
QUEUE_SMTP_SECURE=false
QUEUE_SMTP_USER=your-smtp-user
QUEUE_SMTP_PASSWORD=your-smtp-password
QUEUE_EMAIL_FROM=QueueFlow <noreply@yourdomain.com>
```

Testing / low volume option:

```env
QUEUE_GMAIL_USER=your@gmail.com
QUEUE_GMAIL_APP_PASSWORD=your-16-char-app-password
QUEUE_EMAIL_FROM=QueueFlow <your@gmail.com>
```

## 3. Stripe subscriptions

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
QUEUEFLOW_STRIPE_CURRENCY=usd
QUEUEFLOW_STRIPE_STARTER_MONTHLY_AMOUNT=4900
QUEUEFLOW_STRIPE_GROWTH_MONTHLY_AMOUNT=9900
QUEUEFLOW_STRIPE_SCALE_MONTHLY_AMOUNT=19900
```

Webhook target:

```text
POST https://your-backend-domain/stripe/webhook
```

## 4. Smoke checklist

1. Merchant opens Store Control Center and confirms Stripe shows `Ready`.
2. Merchant confirms Customer Notifications shows `Ready`.
3. Merchant clicks `Send Test Email` and receives the mail.
4. Merchant opens QR modal and checks the QR points to the live customer URL.
5. Merchant starts a subscription checkout and returns with billing success.
6. Customer joins queue, merchant calls customer, customer receives email alert.

## 5. Database

The current app runs on a local SQLite file, which is fine for development and demos.
For real paid production, plan a managed Postgres upgrade next.

See: [database-production.md](./database-production.md)
