import { test, expect } from '@playwright/test';
import { initializeVault } from './helpers';

test.describe('Extension Recovery Flow - Revoked Device', () => {
  test('successfully initializes, migrates, handles failures, and reconnects', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/popup.html');

    await initializeVault(page);

    const emptyHelper = page.locator('text=点击加号按钮添加您的第一个身份验证验证码。');
    await expect(emptyHelper).toBeVisible();
    const helperBox = await emptyHelper.boundingBox();
    if (!helperBox) {
      throw new Error('Could not get bounding box for empty helper');
    }
    expect(helperBox.height).toBeLessThanOrEqual(20);

    await page.evaluate(() => {
      const legacyConfig = {
        baseUrl: 'http://127.0.0.1:1',
        username: 'admin',
        token: 'legacy-plaintext-token-xyz',
        deviceId: 'aa950ec8-5625-4a44-9768-771b3435e9a4',
        deviceLabel: '我的浏览器',
        syncStatus: 'synced'
      };
      localStorage.setItem('remoteConfig', JSON.stringify(legacyConfig));
      localStorage.setItem('lastSyncSeq', '42');
      localStorage.setItem('lastSyncTime', '"2026-07-22T04:25:41.310Z"');
    });

    await page.reload();

    const unlockBtn = page.locator('button:has-text("解锁保管库")');
    await expect(unlockBtn).toBeVisible();

    await page.locator('input[type="password"]').fill('Password123');
    await unlockBtn.click();

    const lockBtn = page.locator('button[title="锁定保管库"]');
    await expect(lockBtn).toBeVisible();

    // Intercept to simulate network failure initially
    await page.route('**/v1/sync/vault', async (route) => {
      await route.abort('failed');
    });

    await page.click('button:has-text("同步")');

    const syncBtn = page.locator('button:has-text("立即同步保管库")');
    await expect(syncBtn).toBeVisible();

    await syncBtn.click();

    const errorTextEl = page.locator('text=网络连接失败，请检查服务器地址');
    await expect(errorTextEl).toBeVisible();

    const tokenResult = await page.evaluate(() => {
      const str = localStorage.getItem('remoteConfig');
      if (!str) return { hasToken: false, hasCiphertext: false, hasIv: false, syncStatus: '' };
      try {
        const obj: unknown = JSON.parse(str);
        const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
        if (!isRecord(obj)) {
          throw new Error('remoteConfig is not a valid JSON record');
        }
        return {
          hasToken: 'token' in obj,
          hasCiphertext: typeof obj.tokenCiphertext === 'string',
          hasIv: typeof obj.tokenIv === 'string',
          syncStatus: String(obj.syncStatus || '')
        };
      } catch (err) {
        if (err instanceof Error) {
          throw err;
        }
        throw new Error('Failed to parse remoteConfig');
      }
    });
    expect(tokenResult.hasToken).toBe(false);
    expect(tokenResult.hasCiphertext).toBe(true);
    expect(tokenResult.hasIv).toBe(true);
    expect(tokenResult.syncStatus).toBe('failed');

    // Setup mock intercept to return 401 session revoked on next sync
    await page.unroute('**/v1/sync/vault');
    await page.route('**/v1/sync/vault', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'auth.session_revoked',
          message: 'Session revoked'
        })
      });
    });

    await syncBtn.click();

    // Verify revoked layout transitions automatically
    const reconnectBtn = page.locator('button:has-text("重新连接设备")');
    await expect(reconnectBtn).toBeVisible();

    const disconnectBtn = page.locator('button:has-text("断开连接")');
    const disconnectBox = await disconnectBtn.boundingBox();
    const reconnectBox = await reconnectBtn.boundingBox();

    if (!disconnectBox || !reconnectBox) {
      throw new Error('Bounding boxes for recovery buttons are missing');
    }
    expect(disconnectBox.height).toBeGreaterThanOrEqual(44);
    expect(disconnectBox.width).toBeGreaterThanOrEqual(44);
    expect(reconnectBox.height).toBeGreaterThanOrEqual(44);
    expect(reconnectBox.width).toBeGreaterThanOrEqual(44);

    await reconnectBtn.click();

    const urlInput = page.locator('input[type="url"]');
    await expect(urlInput).toBeFocused();
    await expect(urlInput).toHaveValue('http://127.0.0.1:1');

    const storageResult = await page.evaluate(() => {
      const remoteConfig = localStorage.getItem('remoteConfig');
      const vaultEnvelope = localStorage.getItem('vaultEnvelope');
      const lastSyncSeq = localStorage.getItem('lastSyncSeq');
      const lastSyncTime = localStorage.getItem('lastSyncTime');
      const activeEl = document.activeElement;
      return {
        remoteConfigAbsent: remoteConfig === null,
        vaultEnvelopePresent: vaultEnvelope !== null,
        lastSyncSeq: lastSyncSeq || '',
        lastSyncTime: lastSyncTime || '',
        isInput: activeEl instanceof HTMLInputElement,
        activeTagName: activeEl ? activeEl.tagName : ''
      };
    });
    expect(storageResult.remoteConfigAbsent).toBe(true);
    expect(storageResult.vaultEnvelopePresent).toBe(true);
    expect(storageResult.lastSyncSeq).toBe('42');
    expect(storageResult.lastSyncTime).toBe('"2026-07-22T04:25:41.310Z"');
    expect(storageResult.isInput).toBe(true);
    expect(storageResult.activeTagName).toBe('INPUT');

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > 320;
    });
    expect(hasHorizontalScroll).toBe(false);

    await page.screenshot({ path: testInfo.outputPath('recovery-flow-320.png') });
  });
});
