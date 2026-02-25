import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    peer_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    from_peer TEXT NOT NULL,
    to_peer TEXT NOT NULL,
    amount REAL NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    relay_peer TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    signature TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS emissions (
    id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    amount REAL NOT NULL,
    work_type TEXT NOT NULL,
    work_proof TEXT NOT NULL DEFAULT '',
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    monthly_cap REAL NOT NULL,
    used_usd REAL NOT NULL DEFAULT 0,
    tasks_completed INTEGER NOT NULL DEFAULT 0,
    lux_earned REAL NOT NULL DEFAULT 0,
    registered_at INTEGER NOT NULL,
    last_used_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS network_stats (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Governance tables
  CREATE TABLE IF NOT EXISTS governance_proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    proposed_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    voting_ends_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS governance_comments (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    from_peer TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS governance_votes (
    proposal_id TEXT NOT NULL,
    voter TEXT NOT NULL,
    choice TEXT NOT NULL,
    reasoning TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, voter)
  );

  CREATE TABLE IF NOT EXISTS governance_decisions (
    proposal_id TEXT PRIMARY KEY,
    outcome TEXT NOT NULL,
    votes_for INTEGER NOT NULL DEFAULT 0,
    votes_against INTEGER NOT NULL DEFAULT 0,
    votes_abstain INTEGER NOT NULL DEFAULT 0,
    decided_at INTEGER NOT NULL
  );

  -- Agent transparency: activity log
  CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    agent_role TEXT NOT NULL,
    agent_tier INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    action TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    summary TEXT NOT NULL,
    details TEXT,
    proposal_id TEXT,
    task_id TEXT,
    transaction_id TEXT,
    signature TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- Agent scoring: track build pass rate and performance per agent
  CREATE TABLE IF NOT EXISTS agent_scores (
    peer_id TEXT PRIMARY KEY,
    total_commits INTEGER NOT NULL DEFAULT 0,
    successful_builds INTEGER NOT NULL DEFAULT 0,
    failed_builds INTEGER NOT NULL DEFAULT 0,
    reverts_triggered INTEGER NOT NULL DEFAULT 0,
    proposals_created INTEGER NOT NULL DEFAULT 0,
    proposals_accepted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  -- Phase 64: Ledger checkpoints for light-mode sync
  -- New nodes can bootstrap from a checkpoint instead of replaying all history.
  -- Pruning logic (removing old transactions) is FUTURE — this just stores the snapshots.
  CREATE TABLE IF NOT EXISTS ledger_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    block_height INTEGER NOT NULL,
    accounts_snapshot TEXT NOT NULL,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    total_supply REAL NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_peer);
  CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_peer);
  CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_emissions_peer ON emissions(peer_id);
  CREATE INDEX IF NOT EXISTS idx_api_contributions_peer ON api_contributions(peer_id);
  CREATE INDEX IF NOT EXISTS idx_governance_comments_proposal ON governance_comments(proposal_id);
  CREATE INDEX IF NOT EXISTS idx_governance_proposals_status ON governance_proposals(status);
  CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp);
  CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent_id);
  CREATE INDEX IF NOT EXISTS idx_activity_action ON activity(action);
`;

export function openDatabase(dataDir?: string): Database.Database {
  const dir = dataDir || join(homedir(), '.pando');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const dbPath = join(dir, 'ledger.db');
  const db = new Database(dbPath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Create schema
  db.exec(SCHEMA);

  // Migration: add relay_peer column if missing (existing databases)
  const cols = db.pragma('table_info(transactions)') as any[];
  if (!cols.some((c: any) => c.name === 'relay_peer')) {
    db.exec("ALTER TABLE transactions ADD COLUMN relay_peer TEXT NOT NULL DEFAULT ''");
  }

  // Migration: add auth columns to accounts table (Phase 56 — P2P user accounts)
  const accountCols = db.pragma('table_info(accounts)') as any[];
  if (!accountCols.some((c: any) => c.name === 'username')) {
    db.exec("ALTER TABLE accounts ADD COLUMN username TEXT COLLATE NOCASE");
    db.exec("ALTER TABLE accounts ADD COLUMN display_name TEXT");
    db.exec("ALTER TABLE accounts ADD COLUMN password_hash TEXT");
    db.exec("ALTER TABLE accounts ADD COLUMN is_claimed INTEGER DEFAULT 0");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username) WHERE username IS NOT NULL");
  }

  // Initialize network stats if needed
  const initStats = db.prepare(
    'INSERT OR IGNORE INTO network_stats (key, value, updated_at) VALUES (?, ?, ?)'
  );
  const now = Date.now();
  initStats.run('total_supply', '0', now);
  initStats.run('total_accounts', '0', now);
  initStats.run('total_transactions', '0', now);
  initStats.run('total_relay_fees', '0', now);

  return db;
}
