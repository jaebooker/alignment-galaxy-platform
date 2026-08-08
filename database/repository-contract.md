# Repository Contract

The MVP currently uses `lib/jsonStore.js` as a local adapter. A Postgres adapter should keep the same shape:

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
- `write(state)` persists one complete state snapshot.
- `reset()` restores seed data for local demos only.
- `transaction(mutator)` loads state, lets domain services mutate it, then commits the result atomically.

## Migration Notes

- In production, `transaction(mutator)` should become explicit SQL transactions around repository methods rather than full-state snapshots.
- `sessions.session_token_hash` should store a hash of the cookie token, not the raw token used by the local demo store.
- API handlers should continue to resolve the actor server-side from the session, then pass actor context into domain operations.
