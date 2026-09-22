-- Reshape `items` into school report-card records (one student = one page).
-- Idempotent: runs on every boot.

ALTER TABLE items DROP COLUMN IF EXISTS title;
ALTER TABLE items DROP COLUMN IF EXISTS description;

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'items' AND column_name = 'image_url'
  ) THEN
    ALTER TABLE items RENAME COLUMN image_url TO photo_url;
  END IF;
END $$;

ALTER TABLE items ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS class_name TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS matricule TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS student_number INTEGER;
ALTER TABLE items ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS subjects JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Drop rows created by the old (title/description) seed: they have no student data.
DELETE FROM items WHERE last_name IS NULL;