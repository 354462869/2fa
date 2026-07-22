import { test, expect } from '@playwright/test';
import { initializeVault } from './helpers';

test.describe('Account Card Hover Details Tooltip', () => {
  test('should display, follow pointer, stay within viewport, and hide on pointer leave', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/popup.html');

    await initializeVault(page);

    await page.locator('button[title="添加账户"]').click();

    await page.locator('input[placeholder="例如 GitHub"]').fill('MyTestIssuer');
    await page.locator('input[placeholder="例如 user@email.com"]').fill('mytestaccount');

    await page.locator('textarea[placeholder="其他备注说明..."]').fill('This is a test remark\nwith multiple lines.');

    await page.locator('button:has-text("保存")').click();

    const card = page.getByTestId('account-card').first();
    await expect(card).toBeVisible();

    const cardBox = await card.boundingBox();
    if (!cardBox) {
      throw new Error('Card bounding box not found');
    }

    const tooltip = page.locator('[role="tooltip"]');
    await expect(tooltip).not.toBeVisible();

    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.waitForTimeout(400);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(700);
    await expect(tooltip).not.toBeVisible();

    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.waitForTimeout(500);

    await expect(tooltip).not.toBeVisible();

    await page.waitForTimeout(600);
    await expect(tooltip).toBeVisible();

    await expect(tooltip).toContainText('备注');
    await expect(tooltip).toContainText('This is a test remark');
    await expect(tooltip).toContainText('with multiple lines.');
    await expect(tooltip).toContainText('创建至今');
    await expect(tooltip).toContainText('0天');

    const firstTooltipBox = await tooltip.boundingBox();
    if (!firstTooltipBox) {
      throw new Error('Tooltip bounding box not found after hover');
    }

    await page.mouse.move(cardBox.x + 24, cardBox.y + cardBox.height / 2 + 10);
    await page.waitForTimeout(100);

    const secondTooltipBox = await tooltip.boundingBox();
    if (!secondTooltipBox) {
      throw new Error('Tooltip bounding box not found after mouse move');
    }

    expect(secondTooltipBox.x).not.toBe(firstTooltipBox.x);

    expect(secondTooltipBox.x).toBeGreaterThanOrEqual(0);
    expect(secondTooltipBox.x + secondTooltipBox.width).toBeLessThanOrEqual(320);
    expect(secondTooltipBox.y).toBeGreaterThanOrEqual(0);
    expect(secondTooltipBox.y + secondTooltipBox.height).toBeLessThanOrEqual(720);

    const overlapsCard = secondTooltipBox.x < cardBox.x + cardBox.width
      && secondTooltipBox.x + secondTooltipBox.width > cardBox.x
      && secondTooltipBox.y < cardBox.y + cardBox.height
      && secondTooltipBox.y + secondTooltipBox.height > cardBox.y;
    expect(overlapsCard).toBe(false);

    await page.mouse.move(cardBox.x + cardBox.width / 2 - 20, cardBox.y + cardBox.height / 2);
    await page.waitForTimeout(100);
    const beforeResizeTooltipBox = await tooltip.boundingBox();
    if (!beforeResizeTooltipBox) {
      throw new Error('Tooltip bounding box not found before viewport resize');
    }
    await page.setViewportSize({ width: 400, height: 720 });
    await expect.poll(async () => {
      const resizedTooltipBox = await tooltip.boundingBox();
      const resizedCardBox = await card.boundingBox();
      if (!resizedTooltipBox || !resizedCardBox) return false;
      const overlapsResizedCard = resizedTooltipBox.x < resizedCardBox.x + resizedCardBox.width
        && resizedTooltipBox.x + resizedTooltipBox.width > resizedCardBox.x
        && resizedTooltipBox.y < resizedCardBox.y + resizedCardBox.height
        && resizedTooltipBox.y + resizedTooltipBox.height > resizedCardBox.y;
      return !overlapsResizedCard
        && resizedTooltipBox.x !== beforeResizeTooltipBox.x
        && resizedTooltipBox.x >= 0
        && resizedTooltipBox.x + resizedTooltipBox.width <= 400
        && resizedTooltipBox.y >= 0
        && resizedTooltipBox.y + resizedTooltipBox.height <= 720;
    }).toBe(true);
    await page.setViewportSize({ width: 320, height: 720 });

    await page.mouse.move(0, 0);
    await expect(tooltip).not.toBeVisible();

    await page.setViewportSize({ width: 320, height: 260 });
    await card.hover();
    await expect(tooltip).toBeVisible({ timeout: 2000 });
    const shortTooltipBox = await tooltip.boundingBox();
    const shortCardBox = await card.boundingBox();
    if (!shortTooltipBox || !shortCardBox) {
      throw new Error('Tooltip or card bounding box not found in short viewport');
    }
    const overlapsShortCard = shortTooltipBox.x < shortCardBox.x + shortCardBox.width
      && shortTooltipBox.x + shortTooltipBox.width > shortCardBox.x
      && shortTooltipBox.y < shortCardBox.y + shortCardBox.height
      && shortTooltipBox.y + shortTooltipBox.height > shortCardBox.y;
    expect(overlapsShortCard).toBe(false);
    expect(shortTooltipBox.x).toBeGreaterThanOrEqual(0);
    expect(shortTooltipBox.x + shortTooltipBox.width).toBeLessThanOrEqual(320);
    expect(shortTooltipBox.y).toBeGreaterThanOrEqual(0);
    expect(shortTooltipBox.y + shortTooltipBox.height).toBeLessThanOrEqual(260);

    await page.mouse.move(0, 0);
    await expect(tooltip).not.toBeVisible();
    await page.setViewportSize({ width: 320, height: 720 });

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > 320;
    });
    expect(hasHorizontalScroll).toBe(false);
  });
});
