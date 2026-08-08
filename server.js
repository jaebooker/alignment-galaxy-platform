const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { loadEnv } = require("./lib/env");
const { createFileStorage } = require("./lib/fileStorage");
const { createOAuthClient } = require("./lib/oauth");
const { createPostgresStore, hashSessionToken } = require("./lib/postgresStore");
const { createStripeConnectClient } = require("./lib/stripeConnect");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PUBLIC_DIR = path.join(ROOT, "public");
const SEED_FILE = path.join(ROOT, "data", "seed.json");
const SCHEMA_FILE = path.join(ROOT, "database", "schema.sql");
const SESSION_COOKIE = "ag_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 12;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const DEFAULT_REVIEW_STANDARDS = [
  "The artifact directly answers the task prompt and includes enough context for a customer to validate it.",
  "Safety-sensitive content is summarized at the right level of abstraction and does not add unnecessary operational detail.",
  "Claims are specific, reproducible, and separated from speculation.",
  "Reviewer notes identify false positive risks, false negative risks, and any recommended follow-up."
];
const MAX_MULTIPART_FILES = 5;

function now() {
  return new Date().toISOString();
}

function createId() {
  return randomUUID();
}

const store = createPostgresStore({
  seedFile: SEED_FILE,
  schemaFile: SCHEMA_FILE,
  normalizeState,
  now
});
const auth = createOAuthClient({ now: () => new Date() });
const fileStorage = createFileStorage({ now });
const stripeConnect = createStripeConnectClient({ now });

async function loadState() {
  return store.read();
}

async function saveState(state) {
  await store.write(state);
}

async function resetState() {
  return store.reset();
}

async function closeStateStore() {
  await store.close();
}

function normalizeState(state) {
  state.sessions ||= [];
  state.auth_identities ||= [];
  state.delivery_packets ||= [];
  state.submission_files ||= [];
  state.payouts ||= [];
  state.review_standards ||= DEFAULT_REVIEW_STANDARDS;
  state.contributor_profiles ||= [];
  state.contributor_profiles.forEach((profile) => {
    profile.stripe_charges_enabled ||= false;
    profile.stripe_payouts_enabled ||= false;
    profile.stripe_requirements_due ||= [];
    profile.stripe_disabled_reason ||= null;
    profile.stripe_onboarding_started_at ||= null;
    profile.stripe_onboarded_at ||= null;
    profile.stripe_last_synced_at ||= null;
  });
  state.payouts.forEach((payout) => {
    payout.released_at ||= null;
    payout.released_by ||= null;
    payout.release_note ||= null;
  });
  state.delivery_packets.forEach((packet) => {
    packet.report_title ||= null;
    packet.report_markdown ||= null;
    packet.report_exported_at ||= null;
    packet.report_exported_by ||= null;
    packet.customer_approved_at ||= null;
    packet.customer_approved_by ||= null;
    packet.customer_approval_notes ||= null;
    packet.payout_released_at ||= null;
    packet.payout_released_by ||= null;
    packet.payout_release_note ||= null;
  });
  state.tasks ||= [];
  state.tasks.forEach((task) => {
    task.acceptance_criteria ||= [
      "Covers the requested behavior or capability domain.",
      "Includes concrete evidence and reviewer-ready notes.",
      "Flags uncertainty and potential misuse concerns."
    ];
    task.claimed_by ||= [];
  });
  return state;
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendError(res, statusCode, message, details = undefined) {
  sendJson(res, statusCode, { error: message, details });
}

function sendRedirect(res, location, headers = {}) {
  res.writeHead(303, {
    location,
    ...headers
  });
  res.end();
}

function sendBinary(res, statusCode, buffer, headers = {}) {
  res.writeHead(statusCode, {
    "cache-control": "private, max-age=60",
    "content-length": buffer.length,
    ...headers
  });
  res.end(buffer);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) return cookies;
    cookies[rawName] = decodeURIComponent(rawValue.join("=") || "");
    return cookies;
  }, {});
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function attachmentDisposition(fileName) {
  const fallback = String(fileName || "artifact").replace(/[^\x20-\x7E]|["\\\r\n]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName || "artifact")}`;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    verification_status: user.verification_status
  };
}

function publicSubmissionFile(file) {
  return {
    id: file.id,
    submission_id: file.submission_id,
    uploaded_by: file.uploaded_by,
    original_name: file.original_name,
    content_type: file.content_type,
    size_bytes: file.size_bytes,
    checksum_sha256: file.checksum_sha256,
    created_at: file.created_at,
    download_url: `/api/submissions/${encodeURIComponent(file.submission_id)}/files/${encodeURIComponent(file.id)}`
  };
}

function publicDeliveryPacket(packet) {
  if (!packet) return null;
  const { report_markdown: _reportMarkdown, ...publicPacket } = packet;
  return publicPacket;
}

function getSessionToken(req) {
  return parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
}

function currentSessionContext(state, req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = state.sessions.find((candidate) => {
    return candidate.token_hash === tokenHash || candidate.session_token_hash === tokenHash || candidate.token === token;
  });
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
  const user = getUser(state, session.user_id);
  if (!user) return null;
  return { session, user };
}

function sessionView(state, session) {
  const user = getUser(state, session?.user_id);
  if (!session || !user) return null;
  return {
    id: session.id,
    user_id: session.user_id,
    active_role: session.active_role,
    expires_at: session.expires_at,
    user: publicUser(user)
  };
}

function requireSession(state, req, allowedRoles = []) {
  const context = currentSessionContext(state, req);
  if (!context) throw httpError(401, "Sign in required.");
  if (allowedRoles.length && !allowedRoles.includes(context.session.active_role)) {
    throw httpError(403, `${allowedRoles.join(" or ")} role required.`);
  }
  return context;
}

function createSessionForUser(state, user, role) {
  if (!user.verification_status || user.verification_status !== "verified") {
    throw httpError(403, "User must be verified before signing in.");
  }
  if (!user.roles.includes(role)) {
    throw httpError(403, "User does not have that role.");
  }

  const token = randomUUID();
  const session = {
    id: createId("sess"),
    token_hash: hashSessionToken(token),
    user_id: user.id,
    active_role: role,
    created_at: now(),
    expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString()
  };

  state.sessions = state.sessions.filter((candidate) => Date.parse(candidate.expires_at) > Date.now());
  state.sessions.unshift(session);
  return { session, token };
}

function resolveActiveRole(user, requestedRole) {
  if (requestedRole && user.roles.includes(requestedRole)) return requestedRole;
  return user.roles[0] || "contributor";
}

function findOrCreateOAuthUser(state, profile) {
  if (!profile.email) {
    throw httpError(403, "OAuth profile must include an email address.");
  }

  const email = profile.email.trim().toLowerCase();
  const identity = state.auth_identities.find((candidate) => {
    return candidate.provider === profile.provider && candidate.subject === profile.subject;
  });
  let user = identity ? getUser(state, identity.user_id) : null;

  if (!user && profile.email_verified !== false) {
    user = state.users.find((candidate) => candidate.email.toLowerCase() === email);
  }
  if (!user && profile.email_verified === false) {
    throw httpError(403, "OAuth email must be verified before account creation.");
  }

  if (!user) {
    user = {
      id: createId("user"),
      name: String(profile.name || email).trim(),
      email,
      roles: ["contributor"],
      verification_status: "verified",
      created_at: now()
    };
    state.users.push(user);
    state.contributor_profiles.push({
      user_id: user.id,
      skills: [],
      verification_tier: 0,
      reputation_score: 0,
      approval_rate: 0,
      completed_tasks: 0,
      payout_status: "not_started",
      stripe_connect_account_id: null
    });
    addActivity(state, "user_created", `${user.name} joined through ${auth.publicConfig().provider}.`);
  }

  if (identity) {
    identity.email = email;
    identity.user_id = user.id;
    identity.last_seen_at = now();
  } else {
    state.auth_identities.push({
      provider: profile.provider,
      subject: profile.subject,
      user_id: user.id,
      email,
      created_at: now(),
      last_seen_at: now()
    });
  }

  return user;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

async function readSubmissionBody(req) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return {
      ...(await readBody(req)),
      files: []
    };
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  const maxRequestBytes = (fileStorage.maxBytes * MAX_MULTIPART_FILES) + (128 * 1024);
  if (contentLength > maxRequestBytes) {
    throw httpError(413, "Upload request is too large.");
  }

  const form = await new Request(`http://${req.headers.host || "localhost"}/`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half"
  }).formData();
  const body = { files: [] };

  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      body[name] = value;
      continue;
    }
    if (!value || typeof value.arrayBuffer !== "function" || value.size === 0) continue;
    if (body.files.length >= MAX_MULTIPART_FILES) {
      throw httpError(400, `Upload at most ${MAX_MULTIPART_FILES} files per submission.`);
    }
    body.files.push({
      buffer: Buffer.from(await value.arrayBuffer()),
      contentType: value.type || "application/octet-stream",
      originalName: value.name || name || "artifact"
    });
  }

  return body;
}

function getUser(state, userId) {
  return state.users.find((user) => user.id === userId);
}

function getContributorProfile(state, userId) {
  return state.contributor_profiles.find((profile) => profile.user_id === userId);
}

function originForRequest(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host || "localhost:3000"}`;
}

function stripeReturnUrl(req, accountId) {
  const url = new URL("/stripe/connect/return", originForRequest(req));
  url.searchParams.set("account", accountId);
  return url.toString();
}

function stripeRefreshUrl(req, accountId) {
  const url = new URL("/stripe/connect/refresh", originForRequest(req));
  url.searchParams.set("account", accountId);
  return url.toString();
}

function applyStripeAccountToProfile(state, profile, account) {
  const status = stripeConnect.accountStatus(account);
  profile.stripe_connect_account_id = account.id;
  profile.payout_status = status;
  profile.stripe_charges_enabled = Boolean(account.charges_enabled);
  profile.stripe_payouts_enabled = Boolean(account.payouts_enabled);
  profile.stripe_requirements_due = [
    ...(account.requirements?.currently_due || []),
    ...(account.requirements?.eventually_due || [])
  ].filter((value, index, list) => value && list.indexOf(value) === index);
  profile.stripe_disabled_reason = account.requirements?.disabled_reason || account.disabled_reason || null;
  profile.stripe_last_synced_at = now();
  if (status === "stripe_ready" && !profile.stripe_onboarded_at) {
    profile.stripe_onboarded_at = now();
  }
  refreshContributorPayoutStatuses(state, profile.user_id);
}

function refreshContributorPayoutStatuses(state, contributorId) {
  const profile = getContributorProfile(state, contributorId);
  const ready = stripeConnect.accountCanReceiveTransfers(profile);
  state.payouts
    .filter((payout) => payout.contributor_id === contributorId && ["pending", "ready"].includes(payout.status))
    .forEach((payout) => {
      payout.status = ready ? "ready" : "pending";
    });
}

function contributorCanReceiveTransfers(profile) {
  return stripeConnect.accountCanReceiveTransfers(profile);
}

function getTask(state, taskId) {
  return state.tasks.find((task) => task.id === taskId);
}

function taskSubmissions(state, taskId) {
  return state.submissions.filter((submission) => submission.task_id === taskId);
}

function filesForSubmission(state, submissionId) {
  return state.submission_files.filter((file) => file.submission_id === submissionId);
}

function approvedSubmissions(state, taskId) {
  return taskSubmissions(state, taskId).filter((submission) => submission.status === "approved");
}

function canAccessSubmission(state, context, submission) {
  if (!context || !submission) return false;
  const { session, user } = context;
  if (submission.contributor_id === user.id) return true;
  if (session.active_role === "reviewer" || session.active_role === "admin") return true;
  if (session.active_role !== "customer") return false;

  const task = getTask(state, submission.task_id);
  const org = state.customer_orgs.find((candidate) => candidate.id === task?.sponsoring_org_id);
  return org?.contact_user_id === user.id;
}

function canAccessDeliveryPacket(state, context, packet) {
  if (!context || !packet) return false;
  const { session, user } = context;
  if (session.active_role === "reviewer" || session.active_role === "admin") return true;
  if (session.active_role !== "customer") return false;

  const task = getTask(state, packet.task_id);
  const org = state.customer_orgs.find((candidate) => candidate.id === task?.sponsoring_org_id);
  return org?.contact_user_id === user.id;
}

function packetPayouts(state, packet) {
  const approvedIds = new Set(packet.approved_submission_ids || []);
  return state.payouts.filter((payout) => approvedIds.has(payout.submission_id));
}

function reportFileName(task, packet) {
  const slug = String(task?.title || packet.id || "delivery-report")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "delivery-report";
  return `${slug}-report.md`;
}

function markdownList(items) {
  if (!items?.length) return "- None";
  return items.map((item) => `- ${item}`).join("\n");
}

function buildDeliveryReport(state, task, packet) {
  const approved = (packet.approved_submission_ids || [])
    .map((submissionId) => state.submissions.find((submission) => submission.id === submissionId))
    .filter(Boolean);
  const payouts = packetPayouts(state, packet);
  const payoutTotal = payouts.reduce((sum, payout) => sum + payout.amount_cents, 0);
  const title = `${task.title} Delivery Report`;
  const lines = [
    `# ${title}`,
    "",
    `Exported: ${now()}`,
    `Customer: ${state.customer_orgs.find((org) => org.id === task.sponsoring_org_id)?.name || "Unknown organization"}`,
    `Task type: ${task.task_type.replaceAll("_", " ")}`,
    `Risk level: ${task.risk_level}`,
    "",
    "## Customer Summary",
    "",
    packet.customer_summary,
    "",
    "## Acceptance Criteria",
    "",
    markdownList(task.acceptance_criteria || []),
    "",
    "## Approved Artifacts",
    ""
  ];

  approved.forEach((submission, index) => {
    const review = reviewForSubmission(state, submission.id);
    const files = filesForSubmission(state, submission.id);
    lines.push(
      `### Artifact ${index + 1}: ${getUser(state, submission.contributor_id)?.name || "Contributor"}`,
      "",
      submission.artifact,
      "",
      submission.notes ? `Contributor notes: ${submission.notes}` : "Contributor notes: None",
      "",
      review ? `Reviewer: ${getUser(state, review.reviewer_id)?.name || "Reviewer"}; verdict ${review.verdict}; score ${review.score}/5; confidence ${review.reviewer_confidence}/5.` : "Reviewer: Not attached.",
      review ? `Reviewer notes: ${review.notes}` : "",
      "",
      "Attached files:",
      files.length
        ? files.map((file) => `- ${file.original_name} (${file.content_type}, ${file.size_bytes} bytes, sha256 ${file.checksum_sha256})`).join("\n")
        : "- None",
      ""
    );
  });

  lines.push(
    "## Quality Review Summary",
    "",
    packet.review_summary,
    "",
    "## Handling Notes",
    "",
    packet.risk_notes,
    "",
    "## Payout Readiness",
    "",
    `Contributor payout total: ${new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0
    }).format(payoutTotal / 100)}`,
    `Ready payouts: ${payouts.filter((payout) => payout.status === "ready").length}`,
    `Pending payouts: ${payouts.filter((payout) => payout.status === "pending").length}`,
    `Transferred payouts: ${payouts.filter((payout) => payout.status === "transferred").length}`,
    ""
  );

  return {
    title,
    markdown: `${lines.filter((line) => line !== undefined).join("\n").trim()}\n`
  };
}

function updateTaskStatus(state, task) {
  const submissions = taskSubmissions(state, task.id);
  const approved = submissions.filter((submission) => submission.status === "approved");

  if (approved.length >= task.redundancy_count) {
    task.status = "completed";
  } else if (submissions.some((submission) => submission.status === "submitted")) {
    task.status = "in_review";
  } else if (task.claimed_by.length > 0) {
    task.status = "claimed";
  } else if (task.status !== "draft") {
    task.status = "open";
  }
}

function computeMetrics(state) {
  const totalRewardCents = state.tasks.reduce((sum, task) => sum + task.reward_cents, 0);
  const publicGoodRewardCents = state.tasks
    .filter((task) => task.commerciality === "public_good")
    .reduce((sum, task) => sum + task.reward_cents, 0);
  const pendingPayoutCents = state.payouts
    .filter((payout) => payout.status === "pending" || payout.status === "ready")
    .reduce((sum, payout) => sum + payout.amount_cents, 0);

  return {
    open_tasks: state.tasks.filter((task) => task.status === "open" || task.status === "claimed").length,
    in_review: state.submissions.filter((submission) => submission.status === "submitted").length,
    approved_submissions: state.submissions.filter((submission) => submission.status === "approved").length,
    completed_tasks: state.tasks.filter((task) => task.status === "completed" || task.status === "paid").length,
    ready_deliveries: state.delivery_packets.filter((packet) => {
      return ["ready", "exported", "changes_requested", "customer_approved", "payout_released", "delivered"].includes(packet.status);
    }).length,
    verified_contributors: state.contributor_profiles.filter((profile) => profile.verification_tier > 0).length,
    pending_payout_cents: pendingPayoutCents,
    public_good_capacity_pct: totalRewardCents === 0 ? 0 : Math.round((publicGoodRewardCents / totalRewardCents) * 100),
    total_reward_cents: totalRewardCents
  };
}

function clientState(state, context = {}) {
  const {
    auth_identities: _authIdentities,
    sessions: _sessions,
    submission_files: submissionFiles,
    delivery_packets: deliveryPackets,
    ...publicState
  } = state;
  const session = context.session || (context.req ? currentSessionContext(state, context.req)?.session : null);

  return {
    ...publicState,
    auth: auth.publicConfig(),
    stripe: stripeConnect.publicConfig(),
    session: sessionView(state, session),
    submission_files: (submissionFiles || []).map(publicSubmissionFile),
    delivery_packets: (deliveryPackets || []).map(publicDeliveryPacket),
    metrics: computeMetrics(state)
  };
}

function addActivity(state, kind, message) {
  state.activity.unshift({
    id: createId("act"),
    kind,
    message,
    created_at: now()
  });
  state.activity = state.activity.slice(0, 30);
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
  if (missing.length) {
    const error = new Error(`Missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
}

function reviewForSubmission(state, submissionId) {
  return state.reviews.find((review) => review.submission_id === submissionId);
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function upsertDeliveryPacket(state, task) {
  const approved = approvedSubmissions(state, task.id);
  if (!approved.length) return null;

  const reviews = approved.map((submission) => reviewForSubmission(state, submission.id)).filter(Boolean);
  const averageScore = average(reviews.map((review) => Number(review.score)));
  const averageConfidence = average(reviews.map((review) => Number(review.reviewer_confidence)));
  const existing = state.delivery_packets.find((packet) => packet.task_id === task.id);
  const previousStatus = existing?.status;
  const readinessStatus = approved.length >= task.redundancy_count ? "ready" : "assembling";
  const status = existing && ["exported", "changes_requested", "customer_approved", "payout_released", "delivered"].includes(existing.status)
    ? existing.status
    : readinessStatus;
  const packet = existing || {
    id: createId("del"),
    task_id: task.id,
    created_at: now()
  };

  Object.assign(packet, {
    status,
    approved_submission_ids: approved.map((submission) => submission.id),
    approved_count: approved.length,
    required_count: task.redundancy_count,
    average_score: averageScore === null ? null : Number(averageScore.toFixed(2)),
    average_reviewer_confidence: averageConfidence === null ? null : Number(averageConfidence.toFixed(2)),
    customer_summary: `${approved.length} approved artifact${approved.length === 1 ? "" : "s"} for ${task.title}. ${status === "ready" ? "Redundancy target met." : "Waiting on additional approved work."}`,
    review_summary: reviews.length
      ? reviews.map((review) => `${getUser(state, review.reviewer_id)?.name || "Reviewer"}: ${review.verdict} (${review.score}/5)`).join(" | ")
      : "No reviews attached yet.",
    risk_notes: task.risk_level === "sensitive"
      ? "Sensitive task. Keep customer packet concise and avoid adding operational detail beyond approved artifacts."
      : "No elevated handling flags beyond standard review.",
    updated_at: now()
  });

  if (!existing) {
    state.delivery_packets.unshift(packet);
  }

  return {
    packet,
    becameReady: previousStatus !== "ready" && status === "ready"
  };
}

async function createTask(req, res, state) {
  const { session, user } = requireSession(state, req, ["customer", "admin"]);
  const body = await readBody(req);
  requireFields(body, ["title", "description", "task_type", "reward_cents", "required_skill_tier", "redundancy_count", "deadline", "sponsoring_org_id", "commerciality"]);

  const org = state.customer_orgs.find((candidate) => candidate.id === body.sponsoring_org_id);
  if (!org || org.vetting_status !== "approved") {
    return sendError(res, 403, "Only approved customer organizations can sponsor tasks.");
  }
  if (session.active_role === "customer" && org.contact_user_id !== user.id) {
    return sendError(res, 403, "Customers can only post tasks for their own approved organization.");
  }

  const task = {
    id: createId("task"),
    title: String(body.title).trim(),
    description: String(body.description).trim(),
    task_type: body.task_type,
    reward_cents: Number(body.reward_cents),
    required_skill_tier: Number(body.required_skill_tier),
    redundancy_count: Number(body.redundancy_count),
    deadline: body.deadline,
    status: body.status === "draft" ? "draft" : "open",
    sponsoring_org_id: body.sponsoring_org_id,
    commerciality: body.commerciality,
    skill_tags: Array.isArray(body.skill_tags)
      ? body.skill_tags.map((tag) => String(tag).trim()).filter(Boolean)
      : String(body.skill_tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
    acceptance_criteria: Array.isArray(body.acceptance_criteria)
      ? body.acceptance_criteria.map((criterion) => String(criterion).trim()).filter(Boolean)
      : String(body.acceptance_criteria || "").split("\n").map((criterion) => criterion.trim()).filter(Boolean),
    deliverable_format: String(body.deliverable_format || "structured artifact").trim(),
    risk_level: body.risk_level || "standard",
    claimed_by: [],
    created_by: user.id,
    created_at: now()
  };
  if (!task.acceptance_criteria.length) {
    task.acceptance_criteria = [
      "Matches the requested scope.",
      "Includes concrete evidence.",
      "Flags uncertainty and follow-up questions."
    ];
  }

  if (!Number.isFinite(task.reward_cents) || task.reward_cents < 0) {
    return sendError(res, 400, "Reward must be a positive number of cents.");
  }
  if (!Number.isInteger(task.required_skill_tier) || task.required_skill_tier < 1) {
    return sendError(res, 400, "Required skill tier must be at least 1.");
  }
  if (!Number.isInteger(task.redundancy_count) || task.redundancy_count < 1) {
    return sendError(res, 400, "Redundancy count must be at least 1.");
  }

  state.tasks.unshift(task);
  addActivity(state, "task_created", `${org.name} posted "${task.title}".`);
  await saveState(state);
  sendJson(res, 201, { task, state: clientState(state, { session }) });
}

async function claimTask(req, res, state, taskId) {
  const { session, user } = requireSession(state, req, ["contributor"]);

  const task = getTask(state, taskId);
  if (!task) return sendError(res, 404, "Task not found.");
  if (!["open", "claimed", "in_review"].includes(task.status)) return sendError(res, 409, "Task is not claimable.");
  if (task.claimed_by.includes(user.id)) return sendError(res, 409, "Contributor already claimed this task.");
  if (task.claimed_by.length >= task.redundancy_count) return sendError(res, 409, "Task already has the required contributor redundancy.");

  if (!user || !user.roles.includes("contributor") || user.verification_status !== "verified") {
    return sendError(res, 403, "Contributor must be verified.");
  }
  const profile = getContributorProfile(state, user.id);
  if (!profile || profile.verification_tier < task.required_skill_tier) {
    return sendError(res, 403, `Task requires skill tier ${task.required_skill_tier}.`);
  }

  task.claimed_by.push(user.id);
  updateTaskStatus(state, task);
  addActivity(state, "task_claimed", `${user.name} claimed "${task.title}".`);
  await saveState(state);
  sendJson(res, 200, { task, state: clientState(state, { session }) });
}

async function submitTask(req, res, state, taskId) {
  const { session, user } = requireSession(state, req, ["contributor"]);
  const body = await readSubmissionBody(req);
  const artifactText = String(body.artifact || "").trim();
  const uploadFiles = body.files || [];
  if (!artifactText && uploadFiles.length === 0) {
    return sendError(res, 400, "Submission requires artifact text or at least one uploaded file.");
  }

  const task = getTask(state, taskId);
  if (!task) return sendError(res, 404, "Task not found.");
  if (!task.claimed_by.includes(user.id)) {
    return sendError(res, 403, "Contributor must claim a task before submitting work.");
  }
  const existing = state.submissions.find((submission) => submission.task_id === taskId && submission.contributor_id === user.id);
  if (existing) return sendError(res, 409, "Contributor already submitted work for this task.");

  const submission = {
    id: createId("sub"),
    task_id: taskId,
    contributor_id: user.id,
    artifact: artifactText || uploadFiles.map((file) => `Uploaded file: ${file.originalName}`).join("\n"),
    notes: String(body.notes || "").trim(),
    status: "submitted",
    review_outcome: null,
    score: null,
    created_at: now()
  };
  const savedFiles = [];
  for (const file of uploadFiles) {
    savedFiles.push(await fileStorage.save({
      ...file,
      submissionId: submission.id,
      uploadedBy: user.id
    }));
  }

  state.submissions.unshift(submission);
  state.submission_files.unshift(...savedFiles);
  updateTaskStatus(state, task);
  addActivity(state, "submission_created", `${user.name} submitted work${savedFiles.length ? ` with ${savedFiles.length} file${savedFiles.length === 1 ? "" : "s"}` : ""} for "${task.title}".`);
  await saveState(state);
  sendJson(res, 201, {
    submission,
    files: savedFiles.map(publicSubmissionFile),
    task,
    state: clientState(state, { session })
  });
}

async function downloadSubmissionFile(req, res, state, submissionId, fileId) {
  const context = requireSession(state, req);
  const submission = state.submissions.find((candidate) => candidate.id === submissionId);
  if (!submission) return sendError(res, 404, "Submission not found.");
  if (!canAccessSubmission(state, context, submission)) {
    return sendError(res, 403, "You do not have access to this submission file.");
  }

  const file = filesForSubmission(state, submissionId).find((candidate) => candidate.id === fileId);
  if (!file) return sendError(res, 404, "Submission file not found.");
  const buffer = await fileStorage.read(file.storage_key);
  sendBinary(res, 200, buffer, {
    "content-type": file.content_type || "application/octet-stream",
    "content-disposition": attachmentDisposition(file.original_name),
    "x-content-type-options": "nosniff"
  });
}

async function reviewSubmission(req, res, state, submissionId) {
  const { session, user: reviewer } = requireSession(state, req, ["reviewer", "admin"]);
  const body = await readBody(req);
  requireFields(body, ["score", "verdict", "notes"]);

  const submission = state.submissions.find((candidate) => candidate.id === submissionId);
  if (!submission) return sendError(res, 404, "Submission not found.");
  if (submission.status !== "submitted") return sendError(res, 409, "Submission has already been reviewed.");

  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return sendError(res, 400, "Review score must be between 1 and 5.");
  if (!["approved", "rejected", "needs_changes"].includes(body.verdict)) return sendError(res, 400, "Review verdict is invalid.");

  const review = {
    id: createId("rev"),
    submission_id: submissionId,
    reviewer_id: reviewer.id,
    score,
    verdict: body.verdict,
    notes: String(body.notes).trim(),
    reviewer_confidence: Number(body.reviewer_confidence || 3),
    created_at: now()
  };

  submission.status = body.verdict === "approved" ? "approved" : "rejected";
  submission.review_outcome = body.verdict;
  submission.score = score;
  state.reviews.unshift(review);

  const task = getTask(state, submission.task_id);
  const contributor = getUser(state, submission.contributor_id);
  const profile = getContributorProfile(state, submission.contributor_id);

  if (body.verdict === "approved") {
    const platformFeeCents = Math.round(task.reward_cents * 0.3);
    const amountCents = task.reward_cents - platformFeeCents;
    const payout = {
      id: createId("pay"),
      submission_id: submission.id,
      contributor_id: submission.contributor_id,
      amount_cents: amountCents,
      platform_fee_cents: platformFeeCents,
      status: contributorCanReceiveTransfers(profile) ? "ready" : "pending",
      stripe_transfer_id: null,
      created_at: now()
    };
    state.payouts.unshift(payout);

    if (profile) {
      profile.completed_tasks += 1;
      const oldApproved = Math.round(profile.approval_rate * Math.max(profile.completed_tasks - 1, 1));
      profile.approval_rate = Math.min(1, (oldApproved + 1) / profile.completed_tasks);
      profile.reputation_score = Math.min(100, Math.round(profile.reputation_score + score * review.reviewer_confidence));
      if (profile.completed_tasks >= 5 && profile.reputation_score >= 75) {
        profile.verification_tier = Math.max(profile.verification_tier, 2);
      }
    }
  } else if (profile) {
    profile.approval_rate = Math.max(0, profile.approval_rate - 0.06);
    profile.reputation_score = Math.max(0, Math.round(profile.reputation_score - 5));
  }

  updateTaskStatus(state, task);
  const deliveryResult = body.verdict === "approved" ? upsertDeliveryPacket(state, task) : null;
  addActivity(state, "submission_reviewed", `${reviewer.name} ${body.verdict.replace("_", " ")} ${contributor.name}'s submission for "${task.title}".`);
  if (deliveryResult?.becameReady) {
    addActivity(state, "delivery_packet_ready", `Delivery packet ready for "${task.title}".`);
  }
  await saveState(state);
  sendJson(res, 201, { review, submission, state: clientState(state, { session }) });
}

async function assembleDeliveryPacket(req, res, state, taskId) {
  const { session, user } = requireSession(state, req, ["customer", "reviewer", "admin"]);
  const task = getTask(state, taskId);
  if (!task) return sendError(res, 404, "Task not found.");

  const approved = approvedSubmissions(state, taskId);
  if (!approved.length) return sendError(res, 409, "At least one approved submission is required before assembling a delivery packet.");

  if (session.active_role === "customer") {
    const org = state.customer_orgs.find((candidate) => candidate.id === task.sponsoring_org_id);
    if (org?.contact_user_id !== user.id) {
      return sendError(res, 403, "Customers can only assemble packets for their own organization.");
    }
  }

  const deliveryResult = upsertDeliveryPacket(state, task);
  addActivity(state, "delivery_packet_updated", `Delivery packet assembled for "${task.title}".`);
  await saveState(state);
  sendJson(res, 201, { delivery_packet: deliveryResult.packet, state: clientState(state, { session }) });
}

async function exportDeliveryReport(req, res, state, packetId) {
  const context = requireSession(state, req, ["customer", "reviewer", "admin"]);
  const { session, user } = context;
  const packet = state.delivery_packets.find((candidate) => candidate.id === packetId);
  if (!packet) return sendError(res, 404, "Delivery packet not found.");
  if (!canAccessDeliveryPacket(state, context, packet)) {
    return sendError(res, 403, "You do not have access to this delivery packet.");
  }
  if (!["ready", "exported", "changes_requested"].includes(packet.status)) {
    return sendError(res, 409, "Delivery packet must be ready before exporting a report.");
  }

  const task = getTask(state, packet.task_id);
  if (!task) return sendError(res, 404, "Task not found.");

  const report = buildDeliveryReport(state, task, packet);
  Object.assign(packet, {
    status: "exported",
    report_title: report.title,
    report_markdown: report.markdown,
    report_exported_at: now(),
    report_exported_by: user.id,
    updated_at: now()
  });
  addActivity(state, "delivery_report_exported", `${user.name} exported a report for "${task.title}".`);
  await saveState(state);
  sendJson(res, 201, { delivery_packet: packet, state: clientState(state, { session }) });
}

async function downloadDeliveryReport(req, res, state, packetId) {
  const context = requireSession(state, req, ["customer", "reviewer", "admin"]);
  const packet = state.delivery_packets.find((candidate) => candidate.id === packetId);
  if (!packet) return sendError(res, 404, "Delivery packet not found.");
  if (!canAccessDeliveryPacket(state, context, packet)) {
    return sendError(res, 403, "You do not have access to this delivery report.");
  }
  if (!packet.report_markdown) return sendError(res, 404, "Delivery report has not been exported yet.");

  const task = getTask(state, packet.task_id);
  sendBinary(res, 200, Buffer.from(packet.report_markdown, "utf8"), {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": attachmentDisposition(reportFileName(task, packet)),
    "x-content-type-options": "nosniff"
  });
}

async function approveDeliveryReport(req, res, state, packetId) {
  const context = requireSession(state, req, ["customer", "admin"]);
  const { session, user } = context;
  const body = await readBody(req);
  requireFields(body, ["decision"]);

  const packet = state.delivery_packets.find((candidate) => candidate.id === packetId);
  if (!packet) return sendError(res, 404, "Delivery packet not found.");
  if (!canAccessDeliveryPacket(state, context, packet)) {
    return sendError(res, 403, "You do not have access to this delivery packet.");
  }
  if (!packet.report_markdown || packet.status !== "exported") {
    return sendError(res, 409, "Export a delivery report before recording customer approval.");
  }

  const decision = String(body.decision);
  if (!["approved", "changes_requested"].includes(decision)) {
    return sendError(res, 400, "Customer approval decision is invalid.");
  }

  const task = getTask(state, packet.task_id);
  const note = String(body.notes || "").trim();
  if (decision === "approved") {
    Object.assign(packet, {
      status: "customer_approved",
      customer_approved_at: now(),
      customer_approved_by: user.id,
      customer_approval_notes: note || "Approved for payout release.",
      updated_at: now()
    });
    addActivity(state, "delivery_report_approved", `${user.name} approved the report for "${task?.title || "a task"}".`);
  } else {
    Object.assign(packet, {
      status: "changes_requested",
      customer_approved_at: null,
      customer_approved_by: null,
      customer_approval_notes: note || "Changes requested before payout release.",
      updated_at: now()
    });
    addActivity(state, "delivery_report_changes_requested", `${user.name} requested report changes for "${task?.title || "a task"}".`);
  }

  await saveState(state);
  sendJson(res, 200, { delivery_packet: packet, state: clientState(state, { session }) });
}

async function releaseDeliveryPayouts(req, res, state, packetId) {
  const { session, user } = requireSession(state, req, ["admin"]);
  const body = await readBody(req);
  const packet = state.delivery_packets.find((candidate) => candidate.id === packetId);
  if (!packet) return sendError(res, 404, "Delivery packet not found.");
  if (packet.status !== "customer_approved") {
    return sendError(res, 409, "Customer approval is required before payout release.");
  }

  const payouts = packetPayouts(state, packet);
  if (!payouts.length) return sendError(res, 409, "No payouts are attached to this delivery packet.");

  const releaseable = payouts.filter((payout) => {
    const profile = getContributorProfile(state, payout.contributor_id);
    return payout.status === "ready" && contributorCanReceiveTransfers(profile);
  });
  if (!releaseable.length) {
    return sendError(res, 409, "No payouts have Stripe-ready connected accounts.");
  }

  const releasedAt = now();
  const note = String(body.note || "").trim() || "Released after customer approval.";
  const failed = [];
  for (const payout of releaseable) {
    const profile = getContributorProfile(state, payout.contributor_id);
    const submission = state.submissions.find((candidate) => candidate.id === payout.submission_id);
    try {
      const transfer = await stripeConnect.createTransfer({
        amountCents: payout.amount_cents,
        destinationAccountId: profile.stripe_connect_account_id,
        payoutId: payout.id,
        taskId: submission?.task_id || packet.task_id,
        contributorId: payout.contributor_id,
        description: `Alignment Galaxy payout for ${submission?.task_id || packet.task_id}`
      });
      payout.status = "transferred";
      payout.stripe_transfer_id = transfer.id;
      payout.released_at = releasedAt;
      payout.released_by = user.id;
      payout.release_note = note;
      if (submission) submission.status = "paid";
    } catch (error) {
      payout.status = "failed";
      payout.release_note = error.message || "Stripe transfer failed.";
      failed.push(payout);
    }
  }

  const packetPayoutState = packetPayouts(state, packet);
  const allTransferred = packetPayoutState.every((payout) => payout.status === "transferred");
  const task = getTask(state, packet.task_id);
  if (task && allTransferred) task.status = "paid";
  Object.assign(packet, {
    status: allTransferred ? "payout_released" : "customer_approved",
    payout_released_at: releasedAt,
    payout_released_by: user.id,
    payout_release_note: note,
    updated_at: releasedAt
  });

  const summary = {
    released_count: releaseable.length - failed.length,
    failed_count: failed.length,
    held_count: packetPayoutState.filter((payout) => payout.status === "pending" || payout.status === "held").length,
    transferred_count: packetPayoutState.filter((payout) => payout.status === "transferred").length
  };
  addActivity(state, "payouts_released", `${user.name} released ${summary.released_count} payout${summary.released_count === 1 ? "" : "s"} for "${task?.title || "a task"}".`);
  await saveState(state);
  sendJson(res, 200, { delivery_packet: packet, release_summary: summary, state: clientState(state, { session }) });
}

async function beginStripeOnboarding(req, res, state) {
  const { session, user } = requireSession(state, req, ["contributor"]);
  const profile = getContributorProfile(state, user.id);
  if (!profile) return sendError(res, 403, "Contributor profile required.");

  let accountId = profile.stripe_connect_account_id;
  if (!accountId || (stripeConnect.configured && accountId.startsWith("acct_demo_"))) {
    const account = await stripeConnect.createAccount({ user });
    applyStripeAccountToProfile(state, profile, account);
    accountId = account.id;
  }

  profile.stripe_onboarding_started_at = now();
  const link = await stripeConnect.createAccountLink({
    accountId,
    returnUrl: stripeReturnUrl(req, accountId),
    refreshUrl: stripeRefreshUrl(req, accountId)
  });
  addActivity(state, "stripe_onboarding_started", `${user.name} started Stripe Connect onboarding.`);
  await saveState(state);
  sendJson(res, 200, {
    onboarding_url: link.url,
    profile,
    stripe: stripeConnect.publicConfig(),
    state: clientState(state, { session })
  });
}

async function syncStripeProfile(req, res, state) {
  const { session, user } = requireSession(state, req, ["contributor"]);
  const profile = getContributorProfile(state, user.id);
  if (!profile) return sendError(res, 403, "Contributor profile required.");
  if (!profile.stripe_connect_account_id) return sendError(res, 409, "Start Stripe onboarding before syncing payout status.");

  const account = await stripeConnect.retrieveAccount(profile.stripe_connect_account_id);
  applyStripeAccountToProfile(state, profile, account);
  addActivity(state, "stripe_profile_synced", `${user.name} synced Stripe Connect payout status.`);
  await saveState(state);
  sendJson(res, 200, { profile, state: clientState(state, { session }) });
}

async function handleStripeConnectReturn(req, res, url) {
  const state = await loadState();
  const { session, user } = requireSession(state, req, ["contributor"]);
  const profile = getContributorProfile(state, user.id);
  if (!profile) return sendRedirect(res, "/");

  const accountId = url.searchParams.get("account") || profile.stripe_connect_account_id;
  if (!accountId || accountId !== profile.stripe_connect_account_id) {
    return sendError(res, 403, "Stripe account does not match the current contributor.");
  }

  const account = await stripeConnect.retrieveAccount(accountId);
  applyStripeAccountToProfile(state, profile, account);
  addActivity(state, "stripe_onboarding_returned", `${user.name} returned from Stripe Connect onboarding.`);
  await saveState(state);
  sendRedirect(res, "/?stripe=returned");
}

async function handleStripeConnectRefresh(req, res, url) {
  const state = await loadState();
  const { user } = requireSession(state, req, ["contributor"]);
  const profile = getContributorProfile(state, user.id);
  const accountId = url.searchParams.get("account") || profile?.stripe_connect_account_id;
  if (!profile || !accountId || accountId !== profile.stripe_connect_account_id) {
    return sendError(res, 403, "Stripe account does not match the current contributor.");
  }

  const link = await stripeConnect.createAccountLink({
    accountId,
    returnUrl: stripeReturnUrl(req, accountId),
    refreshUrl: stripeRefreshUrl(req, accountId)
  });
  profile.stripe_onboarding_started_at = now();
  await saveState(state);
  sendRedirect(res, link.url);
}

async function submitScreening(req, res, state) {
  const { session, user } = requireSession(state, req, ["contributor"]);
  const body = await readBody(req);
  requireFields(body, ["response"]);

  const profile = getContributorProfile(state, user.id);
  if (!profile) return sendError(res, 403, "Contributor profile required.");

  profile.verification_tier = Math.max(profile.verification_tier, 1);
  profile.reputation_score = Math.max(profile.reputation_score, 40);
  addActivity(state, "screening_submitted", `${user.name} completed a screening response.`);
  await saveState(state);
  sendJson(res, 201, { profile, state: clientState(state, { session }) });
}

async function beginOAuthLogin(req, res, url) {
  const redirect = await auth.authorizationRedirect(req, url);
  sendRedirect(res, redirect.location, {
    "set-cookie": redirect.cookie
  });
}

async function completeOAuthLogin(req, res, url) {
  const result = await auth.callbackResult(req, url);
  const state = await loadState();
  const user = findOrCreateOAuthUser(state, result.profile);
  const activeRole = resolveActiveRole(user, result.requestedRole);
  const { session, token } = createSessionForUser(state, user, activeRole);
  addActivity(state, "session_created", `${user.name} signed in with ${auth.publicConfig().provider}.`);
  await saveState(state);
  sendRedirect(res, result.returnTo || "/", {
    "set-cookie": [sessionCookie(token), result.clearCookie]
  });
}

async function switchSessionRole(req, res, state) {
  const { session, user } = requireSession(state, req);
  const body = await readBody(req);
  requireFields(body, ["role"]);
  if (!user.roles.includes(body.role)) {
    return sendError(res, 403, "User does not have that role.");
  }
  session.active_role = body.role;
  await saveState(state);
  sendJson(res, 200, { session: sessionView(state, session), state: clientState(state, { session }) });
}

async function createTestSession(req, res, state) {
  if (!testAuthEnabled()) return sendError(res, 404, "API route not found.");
  const body = await readBody(req);
  requireFields(body, ["user_id", "role"]);

  const user = getUser(state, body.user_id);
  if (!user) return sendError(res, 404, "User not found.");
  const { session, token } = createSessionForUser(state, user, body.role);
  addActivity(state, "session_created", `${user.name} signed in through test auth.`);
  await saveState(state);
  sendJson(res, 201, { session: sessionView(state, session), state: clientState(state, { session }) }, {
    "set-cookie": sessionCookie(token)
  });
}

function testAuthEnabled() {
  return process.env.NODE_ENV === "test" || process.env.ALLOW_TEST_AUTH === "true";
}

async function getSession(req, res, state) {
  const context = currentSessionContext(state, req);
  sendJson(res, 200, {
    auth: auth.publicConfig(),
    session: context ? sessionView(state, context.session) : null
  });
}

async function logoutSession(req, res, state) {
  const token = getSessionToken(req);
  if (token) {
    const tokenHash = hashSessionToken(token);
    state.sessions = state.sessions.filter((session) => session.token_hash !== tokenHash && session.session_token_hash !== tokenHash && session.token !== token);
    await saveState(state);
  }
  sendJson(res, 200, { session: null, state: clientState(state) }, {
    "set-cookie": clearSessionCookie()
  });
}

async function handleApi(req, res, url) {
  const state = await loadState();
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, clientState(state, { req }));
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    return getSession(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    return sendError(res, 410, "Demo session creation has been replaced by OAuth sign-in.");
  }

  if (req.method === "POST" && url.pathname === "/api/session/role") {
    return switchSessionRole(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/api/test/session") {
    return createTestSession(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/api/session/logout") {
    return logoutSession(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    if (!testAuthEnabled() && process.env.ALLOW_DATA_RESET !== "true") {
      requireSession(state, req, ["admin"]);
    }
    await fileStorage.clear();
    const reset = await resetState();
    return sendJson(res, 200, clientState(reset), {
      "set-cookie": clearSessionCookie()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    return createTask(req, res, state);
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "tasks" && parts[3] === "claim") {
    return claimTask(req, res, state, parts[2]);
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "tasks" && parts[3] === "submissions") {
    return submitTask(req, res, state, parts[2]);
  }

  if (req.method === "GET" && parts.length === 5 && parts[0] === "api" && parts[1] === "submissions" && parts[3] === "files") {
    return downloadSubmissionFile(req, res, state, parts[2], parts[4]);
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "tasks" && parts[3] === "delivery-packet") {
    return assembleDeliveryPacket(req, res, state, parts[2]);
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "delivery-packets" && parts[3] === "export") {
    return exportDeliveryReport(req, res, state, parts[2]);
  }

  if (req.method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "delivery-packets" && parts[3] === "report") {
    return downloadDeliveryReport(req, res, state, parts[2]);
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "delivery-packets" && parts[3] === "customer-approval") {
    return approveDeliveryReport(req, res, state, parts[2]);
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "delivery-packets" && parts[3] === "release-payouts") {
    return releaseDeliveryPayouts(req, res, state, parts[2]);
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "submissions" && parts[3] === "reviews") {
    return reviewSubmission(req, res, state, parts[2]);
  }

  if (req.method === "POST" && url.pathname === "/api/screening") {
    return submitScreening(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/api/contributor/stripe/onboarding") {
    return beginStripeOnboarding(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/api/contributor/stripe/sync") {
    return syncStripeProfile(req, res, state);
  }

  sendError(res, 404, "API route not found.");
}

async function handleAuth(req, res, url) {
  if (req.method === "GET" && url.pathname === "/auth/login") {
    return beginOAuthLogin(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    return completeOAuthLogin(req, res, url);
  }

  sendError(res, 404, "Auth route not found.");
}

async function handleStripe(req, res, url) {
  if (req.method === "GET" && url.pathname === "/stripe/connect/return") {
    return handleStripeConnectReturn(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/stripe/connect/refresh") {
    return handleStripeConnectRefresh(req, res, url);
  }

  sendError(res, 404, "Stripe route not found.");
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalizedPath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const file = await readFile(filePath);
    const extension = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extension] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
      } else if (url.pathname.startsWith("/auth/")) {
        await handleAuth(req, res, url);
      } else if (url.pathname.startsWith("/stripe/")) {
        await handleStripe(req, res, url);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Internal server error");
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createAppServer().listen(port, () => {
    console.log(`Alignment Galaxy platform running at http://localhost:${port}`);
  });
}

module.exports = {
  closeStateStore,
  createAppServer,
  resetState,
  loadState
};
