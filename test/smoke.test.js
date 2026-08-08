const test = require("node:test");
const assert = require("node:assert/strict");

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.ALLOW_TEST_AUTH = "true";

const { closeStateStore, createAppServer } = require("../server");

function startServer() {
  const server = createAppServer();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function createClient(baseUrl) {
  let cookie = "";

  async function clientRequest(route, options = {}) {
    const isFormData = options.body instanceof FormData;
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: {
        ...(isFormData ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(options.headers || {})
      }
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `Request failed: ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return data;
  }

  return {
    login(userId, role) {
      return clientRequest("/api/test/session", {
        method: "POST",
        body: JSON.stringify({ user_id: userId, role })
      });
    },
    request: clientRequest
  };
}

test("core marketplace loop claims, submits, reviews, and prepares delivery", {
  skip: databaseUrl ? false : "Set TEST_DATABASE_URL or DATABASE_URL to run the Postgres smoke test."
}, async () => {
  const { server, baseUrl } = await startServer();
  try {
    await request(baseUrl, "/api/reset", {
      method: "POST",
      body: "{}"
    });
    const initial = await request(baseUrl, "/api/bootstrap");
    assert.equal(initial.metrics.open_tasks, 2);
    assert.equal(initial.metrics.in_review, 1);

    const task = initial.tasks.find((candidate) => candidate.title === "Generate eval cases for deceptive planning");
    assert.ok(task);
    const mayaUser = initial.users.find((candidate) => candidate.name === "Maya Chen");
    const renUser = initial.users.find((candidate) => candidate.name === "Ren Okafor");
    const customerUser = initial.users.find((candidate) => candidate.name === "Elara Singh");
    const reviewerUser = initial.users.find((candidate) => candidate.name === "Sam Rivera");
    const adminUser = initial.users.find((candidate) => candidate.name === "Jaeson Booker");
    assert.ok(mayaUser);
    assert.ok(renUser);
    assert.ok(customerUser);
    assert.ok(reviewerUser);
    assert.ok(adminUser);

    await assert.rejects(
      () => request(baseUrl, `/api/tasks/${task.id}/claim`, {
        method: "POST",
        body: "{}"
      }),
      (error) => error.message === "Sign in required."
    );

    const maya = createClient(baseUrl);
    const ren = createClient(baseUrl);
    const reviewer = createClient(baseUrl);
    const customer = createClient(baseUrl);
    const admin = createClient(baseUrl);

    const login = await maya.login(mayaUser.id, "contributor");
    assert.equal(login.session.active_role, "contributor");
    assert.equal(login.state.session.user_id, mayaUser.id);

    const claim = await maya.request(`/api/tasks/${task.id}/claim`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(claim.task.claimed_by.includes(mayaUser.id), true);

    const upload = new FormData();
    upload.set("artifact", "Five deceptive planning eval items with rubrics and grading notes.");
    upload.set("notes", "Includes false positive and false negative review flags.");
    upload.set("artifact_files", new Blob(["case,rubric\nplanning,hidden goal pursuit\n"], {
      type: "text/csv"
    }), "planning-evals.csv");

    const submissionResponse = await maya.request(`/api/tasks/${task.id}/submissions`, {
      method: "POST",
      body: upload
    });
    assert.equal(submissionResponse.submission.status, "submitted");
    assert.equal(submissionResponse.submission.contributor_id, mayaUser.id);
    assert.equal(submissionResponse.files.length, 1);
    assert.equal(submissionResponse.files[0].original_name, "planning-evals.csv");
    assert.equal(submissionResponse.state.submission_files.length, 1);

    await ren.login(renUser.id, "contributor");
    const secondClaim = await ren.request(`/api/tasks/${task.id}/claim`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(secondClaim.task.claimed_by.includes(renUser.id), true);

    const secondSubmissionResponse = await ren.request(`/api/tasks/${task.id}/submissions`, {
      method: "POST",
      body: JSON.stringify({
        artifact: "Three alternate eval cases with rubric notes and monitoring flags.",
        notes: "This set emphasizes ambiguous intent and reviewer disagreement cases."
      })
    });
    assert.equal(secondSubmissionResponse.submission.status, "submitted");

    await reviewer.login(reviewerUser.id, "reviewer");
    const reviewResponse = await reviewer.request(`/api/submissions/${submissionResponse.submission.id}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        score: 5,
        verdict: "approved",
        reviewer_confidence: 4,
        notes: "Strong coverage and clear rubric language."
      })
    });

    assert.equal(reviewResponse.submission.status, "approved");
    assert.equal(reviewResponse.state.payouts.length, 1);
    assert.equal(reviewResponse.state.payouts[0].amount_cents, 21000);
    assert.equal(reviewResponse.state.delivery_packets[0].status, "assembling");
    assert.ok(reviewResponse.state.activity[0].message.includes("approved"));
    assert.equal(reviewResponse.review.reviewer_id, reviewerUser.id);
    assert.equal(reviewResponse.state.sessions, undefined);

    const secondReviewResponse = await reviewer.request(`/api/submissions/${secondSubmissionResponse.submission.id}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        score: 4,
        verdict: "approved",
        reviewer_confidence: 3,
        notes: "Good alternate coverage and useful disagreement cases."
      })
    });

    const completedTask = secondReviewResponse.state.tasks.find((candidate) => candidate.id === task.id);
    assert.equal(completedTask.status, "completed");
    assert.equal(secondReviewResponse.state.payouts.length, 2);
    assert.equal(secondReviewResponse.state.delivery_packets[0].status, "ready");
    assert.equal(secondReviewResponse.state.delivery_packets[0].approved_count, 2);
    assert.equal(secondReviewResponse.state.metrics.ready_deliveries, 1);

    await customer.login(customerUser.id, "customer");
    await assert.rejects(
      () => customer.request(`/api/tasks/${task.id}/delivery-packet`, {
        method: "POST",
        body: "{}"
      }),
      (error) => error.statusCode === 403 && error.message.includes("own organization")
    );

    await admin.login(adminUser.id, "admin");
    const assembled = await admin.request(`/api/tasks/${task.id}/delivery-packet`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(assembled.delivery_packet.status, "ready");
    assert.ok(assembled.delivery_packet.customer_summary.includes("Redundancy target met"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeStateStore();
  }
});
