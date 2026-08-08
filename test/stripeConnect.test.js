const test = require("node:test");
const assert = require("node:assert/strict");
const { createStripeConnectClient } = require("../lib/stripeConnect");

test("Stripe Connect client creates accounts, links, syncs status, and transfers", async () => {
  const calls = [];
  const client = createStripeConnectClient({
    secretKey: "sk_test_alignment",
    apiBase: "https://stripe.test/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/accounts")) {
        return jsonResponse({
          id: "acct_123",
          details_submitted: false,
          payouts_enabled: false,
          capabilities: { transfers: "pending" },
          requirements: { currently_due: ["external_account"], eventually_due: [] }
        });
      }
      if (url.endsWith("/account_links")) {
        return jsonResponse({ url: "https://connect.stripe.test/onboard" });
      }
      if (url.endsWith("/accounts/acct_123")) {
        return jsonResponse({
          id: "acct_123",
          details_submitted: true,
          payouts_enabled: true,
          capabilities: { transfers: "active" },
          requirements: { currently_due: [], eventually_due: [] }
        });
      }
      if (url.endsWith("/transfers")) {
        return jsonResponse({ id: "tr_123", amount: 1200, currency: "usd", destination: "acct_123" });
      }
      return jsonResponse({ error: { message: "Unexpected Stripe test URL" } }, false);
    }
  });

  const account = await client.createAccount({
    user: { id: "user_1", email: "maya@example.com" }
  });
  assert.equal(account.id, "acct_123");

  const accountBody = new URLSearchParams(calls[0].init.body);
  assert.equal(accountBody.get("type"), "express");
  assert.equal(accountBody.get("capabilities[transfers][requested]"), "true");
  assert.equal(accountBody.get("metadata[alignment_galaxy_user_id]"), "user_1");

  const link = await client.createAccountLink({
    accountId: "acct_123",
    returnUrl: "http://localhost:3000/stripe/connect/return?account=acct_123",
    refreshUrl: "http://localhost:3000/stripe/connect/refresh?account=acct_123"
  });
  assert.equal(link.url, "https://connect.stripe.test/onboard");

  const synced = await client.retrieveAccount("acct_123");
  assert.equal(client.accountStatus(synced), "stripe_ready");

  const transfer = await client.createTransfer({
    amountCents: 1200,
    destinationAccountId: "acct_123",
    payoutId: "pay_123",
    taskId: "task_123",
    contributorId: "user_1",
    description: "Test payout"
  });
  assert.equal(transfer.id, "tr_123");
  assert.equal(calls[3].init.headers["idempotency-key"], "alignment-galaxy-payout-pay_123");
});

test("Stripe Connect demo mode returns local account and transfer IDs", async () => {
  const client = createStripeConnectClient({
    now: () => "2026-08-08T00:00:00.000Z"
  });
  const account = await client.createAccount({
    user: { id: "11111111-1111-4111-8111-111111111111", email: "maya@example.com" }
  });
  assert.equal(account.id, "acct_demo_11111111111141118111111111111111");
  assert.equal(client.publicConfig().mode, "demo");

  const transfer = await client.createTransfer({
    amountCents: 1200,
    destinationAccountId: account.id,
    payoutId: "pay_abc-123",
    taskId: "task_123",
    contributorId: "user_1"
  });
  assert.equal(transfer.id, "tr_demo_pay_abc123");
});

test("configured Stripe client does not release demo connected accounts", () => {
  const client = createStripeConnectClient({
    secretKey: "sk_test_alignment",
    fetchImpl: async () => jsonResponse({})
  });
  assert.equal(client.accountCanReceiveTransfers({
    payout_status: "stripe_ready",
    stripe_connect_account_id: "acct_demo_maya"
  }), false);
});

function jsonResponse(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body
  };
}
