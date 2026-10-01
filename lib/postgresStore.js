const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SCHEMA_FILE = path.join(ROOT, "database", "schema.sql");
const STORE_LOCK_ID = 816504271;
const METADATA_KEY = "state";

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function createPostgresStore({
  connectionString = process.env.DATABASE_URL,
  seedFile,
  schemaFile = DEFAULT_SCHEMA_FILE,
  normalizeState,
  now,
  pool,
  ssl = resolveSsl(connectionString)
}) {
  const ownsPool = !pool;
  const db = pool || new Pool({
    ...(connectionString ? { connectionString } : {}),
    ...(ssl ? { ssl } : {})
  });
  let schemaReady = false;

  async function ensureSchema(client) {
    if (schemaReady) return;
    const schema = await readFile(schemaFile, "utf8");
    await client.query(schema);
    schemaReady = true;
  }

  async function withLockedTransaction(callback, { seedIfEmpty = true } = {}) {
    const client = await db.connect();
    try {
      await ensureSchema(client);
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [STORE_LOCK_ID]);
      if (seedIfEmpty) {
        await seedDatabaseIfEmpty(client);
      }
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedDatabaseIfEmpty(client) {
    const { rows } = await client.query("SELECT EXISTS (SELECT 1 FROM users LIMIT 1) AS has_data");
    if (rows[0]?.has_data) return;
    const seed = JSON.parse(await readFile(seedFile, "utf8"));
    await writeState(client, normalizeState(seed));
  }

  async function read() {
    return withLockedTransaction((client) => readState(client));
  }

  async function write(state) {
    return withLockedTransaction(async (client) => {
      const normalized = normalizeState(state);
      await writeState(client, normalized);
      return normalized;
    }, { seedIfEmpty: false });
  }

  async function reset() {
    return withLockedTransaction(async (client) => {
      const seed = normalizeState(JSON.parse(await readFile(seedFile, "utf8")));
      await writeState(client, seed);
      return readState(client);
    }, { seedIfEmpty: false });
  }

  // Reads, mutates and writes under one advisory lock, so concurrent requests cannot
  // overwrite each other. `shouldWrite` lets callers skip the write when nothing changed.
  async function transaction(mutator, { shouldWrite = () => true } = {}) {
    return withLockedTransaction(async (client) => {
      const state = await readState(client);
      const result = await mutator(state);
      if (shouldWrite(state)) {
        await writeState(client, normalizeState(state));
      }
      return result ?? state;
    });
  }

  async function close() {
    if (ownsPool) await db.end();
  }

  async function readState(client) {
    const users = await readUsers(client);
    const authIdentities = await readAuthIdentities(client);
    const sessions = await readSessions(client);
    const contributorProfiles = await readContributorProfiles(client);
    const customerOrgs = await readCustomerOrgs(client);
    const tasks = await readTasks(client);
    const submissions = await readSubmissions(client);
    const submissionFiles = await readSubmissionFiles(client);
    const reviews = await readReviews(client);
    const payouts = await readPayouts(client);
    const deliveryPackets = await readDeliveryPackets(client);
    const screeningTasks = await readScreeningTasks(client);
    const reviewStandards = await readReviewStandards(client);
    const activity = await readActivity(client);
    const metadata = await readMetadata(client);

    return normalizeState({
      users,
      auth_identities: authIdentities,
      sessions,
      contributor_profiles: contributorProfiles,
      customer_orgs: customerOrgs,
      tasks,
      submissions,
      submission_files: submissionFiles,
      reviews,
      payouts,
      delivery_packets: deliveryPackets,
      screening_tasks: screeningTasks,
      review_standards: reviewStandards,
      activity,
      updated_at: metadata.updated_at || null
    });
  }

  async function writeState(client, state) {
    state.updated_at = now();
    await clearTables(client);
    await writeUsers(client, state.users || []);
    await writeAuthIdentities(client, state.auth_identities || []);
    await writeContributorProfiles(client, state.contributor_profiles || []);
    await writeCustomerOrgs(client, state.customer_orgs || []);
    await writeTasks(client, state.tasks || []);
    await writeSubmissions(client, state.submissions || []);
    await writeSubmissionFiles(client, state.submission_files || []);
    await writeReviews(client, state.reviews || []);
    await writePayouts(client, state.payouts || []);
    await writeDeliveryPackets(client, state.delivery_packets || []);
    await writeSessions(client, state.sessions || []);
    await writeScreeningTasks(client, state.screening_tasks || []);
    await writeReviewStandards(client, state.review_standards || []);
    await writeActivity(client, state.activity || []);
    await client.query(
      `INSERT INTO app_metadata (key, value, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [METADATA_KEY, JSON.stringify({ updated_at: state.updated_at }), state.updated_at]
    );
  }

  return {
    close,
    pool: db,
    read,
    reset,
    transaction,
    write
  };
}

function resolveSsl(connectionString) {
  if (process.env.PGSSLMODE === "disable") return false;
  if (process.env.PGSSLMODE === "require") return { rejectUnauthorized: false };
  if (connectionString && /[?&]sslmode=require\b/.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

async function clearTables(client) {
  const tables = [
    "sessions",
    "delivery_packets",
    "payouts",
    "reviews",
    "submission_files",
    "submissions",
    "task_claims",
    "tasks",
    "customer_orgs",
    "contributor_profiles",
    "auth_identities",
    "user_roles",
    "users",
    "review_standards",
    "screening_tasks",
    "activity_events",
    "app_metadata"
  ];
  for (const table of tables) {
    await client.query(`DELETE FROM ${table}`);
  }
}

async function readUsers(client) {
  const { rows } = await client.query(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.verification_status,
      u.created_at,
      COALESCE(array_agg(ur.role ORDER BY ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at ASC, u.name ASC
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    roles: row.roles,
    verification_status: row.verification_status,
    created_at: iso(row.created_at)
  }));
}

async function writeUsers(client, users) {
  for (const user of users) {
    await client.query(
      `INSERT INTO users (id, name, email, verification_status, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, user.name, user.email, user.verification_status || "pending", user.created_at || new Date().toISOString()]
    );
    for (const role of user.roles || []) {
      await client.query(
        "INSERT INTO user_roles (user_id, role) VALUES ($1, $2)",
        [user.id, role]
      );
    }
  }
}

async function readAuthIdentities(client) {
  const { rows } = await client.query(`
    SELECT provider, subject, user_id, email, created_at, last_seen_at
    FROM auth_identities
    ORDER BY created_at ASC
  `);
  return rows.map((row) => ({
    provider: row.provider,
    subject: row.subject,
    user_id: row.user_id,
    email: row.email,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at)
  }));
}

async function writeAuthIdentities(client, identities) {
  for (const identity of identities) {
    await client.query(
      `INSERT INTO auth_identities (provider, subject, user_id, email, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        identity.provider,
        identity.subject,
        identity.user_id,
        identity.email || null,
        identity.created_at || new Date().toISOString(),
        identity.last_seen_at || new Date().toISOString()
      ]
    );
  }
}

async function readSessions(client) {
  const { rows } = await client.query(`
    SELECT id, session_token_hash, user_id, active_role, created_at, expires_at
    FROM sessions
    ORDER BY created_at DESC
  `);
  return rows.map((row) => ({
    id: row.id,
    token_hash: row.session_token_hash,
    user_id: row.user_id,
    active_role: row.active_role,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at)
  }));
}

async function writeSessions(client, sessions) {
  for (const session of sessions) {
    const tokenHash = session.token_hash || session.session_token_hash || (session.token ? hashSessionToken(session.token) : null);
    if (!tokenHash) continue;
    await client.query(
      `INSERT INTO sessions (id, session_token_hash, user_id, active_role, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        session.id,
        tokenHash,
        session.user_id,
        session.active_role,
        session.created_at || new Date().toISOString(),
        session.expires_at
      ]
    );
  }
}

async function readContributorProfiles(client) {
  const { rows } = await client.query(`
    SELECT
      user_id, skills, verification_tier, reputation_score, approval_rate, completed_tasks,
      payout_status, stripe_connect_account_id, stripe_charges_enabled, stripe_payouts_enabled,
      stripe_requirements_due, stripe_disabled_reason, stripe_onboarding_started_at,
      stripe_onboarded_at, stripe_last_synced_at
    FROM contributor_profiles
    ORDER BY reputation_score DESC, user_id ASC
  `);
  return rows.map((row) => ({
    user_id: row.user_id,
    skills: row.skills || [],
    verification_tier: Number(row.verification_tier),
    reputation_score: Number(row.reputation_score),
    approval_rate: Number(row.approval_rate),
    completed_tasks: Number(row.completed_tasks),
    payout_status: row.payout_status,
    stripe_connect_account_id: row.stripe_connect_account_id,
    stripe_charges_enabled: Boolean(row.stripe_charges_enabled),
    stripe_payouts_enabled: Boolean(row.stripe_payouts_enabled),
    stripe_requirements_due: row.stripe_requirements_due || [],
    stripe_disabled_reason: row.stripe_disabled_reason,
    stripe_onboarding_started_at: iso(row.stripe_onboarding_started_at),
    stripe_onboarded_at: iso(row.stripe_onboarded_at),
    stripe_last_synced_at: iso(row.stripe_last_synced_at)
  }));
}

async function writeContributorProfiles(client, profiles) {
  for (const profile of profiles) {
    await client.query(
      `INSERT INTO contributor_profiles (
        user_id, skills, verification_tier, reputation_score, approval_rate, completed_tasks,
        payout_status, stripe_connect_account_id, stripe_charges_enabled, stripe_payouts_enabled,
        stripe_requirements_due, stripe_disabled_reason, stripe_onboarding_started_at,
        stripe_onboarded_at, stripe_last_synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15
      )`,
      [
        profile.user_id,
        profile.skills || [],
        profile.verification_tier || 0,
        profile.reputation_score || 0,
        profile.approval_rate || 0,
        profile.completed_tasks || 0,
        profile.payout_status || "not_started",
        profile.stripe_connect_account_id || null,
        profile.stripe_charges_enabled || false,
        profile.stripe_payouts_enabled || false,
        profile.stripe_requirements_due || [],
        profile.stripe_disabled_reason || null,
        profile.stripe_onboarding_started_at || null,
        profile.stripe_onboarded_at || null,
        profile.stripe_last_synced_at || null
      ]
    );
  }
}

async function readCustomerOrgs(client) {
  const { rows } = await client.query(`
    SELECT id, name, type, vetting_status, billing_status, contact_user_id
    FROM customer_orgs
    ORDER BY name ASC
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    vetting_status: row.vetting_status,
    billing_status: row.billing_status,
    contact_user_id: row.contact_user_id
  }));
}

async function writeCustomerOrgs(client, orgs) {
  for (const org of orgs) {
    await client.query(
      `INSERT INTO customer_orgs (id, name, type, vetting_status, billing_status, contact_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        org.id,
        org.name,
        org.type,
        org.vetting_status || "pending",
        org.billing_status || "manual_invoice",
        org.contact_user_id || null
      ]
    );
  }
}

async function readTasks(client) {
  const { rows } = await client.query(`
    SELECT
      t.id,
      t.title,
      t.description,
      t.task_type,
      t.reward_cents,
      t.required_skill_tier,
      t.redundancy_count,
      t.deadline,
      t.status,
      t.sponsoring_org_id,
      t.commerciality,
      t.skill_tags,
      t.acceptance_criteria,
      t.deliverable_format,
      t.risk_level,
      t.created_by,
      t.created_at,
      COALESCE(array_agg(tc.contributor_id ORDER BY tc.claimed_at) FILTER (WHERE tc.contributor_id IS NOT NULL), '{}') AS claimed_by
    FROM tasks t
    LEFT JOIN task_claims tc ON tc.task_id = t.id
    GROUP BY t.id
    ORDER BY t.created_at DESC, t.title ASC
  `);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    task_type: row.task_type,
    reward_cents: Number(row.reward_cents),
    required_skill_tier: Number(row.required_skill_tier),
    redundancy_count: Number(row.redundancy_count),
    deadline: dateOnly(row.deadline),
    status: row.status,
    sponsoring_org_id: row.sponsoring_org_id,
    commerciality: row.commerciality,
    skill_tags: row.skill_tags || [],
    deliverable_format: row.deliverable_format,
    risk_level: row.risk_level,
    acceptance_criteria: row.acceptance_criteria || [],
    claimed_by: row.claimed_by || [],
    created_by: row.created_by,
    created_at: iso(row.created_at)
  }));
}

async function writeTasks(client, tasks) {
  for (const task of tasks) {
    await client.query(
      `INSERT INTO tasks (
        id, title, description, task_type, reward_cents, required_skill_tier, redundancy_count, deadline,
        status, sponsoring_org_id, commerciality, skill_tags, acceptance_criteria, deliverable_format,
        risk_level, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        task.id,
        task.title,
        task.description,
        task.task_type,
        task.reward_cents,
        task.required_skill_tier,
        task.redundancy_count,
        task.deadline,
        task.status || "draft",
        task.sponsoring_org_id || null,
        task.commerciality,
        task.skill_tags || [],
        task.acceptance_criteria || [],
        task.deliverable_format || null,
        task.risk_level || "standard",
        task.created_by || null,
        task.created_at || new Date().toISOString()
      ]
    );
    for (const contributorId of task.claimed_by || []) {
      await client.query(
        "INSERT INTO task_claims (task_id, contributor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [task.id, contributorId]
      );
    }
  }
}

async function readSubmissions(client) {
  const { rows } = await client.query(`
    SELECT id, task_id, contributor_id, artifact, notes, status, review_outcome, score, created_at
    FROM submissions
    ORDER BY created_at DESC
  `);
  return rows.map((row) => ({
    id: row.id,
    task_id: row.task_id,
    contributor_id: row.contributor_id,
    artifact: row.artifact,
    notes: row.notes,
    status: row.status,
    review_outcome: row.review_outcome,
    score: row.score === null ? null : Number(row.score),
    created_at: iso(row.created_at)
  }));
}

async function writeSubmissions(client, submissions) {
  for (const submission of submissions) {
    await client.query(
      `INSERT INTO submissions (
        id, task_id, contributor_id, artifact, notes, status, review_outcome, score, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        submission.id,
        submission.task_id,
        submission.contributor_id,
        submission.artifact,
        submission.notes || null,
        submission.status || "submitted",
        submission.review_outcome || null,
        submission.score,
        submission.created_at || new Date().toISOString()
      ]
    );
  }
}

async function readSubmissionFiles(client) {
  const { rows } = await client.query(`
    SELECT
      id, submission_id, uploaded_by, storage_key, original_name, content_type,
      size_bytes, checksum_sha256, created_at
    FROM submission_files
    ORDER BY created_at DESC
  `);
  return rows.map((row) => ({
    id: row.id,
    submission_id: row.submission_id,
    uploaded_by: row.uploaded_by,
    storage_key: row.storage_key,
    original_name: row.original_name,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    checksum_sha256: row.checksum_sha256,
    created_at: iso(row.created_at)
  }));
}

async function writeSubmissionFiles(client, files) {
  for (const file of files) {
    await client.query(
      `INSERT INTO submission_files (
        id, submission_id, uploaded_by, storage_key, original_name, content_type,
        size_bytes, checksum_sha256, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        file.id,
        file.submission_id,
        file.uploaded_by,
        file.storage_key,
        file.original_name,
        file.content_type || "application/octet-stream",
        file.size_bytes,
        file.checksum_sha256,
        file.created_at || new Date().toISOString()
      ]
    );
  }
}

async function readReviews(client) {
  const { rows } = await client.query(`
    SELECT id, submission_id, reviewer_id, score, verdict, notes, reviewer_confidence, created_at
    FROM reviews
    ORDER BY created_at DESC
  `);
  return rows.map((row) => ({
    id: row.id,
    submission_id: row.submission_id,
    reviewer_id: row.reviewer_id,
    score: Number(row.score),
    verdict: row.verdict,
    notes: row.notes,
    reviewer_confidence: Number(row.reviewer_confidence),
    created_at: iso(row.created_at)
  }));
}

async function writeReviews(client, reviews) {
  for (const review of reviews) {
    await client.query(
      `INSERT INTO reviews (
        id, submission_id, reviewer_id, score, verdict, notes, reviewer_confidence, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        review.id,
        review.submission_id,
        review.reviewer_id,
        review.score,
        review.verdict,
        review.notes,
        review.reviewer_confidence || 3,
        review.created_at || new Date().toISOString()
      ]
    );
  }
}

async function readPayouts(client) {
  const { rows } = await client.query(`
    SELECT
      id, submission_id, contributor_id, amount_cents, platform_fee_cents, status,
      stripe_transfer_id, released_at, released_by, release_note, created_at
    FROM payouts
    ORDER BY created_at DESC
  `);
  return rows.map((row) => ({
    id: row.id,
    submission_id: row.submission_id,
    contributor_id: row.contributor_id,
    amount_cents: Number(row.amount_cents),
    platform_fee_cents: Number(row.platform_fee_cents),
    status: row.status,
    stripe_transfer_id: row.stripe_transfer_id,
    released_at: iso(row.released_at),
    released_by: row.released_by,
    release_note: row.release_note,
    created_at: iso(row.created_at)
  }));
}

async function writePayouts(client, payouts) {
  for (const payout of payouts) {
    await client.query(
      `INSERT INTO payouts (
        id, submission_id, contributor_id, amount_cents, platform_fee_cents, status,
        stripe_transfer_id, released_at, released_by, release_note, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        payout.id,
        payout.submission_id,
        payout.contributor_id,
        payout.amount_cents,
        payout.platform_fee_cents || 0,
        payout.status || "pending",
        payout.stripe_transfer_id || null,
        payout.released_at || null,
        payout.released_by || null,
        payout.release_note || null,
        payout.created_at || new Date().toISOString()
      ]
    );
  }
}

async function readDeliveryPackets(client) {
  const { rows } = await client.query(`
    SELECT
      id, task_id, status, approved_submission_ids, approved_count, required_count, average_score,
      average_reviewer_confidence, customer_summary, review_summary, risk_notes,
      report_title, report_markdown, report_exported_at, report_exported_by,
      customer_approved_at, customer_approved_by, customer_approval_notes,
      payout_released_at, payout_released_by, payout_release_note,
      delivered_at, created_at, updated_at
    FROM delivery_packets
    ORDER BY updated_at DESC
  `);
  return rows.map((row) => ({
    id: row.id,
    task_id: row.task_id,
    status: row.status,
    approved_submission_ids: row.approved_submission_ids || [],
    approved_count: Number(row.approved_count),
    required_count: Number(row.required_count),
    average_score: row.average_score === null ? null : Number(row.average_score),
    average_reviewer_confidence: row.average_reviewer_confidence === null ? null : Number(row.average_reviewer_confidence),
    customer_summary: row.customer_summary,
    review_summary: row.review_summary,
    risk_notes: row.risk_notes,
    report_title: row.report_title,
    report_markdown: row.report_markdown,
    report_exported_at: iso(row.report_exported_at),
    report_exported_by: row.report_exported_by,
    customer_approved_at: iso(row.customer_approved_at),
    customer_approved_by: row.customer_approved_by,
    customer_approval_notes: row.customer_approval_notes,
    payout_released_at: iso(row.payout_released_at),
    payout_released_by: row.payout_released_by,
    payout_release_note: row.payout_release_note,
    delivered_at: iso(row.delivered_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  }));
}

async function writeDeliveryPackets(client, packets) {
  for (const packet of packets) {
    await client.query(
      `INSERT INTO delivery_packets (
        id, task_id, status, approved_submission_ids, approved_count, required_count, average_score,
        average_reviewer_confidence, customer_summary, review_summary, risk_notes,
        report_title, report_markdown, report_exported_at, report_exported_by,
        customer_approved_at, customer_approved_by, customer_approval_notes,
        payout_released_at, payout_released_by, payout_release_note,
        delivered_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24
      )`,
      [
        packet.id,
        packet.task_id,
        packet.status || "assembling",
        packet.approved_submission_ids || [],
        packet.approved_count || 0,
        packet.required_count || 1,
        packet.average_score,
        packet.average_reviewer_confidence,
        packet.customer_summary,
        packet.review_summary,
        packet.risk_notes,
        packet.report_title || null,
        packet.report_markdown || null,
        packet.report_exported_at || null,
        packet.report_exported_by || null,
        packet.customer_approved_at || null,
        packet.customer_approved_by || null,
        packet.customer_approval_notes || null,
        packet.payout_released_at || null,
        packet.payout_released_by || null,
        packet.payout_release_note || null,
        packet.delivered_at || null,
        packet.created_at || new Date().toISOString(),
        packet.updated_at || new Date().toISOString()
      ]
    );
  }
}

async function readScreeningTasks(client) {
  const { rows } = await client.query(`
    SELECT id, title, prompt, required_for_tier, status, created_at
    FROM screening_tasks
    ORDER BY required_for_tier ASC, created_at ASC
  `);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    required_for_tier: Number(row.required_for_tier),
    status: row.status,
    created_at: iso(row.created_at)
  }));
}

async function writeScreeningTasks(client, screeningTasks) {
  for (const task of screeningTasks) {
    await client.query(
      `INSERT INTO screening_tasks (id, title, prompt, required_for_tier, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        task.id,
        task.title,
        task.prompt,
        task.required_for_tier || 1,
        task.status || "active",
        task.created_at || new Date().toISOString()
      ]
    );
  }
}

async function readReviewStandards(client) {
  const { rows } = await client.query(`
    SELECT standard
    FROM review_standards
    WHERE active = true
    ORDER BY created_at ASC, title ASC
  `);
  return rows.map((row) => row.standard);
}

async function writeReviewStandards(client, standards) {
  for (const [index, standard] of standards.entries()) {
    const record = typeof standard === "string"
      ? { id: randomUUID(), title: `Standard ${index + 1}`, standard }
      : standard;
    await client.query(
      `INSERT INTO review_standards (id, title, standard, active, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        record.id || randomUUID(),
        record.title || `Standard ${index + 1}`,
        record.standard,
        record.active !== false,
        record.created_at || new Date().toISOString()
      ]
    );
  }
}

async function readActivity(client) {
  const { rows } = await client.query(`
    SELECT id, kind, message, created_at
    FROM activity_events
    ORDER BY created_at DESC
    LIMIT 30
  `);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    message: row.message,
    created_at: iso(row.created_at)
  }));
}

async function writeActivity(client, activity) {
  for (const event of activity.slice(0, 30)) {
    await client.query(
      `INSERT INTO activity_events (id, kind, message, created_at)
       VALUES ($1, $2, $3, $4)`,
      [
        event.id,
        event.kind,
        event.message,
        event.created_at || new Date().toISOString()
      ]
    );
  }
}

async function readMetadata(client) {
  const { rows } = await client.query(
    "SELECT value, updated_at FROM app_metadata WHERE key = $1",
    [METADATA_KEY]
  );
  return {
    updated_at: rows[0]?.value?.updated_at || iso(rows[0]?.updated_at)
  };
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

module.exports = {
  createPostgresStore,
  hashSessionToken
};
