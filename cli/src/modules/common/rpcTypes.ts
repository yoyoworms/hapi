import type { AgentFlavor } from '@hapi/protocol'

export interface SpawnSessionOptions {
    machineId?: string
    directory: string
    sessionId?: string
    existingSessionId?: string
    resumeSessionId?: string
    continueLatest?: boolean
    approvedNewDirectoryCreation?: boolean
    agent?: AgentFlavor
    model?: string
    effort?: string
    modelReasoningEffort?: string
    yolo?: boolean
    permissionMode?: string
    serviceTier?: string
    codexAccountId?: string
    codexSourceAccountId?: string
    collaborationMode?: 'default' | 'plan'
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    sandbox?: boolean
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }
