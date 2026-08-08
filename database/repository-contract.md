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

## Migration Notes

- In production, `transaction(mutator)` should become explicit SQL transactions around narrower repository methods rather than full-state snapshots.
- `sessions.session_token_hash` stores a SHA-256 hash of the cookie token.
- API handlers should continue to resolve the actor server-side from the session, then pass actor context into domain operations.
