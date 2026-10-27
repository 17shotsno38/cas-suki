import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const databaseDirectory = mkdtempSync(join(tmpdir(), "civicalert-gmail-test-"));
process.env.DATABASE_PATH = join(databaseDirectory, "test.sqlite");
process.env.NODE_ENV = "test";
delete process.env.GMAIL_OAUTH_CLIENT_ID;
delete process.env.GMAIL_OAUTH_CLIENT_SECRET;
delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
delete process.env.CEPALCO_GMAIL_SENDER_EMAIL;
delete process.env.WATER_GMAIL_SENDER_EMAIL;

const [{ createApi, startScheduledAnnouncementWorker }, { database }] = await Promise.all([
  import("./server.js"),
  import("./database.js"),
]);
const servers: Server[] = [];

async function startApi(portal: "resident" | "cepalco" | "water"): Promise<string> {
  const server = createApi(portal).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the API test port.");
  return `http://127.0.0.1:${address.port}`;
}

async function jsonRequest(url: string, method = "GET", body?: unknown, token?: string) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json();
  return { response, result: result as Record<string, unknown> };
}

after(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  database.close();
  rmSync(databaseDirectory, { recursive: true, force: true });
});

test("all registered residents receive advisory email and admins remain utility-scoped", async () => {
  const residentApi = await startApi("resident");
  const cepalcoApi = await startApi("cepalco");
  const waterApi = await startApi("water");

  const registrationFields = {
    name: "Consenting Resident",
    password: "ValidPass123",
    phoneNumber: "09170000000",
    address: "1 Test Street",
    barangay: "Carmen",
    district: "1st District",
    city: "Cagayan de Oro City",
    postalCode: "9000",
    termsAccepted: true,
  };
  const optedInRegistration = await jsonRequest(`${residentApi}/auth/register`, "POST", {
    ...registrationFields,
    email: "opted-in@example.test",
    immediateEmailAlerts: true,
  });
  assert.equal(optedInRegistration.response.status, 201);
  const optedInToken = optedInRegistration.result.token as string;
  const optedInProfile = await jsonRequest(`${residentApi}/auth/profile`, "PATCH", {
    name: "Consenting Resident",
    email: "opted-in@example.test",
    phoneNumber: registrationFields.phoneNumber,
    emailDigest: false,
    immediateEmailAlerts: true,
    profileImage: null,
  }, optedInToken);
  assert.equal(optedInProfile.response.status, 200);
  assert.equal((optedInProfile.result.actor as Record<string, unknown>).emailDigest, false);
  assert.equal((optedInProfile.result.actor as Record<string, unknown>).immediateEmailAlerts, true);

  const optedOutRegistration = await jsonRequest(`${residentApi}/auth/register`, "POST", {
    ...registrationFields,
    name: "Nonconsenting Resident",
    email: "not-opted-in@example.test",
    smsAlerts: false,
  });
  assert.equal(optedOutRegistration.response.status, 201);

  const cepalcoLogin = await jsonRequest(`${cepalcoApi}/auth/login`, "POST", {
    email: "admin@cepalco.local",
    password: "DemoPass123!",
  });
  assert.equal(cepalcoLogin.response.status, 200);
  const cepalcoToken = cepalcoLogin.result.token as string;
  const initialAdvisories = await jsonRequest(`${cepalcoApi}/advisories`, "GET", undefined, cepalcoToken);
  assert.deepEqual(initialAdvisories.result, []);
  const gmailStatus = await jsonRequest(`${cepalcoApi}/email/gmail/status`, "GET", undefined, cepalcoToken);
  assert.equal(gmailStatus.response.status, 200);
  assert.equal(gmailStatus.result.connected, false);
  const socialStatus = await jsonRequest(`${cepalcoApi}/social/status`, "GET", undefined, cepalcoToken);
  assert.equal(socialStatus.response.status, 200);
  assert.equal(typeof socialStatus.result.facebook, "boolean");
  assert.equal(typeof socialStatus.result.instagram, "boolean");

  const previousFetch = globalThis.fetch;
  const previousMetaEnvironment = {
    pageId: process.env.META_FACEBOOK_PAGE_ID,
    accessToken: process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN,
  };
  process.env.META_FACEBOOK_PAGE_ID = "test-page";
  process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = "test-page-token";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "graph.facebook.com" && init?.method === "POST" && ["/feed", "/photos"].some(path => url.pathname.endsWith(path))) {
      return new Response(JSON.stringify({ id: "test-page_456" }), { status: 200 });
    }
    if (url.hostname === "graph.facebook.com" && url.searchParams.get("fields") === "permalink_url") {
      return new Response(JSON.stringify({ permalink_url: "https://www.facebook.com/test-page/posts/456" }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  try {
    const facebookAdvisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
      title: "Facebook link test",
      area: "Carmen",
      details: "Verify stored social post links.",
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      channels: ["facebook"],
    }, cepalcoToken);
    assert.equal(facebookAdvisory.response.status, 201);
    assert.equal(facebookAdvisory.result.facebookUrl, "https://www.facebook.com/test-page/posts/456");
    const residentFacebookAdvisories = await jsonRequest(`${residentApi}/advisories`);
    assert.ok((residentFacebookAdvisories.result as unknown as Array<Record<string, unknown>>)
      .some(item => item.id === facebookAdvisory.result.id && item.facebookUrl === "https://www.facebook.com/test-page/posts/456"));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMetaEnvironment.pageId === undefined) delete process.env.META_FACEBOOK_PAGE_ID;
    else process.env.META_FACEBOOK_PAGE_ID = previousMetaEnvironment.pageId;
    if (previousMetaEnvironment.accessToken === undefined) delete process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN;
    else process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = previousMetaEnvironment.accessToken;
  }

  const scheduled = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    title: "Scheduled service update",
    area: "Carmen",
    type: "Maintenance",
    details: "This update is scheduled for testing.",
    priority: "Urgent",
    serviceStartsAt: "2026-10-23T08:00:00.000Z",
    estimatedRestorationAt: "2026-10-23T12:00:00.000Z",
    channels: ["sms"],
    imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, cepalcoToken);
  assert.equal(scheduled.response.status, 201);
  assert.equal(scheduled.result.publicationStatus, "scheduled");
  assert.ok((scheduled.result.channels as string[]).includes("facebook"));
  assert.ok((scheduled.result.channels as string[]).includes("gmail"));
  assert.equal(scheduled.result.priority, "Urgent");
  assert.equal(scheduled.result.serviceStartsAt, "2026-10-23T08:00:00.000Z");
  assert.equal(scheduled.result.estimatedRestorationAt, "2026-10-23T12:00:00.000Z");
  assert.equal(scheduled.result.emailDelivery, undefined);
  const invalidWindow = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    title: "Invalid service window",
    area: "Carmen",
    details: "This advisory has an invalid timeline.",
    serviceStartsAt: "2026-10-23T12:00:00.000Z",
    estimatedRestorationAt: "2026-10-23T08:00:00.000Z",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(invalidWindow.response.status, 400);
  assert.match(String(invalidWindow.result.error), /must be after/);
  const invalidPriority = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    title: "Invalid priority",
    area: "Carmen",
    details: "This advisory uses an unsupported priority.",
    priority: "Immediate",
    channels: ["sms"],
  }, cepalcoToken);
  assert.equal(invalidPriority.response.status, 400);
  assert.match(String(invalidPriority.result.error), /valid advisory priority/);
  const scheduledPublic = await jsonRequest(`${residentApi}/advisories`);
  const scheduledId = Number(scheduled.result.id);
  const scheduledReference = String(scheduled.result.reference);
  assert.ok(!(scheduledPublic.result as unknown as Array<Record<string, unknown>>).some(item => item.id === scheduledId));
  const scheduledImage = await fetch(`${residentApi}/advisories/${scheduledId}/image`);
  assert.equal(scheduledImage.status, 404);
  database.prepare("UPDATE advisories SET scheduled_at = datetime('now', '-1 minute') WHERE id = ?").run(scheduledId);
  const stopScheduledWorker = startScheduledAnnouncementWorker("cepalco");
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally {
    stopScheduledWorker();
  }
  const scheduledState = database.prepare("SELECT publication_status FROM advisories WHERE id = ?").get(scheduledId) as { publication_status: string };
  assert.equal(scheduledState.publication_status, "published");
  const scheduledEmailCount = database.prepare("SELECT COUNT(*) AS count FROM email_deliveries WHERE advisory_id = ?")
    .get(scheduledId) as { count: number };
  assert.equal(scheduledEmailCount.count, 2);
  const residentId = (database.prepare("SELECT id FROM users WHERE email = ?").get("opted-in@example.test") as { id: number }).id;
  const optedOutResidentId = (database.prepare("SELECT id FROM users WHERE email = ?").get("not-opted-in@example.test") as { id: number }).id;
  const simulatedSmsRows = database.prepare("SELECT resident_id FROM sms_deliveries WHERE advisory_id = ?").all(scheduledId) as Array<{ resident_id: number }>;
  assert.deepEqual(simulatedSmsRows.map(row => row.resident_id), [residentId]);
  assert.ok(!simulatedSmsRows.some(row => row.resident_id === optedOutResidentId));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sms_deliveries WHERE advisory_id = ? AND resident_id IN (SELECT id FROM users WHERE role != 'resident')").get(scheduledId)?.count, 0);
  const residentInbox = await jsonRequest(`${residentApi}/inbox`, "GET", undefined, optedInToken);
  assert.equal(residentInbox.response.status, 200, JSON.stringify(residentInbox.result));
  assert.ok((residentInbox.result as unknown as Array<Record<string, unknown>>).some(
    item => item.reference === scheduledReference && item.status === "Simulated",
  ), JSON.stringify(residentInbox.result));
  const optedOutToken = optedOutRegistration.result.token as string;
  const optedOutInbox = await jsonRequest(`${residentApi}/inbox`, "GET", undefined, optedOutToken);
  assert.equal(optedOutInbox.response.status, 200);
  assert.deepEqual(optedOutInbox.result, []);
  const adminInbox = await jsonRequest(`${cepalcoApi}/inbox`, "GET", undefined, cepalcoToken);
  assert.equal(adminInbox.response.status, 404);
  const scheduledAdminList = await jsonRequest(`${cepalcoApi}/advisories`, "GET", undefined, cepalcoToken);
  assert.ok((scheduledAdminList.result as unknown as Array<Record<string, unknown>>).some(
    item => item.id === scheduledId && item.publicationStatus === "published" &&
      item.priority === "Urgent" &&
      item.serviceStartsAt === "2026-10-23T08:00:00.000Z" &&
      item.estimatedRestorationAt === "2026-10-23T12:00:00.000Z",
  ));
  const publishedImage = await fetch(`${residentApi}/advisories/${scheduledId}/image`);
  assert.equal(publishedImage.status, 200);
  assert.match(publishedImage.headers.get("content-type") || "", /^image\/png/);
  assert.deepEqual(Buffer.from(await publishedImage.arrayBuffer()), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const residentAdvisories = await jsonRequest(`${residentApi}/advisories`);
  assert.equal(
    (residentAdvisories.result as unknown as Array<Record<string, unknown>>).find(item => item.id === scheduledId)?.imageUrl,
    `/advisories/${scheduledId}/image`,
  );
  const residentScheduled = (residentAdvisories.result as unknown as Array<Record<string, unknown>>).find(item => item.id === scheduledId);
  assert.equal(residentScheduled?.priority, "Urgent");
  assert.equal(residentScheduled?.serviceStartsAt, "2026-10-23T08:00:00.000Z");
  assert.equal(residentScheduled?.estimatedRestorationAt, "2026-10-23T12:00:00.000Z");

  const connect = await jsonRequest(`${cepalcoApi}/email/gmail/connect`, "POST", {}, cepalcoToken);
  assert.equal(connect.response.status, 503);
  assert.match(String(connect.result.error), /GMAIL_TOKEN_ENCRYPTION_KEY/);

  const advisory = await jsonRequest(`${cepalcoApi}/advisories`, "POST", {
    title: "Power interruption notice",
    area: "Carmen",
    type: "Outage",
    details: "Full announcement text and safety information.",
    imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  }, cepalcoToken);
  assert.equal(advisory.response.status, 201);
  const delivery = advisory.result.emailDelivery as Record<string, unknown>;
  assert.equal(delivery.status, "failed");
  assert.equal(delivery.sent, 0);
  assert.equal(delivery.failed, 2);
  assert.deepEqual(
    (delivery.deliveries as Array<Record<string, unknown>>).map(item => item.recipientName).sort(),
    ["Consenting Resident", "Nonconsenting Resident"],
  );
  assert.ok((advisory.result.channels as string[]).includes("facebook"));
  assert.ok((advisory.result.channels as string[]).includes("gmail"));
  const deliveryStatus = await jsonRequest(
    `${cepalcoApi}/advisories/${advisory.result.id}/email-delivery`,
    "GET",
    undefined,
    cepalcoToken,
  );
  assert.equal(deliveryStatus.response.status, 200);
  assert.equal(deliveryStatus.result.failed, 2);
  assert.equal((deliveryStatus.result.deliveries as Array<Record<string, unknown>>).length, 2);
  const retry = await jsonRequest(
    `${cepalcoApi}/advisories/${advisory.result.id}/email-delivery/retry`,
    "POST",
    {},
    cepalcoToken,
  );
  assert.equal(retry.response.status, 200);
  assert.equal(retry.result.failed, 2);
  assert.ok((retry.result.deliveries as Array<Record<string, unknown>>).every(item => item.attempts === 2));

  const latestResidentAdvisories = await jsonRequest(`${residentApi}/advisories`);
  const listed = latestResidentAdvisories.result as unknown as Array<Record<string, unknown>>;
  assert.ok(listed.some(item => item.id === advisory.result.id));
  const unauthenticatedDelivery = await jsonRequest(`${cepalcoApi}/advisories/${advisory.result.id}/email-delivery`);
  assert.equal(unauthenticatedDelivery.response.status, 401);

  const waterLogin = await jsonRequest(`${waterApi}/auth/login`, "POST", {
    email: "admin@waterdistrict.local",
    password: "DemoPass123!",
  });
  assert.equal(waterLogin.response.status, 200);
  const crossUtilityUpdate = await jsonRequest(
    `${waterApi}/advisories/${advisory.result.id}/status`,
    "PATCH",
    { status: "Resolved" },
    waterLogin.result.token as string,
  );
  assert.equal(crossUtilityUpdate.response.status, 404);
});
