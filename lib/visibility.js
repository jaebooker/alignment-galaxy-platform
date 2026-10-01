// Decides which records each viewer may see. The server holds the full state;
// clients only ever receive the slice their active role needs.

const CONTRIBUTOR_TASK_STATUSES = new Set(["open", "claimed", "in_review"]);
const CUSTOMER_SUBMISSION_STATUSES = new Set(["approved", "paid"]);

function scopeStateForViewer(state, viewer) {
  const role = viewer?.role || null;
  const userId = viewer?.userId || null;

  if (!role || !userId) return anonymousView(state);
  if (role === "admin") return adminView(state);
  if (role === "reviewer") return reviewerView(state);
  if (role === "customer") return customerView(state, userId);
  return contributorView(state, userId);
}

function baseView(state) {
  return {
    review_standards: state.review_standards || [],
    screening_tasks: state.screening_tasks || [],
    updated_at: state.updated_at || null
  };
}

function anonymousView(state) {
  return {
    ...baseView(state),
    users: [],
    contributor_profiles: [],
    customer_orgs: [],
    tasks: [],
    submissions: [],
    submission_files: [],
    reviews: [],
    payouts: [],
    delivery_packets: [],
    activity: []
  };
}

function adminView(state) {
  return {
    ...baseView(state),
    users: state.users.map(staffUser),
    contributor_profiles: state.contributor_profiles,
    customer_orgs: state.customer_orgs,
    tasks: state.tasks.map((task) => withCounts(state, task)),
    submissions: state.submissions,
    submission_files: state.submission_files,
    reviews: state.reviews,
    payouts: state.payouts,
    delivery_packets: state.delivery_packets,
    activity: state.activity
  };
}

function reviewerView(state) {
  return {
    ...baseView(state),
    users: state.users.map(nameOnly),
    contributor_profiles: [],
    customer_orgs: state.customer_orgs.map(publicOrg),
    tasks: state.tasks.map((task) => withCounts(state, task)),
    submissions: state.submissions,
    submission_files: state.submission_files,
    reviews: state.reviews,
    payouts: [],
    delivery_packets: state.delivery_packets,
    activity: state.activity
  };
}

function customerView(state, userId) {
  const orgIds = new Set(state.customer_orgs.filter((org) => org.contact_user_id === userId).map((org) => org.id));
  const tasks = state.tasks.filter((task) => orgIds.has(task.sponsoring_org_id));
  const taskIds = new Set(tasks.map((task) => task.id));
  const submissions = state.submissions.filter((submission) => {
    return taskIds.has(submission.task_id) && CUSTOMER_SUBMISSION_STATUSES.has(submission.status);
  });
  const submissionIds = new Set(submissions.map((submission) => submission.id));
  const packets = state.delivery_packets.filter((packet) => taskIds.has(packet.task_id));

  return {
    ...baseView(state),
    users: state.users.filter((user) => user.id === userId).map(selfUser),
    contributor_profiles: [],
    customer_orgs: state.customer_orgs.map((org) => (orgIds.has(org.id) ? org : publicOrg(org))),
    tasks: tasks.map((task) => withCounts(state, task)),
    submissions,
    submission_files: state.submission_files.filter((file) => submissionIds.has(file.submission_id)),
    reviews: [],
    payouts: state.payouts
      .filter((payout) => submissionIds.has(payout.submission_id))
      .map(({ contributor_id: _contributorId, ...payout }) => payout),
    delivery_packets: packets,
    activity: []
  };
}

function contributorView(state, userId) {
  const tasks = state.tasks.filter((task) => {
    return CONTRIBUTOR_TASK_STATUSES.has(task.status) || (task.claimed_by || []).includes(userId);
  });
  const submissions = state.submissions.filter((submission) => submission.contributor_id === userId);
  const submissionIds = new Set(submissions.map((submission) => submission.id));

  return {
    ...baseView(state),
    users: state.users.filter((user) => user.id === userId).map(selfUser),
    contributor_profiles: state.contributor_profiles.filter((profile) => profile.user_id === userId),
    customer_orgs: state.customer_orgs.map(publicOrg),
    tasks: tasks.map((task) => contributorTask(state, task, userId)),
    submissions,
    submission_files: state.submission_files.filter((file) => submissionIds.has(file.submission_id)),
    reviews: state.reviews
      .filter((review) => submissionIds.has(review.submission_id))
      .map(({ reviewer_id: _reviewerId, ...review }) => review),
    payouts: state.payouts.filter((payout) => payout.contributor_id === userId),
    delivery_packets: [],
    activity: []
  };
}

// Contributors learn how full a task is and whether they hold a slot, not who else claimed it.
function contributorTask(state, task, userId) {
  const claimedBy = task.claimed_by || [];
  return {
    ...withCounts(state, task),
    claimed_by: claimedBy.includes(userId) ? [userId] : []
  };
}

function withCounts(state, task) {
  return {
    ...task,
    claimed_count: (task.claimed_by || []).length,
    submission_count: state.submissions.filter((submission) => submission.task_id === task.id).length
  };
}

function nameOnly(user) {
  return { id: user.id, name: user.name };
}

function selfUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    verification_status: user.verification_status
  };
}

function staffUser(user) {
  return { ...selfUser(user), created_at: user.created_at };
}

function publicOrg(org) {
  return { id: org.id, name: org.name, type: org.type, vetting_status: org.vetting_status };
}

module.exports = {
  scopeStateForViewer
};
