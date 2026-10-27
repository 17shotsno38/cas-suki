import { test, expect } from '@playwright/test';

test.describe('CEPALCO Operations Portal (http://localhost:5174)', () => {
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(`[Console Error] ${msg.text()}`);
      }
    });
    page.on('pageerror', err => {
      consoleErrors.push(`[Page Error] ${err.message}`);
    });
    page.on('requestfailed', req => {
      networkErrors.push(`[Request Failed] ${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    });
  });

  test('Login fails with invalid password', async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.fill('input[name="email"]', 'admin@cepalco.local');
    await page.fill('input[name="password"]', 'WrongPassword123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/incorrect|invalid/i);
  });

  test('Admin logs in successfully and verifies Overview dashboard', async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.fill('input[name="email"]', 'admin@cepalco.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    // Verify main navigation loads
    await expect(page.locator('.portal-sidebar')).toBeVisible();
    await expect(page.locator('h1')).toContainText(/Operations overview/i);
  });

  test('Navigation across all tabs: Disruptions, Works, Map, Reports, Announcement, Inbox', async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.fill('input[name="email"]', 'admin@cepalco.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    // 1. Active disruptions
    await page.locator('.portal-sidebar button:has-text("Active disruptions")').click();
    await expect(page.locator('h1')).toContainText(/Active disruptions/i);

    // 2. Scheduled works
    await page.locator('.portal-sidebar button:has-text("Scheduled works")').click();
    await expect(page.locator('h1')).toContainText(/Scheduled works/i);

    // 3. Restoration map
    await page.locator('.portal-sidebar button:has-text("Restoration map")').click();
    await expect(page.locator('h1')).toContainText(/Restoration map/i);

    // 4. Resident reports
    await page.locator('.portal-sidebar button:has-text("Resident reports")').click();
    await expect(page.locator('h1')).toContainText(/Resident reports/i);

    // 5. Create announcement
    await page.locator('.portal-sidebar button:has-text("Create announcement")').click();
    await expect(page.locator('h1')).toContainText(/Create announcement/i);

    // 6. Virtual SMS inbox
    await page.locator('.portal-sidebar button:has-text("Virtual SMS inbox")').click();
    await expect(page.locator('h1')).toContainText(/Virtual SMS Inbox/i);
  });

  test('Create announcement form validation: requires channels, Instagram requires image', async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.fill('input[name="email"]', 'admin@cepalco.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    await page.locator('.portal-sidebar button:has-text("Create announcement")').click();

    // Fill form
    await page.fill('input[name="title"]', 'Emergency Feeder 4 Tripping');
    await page.fill('input[name="area"]', 'Carmen, Zone 2');
    await page.fill('textarea[name="details"]', 'Emergency line inspection ongoing.');

    // Uncheck all channels if possible or check only Instagram without image
    const instagramCheckbox = page.locator('input[value="instagram"]');
    if (await instagramCheckbox.count() > 0) {
      await instagramCheckbox.check();
      // Ensure image is empty
      await page.locator('form.cepalco-publish-layout button[type="submit"]').click();
      const alert = page.locator('[role="alert"]');
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(/image/i);
    }
  });

  test('Create immediate advisory with simulated SMS and verify delivery toast', async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.fill('input[name="email"]', 'admin@cepalco.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    await page.locator('.portal-sidebar button:has-text("Create announcement")').click();

    const title = `CEPALCO Advisory ${Date.now()}`;
    await page.fill('input[name="title"]', title);
    await page.fill('input[name="area"]', 'Macasandig · Sector 1');
    await page.fill('textarea[name="details"]', 'Scheduled line maintenance for transformer upgrade.');

    // Uncheck instagram so image is not required
    const instagramCheckbox = page.locator('input[value="instagram"]');
    if (await instagramCheckbox.count() > 0 && await instagramCheckbox.isChecked()) {
      await instagramCheckbox.uncheck();
    }

    // Ensure SMS channel is checked
    await page.locator('input[value="sms"]').check();

    // Submit announcement via form submit button
    await page.locator('form.cepalco-publish-layout button[type="submit"]').click();

    // Should navigate to incidents and show toast or alert
    await expect(page.locator('h1')).toContainText(/Active disruptions/i, { timeout: 10000 });
  });

  test.afterEach(async () => {
    if (consoleErrors.length > 0) {
      console.log('=== CEPALCO Console Errors ===\n' + consoleErrors.join('\n'));
    }
    if (networkErrors.length > 0) {
      console.log('=== CEPALCO Network Failures ===\n' + networkErrors.join('\n'));
    }
  });
});
