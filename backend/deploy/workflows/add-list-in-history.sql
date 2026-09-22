ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS list_in_history boolean;
UPDATE transcripts SET list_in_history = true WHERE list_in_history IS NULL;
ALTER TABLE transcripts ALTER COLUMN list_in_history SET DEFAULT true;
ALTER TABLE transcripts ALTER COLUMN list_in_history SET NOT NULL;
