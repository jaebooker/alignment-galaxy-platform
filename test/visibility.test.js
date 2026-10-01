const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../data/seed.json");
const { scopeStateForViewer } = require("../lib/visibility");

const MAYA = "11111111-1111-4111-8111-111111111111";
const REN = "22222222-2222-4222-8222-222222222222";
const ELARA = "33333333-3333-4333-8333-333333333333";
const SAM = "44444444-4444-4444-8444-444444444444";
const JAESON = "55555555-5555-4555-8555-555555555555";

function state() {
  return structuredClone({ ...seed, submission_files: [], delivery_packets: [], payouts: [], reviews: [] });
}

function emails(view) {
  return view.users.map((user) => user.email).filter(Boolean);
}

test("anonymous viewers receive no records", () => {
  const view = scopeStateForViewer(state(), null);
  for (const key of ["users", "tasks", "submissions", "customer_orgs", "contributor_profiles", "activity"]) {
    assert.deepEqual(view[key], [], key);
  }
});

test("contributors see their own work and nobody else's identity", () => {
  const view = scopeStateForViewer(state(), { userId: MAYA, role: "contributor" });
  assert.deepEqual(emails(view), ["maya@example.com"]);
  assert.deepEqual(view.submissions, []);
  assert.deepEqual(view.contributor_profiles.map((profile) => profile.user_id), [MAYA]);
  assert.equal(view.customer_orgs.every((org) => org.contact_user_id === undefined), true);

  const catalogTask = view.tasks.find((task) => task.id.endsWith("883"));
  assert.deepEqual(catalogTask.claimed_by, []);
  assert.equal(catalogTask.claimed_count, 1);
  assert.equal(catalogTask.submission_count, 1);

  const ren = scopeStateForViewer(state(), { userId: REN, role: "contributor" });
  assert.equal(ren.submissions.length, 1);
  assert.deepEqual(ren.tasks.find((task) => task.id.endsWith("883")).claimed_by, [REN]);
});

test("customers see only their organization's tasks and approved work", () => {
  const view = scopeStateForViewer(state(), { userId: ELARA, role: "customer" });
  const apollo = "66666666-6666-4666-8666-666666666666";
  assert.equal(view.tasks.every((task) => task.sponsoring_org_id === apollo), true);
  assert.equal(view.tasks.length, 2);
  assert.deepEqual(view.submissions, [], "submitted-but-unreviewed work stays hidden");
  assert.deepEqual(emails(view), ["elara@example.com"]);
});

test("reviewers see the queue without contact details or payouts", () => {
  const view = scopeStateForViewer(state(), { userId: SAM, role: "reviewer" });
  assert.equal(view.submissions.length, 1);
  assert.deepEqual(emails(view), []);
  assert.deepEqual(view.payouts, []);
  assert.deepEqual(view.contributor_profiles, []);
});

test("admins see everything", () => {
  const view = scopeStateForViewer(state(), { userId: JAESON, role: "admin" });
  assert.equal(view.users.length, seed.users.length);
  assert.equal(view.contributor_profiles.length, seed.contributor_profiles.length);
});
