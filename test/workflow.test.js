const test = require("node:test");
const assert = require("node:assert/strict");

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.ALLOW_TEST_AUTH = "true";

const { closeStateStore, createAppServer } = require("../server");
const seed = require("../data/seed.json");

const MAYA = "11111111-1111-4111-8111-111111111111";
const REN = "22222222-2222-4222-8222-222222222222";
const SAM = "44444444-4444-4444-8444-444444444444";
const JAESON = "55555555-5555-4555-8555-555555555555";
const ELARA = "33333333-3333-4333-8333-333333333333";
const DECEPTIVE_PLANNING_TASK = "88888888-8888-4888-8888-888888888882";
const CATALOG_SUBMISSION = "99999999-9999-4999-8999-999999999999";
const skip = databaseUrl ? false : "Set TEST_DATABASE_URL or DATABASE_URL to run Postgres workflow tests.";

async function withServer(run) {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${baseUrl}/api/reset`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function client(baseUrl) {
  let cookie = "";
  async function call(route, body, method = "POST") {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {})
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = await response.json();
    return { status: response.status, data };
  }
  return {
    call,
    async login(userId, role) {
      const result = await call("/api/test/session", { user_id: userId, role });
      assert.equal(result.status, 201, result.data.error);
      return result.data.state;
    }
  };
}

test.after(async () => {
  if (databaseUrl) await closeStateStore();
});

test("concurrent writes from different users are all kept", { skip }, async () => {
  await withServer(async (baseUrl) => {
    const maya = client(baseUrl);
    const ren = client(baseUrl);
    await maya.login(MAYA, "contributor");
    await ren.login(REN, "contributor");

    const rounds = 8;
    for (let index = 0; index < rounds; index += 1) {
      await Promise.all([
        maya.call("/api/screening", { response: "a" }),
        ren.call("/api/screening", { response: "b" })
      ]);
    }

    const admin = client(baseUrl);
    const state = await admin.login(JAESON, "admin");
    const screenings = state.activity.filter((event) => event.kind === "screening_submitted").length;
    assert.equal(screenings, rounds * 2);
  });
});

test("reviewers cannot approve their own submissions", { skip }, async () => {
  await withServer(async (baseUrl) => {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'contributor') ON CONFLICT DO NOTHING", [SAM]);
    await pool.query(
      "INSERT INTO contributor_profiles (user_id, verification_tier) VALUES ($1, 2) ON CONFLICT (user_id) DO UPDATE SET verification_tier = 2",
      [SAM]
    );
    await pool.end();

    const sam = client(baseUrl);
    await sam.login(SAM, "contributor");
    assert.equal((await sam.call(`/api/tasks/${DECEPTIVE_PLANNING_TASK}/claim`)).status, 200);
    const submitted = await sam.call(`/api/tasks/${DECEPTIVE_PLANNING_TASK}/submissions`, { artifact: "Self-authored eval set." });
    assert.equal(submitted.status, 201);

    await sam.call("/api/session/role", { role: "reviewer" });
    const review = await sam.call(`/api/submissions/${submitted.data.submission.id}/reviews`, {
      score: 5,
      verdict: "approved",
      notes: "Looks great."
    });
    assert.equal(review.status, 403);
  });
});

test("needs-changes allows a revision; rejection frees the slot and blocks reclaiming", { skip }, async () => {
  await withServer(async (baseUrl) => {
    const maya = client(baseUrl);
    const reviewer = client(baseUrl);
    await maya.login(MAYA, "contributor");
    await reviewer.login(SAM, "reviewer");

    await maya.call(`/api/tasks/${DECEPTIVE_PLANNING_TASK}/claim`);
    const first = await maya.call(`/api/tasks/${DECEPTIVE_PLANNING_TASK}/submissions`, { artifact: "Draft eval set." });
    const needsChanges = await reviewer.call(`/api/submissions/${first.data.submission.id}/reviews`, {
      score: 2,
      verdict: "needs_changes",
      notes: "Add grading rubric."
    });
    assert.equal(needsChanges.data.submission.status, "needs_changes");

    const revision = await maya.call(`/api/tasks/${DECEPTIVE_PLANNING_TASK}/submissions`, { artifact: "Eval set with rubric." });
    assert.equal(revision.status, 201);
    const duplicate = await maya.call(`/api/tasks/${DECEPTIVE_PLANNING_TASK}/submissions`, { artifact: "Again." });
    assert.equal(duplicate.status, 409);

    const rejected = await reviewer.call(`/api/submissions/${revision.data.submission.id}/reviews`, {
      score: 1,
      verdict: "rejected",
      notes: "Off-scope."
    });
    assert.equal(rejected.data.submission.status, "rejected");
    const task = rejected.data.state.tasks.find((candidate) => candidate.id === DECEPTIVE_PLANNING_TASK);
    assert.deepEqual(task.claimed_by, []);
    assert.equal(task.status, "open");

    const reclaim = await maya.call(`/api/tasks/${DECEPTIVE_PLANNING_TASK}/claim`);
    assert.equal(reclaim.status, 409);

    const profile = (await maya.call("/api/bootstrap", undefined, "GET")).data.contributor_profiles[0];
    assert.equal(profile.completed_tasks, 0);
    assert.equal(profile.approval_rate, 0);
  });
});

test("tasks with past deadlines are refused", { skip }, async () => {
  await withServer(async (baseUrl) => {
    const customer = client(baseUrl);
    await customer.login(ELARA, "customer");
    const result = await customer.call("/api/tasks", {
      title: "Late task",
      description: "Should not post.",
      task_type: "research_task",
      reward_cents: 1000,
      required_skill_tier: 1,
      redundancy_count: 1,
      deadline: "2020-01-01",
      sponsoring_org_id: seed.customer_orgs[0].id,
      commerciality: "commercial"
    });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /past/);
  });
});

test("data reset is unavailable unless explicitly enabled", { skip }, async () => {
  await withServer(async (baseUrl) => {
    const admin = client(baseUrl);
    await admin.login(JAESON, "admin");
    process.env.ALLOW_TEST_AUTH = "false";
    try {
      const result = await admin.call("/api/reset");
      assert.equal(result.status, 404);
    } finally {
      process.env.ALLOW_TEST_AUTH = "true";
    }
    const queue = await client(baseUrl).login(SAM, "reviewer");
    assert.ok(queue.submissions.some((submission) => submission.id === CATALOG_SUBMISSION));
  });
});

test("oversized JSON bodies are refused", { skip }, async () => {
  await withServer(async (baseUrl) => {
    const maya = client(baseUrl);
    await maya.login(MAYA, "contributor");
    const result = await maya.call("/api/screening", { response: "x".repeat(2 * 1024 * 1024) });
    assert.equal(result.status, 413);
  });
});
