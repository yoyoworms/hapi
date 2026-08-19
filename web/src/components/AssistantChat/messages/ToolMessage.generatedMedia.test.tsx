import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import type { HappyChatContextValue } from '@/components/AssistantChat/context'
import type { GeneratedImageBlock } from '@/chat/types'
import { downloadBlobFile } from '@/lib/file-download'

vi.mock('@/lib/file-download', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/file-download')>(),
    downloadBlobFile: vi.fn(),
}))

function renderCard(options: {
    mimeType: string | null
    locale?: 'en' | 'zh-CN'
    getGeneratedImageBlob?: ReturnType<typeof vi.fn>
}) {
    if (options.locale) {
        localStorage.setItem('hapi-lang', options.locale)
    } else {
        localStorage.removeItem('hapi-lang')
    }

    const getGeneratedImageBlob = options.getGeneratedImageBlob ?? vi.fn(async () => new Blob(['x'], { type: options.mimeType ?? 'image/png' }))
    const api = { getGeneratedImageBlob } as unknown as ApiClient
    const value: HappyChatContextValue = {
        api,
        sessionId: 'session-1',
        metadata: null,
        terminalToolDisplayMode: 'compact',
        showSessionSummaryInChat: false,
        disabled: false,
        onRefresh: () => {},
        hasMoreMessages: false,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'loaded',
    }

    const initialBlock: GeneratedImageBlock = {
        kind: 'generated-image',
        id: 'block-1',
        localId: null,
        createdAt: 1,
        imageId: 'img-1',
        fileName: 'clip.mp4',
        mimeType: options.mimeType,
    }
    const renderTree = (block: GeneratedImageBlock) => (
        <I18nProvider>
            <HappyChatProvider value={value}>
                <GeneratedImageCard block={block} />
            </HappyChatProvider>
        </I18nProvider>
    )
    const rendered = render(renderTree(initialBlock))

    return {
        getGeneratedImageBlob,
        rerenderBlock: (patch: Partial<GeneratedImageBlock>) => {
            rendered.rerender(renderTree({ ...initialBlock, ...patch }))
        },
    }
}

describe('GeneratedImageCard video fetch', () => {
    beforeEach(() => {
        vi.mocked(downloadBlobFile).mockClear()
    })

    it('labels displayed images in English without implying AI generation', () => {
        renderCard({ mimeType: 'image/png', locale: 'en' })

        expect(screen.getByText('Displayed image: clip.mp4')).toBeInTheDocument()
        expect(screen.queryByText(/Generated image/)).not.toBeInTheDocument()
    })

    it('localizes the displayed image label in Chinese', () => {
        renderCard({ mimeType: 'image/png', locale: 'zh-CN' })

        expect(screen.getByText('展示图片：clip.mp4')).toBeInTheDocument()
        expect(screen.queryByText(/Generated image/)).not.toBeInTheDocument()
    })

    it('does not call the API for an untouched video card', async () => {
        const { getGeneratedImageBlob } = renderCard({ mimeType: 'video/mp4' })

        expect(screen.getByRole('button', { name: 'Load video' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Download clip.mp4' })).toBeInTheDocument()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(getGeneratedImageBlob).not.toHaveBeenCalled()
    })

    it('downloads an unloaded video through the authenticated blob API without loading the player', async () => {
        const blob = new Blob(['video'], { type: 'video/mp4' })
        const getGeneratedImageBlob = vi.fn(async () => blob)
        renderCard({ mimeType: 'video/mp4', getGeneratedImageBlob })

        fireEvent.click(screen.getByRole('button', { name: 'Download clip.mp4' }))

        await waitFor(() => {
            expect(getGeneratedImageBlob).toHaveBeenCalledWith('session-1', 'img-1')
            expect(downloadBlobFile).toHaveBeenCalledWith('clip.mp4', blob)
        })
        expect(document.querySelector('video')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Load video' })).toBeInTheDocument()
    })

    it('releases a download-only blob instead of retaining it for the life of the chat', async () => {
        const getGeneratedImageBlob = vi.fn(async () => new Blob(['video'], { type: 'video/mp4' }))
        renderCard({ mimeType: 'video/mp4', getGeneratedImageBlob })

        const downloadButton = screen.getByRole('button', { name: 'Download clip.mp4' })
        fireEvent.click(downloadButton)
        await waitFor(() => expect(downloadButton).toBeEnabled())

        fireEvent.click(downloadButton)
        await waitFor(() => expect(getGeneratedImageBlob).toHaveBeenCalledTimes(2))
    })

    it('exposes an accessible download progress state', async () => {
        let resolveBlob: ((blob: Blob) => void) | undefined
        const pendingBlob = new Promise<Blob>((resolve) => {
            resolveBlob = resolve
        })
        renderCard({
            mimeType: 'video/mp4',
            getGeneratedImageBlob: vi.fn(() => pendingBlob),
        })

        fireEvent.click(screen.getByRole('button', { name: 'Download clip.mp4' }))

        const progressButton = screen.getByRole('button', { name: 'Downloading…' })
        expect(progressButton).toBeDisabled()
        expect(progressButton).toHaveAttribute('aria-busy', 'true')

        resolveBlob?.(new Blob(['video'], { type: 'video/mp4' }))
        await waitFor(() => expect(downloadBlobFile).toHaveBeenCalled())
    })

    it('shows a localized accessible download error and keeps retry available', async () => {
        renderCard({
            mimeType: 'video/mp4',
            locale: 'zh-CN',
            getGeneratedImageBlob: vi.fn(async () => {
                throw new Error('HTTP 503')
            }),
        })

        fireEvent.click(screen.getByRole('button', { name: '下载 clip.mp4' }))

        expect(await screen.findByRole('alert')).toHaveTextContent('下载失败：HTTP 503')
        expect(screen.getByRole('button', { name: '下载 clip.mp4' })).toBeEnabled()
    })

    it('fetches the blob after the user clicks Load video', async () => {
        const { getGeneratedImageBlob } = renderCard({ mimeType: 'video/mp4' })

        fireEvent.click(screen.getByRole('button', { name: 'Load video' }))

        await waitFor(() => {
            expect(getGeneratedImageBlob).toHaveBeenCalledWith('session-1', 'img-1')
        })
    })

    it('shares one in-flight request when Load and Download are clicked together', async () => {
        let resolveBlob: ((blob: Blob) => void) | undefined
        const pendingBlob = new Promise<Blob>((resolve) => {
            resolveBlob = resolve
        })
        const getGeneratedImageBlob = vi.fn(() => pendingBlob)
        renderCard({ mimeType: 'video/mp4', getGeneratedImageBlob })

        fireEvent.click(screen.getByRole('button', { name: 'Download clip.mp4' }))
        fireEvent.click(screen.getByRole('button', { name: 'Load video' }))
        expect(getGeneratedImageBlob).toHaveBeenCalledTimes(1)

        const blob = new Blob(['video'], { type: 'video/mp4' })
        resolveBlob?.(blob)
        await waitFor(() => expect(document.querySelector('video')).toBeInTheDocument())
        expect(downloadBlobFile).toHaveBeenCalledWith('clip.mp4', blob)
        expect(getGeneratedImageBlob).toHaveBeenCalledTimes(1)
    })

    it('reuses the loaded video blob when downloading', async () => {
        const blob = new Blob(['video'], { type: 'video/mp4' })
        const getGeneratedImageBlob = vi.fn(async () => blob)
        renderCard({ mimeType: 'video/mp4', getGeneratedImageBlob })

        fireEvent.click(screen.getByRole('button', { name: 'Load video' }))
        await waitFor(() => expect(document.querySelector('video')).toBeInTheDocument())
        fireEvent.click(screen.getByRole('button', { name: 'Download clip.mp4' }))

        await waitFor(() => expect(downloadBlobFile).toHaveBeenCalledWith('clip.mp4', blob))
        expect(getGeneratedImageBlob).toHaveBeenCalledTimes(1)
    })

    it('does not reuse cached bytes when the rendered media identity changes', async () => {
        const firstBlob = new Blob(['first'], { type: 'video/mp4' })
        const secondBlob = new Blob(['second'], { type: 'video/mp4' })
        const getGeneratedImageBlob = vi.fn(async (_sessionId: string, imageId: string) => (
            imageId === 'img-1' ? firstBlob : secondBlob
        ))
        const { rerenderBlock } = renderCard({ mimeType: 'video/mp4', getGeneratedImageBlob })

        fireEvent.click(screen.getByRole('button', { name: 'Load video' }))
        await waitFor(() => expect(document.querySelector('video')).toBeInTheDocument())

        rerenderBlock({ imageId: 'img-2', fileName: 'next.mp4' })
        await waitFor(() => {
            expect(getGeneratedImageBlob).toHaveBeenCalledWith('session-1', 'img-2')
        })
        vi.mocked(downloadBlobFile).mockClear()
        fireEvent.click(screen.getByRole('button', { name: 'Download next.mp4' }))

        await waitFor(() => expect(downloadBlobFile).toHaveBeenCalledWith('next.mp4', secondBlob))
    })

    it('explains browser playback failures while keeping the download button visible', async () => {
        renderCard({ mimeType: 'video/mp4' })

        fireEvent.click(screen.getByRole('button', { name: 'Load video' }))
        const video = await waitFor(() => {
            const element = document.querySelector('video')
            expect(element).toBeInTheDocument()
            return element as HTMLVideoElement
        })
        fireEvent.error(video)

        expect(screen.getByRole('alert')).toHaveTextContent(
            'This video cannot be played in this browser. Download it to open it in another player.'
        )
        expect(screen.getByRole('button', { name: 'Download clip.mp4' })).toBeEnabled()
    })

    it('still fetches images on mount', async () => {
        const { getGeneratedImageBlob } = renderCard({ mimeType: 'image/png' })

        await waitFor(() => {
            expect(getGeneratedImageBlob).toHaveBeenCalledWith('session-1', 'img-1')
        })
    })

    it('loads audio on demand and renders controls', async () => {
        renderCard({ mimeType: 'audio/wav' })

        fireEvent.click(screen.getByRole('button', { name: 'Load audio' }))

        await waitFor(() => {
            expect(document.querySelector('audio[controls]')).toBeInTheDocument()
        })
    })

    it('loads unknown files on demand and renders a download link', async () => {
        renderCard({ mimeType: 'application/octet-stream' })

        fireEvent.click(screen.getByRole('button', { name: 'Prepare download' }))

        await waitFor(() => {
            expect(screen.getByRole('link', { name: /Download clip\.mp4/ })).toHaveAttribute('download', 'clip.mp4')
        })
    })
})
