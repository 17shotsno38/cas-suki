import { test, expect } from '@playwright/test';

test.describe('Resident Portal (http://localhost:5173)', () => {
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

  test('Page loads and shows branding, navigation, and auth forms', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await expect(page).toHaveTitle(/CivicAlert|Resident/i);

    // Verify brand
    const brand = page.locator('header a');
    await expect(brand).toBeVisible();

    // Verify sign in form fields
    const emailInput = page.locator('input[name="email"]');
    const passwordInput = page.locator('input[name="password"]');
    const submitButton = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Access")');

    await expect(emailInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(submitButton.first()).toBeVisible();
  });

  test('Sign in fails with invalid credentials and displays error alert', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.fill('input[name="email"]', 'wrong-resident@example.com');
    await page.fill('input[name="password"]', 'WrongPassword123!');
    await page.click('button:has-text("Access"), button:has-text("Sign in")');

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/incorrect|invalid/i);
  });

  test('Registration validation works: password mismatch & successful registration', async ({ page }) => {
    await page.goto('http://localhost:5173');

    // Switch to register mode
    const registerBtn = page.locator('button:has-text("Register"), button:has-text("Create an account")').first();
    await registerBtn.click();

    // Check register form fields
    await expect(page.locator('input[name="name"]')).toBeVisible();
    await expect(page.locator('input[name="phoneNumber"]')).toBeVisible();
    await expect(page.locator('input[name="address"]')).toBeVisible();
    await expect(page.locator('input[name="barangay"]')).toBeVisible();

    const uniqueEmail = `testresident_${Date.now()}@example.com`;

    // Fill form with mismatched passwords
    await page.fill('input[name="name"]', 'Juan Dela Cruz');
    await page.fill('input[name="phoneNumber"]', '09171234567');
    await page.fill('input[name="email"]', uniqueEmail);
    await page.fill('input[name="address"]', 'Zone 2, Balulang');
    await page.fill('input[name="barangay"]', 'Balulang');
    await page.selectOption('select[name="district"]', { index: 1 });
    await page.fill('input[name="password"]', 'Password123!');
    await page.fill('input[name="confirmPassword"]', 'MismatchPassword123!');
    await page.check('input[name="termsAccepted"]');

    await page.click('button:has-text("Complete"), button:has-text("Register"), button:has-text("Create")');

    // Should show password mismatch error
    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/match|password/i);

    // Fix password and submit
    await page.fill('input[name="confirmPassword"]', 'Password123!');
    await page.click('button:has-text("Complete"), button:has-text("Register"), button:has-text("Create")');

    // Should transition to dashboard
    await expect(page.locator('.portal-sidebar, header .avatar, h1').first()).toBeVisible({ timeout: 10000 });
  });

  test('Authenticated Resident can navigate tabs, filter advisories, and view inbox', async ({ page }) => {
    // Register fresh user for testing logged-in state
    await page.goto('http://localhost:5173');
    await page.locator('button:has-text("Register"), button:has-text("Create an account")').first().click();

    const uniqueEmail = `flowresident_${Date.now()}@example.com`;
    await page.fill('input[name="name"]', 'Maria Santos');
    await page.fill('input[name="phoneNumber"]', '09189876543');
    await page.fill('input[name="email"]', uniqueEmail);
    await page.fill('input[name="address"]', 'Carmen Valley');
    await page.fill('input[name="barangay"]', 'Carmen');
    await page.selectOption('select[name="district"]', { index: 1 });
    await page.fill('input[name="password"]', 'Password123!');
    await page.fill('input[name="confirmPassword"]', 'Password123!');
    await page.check('input[name="termsAccepted"]');
    await page.check('input[name="smsAlerts"]');

    await page.click('button:has-text("Complete"), button:has-text("Register"), button:has-text("Create")');

    // Verify Overview page loaded
    await expect(page.locator('h1')).toContainText(/Maria|Good day|community/i);

    // Navigate to Local advisories
    const advisoriesNav = page.locator('.portal-sidebar button:has-text("Local advisories")');
    await advisoriesNav.click();
    await expect(page.locator('h1')).toContainText(/Local advisories/i);

    // Test quick filter buttons
    const filterButtons = page.locator('button:has-text("CEPALCO"), button:has-text("Water District")');
    if (await filterButtons.count() > 0) {
      await filterButtons.first().click();
    }

    // Navigate to Utility services
    const servicesNav = page.locator('.portal-sidebar button:has-text("Utility services")');
    await servicesNav.click();
    await expect(page.locator('h1')).toContainText(/Utility services/i);

    // Navigate to Profile & settings
    const profileNav = page.locator('.portal-sidebar button:has-text("Profile & settings")');
    await profileNav.click();
    await expect(page.locator('h1')).toContainText(/Profile/i);

    // Edit profile field and save
    await page.fill('input[name="address"]', 'Updated Address St.');
    await page.click('button:has-text("Save Profile Changes")');

    // Navigate to Virtual SMS inbox
    const inboxNav = page.locator('.portal-sidebar button:has-text("Virtual SMS inbox")');
    await inboxNav.click();
    await expect(page.locator('h1')).toContainText(/Virtual SMS Inbox/i);

    // Sign out
    const signOutBtn = page.locator('.portal-sidebar button:has-text("Sign out")');
    await signOutBtn.click();
    await expect(page.locator('input[name="email"]')).toBeVisible();
  });

  test.afterEach(async () => {
    // Print diagnostic errors found during execution
    if (consoleErrors.length > 0) {
      console.log('=== Resident Portal Console Errors ===\n' + consoleErrors.join('\n'));
    }
    if (networkErrors.length > 0) {
      console.log('=== Resident Portal Network Failures ===\n' + networkErrors.join('\n'));
    }
  });
});
