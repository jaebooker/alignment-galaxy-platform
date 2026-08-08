# Alignment Galaxy Platform

This is the first working MVP slice for Alignment Galaxy: a marketplace where vetted customers post AI safety tasks, vetted contributors claim and submit work, reviewers quality-check submissions, and admins track reputation and payout readiness.

## Run Locally

```bash
npm install
docker compose up -d db
npm start
```

Open `http://localhost:3000`.

The app auto-loads an ignored local `.env` file before starting. The checked-in `.env.example` documents the expected variables; copy values from it or edit `.env` locally for database, Stripe, OAuth, upload, and base URL settings.

The app uses Postgres for persistence. On first launch, `lib/postgresStore.js` runs `database/schema.sql` and seeds an empty database from `data/seed.json`.

For SSL-required hosted Postgres providers, include `sslmode=require` in `DATABASE_URL` or set `PGSSLMODE=require`.

Uploaded artifact files are stored on disk under `ALIGNMENT_GALAXY_UPLOAD_DIR`, which defaults to `storage/artifacts`. Metadata, hashes, and access checks are stored in Postgres through `submission_files`. The default upload limit is 10 MB per file and can be changed with `ALIGNMENT_GALAXY_MAX_UPLOAD_BYTES`.

## Stripe Connect Setup

Set `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_COUNTRY`, `STRIPE_CURRENCY`, and `APP_BASE_URL` to enable real Stripe Connect onboarding links and transfer creation. Without `STRIPE_SECRET_KEY`, the app runs in demo mode: contributor onboarding marks the local profile ready and payout release records deterministic `tr_demo_*` transfer IDs without contacting Stripe.

## OAuth Setup

The app supports generic OIDC, Auth0, or Clerk through the same callback route:

```text
http://localhost:3000/auth/callback
```

Set `AUTH_SESSION_SECRET`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and optionally `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI`. Auth0 aliases such as `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET` are also accepted. Clerk aliases such as `CLERK_ISSUER_URL`, `CLERK_CLIENT_ID`, and `CLERK_CLIENT_SECRET` are accepted too.

## Useful Commands

```bash
npm start
npm test
```

`npm test` runs the Postgres smoke test when `DATABASE_URL` or `TEST_DATABASE_URL` is present. Without a database URL, the integration test is skipped.

## Implemented Flows

- OAuth-backed sessions: Auth0, Clerk, or generic OIDC sign-in links external identities to platform users, hashes session tokens, and keeps role checks server-side.
- Contributor marketplace: browse open tasks, claim gated tasks, submit artifacts, complete a screening task.
- Uploaded artifacts: contributors can attach files to submissions, and authorized contributors, reviewers, admins, and owning customers can download them.
- Stripe Connect onboarding: contributors can start hosted onboarding, sync account requirements, and expose payout readiness to review/admin workflows.
- Customer workspace: create new commercial or public-good tasks and monitor engagement status.
- Reviewer queue: inspect submitted work, score it, approve or reject it.
- Customer delivery packets: assemble approved submissions into buyer-facing packets, export Markdown reports, and record customer approval or requested changes.
- Admin operations: monitor public-good allocation, reputation, review backlog, delivery readiness, and release customer-approved payouts through Stripe transfers.
- API foundation: task posting, claiming, submission, review, delivery export, customer approval, payout release, screening, reset, and bootstrap endpoints.
- Database foundation: `database/schema.sql` maps the MVP objects to Postgres tables.
- Storage adapter: `lib/postgresStore.js` reads and writes the app state through the relational schema.

## Next Build Steps

- Add Stripe webhooks for account requirement changes and transfer failure reconciliation.
- Generate branded PDF reports from exported delivery packet Markdown.
