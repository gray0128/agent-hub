PRAGMA foreign_keys = ON;

ALTER TABLE runs ADD COLUMN labels_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN result_schema_json TEXT;
ALTER TABLE runs ADD COLUMN result_json TEXT;
