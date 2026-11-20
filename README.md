# ShareKit API · The engine behind sharing

<p align="center">
  <strong>Listings in. Bookings through. Good gear back in circulation.</strong><br />
  The API that keeps the ShareKit rental marketplace moving.
</p>

<p align="center">
  <a href="https://sharekit-server.vercel.app/">Live API</a> ·
  <a href="https://sharekit-server.vercel.app/api/health">Health check</a> ·
  <a href="https://sharekit-client.vercel.app/">ShareKit app</a> ·
  <a href="https://github.com/nnasif78/sharekit-client">Client repository</a>
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=white" />
  <img alt="Express 5" src="https://img.shields.io/badge/Express-5-000000?logo=express" />
  <img alt="MongoDB" src="https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white" />
  <img alt="Vercel deployment" src="https://img.shields.io/badge/deployed-on%20Vercel-black?logo=vercel" />
</p>

---

## One API. Every handoff.

ShareKit connects renters, equipment owners, and marketplace admins with a MongoDB-backed Express API. It handles the flow from discovering available equipment to reserving inventory, confirming payment, managing rentals, and returning items to availability when a rental ends.

## What it powers

- **Equipment discovery and management** — searchable, filterable listings with availability and owner controls.
- **Rental workflows** — inventory-aware reservations, booking status, and customer and owner rental views.
- **Payments** — hosted Stripe Checkout, signed webhook processing, and checkout cancellation.
- **Authentication and access** — Better Auth sessions exchanged by the client for short-lived JWTs, with renter, owner, and admin role checks.
- **Marketplace operations** — favorites, moderation, dashboards, and analytics endpoints.
- **Automatic follow-through** — rental completion, inventory release, and optional email notifications.

## Live endpoints

The deployed API is **[sharekit-server.vercel.app](https://sharekit-server.vercel.app/)**.

```text
GET  /api/health                         API and database health
GET  /api/equipment                      Browse approved equipment
POST /api/customer/equipment/:id/checkout Start a Stripe Checkout
POST /api/stripe/webhook                 Process verified Stripe events
GET  /api/cron/complete-rentals          Complete rentals due for return
```

Most customer, owner, and admin routes require a valid bearer token and the appropriate role. The health route does not require authentication. See [`index.js`](./index.js) for the complete route definitions.

## Run it locally

```bash
git clone https://github.com/nnasif78/sharekit-server.git
cd sharekit-server
npm install
npm start
```

The API listens on port `5000` by default. Set the following values in `.env`:

```dotenv
MONGODB_URI=your-mongodb-connection-string
BETTER_AUTH_SECRET=your-auth-secret
BETTER_AUTH_URL=http://localhost:5000
CLIENT_URL=http://localhost:3000
```

### Optional integrations

```dotenv
PORT=5000
DB_NAME=sharekit
STRIPE_SECRET_KEY=your-stripe-secret-key
STRIPE_WEBHOOK_SECRET=your-stripe-webhook-signing-secret
STRIPE_CURRENCY=bdt
RESEND_API_KEY=your-resend-api-key
EMAIL_FROM=ShareKit <updates@example.com>
CRON_SECRET=your-cron-endpoint-secret
```

Stripe keys enable checkout and signed webhook handling. Configure Stripe to send checkout events to `/api/stripe/webhook`. Resend credentials enable rental email notifications; without them, notifications are skipped. `CRON_SECRET` protects the rental completion endpoint, which a scheduler can call with `Authorization: Bearer <CRON_SECRET>`.

## Built with

Node.js · Express 5 · MongoDB · Better Auth · Stripe · Resend · `jose` · `node-cron`

## Connect the client

Set `NEXT_PUBLIC_API_URL` in the [ShareKit client](https://github.com/nnasif78/sharekit-client) to this API origin, and set `CLIENT_URL` here to the deployed client origin.

**[Open the ShareKit app →](https://sharekit-client.vercel.app/)**
