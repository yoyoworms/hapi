import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        useThreadComposerAttachment: () => ({
            name: 'a-very-long-mobile-screenshot-filename.png',
            status: { type: 'incomplete' },
        }),
        AttachmentPrimitive: {
            Root: ({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
                <div data-testid="attachment-root" {...props}>{children}</div>
            ),
            Remove: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
                <button type="button" {...props}>{children}</button>
            ),
        },
    }
})

import { AttachmentItem } from './AttachmentItem'

describe('AttachmentItem mobile sizing', () => {
    it('allows the chip and filename to shrink while keeping failure details accessible', () => {
        render(<AttachmentItem />)

        expect(screen.getByTestId('attachment-root')).toHaveClass('min-w-0', 'max-w-full')
        expect(screen.getByText('a-very-long-mobile-screenshot-filename.png')).toHaveClass(
            'min-w-0',
            'flex-1',
            'truncate',
        )
        expect(screen.getByLabelText('Upload failed')).toHaveAttribute('title', 'Upload failed')
        expect(screen.getByText('Upload failed')).toHaveClass('hidden', 'sm:inline')
        expect(screen.getByRole('button', { name: 'Remove attachment' })).toHaveClass('shrink-0')
    })
})
