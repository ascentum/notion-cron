import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import {
  CompletionSource,
  CreateDispatchInput,
  DispatchRecord,
  JobRunRecord,
  Person,
  SnippetType,
} from "./types";

let database: DatabaseSync | null = null;

function getDatabasePath() {
  return process.env.SQLITE_DB_PATH ?? "./data/automation.sqlite";
}

function toDispatchRecord(row: Record<string, unknown>): DispatchRecord {
  return {
    id: Number(row.id),
    discordMessageId: String(row.discord_message_id),
    person: row.person as Person,
    snippetType: row.snippet_type as SnippetType,
    dateLabel: String(row.date_label),
    content: String(row.content),
    status: row.status as DispatchRecord["status"],
    healthScore:
      row.health_score === null || row.health_score === undefined
        ? null
        : Number(row.health_score),
    completionSource:
      row.completion_source === null || row.completion_source === undefined
        ? null
        : (row.completion_source as CompletionSource),
    dueAt: String(row.due_at),
    postedAt:
      row.posted_at === null || row.posted_at === undefined
        ? null
        : String(row.posted_at),
    lastError:
      row.last_error === null || row.last_error === undefined
        ? null
        : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toJobRunRecord(row: Record<string, unknown>): JobRunRecord {
  return {
    id: Number(row.id),
    jobName: String(row.job_name),
    scheduledFor: String(row.scheduled_for),
    status: String(row.status),
    startedAt: String(row.started_at),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : String(row.finished_at),
    error:
      row.error === null || row.error === undefined ? null : String(row.error),
  };
}

function initializeSchema(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS snippet_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_message_id TEXT NOT NULL UNIQUE,
      person TEXT NOT NULL,
      snippet_type TEXT NOT NULL,
      date_label TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      health_score INTEGER,
      completion_source TEXT,
      due_at TEXT NOT NULL,
      posted_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snippet_dispatches_due_pending
      ON snippet_dispatches(status, due_at);

    CREATE INDEX IF NOT EXISTS idx_snippet_dispatches_lookup
      ON snippet_dispatches(snippet_type, date_label, person);

    CREATE TABLE IF NOT EXISTS scheduler_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );
  `);
}

function withImmediateTransaction<T>(fn: () => T): T {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failures
    }
    throw error;
  }
}

export function initializeDatabase() {
  if (database) return database;

  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  initializeSchema(database);
  return database;
}

export function getDatabase() {
  return initializeDatabase();
}

export function closeDatabase() {
  if (!database) return;
  database.close();
  database = null;
}

export function createDispatch(input: CreateDispatchInput): DispatchRecord {
  const db = getDatabase();
  const timestamp = input.createdAt ?? new Date().toISOString();
  const statement = db.prepare(`
    INSERT INTO snippet_dispatches (
      discord_message_id,
      person,
      snippet_type,
      date_label,
      content,
      status,
      due_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `);

  const result = statement.run(
    input.discordMessageId,
    input.person,
    input.snippetType,
    input.dateLabel,
    input.content,
    input.dueAt,
    timestamp,
    timestamp
  );

  return getDispatchById(Number(result.lastInsertRowid))!;
}

export function getDispatchById(id: number): DispatchRecord | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM snippet_dispatches WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? toDispatchRecord(row) : null;
}

export function getDispatchByMessageId(messageId: string): DispatchRecord | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM snippet_dispatches WHERE discord_message_id = ?")
    .get(messageId) as Record<string, unknown> | undefined;
  return row ? toDispatchRecord(row) : null;
}

export function listExistingDispatchPeople(
  dateLabel: string,
  snippetType: SnippetType
): Person[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT DISTINCT person
        FROM snippet_dispatches
        WHERE date_label = ? AND snippet_type = ?
      `
    )
    .all(dateLabel, snippetType) as Array<Record<string, unknown>>;

  return rows.map((row) => row.person as Person);
}

export function listDuePendingDispatches(
  nowIso: string,
  limit = 50
): DispatchRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM snippet_dispatches
        WHERE status = 'pending' AND due_at <= ?
        ORDER BY due_at ASC, id ASC
        LIMIT ?
      `
    )
    .all(nowIso, limit) as Array<Record<string, unknown>>;

  return rows.map(toDispatchRecord);
}

export function claimPendingDispatchByMessageId(
  messageId: string,
  nowIso: string
): DispatchRecord | null {
  return withImmediateTransaction(() => {
    const db = getDatabase();
    const row = db
      .prepare("SELECT * FROM snippet_dispatches WHERE discord_message_id = ?")
      .get(messageId) as Record<string, unknown> | undefined;

    if (!row || row.status !== "pending") return null;

    const update = db.prepare(`
      UPDATE snippet_dispatches
      SET status = 'posting', updated_at = ?, last_error = NULL
      WHERE id = ? AND status = 'pending'
    `);
    const result = update.run(nowIso, Number(row.id));
    if (result.changes !== 1) return null;

    return toDispatchRecord({
      ...row,
      status: "posting",
      updated_at: nowIso,
      last_error: null,
    });
  });
}

export function markDispatchPosted(
  messageId: string,
  options: {
    content: string;
    healthScore: number;
    completionSource: CompletionSource;
    postedAt: string;
    lastError?: string | null;
  }
) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE snippet_dispatches
      SET
        content = ?,
        status = 'posted',
        health_score = ?,
        completion_source = ?,
        posted_at = ?,
        updated_at = ?,
        last_error = ?
      WHERE discord_message_id = ?
    `
  ).run(
    options.content,
    options.healthScore,
    options.completionSource,
    options.postedAt,
    options.postedAt,
    options.lastError ?? null,
    messageId
  );
}

export function markDispatchSkipped(
  messageId: string,
  options: {
    content: string;
    completionSource: CompletionSource;
    skippedAt: string;
  }
) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE snippet_dispatches
      SET
        content = ?,
        status = 'skipped',
        completion_source = ?,
        updated_at = ?,
        last_error = NULL
      WHERE discord_message_id = ?
    `
  ).run(
    options.content,
    options.completionSource,
    options.skippedAt,
    messageId
  );
}

export function markDispatchFailed(
  messageId: string,
  options: {
    content: string;
    error: string;
    failedAt: string;
  }
) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE snippet_dispatches
      SET
        content = ?,
        status = 'failed',
        updated_at = ?,
        last_error = ?
      WHERE discord_message_id = ?
    `
  ).run(options.content, options.failedAt, options.error, messageId);
}

export function requeueFailedDispatch(id: number, nowIso: string): DispatchRecord | null {
  return withImmediateTransaction(() => {
    const db = getDatabase();
    const row = db
      .prepare("SELECT * FROM snippet_dispatches WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;

    if (!row || row.status !== "failed") return null;

    const result = db
      .prepare(
        `
          UPDATE snippet_dispatches
          SET status = 'pending', due_at = ?, updated_at = ?, last_error = NULL
          WHERE id = ? AND status = 'failed'
        `
      )
      .run(nowIso, nowIso, id);

    if (result.changes !== 1) return null;

    return toDispatchRecord({
      ...row,
      status: "pending",
      due_at: nowIso,
      updated_at: nowIso,
      last_error: null,
    });
  });
}

export function getSchedulerState(key: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT value FROM scheduler_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSchedulerState(key: string, value: string, updatedAt: string) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO scheduler_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `
  ).run(key, value, updatedAt);
}

export function createJobRun(jobName: string, scheduledFor: string, startedAt: string) {
  const db = getDatabase();
  const result = db
    .prepare(
      `
        INSERT INTO job_runs (job_name, scheduled_for, status, started_at)
        VALUES (?, ?, 'running', ?)
      `
    )
    .run(jobName, scheduledFor, startedAt);

  return Number(result.lastInsertRowid);
}

export function finishJobRun(
  id: number,
  status: "success" | "failed",
  finishedAt: string,
  error: string | null = null
) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE job_runs
      SET status = ?, finished_at = ?, error = ?
      WHERE id = ?
    `
  ).run(status, finishedAt, error, id);
}

export function listJobRuns(limit = 20): JobRunRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM job_runs
        ORDER BY id DESC
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map(toJobRunRecord);
}
