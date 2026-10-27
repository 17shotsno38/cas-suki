import { test, expect } from '@playwright/test';

test.describe('Deep Diagnostics & Problem Detection', () => {
  const issues: Array<{ category: string; severity: 'CRITICAL' | 'WARNING' | 'INFO'; portal: string; details: string }> = [];

  test('Security & API Boundary Check across all 3 backend ports', async ({ request }) => {
    // 1. Unauthenticated requests to protected endpoints
    const resAuthMe = await request.get('http://localhost:4101/auth/me');
    if (resAuthMe.status() !== 401) {
      issues.push({
        category: 'SECURITY',
        severity: 'CRITICAL',
        portal: 'Resident API (4101)',
        details: `Unauthenticated GET /auth/me returned HTTP ${resAuthMe.status()} instead of 401.`,
      });
    }

    const cepalcoAuthMe = await request.get('http://localhost:4102/auth/me');
    if (cepalcoAuthMe.status() !== 401) {
      issues.push({
        category: 'SECURITY',
        severity: 'CRITICAL',
        portal: 'CEPALCO API (4102)',
        details: `Unauthenticated GET /auth/me returned HTTP ${cepalcoAuthMe.status()} instead of 401.`,
      });
    }

    // 2. Login as Resident and try to access CEPALCO admin advisory creation
    const regRes = await request.post('http://localhost:4101/auth/register', {
      data: {
        name: 'Attacker Resident',
        email: `attacker_${Date.now()}@example.com`,
        password: 'Password123!',
        phoneNumber: '09123456789',
        address: '123 Fake St',
        barangay: 'Carmen',
        district: '1st District',
        city: 'Cagayan de Oro City',
        postalCode: '9000',
        termsAccepted: true,
      },
    });

    const regData = await regRes.json();
    const residentToken = regData.token;

    const crossPost = await request.post('http://localhost:4102/advisories', {
      headers: { Authorization: `Bearer ${residentToken}` },
      data: {
        title: 'Hacked advisory',
        area: 'Carmen',
        details: 'Exploit test',
        channels: ['gmail'],
      },
    });

    if (crossPost.status() !== 401 && crossPost.status() !== 403) {
      issues.push({
        category: 'SECURITY',
        severity: 'CRITICAL',
        portal: 'Cross-Portal Authorization',
        details: `Resident token was allowed or not properly rejected when calling CEPALCO POST /advisories (HTTP ${crossPost.status()}).`,
      });
    }

    // 3. CEPALCO admin token attempting to modify Water District advisory
    const cepalcoLogin = await request.post('http://localhost:4102/auth/login', {
      data: { email: 'admin@cepalco.local', password: 'DemoPass123!' },
    });
    const cepalcoToken = (await cepalcoLogin.json()).token;

    // Water District advisory update attempt with CEPALCO token
    const crossPatch = await request.patch('http://localhost:4103/advisories/1/status', {
      headers: { Authorization: `Bearer ${cepalcoToken}` },
      data: { status: 'Resolved' },
    });

    if (crossPatch.status() !== 401 && crossPatch.status() !== 403 && crossPatch.status() !== 404) {
      issues.push({
        category: 'SECURITY',
        severity: 'CRITICAL',
        portal: 'Utility Isolation',
        details: `CEPALCO token unexpectedly modified Water District advisory (HTTP ${crossPatch.status()}).`,
      });
    }
  });

  test('Check Environment & Integration Status (Google Maps, Gmail, Social)', async ({ page, request }) => {
    // 1. Gmail status on CEPALCO and Water APIs
    const cepalcoLogin = await request.post('http://localhost:4102/auth/login', {
      data: { email: 'admin@cepalco.local', password: 'DemoPass123!' },
    });
    const cepalcoToken = (await cepalcoLogin.json()).token;

    const gmailStatus = await request.get('http://localhost:4102/email/gmail/status', {
      headers: { Authorization: `Bearer ${cepalcoToken}` },
    });
    const gmailData = await gmailStatus.json();
    if (!gmailData.connected) {
      issues.push({
        category: 'INTEGRATION',
        severity: 'WARNING',
        portal: 'CEPALCO API',
        details: `Official Gmail account is not connected (${gmailData.connectionError || 'No connection record'}). Real email alerts cannot be dispatched.`,
      });
    }

    // 2. Social media publishing status
    const socialStatus = await request.get('http://localhost:4102/social/status', {
      headers: { Authorization: `Bearer ${cepalcoToken}` },
    });
    const socialData = await socialStatus.json();
    if (!socialData.facebook) {
      issues.push({
        category: 'INTEGRATION',
        severity: 'INFO',
        portal: 'CEPALCO API',
        details: 'Facebook page publishing is not configured (META_FACEBOOK_PAGE_ID / ACCESS_TOKEN missing).',
      });
    }
    if (!socialData.instagram) {
      issues.push({
        category: 'INTEGRATION',
        severity: 'INFO',
        portal: 'CEPALCO API',
        details: 'Instagram publishing is not configured (META_INSTAGRAM_BUSINESS_ACCOUNT_ID / META_PUBLIC_BASE_URL missing).',
      });
    }

    // 3. Google Maps API key verification on frontends
    await page.goto('http://localhost:5174');
    await page.fill('input[name="email"]', 'admin@cepalco.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    await page.locator('.portal-sidebar button:has-text("Restoration map")').click();
    const mapErrorAlert = page.locator('[role="alert"]:has-text("Google Maps")');
    if (await mapErrorAlert.isVisible()) {
      const errorText = await mapErrorAlert.innerText();
      issues.push({
        category: 'CONFIGURATION',
        severity: 'WARNING',
        portal: 'Frontend Maps',
        details: `Google Maps key is missing or invalid: "${errorText}"`,
      });
    }
  });

  test('Check UI and Feature Completeness (e.g. CEPALCO Report Status Updates)', async ({ page }) => {
    // Log into CEPALCO and inspect Resident reports
    await page.goto('http://localhost:5174');
    await page.fill('input[name="email"]', 'admin@cepalco.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    await page.locator('.portal-sidebar button:has-text("Resident reports")').click();

    // Check if report status update button exists or if reports are read-only
    const updateButtons = page.locator('button:has-text("Under investigation"), button:has-text("Crew dispatched"), button:has-text("Resolved"), button:has-text("Update status")');
    const updateButtonCount = await updateButtons.count();
    if (updateButtonCount === 0) {
      issues.push({
        category: 'UI_FEATURE_DEFECT',
        severity: 'WARNING',
        portal: 'CEPALCO Portal',
        details: 'CEPALCO Admin "Resident reports" view lacks interactive status update buttons. In PortalApp.tsx, updateReportStatus is restricted to portal === "water", leaving CEPALCO reports read-only in the UI even though the backend supports PATCH /reports/:id/status.',
      });
    }
  });

  test.afterAll(() => {
    console.log('\n======================================================');
    console.log('              PLAYWRIGHT DIAGNOSTIC FINDINGS           ');
    console.log('======================================================');
    for (const issue of issues) {
      console.log(`[${issue.severity}] [${issue.category}] (${issue.portal}): ${issue.details}`);
    }
    console.log('======================================================\n');
  });
});
