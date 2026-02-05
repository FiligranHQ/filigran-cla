import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { CLARecord, CLAStatus, PRRecord } from '../types';
import { logger } from '../utils/logger';

let db: Database.Database;

export function initDatabase(): void {
  // Ensure data directory exists
  const dataDir = path.dirname(config.database.path);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(config.database.path);
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS cla_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_username TEXT NOT NULL,
      github_user_id INTEGER NOT NULL,
      github_email TEXT,
      concord_agreement_uid TEXT NOT NULL,
      signed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(github_user_id)
    );

    CREATE TABLE IF NOT EXISTS pr_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      github_username TEXT NOT NULL,
      github_user_id INTEGER NOT NULL,
      comment_id INTEGER,
      concord_agreement_uid TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_full_name, pr_number, github_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cla_github_user_id ON cla_records(github_user_id);
    CREATE INDEX IF NOT EXISTS idx_cla_github_username ON cla_records(github_username);
    CREATE INDEX IF NOT EXISTS idx_cla_agreement_uid ON cla_records(concord_agreement_uid);
    CREATE INDEX IF NOT EXISTS idx_pr_agreement_uid ON pr_records(concord_agreement_uid);
  `);

  logger.info('Database initialized', { path: config.database.path });
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// CLA Record Operations
export function findCLAByGitHubUserId(githubUserId: number): CLARecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM cla_records WHERE github_user_id = ?
  `);
  return stmt.get(githubUserId) as CLARecord | undefined;
}

export function findCLAByGitHubUsername(username: string): CLARecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM cla_records WHERE github_username = ? COLLATE NOCASE
  `);
  return stmt.get(username) as CLARecord | undefined;
}

export function findCLAByAgreementUid(agreementUid: string): CLARecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM cla_records WHERE concord_agreement_uid = ?
  `);
  return stmt.get(agreementUid) as CLARecord | undefined;
}

export function createCLARecord(record: Omit<CLARecord, 'id' | 'created_at' | 'updated_at'>): CLARecord {
  const stmt = db.prepare(`
    INSERT INTO cla_records (github_username, github_user_id, github_email, concord_agreement_uid, status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(github_user_id) DO UPDATE SET
      concord_agreement_uid = excluded.concord_agreement_uid,
      status = excluded.status,
      updated_at = datetime('now')
  `);
  
  stmt.run(
    record.github_username,
    record.github_user_id,
    record.github_email || null,
    record.concord_agreement_uid,
    record.status
  );

  return findCLAByGitHubUserId(record.github_user_id)!;
}

export function updateCLAStatus(githubUserId: number, status: CLAStatus, signedAt?: string): void {
  const stmt = db.prepare(`
    UPDATE cla_records
    SET status = ?, signed_at = ?, updated_at = datetime('now')
    WHERE github_user_id = ?
  `);
  stmt.run(status, signedAt || null, githubUserId);
}

export function updateCLAStatusByAgreementUid(agreementUid: string, status: CLAStatus, signedAt?: string): void {
  const stmt = db.prepare(`
    UPDATE cla_records
    SET status = ?, signed_at = ?, updated_at = datetime('now')
    WHERE concord_agreement_uid = ?
  `);
  stmt.run(status, signedAt || null, agreementUid);
}

// PR Record Operations
export function findPRRecord(repoFullName: string, prNumber: number, githubUserId: number): PRRecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM pr_records
    WHERE repo_full_name = ? AND pr_number = ? AND github_user_id = ?
  `);
  return stmt.get(repoFullName, prNumber, githubUserId) as PRRecord | undefined;
}

export function findPRRecordsByAgreementUid(agreementUid: string): PRRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM pr_records WHERE concord_agreement_uid = ?
  `);
  return stmt.all(agreementUid) as PRRecord[];
}

export function findPRRecordsByGitHubUserId(githubUserId: number): PRRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM pr_records WHERE github_user_id = ?
  `);
  return stmt.all(githubUserId) as PRRecord[];
}

export function createPRRecord(record: Omit<PRRecord, 'id' | 'created_at' | 'updated_at'>): PRRecord {
  const stmt = db.prepare(`
    INSERT INTO pr_records (repo_full_name, pr_number, github_username, github_user_id, comment_id, concord_agreement_uid)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_full_name, pr_number, github_user_id) DO UPDATE SET
      comment_id = COALESCE(excluded.comment_id, pr_records.comment_id),
      concord_agreement_uid = COALESCE(excluded.concord_agreement_uid, pr_records.concord_agreement_uid),
      updated_at = datetime('now')
  `);
  
  stmt.run(
    record.repo_full_name,
    record.pr_number,
    record.github_username,
    record.github_user_id,
    record.comment_id || null,
    record.concord_agreement_uid || null
  );

  return findPRRecord(record.repo_full_name, record.pr_number, record.github_user_id)!;
}

export function updatePRRecordCommentId(repoFullName: string, prNumber: number, githubUserId: number, commentId: number): void {
  const stmt = db.prepare(`
    UPDATE pr_records
    SET comment_id = ?, updated_at = datetime('now')
    WHERE repo_full_name = ? AND pr_number = ? AND github_user_id = ?
  `);
  stmt.run(commentId, repoFullName, prNumber, githubUserId);
}

export function updatePRRecordAgreementUid(repoFullName: string, prNumber: number, githubUserId: number, agreementUid: string): void {
  const stmt = db.prepare(`
    UPDATE pr_records
    SET concord_agreement_uid = ?, updated_at = datetime('now')
    WHERE repo_full_name = ? AND pr_number = ? AND github_user_id = ?
  `);
  stmt.run(agreementUid, repoFullName, prNumber, githubUserId);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    logger.info('Database connection closed');
  }
}
