import { describe, expect, it } from 'vitest'
import { decodeFileDownloadHref, decodeFilePathHref, remarkFilePathLinks } from '@/lib/remark-file-path-links'

type TestNode = {
    type: string
    value?: string
    url?: string
    children?: TestNode[]
}

function transform(text: string): TestNode[] {
    const tree: TestNode = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }]
    }
    remarkFilePathLinks()(tree)
    return tree.children?.[0]?.children ?? []
}

function linkedPath(node: TestNode): string | null {
    return typeof node.url === 'string' ? decodeFilePathHref(node.url) : null
}

function transformLink(url: string): TestNode {
    const link: TestNode = {
        type: 'link',
        url,
        children: [{ type: 'text', value: 'Download' }]
    }
    const tree: TestNode = {
        type: 'root',
        children: [{ type: 'paragraph', children: [link] }]
    }
    remarkFilePathLinks()(tree)
    return link
}

describe('remarkFilePathLinks', () => {
    it('links relative code paths and strips line suffixes from the target path', () => {
        const nodes = transform('Open web/src/router.tsx:42 please')
        const link = nodes.find((node) => node.type === 'link')

        expect(link?.children?.[0]?.value).toBe('web/src/router.tsx:42')
        expect(linkedPath(link!)).toBe('web/src/router.tsx')
    })

    it('links image and markdown filenames for preview', () => {
        const nodes = transform('See screenshot.png and README.md')
        const links = nodes.filter((node) => node.type === 'link')

        expect(links.map(linkedPath)).toEqual(['screenshot.png', 'README.md'])
    })


    it('does not link paths that are outside the session workspace', () => {
        const nodes = transform('Skip /Users/dev/project/a.png, ~/a.png, ../a.png and C:\\tmp\\a.png')

        expect(nodes.some((node) => node.type === 'link')).toBe(false)
    })

    it('does not rewrite ordinary urls', () => {
        const nodes = transform('Visit https://example.com/web/src/router.tsx')

        expect(nodes.some((node) => node.type === 'link')).toBe(false)
    })

    it('rewrites an explicit macOS file link as a remote download', () => {
        const link = transformLink('/Users/liuxin/Documents/project/outputs/report.xlsx')

        expect(decodeFileDownloadHref(link.url!)).toBe('/Users/liuxin/Documents/project/outputs/report.xlsx')
    })

    it('rewrites file and sandbox URLs without exposing those schemes to the browser', () => {
        expect(decodeFileDownloadHref(transformLink('file:///Users/dev/project/report.pdf').url!))
            .toBe('/Users/dev/project/report.pdf')
        expect(decodeFileDownloadHref(transformLink('sandbox:/Users/dev/project/report.docx').url!))
            .toBe('/Users/dev/project/report.docx')
    })

    it('rewrites an explicit relative output artifact but preserves web links', () => {
        expect(decodeFileDownloadHref(transformLink('outputs/report.csv').url!)).toBe('outputs/report.csv')
        expect(transformLink('https://example.com/report.csv').url).toBe('https://example.com/report.csv')
    })
})
