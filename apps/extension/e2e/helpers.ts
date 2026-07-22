import { type Page, expect } from '@playwright/test';

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function initializeVault(page: Page): Promise<void> {
  const initBtn = page.locator('button:has-text("初始化保管库")');
  await expect(initBtn).toBeVisible();

  await page.locator('input').first().fill('Password123');
  await page.locator('input').nth(1).fill('Password123');
  await initBtn.click();

  const lockBtn = page.locator('button[title="锁定保管库"]');
  await expect(lockBtn).toBeVisible();
}

export async function unlockVault(page: Page): Promise<void> {
  const unlockBtn = page.locator('button:has-text("解锁保管库")');
  await expect(unlockBtn).toBeVisible();

  await page.locator('input[type="password"]').fill('Password123');
  await unlockBtn.click();

  const lockBtn = page.locator('button[title="锁定保管库"]');
  await expect(lockBtn).toBeVisible();
}
