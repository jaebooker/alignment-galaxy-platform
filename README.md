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

## Useful Commands

```bash
npm start
npm test
```

`npm test` runs the Postgres smoke test when `DATABASE_URL` or `TEST_DATABASE_URL` is present. Without a database URL, the integration test is skipped.

## Implemented Flows

- Cookie-backed demo sessions: role switches create real server sessions, and protected API routes use the session actor instead of trusting browser-supplied user IDs.
- Contributor marketplace: browse open tasks, claim gated tasks, submit artifacts, complete a screening task.
- Customer workspace: create new commercial or public-good tasks and monitor engagement status.
- Reviewer queue: inspect submitted work, score it, approve or reject it.
- Customer delivery packets: assemble approved submissions into buyer-facing packets with review summaries.
- Admin operations: monitor public-good allocation, reputation, review backlog, delivery readiness, and pending payouts.
- API foundation: task posting, claiming, submission, review, screening, reset, and bootstrap endpoints.
- Database foundation: `database/schema.sql` maps the MVP objects to Postgres tables.
- Storage adapter: `lib/postgresStore.js` reads and writes the app state through the relational schema.

## Next Build Steps

- Replace demo session creation with Clerk/Auth0 OAuth and keep the same server-side role checks.
- Connect Stripe Connect for contributor onboarding and transfers.
- Add file storage for uploaded submission artifacts.
- Turn delivery packets into exported reports with customer approval and payout release controls.
