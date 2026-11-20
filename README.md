# ShareKit API

The ShareKit API is an Express service backed by MongoDB. BetterAuth establishes user sessions; a same-origin client endpoint exchanges an authenticated session for a short-lived JWT access token. The API validates that JWT with `verifyToken` and checks renter, owner, or admin access with role-specific middleware. The API also handles equipment listings, rental reservations, Stripe Checkout and webhooks, analytics, email notifications, and scheduled rental completion.

## Live URL

The deployed API URL is not configured in this repository. Set the client’s `NEXT_PUBLIC_API_URL` and this server’s `CLIENT_URL` to the deployed origins.

## Run locally

Create a server `.env` file with the required configuration and start the API:

```bash
npm install
node index.js
```

The service listens on port `5000` by default. `GET /api/health` reports API and database connectivity.

## Configuration

Required for normal operation:

- `MONGODB_URI` — MongoDB connection string.
- `BETTER_AUTH_SECRET` — BetterAuth session secret.
- `BETTER_AUTH_URL` — public server origin used by BetterAuth.
- `CLIENT_URL` — allowed client origin and return URL for checkout.

Required for their respective features:

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — hosted checkout and verified payment webhooks.
- `RESEND_API_KEY`, `EMAIL_FROM` — booking and rental-status email notifications through Resend.
- `DB_NAME` — optional database name (defaults to `sharekit`).
- `PORT` — optional HTTP port (defaults to `5000`).

Email notifications are logged as skipped when Resend is not configured. The `node-cron` job checks for approved rentals whose end date has passed at startup and at the top of every UTC hour, marks them completed, returns their reserved quantity to available inventory, and notifies the renter and owner when email is configured.

## Main packages

- `express`, `cors`, `dotenv` — HTTP API, cross-origin configuration, and environment loading.
- `mongodb` — persistence for users, equipment, rentals, payments, and reservations.
- `better-auth`, `@better-auth/mongo-adapter` — session authentication.
- `stripe` — checkout and webhook integration.
- `node-cron` — scheduled rental completion.
- `jose`, `zod` — token and schema utilities.
