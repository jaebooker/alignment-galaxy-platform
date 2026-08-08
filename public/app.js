const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

let state = null;
let activeRole = "contributor";
let selectedTaskId = null;
let selectedSubmissionId = null;

const roleLabels = {
  contributor: "Contributor",
  customer: "Customer",
  reviewer: "Reviewer",
  admin: "Admin"
};

const statusLabels = {
  draft: "Draft",
  open: "Open",
  claimed: "Claimed",
  in_review: "In review",
  completed: "Completed",
  paid: "Paid",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  assembling: "Assembling",
  delivered: "Delivered",
  pending: "Pending",
  ready: "Ready",
  public_good: "Public good",
  commercial: "Commercial",
  sensitive: "Sensitive",
  restricted: "Restricted"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format((Number(cents) || 0) / 100);
}

function dateLabel(date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${date}T12:00:00Z`));
}

function relativeTime(value) {
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const diff = new Date(value).getTime() - Date.now();
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function statusPill(value) {
  const normalized = String(value).replaceAll(" ", "_");
  return `<span class="status-pill ${escapeHtml(normalized)}">${escapeHtml(statusLabels[normalized] || statusLabels[value] || value)}</span>`;
}

function tags(tags) {
  return `<div class="tag-row">${(tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function userName(userId) {
  return state.users.find((user) => user.id === userId)?.name || "Unknown user";
}

function orgName(orgId) {
  return state.customer_orgs.find((org) => org.id === orgId)?.name || "Unknown org";
}

function profileFor(userId) {
  return state.contributor_profiles.find((profile) => profile.user_id === userId);
}

function submissionsFor(taskId) {
  return state.submissions.filter((submission) => submission.task_id === taskId);
}

function approvedSubmissionsFor(taskId) {
  return submissionsFor(taskId).filter((submission) => submission.status === "approved");
}

function reviewForSubmission(submissionId) {
  return state.reviews.find((review) => review.submission_id === submissionId);
}

function packetForTask(taskId) {
  return (state.delivery_packets || []).find((packet) => packet.task_id === taskId);
}

function scoreLabel(value) {
  return value === null || value === undefined ? "Pending" : `${value}/5`;
}

function currentSession() {
  return state?.session || null;
}

function currentUser() {
  return currentSession()?.user || null;
}

function currentUserId() {
  return currentSession()?.user_id || null;
}

function demoUserForRole(role) {
  return state?.demo_users?.[role] || null;
}

function customerOrgsForSession() {
  const userId = currentUserId();
  if (!userId) return [];
  if (activeRole === "admin") return state.customer_orgs.filter((org) => org.vetting_status === "approved");
  return state.customer_orgs.filter((org) => org.contact_user_id === userId && org.vetting_status === "approved");
}

function selectedTask() {
  const available = state.tasks[0];
  if (!selectedTaskId && available) selectedTaskId = available.id;
  return state.tasks.find((task) => task.id === selectedTaskId) || available;
}

function selectedSubmission() {
  const queue = state.submissions.filter((submission) => submission.status === "submitted");
  if (!selectedSubmissionId && queue[0]) selectedSubmissionId = queue[0].id;
  return state.submissions.find((submission) => submission.id === selectedSubmissionId) || queue[0];
}

async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function loginAsRole(role) {
  const demoUser = demoUserForRole(role);
  if (!demoUser) throw new Error(`No demo user is available for ${role}.`);
  const result = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({
      user_id: demoUser.user_id,
      role
    })
  });
  state = result.state;
  activeRole = state.session.active_role;
  selectedTaskId = state.tasks[0]?.id || null;
  selectedSubmissionId = state.submissions.find((submission) => submission.status === "submitted")?.id || null;
  return state;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function refresh(message) {
  state = await api("/api/bootstrap");
  if (!state.session) {
    await loginAsRole(activeRole);
  } else {
    activeRole = state.session.active_role;
  }
  if (message) showToast(message);
  render();
}

function header() {
  const session = currentSession();
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <div class="brand-text">
          <strong>Alignment Galaxy</strong>
          <span>MVP control tower</span>
        </div>
      </div>
      <nav class="segmented" aria-label="Role">
        ${Object.entries(roleLabels).map(([role, label]) => `
          <button data-role="${role}" aria-pressed="${role === activeRole}" title="Sign in as ${escapeHtml(demoUserForRole(role)?.name || label)}">${label}</button>
        `).join("")}
      </nav>
      <div class="topbar-actions">
        ${session ? `
          <div class="session-chip">
            <span>${escapeHtml(roleLabels[session.active_role] || session.active_role)}</span>
            <strong>${escapeHtml(session.user.name)}</strong>
          </div>
        ` : ""}
        <button class="btn" data-action="reset" title="Reset demo data">Reset</button>
      </div>
    </header>
  `;
}

function rail() {
  const navItems = {
    contributor: [["market", "Marketplace"], ["screening", "Screening"]],
    customer: [["create", "Create task"], ["portfolio", "Org tasks"]],
    reviewer: [["queue", "Review queue"], ["standards", "Standards"]],
    admin: [["ops", "Operations"], ["schema", "Schema"]]
  };

  return `
    <aside class="rail">
      <section class="rail-section">
        <p class="rail-title">Live system</p>
        <div class="metric-list">
          <div class="metric-row"><span>Open tasks</span><strong>${state.metrics.open_tasks}</strong></div>
          <div class="metric-row"><span>In review</span><strong>${state.metrics.in_review}</strong></div>
          <div class="metric-row"><span>Ready deliveries</span><strong>${state.metrics.ready_deliveries}</strong></div>
          <div class="metric-row"><span>Pending payouts</span><strong>${money(state.metrics.pending_payout_cents)}</strong></div>
        </div>
      </section>
      <section class="rail-section">
        <p class="rail-title">${escapeHtml(roleLabels[activeRole])}</p>
        <div class="nav-stack">
          ${(navItems[activeRole] || []).map(([key, label], index) => `
            <button class="nav-button ${index === 0 ? "active" : ""}" type="button">
              <span>${label}</span><span>${index + 1}</span>
            </button>
          `).join("")}
        </div>
      </section>
      <section class="rail-section">
        <p class="rail-title">Recent activity</p>
        <div class="activity-list">
          ${state.activity.slice(0, 5).map((item) => `
            <div class="activity-item">
              <p>${escapeHtml(item.message)}</p>
              <time>${escapeHtml(relativeTime(item.created_at))}</time>
            </div>
          `).join("")}
        </div>
      </section>
    </aside>
  `;
}

function quickStats() {
  return `
    <div class="quick-stats">
      <div class="stat"><span>Reward pool</span><strong>${money(state.metrics.total_reward_cents)}</strong><small>Commercial and sponsored tasks</small></div>
      <div class="stat"><span>Public-good allocation</span><strong>${state.metrics.public_good_capacity_pct}%</strong><small>Target operating range is 25%</small></div>
      <div class="stat"><span>Review load</span><strong>${state.metrics.in_review}</strong><small>Submissions awaiting verdicts</small></div>
      <div class="stat"><span>Ready deliveries</span><strong>${state.metrics.ready_deliveries}</strong><small>Customer packets ready</small></div>
    </div>
  `;
}

function taskCard(task) {
  const submissions = submissionsFor(task.id);
  const selected = task.id === selectedTaskId ? "selected" : "";
  return `
    <article class="task-card ${selected}" data-task-id="${escapeHtml(task.id)}">
      <div class="task-topline">
        <div>
          <h3>${escapeHtml(task.title)}</h3>
          <p>${escapeHtml(task.description)}</p>
        </div>
        <div class="tag-row">
          ${statusPill(task.status)}
          ${statusPill(task.commerciality)}
        </div>
      </div>
      <div class="meta-grid">
        <div><span>Reward</span><strong>${money(task.reward_cents)}</strong></div>
        <div><span>Tier</span><strong>${task.required_skill_tier}</strong></div>
        <div><span>Redundancy</span><strong>${submissions.length}/${task.redundancy_count}</strong></div>
      </div>
      ${tags(task.skill_tags)}
    </article>
  `;
}

function taskDetail(task) {
  if (!task) return `<section class="detail-panel"><div class="empty-state">No tasks yet.</div></section>`;

  const contributorId = currentUserId();
  const profile = profileFor(contributorId) || { verification_tier: 0 };
  const claimed = task.claimed_by.includes(contributorId);
  const submitted = state.submissions.some((submission) => submission.task_id === task.id && submission.contributor_id === contributorId);
  const blockedByTier = profile.verification_tier < task.required_skill_tier;
  const full = task.claimed_by.length >= task.redundancy_count;
  const claimDisabled = blockedByTier || claimed || full || !["open", "claimed", "in_review"].includes(task.status);

  return `
    <section class="detail-panel">
      <div class="detail-stack">
        <div>
          <p class="section-kicker">${escapeHtml(orgName(task.sponsoring_org_id))}</p>
          <h2>${escapeHtml(task.title)}</h2>
        </div>
        <p>${escapeHtml(task.description)}</p>
        <div class="meta-grid">
          <div><span>Deadline</span><strong>${dateLabel(task.deadline)}</strong></div>
          <div><span>Deliverable</span><strong>${escapeHtml(task.deliverable_format)}</strong></div>
          <div><span>Risk</span><strong>${escapeHtml(task.risk_level)}</strong></div>
        </div>
        <div class="criterion-list">
          ${(task.acceptance_criteria || []).map((criterion) => `<div class="criterion-item">${escapeHtml(criterion)}</div>`).join("")}
        </div>
        ${tags(task.skill_tags)}
        <div class="button-row">
          <button class="btn primary" data-action="claim" data-task-id="${escapeHtml(task.id)}" ${claimDisabled ? "disabled" : ""}>
            ${claimed ? "Claimed" : full ? "Redundancy full" : blockedByTier ? `Tier ${task.required_skill_tier} required` : "Claim task"}
          </button>
        </div>
        ${claimed ? `
          <div class="divider"></div>
          <form class="submission-form" data-task-id="${escapeHtml(task.id)}">
            <div class="field-grid single">
              <label>Artifact
                <textarea name="artifact" ${submitted ? "disabled" : ""} required>${submitted ? "Submission already received." : ""}</textarea>
              </label>
              <label>Reviewer notes
                <textarea name="notes" ${submitted ? "disabled" : ""}></textarea>
              </label>
            </div>
            <div class="button-row">
              <button class="btn secondary" ${submitted ? "disabled" : ""}>Submit work</button>
            </div>
          </form>
        ` : ""}
      </div>
    </section>
  `;
}

function contributorView() {
  const task = selectedTask();
  const profile = profileFor(currentUserId()) || { verification_tier: 0, reputation_score: 0, approval_rate: 0 };
  const visibleTasks = state.tasks.filter((candidate) => ["open", "claimed", "in_review"].includes(candidate.status));

  return `
    <section>
      <div class="view-header">
        <div>
          <h1>Contributor marketplace</h1>
          <p>${escapeHtml(currentUser()?.name || "Signed-out contributor")} · Tier ${profile.verification_tier} · ${profile.reputation_score} reputation · ${Math.round(profile.approval_rate * 100)}% approval</p>
        </div>
      </div>
      ${quickStats()}
      <div class="two-column">
        <section class="panel">
          <div class="panel-header">
            <h2>Available work</h2>
            <span class="status-pill open">${visibleTasks.length} tasks</span>
          </div>
          <div class="task-list">
            ${visibleTasks.map(taskCard).join("")}
          </div>
        </section>
        ${taskDetail(task)}
      </div>
      <section class="form-panel" id="screening">
        <div class="panel-header">
          <h2>Screening task</h2>
          <span class="status-pill ready">Tier 1 gate</span>
        </div>
        <form class="screening-form">
          <div class="field-grid single">
            <label>Response
              <textarea name="response" required>False positive risk: the eval may flag harmless strategic planning. False negative risk: a model may avoid explicit goal language while still pursuing hidden objectives. Improvement: add paired benign and adversarial controls with rubric anchors.</textarea>
            </label>
          </div>
          <div class="button-row">
            <button class="btn secondary">Submit screening</button>
          </div>
        </form>
      </section>
    </section>
  `;
}

function customerTaskRows() {
  return state.tasks.map((task) => {
    const approvedCount = approvedSubmissionsFor(task.id).length;
    const packet = packetForTask(task.id);
    return `
      <tr>
        <td><strong>${escapeHtml(task.title)}</strong><br><span class="tag">${escapeHtml(task.task_type.replaceAll("_", " "))}</span></td>
        <td>${statusPill(task.status)}</td>
        <td>${money(task.reward_cents)}</td>
        <td>${approvedCount}/${task.redundancy_count}</td>
        <td>${packet ? statusPill(packet.status) : `<span class="tag">None</span>`}</td>
        <td>${dateLabel(task.deadline)}</td>
        <td>
          <button class="btn inline-action" data-action="assemble-packet" data-task-id="${escapeHtml(task.id)}" ${approvedCount === 0 ? "disabled" : ""}>Assemble</button>
        </td>
      </tr>
    `;
  }).join("");
}

function customerDeliverables() {
  const packets = state.delivery_packets || [];
  return `
    <section class="panel">
      <div class="panel-header">
        <h2>Delivery packets</h2>
        <span class="status-pill ready">${state.metrics.ready_deliveries} ready</span>
      </div>
      ${packets.length ? `
        <div class="deliverable-grid">
          ${packets.map((packet) => {
            const task = state.tasks.find((candidate) => candidate.id === packet.task_id);
            return `
              <article class="deliverable-card">
                <div class="task-topline">
                  <div>
                    <h3>${escapeHtml(task?.title || "Untitled task")}</h3>
                    <p>${escapeHtml(packet.customer_summary)}</p>
                  </div>
                  ${statusPill(packet.status)}
                </div>
                <div class="meta-grid">
                  <div><span>Approved</span><strong>${packet.approved_count}/${packet.required_count}</strong></div>
                  <div><span>Avg score</span><strong>${scoreLabel(packet.average_score)}</strong></div>
                  <div><span>Confidence</span><strong>${scoreLabel(packet.average_reviewer_confidence)}</strong></div>
                </div>
                <div class="artifact-block">${escapeHtml(packet.review_summary)}</div>
                <div class="artifact-block">${escapeHtml(packet.risk_notes)}</div>
              </article>
            `;
          }).join("")}
        </div>
      ` : `<div class="empty-state">No delivery packets yet.</div>`}
    </section>
  `;
}

function customerView() {
  const customerOrgs = customerOrgsForSession();
  const primaryOrg = customerOrgs[0];
  return `
    <section>
      <div class="view-header">
        <div>
          <h1>Customer workspace</h1>
          <p>${primaryOrg ? `${escapeHtml(primaryOrg.name)} · Approved buyer · ${escapeHtml(primaryOrg.billing_status.replaceAll("_", " "))}` : "No approved organization attached to this session."}</p>
        </div>
      </div>
      ${quickStats()}
      <div class="two-column">
        <section class="form-panel">
          <div class="panel-header">
            <h2>Create task</h2>
            <span class="status-pill ready">Vetted org</span>
          </div>
          <form class="task-form">
            <div class="field-grid single">
              <label>Title
                <input name="title" value="Probe multimodal refusal boundary cases" required>
              </label>
              <label>Description
                <textarea name="description" required>Identify cases where a multimodal assistant safely refuses text-only requests but becomes overconfident when an image implies missing context. Submit prompt set, observed behavior, and rubric notes.</textarea>
              </label>
            </div>
            <div class="field-grid">
              <label>Task type
                <select name="task_type">
                  <option value="red_team">Red-team</option>
                  <option value="eval_generation">Eval generation</option>
                  <option value="behavior_catalog">Behavior catalog</option>
                  <option value="deployment_monitoring">Deployment monitoring</option>
                  <option value="research_task">Research task</option>
                </select>
              </label>
              <label>Commerciality
                <select name="commerciality">
                  <option value="commercial">Commercial</option>
                  <option value="public_good">Public good</option>
                </select>
              </label>
              <label>Reward
                <input name="reward" type="number" min="50" step="10" value="380" required>
              </label>
              <label>Required tier
                <input name="required_skill_tier" type="number" min="1" max="4" value="2" required>
              </label>
              <label>Redundancy count
                <input name="redundancy_count" type="number" min="1" max="5" value="3" required>
              </label>
              <label>Deadline
                <input name="deadline" type="date" value="2026-09-11" required>
              </label>
              <label>Sponsor
                <select name="sponsoring_org_id">
                  ${customerOrgs.map((org) => `<option value="${escapeHtml(org.id)}">${escapeHtml(org.name)}</option>`).join("")}
                </select>
              </label>
              <label>Risk level
                <select name="risk_level">
                  <option value="standard">Standard</option>
                  <option value="sensitive">Sensitive</option>
                  <option value="restricted">Restricted</option>
                </select>
              </label>
            </div>
            <div class="field-grid single">
              <label>Skill tags
                <input name="skill_tags" value="red teaming, multimodal, safety policy">
              </label>
              <label>Deliverable format
                <input name="deliverable_format" value="prompt-response bundle">
              </label>
              <label>Acceptance criteria
                <textarea name="acceptance_criteria">Includes prompt, response, and risk rationale.
Highlights uncertainty and recommended follow-up.
Can be reviewed without private customer context.</textarea>
              </label>
            </div>
            <div class="button-row">
              <button class="btn primary" ${customerOrgs.length ? "" : "disabled"}>Post task</button>
            </div>
          </form>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>Engagement pipeline</h2>
            <span class="status-pill in_review">${state.metrics.in_review} in review</span>
          </div>
          <div class="network-map">
            <div class="network-step"><strong>Task posted</strong><span>${state.tasks.length} total tasks</span></div>
            <div class="network-step"><strong>Contributors</strong><span>${state.metrics.verified_contributors} verified profiles</span></div>
            <div class="network-step"><strong>Submission</strong><span>${state.submissions.length} artifacts</span></div>
            <div class="network-step"><strong>Review</strong><span>${state.metrics.in_review} pending verdicts</span></div>
            <div class="network-step"><strong>Payout</strong><span>${money(state.metrics.pending_payout_cents)} queued</span></div>
          </div>
        </section>
      </div>
      ${customerDeliverables()}
      <section class="panel">
        <div class="panel-header">
          <h2>Org tasks</h2>
          <span class="status-pill open">${state.tasks.length} records</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Task</th><th>Status</th><th>Reward</th><th>Approved</th><th>Packet</th><th>Deadline</th><th>Action</th></tr></thead>
            <tbody>${customerTaskRows()}</tbody>
          </table>
        </div>
      </section>
    </section>
  `;
}

function queueItem(submission) {
  const task = state.tasks.find((candidate) => candidate.id === submission.task_id);
  return `
    <article class="queue-item ${submission.id === selectedSubmissionId ? "selected" : ""}" data-submission-id="${escapeHtml(submission.id)}">
      <div class="queue-topline">
        <div>
          <h3>${escapeHtml(task?.title || "Untitled task")}</h3>
          <p>${escapeHtml(userName(submission.contributor_id))} · ${escapeHtml(relativeTime(submission.created_at))}</p>
        </div>
        ${statusPill(submission.status)}
      </div>
      <p>${escapeHtml(submission.artifact)}</p>
    </article>
  `;
}

function reviewStandardsBlock() {
  return `
    <section class="panel">
      <div class="panel-header">
        <h2>Review standards</h2>
        <span class="status-pill ready">${(state.review_standards || []).length} checks</span>
      </div>
      <div class="criterion-list">
        ${(state.review_standards || []).map((standard) => `<div class="criterion-item">${escapeHtml(standard)}</div>`).join("")}
      </div>
    </section>
  `;
}

function peerSubmissionList(peerSubmissions, selectedId) {
  return `
    <div class="comparison-list">
      ${peerSubmissions.map((peer) => {
        const review = reviewForSubmission(peer.id);
        return `
          <div class="comparison-item ${peer.id === selectedId ? "active" : ""}">
            <div class="task-topline">
              <div>
                <strong>${escapeHtml(userName(peer.contributor_id))}</strong>
                <p>${escapeHtml(peer.artifact)}</p>
              </div>
              ${statusPill(peer.status)}
            </div>
            <div class="tag-row">
              <span class="tag">Score ${scoreLabel(peer.score)}</span>
              ${review ? `<span class="tag">Confidence ${review.reviewer_confidence}/5</span>` : `<span class="tag">Awaiting review</span>`}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function reviewerView() {
  const queue = state.submissions.filter((submission) => submission.status === "submitted");
  const submission = selectedSubmission();
  const task = submission ? state.tasks.find((candidate) => candidate.id === submission.task_id) : null;
  const peerSubmissions = task ? submissionsFor(task.id) : [];

  return `
    <section>
      <div class="view-header">
        <div>
          <h1>Review queue</h1>
          <p>${escapeHtml(currentUser()?.name || "Signed-out reviewer")} · Vetted reviewer · Redundancy and reputation checks</p>
        </div>
      </div>
      ${quickStats()}
      <div class="review-layout">
        <div class="review-sidebar">
          <section class="panel">
            <div class="panel-header">
              <h2>Awaiting verdict</h2>
              <span class="status-pill in_review">${queue.length} submissions</span>
            </div>
            <div class="queue-list">
              ${queue.length ? queue.map(queueItem).join("") : `<div class="empty-state">Review queue is clear.</div>`}
            </div>
          </section>
          ${reviewStandardsBlock()}
        </div>
        <section class="detail-panel">
          ${submission ? `
            <div class="submission-body">
              <div>
                <p class="section-kicker">${escapeHtml(task.task_type.replaceAll("_", " "))}</p>
                <h2>${escapeHtml(task.title)}</h2>
              </div>
              <div class="meta-grid">
                <div><span>Contributor</span><strong>${escapeHtml(userName(submission.contributor_id))}</strong></div>
                <div><span>Reward</span><strong>${money(task.reward_cents)}</strong></div>
                <div><span>Redundancy</span><strong>${peerSubmissions.length}/${task.redundancy_count}</strong></div>
              </div>
              <div class="criterion-list">
                ${(task.acceptance_criteria || []).map((criterion) => `<div class="criterion-item">${escapeHtml(criterion)}</div>`).join("")}
              </div>
              <div class="artifact-block">${escapeHtml(submission.artifact)}</div>
              <div class="artifact-block">${escapeHtml(submission.notes || "No reviewer notes.")}</div>
              ${peerSubmissionList(peerSubmissions, submission.id)}
              <form class="review-form" data-submission-id="${escapeHtml(submission.id)}">
                <div class="field-grid">
                  <label>Verdict
                    <select name="verdict">
                      <option value="approved">Approve</option>
                      <option value="needs_changes">Needs changes</option>
                      <option value="rejected">Reject</option>
                    </select>
                  </label>
                  <label>Score
                    <input name="score" type="number" min="1" max="5" value="4" required>
                  </label>
                  <label>Confidence
                    <input name="reviewer_confidence" type="number" min="1" max="5" value="3" required>
                  </label>
                </div>
                <div class="field-grid single">
                  <label>Notes
                    <textarea name="notes" required>Clear artifact with enough context to validate. Approve for customer aggregation.</textarea>
                  </label>
                </div>
                <div class="button-row">
                  <button class="btn primary">Record verdict</button>
                </div>
              </form>
            </div>
          ` : `<div class="empty-state">No submitted work is waiting for review.</div>`}
        </section>
      </div>
    </section>
  `;
}

function adminView() {
  const profiles = state.contributor_profiles.map((profile) => {
    const user = state.users.find((candidate) => candidate.id === profile.user_id);
    return { ...profile, name: user?.name || "Unknown" };
  });
  const payouts = state.payouts.length ? state.payouts : [];
  const packets = state.delivery_packets || [];

  return `
    <section>
      <div class="view-header">
        <div>
          <h1>Operations dashboard</h1>
          <p>Quality control, reputation, public-good allocation, and payout readiness.</p>
        </div>
      </div>
      ${quickStats()}
      <div class="two-column">
        <section class="panel">
          <div class="panel-header">
            <h2>Quality system</h2>
            <span class="status-pill ready">MVP v1</span>
          </div>
          <div class="network-map">
            <div class="network-step"><strong>Identity</strong><span>Email, OAuth, payout ID gate</span></div>
            <div class="network-step"><strong>Skill tier</strong><span>Screening plus approved work</span></div>
            <div class="network-step"><strong>Redundancy</strong><span>2-3 contributors per critical task</span></div>
            <div class="network-step"><strong>Review</strong><span>Vetted reviewer verdicts</span></div>
            <div class="network-step"><strong>Reputation</strong><span>Approval rate weighted by confidence</span></div>
          </div>
          <div class="capacity-bar" style="--capacity: ${Math.min(state.metrics.public_good_capacity_pct, 100)}%"><span></span></div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>Payout queue</h2>
            <span class="status-pill pending">${money(state.metrics.pending_payout_cents)}</span>
          </div>
          <div class="payout-list">
            ${payouts.length ? payouts.map((payout) => `
              <div class="payout-row">
                <div>
                  <strong>${escapeHtml(userName(payout.contributor_id))}</strong>
                  <p>${money(payout.amount_cents)} contributor payout · ${money(payout.platform_fee_cents)} platform fee</p>
                </div>
                ${statusPill(payout.status)}
              </div>
            `).join("") : `<div class="empty-state">No approved payouts yet.</div>`}
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-header">
          <h2>Delivery readiness</h2>
          <span class="status-pill ready">${state.metrics.ready_deliveries} ready</span>
        </div>
        ${packets.length ? `
          <div class="deliverable-grid">
            ${packets.map((packet) => {
              const task = state.tasks.find((candidate) => candidate.id === packet.task_id);
              return `
                <article class="deliverable-card">
                  <div class="task-topline">
                    <div>
                      <h3>${escapeHtml(task?.title || "Untitled task")}</h3>
                      <p>${escapeHtml(packet.customer_summary)}</p>
                    </div>
                    ${statusPill(packet.status)}
                  </div>
                  <div class="meta-grid">
                    <div><span>Approved</span><strong>${packet.approved_count}/${packet.required_count}</strong></div>
                    <div><span>Avg score</span><strong>${scoreLabel(packet.average_score)}</strong></div>
                    <div><span>Confidence</span><strong>${scoreLabel(packet.average_reviewer_confidence)}</strong></div>
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        ` : `<div class="empty-state">No delivery packets yet.</div>`}
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Contributor reputation</h2>
          <span class="status-pill open">${profiles.length} profiles</span>
        </div>
        <div class="profile-list">
          ${profiles.map((profile) => `
            <article class="profile-row">
              <div class="task-topline">
                <div>
                  <h3>${escapeHtml(profile.name)}</h3>
                  <p>Tier ${profile.verification_tier} · ${profile.completed_tasks} completed · ${Math.round(profile.approval_rate * 100)}% approval</p>
                </div>
                <strong>${profile.reputation_score}</strong>
              </div>
              ${tags(profile.skills)}
            </article>
          `).join("")}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Schema coverage</h2>
          <span class="status-pill ready">Postgres-ready</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Entity</th><th>MVP purpose</th><th>Current count</th></tr></thead>
            <tbody>
              <tr><td>users</td><td>Multi-role identity records</td><td>${state.users.length}</td></tr>
              <tr><td>contributor_profiles</td><td>Skills, tiers, reputation, payout status</td><td>${state.contributor_profiles.length}</td></tr>
              <tr><td>customer_orgs</td><td>Vetted buyer and sponsor organizations</td><td>${state.customer_orgs.length}</td></tr>
              <tr><td>tasks</td><td>Red-team, eval, cataloging, monitoring work units</td><td>${state.tasks.length}</td></tr>
              <tr><td>submissions</td><td>Contributor artifacts awaiting QC</td><td>${state.submissions.length}</td></tr>
              <tr><td>reviews</td><td>Verdicts, confidence, scoring notes</td><td>${state.reviews.length}</td></tr>
              <tr><td>delivery_packets</td><td>Customer-ready approved work bundles</td><td>${packets.length}</td></tr>
              <tr><td>payouts</td><td>Stripe transfer-ready approved work</td><td>${state.payouts.length}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  `;
}

function mainView() {
  if (activeRole === "customer") return customerView();
  if (activeRole === "reviewer") return reviewerView();
  if (activeRole === "admin") return adminView();
  return contributorView();
}

function render() {
  app.innerHTML = `
    ${header()}
    <main class="shell">
      ${rail()}
      <div class="workspace">
        ${mainView()}
      </div>
    </main>
  `;
  bindEvents();
}

function bindEvents() {
  document.querySelectorAll("[data-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await loginAsRole(button.dataset.role);
        showToast(`Signed in as ${currentUser().name}.`);
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-task-id].task-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedTaskId = card.dataset.taskId;
      render();
    });
  });

  document.querySelectorAll("[data-submission-id].queue-item").forEach((item) => {
    item.addEventListener("click", () => {
      selectedSubmissionId = item.dataset.submissionId;
      render();
    });
  });

  document.querySelectorAll("[data-action='claim']").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const result = await api(`/api/tasks/${button.dataset.taskId}/claim`, {
          method: "POST",
          body: "{}"
        });
        state = result.state;
        showToast("Task claimed.");
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll(".submission-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      try {
        const result = await api(`/api/tasks/${form.dataset.taskId}/submissions`, {
          method: "POST",
          body: JSON.stringify({
            artifact: formData.get("artifact"),
            notes: formData.get("notes")
          })
        });
        state = result.state;
        showToast("Submission sent to review.");
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll(".screening-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      try {
        const result = await api("/api/screening", {
          method: "POST",
          body: JSON.stringify({
            response: formData.get("response")
          })
        });
        state = result.state;
        showToast("Screening response recorded.");
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll(".task-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      try {
        const result = await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            title: formData.get("title"),
            description: formData.get("description"),
            task_type: formData.get("task_type"),
            reward_cents: Number(formData.get("reward")) * 100,
            required_skill_tier: Number(formData.get("required_skill_tier")),
            redundancy_count: Number(formData.get("redundancy_count")),
            deadline: formData.get("deadline"),
            sponsoring_org_id: formData.get("sponsoring_org_id"),
            commerciality: formData.get("commerciality"),
            skill_tags: formData.get("skill_tags"),
            acceptance_criteria: formData.get("acceptance_criteria"),
            deliverable_format: formData.get("deliverable_format"),
            risk_level: formData.get("risk_level")
          })
        });
        state = result.state;
        selectedTaskId = result.task.id;
        showToast("Task posted.");
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-action='assemble-packet']").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const result = await api(`/api/tasks/${button.dataset.taskId}/delivery-packet`, {
          method: "POST",
          body: "{}"
        });
        state = result.state;
        showToast("Delivery packet assembled.");
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll(".review-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      try {
        const result = await api(`/api/submissions/${form.dataset.submissionId}/reviews`, {
          method: "POST",
          body: JSON.stringify({
            verdict: formData.get("verdict"),
            score: Number(formData.get("score")),
            reviewer_confidence: Number(formData.get("reviewer_confidence")),
            notes: formData.get("notes")
          })
        });
        state = result.state;
        selectedSubmissionId = state.submissions.find((submission) => submission.status === "submitted")?.id || null;
        showToast("Review recorded.");
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-action='reset']").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = await api("/api/reset", { method: "POST", body: "{}" });
      state = result;
      await loginAsRole(activeRole);
      showToast("Demo data reset.");
      render();
    });
  });
}

refresh().catch((error) => {
  app.innerHTML = `<main class="loading-screen"><p>${escapeHtml(error.message)}</p></main>`;
});
