import "../src/env.js";
import { createClient } from "@supabase/supabase-js";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the legacy data import.`);
  return value;
}

const databasePath = resolve(process.env.DATABASE_PATH || "backend/data/civicalert.sqlite");
const local = new DatabaseSync(databasePath, { readOnly: true });
const supabase = createClient(
  requiredEnvironment("SUPABASE_URL"),
  requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type Row = Record<string, unknown>;

function rows(sql: string): Row[] {
  return local.prepare(sql).all() as Row[];
}

async function upsert(table: string, data: Row[], onConflict = "id"): Promise<void> {
  for (let offset = 0; offset < data.length; offset += 100) {
    const { error } = await supabase.from(table).upsert(data.slice(offset, offset + 100), { onConflict });
    if (error) throw new Error(`Import failed for ${table}: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const users = rows("SELECT id, email, role, utility FROM users");
  await upsert("legacy_user_links", users.map(user => ({
    legacy_user_id: user.id,
    email: String(user.email).trim().toLowerCase(),
    role: user.role,
    utility: user.utility || null,
  })), "legacy_user_id");

  const advisories: Row[] = rows(`
    SELECT id, reference, title, utility, type, area, status, details, priority,
      image_data_url, latitude, longitude, service_starts_at, estimated_restoration_at,
      scheduled_at, publication_status, channels_json, created_at
    FROM advisories
  `).map(row => {
    const { channels_json: channelsJson, ...advisory } = row;
    return {
      ...advisory,
      channels: typeof channelsJson === "string" ? JSON.parse(channelsJson) : [],
    };
  });
  await upsert("advisories", advisories);

  await upsert("work_orders", rows(`
    SELECT id, reference, title, utility, area, description, status, starts_at, ends_at, created_at
    FROM work_orders
  `));
  await upsert("network_readings", rows(`
    SELECT id, utility, district, area, pressure_psi, reservoir_percent, recorded_at
    FROM network_readings
  `));
  await upsert("ui_copy", rows("SELECT content_key, content_value FROM ui_copy"), "content_key");
  await upsert("portal_settings", rows("SELECT portal, settings_json FROM portal_settings")
    .map(row => ({ ...row, settings_json: JSON.parse(String(row.settings_json)) })), "portal");

  await upsert("legacy_import_reports", rows(`
    SELECT reports.id AS legacy_source_id, reports.user_id AS legacy_user_id,
      reports.reference, reports.title, reports.utility, reports.area, reports.details,
      reports.status, reports.created_at
    FROM reports
  `), "legacy_source_id");
  const { error: linkError } = await supabase.rpc("link_legacy_records");
  if (linkError) throw new Error(`Could not link imported reports: ${linkError.message}`);

  const { data: links, error: linksError } = await supabase
    .from("legacy_user_links")
    .select("legacy_user_id, profile_id")
    .not("profile_id", "is", null);
  if (linksError) throw new Error(`Could not resolve linked users: ${linksError.message}`);
  const profileIds = new Map((links ?? []).map(link => [Number(link.legacy_user_id), link.profile_id]));

  const socialPosts = rows("SELECT advisory_id, platform, post_id, permalink_url, published_at FROM social_posts");
  await upsert("social_posts", socialPosts, "advisory_id,platform");

  const emailDeliveries = rows(`
    SELECT id, advisory_id, resident_id AS legacy_resident_id, status, error_message,
      attempt_count, sent_at, created_at FROM email_deliveries
  `).flatMap(({ legacy_resident_id, ...row }) => {
    const residentId = profileIds.get(Number(legacy_resident_id));
    return residentId ? [{ ...row, resident_id: residentId }] : [];
  });
  await upsert("email_deliveries", emailDeliveries);

  const smsDeliveries = rows(`
    SELECT id, advisory_id, resident_id AS legacy_resident_id, read_at, created_at
    FROM sms_deliveries
  `).flatMap(({ legacy_resident_id, ...row }) => {
    const residentId = profileIds.get(Number(legacy_resident_id));
    return residentId ? [{ ...row, resident_id: residentId }] : [];
  });
  await upsert("sms_deliveries", smsDeliveries);

  const { data: adminLinks, error: adminLinksError } = await supabase
    .from("legacy_user_links")
    .select("legacy_user_id, profile_id")
    .not("profile_id", "is", null);
  if (adminLinksError) throw new Error(`Could not resolve administrators: ${adminLinksError.message}`);
  const adminProfiles = new Map((adminLinks ?? []).map(link => [Number(link.legacy_user_id), link.profile_id]));
  const gmailConnections = rows(`
    SELECT utility, sender_email, encrypted_refresh_token, connected_by, connected_at
    FROM gmail_connections
  `).flatMap(({ connected_by, ...row }) => {
    const profileId = adminProfiles.get(Number(connected_by));
    return profileId ? [{ ...row, connected_by: profileId }] : [];
  });
  await upsert("gmail_connections", gmailConnections, "utility");

  console.info([
    "SQLite data import completed.",
    `Advisories: ${advisories.length}`,
    `Work orders: ${local.prepare("SELECT COUNT(*) AS count FROM work_orders").get()?.count ?? 0}`,
    `Reports staged: ${local.prepare("SELECT COUNT(*) AS count FROM reports").get()?.count ?? 0}`,
    `Email deliveries linked: ${emailDeliveries.length}`,
    `SMS deliveries linked: ${smsDeliveries.length}`,
    `Gmail connections linked: ${gmailConnections.length}`,
    "User credentials were not read or imported.",
    "Run this command again after residents re-register to link their existing records by email.",
  ].join("\n"));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Legacy import failed.");
  process.exitCode = 1;
} finally {
  local.close();
}
