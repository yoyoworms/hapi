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

    test('does not repaint provisional native voice input during unrelated renders', async ({ page }) => {
        const editor = await openComposer(page, 'native')
        await editor.click()

        // iOS/third-party dictation mutates a provisional range before it has
        // committed the replacement to application state. Repainting a
        // controlled value here destroys that range and duplicates the prefix
        // when the recognizer refines it.
        await page.evaluate(() => {
            const input = document.querySelector<HTMLTextAreaElement>('textarea[name="input"]')!
            input.value = '在'
            input.setSelectionRange(1, 1)
            window.__composerImeE2E?.rerender()
        })

        await expect(editor).toHaveValue('在')
        await expect(editor).toBeFocused()
    })

    test('accepts successive native voice replacement values without duplicating the prefix', async ({ page }) => {
        const editor = await openComposer(page, 'native')
        await editor.click()

        await page.evaluate(() => {
            const input = document.querySelector<HTMLTextAreaElement>('textarea[name="input"]')!
            const replace = (value: string, inputType: string) => {
                input.value = value
                input.setSelectionRange(value.length, value.length)
                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType,
                    data: value,
                }))
                window.__composerImeE2E?.rerender()
            }
            replace('在', 'insertText')
            replace('在输入', 'insertReplacementText')
            replace('在输入框里', 'insertReplacementText')
        })

        await expect(editor).toHaveValue('在输入框里')
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

            await page.getByRole('button', { name: 'Send', exact: true }).click()

            await expect(editor).toBeFocused()
            await expect(editor).toBeEditable()
        })
    }
})
