# Alignment Galaxy Platform

This is the first working MVP slice for Alignment Galaxy: a marketplace where vetted customers post AI safety tasks, vetted contributors claim and submit work, reviewers quality-check submissions, and admins track reputation and payout readiness.

## Run Locally

```bash
npm install
docker compose up -d db
DATABASE_URL=postgres://alignment_galaxy:alignment_galaxy@localhost:5432/alignment_galaxy npm start
```

Open `http://localhost:3000`.

The app uses Postgres for persistence. On first launch, `lib/postgresStore.js` runs `database/schema.sql` and seeds an empty database from `data/seed.json`.

For SSL-required hosted Postgres providers, include `sslmode=require` in `DATABASE_URL` or set `PGSSLMODE=require`.
`.env.example` documents the expected environment variables for hosts that load env files.

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
- Customer workspace: create new commercial or public-good tasks and monitor engagement status.
- Reviewer queue: inspect submitted work, score it, approve or reject it.
- Customer delivery packets: assemble approved submissions into buyer-facing packets with review summaries.
- Admin operations: monitor public-good allocation, reputation, review backlog, delivery readiness, and pending payouts.
- API foundation: task posting, claiming, submission, review, screening, reset, and bootstrap endpoints.
- Database foundation: `database/schema.sql` maps the MVP objects to Postgres tables.
- Storage adapter: `lib/postgresStore.js` reads and writes the app state through the relational schema.

## Next Build Steps

- Connect Stripe Connect for contributor onboarding and transfers.
- Add file storage for uploaded submission artifacts.
- Turn delivery packets into exported reports with customer approval and payout release controls.
