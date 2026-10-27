import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { database, findActorForToken, hashPassword, issueSession, seedDemoAccounts, verifyPassword, type Actor } from "./database.js";
import {
  type GmailConnectionFailure,
  assertGmailTokenEncryptionConfigured,
  configuredGmailSender,
  createGmailAuthorizationUrl,
  decryptRefreshToken,
  encryptRefreshToken,
  exchangeGmailAuthorizationCode,
  gmailConnectionFailure,
  parseGmailImageAttachment,
  safeGmailError,
  sendGmailMessage,
} from "./gmail.js";
import { publishAnnouncementToSocial, socialConfiguration, type SocialDeliverySummary, type SocialPlatform } from "./social.js";

type Portal = "resident" | "cepalco" | "water";
type Locals = { actor?: Actor };
type Row = Record<string, unknown>;
const utilities: Record<Exclude<Portal, "resident">, string> = { cepalco: "CEPALCO", water: "Water District" };
const notificationChannels = ["facebook", "instagram", "gmail", "sms"] as const;
type NotificationChannel = typeof notificationChannels[number];
const requiredAnnouncementChannels: NotificationChannel[] = ["facebook", "gmail"];

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the API server environment.");
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

async function syncResidentProfiles(supabase: ReturnType<typeof supabaseAdmin>) {
  const residents = await residentProfilesFromSupabase(supabase);

  for (const resident of residents ?? []) {
    const existing = database.prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND role = 'resident' LIMIT 1")
      .get(resident.email) as { id: number } | undefined;
    const columns = [
      resident.name, resident.email, resident.phone_number, resident.address, resident.barangay,
      resident.district, resident.city, resident.postal_code, resident.profile_image,
      Number(resident.sms_alerts), Number(resident.notify_maintenance),
      Number(resident.notify_email_digest), Number(resident.immediate_email_alerts), resident.terms_accepted_at,
    ];
    if (existing) {
      database.prepare(`
        UPDATE users SET name=?,email=?,phone_number=?,address=?,barangay=?,district=?,city=?,
          postal_code=?,profile_image=?,sms_alerts=?,notify_maintenance=?,notify_email_digest=?,
          immediate_email_alerts=?,terms_accepted_at=? WHERE id=?
      `).run(...columns, existing.id);
    } else {
      database.prepare(`
        INSERT INTO users
          (name,email,password_hash,role,utility,phone_number,address,barangay,district,city,
           postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,
           immediate_email_alerts,terms_accepted_at)
        VALUES (?,?,?,'resident',NULL,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(resident.name, resident.email, hashPassword(randomBytes(32).toString("hex")), ...columns.slice(2));
    }
  }
  return residents ?? [];
}

async function residentProfilesFromSupabase(supabase: ReturnType<typeof supabaseAdmin>) {
  const residents = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from("profiles")
      .select("id,name,email,role,utility,phone_number,address,barangay,district,city,postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,immediate_email_alerts,terms_accepted_at")
      .eq("role", "resident")
      .order("id")
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    residents.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
  }
  return residents;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value.trim();
}

function parseAnnouncementChannels(value: unknown): NotificationChannel[] {
  const channels = value === undefined ? requiredAnnouncementChannels : value;
  if (!Array.isArray(channels) ||
      channels.some(channel => typeof channel !== "string" || !notificationChannels.includes(channel as NotificationChannel))) {
    throw new Error("Select valid announcement channels.");
  }
  const selectedChannels = channels as NotificationChannel[];
  return [...new Set([...selectedChannels, ...requiredAnnouncementChannels])];
}

function parseScheduledAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Choose a valid announcement date and time.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    throw new Error("Scheduled announcement time must be in the future.");
  }
  return date.toISOString();
}

function parseOptionalDateTime(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be a valid date and time.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid date and time.`);
  return date.toISOString();
}

function createSimulatedSms(advisoryId: number): number {
  const result = database.prepare(`
    INSERT OR IGNORE INTO sms_deliveries (advisory_id, resident_id)
    SELECT ?, id FROM users
    WHERE role = 'resident' AND (sms_alerts = 1 OR sms_alerts IS NULL)
  `).run(advisoryId);
  return Number(result.changes);
}

function recordSocialPosts(advisoryId: number, summary: SocialDeliverySummary | null): void {
  if (!summary) return;
  const save = database.prepare(`
    INSERT INTO social_posts (advisory_id, platform, post_id, permalink_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(advisory_id, platform) DO UPDATE SET
      post_id = excluded.post_id,
      permalink_url = excluded.permalink_url,
      published_at = CURRENT_TIMESTAMP
  `);
  for (const post of summary.platforms) {
    if (post.status === "published" && post.id) {
      save.run(advisoryId, post.platform, post.id, post.permalinkUrl ?? null);
    }
  }
}

function socialLinksForAdvisory(advisoryId: number): string[] {
  const rows = database.prepare(`
    SELECT platform, permalink_url FROM social_posts
    WHERE advisory_id = ? AND permalink_url IS NOT NULL
    ORDER BY platform
  `).all(advisoryId) as Array<{ platform: string; permalink_url: string }>;
  return rows.map(({ platform, permalink_url }) => `${platform === "facebook" ? "Facebook" : "Instagram"}: ${permalink_url}`);
}

async function publishSelectedChannels(
  portal: Exclude<Portal, "resident">,
  utility: string,
  advisory: {
    id: number;
    reference: string;
    title: string;
    area: string;
    details: string;
    imageDataUrl: string | null;
  },
  channels: NotificationChannel[],
  recipientEmails?: string[],
) {
  if (!advisory.imageDataUrl) throw new Error("Add an announcement image before publishing to Facebook and Gmail.");
  const socialChannels = channels.filter((channel): channel is SocialPlatform => channel === "facebook" || channel === "instagram");
  const socialDelivery = socialChannels.length
    ? await publishAnnouncementToSocial(portal, utility, advisory.id, advisory.reference, advisory.title, advisory.area, advisory.details, advisory.imageDataUrl, socialChannels)
    : null;
  recordSocialPosts(advisory.id, socialDelivery);
  const socialLinks = socialLinksForAdvisory(advisory.id);
  const emailDelivery = channels.includes("gmail")
    ? await deliverAdvisoryEmails(portal, utility, advisory.id, advisory.reference, advisory.title, advisory.area, advisory.details, advisory.imageDataUrl, false, socialLinks, recipientEmails)
    : null;
  const smsQueued = channels.includes("sms") ? createSimulatedSms(advisory.id) : 0;
  return { emailDelivery, socialDelivery, socialLinks: socialLinksForAdvisory(advisory.id), smsQueued };
}

// ADDED: Validate optional map coordinates from the advisory publishing form.
function optionalCoordinate(value: unknown, name: string, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const coordinate = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(coordinate) || coordinate < minimum || coordinate > maximum) {
    throw new Error(`${name} must be a valid number between ${minimum} and ${maximum}.`);
  }
  return coordinate;
}


function publicActor(actor: Actor) {
  return {
    id: actor.id,
    name: actor.name,
    email: actor.email,
    role: actor.role,
    utility: actor.utility,
    phoneNumber: actor.phone_number ?? "",
    address: actor.address ?? "",
    barangay: actor.barangay ?? "",
    district: actor.district ?? "",
    city: actor.city ?? "",
    postalCode: actor.postal_code ?? "",
    profileImage: actor.profile_image ?? null,
    smsAlerts: Boolean(actor.sms_alerts),
    maintenanceAlerts: Boolean(actor.notify_maintenance),
    emailDigest: Boolean(actor.notify_email_digest),
    immediateEmailAlerts: Boolean(actor.immediate_email_alerts),
  };
}

function decorateRows<T extends Row>(rows: T[]): T[] {
  return rows.map(row => {
    const decorated: Row = { ...row };
    for (const [key, value] of Object.entries(row)) {
      const outputKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      decorated[outputKey] = value;
    }
    return decorated as T;
  });
}

export function createApi(portal: Portal) {
  seedDemoAccounts();
  const app = express();
  app.disable("x-powered-by");
  const configuredOrigins = process.env.CORS_ORIGIN?.split(",").map(origin => origin.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (configuredOrigins && configuredOrigins.includes(origin)) return callback(null, true);
      if (process.env.NODE_ENV !== "production") {
        if (/^https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)(?::\d+)?$/.test(origin)) {
          return callback(null, true);
        }
      }
      return callback(new Error("Origin is not allowed by CORS."));
    },
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, portal, service: "CivicAlert API" }));
  app.get("/content", (_req, res) => {
    const rows = database.prepare("SELECT content_key, content_value FROM ui_copy ORDER BY content_key").all() as Array<{ content_key: string; content_value: string }>;
    const settings = database.prepare("SELECT settings_json FROM portal_settings WHERE portal = ?").get(portal) as { settings_json: string } | undefined;
    if (!settings) return res.status(500).json({ error: `Portal content for ${portal} is unavailable.` });
    return res.json({ copy: Object.fromEntries(rows.map(row => [row.content_key, row.content_value])), settings: JSON.parse(settings.settings_json) });
  });
  app.get("/advisories/:id/image", (req, res) => {
    const advisory = database.prepare(`
      SELECT image_data_url FROM advisories
      WHERE id = ? AND publication_status IN ('published', 'publishing')
    `).get(Number(req.params.id)) as { image_data_url: string | null } | undefined;
    if (!advisory?.image_data_url) return res.status(404).json({ error: "Announcement image not found." });
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(advisory.image_data_url);
    if (!match) return res.status(404).json({ error: "Announcement image is not available." });
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.type(match[1]).send(Buffer.from(match[2], "base64"));
  });
  if (portal === "resident") {
    app.get("/inbox", authenticate("resident"), (_req, res: Response<unknown, Locals>) => {
      const rows = database.prepare(`
        SELECT deliveries.id, users.id AS recipient_id, users.name AS recipient,
          users.phone_number, advisories.utility, advisories.reference, advisories.title,
          advisories.area, deliveries.created_at, deliveries.read_at
        FROM sms_deliveries AS deliveries
        JOIN users ON users.id = deliveries.resident_id
        JOIN advisories ON advisories.id = deliveries.advisory_id
        WHERE deliveries.resident_id = ?
        ORDER BY deliveries.id DESC
      `).all(res.locals.actor!.id) as Array<Record<string, unknown>>;
      return res.json(rows.map(row => ({
        id: row.id,
        recipientId: row.recipient_id,
        recipient: row.recipient,
        phoneNumber: row.phone_number,
        utility: row.utility,
        reference: row.reference,
        body: `${row.utility} advisory for ${row.area}: ${row.title}`,
        createdAt: row.created_at,
        status: "Simulated",
        read: row.read_at !== null,
      })));
    });
    app.patch("/inbox/:id/read", authenticate("resident"), (req, res: Response<unknown, Locals>) => {
      const result = database.prepare("UPDATE sms_deliveries SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND resident_id = ?")
        .run(Number(req.params.id), res.locals.actor!.id);
      return Number(result.changes) ? res.json({ ok: true }) : res.status(404).json({ error: "Inbox message not found." });
    });
  } else {
    app.get("/inbox", (_req, res) => res.status(404).json({ error: "The simulated SMS inbox is available only to residents." }));
    app.patch("/inbox/:id/read", (_req, res) => res.status(404).json({ error: "The simulated SMS inbox is available only to residents." }));
  }
  if (portal === "resident") {
    app.get("/auth/me", authenticate("resident"), (_req, res: Response<unknown, Locals>) => res.json({ actor: publicActor(res.locals.actor!) }));
  } else {
    app.get("/auth/me", requireUtility(utilities[portal]), (_req, res: Response<unknown, Locals>) => res.json({ actor: publicActor(res.locals.actor!) }));
    app.get("/email/gmail/status", requireUtility(utilities[portal]), (_req, res) => {
      const connection = database.prepare("SELECT sender_email, connected_at FROM gmail_connections WHERE utility = ?")
        .get(utilities[portal]) as { sender_email: string; connected_at: string } | undefined;
      if (!connection) return res.json({ connected: false, senderEmail: null, connectedAt: null });
      try {
        const stored = database.prepare("SELECT encrypted_refresh_token FROM gmail_connections WHERE utility = ?")
          .get(utilities[portal]) as { encrypted_refresh_token: string };
        decryptRefreshToken(stored.encrypted_refresh_token);
        return res.json({ connected: true, senderEmail: connection.sender_email, connectedAt: connection.connected_at });
      } catch (error) {
        return res.json({
          connected: false,
          senderEmail: connection.sender_email,
          connectedAt: connection.connected_at,
          connectionError: error instanceof Error ? error.message : "Stored Gmail authorization is unavailable.",
        });
      }
    });
    app.post("/email/gmail/connect", requireUtility(utilities[portal]), (req, res: Response<unknown, Locals>) => {
      const state = randomBytes(32).toString("base64url");
      const userId = res.locals.actor!.id;
      try {
        assertGmailTokenEncryptionConfigured();
        configuredGmailSender(portal);
        const authorizationUrl = createGmailAuthorizationUrl(portal, state);
        database.prepare("DELETE FROM gmail_oauth_states WHERE expires_at < ?").run(Date.now());
        database.prepare("INSERT INTO gmail_oauth_states (state_hash, user_id, utility, expires_at) VALUES (?, ?, ?, ?)")
          .run(createHash("sha256").update(state).digest("hex"), userId, utilities[portal], Date.now() + 5 * 60 * 1000);
        return res.json({ authorizationUrl });
      } catch (error) {
        return res.status(503).json({ error: error instanceof Error ? error.message : "Gmail OAuth is not configured on the server." });
      }
    });
    app.get("/oauth/gmail/callback", async (req, res) => {
      const frontend = gmailFrontendUrl(portal);
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const stateHash = createHash("sha256").update(state).digest("hex");
      const oauthState = state ? database.prepare(`
        SELECT oauth_states.user_id, oauth_states.utility, oauth_states.expires_at
        FROM gmail_oauth_states AS oauth_states
        JOIN users ON users.id = oauth_states.user_id
        WHERE oauth_states.state_hash = ? AND users.role = 'admin' AND users.utility = oauth_states.utility
      `)
        .get(stateHash) as { user_id: number; utility: string; expires_at: number } | undefined : undefined;
      if (!oauthState || oauthState.expires_at < Date.now() || oauthState.utility !== utilities[portal]) {
        return res.redirect(gmailFrontendRedirect(frontend, portal, "error", "invalid_state"));
      }
      database.prepare("DELETE FROM gmail_oauth_states WHERE state_hash = ?").run(stateHash);
      if (typeof req.query.error === "string") {
        const reason = req.query.error === "access_denied" ? "cancelled" : "google_error";
        return res.redirect(gmailFrontendRedirect(frontend, portal, "error", reason));
      }
      if (typeof req.query.code !== "string") {
        return res.redirect(gmailFrontendRedirect(frontend, portal, "error", "google_error"));
      }
      try {
        const connected = await exchangeGmailAuthorizationCode(portal, req.query.code);
        if (connected.email !== configuredGmailSender(portal)) {
          throw new Error("The authorized Google account does not match the configured official utility address.");
        }
        const existing = database.prepare("SELECT encrypted_refresh_token FROM gmail_connections WHERE utility = ?")
          .get(utilities[portal]) as { encrypted_refresh_token: string } | undefined;
        const refreshToken = connected.refreshToken
          ? encryptRefreshToken(connected.refreshToken)
          : existing?.encrypted_refresh_token;
        if (!refreshToken) throw new Error("Google did not issue a refresh token. Reconnect and approve offline access.");
        database.prepare(`
          INSERT INTO gmail_connections (utility, sender_email, encrypted_refresh_token, connected_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(utility) DO UPDATE SET
            sender_email = excluded.sender_email,
            encrypted_refresh_token = excluded.encrypted_refresh_token,
            connected_by = excluded.connected_by,
            connected_at = CURRENT_TIMESTAMP
        `).run(utilities[portal], connected.email, refreshToken, oauthState.user_id);
        return res.redirect(gmailFrontendRedirect(frontend, portal, "connected"));
      } catch (error) {
        console.error(`[${portal}-api] Gmail account connection failed: ${safeGmailError(error)}`);
        return res.redirect(gmailFrontendRedirect(frontend, portal, "error", gmailConnectionFailure(error)));
      }
    });
  }
  app.post("/auth/login", (req, res) => {
    try {
      const email = required(req.body?.email, "Email").toLowerCase();
      const password = required(req.body?.password, "Password");
      const expectedRole = portal === "resident" ? "resident" : "admin";
      const user = database.prepare("SELECT id, name, email, password_hash, role, utility, phone_number, address, barangay, district, city, postal_code, profile_image, sms_alerts, notify_maintenance, notify_email_digest, immediate_email_alerts, terms_accepted_at FROM users WHERE email = ? AND role = ? AND (utility IS ? OR utility = ?)").get(
        email, expectedRole, portal === "resident" ? null : utilities[portal], portal === "resident" ? "" : utilities[portal],
      ) as (Actor & { password_hash: string }) | undefined;
      if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "Email or password is incorrect." });
      const { password_hash: _secret, ...actor } = user;
      return res.json({ token: issueSession(user.id), actor: publicActor(actor) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid sign-in request." });
    }
  });

  if (portal === "resident") {
    app.patch("/auth/profile", authenticate("resident"), (req, res: Response<unknown, Locals>) => {
      try {
        const name = required(req.body?.name, "Full name");
        const email = required(req.body?.email, "Email").toLowerCase();
        const phoneNumber = typeof req.body?.phoneNumber === "string" ? req.body.phoneNumber.trim() : "";
        const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
        const barangay = typeof req.body?.barangay === "string" ? req.body.barangay.trim() : "";
        const district = typeof req.body?.district === "string" ? req.body.district.trim() : "";
        const city = typeof req.body?.city === "string" ? req.body.city.trim() : "";
        const postalCode = typeof req.body?.postalCode === "string" ? req.body.postalCode.trim() : "";
        const smsAlerts = typeof req.body?.smsAlerts === "boolean" ? Number(req.body.smsAlerts) : res.locals.actor!.sms_alerts ?? 1;
        const maintenanceAlerts = typeof req.body?.maintenanceAlerts === "boolean" ? Number(req.body.maintenanceAlerts) : res.locals.actor!.notify_maintenance ?? 1;
        const emailDigest = typeof req.body?.emailDigest === "boolean" ? Number(req.body.emailDigest) : res.locals.actor!.notify_email_digest ?? 1;
        const immediateEmailAlerts = typeof req.body?.immediateEmailAlerts === "boolean" ? Number(req.body.immediateEmailAlerts) : res.locals.actor!.immediate_email_alerts ?? 0;
        const profileImage = req.body?.profileImage;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
        if (phoneNumber.length > 40 || address.length > 240 || barangay.length > 100 || district.length > 80 || city.length > 100 || postalCode.length > 20 || name.length > 120) {
          return res.status(400).json({ error: "One or more profile fields are too long." });
        }
        if (profileImage !== null && profileImage !== undefined &&
            (typeof profileImage !== "string" || profileImage.length > 1_500_000 ||
             !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(profileImage))) {
          return res.status(400).json({ error: "Choose a JPEG, PNG, or WebP profile image under 1 MB." });
        }
        const imageToSave = profileImage === undefined ? res.locals.actor!.profile_image ?? null : profileImage;
        const result = database.prepare(`
          UPDATE users SET name = ?, email = ?, phone_number = ?, address = ?, barangay = ?, district = ?, city = ?, postal_code = ?, profile_image = ?, sms_alerts = ?, notify_maintenance = ?, notify_email_digest = ?, immediate_email_alerts = ?
          WHERE id = ? AND role = 'resident'
        `).run(name, email, phoneNumber, address, barangay, district, city, postalCode, imageToSave, smsAlerts, maintenanceAlerts, emailDigest, immediateEmailAlerts, res.locals.actor!.id);
        if (!Number(result.changes)) return res.status(404).json({ error: "Resident account not found." });
        const actor = database.prepare("SELECT id, name, email, role, utility, phone_number, address, barangay, district, city, postal_code, profile_image, sms_alerts, notify_maintenance, notify_email_digest, immediate_email_alerts, terms_accepted_at FROM users WHERE id = ?").get(res.locals.actor!.id) as Actor;
        return res.json({ actor: publicActor(actor) });
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint")) return res.status(409).json({ error: "An account with this email already exists." });
        return res.status(400).json({ error: error instanceof Error ? error.message : "Could not update resident profile." });
      }
    });
    app.post("/auth/password", authenticate("resident"), (req, res: Response<unknown, Locals>) => {
      try {
        const currentPassword = required(req.body?.currentPassword, "Current password");
        const newPassword = required(req.body?.newPassword, "New password");
        if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
        const user = database.prepare("SELECT password_hash FROM users WHERE id = ? AND role = 'resident'").get(res.locals.actor!.id) as { password_hash: string } | undefined;
        if (!user || !verifyPassword(currentPassword, user.password_hash)) return res.status(401).json({ error: "Current password is incorrect." });
        if (verifyPassword(newPassword, user.password_hash)) return res.status(400).json({ error: "Choose a password you have not used before." });
        database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), res.locals.actor!.id);
        return res.json({ ok: true });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "Could not change password." });
      }
    });
    app.post("/auth/register", (req, res) => {
      try {
        const name = required(req.body?.name, "Name");
        const email = required(req.body?.email, "Email").toLowerCase();
        const password = required(req.body?.password, "Password");
        const phoneNumber = required(req.body?.phoneNumber, "Mobile telephone");
        const address = required(req.body?.address, "Street address");
        const barangay = required(req.body?.barangay, "Barangay");
        const district = required(req.body?.district, "District");
        const city = required(req.body?.city, "City");
        const postalCode = required(req.body?.postalCode, "Postal code");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
        if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
        if (name.length > 120 || phoneNumber.length > 40 || address.length > 240 || barangay.length > 100 || district.length > 80 || city.length > 100 || postalCode.length > 20) {
          return res.status(400).json({ error: "One or more registration fields are too long." });
        }
        if (req.body?.termsAccepted !== true) return res.status(400).json({ error: "Please accept the resident terms and privacy policy." });
        const smsAlerts = req.body?.smsAlerts === false ? 0 : 1;
        const immediateEmailAlerts = req.body?.immediateEmailAlerts === true ? 1 : 0;
        const id = Number(database.prepare(`
          INSERT INTO users (name, email, password_hash, role, utility, phone_number, address, barangay, district, city, postal_code, sms_alerts, immediate_email_alerts, terms_accepted_at)
          VALUES (?, ?, ?, 'resident', NULL, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(name, email, hashPassword(password), phoneNumber, address, barangay, district, city, postalCode, smsAlerts, immediateEmailAlerts).lastInsertRowid);
        const actor: Actor = { id, name, email, role: "resident", utility: null, phone_number: phoneNumber, address, barangay, district, city, postal_code: postalCode, sms_alerts: smsAlerts, immediate_email_alerts: immediateEmailAlerts, notify_maintenance: 1, notify_email_digest: 1 };
        return res.status(201).json({ token: issueSession(id), actor: publicActor(actor) });
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint")) return res.status(409).json({ error: "An account with this email already exists." });
        return res.status(400).json({ error: error instanceof Error ? error.message : "Could not create account." });
      }
    });
    app.get("/advisories", (_req, res) => res.json(decorateRows(database.prepare(`
      SELECT advisories.id, reference, title, utility, type, area, status, details, priority,
        service_starts_at, estimated_restoration_at, created_at, latitude, longitude,
        scheduled_at, publication_status, channels_json,
        (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'facebook') AS facebook_url,
        (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'instagram') AS instagram_url,
        CASE WHEN image_data_url IS NOT NULL THEN '/advisories/' || advisories.id || '/image' END AS image_url
      FROM advisories WHERE publication_status = 'published' ORDER BY advisories.id DESC
    `).all() as Row[])));
    app.get("/work-orders", (_req, res) => {
      const rows = database.prepare("SELECT id, reference, title, utility, area, status, starts_at, ends_at FROM work_orders ORDER BY starts_at").all() as Row[];
      return res.json(decorateRows(rows));
    });
    app.post("/reports", authenticate("resident"), (req, res: Response<unknown, Locals>) => {
      try {
        const utility = required(req.body?.utility, "Utility");
        if (!["CEPALCO", "Water District"].includes(utility)) return res.status(400).json({ error: "Choose a valid utility." });
        const title = required(req.body?.issue, "Issue");
        const area = required(req.body?.area, "Service area");
        const details = typeof req.body?.details === "string" ? req.body.details.trim() : "";
        const reference = `CAS-R-${Date.now().toString(36).toUpperCase()}${randomInt(10, 99)}`;
        const id = Number(database.prepare("INSERT INTO reports (reference, user_id, title, utility, area, details) VALUES (?, ?, ?, ?, ?, ?)").run(reference, res.locals.actor!.id, title, utility, area, details).lastInsertRowid);
        return res.status(201).json({ id, reference, title, utility, area, details, status: "Received" });
      } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Could not submit report." }); }
    });
    app.get("/reports/mine", authenticate("resident"), (_req, res: Response<unknown, Locals>) => {
      const rows = database.prepare("SELECT id, reference, title, utility, area, status, created_at FROM reports WHERE user_id = ? ORDER BY id DESC").all(res.locals.actor!.id) as Row[];
      return res.json(decorateRows(rows));
    });
  } else {
    const utility = utilities[portal];
    app.post("/advisories/:id/deliver", requireUtility(utility), async (req, res) => {
      const supabase = supabaseAdmin();
      const advisoryId = Number(req.params.id);
      const { data: advisory, error: advisoryError } = await supabase.from("advisories")
        .select("id,reference,title,utility,type,area,status,details,priority,service_starts_at,estimated_restoration_at,image_data_url,latitude,longitude,scheduled_at,publication_status,channels")
        .eq("id", advisoryId).eq("utility", utility).single();
      if (advisoryError || !advisory) return res.status(404).json({ error: "Supabase advisory not found." });
      if (!advisory.image_data_url) {
        return res.status(400).json({ error: "Add an announcement image before publishing to Facebook and Gmail." });
      }
      try {
        const residents = await syncResidentProfiles(supabase);

        const localAdvisoryId = (database.prepare(`
          INSERT INTO advisories
            (reference,title,utility,type,area,status,details,priority,service_starts_at,
             estimated_restoration_at,image_data_url,latitude,longitude,scheduled_at,
             publication_status,channels_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(reference) DO UPDATE SET
            title=excluded.title, utility=excluded.utility, type=excluded.type, area=excluded.area,
            status=excluded.status, details=excluded.details, priority=excluded.priority,
            service_starts_at=excluded.service_starts_at,
            estimated_restoration_at=excluded.estimated_restoration_at,
            image_data_url=excluded.image_data_url, latitude=excluded.latitude, longitude=excluded.longitude,
            scheduled_at=excluded.scheduled_at, publication_status=excluded.publication_status,
            channels_json=excluded.channels_json
          RETURNING id
        `).get(
          advisory.reference, advisory.title, advisory.utility, advisory.type, advisory.area,
          advisory.status, advisory.details, advisory.priority, advisory.service_starts_at,
          advisory.estimated_restoration_at, advisory.image_data_url, advisory.latitude,
          advisory.longitude, advisory.scheduled_at, advisory.publication_status,
          JSON.stringify(advisory.channels),
        ) as { id: number }).id;

        // Mirror scheduled Supabase notices into the shared API database without publishing yet.
        // The utility-specific worker will deliver them when their schedule becomes due.
        if (advisory.publication_status === "scheduled") return res.json({ scheduled: true });

        const delivery = await publishSelectedChannels(portal, utility, {
          id: localAdvisoryId,
          reference: advisory.reference,
          title: advisory.title,
          area: advisory.area,
          details: advisory.details,
          imageDataUrl: advisory.image_data_url,
        }, parseAnnouncementChannels(advisory.channels), residents.map(resident => resident.email));

        const localEmailRows = database.prepare(`
          SELECT users.email, deliveries.status, deliveries.error_message,
            deliveries.attempt_count, deliveries.sent_at, deliveries.created_at
          FROM email_deliveries AS deliveries
          JOIN users ON users.id = deliveries.resident_id
          WHERE deliveries.advisory_id = ?
        `).all(localAdvisoryId) as Array<{
          email: string;
          status: "pending" | "sent" | "failed";
          error_message: string | null;
          attempt_count: number;
          sent_at: string | null;
          created_at: string;
        }>;
        for (const emailRow of localEmailRows) {
          const resident = (residents ?? []).find(profile => profile.email.toLowerCase() === emailRow.email.toLowerCase());
          if (!resident) continue;
          const { error } = await supabase.from("email_deliveries").upsert({
            advisory_id: advisory.id,
            resident_id: resident.id,
            status: emailRow.status,
            error_message: emailRow.error_message,
            attempt_count: emailRow.attempt_count,
            sent_at: emailRow.sent_at,
            created_at: emailRow.created_at,
          }, { onConflict: "advisory_id,resident_id" });
          if (error) throw error;
        }

        const localPosts = database.prepare(`
          SELECT platform,post_id,permalink_url,published_at FROM social_posts WHERE advisory_id=?
        `).all(localAdvisoryId) as Array<{ platform: string; post_id: string; permalink_url: string | null; published_at: string }>;
        for (const post of localPosts) {
          const { error } = await supabase.from("social_posts").upsert({
            advisory_id: advisory.id,
            platform: post.platform,
            post_id: post.post_id,
            permalink_url: post.permalink_url,
            published_at: post.published_at,
          }, { onConflict: "advisory_id,platform" });
          if (error) throw error;
        }

        if (advisory.channels.includes("sms")) {
          const recipients = (residents ?? []).filter(profile => profile.role === "resident" && profile.sms_alerts && profile.phone_number);
          if (recipients.length) {
            const { error } = await supabase.from("sms_deliveries").upsert(
              recipients.map(profile => ({ advisory_id: advisory.id, resident_id: profile.id })),
              { onConflict: "advisory_id,resident_id", ignoreDuplicates: true },
            );
            if (error) throw error;
          }
        }
        return res.json(delivery);
      } catch (error) {
        console.error(`[${portal}-api] Supabase announcement delivery failed:`, error);
        return res.status(500).json({ error: error instanceof Error ? error.message : "Announcement delivery failed." });
      }
    });
    app.get("/advisories", requireUtility(utility), (_req, res) => {
      const rows = database.prepare(`
        SELECT advisories.id, reference, title, utility, type, area, status, details, priority,
          service_starts_at, estimated_restoration_at, created_at, latitude, longitude,
          scheduled_at, publication_status, channels_json,
          (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'facebook') AS facebook_url,
          (SELECT permalink_url FROM social_posts WHERE advisory_id = advisories.id AND platform = 'instagram') AS instagram_url,
          CASE WHEN image_data_url IS NOT NULL THEN '/advisories/' || advisories.id || '/image' END AS image_url
        FROM advisories WHERE utility = ? ORDER BY advisories.id DESC
      `).all(utility) as Row[];
      return res.json(decorateRows(rows));
    });
    app.post("/advisories", requireUtility(utility), async (req, res) => {
      try {
        const title = required(req.body?.title, "Advisory title");
        const area = required(req.body?.area, "Affected service area");
        const details = required(req.body?.details, "Public update");
        const type = typeof req.body?.type === "string" ? req.body.type : "Service disruption";
        const priority = req.body?.priority == null ? "Normal" : required(req.body.priority, "Priority");
        if (!["Emergency", "Urgent", "High", "Normal", "Critical", "Medium", "Low"].includes(priority)) {
          throw new Error("Choose a valid advisory priority.");
        }
        const serviceStartsAt = parseOptionalDateTime(req.body?.serviceStartsAt, "Advisory start");
        const estimatedRestorationAt = parseOptionalDateTime(req.body?.estimatedRestorationAt, "Estimated restoration");
        if (serviceStartsAt && estimatedRestorationAt && new Date(estimatedRestorationAt) <= new Date(serviceStartsAt)) {
          throw new Error("Estimated restoration must be after the advisory start.");
        }
        const channels = parseAnnouncementChannels(req.body?.channels);
        const scheduledAt = parseScheduledAt(req.body?.scheduledAt);

        // ADDED: Validate the optional Google Maps location. A pin must include both coordinates.
        const latitude = optionalCoordinate(req.body?.latitude, "Latitude", -90, 90);
        const longitude = optionalCoordinate(req.body?.longitude, "Longitude", -180, 180);
        if ((latitude === null) !== (longitude === null)) {
          throw new Error("Select a map location so both latitude and longitude are provided.");
        }

        // ADDED: Validate the optional announcement image before saving the advisory.
        // The frontend will submit it as a data URL (JPEG, PNG, or WebP).
        const validatedImage = parseGmailImageAttachment(req.body?.imageDataUrl ?? null);
        const imageDataUrl = validatedImage
          ? `data:${validatedImage.mimeType};base64,${validatedImage.content.toString("base64")}`
          : null;
        if (!imageDataUrl) throw new Error("Add an announcement image before publishing to Facebook and Gmail.");

        const reference = `${portal === "water" ? "WD" : "CE"}-${Date.now().toString(36).toUpperCase()}`;

        // ADDED: Save the validated image with the advisory so failed email deliveries can retry with it.
        const publicationStatus = scheduledAt ? "scheduled" : "published";
        const status = scheduledAt ? "Scheduled" : "Monitoring";
        const id = Number(database.prepare(`
          INSERT INTO advisories
            (reference, title, utility, type, area, status, details, priority, service_starts_at, estimated_restoration_at, image_data_url, latitude, longitude, scheduled_at, publication_status, channels_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(reference, title, utility, type, area, status, details, priority, serviceStartsAt, estimatedRestorationAt, imageDataUrl, latitude, longitude, scheduledAt, publicationStatus, JSON.stringify(channels)).lastInsertRowid);

        const delivery = scheduledAt ? null : await publishSelectedChannels(portal, utility, {
          id, reference, title, area, details, imageDataUrl,
        }, channels);

        return res.status(201).json({
          id, reference, title, utility, type, area, status, details, priority, serviceStartsAt, estimatedRestorationAt, latitude, longitude,
          scheduledAt, publicationStatus, channels,
          facebookUrl: socialLinksForAdvisory(id).find(link => link.startsWith("Facebook: "))?.slice("Facebook: ".length) ?? null,
          instagramUrl: socialLinksForAdvisory(id).find(link => link.startsWith("Instagram: "))?.slice("Instagram: ".length) ?? null,
          ...delivery,
        });
      } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Could not publish advisory." }); }
    });
    app.get("/advisories/:id/email-delivery", requireUtility(utility), (req, res) => {
      const advisory = database.prepare("SELECT id FROM advisories WHERE id = ? AND utility = ?")
        .get(Number(req.params.id), utility) as { id: number } | undefined;
      if (!advisory) return res.status(404).json({ error: "Advisory not found." });
      const rows = database.prepare(`
        SELECT deliveries.status, deliveries.error_message, deliveries.attempt_count, deliveries.sent_at,
          users.name AS recipient_name
        FROM email_deliveries AS deliveries
        JOIN users ON users.id = deliveries.resident_id
        WHERE deliveries.advisory_id = ?
        ORDER BY deliveries.id
      `).all(advisory.id) as Array<{ status: "pending" | "sent" | "failed"; error_message: string | null; attempt_count: number; sent_at: string | null; recipient_name: string }>;
      return res.json(summarizeEmailDeliveries(rows));
    });
    app.post("/advisories/:id/email-delivery/retry", requireUtility(utility), async (req, res) => {
      // ADDED: Fetch the saved image too, so retrying a failed email preserves its attachment.
      const advisory = database.prepare(`
        SELECT id, reference, title, area, details, image_data_url
        FROM advisories WHERE id = ? AND utility = ?
      `).get(Number(req.params.id), utility) as {
        id: number;
        reference: string;
        title: string;
        area: string;
        details: string;
        image_data_url: string | null;
      } | undefined;
      if (!advisory) return res.status(404).json({ error: "Advisory not found." });
      try {
        const residentEmails = supabaseConfigured()
          ? (await syncResidentProfiles(supabaseAdmin())).map(resident => resident.email)
          : undefined;
        // ADDED: Pass the originally saved image before the `failedOnly` flag.
        const emailDelivery = await deliverAdvisoryEmails(
          portal,
          utility,
          advisory.id,
          advisory.reference,
          advisory.title,
          advisory.area,
          advisory.details,
          advisory.image_data_url,
          true,
          socialLinksForAdvisory(advisory.id),
          residentEmails,
        );
        return res.json(emailDelivery);
      } catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : "Could not retry email delivery." });
      }
    });
// ADDED: Report which social publishing platforms are configured for this utility.
app.get("/social/status", requireUtility(utility), (_req, res) => {
  return res.json(socialConfiguration(portal));
});

// ADDED: Publish or retry publishing an advisory to configured social media accounts.
app.post("/advisories/:id/social-publish", requireUtility(utility), async (req, res) => {
  const advisory = database.prepare(`
    SELECT id, reference, title, area, details, image_data_url
    FROM advisories WHERE id = ? AND utility = ?
  `).get(Number(req.params.id), utility) as {
    id: number;
    reference: string;
    title: string;
    area: string;
    details: string;
    image_data_url: string | null;
  } | undefined;
  if (!advisory) return res.status(404).json({ error: "Advisory not found." });
  try {
    const socialDelivery = await publishAnnouncementToSocial(
      portal,
      utility,
      advisory.id,
      advisory.reference,
      advisory.title,
      advisory.area,
      advisory.details,
      advisory.image_data_url,
    );
    recordSocialPosts(advisory.id, socialDelivery);
    return res.json({ ...socialDelivery, socialLinks: socialLinksForAdvisory(advisory.id) });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Could not publish to social media." });
  }
});

app.patch("/advisories/:id/status", requireUtility(utility), (req, res) => {
      const status = req.body?.status;
      if (!["Monitoring", "Under investigation", "Crew dispatched", "Resolved"].includes(status)) return res.status(400).json({ error: "Unsupported advisory status." });
      const result = database.prepare("UPDATE advisories SET status = ? WHERE id = ? AND utility = ? AND publication_status = 'published'").run(status, Number(req.params.id), utility);
      return Number(result.changes) ? res.json({ ok: true }) : res.status(404).json({ error: "Advisory not found." });
    });
    app.get("/work-orders", requireUtility(utility), (_req, res) => {
      const rows = database.prepare("SELECT id, reference, title, utility, area, status, starts_at, ends_at FROM work_orders WHERE utility = ? ORDER BY starts_at").all(utility) as Row[];
      return res.json(decorateRows(rows));
    });
    app.post("/work-orders", requireUtility(utility), (req, res) => {
      try {
        const title = required(req.body?.title, "Work order title");
        const area = required(req.body?.area, "Affected service area");
        const startsAt = required(req.body?.startsAt, "Start time");
        const endsAt = required(req.body?.endsAt, "End time");
        const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
        if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(startsAt)) return res.status(400).json({ error: "End time must be later than start time." });
        const reference = `${portal === "water" ? "WD" : "CE"}-WO-${Date.now().toString(36).toUpperCase()}`;
        const id = Number(database.prepare("INSERT INTO work_orders (reference, title, utility, area, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(reference, title, utility, area, description, startsAt, endsAt).lastInsertRowid);
        return res.status(201).json({ id, reference, title, utility, area, description, startsAt, endsAt, status: "Scheduled" });
      } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Could not create work order." }); }
    });
    app.get("/reports", requireUtility(utility), (_req, res) => {
      const rows = database.prepare("SELECT id, reference, title, utility, area, status, created_at FROM reports WHERE utility = ? ORDER BY id DESC").all(utility) as Row[];
      return res.json(decorateRows(rows));
    });
    app.patch("/reports/:id/status", requireUtility(utility), (req, res) => {
      const status = req.body?.status;
      if (!["Received", "Under investigation", "Crew dispatched", "Resolved"].includes(status)) return res.status(400).json({ error: "Unsupported report status." });
      const result = database.prepare("UPDATE reports SET status = ? WHERE id = ? AND utility = ?").run(status, Number(req.params.id), utility);
      return Number(result.changes) ? res.json({ ok: true }) : res.status(404).json({ error: "Report not found." });
    });
    if (portal === "water") {
      app.get("/network", requireUtility(utility), (_req, res) => {
        const rows = database.prepare("SELECT district, area, pressure_psi, reservoir_percent, recorded_at FROM network_readings WHERE utility = ? ORDER BY id").all(utility) as Row[];
        return res.json(decorateRows(rows));
      });
    }
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${portal}-api]`, error);
    res.status(500).json({ error: "An unexpected server error occurred." });
  });
  return app;
}

async function syncScheduledDeliveryToSupabase(
  portal: Exclude<Portal, "resident">,
  utility: string,
  reference: string,
  localAdvisoryId: number,
): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return;

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: advisory, error: advisoryError } = await supabase.from("advisories")
      .select("id").eq("reference", reference).eq("utility", utility).maybeSingle();
    if (advisoryError) throw advisoryError;
    if (!advisory) return;

    const profiles = await residentProfilesFromSupabase(supabase);
    const profileIds = new Map(profiles.map(profile => [profile.email.toLowerCase(), profile.id]));
    const localEmails = database.prepare(`
      SELECT users.email, deliveries.status, deliveries.error_message, deliveries.attempt_count,
        deliveries.sent_at, deliveries.created_at
      FROM email_deliveries AS deliveries JOIN users ON users.id = deliveries.resident_id
      WHERE deliveries.advisory_id = ?
    `).all(localAdvisoryId) as Array<{
      email: string; status: "pending" | "sent" | "failed"; error_message: string | null;
      attempt_count: number; sent_at: string | null; created_at: string;
    }>;
    const emailRows = localEmails.flatMap(row => {
      const residentId = profileIds.get(row.email.toLowerCase());
      return residentId ? [{
        advisory_id: advisory.id, resident_id: residentId, status: row.status,
        error_message: row.error_message, attempt_count: row.attempt_count,
        sent_at: row.sent_at, created_at: row.created_at,
      }] : [];
    });
    if (emailRows.length) {
      const { error } = await supabase.from("email_deliveries").upsert(emailRows, { onConflict: "advisory_id,resident_id" });
      if (error) throw error;
    }

    const posts = database.prepare(`
      SELECT platform, post_id, permalink_url, published_at FROM social_posts WHERE advisory_id = ?
    `).all(localAdvisoryId) as Array<{ platform: string; post_id: string; permalink_url: string | null; published_at: string }>;
    if (posts.length) {
      const { error } = await supabase.from("social_posts").upsert(posts.map(post => ({
        advisory_id: advisory.id, ...post,
      })), { onConflict: "advisory_id,platform" });
      if (error) throw error;
    }

    const smsRows = database.prepare(`
      SELECT users.email, deliveries.created_at, deliveries.read_at
      FROM sms_deliveries AS deliveries JOIN users ON users.id = deliveries.resident_id
      WHERE deliveries.advisory_id = ?
    `).all(localAdvisoryId) as Array<{ email: string; created_at: string; read_at: string | null }>;
    const mappedSms = smsRows.flatMap(row => {
      const residentId = profileIds.get(row.email.toLowerCase());
      return residentId ? [{ advisory_id: advisory.id, resident_id: residentId, created_at: row.created_at, read_at: row.read_at }] : [];
    });
    if (mappedSms.length) {
      const { error } = await supabase.from("sms_deliveries").upsert(mappedSms, {
        onConflict: "advisory_id,resident_id", ignoreDuplicates: true,
      });
      if (error) throw error;
    }

    const { error: updateError } = await supabase.from("advisories").update({
      publication_status: "published", status: "Monitoring",
    }).eq("id", advisory.id).eq("utility", utility);
    if (updateError) throw updateError;
  } catch (error) {
    // Do not mark an already-published external announcement failed just because its mirror sync failed.
    console.error(`[${portal}-api] Could not sync scheduled delivery to Supabase for ${reference}:`, error);
  }
}

export function startScheduledAnnouncementWorker(portal: Exclude<Portal, "resident">): () => void {
  const utility = utilities[portal];
  let running = false;
  const processDueAnnouncements = async () => {
    if (running) return;
    running = true;
    try {
      const due = database.prepare(`
        SELECT id, reference, title, area, details, image_data_url, channels_json
        FROM advisories
        WHERE utility = ? AND publication_status = 'scheduled'
          AND datetime(scheduled_at) <= datetime('now')
        ORDER BY scheduled_at, id
      `).all(utility) as Array<{
        id: number;
        reference: string;
        title: string;
        area: string;
        details: string;
        image_data_url: string | null;
        channels_json: string;
      }>;

      const claimed: typeof due = [];
      database.exec("BEGIN IMMEDIATE");
      try {
        const claim = database.prepare(`
          UPDATE advisories SET publication_status = 'publishing'
          WHERE id = ? AND utility = ? AND publication_status = 'scheduled'
        `);
        for (const advisory of due) {
          if (Number(claim.run(advisory.id, utility).changes)) claimed.push(advisory);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      for (const advisory of claimed) {
        try {
          const channels = parseAnnouncementChannels(JSON.parse(advisory.channels_json));
          const recipientEmails = supabaseConfigured()
            ? (await syncResidentProfiles(supabaseAdmin())).map(resident => resident.email)
            : undefined;
          const delivery = await publishSelectedChannels(portal, utility, {
            id: advisory.id,
            reference: advisory.reference,
            title: advisory.title,
            area: advisory.area,
            details: advisory.details,
            imageDataUrl: advisory.image_data_url,
          }, channels, recipientEmails);
          await syncScheduledDeliveryToSupabase(portal, utility, advisory.reference, advisory.id);
          database.prepare(`
            UPDATE advisories SET publication_status = 'published', status = 'Monitoring'
            WHERE id = ? AND utility = ? AND publication_status = 'publishing'
          `).run(advisory.id, utility);
          if (delivery.emailDelivery?.failed) {
            console.error(`[${portal}-api] Scheduled Gmail delivery failed for advisory ${advisory.reference}.`);
          }
          for (const post of delivery.socialDelivery?.platforms ?? []) {
            if (post.status === "failed" || post.status === "not_configured") {
              console.error(`[${portal}-api] Scheduled ${post.platform} delivery for advisory ${advisory.reference}: ${post.message || post.status}.`);
            }
          }
        } catch (error) {
          database.prepare(`
            UPDATE advisories SET publication_status = 'failed'
            WHERE id = ? AND utility = ? AND publication_status = 'publishing'
          `).run(advisory.id, utility);
          console.error(`[${portal}-api] Scheduled announcement ${advisory.reference} failed: ${error instanceof Error ? error.message : "Unknown error."}`);
        }
      }
    } catch (error) {
      console.error(`[${portal}-api] Scheduled announcement worker failed: ${error instanceof Error ? error.message : "Unknown error."}`);
    } finally {
      running = false;
    }
  };

  void processDueAnnouncements();
  const interval = setInterval(() => void processDueAnnouncements(), 15_000);
  interval.unref();
  return () => clearInterval(interval);
}

function authenticate(expectedRole: Actor["role"]) {
  return async (req: Request, res: Response<unknown, Locals>, next: NextFunction) => {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    try {
      const actor = await actorForAccessToken(token);
      if (!actor || actor.role !== expectedRole) return res.status(401).json({ error: "Please sign in to continue." });
      res.locals.actor = actor;
      next();
    } catch (error) {
      console.error("[api] Supabase token validation failed:", error);
      return res.status(503).json({ error: "Could not verify your Supabase session. Check the server-side Supabase configuration." });
    }
  };
}

function requireUtility(utility: string) {
  return async (req: Request, res: Response<unknown, Locals>, next: NextFunction) => {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    try {
      const actor = await actorForAccessToken(token);
      if (!actor || actor.role !== "admin" || actor.utility !== utility) return res.status(401).json({ error: "A matching utility administrator must sign in." });
      res.locals.actor = actor;
      next();
    } catch (error) {
      console.error("[api] Supabase token validation failed:", error);
      return res.status(503).json({ error: "Could not verify your Supabase session. Check the server-side Supabase configuration." });
    }
  };
}

async function actorForAccessToken(token: string): Promise<Actor | undefined> {
  if (!token) return undefined;
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return findActorForToken(token);

  const supabase = supabaseAdmin();
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return undefined;
  const { data: profile, error: profileError } = await supabase.from("profiles")
    .select("id,name,email,role,utility,phone_number,address,barangay,district,city,postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,immediate_email_alerts,terms_accepted_at")
    .eq("id", user.id).single();
  if (profileError) throw profileError;
  if (!profile) return undefined;

  const existing = database.prepare(`
    SELECT id FROM users WHERE lower(email) = lower(?) AND role = ?
      AND (utility IS ? OR utility = ?) LIMIT 1
  `).get(profile.email, profile.role, profile.utility, profile.utility) as { id: number } | undefined;
  if (existing) {
    return database.prepare(`
      SELECT id,name,email,role,utility,phone_number,address,barangay,district,city,
        postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,
        immediate_email_alerts,terms_accepted_at
      FROM users WHERE id = ?
    `).get(existing.id) as Actor;
  }

  database.prepare(`
    INSERT OR IGNORE INTO users
      (name,email,password_hash,role,utility,phone_number,address,barangay,district,city,postal_code,
       profile_image,sms_alerts,notify_maintenance,notify_email_digest,immediate_email_alerts,terms_accepted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    profile.name, profile.email, hashPassword(randomBytes(32).toString("hex")),
    profile.role, profile.utility, profile.phone_number, profile.address, profile.barangay,
    profile.district, profile.city, profile.postal_code, profile.profile_image,
    Number(profile.sms_alerts), Number(profile.notify_maintenance), Number(profile.notify_email_digest),
    Number(profile.immediate_email_alerts), profile.terms_accepted_at,
  );
  return database.prepare(`
    SELECT id,name,email,role,utility,phone_number,address,barangay,district,city,
      postal_code,profile_image,sms_alerts,notify_maintenance,notify_email_digest,
      immediate_email_alerts,terms_accepted_at
    FROM users WHERE lower(email) = lower(?) AND role = ?
      AND (utility IS ? OR utility = ?) LIMIT 1
  `).get(profile.email, profile.role, profile.utility, profile.utility) as Actor | undefined;
}

function gmailFrontendUrl(portal: Exclude<Portal, "resident">): URL {
  const variable = portal === "cepalco" ? "CEPALCO_FRONTEND_URL" : "WATER_FRONTEND_URL";
  const defaultPort = portal === "cepalco" ? 5174 : 5175;
  const configuredUrl = process.env[variable]?.trim() || `http://localhost:${defaultPort}`;
  const frontend = new URL(configuredUrl);
  if (frontend.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && frontend.protocol === "http:" && ["localhost", "127.0.0.1"].includes(frontend.hostname))) {
    throw new Error(`${variable} must use HTTPS outside local development.`);
  }
  return frontend;
}

function gmailFrontendRedirect(
  frontend: URL,
  portal: Exclude<Portal, "resident">,
  result: "connected" | "error",
  reason?: GmailConnectionFailure | "cancelled" | "google_error" | "invalid_state",
): string {
  frontend.search = "";
  frontend.hash = "";
  frontend.searchParams.set("portal", portal);
  frontend.searchParams.set("view", "portal");
  frontend.searchParams.set("page", "publish");
  frontend.searchParams.set("gmail", result);
  if (result === "error" && reason) frontend.searchParams.set("gmailError", reason);
  return frontend.toString();
}

type EmailDeliveryRow = {
  status: "pending" | "sent" | "failed";
  error_message: string | null;
  attempt_count: number;
  sent_at: string | null;
  recipient_name: string;
};

function summarizeEmailDeliveries(rows: EmailDeliveryRow[]) {
  const sent = rows.filter(row => row.status === "sent").length;
  const failed = rows.filter(row => row.status === "failed").length;
  const pending = rows.filter(row => row.status === "pending").length;
  const status = rows.length === 0
    ? "no_recipients"
    : pending > 0
      ? "pending"
      : failed === 0
        ? "sent"
        : sent > 0
          ? "partial"
          : "failed";
  const errors = new Map<string, number>();
  for (const row of rows) {
    if (row.error_message) errors.set(row.error_message, (errors.get(row.error_message) ?? 0) + 1);
  }
  return {
    status,
    attempted: sent + failed,
    sent,
    failed,
    pending,
    errors: [...errors].map(([message, count]) => ({ message, count })),
    deliveries: rows.map(row => ({
      status: row.status,
      error: row.error_message,
      attempts: row.attempt_count,
      sentAt: row.sent_at,
      recipientName: row.recipient_name,
    })),
  };
}

async function deliverAdvisoryEmails(
  portal: Exclude<Portal, "resident">,
  utility: string,
  advisoryId: number,
  reference: string,
  title: string,
  area: string,
  details: string,
  imageDataUrl: string | null = null,
  failedOnly = false,
  socialLinks: string[] = [],
  recipientEmails?: string[],
) {
  if (!imageDataUrl) throw new Error("Add an announcement image before sending advisory emails.");
  const normalizedEmails = recipientEmails?.map(email => email.toLowerCase());
  const emailPlaceholders = normalizedEmails?.map(() => "?").join(",") ?? "";
  const emailFilter = recipientEmails === undefined
    ? ""
    : emailPlaceholders
      ? `AND lower(users.email) IN (${emailPlaceholders})`
      : "AND 1=0";
  const recipients = failedOnly
    ? database.prepare(`
        SELECT users.id, users.name, users.email FROM email_deliveries
        JOIN users ON users.id = email_deliveries.resident_id
        WHERE email_deliveries.advisory_id = ? AND email_deliveries.status = 'failed'
          AND users.role = 'resident' ${emailFilter}
        ORDER BY users.id
      `).all(advisoryId, ...(normalizedEmails ?? [])) as Array<{ id: number; name: string; email: string }>
    : database.prepare(`
        SELECT users.id, users.name, users.email FROM users
        WHERE users.role = 'resident' ${emailFilter}
        ORDER BY id
      `).all(...(normalizedEmails ?? [])) as Array<{ id: number; name: string; email: string }>;
  if (failedOnly) {
    database.prepare(`
      UPDATE email_deliveries SET status = 'pending', error_message = NULL
      WHERE advisory_id = ? AND status = 'failed' AND resident_id IN (
        SELECT users.id FROM users WHERE users.role = 'resident' ${emailFilter}
      )
    `).run(advisoryId, ...(normalizedEmails ?? []));
  } else {
    for (const resident of recipients) {
      database.prepare(`
        INSERT OR IGNORE INTO email_deliveries (advisory_id, resident_id, status)
        VALUES (?, ?, 'pending')
      `).run(advisoryId, resident.id);
    }
  }
  if (recipients.length === 0) return summarizeEmailDeliveries([]);

  const connection = database.prepare("SELECT encrypted_refresh_token FROM gmail_connections WHERE utility = ?")
    .get(utility) as { encrypted_refresh_token: string } | undefined;
  let refreshToken: string | null = null;
  let connectionError: string | null = null;
  if (!connection) {
    connectionError = "No Gmail sending account is connected for this utility.";
  } else {
    try {
      refreshToken = decryptRefreshToken(connection.encrypted_refresh_token);
    } catch (error) {
      connectionError = error instanceof Error ? error.message : "Reconnect the Gmail sending account.";
    }
  }

  for (const recipient of recipients) {
    const update = database.prepare(`
      UPDATE email_deliveries
      SET status = ?, error_message = ?, attempt_count = attempt_count + 1,
        sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE advisory_id = ? AND resident_id = ?
    `);
    if (!refreshToken) {
      update.run("failed", connectionError, "failed", advisoryId, recipient.id);
      continue;
    }
    try {
      await sendGmailMessage(
        portal,
        refreshToken,
        recipient.email,
        `${utility} advisory: ${title}`,
        `${title}\n\n${area}\n\n${details}\n\nReference: ${reference}${socialLinks.length ? `\n\nSocial post links:\n${socialLinks.join("\n")}` : ""}`,
        // ADDED: Gmail creates a multipart email when this optional image data URL is present.
        imageDataUrl,
      );
      update.run("sent", null, "sent", advisoryId, recipient.id);
    } catch (error) {
      update.run("failed", safeGmailError(error), "failed", advisoryId, recipient.id);
    }
  }

  const rows = database.prepare(`
    SELECT deliveries.status, deliveries.error_message, deliveries.attempt_count,
      deliveries.sent_at, users.name AS recipient_name
    FROM email_deliveries AS deliveries
    JOIN users ON users.id = deliveries.resident_id
    WHERE deliveries.advisory_id = ?
    ORDER BY deliveries.id
  `).all(advisoryId) as EmailDeliveryRow[];
  return summarizeEmailDeliveries(rows);
}
