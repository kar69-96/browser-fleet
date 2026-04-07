-- =============================================================================
-- Supabase Schema for EC2 Instance Management
-- =============================================================================
-- This schema supports the Lambda-based auto-scaling infrastructure.
-- Tables store instance state, auth requests, and event logs.
-- RPC functions provide atomic state transitions to prevent race conditions.

-- =============================================================================
-- Tables
-- =============================================================================

-- Tracks EC2 instances in the auto-scaling pool
CREATE TABLE streaming_instances (
  id            BIGSERIAL PRIMARY KEY,
  instance_id   TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'starting'
                CHECK (status IN ('starting', 'warm', 'active', 'hibernating', 'stopped', 'terminating')),
  tunnel_url    TEXT,
  current_sessions  INTEGER NOT NULL DEFAULT 0,
  max_sessions      INTEGER NOT NULL DEFAULT 3,
  health_check_failures INTEGER NOT NULL DEFAULT 0,
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_instances_status ON streaming_instances(status);
CREATE INDEX idx_instances_activity ON streaming_instances(last_activity_at);

-- Tracks authentication requests and their assignment to instances
CREATE TABLE auth_requests (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  context         TEXT NOT NULL DEFAULT 'login',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'assigned', 'in_progress', 'completed', 'failed', 'timeout')),
  assigned_instance TEXT REFERENCES streaming_instances(instance_id) ON DELETE SET NULL,
  position        INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_requests_status ON auth_requests(status);
CREATE INDEX idx_requests_instance ON auth_requests(assigned_instance);

-- Event log for auditing and debugging
CREATE TABLE instance_events (
  id          BIGSERIAL PRIMARY KEY,
  instance_id TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_instance ON instance_events(instance_id);
CREATE INDEX idx_events_type ON instance_events(event_type);
CREATE INDEX idx_events_created ON instance_events(created_at);

-- Extraction queue (for the extraction-manager Lambda)
CREATE TABLE pending_extractions (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE completed_extractions (
  id                      BIGSERIAL PRIMARY KEY,
  email                   TEXT NOT NULL,
  extraction_completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE extraction_events (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  data        JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- RPC Functions (Atomic State Transitions)
-- =============================================================================

-- Find an available instance with capacity
CREATE OR REPLACE FUNCTION find_available_instance()
RETURNS streaming_instances AS $$
  SELECT *
  FROM streaming_instances
  WHERE status IN ('warm', 'active')
    AND current_sessions < max_sessions
  ORDER BY current_sessions ASC, last_activity_at DESC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
$$ LANGUAGE sql;

-- Atomically assign a request to an instance
CREATE OR REPLACE FUNCTION assign_request_to_instance(
  p_request_id BIGINT,
  p_instance_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_updated BOOLEAN;
BEGIN
  -- Update the request
  UPDATE auth_requests
  SET status = 'assigned',
      assigned_instance = p_instance_id,
      updated_at = NOW()
  WHERE id = p_request_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Increment instance session count
  UPDATE streaming_instances
  SET current_sessions = current_sessions + 1,
      status = CASE
        WHEN current_sessions + 1 >= max_sessions THEN 'active'
        ELSE status
      END,
      last_activity_at = NOW(),
      updated_at = NOW()
  WHERE instance_id = p_instance_id
    AND current_sessions < max_sessions;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Release a session and update instance
CREATE OR REPLACE FUNCTION release_instance_session(
  p_request_id BIGINT,
  p_new_status TEXT DEFAULT 'completed'
) RETURNS BOOLEAN AS $$
DECLARE
  v_instance_id TEXT;
BEGIN
  -- Get the instance this request was assigned to
  SELECT assigned_instance INTO v_instance_id
  FROM auth_requests
  WHERE id = p_request_id;

  IF v_instance_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Update the request
  UPDATE auth_requests
  SET status = p_new_status, updated_at = NOW()
  WHERE id = p_request_id;

  -- Decrement instance session count
  UPDATE streaming_instances
  SET current_sessions = GREATEST(0, current_sessions - 1),
      status = CASE
        WHEN current_sessions - 1 <= 0 THEN 'warm'
        ELSE 'active'
      END,
      last_activity_at = NOW(),
      updated_at = NOW()
  WHERE instance_id = v_instance_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Get queue position for a request
CREATE OR REPLACE FUNCTION get_queue_position(p_request_id BIGINT)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER
  FROM auth_requests
  WHERE status = 'pending'
    AND created_at <= (SELECT created_at FROM auth_requests WHERE id = p_request_id);
$$ LANGUAGE sql;

-- Get aggregate scaling metrics
CREATE OR REPLACE FUNCTION get_scaling_metrics()
RETURNS TABLE(
  active_instances INTEGER,
  warm_instances INTEGER,
  hibernated_instances INTEGER,
  pending_requests INTEGER,
  total_sessions INTEGER,
  total_capacity INTEGER
) AS $$
  SELECT
    (SELECT COUNT(*)::INTEGER FROM streaming_instances WHERE status = 'active'),
    (SELECT COUNT(*)::INTEGER FROM streaming_instances WHERE status = 'warm'),
    (SELECT COUNT(*)::INTEGER FROM streaming_instances WHERE status IN ('stopped', 'hibernating')),
    (SELECT COUNT(*)::INTEGER FROM auth_requests WHERE status = 'pending'),
    (SELECT COALESCE(SUM(current_sessions), 0)::INTEGER FROM streaming_instances WHERE status IN ('warm', 'active')),
    (SELECT COALESCE(SUM(max_sessions), 0)::INTEGER FROM streaming_instances WHERE status IN ('warm', 'active'));
$$ LANGUAGE sql;
