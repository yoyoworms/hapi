import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';

type SessionDisplayRenameClient = Pick<ApiSessionClient, 'updateMetadata'>;

/**
 * Agent rename: set metadata.name unless the user has chosen a title.
 * Web/operator renames own the title and take priority over agent updates.
 */
export function normalizeSessionDisplayTitle(title: unknown): string | null {
    if (typeof title !== 'string') {
        return null;
    }
    const normalized = title.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

export function applySessionDisplayRename(
    client: SessionDisplayRenameClient,
    title: unknown
): boolean {
    const normalized = normalizeSessionDisplayTitle(title);
    if (!normalized) {
        return false;
    }

    client.updateMetadata((metadata: Metadata) => {
        if (metadata.titleLocked || (metadata.titleLocked !== false && metadata.nameSource === 'user')) return metadata;
        if (metadata.name?.trim() === normalized) {
            return metadata;
        }
        return {
            ...metadata,
            name: normalized,
            nameSource: 'agent'
        };
    });
    return true;
}
