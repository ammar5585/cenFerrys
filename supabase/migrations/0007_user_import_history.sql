-- =====================================================================
-- CSV bulk user import: history/audit table. The working import data
-- itself is never staged in the database (upload -> parse/validate ->
-- preview -> confirm all happen in one request/response round trip,
-- with the raw CSV text carried through the preview page's hidden
-- form field) - only the *result* of a completed import is recorded
-- here, mirroring activity_logs' shape.
-- =====================================================================

CREATE TABLE user_import_history (
    import_id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    imported_by   INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    imported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    filename      TEXT,
    total_count   INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    failed_rows   JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX idx_user_import_history_imported_at ON user_import_history(imported_at DESC);
