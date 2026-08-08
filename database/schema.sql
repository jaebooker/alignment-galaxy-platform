CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('contributor', 'customer', 'reviewer', 'admin')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_role TEXT NOT NULL CHECK (active_role IN ('contributor', 'customer', 'reviewer', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);

CREATE TABLE IF NOT EXISTS contributor_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  skills TEXT[] NOT NULL DEFAULT '{}',
  verification_tier INTEGER NOT NULL DEFAULT 0,
  reputation_score NUMERIC(5, 2) NOT NULL DEFAULT 0,
  approval_rate NUMERIC(5, 4) NOT NULL DEFAULT 0,
  completed_tasks INTEGER NOT NULL DEFAULT 0,
  payout_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (payout_status IN ('not_started', 'needs_id_verification', 'stripe_ready', 'paused')),
  stripe_connect_account_id TEXT
);

CREATE TABLE IF NOT EXISTS customer_orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('frontier_lab', 'enterprise', 'evaluation_org', 'governance_org', 'public_good_sponsor')),
  vetting_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (vetting_status IN ('pending', 'approved', 'rejected', 'paused')),
  billing_status TEXT NOT NULL DEFAULT 'manual_invoice',
  contact_user_id UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  task_type TEXT NOT NULL
    CHECK (task_type IN ('red_team', 'eval_generation', 'behavior_catalog', 'deployment_monitoring', 'research_task')),
  reward_cents INTEGER NOT NULL CHECK (reward_cents >= 0),
  required_skill_tier INTEGER NOT NULL DEFAULT 1,
  redundancy_count INTEGER NOT NULL DEFAULT 1 CHECK (redundancy_count > 0),
  deadline DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'open', 'claimed', 'in_review', 'completed', 'paid', 'cancelled')),
  sponsoring_org_id UUID REFERENCES customer_orgs(id),
  commerciality TEXT NOT NULL CHECK (commerciality IN ('commercial', 'public_good')),
  skill_tags TEXT[] NOT NULL DEFAULT '{}',
  acceptance_criteria TEXT[] NOT NULL DEFAULT '{}',
  deliverable_format TEXT,
  risk_level TEXT NOT NULL DEFAULT 'standard' CHECK (risk_level IN ('standard', 'sensitive', 'restricted')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_claims (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  contributor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, contributor_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  contributor_id UUID NOT NULL REFERENCES users(id),
  artifact TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'needs_changes', 'paid')),
  review_outcome TEXT CHECK (review_outcome IN ('approved', 'rejected', 'needs_changes')),
  score INTEGER CHECK (score BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'needs_changes')),
  notes TEXT NOT NULL,
  reviewer_confidence INTEGER NOT NULL DEFAULT 3 CHECK (reviewer_confidence BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  contributor_id UUID NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  platform_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'transferred', 'failed', 'held')),
  stripe_transfer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_standards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  standard TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS screening_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  required_for_tier INTEGER NOT NULL DEFAULT 1 CHECK (required_for_tier > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_packets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'assembling'
    CHECK (status IN ('assembling', 'ready', 'delivered')),
  approved_submission_ids UUID[] NOT NULL DEFAULT '{}',
  approved_count INTEGER NOT NULL DEFAULT 0,
  required_count INTEGER NOT NULL DEFAULT 1,
  average_score NUMERIC(4, 2),
  average_reviewer_confidence NUMERIC(4, 2),
  customer_summary TEXT NOT NULL,
  review_summary TEXT NOT NULL,
  risk_notes TEXT NOT NULL,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_commerciality ON tasks(commerciality);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_delivery_packets_status ON delivery_packets(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_events_created ON activity_events(created_at);
