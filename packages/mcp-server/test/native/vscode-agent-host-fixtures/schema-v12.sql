-- Source: microsoft/vscode cbea5b4b6a964508352be917d3ddbdc6fc6e7a75
-- src/vs/platform/agentHost/node/sessionDatabase.ts, migrations 1–12.
-- Copyright (c) Microsoft Corporation. MIT License.
-- https://github.com/microsoft/vscode/blob/cbea5b4b6a964508352be917d3ddbdc6fc6e7a75/License.txt
-- Real migrations, including the v3 table replacement and the v12 data migration.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE IF NOT EXISTS file_edits (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  before_content BLOB NOT NULL,
  after_content BLOB NOT NULL,
  added_lines INTEGER,
  removed_lines INTEGER,
  PRIMARY KEY (tool_call_id, file_path)
);
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
PRAGMA user_version = 2;
CREATE TABLE file_edits_v3 (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  edit_type TEXT NOT NULL DEFAULT 'edit',
  original_path TEXT,
  before_content BLOB,
  after_content BLOB,
  added_lines INTEGER,
  removed_lines INTEGER,
  PRIMARY KEY (tool_call_id, file_path)
);
INSERT INTO file_edits_v3 (turn_id, tool_call_id, file_path, edit_type, before_content, after_content, added_lines, removed_lines)
  SELECT turn_id, tool_call_id, file_path, 'edit', before_content, after_content, added_lines, removed_lines FROM file_edits;
DROP TABLE file_edits;
ALTER TABLE file_edits_v3 RENAME TO file_edits;
PRAGMA user_version = 3;
ALTER TABLE turns ADD COLUMN event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_turns_event_id ON turns(event_id);
PRAGMA user_version = 4;
ALTER TABLE turns ADD COLUMN checkpoint_ref TEXT;
PRAGMA user_version = 5;
CREATE TABLE IF NOT EXISTS chat_drafts (chat_uri TEXT PRIMARY KEY NOT NULL, draft TEXT NOT NULL);
PRAGMA user_version = 6;
CREATE TABLE IF NOT EXISTS reviewed_files (uri TEXT NOT NULL, nonce TEXT NOT NULL, PRIMARY KEY (uri, nonce));
PRAGMA user_version = 7;
CREATE TABLE IF NOT EXISTS local_turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  chat_uri TEXT NOT NULL,
  anchor_turn_id TEXT,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL
);
PRAGMA user_version = 8;
CREATE TABLE IF NOT EXISTS turn_usage (
  turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  usage TEXT NOT NULL
);
PRAGMA user_version = 9;
CREATE TABLE IF NOT EXISTS turn_delegation (
  turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  delegation TEXT NOT NULL
);
PRAGMA user_version = 10;
CREATE TABLE IF NOT EXISTS turn_workspace_transition (
  turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  transition TEXT NOT NULL
);
PRAGMA user_version = 11;
INSERT OR REPLACE INTO session_metadata (key, value)
  SELECT 'agentHost.hasWorkspaceTransitions', 'true'
  WHERE EXISTS (SELECT 1 FROM turn_workspace_transition);
PRAGMA user_version = 12;
