import { test, expect } from '@playwright/test';

test.describe('Extension Recovery Flow - Expired Session Re-Login', () => {
  test('handles session expiration re-login and successful synchronization', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/popup.html');

    // Wait for unlock or initialization page
    const unlockBtn = page.locator('button:has-text("解锁保管库")');
    const isLockVisible = await unlockBtn.isVisible();

    if (!isLockVisible) {
      const initBtn = page.locator('button:has-text("初始化保管库")');
      await expect(initBtn).toBeVisible();
      await page.locator('input').first().fill('Password123');
      await page.locator('input').nth(1).fill('Password123');
      await initBtn.click();
    } else {
      await page.locator('input[type="password"]').fill('Password123');
      await unlockBtn.click();
    }

    const lockBtn = page.locator('button[title="锁定保管库"]');
    await expect(lockBtn).toBeVisible();

    const envelopeStr = await page.evaluate(() => localStorage.getItem('vaultEnvelope'));
    if (!envelopeStr) {
      throw new Error('Local vaultEnvelope is missing');
    }
    const localEnvelope: unknown = JSON.parse(envelopeStr);

    await page.evaluate(() => {
      const config = {
        baseUrl: 'http://127.0.0.1:1',
        username: 'admin',
        token: 'old-expired-token-abc',
        deviceId: 'aa950ec8-5625-4a44-9768-771b3435e9a4',
        deviceLabel: '我的浏览器',
        syncStatus: 'synced'
      };
      localStorage.setItem('remoteConfig', JSON.stringify(config));
      localStorage.setItem('lastSyncSeq', '42');
      localStorage.setItem('lastSyncTime', '"2026-07-22T04:25:41.310Z"');
    });

    await page.route('**/v1/sync/vault', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'auth.session_expired',
          message: 'Session expired'
        })
      });
    });

    await page.reload();

    await page.locator('input[type="password"]').fill('Password123');
    await page.click('button:has-text("解锁保管库")');

    await page.click('button:has-text("同步")');
    const expiredHeading = page.locator('h3:has-text("同步服务器登录已过期")');
    await expect(expiredHeading).toBeVisible();

    await page.unroute('**/v1/sync/vault');
    await page.route('**/v1/auth/login', async (route) => {
      const req = route.request();
      const body: unknown = req.postDataJSON();
      const isRecordCheck = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
      if (!isRecordCheck(body)) {
        throw new Error('Login body is not a record');
      }
      expect(body.device_id).toBe('aa950ec8-5625-4a44-9768-771b3435e9a4');
      expect(body.password).toBe('AdminPassword123!');

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'new-secret-token-123'
        })
      });
    });

    await page.route('**/v1/sync/vault', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          envelope: localEnvelope,
          items_rev: 1,
          groups_rev: 1,
          accounts_rev: 1,
          relations_rev: 1
        })
      });
    });

    await page.route('**/v1/sync/pull', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [],
          groups: [],
          accounts: [],
          relations: [],
          has_more: false,
          next_seq: 42
        })
      });
    });

    await page.locator('input[id="re-login-password"]').fill('AdminPassword123!');
    await page.click('button:has-text("重新登录")');

    const successMsg = page.locator('text=重新登录并同步成功！');
    await expect(successMsg).toBeVisible();

    const storageResult = await page.evaluate(() => {
      const str = localStorage.getItem('remoteConfig');
      if (!str) return { hasToken: false, hasCiphertext: false, hasIv: false, syncStatus: '' };
      const obj: unknown = JSON.parse(str);
      const isRecordCheck = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
      if (!isRecordCheck(obj)) {
        throw new Error('remoteConfig is not a valid JSON record');
      }
      return {
        hasToken: 'token' in obj,
        hasCiphertext: typeof obj.tokenCiphertext === 'string',
        hasIv: typeof obj.tokenIv === 'string',
        syncStatus: String(obj.syncStatus || '')
      };
    });

    expect(storageResult.hasToken).toBe(false);
    expect(storageResult.hasCiphertext).toBe(true);
    expect(storageResult.hasIv).toBe(true);
    expect(storageResult.syncStatus).toBe('synced');

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > 320;
    });
    expect(hasHorizontalScroll).toBe(false);

    await page.screenshot({ path: testInfo.outputPath('re-login-flow-320.png') });
  });
});
