CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    owner_github_login TEXT NOT NULL,
    harness_session_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    harness_name TEXT NOT NULL,
    harness_version TEXT NOT NULL,
    transcript_container_name TEXT NOT NULL,
    transcript_blob_key TEXT NOT NULL,
    resumable_bundle_container_name TEXT,
    resumable_bundle_blob_key TEXT,
    known_bad_list_version_checked TEXT NOT NULL,
    content_blocked_at TIMESTAMPTZ,
    content_blocked_list_version TEXT,
    superseded_at TIMESTAMPTZ,
    CONSTRAINT title_length CHECK (char_length(title) BETWEEN 1 AND 120),
    CONSTRAINT summary_length CHECK (char_length(summary) BETWEEN 1 AND 500),
    CONSTRAINT harness_session_id_shape CHECK (
        char_length(harness_session_id) BETWEEN 1 AND 128
        AND harness_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    ),
    CONSTRAINT resumable_bundle_pointer_pairing CHECK (
        (resumable_bundle_container_name IS NULL) = (resumable_bundle_blob_key IS NULL)
    ),
    CONSTRAINT content_blocked_pairing CHECK (
        (content_blocked_at IS NULL) = (content_blocked_list_version IS NULL)
    )
);

CREATE UNIQUE INDEX idx_sessions_current_harness
    ON sessions(owner_github_login, harness_session_id)
    WHERE superseded_at IS NULL;

CREATE TABLE session_artifact_pointers (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    container_name TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    UNIQUE (session_id, container_name, blob_key)
);

CREATE INDEX idx_session_artifact_pointers_session_id
    ON session_artifact_pointers(session_id);

CREATE TABLE share_links (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    access_mode TEXT NOT NULL CHECK (
        access_mode IN ('anonymous', 'authenticated')
    ),
    audience_policy JSONB NOT NULL,
    resolved_rules JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT anonymous_links_have_no_resolved_rules CHECK (
        (access_mode = 'anonymous') = (resolved_rules IS NULL)
    )
);

CREATE INDEX idx_share_links_session_id ON share_links(session_id);
CREATE INDEX idx_share_links_active
    ON share_links(session_id)
    WHERE revoked_at IS NULL;

CREATE TABLE publish_idempotency (
    owner_github_login TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_github_login, idempotency_key)
);
