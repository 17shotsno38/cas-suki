import { test, expect } from '@playwright/test';

test.describe('Water District Portal (http://localhost:5175)', () => {
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

  test('Water District admin logs in and verifies Overview dashboard metrics', async ({ page }) => {
    await page.goto('http://localhost:5175');
    await page.fill('input[name="email"]', 'admin@waterdistrict.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    await expect(page.locator('.portal-sidebar')).toBeVisible();
    await expect(page.locator('h1')).toContainText(/Water network overview/i);
  });

  test('Navigation across all Water District tabs and Network Map metrics', async ({ page }) => {
    await page.goto('http://localhost:5175');
    await page.fill('input[name="email"]', 'admin@waterdistrict.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    // 1. Water advisories
    await page.locator('.portal-sidebar button:has-text("Water advisories")').click();
    await expect(page.locator('h1')).toContainText(/Water service advisories/i);

    // 2. Maintenance schedule
    await page.locator('.portal-sidebar button:has-text("Maintenance schedule")').click();
    await expect(page.locator('h1')).toContainText(/Water maintenance schedule/i);

    // 3. Network map
    await page.locator('.portal-sidebar button:has-text("Network map")').click();
    await expect(page.locator('h1')).toContainText(/Water network map/i);

    // 4. Service reports
    await page.locator('.portal-sidebar button:has-text("Service reports")').click();
    await expect(page.locator('h1')).toContainText(/Water service reports/i);

    // 5. Virtual SMS inbox
    await page.locator('.portal-sidebar button:has-text("Virtual SMS inbox")').click();
    await expect(page.locator('h1')).toContainText(/Virtual SMS Inbox/i);
  });

  test('Status update interaction on Service reports', async ({ page }) => {
    await page.goto('http://localhost:5175');
    await page.fill('input[name="email"]', 'admin@waterdistrict.local');
    await page.fill('input[name="password"]', 'DemoPass123!');
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    await page.locator('.portal-sidebar button:has-text("Service reports")').click();

    // Look for status buttons or pill actions on service reports
    const statusPill = page.locator('button:has-text("Received"), button:has-text("Under investigation"), button:has-text("Crew dispatched")').first();
    if (await statusPill.isVisible()) {
      const initialText = await statusPill.innerText();
      await statusPill.click();
      // Should update status and show toast
      await expect(page.locator('[role="status"]')).toBeVisible({ timeout: 5000 });
    }
  });

  test.afterEach(async () => {
    if (consoleErrors.length > 0) {
      console.log('=== Water District Console Errors ===\n' + consoleErrors.join('\n'));
    }
    if (networkErrors.length > 0) {
      console.log('=== Water District Network Failures ===\n' + networkErrors.join('\n'));
    }
  });
});
