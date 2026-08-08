# Repository Contract

The MVP uses `lib/postgresStore.js` as the persistence adapter. It keeps the same state-level shape the API handlers were built around:

```js
{
  read(),
  write(state),
  reset(),
  transaction(mutator)
}
```

## Adapter Expectations

- `read()` returns the full normalized application state for the current tenant/demo workspace.
- `write(state)` persists one complete state snapshot into relational tables.
- `reset()` restores seed data for local demos only.
- `transaction(mutator)` loads state, lets domain services mutate it, then commits the result inside a SQL transaction.
- `auth_identities` links OAuth provider subjects to local platform users, keeping local role and verification checks authoritative.
- `submission_files` stores metadata and checksums for uploaded artifacts; `lib/fileStorage.js` owns binary persistence and can be swapped for object storage later.
- `delivery_packets` stores the exported report Markdown, customer approval metadata, and packet-level payout release metadata.
- `payouts` are created by approved reviews, but transition to `transferred` only through the admin payout release control after customer approval.

## Migration Notes

- In production, `transaction(mutator)` should become explicit SQL transactions around narrower repository methods rather than full-state snapshots.
- `sessions.session_token_hash` stores a SHA-256 hash of the cookie token.
- API handlers should continue to resolve the actor server-side from the session, then pass actor context into domain operations.
- The current report export format is Markdown generated from normalized packet state; future PDF/object-storage exports should preserve the same approval and release gates.
