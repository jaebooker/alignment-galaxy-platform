const STRIPE_API_BASE = "https://api.stripe.com/v1";

function createStripeConnectClient({
  secretKey = process.env.STRIPE_SECRET_KEY,
  apiBase = process.env.STRIPE_API_BASE || STRIPE_API_BASE,
  apiVersion = process.env.STRIPE_API_VERSION,
  country = process.env.STRIPE_CONNECT_COUNTRY || "US",
  currency = process.env.STRIPE_CURRENCY || "usd",
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString()
} = {}) {
  const configured = Boolean(secretKey);

  function publicConfig() {
    return {
      enabled: configured,
      mode: configured && secretKey.startsWith("sk_live_") ? "live" : configured ? "test" : "demo",
      currency
    };
  }

  function accountCanReceiveTransfers(profile) {
    if (!profile?.stripe_connect_account_id) return false;
    if (configured && profile.stripe_connect_account_id.startsWith("acct_demo_")) return false;
    return profile.payout_status === "stripe_ready";
  }

  async function createAccount({ user }) {
    if (!configured) {
      return demoAccount(`acct_demo_${safeId(user.id)}`, {
        details_submitted: false,
        payouts_enabled: false,
        transfers_active: false
      });
    }

    return stripeRequest("POST", "/accounts", {
      type: "express",
      country,
      email: user.email,
      capabilities: {
        transfers: {
          requested: "true"
        }
      },
      metadata: {
        alignment_galaxy_user_id: user.id
      }
    });
  }

  async function createAccountLink({ accountId, returnUrl, refreshUrl }) {
    if (!configured) {
      return {
        object: "account_link",
        created: Math.floor(Date.parse(now()) / 1000),
        expires_at: Math.floor(Date.parse(now()) / 1000) + 300,
        url: returnUrl
      };
    }

    return stripeRequest("POST", "/account_links", {
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding"
    });
  }

  async function retrieveAccount(accountId) {
    if (!configured) {
      return demoAccount(accountId, {
        details_submitted: true,
        payouts_enabled: true,
        transfers_active: true
      });
    }

    return stripeRequest("GET", `/accounts/${encodeURIComponent(accountId)}`);
  }

  async function createTransfer({ amountCents, destinationAccountId, payoutId, taskId, contributorId, description }) {
    if (!configured) {
      return {
        id: `tr_demo_${safeId(payoutId).slice(0, 18)}`,
        object: "transfer",
        amount: amountCents,
        currency,
        destination: destinationAccountId
      };
    }

    return stripeRequest("POST", "/transfers", {
      amount: amountCents,
      currency,
      destination: destinationAccountId,
      description,
      transfer_group: taskId ? `task_${taskId}` : undefined,
      metadata: {
        alignment_galaxy_payout_id: payoutId,
        alignment_galaxy_task_id: taskId,
        alignment_galaxy_contributor_id: contributorId
      }
    }, {
      idempotencyKey: `alignment-galaxy-payout-${payoutId}`
    });
  }

  function accountStatus(account) {
    const transfersActive = account?.capabilities?.transfers === "active" || account?.transfers_active === true;
    if (account?.details_submitted && account?.payouts_enabled && transfersActive) return "stripe_ready";
    if (account?.requirements?.disabled_reason || account?.disabled_reason) return "paused";
    if (account?.id) return "needs_id_verification";
    return "not_started";
  }

  async function stripeRequest(method, path, params = {}, options = {}) {
    if (!fetchImpl) throw new Error("Stripe integration requires fetch support.");
    const headers = {
      authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`
    };
    if (apiVersion) headers["stripe-version"] = apiVersion;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const init = { method, headers };
    let url = `${apiBase}${path}`;
    if (method === "GET") {
      const query = formBody(params);
      if (query) url += `?${query}`;
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = formBody(params);
    }

    const response = await fetchImpl(url, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || `Stripe request failed with ${response.status}.`;
      const error = new Error(message);
      error.statusCode = response.status;
      error.stripe = data?.error || data;
      throw error;
    }
    return data;
  }

  return {
    accountCanReceiveTransfers,
    accountStatus,
    configured,
    createAccount,
    createAccountLink,
    createTransfer,
    publicConfig,
    retrieveAccount
  };
}

function formBody(params, prefix = "") {
  const body = new URLSearchParams();
  appendParams(body, params, prefix);
  return body.toString();
}

function appendParams(body, params, prefix) {
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item) => body.append(`${name}[]`, item));
    } else if (typeof value === "object") {
      appendParams(body, value, name);
    } else {
      body.append(name, String(value));
    }
  });
}

function demoAccount(id, flags) {
  return {
    id,
    object: "account",
    details_submitted: Boolean(flags.details_submitted),
    payouts_enabled: Boolean(flags.payouts_enabled),
    capabilities: {
      transfers: flags.transfers_active ? "active" : "pending"
    },
    requirements: {
      currently_due: flags.transfers_active ? [] : ["external_account"],
      eventually_due: flags.transfers_active ? [] : ["external_account"],
      disabled_reason: null
    }
  };
}

function safeId(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 48) || "unknown";
}

module.exports = {
  createStripeConnectClient
};
