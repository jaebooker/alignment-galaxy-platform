const test = require("node:test");
const assert = require("node:assert/strict");

const { AUTH_STATE_COOKIE, createOAuthClient } = require("../lib/oauth");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

test("OAuth client creates PKCE authorization redirects and resolves callback profiles", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === "https://auth.example.test/.well-known/openid-configuration") {
      return jsonResponse({
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/oauth/token",
        userinfo_endpoint: "https://auth.example.test/userinfo"
      });
    }
    if (url === "https://auth.example.test/oauth/token") {
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("grant_type"), "authorization_code");
      assert.equal(options.body.get("code"), "callback-code");
      assert.ok(options.body.get("code_verifier").length > 40);
      return jsonResponse({
        access_token: "access-token",
        token_type: "Bearer"
      });
    }
    if (url === "https://auth.example.test/userinfo") {
      assert.equal(options.headers.authorization, "Bearer access-token");
      return jsonResponse({
        sub: "oauth|user-123",
        email: "maya@example.com",
        email_verified: true,
        name: "Maya Chen"
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const oauth = createOAuthClient({
    env: {
      AUTH_PROVIDER: "auth0",
      AUTH_SESSION_SECRET: "test-secret",
      OIDC_CLIENT_ID: "client-id",
      OIDC_CLIENT_SECRET: "client-secret",
      OIDC_ISSUER_URL: "https://auth.example.test"
    },
    fetchImpl,
    now: () => new Date("2026-08-08T12:00:00.000Z")
  });

  const req = { headers: { host: "localhost:3000" } };
  const redirect = await oauth.authorizationRedirect(req, new URL("http://localhost:3000/auth/login?role=reviewer&return_to=/queue"));
  const authorizationUrl = new URL(redirect.location);
  assert.equal(authorizationUrl.origin, "https://auth.example.test");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "client-id");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "http://localhost:3000/auth/callback");
  assert.equal(authorizationUrl.searchParams.get("scope"), "openid profile email");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationUrl.searchParams.get("code_challenge"));
  assert.match(redirect.cookie, new RegExp(`^${AUTH_STATE_COOKIE}=`));

  const callback = await oauth.callbackResult(
    { headers: { host: "localhost:3000", cookie: redirect.cookie } },
    new URL(`http://localhost:3000/auth/callback?code=callback-code&state=${authorizationUrl.searchParams.get("state")}`)
  );

  assert.deepEqual(callback.profile, {
    email: "maya@example.com",
    email_verified: true,
    name: "Maya Chen",
    picture: null,
    provider: "auth0",
    subject: "oauth|user-123"
  });
  assert.equal(callback.requestedRole, "reviewer");
  assert.equal(callback.returnTo, "/queue");
  assert.match(callback.clearCookie, new RegExp(`^${AUTH_STATE_COOKIE}=;`));
  assert.equal(calls.length, 3);
});

test("OAuth public config uses Clerk authorization-server discovery default", () => {
  const oauth = createOAuthClient({
    env: {
      AUTH_PROVIDER: "clerk",
      AUTH_SESSION_SECRET: "test-secret",
      CLERK_ISSUER_URL: "https://clerk.example.test",
      OIDC_CLIENT_ID: "client-id"
    }
  });

  assert.deepEqual(oauth.publicConfig(), {
    enabled: true,
    provider: "Clerk",
    login_url: "/auth/login",
    logout_url: "/api/session/logout"
  });
  assert.equal(oauth.config().discoveryUrl, "https://clerk.example.test/.well-known/oauth-authorization-server");
});
