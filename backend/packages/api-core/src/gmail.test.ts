import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGmailAuthorizationUrl,
  createRawEmail,
  decryptRefreshToken,
  encryptRefreshToken,
  gmailConnectionFailure,
  GMAIL_SEND_SCOPE,
  parseGmailImageAttachment,
} from "./gmail.js";

test("Gmail connection errors identify actionable OAuth configuration failures", () => {
  assert.equal(gmailConnectionFailure(new Error("redirect_uri_mismatch")), "redirect_uri");
  assert.equal(gmailConnectionFailure(new Error("invalid_client")), "oauth_client");
  assert.equal(
    gmailConnectionFailure(new Error("The authorized Google account does not match the configured official utility address.")),
    "account_mismatch",
  );
  assert.equal(gmailConnectionFailure(new Error("Google did not issue a refresh token.")), "refresh_token");
  assert.equal(gmailConnectionFailure(new Error("invalid_grant")), "invalid_grant");
  assert.equal(gmailConnectionFailure(new Error("unexpected provider response")), "unknown");
});

test("Gmail authorization requests only send and identity scopes", () => {
  process.env.GMAIL_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GMAIL_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const authorization = new URL(createGmailAuthorizationUrl("cepalco", "random-state"));
  const scopes = authorization.searchParams.get("scope")?.split(" ") ?? [];
  assert.deepEqual(scopes.sort(), ["email", GMAIL_SEND_SCOPE, "openid"].sort());
  assert.equal(authorization.searchParams.get("state"), "random-state");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
});

test("Gmail refresh tokens are authenticated-encrypted at rest", () => {
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const encrypted = encryptRefreshToken("refresh-token-for-test");
  assert.notEqual(encrypted, "refresh-token-for-test");
  assert.equal(decryptRefreshToken(encrypted), "refresh-token-for-test");

  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString("base64");
  assert.throws(() => decryptRefreshToken(encrypted), /cannot be decrypted/);
});

test("Gmail message includes the full subject, notice, and social post links", () => {
  const body = "Power advisory — Carmen\n\nFull notice and safety details.\n\nSocial post links:\nFacebook: https://www.facebook.com/example/posts/123";
  const raw = createRawEmail("resident@example.test", "Power advisory — Carmen", body);
  const message = Buffer.from(raw, "base64url").toString("utf8");
  const bodyBase64 = message.split("\r\n\r\n").at(-1);
  assert.match(message, /To: resident@example\.test/);
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.equal(
    Buffer.from(bodyBase64 ?? "", "base64").toString("utf8"),
    body,
  );
  assert.throws(() => createRawEmail("bad\r\nBcc: attacker@example.test", "Subject", "Body"), /Recipient email address is invalid/);
});

test("Gmail advisory messages attach the uploaded announcement image", () => {
  const attachment = parseGmailImageAttachment("data:image/png;base64,iVBORw0KGgo=");
  assert.ok(attachment);
  const raw = createRawEmail("resident@example.test", "Service notice", "Details", attachment);
  const message = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(message, /multipart\/mixed/);
  assert.match(message, /Content-Disposition: attachment; filename="announcement\.png"/);
  assert.match(message, /iVBORw0KGgo=/);
});
