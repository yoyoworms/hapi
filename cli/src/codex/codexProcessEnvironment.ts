const HAPI_CODEX_SESSION_ENV_KEYS = [
    'HAPI_CODEX_ACCOUNT_ID',
    'HAPI_CODEX_ACCOUNT_LABEL',
    'HAPI_CODEX_ACCOUNT_KIND',
    'HAPI_CODEX_API_KEY',
    'HAPI_CODEX_RESUME_PATH'
] as const;

/**
 * Removes Codex identity state that belongs to one HAPI session.
 *
 * `CODEX_HOME` is preserved for normal shell configuration, but removed when
 * any HAPI account marker proves it belongs to a running HAPI session. Even a
 * session labelled "system" is not authoritative here: legacy runners could
 * record "system" while actually using a managed CODEX_HOME.
 */
export function sanitizeCodexSessionEnvironment(
    environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
    const sanitized = { ...environment };
    const inheritedSessionIdentity = HAPI_CODEX_SESSION_ENV_KEYS.some(
        (key) => environment[key] !== undefined
    );

    for (const key of HAPI_CODEX_SESSION_ENV_KEYS) {
        delete sanitized[key];
    }
    if (inheritedSessionIdentity) {
        delete sanitized.CODEX_HOME;
    }

    return sanitized;
}
