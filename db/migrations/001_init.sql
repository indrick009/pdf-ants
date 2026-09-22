CREATE TABLE IF NOT EXISTS items (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'queued',
  total_items INTEGER NOT NULL,
  processed_items INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  failed_chunks INTEGER NOT NULL DEFAULT 0,
  progress NUMERIC(5,1) NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS export_chunks (
  id BIGSERIAL PRIMARY KEY,
  export_id UUID NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  image_errors INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (export_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS export_chunks_export_idx ON export_chunks (export_id, chunk_index);
CREATE INDEX IF NOT EXISTS exports_created_idx ON exports (created_at);
