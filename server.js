const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { createJsonStore } = require("./lib/jsonStore");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SEED_FILE = path.join(ROOT, "data", "seed.json");
const DATA_FILE = process.env.ALIGNMENT_GALAXY_DATA || path.join(ROOT, "data", "alignment-galaxy.local.json");
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

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

const store = createJsonStore({
  dataFile: DATA_FILE,
  seedFile: SEED_FILE,
  normalizeState,
  now
});

async function loadState() {
  return store.read();
}

async function saveState(state) {
  await store.write(state);
}

async function resetState() {
  return store.reset();
}

function normalizeState(state) {
  state.sessions ||= [];
  state.delivery_packets ||= [];
  state.review_standards ||= DEFAULT_REVIEW_STANDARDS;
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

function getSessionToken(req) {
  return parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
}

function currentSessionContext(state, req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const session = state.sessions.find((candidate) => candidate.token === token);
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

function demoUsersByRole(state) {
  return ["contributor", "customer", "reviewer", "admin"].reduce((users, role) => {
    const user = state.users.find((candidate) => candidate.roles.includes(role) && candidate.verification_status === "verified");
    if (user) {
      users[role] = {
        user_id: user.id,
        name: user.name
      };
    }
    return users;
  }, {});
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

function getUser(state, userId) {
  return state.users.find((user) => user.id === userId);
}

function getContributorProfile(state, userId) {
  return state.contributor_profiles.find((profile) => profile.user_id === userId);
}

function getTask(state, taskId) {
  return state.tasks.find((task) => task.id === taskId);
}

function taskSubmissions(state, taskId) {
  return state.submissions.filter((submission) => submission.task_id === taskId);
}

function approvedSubmissions(state, taskId) {
  return taskSubmissions(state, taskId).filter((submission) => submission.status === "approved");
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
    ready_deliveries: state.delivery_packets.filter((packet) => packet.status === "ready").length,
    verified_contributors: state.contributor_profiles.filter((profile) => profile.verification_tier > 0).length,
    pending_payout_cents: pendingPayoutCents,
    public_good_capacity_pct: totalRewardCents === 0 ? 0 : Math.round((publicGoodRewardCents / totalRewardCents) * 100),
    total_reward_cents: totalRewardCents
  };
}

function clientState(state, context = {}) {
  const { sessions, ...publicState } = state;
  const session = context.session || (context.req ? currentSessionContext(state, context.req)?.session : null);

  return {
    ...publicState,
    demo_users: demoUsersByRole(state),
    session: sessionView(state, session),
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
  const status = approved.length >= task.redundancy_count ? "ready" : "assembling";
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
  const body = await readBody(req);
  requireFields(body, ["artifact"]);

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
    artifact: String(body.artifact).trim(),
    notes: String(body.notes || "").trim(),
    status: "submitted",
    review_outcome: null,
    score: null,
    created_at: now()
  };

  state.submissions.unshift(submission);
  updateTaskStatus(state, task);
  addActivity(state, "submission_created", `${user.name} submitted work for "${task.title}".`);
  await saveState(state);
  sendJson(res, 201, { submission, task, state: clientState(state, { session }) });
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
      status: profile?.payout_status === "stripe_ready" ? "ready" : "pending",
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

async function createSession(req, res, state) {
  const body = await readBody(req);
  requireFields(body, ["user_id", "role"]);

  const user = getUser(state, body.user_id);
  if (!user) return sendError(res, 404, "User not found.");
  if (user.verification_status !== "verified") return sendError(res, 403, "User must be verified before signing in.");
  if (!user.roles.includes(body.role)) return sendError(res, 403, "User does not have that role.");

  const session = {
    id: createId("sess"),
    token: randomUUID(),
    user_id: user.id,
    active_role: body.role,
    created_at: now(),
    expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString()
  };

  state.sessions = state.sessions.filter((candidate) => Date.parse(candidate.expires_at) > Date.now());
  state.sessions.unshift(session);
  addActivity(state, "session_created", `${user.name} signed in as ${body.role}.`);
  await saveState(state);
  sendJson(res, 201, { session: sessionView(state, session), state: clientState(state, { session }) }, {
    "set-cookie": sessionCookie(session.token)
  });
}

async function getSession(req, res, state) {
  const context = currentSessionContext(state, req);
  sendJson(res, 200, {
    session: context ? sessionView(state, context.session) : null,
    demo_users: demoUsersByRole(state)
  });
}

async function logoutSession(req, res, state) {
  const token = getSessionToken(req);
  if (token) {
    state.sessions = state.sessions.filter((session) => session.token !== token);
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
    return createSession(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/api/session/logout") {
    return logoutSession(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
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

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "tasks" && parts[3] === "delivery-packet") {
    return assembleDeliveryPacket(req, res, state, parts[2]);
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "submissions" && parts[3] === "reviews") {
    return reviewSubmission(req, res, state, parts[2]);
  }

  if (req.method === "POST" && url.pathname === "/api/screening") {
    return submitScreening(req, res, state);
  }

  sendError(res, 404, "API route not found.");
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
  createAppServer,
  resetState,
  loadState
};
