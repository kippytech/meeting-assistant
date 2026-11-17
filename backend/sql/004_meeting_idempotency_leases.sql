ALTER TABLE meeting_idempotency
    ADD COLUMN IF NOT EXISTS claim_token UUID,
    ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

ALTER TABLE meeting_idempotency
    DROP CONSTRAINT IF EXISTS meeting_idempotency_status_check;

ALTER TABLE meeting_idempotency
    ADD CONSTRAINT meeting_idempotency_status_check
    CHECK (status IN ('pending', 'processing', 'complete'));

-- Pending rows from the first idempotency migration remain immediately claimable.
UPDATE meeting_idempotency
SET status = 'processing', lease_until = NOW() - INTERVAL '1 second'
WHERE status = 'pending';
