const DB_NAME = 'hapi-composer-drafts'
const DB_VERSION = 2
const STORE = 'attachments'
const META_STORE = 'attachment-meta'
const MAX_DRAFTS = 50
// Uploading a single normal attachment is capped at 50MB. Persist at most one
// such payload (plus modest companions) per session and keep a small global
// budget. Larger drafts remain in the in-memory cache for same-tab recovery;
// attempting to clone them repeatedly into IndexedDB can terminate mobile tabs.
const MAX_PERSISTED_DRAFT_BYTES = 64 * 1024 * 1024
const MAX_PERSISTED_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_CACHE_BYTES = 128 * 1024 * 1024

type StoredAttachment = {
    id: string
    name: string
    type: string
    lastModified: number
    blob: Blob
    path?: string
    previewUrl?: string
}

type StoredAttachmentDraft = {
    sessionId: string
    files: StoredAttachment[]
    updatedAt: number
}

type StoredAttachmentDraftMeta = {
    sessionId: string
    updatedAt: number
    bytes: number
}

const cache = new Map<string, File[]>()
const restoredUploadMetadata = new WeakMap<File, RestoredUploadMetadata>()
const pendingWrites = new Map<string, Promise<void>>()

export type AttachmentDraftInput = {
    id: string
    file: File
    path?: string
    previewUrl?: string
}

export type RestoredUploadMetadata = {
    id: string
    path: string
    previewUrl?: string
    /** Session whose CLI/Hub storage owns `path`. */
    sourceSessionId: string
}

function storedDraftBytes(record: Pick<StoredAttachmentDraft, 'files'>): number {
    return record.files.reduce((total, file) => total + file.blob.size, 0)
}

function fileSetBytes(files: readonly File[]): number {
    return files.reduce((total, file) => total + file.size, 0)
}

/** @internal Exported for the storage-budget regression test. */
export function canPersistAttachmentDraft(files: readonly Pick<File, 'size'>[]): boolean {
    return files.reduce((total, file) => total + file.size, 0) <= MAX_PERSISTED_DRAFT_BYTES
}

function evictStoredDrafts(
    store: IDBObjectStore,
    metaStore: IDBObjectStore,
    drafts: StoredAttachmentDraftMeta[],
): void {
    const newestFirst = [...drafts].sort((a, b) => b.updatedAt - a.updatedAt)
    let kept = 0
    let keptBytes = 0
    for (const draft of newestFirst) {
        const bytes = Number.isFinite(draft.bytes) ? Math.max(0, draft.bytes) : Infinity
        const withinBudget = kept < MAX_DRAFTS
            && bytes <= MAX_PERSISTED_DRAFT_BYTES
            && keptBytes + bytes <= MAX_PERSISTED_TOTAL_BYTES
        if (withinBudget) {
            kept += 1
            keptBytes += bytes
            continue
        }
        store.delete(draft.sessionId)
        metaStore.delete(draft.sessionId)
    }
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is unavailable'))
            return
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = (event) => {
            const db = request.result
            const transaction = request.transaction
            if (!transaction) return
            const hadAttachmentStore = db.objectStoreNames.contains(STORE)
            const store = hadAttachmentStore
                ? transaction.objectStore(STORE)
                : db.createObjectStore(STORE, { keyPath: 'sessionId' })
            const metaStore = db.objectStoreNames.contains(META_STORE)
                ? transaction.objectStore(META_STORE)
                : db.createObjectStore(META_STORE, { keyPath: 'sessionId' })

            // V1 evicted with getAll(), which materialized every stored Blob at
            // once. Migrate one cursor value at a time into a tiny metadata
            // store, then all future eviction scans touch metadata only.
            if ((event.oldVersion ?? 0) < 2 && hadAttachmentStore) {
                const cursorRequest = store.openCursor()
                cursorRequest.onsuccess = () => {
                    const cursor = cursorRequest.result
                    if (cursor) {
                        const record = cursor.value as StoredAttachmentDraft
                        metaStore.put({
                            sessionId: record.sessionId,
                            updatedAt: record.updatedAt,
                            bytes: storedDraftBytes(record),
                        } satisfies StoredAttachmentDraftMeta)
                        cursor.continue()
                        return
                    }
                    const metaRequest = metaStore.getAll()
                    metaRequest.onsuccess = () => {
                        evictStoredDrafts(
                            store,
                            metaStore,
                            metaRequest.result as StoredAttachmentDraftMeta[],
                        )
                    }
                }
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Failed to open composer draft DB'))
    })
}

function copyFile(file: File): File {
    const copy = new File([file], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    })
    const metadata = restoredUploadMetadata.get(file)
    if (metadata) restoredUploadMetadata.set(copy, metadata)
    return copy
}

function toStoredFile(attachment: AttachmentDraftInput): StoredAttachment {
    const file = attachment.file
    return {
        id: attachment.id,
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        blob: file,
        path: attachment.path,
        previewUrl: attachment.previewUrl,
    }
}

function toFile(file: StoredAttachment, sourceSessionId: string): File {
    const restored = new File([file.blob], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    })
    if (file.path) {
        restoredUploadMetadata.set(restored, {
            id: file.id,
            path: file.path,
            previewUrl: file.previewUrl,
            sourceSessionId,
        })
    }
    return restored
}

async function writeDraft(record: StoredAttachmentDraft | null, sessionId: string): Promise<void> {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE, META_STORE], 'readwrite')
        const store = transaction.objectStore(STORE)
        const metaStore = transaction.objectStore(META_STORE)
        if (record) {
            const bytes = storedDraftBytes(record)
            store.put(record)
            metaStore.put({
                sessionId,
                updatedAt: record.updatedAt,
                bytes,
            } satisfies StoredAttachmentDraftMeta)
        } else {
            store.delete(sessionId)
            metaStore.delete(sessionId)
        }
        const metaRequest = metaStore.getAll()
        metaRequest.onsuccess = () => {
            evictStoredDrafts(
                store,
                metaStore,
                metaRequest.result as StoredAttachmentDraftMeta[],
            )
        }
        transaction.oncomplete = () => {
            db.close()
            resolve()
        }
        transaction.onerror = () => {
            db.close()
            reject(transaction.error ?? new Error('Composer draft transaction failed'))
        }
        transaction.onabort = transaction.onerror
    })
}

function queueWrite(record: StoredAttachmentDraft | null, sessionId: string): void {
    const previous = pendingWrites.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => writeDraft(record, sessionId))
    pendingWrites.set(sessionId, next)
    void next.catch(() => {}).finally(() => {
        if (pendingWrites.get(sessionId) === next) pendingWrites.delete(sessionId)
    })
}

function setCachedFiles(sessionId: string, files: File[]): void {
    cache.delete(sessionId)
    cache.set(sessionId, files)
    let cachedBytes = [...cache.values()].reduce(
        (total, cachedFiles) => total + fileSetBytes(cachedFiles),
        0,
    )
    while (cache.size > MAX_DRAFTS || (cachedBytes > MAX_CACHE_BYTES && cache.size > 1)) {
        const oldest = cache.keys().next().value as string | undefined
        if (!oldest) break
        cachedBytes -= fileSetBytes(cache.get(oldest) ?? [])
        cache.delete(oldest)
    }
}

export async function getDraftAttachments(sessionId: string): Promise<File[]> {
    const cached = cache.get(sessionId)
    if (cached) return cached.map(copyFile)

    try {
        const db = await openDb()
        const record = await new Promise<StoredAttachmentDraft | undefined>((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readonly')
            const request = transaction.objectStore(STORE).get(sessionId)
            transaction.oncomplete = () => {
                db.close()
                resolve(request.result as StoredAttachmentDraft | undefined)
            }
            transaction.onerror = () => {
                db.close()
                reject(transaction.error ?? new Error('Composer draft transaction failed'))
            }
        })
        const files = record?.files.map((file) => toFile(file, record.sessionId)) ?? []
        if (files.length > 0) setCachedFiles(sessionId, files)
        if (record && !canPersistAttachmentDraft(files)) {
            // Preserve this recovery in memory for the current tab, but remove
            // an oversized legacy V1 record before a later getAll-like browser
            // operation or quota pressure can amplify it.
            queueWrite(null, sessionId)
        }
        return files
    } catch {
        return []
    }
}

export function saveDraftAttachments(sessionId: string, attachments: AttachmentDraftInput[]): void {
    if (attachments.length === 0) {
        // Keep an empty cache entry as a tombstone until the queued IndexedDB
        // delete completes, so a fast remount cannot read and restore stale files.
        setCachedFiles(sessionId, [])
        queueWrite(null, sessionId)
        return
    }

    const storedFiles = attachments.map(toStoredFile)
    const copies = storedFiles.map((file) => toFile(file, sessionId))
    setCachedFiles(sessionId, copies)
    if (!canPersistAttachmentDraft(copies)) {
        // The current tab still owns `copies`; delete any stale persistent
        // version so a reload never resurrects an older attachment set.
        queueWrite(null, sessionId)
        return
    }
    queueWrite({
        sessionId,
        files: storedFiles,
        updatedAt: Date.now(),
    }, sessionId)
}

export function clearDraftAttachments(sessionId: string): void {
    saveDraftAttachments(sessionId, [])
}

export function getRestoredUploadMetadata(file: File): RestoredUploadMetadata | undefined {
    return restoredUploadMetadata.get(file)
}
