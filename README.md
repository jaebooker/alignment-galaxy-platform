# Alignment Galaxy Platform

This is the first working MVP slice for Alignment Galaxy: a marketplace where vetted customers post AI safety tasks, vetted contributors claim and submit work, reviewers quality-check submissions, and admins track reputation and payout readiness.

## Run Locally

```bash
npm start
```

Open `http://localhost:3000`.

The app uses only built-in Node and browser APIs, so it can run without a dependency install. Data persists to `data/alignment-galaxy.local.json`, which is created from `data/seed.json` on first launch.

## Implemented Flows

- Cookie-backed demo sessions: role switches create real server sessions, and protected API routes use the session actor instead of trusting browser-supplied user IDs.
- Contributor marketplace: browse open tasks, claim gated tasks, submit artifacts, complete a screening task.
- Customer workspace: create new commercial or public-good tasks and monitor engagement status.
- Reviewer queue: inspect submitted work, score it, approve or reject it.
- Customer delivery packets: assemble approved submissions into buyer-facing packets with review summaries.
- Admin operations: monitor public-good allocation, reputation, review backlog, delivery readiness, and pending payouts.
- API foundation: task posting, claiming, submission, review, screening, reset, and bootstrap endpoints.
- Database plan: `database/schema.sql` maps the MVP objects to a future Postgres schema.
- Storage adapter: `lib/jsonStore.js` is the local repository boundary to replace with Neon/Supabase/Postgres later.

## Next Build Steps

- Replace `lib/jsonStore.js` with a Postgres adapter using the schema in `database/schema.sql`.
- Replace demo session creation with Clerk/Auth0 OAuth and keep the same server-side role checks.
- Connect Stripe Connect for contributor onboarding and transfers.
- Add file storage for uploaded submission artifacts.
- Turn delivery packets into exported reports with customer approval and payout release controls.
