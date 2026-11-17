ALTER TABLE meeting_idempotency
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE meeting_idempotency
    DROP CONSTRAINT IF EXISTS meeting_idempotency_status_check;

ALTER TABLE meeting_idempotency
    ADD CONSTRAINT meeting_idempotency_status_check
    CHECK (status IN ('pending', 'processing', 'complete', 'failed'));
