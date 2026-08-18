import { expect, test, type Page } from '@playwright/test'

async function openComposer(page: Page, mode: 'native' | 'rich') {
    await page.goto('/e2e-fixtures/composer-ime-fixture.html')
    await page.evaluate((nextMode) => {
        localStorage.setItem('hapi.composer.richMentions', nextMode === 'rich' ? '1' : '0')
    }, mode)
    await page.reload()
    return mode === 'rich'
        ? page.getByTestId('rich-composer-input')
        : page.locator('textarea[name="input"]')
}

test.describe('composer IME focus lifecycle', () => {
    test('uses the native textarea compatibility editor by default', async ({ page }) => {
        await page.goto('/e2e-fixtures/composer-ime-fixture.html')
        await page.evaluate(() => localStorage.removeItem('hapi.composer.richMentions'))
        await page.reload()

        await expect(page.locator('textarea[name="input"]')).toBeVisible()
        await expect(page.getByTestId('rich-composer-input')).toHaveCount(0)
    })

    for (const mode of ['native', 'rich'] as const) {
        test(`keeps the ${mode} input focused across a pending send and resumes editing`, async ({ page }) => {
            const editor = await openComposer(page, mode)
            await editor.click()
            await editor.fill('first draft')

            await page.evaluate(() => window.__composerImeE2E?.setPending(true))
            await expect(editor).toBeFocused()
            if (mode === 'native') {
                await expect(editor).not.toBeEditable()
            } else {
                await expect(editor).toHaveAttribute('aria-readonly', 'true')
                await expect(editor).not.toHaveAttribute('contenteditable', 'false')
            }

            await page.evaluate(() => window.__composerImeE2E?.setPending(false))
            await expect(editor).toBeFocused()
            await expect(editor).toBeEditable()
            await page.keyboard.type(' continues')
            if (mode === 'native') {
                await expect(editor).toHaveValue('first draft continues')
            } else {
                await expect(editor).toHaveText('first draft continues')
            }
        })
    }

    for (const mode of ['native', 'rich'] as const) {
        test(`pointer-send preserves the ${mode} editor as the focused IME client`, async ({ page }) => {
            const editor = await openComposer(page, mode)
            await editor.click()
            await editor.fill('send this')

            await page.getByRole('button', { name: 'Send' }).click()

            await expect(editor).toBeFocused()
            await expect(editor).toBeEditable()
        })
    }
})
