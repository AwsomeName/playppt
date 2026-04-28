import { expect, test } from '@playwright/test';

test('首页加载并可创建会话', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'play-ppt' })).toBeVisible();
  await page.getByRole('button', { name: '创建会话 (demo)' }).click();
  await expect(page.getByText(/页\s+\d+\s+\/\s+\d+/)).toBeVisible({ timeout: 30_000 });
});
