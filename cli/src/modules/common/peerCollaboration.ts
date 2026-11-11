export const HAPI_PEER_COLLABORATION_ENV = 'HAPI_ENABLE_PEER_COLLABORATION'

export function isPeerCollaborationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return ['1', 'true', 'yes', 'on'].includes((env[HAPI_PEER_COLLABORATION_ENV] ?? '').trim().toLowerCase())
}
