import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { portalSettings } from "./portalSettings.js";
import { uiCopy } from "./uiCopy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const databasePath = process.env.DATABASE_PATH || join(root, "data", "civicalert.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
export const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('resident', 'admin')),
    utility TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(email, role, utility)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS advisories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    utility TEXT NOT NULL,
    type TEXT NOT NULL,
    area TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Monitoring',
    details TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'Normal',
    service_starts_at TEXT,
    estimated_restoration_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    utility TEXT NOT NULL,
    area TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Scheduled',
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    utility TEXT NOT NULL,
    area TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Received',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS network_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utility TEXT NOT NULL,
    district TEXT NOT NULL,
    area TEXT NOT NULL,
    pressure_psi REAL NOT NULL,
    reservoir_percent REAL NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ui_copy (
    content_key TEXT PRIMARY KEY,
    content_value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portal_settings (
    portal TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gmail_connections (
    utility TEXT PRIMARY KEY CHECK (utility IN ('CEPALCO', 'Water District')),
    sender_email TEXT NOT NULL,
    encrypted_refresh_token TEXT NOT NULL,
    connected_by INTEGER NOT NULL REFERENCES users(id),
    connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS gmail_oauth_states (
    state_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    utility TEXT NOT NULL CHECK (utility IN ('CEPALCO', 'Water District')),
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS social_posts (
    advisory_id INTEGER NOT NULL REFERENCES advisories(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),
    post_id TEXT NOT NULL,
    permalink_url TEXT,
    published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (advisory_id, platform)
  );
  CREATE TABLE IF NOT EXISTS email_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    advisory_id INTEGER NOT NULL REFERENCES advisories(id) ON DELETE CASCADE,
    resident_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    error_message TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(advisory_id, resident_id)
  );
  CREATE TABLE IF NOT EXISTS schema_migrations (
    migration TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sms_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    advisory_id INTEGER NOT NULL REFERENCES advisories(id) ON DELETE CASCADE,
    resident_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(advisory_id, resident_id)
  );
`);

database.exec("BEGIN IMMEDIATE");

try {
  const userColumns = new Set(
    (
      database.prepare("PRAGMA table_info(users)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name)
  );

  for (const [name, definition] of [
    ["phone_number", "TEXT"],
    ["address", "TEXT"],
    ["barangay", "TEXT"],
    ["district", "TEXT"],
    ["city", "TEXT"],
    ["postal_code", "TEXT"],
    ["profile_image", "TEXT"],
    ["sms_alerts", "INTEGER NOT NULL DEFAULT 1"],
    ["notify_maintenance", "INTEGER NOT NULL DEFAULT 1"],
    ["notify_email_digest", "INTEGER NOT NULL DEFAULT 1"],
    ["immediate_email_alerts", "INTEGER NOT NULL DEFAULT 0"],
    ["terms_accepted_at", "TEXT"],
  ] as const) {
    if (!userColumns.has(name)) {
      database.exec(
        `ALTER TABLE users ADD COLUMN ${name} ${definition}`
      );
    }
  }

  // Add image storage to existing advisories without deleting existing data.
  const advisoryColumns = new Set(
    (
      database.prepare("PRAGMA table_info(advisories)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name)
  );

  if (!advisoryColumns.has("image_data_url")) {
    database.exec(
      "ALTER TABLE advisories ADD COLUMN image_data_url TEXT"
    );
  }

  // ADDED: Store the selected map location for each advisory.
if (!advisoryColumns.has("latitude")) {
  database.exec(
    "ALTER TABLE advisories ADD COLUMN latitude REAL"
  );
}

if (!advisoryColumns.has("longitude")) {
  database.exec(
    "ALTER TABLE advisories ADD COLUMN longitude REAL"
  );
}

for (const [name, definition] of [
  ["scheduled_at", "TEXT"],
  ["publication_status", "TEXT NOT NULL DEFAULT 'published'"],
  ["channels_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["priority", "TEXT NOT NULL DEFAULT 'Normal'"],
  ["service_starts_at", "TEXT"],
  ["estimated_restoration_at", "TEXT"],
] as const) {
  if (!advisoryColumns.has(name)) {
    database.exec(`ALTER TABLE advisories ADD COLUMN ${name} ${definition}`);
  }
}

const oldAdvisoriesMigration = "clear-old-utility-advisories";
const migrationApplied = database.prepare("SELECT 1 FROM schema_migrations WHERE migration = ?")
  .get(oldAdvisoriesMigration);
if (!migrationApplied) {
  database.prepare("DELETE FROM advisories WHERE utility IN ('CEPALCO', 'Water District')").run();
  database.prepare("INSERT INTO schema_migrations (migration) VALUES (?)").run(oldAdvisoriesMigration);
}

  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
}

export type Actor = {
  id: number;
  name: string;
  email: string;
  role: "resident" | "admin";
  utility: string | null;
  phone_number?: string | null;
  address?: string | null;
  barangay?: string | null;
  district?: string | null;
  city?: string | null;
  postal_code?: string | null;
  profile_image?: string | null;
  sms_alerts?: number;
  notify_maintenance?: number;
  notify_email_digest?: number;
  immediate_email_alerts?: number;
  terms_accepted_at?: string | null;
};

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function issueSession(userId: number): string {
  const token = randomBytes(32).toString("base64url");
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, Date.now() + 1000 * 60 * 60 * 24 * 7);
  return token;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function findActorForToken(token: string): Actor | undefined {
  return database.prepare(`
    SELECT users.id, users.name, users.email, users.role, users.utility,
      users.phone_number, users.address, users.barangay, users.district, users.city,
      users.postal_code, users.profile_image, users.sms_alerts, users.notify_maintenance,
      users.notify_email_digest, users.immediate_email_alerts, users.terms_accepted_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at >= ?
  `).get(hashToken(token), Date.now()) as Actor | undefined;
}

export function seedDemoAccounts(): void {
  const seedCopy = database.prepare("INSERT OR REPLACE INTO ui_copy (content_key, content_value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(uiCopy)) {
    seedCopy.run(key, value);
  }
  const seedSettings = database.prepare("INSERT OR REPLACE INTO portal_settings (portal, settings_json) VALUES (?, ?)");
  for (const [portal, settings] of Object.entries(portalSettings)) {
    seedSettings.run(portal, JSON.stringify(settings));
  }
  if (process.env.NODE_ENV === "production") return;
  database.exec("BEGIN IMMEDIATE");
  try {
    const seed = database.prepare("INSERT OR IGNORE INTO users (name, email, password_hash, role, utility) VALUES (?, ?, ?, 'admin', ?)");
    for (const [utility, email, name] of [
      ["CEPALCO", "admin@cepalco.local", "CEPALCO Demo Admin"],
      ["Water District", "admin@waterdistrict.local", "Water District Demo Admin"],
    ]) {
      seed.run(name, email, hashPassword("DemoPass123!"), utility);
    }

    const works = database.prepare("SELECT COUNT(*) AS count FROM work_orders").get() as { count: number };
    if (works.count === 0) {
      const insert = database.prepare("INSERT INTO work_orders (reference, title, utility, area, description, status, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      insert.run("WD-2026-021", "Mainline valve replacement", "Water District", "Balulang · District 3", "Planned valve maintenance.", "Scheduled", "2026-10-20T08:00", "2026-10-20T12:00");
      insert.run("WD-2026-022", "District 2 pressure inspection", "Water District", "Macasandig · District 2", "Pressure zone inspection.", "Scheduled", "2026-10-22T09:00", "2026-10-22T11:00");
      insert.run("CE-2026-021", "Feeder 7 line maintenance", "CEPALCO", "Carmen · Zone 4", "Line maintenance.", "Scheduled", "2026-10-20T14:00", "2026-10-20T17:00");
    }
    const cepalcoWorkCount = database.prepare("SELECT COUNT(*) AS count FROM work_orders WHERE utility = 'CEPALCO'").get() as { count: number };
    if (cepalcoWorkCount.count < 2) {
      database.prepare("INSERT OR IGNORE INTO work_orders (reference, title, utility, area, description, status, starts_at, ends_at) VALUES (?, ?, 'CEPALCO', ?, ?, 'Scheduled', ?, ?)")
        .run("CE-2026-024", "Substation capacitor replacement", "Puntod · Substation B", "Replace capacitor bank equipment and inspect the local busbar.", "2026-10-22T08:00", "2026-10-22T13:00");
    }
    if (cepalcoWorkCount.count < 3) {
      database.prepare("INSERT OR IGNORE INTO work_orders (reference, title, utility, area, description, status, starts_at, ends_at) VALUES (?, ?, 'CEPALCO', ?, ?, 'Scheduled', ?, ?)")
        .run("CE-2026-027", "High voltage insulator cleaning", "Macasandig · Sector 2", "Routine line-insulator cleaning and hardware inspection.", "2026-10-24T05:00", "2026-10-24T08:00");
    }

    const readings = database.prepare("SELECT COUNT(*) AS count FROM network_readings").get() as { count: number };
    if (readings.count === 0) {
      const insert = database.prepare("INSERT INTO network_readings (utility, district, area, pressure_psi, reservoir_percent) VALUES ('Water District', ?, ?, ?, ?)");
      insert.run("District 1", "Nazareth · Carmen", 48, 86);
      insert.run("District 2", "Macasandig · downtown", 31, 86);
      insert.run("District 3", "Balulang · Kauswagan", 44, 86);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function insert(sql: string, ...params: SQLInputValue[]): number {
  return Number(database.prepare(sql).run(...params).lastInsertRowid);
}
