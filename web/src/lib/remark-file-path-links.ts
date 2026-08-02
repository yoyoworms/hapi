const FILE_PATH_HREF_PREFIX = 'hapi-file:'
const FILE_DOWNLOAD_HREF_PREFIX = 'hapi-file-download:'

const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\.\/|[A-Za-z0-9_.-]+\/)[^\s`"\'<>]*?\.(?:[A-Za-z0-9]{1,12}|lock)(?::\d+(?::\d+)?)?|(?:[A-Za-z0-9_.-]+\.(?:[A-Za-z0-9]{1,12}|lock))(?::\d+(?::\d+)?)?/g

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])
// Extensions that autolink to the session file viewer. Kept intentionally
// allowlisted (not "any dotted word") to avoid turning prose like "Node.js" or
// domains into dead file links. Additions target formats agents actually cite
// when handing over work: diagram sources (mmd/puml), docs (rst/adoc/tex),
// tabular data (csv/tsv), config/schema (ini/conf/env/proto/graphql/prisma),
// and common languages not already covered. TLD-lookalikes (org/com/io/dev/co)
// are deliberately excluded so URLs like "example.org" don't autolink.
const COMMON_FILE_EXTENSIONS = new Set([
    'adoc', 'astro', 'avif', 'bat', 'bmp', 'c', 'cfg', 'cjs', 'conf', 'cpp', 'css', 'csv',
    'doc', 'docx', 'env', 'gif', 'go', 'gql', 'gradle', 'graphql', 'gz', 'h', 'hpp', 'html',
    'ico', 'ini', 'java', 'jpeg', 'jpg', 'js', 'json', 'jsx', 'kt', 'lock', 'md', 'mdx', 'mjs',
    'mmd', 'ods', 'odt', 'pdf', 'php', 'png', 'ppt', 'pptx', 'prisma', 'properties', 'proto',
    'ps1', 'puml', 'py', 'rar', 'rb', 'rs', 'rst', 'scss', 'sh', 'sql', 'svelte', 'svg',
    'swift', 'tar', 'tex', 'toml', 'ts', 'tsv', 'tsx', 'txt', 'vue', 'webp', 'xls', 'xlsm',
    'xlsx', 'xml', 'yaml', 'yml', 'zip', 'zsh'
])

// Binary/output artifacts are not useful in the text file viewer. Explicit
// absolute links to these formats should keep the local authenticated-download
// behavior from before the upstream file-link rewrite.
const DOWNLOADABLE_ARTIFACT_EXTENSIONS = new Set([
    'doc', 'docx', 'gz', 'ods', 'odt', 'pdf', 'ppt', 'pptx', 'rar', 'tar',
    'xls', 'xlsm', 'xlsx', 'zip'
])

type MarkdownNode = {
    type?: string
    value?: string
    url?: string
    title?: string | null
    children?: MarkdownNode[]
}

function createFileHref(path: string): string {
    return `${FILE_PATH_HREF_PREFIX}${encodeURIComponent(path)}`
}

function createFileDownloadHref(path: string): string {
    return `${FILE_DOWNLOAD_HREF_PREFIX}${encodeURIComponent(path)}`
}

export function decodeFilePathHref(href: string): string | null {
    if (!href.startsWith(FILE_PATH_HREF_PREFIX)) return null
    try {
        return decodeURIComponent(href.slice(FILE_PATH_HREF_PREFIX.length))
    } catch {
        return null
    }
}

export function decodeFileDownloadHref(href: string): string | null {
    if (!href.startsWith(FILE_DOWNLOAD_HREF_PREFIX)) return null
    try {
        return decodeURIComponent(href.slice(FILE_DOWNLOAD_HREF_PREFIX.length))
    } catch {
        return null
    }
}

function splitTrailingPunctuation(value: string): { path: string; trailing: string } {
    let path = value
    let trailing = ''

    while (path.length > 0) {
        const last = path[path.length - 1]
        if (TRAILING_PUNCTUATION.has(last)) {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        if (last === ')' && path.split('(').length <= path.split(')').length) {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        if (last === ']' || last === '}') {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        break
    }

    return { path, trailing }
}

function stripLineSuffix(value: string): string {
    return value.replace(/:\d+(?::\d+)?$/, '')
}

function hasKnownFileExtension(value: string): boolean {
    const path = stripLineSuffix(value).toLowerCase()
    const ext = path.slice(path.lastIndexOf('.') + 1)
    return COMMON_FILE_EXTENSIONS.has(ext)
}

function hasDownloadableArtifactExtension(value: string): boolean {
    const path = stripLineSuffix(value).toLowerCase()
    const ext = path.slice(path.lastIndexOf('.') + 1)
    return DOWNLOADABLE_ARTIFACT_EXTENSIONS.has(ext)
}

function isWindowsAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value)
}

function shouldLinkPath(value: string): boolean {
    if (value.includes('://')) return false
    const path = stripLineSuffix(value)
    if (path.length < 3) return false
    if (path.startsWith('/') || path.startsWith('~/')) return false
    if (path.startsWith('../') || path.includes('/../')) return false
    if (isWindowsAbsolutePath(path)) return hasKnownFileExtension(path)
    if (path.includes('/')) return hasKnownFileExtension(path)
    return hasKnownFileExtension(path)
}

/**
 * Resolve explicit links that intentionally point at a local artifact. These
 * links cannot be fetched by normal browser navigation because the Hub may be
 * remote and authentication is required. Keep relative repository links on
 * the upstream file-viewer path; only explicit absolute/file/sandbox targets
 * use the authenticated download endpoint.
 */
function decodeExplicitLocalArtifactPath(value: string): string | null {
    let path = value.trim()
    if (!path) return null

    try {
        path = decodeURIComponent(path)
    } catch {
        // A literal percent sign is valid in a filesystem path.
    }

    let explicitLocalScheme = false
    if (path.startsWith('file://')) {
        path = path.slice('file://'.length)
        explicitLocalScheme = true
    } else if (path.startsWith('sandbox:')) {
        path = path.slice('sandbox:'.length)
        explicitLocalScheme = true
    }

    path = stripLineSuffix(path)
    if (!hasKnownFileExtension(path)) return null
    if (explicitLocalScheme) return path

    // Keep upstream's Windows-path behavior: route it to the session file
    // viewer, where the session host validates the path. A plain POSIX path is
    // only rewritten for binary artifacts; source/documentation paths such as
    // `/abs/path.md` remain untouched as upstream intended.
    if (path.startsWith('/') && hasDownloadableArtifactExtension(path)) return path
    return null
}

function linkTextNode(node: MarkdownNode): MarkdownNode[] {
    const value = node.value ?? ''
    const parts: MarkdownNode[] = []
    let lastIndex = 0

    PATH_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATH_PATTERN.exec(value)) !== null) {
        const rawMatch = match[0]
        const previousChar = match.index > 0 ? value[match.index - 1] : ''
        if (previousChar === ':' || previousChar === '/' || previousChar === '\\' || previousChar === '.') {
            continue
        }
        const { path: displayPath, trailing } = splitTrailingPunctuation(rawMatch)
        const filePath = stripLineSuffix(displayPath)

        if (!shouldLinkPath(filePath)) {
            continue
        }

        if (match.index > lastIndex) {
            parts.push({ type: 'text', value: value.slice(lastIndex, match.index) })
        }
        parts.push({
            type: 'link',
            url: createFileHref(filePath),
            title: null,
            children: [{ type: 'text', value: displayPath }]
        })
        if (trailing) {
            parts.push({ type: 'text', value: trailing })
        }
        lastIndex = match.index + rawMatch.length
    }

    if (parts.length === 0) return [node]
    if (lastIndex < value.length) {
        parts.push({ type: 'text', value: value.slice(lastIndex) })
    }
    return parts
}

// Convert an `inlineCode` node whose ENTIRE value is a single linkable file
// path into a link wrapping an inlineCode (preserving monospace styling).
//
// Intentionally conservative: only whole-value, whitespace-free values that the
// path pattern matches end-to-end are linked. This keeps real code snippets
// (`npm run build`, `str.split()`, `Math.PI`, `a.b.c`) untouched — they either
// contain whitespace, non-path characters, or a non-allowlisted extension.
function linkInlineCodeNode(node: MarkdownNode): MarkdownNode | null {
    const raw = node.value ?? ''
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    if (/\s/.test(trimmed)) return null

    PATH_PATTERN.lastIndex = 0
    const match = PATH_PATTERN.exec(trimmed)
    // Require the pattern to cover the whole value — rejects `a=b.js`, `x.md#y`, etc.
    if (!match || match[0] !== trimmed) return null

    const filePath = stripLineSuffix(trimmed)
    if (!shouldLinkPath(filePath)) return null

    return {
        type: 'link',
        url: createFileHref(filePath),
        title: null,
        children: [{ type: 'inlineCode', value: trimmed }]
    }
}

// Rewrite an explicit markdown link `[label](relative/file.ext)` whose target is
// a repo-relative allowlisted file path into a `hapi-file:` href so it opens the
// session file viewer instead of dead-ending in the SPA router.
//
// Security: reuses shouldLinkPath (rejects POSIX abs / `~/` / `../` / `scheme://`)
// and rejects residual colons for non-Windows targets after the line-suffix strip,
// so scheme-bearing urls (mailto:, obsidian://, foo:bar.md) are left for the
// deny-scheme layer. Windows absolute paths are routed through the session file
// viewer; the CLI still enforces that they stay inside the session workspace.
function rewriteFileLinkNode(node: MarkdownNode): void {
    if (node.type !== 'link') return
    const url = node.url
    if (!url) return
    if (url.startsWith(FILE_PATH_HREF_PREFIX) || url.startsWith(FILE_DOWNLOAD_HREF_PREFIX)) return

    const artifactPath = decodeExplicitLocalArtifactPath(url)
    if (artifactPath) {
        node.url = createFileDownloadHref(artifactPath)
        return
    }

    const target = stripLineSuffix(url)
    if (!isWindowsAbsolutePath(target) && target.includes(':')) return
    if (!shouldLinkPath(target)) return

    node.url = createFileHref(target)
}

export type RemarkFilePathLinksOptions = {
    // Rewrite explicit markdown links `[label](relative/file.ext)` → `hapi-file:`.
    // Routing a `hapi-file:` href needs session context (FilePathAnchor); surfaces
    // that render without HappyChatContext (standalone file-preview) must disable
    // this or the anchor collapses to plain text (`A` returns props.children when
    // `!chat`). Bare-path / inlineCode autolinks are unaffected — they were already
    // plain text on those surfaces. Default: true (chat surface).
    rewriteExplicitLinks?: boolean
}

function visit(
    node: MarkdownNode,
    parentType: string | null,
    rewriteExplicitLinks: boolean
): void {
    if (!node.children) return
    if (parentType === 'link' || parentType === 'linkReference') return

    const nextChildren: MarkdownNode[] = []
    for (const child of node.children) {
        if (child.type === 'text') {
            nextChildren.push(...linkTextNode(child))
            continue
        }
        if (child.type === 'inlineCode') {
            nextChildren.push(linkInlineCodeNode(child) ?? child)
            continue
        }
        if (child.type === 'link') {
            if (rewriteExplicitLinks) rewriteFileLinkNode(child)
            nextChildren.push(child)
            continue
        }
        visit(child, child.type ?? null, rewriteExplicitLinks)
        nextChildren.push(child)
    }
    node.children = nextChildren
}

export function remarkFilePathLinks(options: RemarkFilePathLinksOptions = {}) {
    const rewriteExplicitLinks = options.rewriteExplicitLinks !== false
    return (tree: MarkdownNode) => visit(tree, null, rewriteExplicitLinks)
}
