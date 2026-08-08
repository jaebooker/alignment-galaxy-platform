const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const AUTH_STATE_COOKIE = "ag_oauth_state";
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SCOPES = "openid profile email";

let discoveryCache = null;

function createOAuthClient({ env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  function config() {
    return getAuthConfig(env);
  }

  function publicConfig() {
    const auth = config();
    return {
      enabled: auth.enabled,
      provider: auth.providerLabel,
      login_url: "/auth/login",
      logout_url: "/api/session/logout"
    };
  }

  async function authorizationRedirect(req, url) {
    const auth = requireAuthConfig(config());
    const discovery = await getDiscovery(auth, fetchImpl);
    const requestedRole = sanitizeRole(url.searchParams.get("role"));
    const returnTo = safeReturnTo(url.searchParams.get("return_to"));
    const statePayload = createAuthState({ requestedRole, returnTo }, now);
    const redirectUri = auth.redirectUri || `${baseUrl(req)}/auth/callback`;
    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", auth.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", auth.scopes);
    authorizationUrl.searchParams.set("state", statePayload.state);
    authorizationUrl.searchParams.set("nonce", statePayload.nonce);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("code_challenge", base64url(sha256(statePayload.codeVerifier)));
    if (auth.audience) authorizationUrl.searchParams.set("audience", auth.audience);
    if (auth.connection) authorizationUrl.searchParams.set("connection", auth.connection);
    if (auth.organization) authorizationUrl.searchParams.set("organization", auth.organization);

    return {
      location: authorizationUrl.toString(),
      cookie: serializeCookie(AUTH_STATE_COOKIE, signState(statePayload, auth.cookieSecret), {
        httpOnly: true,
        maxAge: Math.floor(AUTH_STATE_TTL_MS / 1000),
        path: "/auth",
        sameSite: "Lax",
        secure: isSecureRequest(req)
      })
    };
  }

  async function callbackResult(req, url) {
    const auth = requireAuthConfig(config());
    const discovery = await getDiscovery(auth, fetchImpl);
    const providerError = url.searchParams.get("error");
    if (providerError) {
      throw new Error(url.searchParams.get("error_description") || providerError);
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (!code || !returnedState) {
      const error = new Error("OAuth callback is missing code or state.");
      error.statusCode = 400;
      throw error;
    }

    const storedState = verifyStateCookie(req.headers.cookie || "", auth.cookieSecret, now);
    if (!storedState || storedState.state !== returnedState) {
      const error = new Error("OAuth state validation failed.");
      error.statusCode = 400;
      throw error;
    }

    const redirectUri = auth.redirectUri || `${baseUrl(req)}/auth/callback`;
    const tokens = await exchangeCode({
      auth,
      code,
      codeVerifier: storedState.codeVerifier,
      discovery,
      fetchImpl,
      redirectUri
    });
    const profile = await userProfile({ auth, discovery, fetchImpl, tokens });

    return {
      clearCookie: clearAuthStateCookie(req),
      profile,
      requestedRole: storedState.requestedRole,
      returnTo: storedState.returnTo
    };
  }

  return {
    callbackResult,
    clearAuthStateCookie,
    config,
    publicConfig,
    authorizationRedirect
  };
}

function getAuthConfig(env) {
  const auth0Domain = cleanHost(env.AUTH0_DOMAIN);
  const issuer = stripTrailingSlash(
    env.OIDC_ISSUER_URL ||
    env.AUTH0_ISSUER_URL ||
    (auth0Domain ? `https://${auth0Domain}` : "") ||
    env.CLERK_OIDC_ISSUER_URL ||
    env.CLERK_ISSUER_URL ||
    env.CLERK_FRONTEND_API ||
    ""
  );
  const providerName = (env.AUTH_PROVIDER || inferProvider(issuer)).toLowerCase();
  const discoveryUrl = env.OIDC_DISCOVERY_URL ||
    env.AUTH_DISCOVERY_URL ||
    (issuer ? `${issuer}/.well-known/${providerName === "clerk" ? "oauth-authorization-server" : "openid-configuration"}` : "");
  const providerLabel = env.AUTH_PROVIDER_LABEL || (providerName === "auth0" ? "Auth0" : providerName === "clerk" ? "Clerk" : "OAuth");
  const clientSecret = env.OIDC_CLIENT_SECRET || env.AUTH0_CLIENT_SECRET || env.CLERK_CLIENT_SECRET || "";
  const cookieSecret = env.AUTH_SESSION_SECRET || env.SESSION_SECRET || "";

  return {
    audience: env.OIDC_AUDIENCE || env.AUTH0_AUDIENCE || "",
    clientId: env.OIDC_CLIENT_ID || env.AUTH0_CLIENT_ID || env.CLERK_CLIENT_ID || "",
    clientSecret,
    connection: env.OIDC_CONNECTION || env.AUTH0_CONNECTION || "",
    cookieSecret,
    discoveryUrl,
    enabled: Boolean(discoveryUrl && (env.OIDC_CLIENT_ID || env.AUTH0_CLIENT_ID || env.CLERK_CLIENT_ID) && cookieSecret),
    issuer,
    organization: env.OIDC_ORGANIZATION || env.AUTH0_ORGANIZATION || "",
    providerLabel,
    providerName,
    redirectUri: env.OIDC_REDIRECT_URI || env.AUTH_CALLBACK_URL || "",
    scopes: env.OIDC_SCOPES || DEFAULT_SCOPES,
    tokenAuthMethod: env.OIDC_TOKEN_AUTH_METHOD || "client_secret_post"
  };
}

function requireAuthConfig(auth) {
  const missing = [];
  if (!auth.discoveryUrl) missing.push("OIDC_ISSUER_URL or OIDC_DISCOVERY_URL");
  if (!auth.clientId) missing.push("OIDC_CLIENT_ID");
  if (!auth.cookieSecret) missing.push("AUTH_SESSION_SECRET");
  if (missing.length) {
    const error = new Error(`OAuth is not configured. Missing: ${missing.join(", ")}.`);
    error.statusCode = 503;
    throw error;
  }
  return auth;
}

async function getDiscovery(auth, fetchImpl) {
  if (discoveryCache?.url === auth.discoveryUrl) return discoveryCache.document;
  const response = await fetchImpl(auth.discoveryUrl, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    const error = new Error(`Unable to load OAuth discovery document (${response.status}).`);
    error.statusCode = 502;
    throw error;
  }
  const document = await response.json();
  for (const field of ["authorization_endpoint", "token_endpoint"]) {
    if (!document[field]) {
      const error = new Error(`OAuth discovery document is missing ${field}.`);
      error.statusCode = 502;
      throw error;
    }
  }
  discoveryCache = { url: auth.discoveryUrl, document };
  return document;
}

async function exchangeCode({ auth, code, codeVerifier, discovery, fetchImpl, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: auth.clientId,
    code_verifier: codeVerifier
  });

  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded"
  };

  if (auth.clientSecret) {
    if (auth.tokenAuthMethod === "client_secret_basic") {
      headers.authorization = `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString("base64")}`;
    } else {
      body.set("client_secret", auth.clientSecret);
    }
  }

  const response = await fetchImpl(discovery.token_endpoint, {
    method: "POST",
    headers,
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.error || `OAuth token exchange failed (${response.status}).`);
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

async function userProfile({ auth, discovery, fetchImpl, tokens }) {
  if (!discovery.userinfo_endpoint || !tokens.access_token) {
    const error = new Error("OAuth provider must return an access token and userinfo endpoint.");
    error.statusCode = 502;
    throw error;
  }

  const response = await fetchImpl(discovery.userinfo_endpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${tokens.access_token}`
    }
  });
  const claims = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(claims.error_description || claims.error || `OAuth userinfo request failed (${response.status}).`);
    error.statusCode = 502;
    throw error;
  }

  if (!claims.sub) {
    const error = new Error("OAuth profile did not include a subject.");
    error.statusCode = 502;
    throw error;
  }

  return {
    email: claims.email || null,
    email_verified: claims.email_verified,
    name: claims.name || claims.given_name || claims.nickname || claims.email || "Alignment Galaxy user",
    picture: claims.picture || null,
    provider: auth.providerName,
    subject: claims.sub
  };
}

function createAuthState({ requestedRole, returnTo }, now) {
  return {
    codeVerifier: base64url(randomBytes(48)),
    createdAt: now().toISOString(),
    nonce: base64url(randomBytes(24)),
    requestedRole,
    returnTo,
    state: base64url(randomBytes(24))
  };
}

function signState(payload, secret) {
  const encoded = base64url(JSON.stringify(payload));
  const signature = hmac(encoded, secret);
  return `${encoded}.${signature}`;
}

function verifyStateCookie(cookieHeader, secret, now) {
  const value = parseCookies(cookieHeader)[AUTH_STATE_COOKIE];
  if (!value) return null;
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) return null;
  const expected = hmac(encoded, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (now().getTime() - new Date(payload.createdAt).getTime() > AUTH_STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function clearAuthStateCookie(req) {
  return serializeCookie(AUTH_STATE_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/auth",
    sameSite: "Lax",
    secure: isSecureRequest(req)
  });
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) return cookies;
    cookies[rawName] = decodeURIComponent(rawValue.join("=") || "");
    return cookies;
  }, {});
}

function hmac(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || (isLocalHost(req.headers.host) ? "http" : "https");
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000"}`;
}

function isSecureRequest(req) {
  const host = req.headers.host || "";
  return req.headers["x-forwarded-proto"] === "https" || (!isLocalHost(host) && process.env.NODE_ENV === "production");
}

function isLocalHost(host = "") {
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}

function sanitizeRole(role) {
  return ["contributor", "customer", "reviewer", "admin"].includes(role) ? role : "contributor";
}

function safeReturnTo(returnTo) {
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//")) return "/";
  return returnTo;
}

function cleanHost(value = "") {
  return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function stripTrailingSlash(value = "") {
  return value.replace(/\/+$/, "");
}

function inferProvider(issuer) {
  if (issuer.includes("auth0.com")) return "auth0";
  if (issuer.includes("clerk.accounts") || issuer.includes("clerk.")) return "clerk";
  return "oidc";
}

module.exports = {
  AUTH_STATE_COOKIE,
  createOAuthClient
};
