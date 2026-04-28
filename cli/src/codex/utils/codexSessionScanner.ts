import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from "@/modules/common/session/BaseSessionScanner";
import { logger } from "@/ui/logger";
import { join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { readFile, readdir, stat } from "node:fs/promises";
import type { CodexSessionEvent } from "./codexEventConverter";

interface CodexSessionScannerOptions {
    sessionId: string | null;
    onEvent: (event: CodexSessionEvent) => void;
    onSessionFound?: (sessionId: string) => void;
    shouldImportHistory?: (sessionId: string) => boolean;
    onHistoryImported?: (sessionId: string) => void;
    onSessionMatchFailed?: (message: string) => void;
    cwd?: string;
    sessionMatchToken?: string;
    startupTimestampMs?: number;
    sessionStartWindowMs?: number;
}

interface CodexSessionScanner {
    cleanup: () => Promise<void>;
    onNewSession: (sessionId: string) => void;
    resolveActiveSession: () => Promise<string | null>;
}

type PendingEvents = {
    events: CodexSessionEvent[];
    fileSessionId: string | null;
};

type Candidate = {
    sessionId: string;
    score: number;
};

const DEFAULT_SESSION_START_WINDOW_MS = 2 * 60 * 1000;
const HISTORY_IMPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function createCodexSessionScanner(opts: CodexSessionScannerOptions): Promise<CodexSessionScanner> {
    const targetCwd = opts.cwd && opts.cwd.trim().length > 0 ? normalizePath(opts.cwd) : null;

    if (!targetCwd && !opts.sessionId) {
        const message = 'No cwd provided for Codex session matching; refusing to fallback.';
        logger.warn(`[CODEX_SESSION_SCANNER] ${message}`);
        opts.onSessionMatchFailed?.(message);
        return {
            cleanup: async () => {},
            onNewSession: () => {},
            resolveActiveSession: async () => null
        };
    }

    const scanner = new CodexSessionScannerImpl(opts, targetCwd);
    await scanner.start();

    return {
        cleanup: async () => {
            await scanner.cleanup();
        },
        onNewSession: (sessionId: string) => {
            scanner.onNewSession(sessionId);
        },
        resolveActiveSession: async () => {
            return await scanner.resolveActiveSession();
        }
    };
}

class CodexSessionScannerImpl extends BaseSessionScanner<CodexSessionEvent> {
    private readonly sessionsRoot: string;
    private readonly onEvent: (event: CodexSessionEvent) => void;
    private readonly onSessionFound?: (sessionId: string) => void;
    private readonly shouldImportHistory?: (sessionId: string) => boolean;
    private readonly onHistoryImported?: (sessionId: string) => void;
    private readonly onSessionMatchFailed?: (message: string) => void;
    private readonly sessionIdByFile = new Map<string, string>();
    private readonly sessionCwdByFile = new Map<string, string>();
    private readonly sessionTimestampByFile = new Map<string, number>();
    private readonly sessionMatchTokenByFile = new Map<string, string>();
    private readonly pendingEventsByFile = new Map<string, PendingEvents>();
    private readonly historyEventsByFile = new Map<string, PendingEvents>();
    private readonly sessionMetaParsed = new Set<string>();
    private readonly fileEpochByPath = new Map<string, number>();
    private readonly targetCwd: string | null;
    private readonly sessionMatchToken: string | null;
    private readonly referenceTimestampMs: number;
    private readonly sessionStartWindowMs: number;
    private readonly matchDeadlineMs: number;
    private readonly sessionDatePrefixes: Set<string> | null;
    private readonly historyCutoffMs: number;

    private activeSessionId: string | null;
    private reportedSessionId: string | null;
    private matchFailed = false;
    private bestWithinWindow: Candidate | null = null;
    private readonly recentActivitySessionIds = new Set<string>();
    private firstRecentActivityCandidateResolved = false;
    private readonly firstRecentActivitySessionIds = new Set<string>();
    private loggedAmbiguousRecentActivity = false;

    constructor(opts: CodexSessionScannerOptions, targetCwd: string | null) {
        super({ intervalMs: 2000 });
        const codexHomeDir = process.env.CODEX_HOME || join(homedir(), '.codex');
        this.sessionsRoot = join(codexHomeDir, 'sessions');
        this.onEvent = opts.onEvent;
        this.onSessionFound = opts.onSessionFound;
        this.shouldImportHistory = opts.shouldImportHistory;
        this.onHistoryImported = opts.onHistoryImported;
        this.onSessionMatchFailed = opts.onSessionMatchFailed;
        this.activeSessionId = opts.sessionId;
        this.reportedSessionId = opts.sessionId;
        this.targetCwd = targetCwd;
        this.sessionMatchToken = opts.sessionMatchToken ?? null;
        this.referenceTimestampMs = opts.startupTimestampMs ?? Date.now();
        this.sessionStartWindowMs = opts.sessionStartWindowMs ?? DEFAULT_SESSION_START_WINDOW_MS;
        this.matchDeadlineMs = this.referenceTimestampMs + this.sessionStartWindowMs;
        this.sessionDatePrefixes = this.targetCwd
            ? getSessionDatePrefixes(this.referenceTimestampMs, this.sessionStartWindowMs)
            : null;
        this.historyCutoffMs = this.referenceTimestampMs - HISTORY_IMPORT_WINDOW_MS;

        logger.debug(`[CODEX_SESSION_SCANNER] Init: targetCwd=${this.targetCwd ?? 'none'} startupTs=${new Date(this.referenceTimestampMs).toISOString()} windowMs=${this.sessionStartWindowMs} hasMatchToken=${this.sessionMatchToken ? 'yes' : 'no'}`);
    }

    public onNewSession(sessionId: string): void {
        if (this.activeSessionId === sessionId) {
            return;
        }
        logger.debug(`[CODEX_SESSION_SCANNER] Switching to new session: ${sessionId}`);
        this.setActiveSessionId(sessionId);
        this.invalidate();
    }

    public async resolveActiveSession(): Promise<string | null> {
        if (this.activeSessionId) {
            return this.activeSessionId;
        }
        if (!this.targetCwd) {
            return null;
        }

        await this.beforeScan();
        const files = await this.findSessionFiles();
        for (const filePath of files) {
            const cursor = this.getCursor(filePath);
            const { events, nextCursor } = await this.readSessionFile(filePath, cursor);
            this.cacheHistoryEvents(filePath, events.map((entry) => entry.event));
            await this.handleFileScan({
                filePath,
                events: events.map((entry) => entry.event),
                parsedCount: events.length,
                newCount: events.length,
                skippedCount: 0,
                cursor,
                nextCursor
            });
            this.setCursor(filePath, nextCursor);
        }
        await this.afterScan();

        if (this.activeSessionId) {
            logger.debug(`[CODEX_SESSION_SCANNER] Resolved active session ${this.activeSessionId} during synchronous scan`);
        }
        return this.activeSessionId;
    }

    protected shouldScan(): boolean {
        return !this.matchFailed;
    }

    protected shouldWatchFile(filePath: string): boolean {
        if (!this.activeSessionId) {
            if (!this.targetCwd) {
                return false;
            }
            return this.getCandidateForFile(filePath) !== null;
        }
        const fileSessionId = this.sessionIdByFile.get(filePath);
        if (fileSessionId) {
            return fileSessionId === this.activeSessionId;
        }
        return filePath.endsWith(`-${this.activeSessionId}.jsonl`);
    }

    protected async initialize(): Promise<void> {
        const files = await this.listSessionFiles(this.sessionsRoot);
        for (const filePath of files) {
            const { events, nextCursor } = await this.readSessionFile(filePath, 0);
            this.cacheHistoryEvents(filePath, events.map((entry) => entry.event));
            this.setCursor(filePath, nextCursor);
            if (this.shouldWatchFile(filePath)) {
                this.ensureWatcher(filePath);
            }
        }
        if (this.activeSessionId) {
            this.emitHistoryForSession(this.activeSessionId);
        }
    }

    protected async beforeScan(): Promise<void> {
        this.bestWithinWindow = null;
        this.recentActivitySessionIds.clear();
    }

    protected async findSessionFiles(): Promise<string[]> {
        const files = await this.listSessionFiles(this.sessionsRoot);
        return sortFilesByMtime(files);
    }

    protected async parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        if (this.shouldSkipFile(filePath)) {
            return { events: [], nextCursor: cursor };
        }
        const result = await this.readSessionFile(filePath, cursor);
        this.cacheHistoryEvents(filePath, result.events.map((entry) => entry.event));
        return result;
    }

    protected generateEventKey(event: CodexSessionEvent, context: { filePath: string; lineIndex?: number }): string {
        const epoch = this.fileEpochByPath.get(context.filePath) ?? 0;
        const lineIndex = context.lineIndex ?? -1;
        return `${context.filePath}:${epoch}:${lineIndex}`;
    }

    protected async handleFileScan(stats: SessionFileScanStats<CodexSessionEvent>): Promise<void> {
        const filePath = stats.filePath;
        const fileSessionId = this.sessionIdByFile.get(filePath) ?? null;

        if (!this.activeSessionId && this.targetCwd) {
            this.appendPendingEvents(filePath, stats.events, fileSessionId);
            const candidate = this.getCandidateForFile(filePath);
            if (candidate) {
                if (!this.bestWithinWindow || candidate.score < this.bestWithinWindow.score) {
                    this.bestWithinWindow = candidate;
                }
            }
            const recentActivityCandidate = this.getRecentActivityCandidateForFile(filePath, stats.newCount);
            if (recentActivityCandidate) {
                this.recentActivitySessionIds.add(recentActivityCandidate.sessionId);
            }
            if (stats.newCount > 0) {
                logger.debug(`[CODEX_SESSION_SCANNER] Buffered ${stats.newCount} pending events from ${filePath}`);
            }
            return;
        }

        const emittedForFile = this.emitEvents(stats.events, fileSessionId);
        if (emittedForFile > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emittedForFile} new events from ${filePath}`);
        }
    }

    protected async afterScan(): Promise<void> {
        if (!this.activeSessionId && this.targetCwd) {
            if (this.bestWithinWindow) {
                logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${this.bestWithinWindow.sessionId} within start window`);
                this.setActiveSessionId(this.bestWithinWindow.sessionId);
            } else {
                this.captureFirstRecentActivityCandidate();

                if (this.firstRecentActivitySessionIds.size === 1) {
                    const [sessionId] = this.firstRecentActivitySessionIds;
                    if (sessionId) {
                        logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${sessionId} from first unique matching activity after startup`);
                        this.setActiveSessionId(sessionId);
                    }
                } else if (
                    !this.loggedAmbiguousRecentActivity
                    && this.firstRecentActivityCandidateResolved
                    && this.firstRecentActivitySessionIds.size > 1
                ) {
                    this.loggedAmbiguousRecentActivity = true;
                    logger.debug('[CODEX_SESSION_SCANNER] First matching activity after startup was ambiguous; refusing reused-session adoption');
                }

                if (!this.activeSessionId) {
                    if (Date.now() > this.matchDeadlineMs) {
                        this.matchFailed = true;
                        this.pendingEventsByFile.clear();
                        const message = `No Codex session found within ${this.sessionStartWindowMs}ms for cwd ${this.targetCwd}; refusing fallback.`;
                        logger.warn(`[CODEX_SESSION_SCANNER] ${message}`);
                        this.onSessionMatchFailed?.(message);
                    } else if (this.pendingEventsByFile.size > 0) {
                        logger.debug('[CODEX_SESSION_SCANNER] No session candidate matched yet; pending events buffered');
                    }
                }
            }
        }
    }

    private captureFirstRecentActivityCandidate(): void {
        if (this.firstRecentActivityCandidateResolved || this.recentActivitySessionIds.size === 0) {
            return;
        }

        this.firstRecentActivityCandidateResolved = true;
        for (const sessionId of this.recentActivitySessionIds) {
            this.firstRecentActivitySessionIds.add(sessionId);
        }
    }

    private shouldSkipFile(filePath: string): boolean {
        if (!this.activeSessionId) {
            return false;
        }
        const fileSessionId = this.sessionIdByFile.get(filePath);
        if (fileSessionId && fileSessionId !== this.activeSessionId) {
            return true;
        }
        if (!fileSessionId && !filePath.endsWith(`-${this.activeSessionId}.jsonl`)) {
            return true;
        }
        return false;
    }

    private reportSessionId(sessionId: string): void {
        if (this.reportedSessionId === sessionId) {
            return;
        }
        this.reportedSessionId = sessionId;
        this.onSessionFound?.(sessionId);
    }

    private setActiveSessionId(sessionId: string): void {
        this.activeSessionId = sessionId;
        this.matchFailed = false;
        this.reportSessionId(sessionId);
        const candidateFiles = this.getFilesForSession(sessionId);
        for (const filePath of candidateFiles) {
            if (this.shouldWatchFile(filePath)) {
                this.ensureWatcher(filePath);
            }
        }
        this.pruneWatchers(this.getWatchedFiles().filter((filePath) => this.shouldWatchFile(filePath)));
        this.emitHistoryForSession(sessionId);
        if (this.targetCwd) {
            this.flushPendingEventsForSession(sessionId);
        } else {
            this.pendingEventsByFile.clear();
        }
    }

    private cacheHistoryEvents(filePath: string, events: CodexSessionEvent[]): void {
        if (!this.shouldImportHistory || events.length === 0) {
            return;
        }
        if (this.historyEventsByFile.has(filePath)) {
            return;
        }

        const sessionId = this.sessionIdByFile.get(filePath);
        if (!sessionId) {
            return;
        }

        if (this.activeSessionId && sessionId !== this.activeSessionId) {
            return;
        }

        const fileCwd = this.sessionCwdByFile.get(filePath);
        if (this.targetCwd && fileCwd !== this.targetCwd) {
            return;
        }

        const recentEvents = events.filter((event) => {
            const timestampMs = parseTimestamp(event.timestamp);
            return timestampMs === null || timestampMs >= this.historyCutoffMs;
        });
        if (recentEvents.length === 0) {
            return;
        }

        this.historyEventsByFile.set(filePath, {
            events: recentEvents,
            fileSessionId: sessionId
        });
    }

    private emitHistoryForSession(sessionId: string): void {
        if (!this.shouldImportHistory?.(sessionId)) {
            return;
        }

        let emitted = 0;
        let matched = false;
        for (const [filePath, history] of this.historyEventsByFile.entries()) {
            const matches = (history.fileSessionId && history.fileSessionId === sessionId)
                || filePath.endsWith(`-${sessionId}.jsonl`);
            if (!matches) {
                continue;
            }

            matched = true;
            emitted += this.emitEvents(history.events, history.fileSessionId);
            this.historyEventsByFile.delete(filePath);
        }

        if (!matched) {
            return;
        }

        this.onHistoryImported?.(sessionId);
        logger.debug(`[CODEX_SESSION_SCANNER] Imported ${emitted} history events for session ${sessionId}`);
    }

    private async listSessionFiles(dir: string): Promise<string[]> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            const results: string[] = [];
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    results.push(...await this.listSessionFiles(full));
                } else if (entry.isFile() && entry.name.endsWith('.jsonl') && await this.shouldIncludeSessionFile(full)) {
                    results.push(full);
                }
            }
            return results;
        } catch (error) {
            return [];
        }
    }

    private async shouldIncludeSessionFile(filePath: string): Promise<boolean> {
        if (this.activeSessionId && filePath.endsWith(`-${this.activeSessionId}.jsonl`)) {
            return true;
        }
        if (shouldIncludeSessionPath(filePath, this.sessionsRoot, this.sessionDatePrefixes)) {
            return true;
        }
        if (!this.targetCwd) {
            return false;
        }
        try {
            const stats = await stat(filePath);
            return stats.mtimeMs >= this.referenceTimestampMs - this.sessionStartWindowMs;
        } catch {
            return false;
        }
    }

    private async readSessionFile(filePath: string, startLine: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        let content: string;
        try {
            content = await readFile(filePath, 'utf-8');
        } catch (error) {
            return { events: [], nextCursor: startLine };
        }

        const events: SessionFileScanEntry<CodexSessionEvent>[] = [];
        const lines = content.split('\n');
        const hasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
        const totalLines = hasTrailingEmpty ? lines.length - 1 : lines.length;
        let effectiveStartLine = startLine;
        if (effectiveStartLine > totalLines) {
            effectiveStartLine = 0;
            const nextEpoch = (this.fileEpochByPath.get(filePath) ?? 0) + 1;
            this.fileEpochByPath.set(filePath, nextEpoch);
        }

        const hasSessionMeta = this.sessionMetaParsed.has(filePath);
        const parseFrom = hasSessionMeta ? effectiveStartLine : 0;

        for (let index = parseFrom; index < lines.length; index += 1) {
            const trimmed = lines[index].trim();
            if (!trimmed) {
                continue;
            }
            try {
                const parsed = JSON.parse(trimmed) as CodexSessionEvent;
                if (parsed?.type === 'session_meta') {
                    const payload = asRecord(parsed.payload);
                    const sessionId = payload ? asString(payload.id) : null;
                    if (sessionId) {
                        this.sessionIdByFile.set(filePath, sessionId);
                    }
                    const sessionCwd = payload ? asString(payload.cwd) : null;
                    const normalizedCwd = sessionCwd ? normalizePath(sessionCwd) : null;
                    if (normalizedCwd) {
                        this.sessionCwdByFile.set(filePath, normalizedCwd);
                    }
                    const rawTimestamp = payload ? payload.timestamp : null;
                    const sessionTimestamp = payload ? parseTimestamp(payload.timestamp) : null;
                    if (sessionTimestamp !== null) {
                        this.sessionTimestampByFile.set(filePath, sessionTimestamp);
                    }
                    const baseInstructions = payload ? asRecord(payload.base_instructions) : null;
                    const baseInstructionsText = baseInstructions ? asString(baseInstructions.text) : null;
                    const matchedToken = this.extractSessionMatchToken(baseInstructionsText);
                    if (matchedToken) {
                        this.sessionMatchTokenByFile.set(filePath, matchedToken);
                    }
                    logger.debug(`[CODEX_SESSION_SCANNER] Session meta: file=${filePath} cwd=${sessionCwd ?? 'none'} normalizedCwd=${normalizedCwd ?? 'none'} timestamp=${rawTimestamp ?? 'none'} parsedTs=${sessionTimestamp ?? 'none'} hasMatchToken=${matchedToken ? 'yes' : 'no'}`);
                    this.sessionMetaParsed.add(filePath);
                }
                const eventMatchedToken = this.extractSessionMatchTokenFromEvent(parsed);
                if (eventMatchedToken) {
                    this.sessionMatchTokenByFile.set(filePath, eventMatchedToken);
                    logger.debug(`[CODEX_SESSION_SCANNER] Session match token found outside session_meta: file=${filePath}`);
                }
                if (index >= effectiveStartLine) {
                    events.push({ event: parsed, lineIndex: index });
                }
            } catch (error) {
                logger.debug(`[CODEX_SESSION_SCANNER] Failed to parse line: ${error}`);
            }
        }

        return { events, nextCursor: totalLines };
    }

    private getCandidateForFile(filePath: string): Candidate | null {
        const sessionId = this.sessionIdByFile.get(filePath);
        if (!sessionId) {
            return null;
        }

        const fileCwd = this.sessionCwdByFile.get(filePath);
        if (this.targetCwd && fileCwd !== this.targetCwd) {
            return null;
        }
        if (!this.fileMatchesSessionToken(filePath)) {
            return null;
        }

        const sessionTimestamp = this.sessionTimestampByFile.get(filePath);
        if (sessionTimestamp === undefined) {
            return null;
        }

        if (sessionTimestamp < this.referenceTimestampMs) {
            return null;
        }

        const diff = sessionTimestamp - this.referenceTimestampMs;
        if (diff > this.sessionStartWindowMs) {
            return null;
        }

        return {
            sessionId,
            score: diff
        };
    }

    private getRecentActivityCandidateForFile(filePath: string, newCount: number): Candidate | null {
        if (newCount <= 0) {
            return null;
        }

        const sessionId = this.sessionIdByFile.get(filePath);
        if (!sessionId) {
            return null;
        }

        const fileCwd = this.sessionCwdByFile.get(filePath);
        if (this.targetCwd && fileCwd !== this.targetCwd) {
            return null;
        }
        if (!this.fileMatchesSessionToken(filePath)) {
            return null;
        }

        return {
            sessionId,
            score: 0
        };
    }

    private fileMatchesSessionToken(filePath: string): boolean {
        if (!this.sessionMatchToken) {
            return true;
        }
        return this.sessionMatchTokenByFile.get(filePath) === this.sessionMatchToken;
    }

    private extractSessionMatchToken(text: string | null): string | null {
        if (!text) {
            return null;
        }
        const match = text.match(/(?:hapi[-\s]+session[-\s]+match[-\s]+token|HAPI session match token)\s*:?\s*([a-f0-9-]+)/i);
        return match?.[1] ?? null;
    }

    private extractSessionMatchTokenFromEvent(event: CodexSessionEvent): string | null {
        const payload = asRecord(event.payload);
        if (!payload) {
            return null;
        }

        if (event.type === 'response_item') {
            const itemType = asString(payload.type);
            const role = asString(payload.role);
            if (itemType !== 'message' || role !== 'developer') {
                return null;
            }

            const content = payload.content;
            if (!Array.isArray(content)) {
                return null;
            }

            for (const part of content) {
                const record = asRecord(part);
                const text = record ? asString(record.text) : null;
                const matchedToken = this.extractSessionMatchToken(text);
                if (matchedToken) {
                    return matchedToken;
                }
            }
            return null;
        }

        if (event.type === 'turn_context') {
            const collaborationMode = asRecord(payload.collaboration_mode);
            const settings = collaborationMode ? asRecord(collaborationMode.settings) : null;
            return this.extractSessionMatchToken(settings ? asString(settings.developer_instructions) : null);
        }

        return null;
    }

    private getFilesForSession(sessionId: string): string[] {
        const matches: string[] = [];
        for (const [filePath, storedSessionId] of this.sessionIdByFile.entries()) {
            if (storedSessionId === sessionId) {
                matches.push(filePath);
            }
        }
        if (matches.length > 0) {
            return matches;
        }
        const suffix = `-${sessionId}.jsonl`;
        return this.getWatchedFiles().filter((filePath) => filePath.endsWith(suffix));
    }

    private appendPendingEvents(filePath: string, events: CodexSessionEvent[], fileSessionId: string | null): void {
        if (events.length === 0) {
            return;
        }
        const existing = this.pendingEventsByFile.get(filePath);
        if (existing) {
            existing.events.push(...events);
            if (!existing.fileSessionId && fileSessionId) {
                existing.fileSessionId = fileSessionId;
            }
            return;
        }
        this.pendingEventsByFile.set(filePath, {
            events: [...events],
            fileSessionId
        });
    }

    private emitEvents(events: CodexSessionEvent[], fileSessionId: string | null): number {
        let emittedForFile = 0;
        for (const event of events) {
            const payload = asRecord(event.payload);
            const payloadSessionId = payload ? asString(payload.id) : null;
            const eventSessionId = payloadSessionId ?? fileSessionId ?? null;

            if (this.activeSessionId && eventSessionId && eventSessionId !== this.activeSessionId) {
                continue;
            }

            this.onEvent(event);
            emittedForFile += 1;
        }
        return emittedForFile;
    }

    private flushPendingEventsForSession(sessionId: string): void {
        if (this.pendingEventsByFile.size === 0) {
            return;
        }
        let emitted = 0;
        for (const [filePath, pending] of this.pendingEventsByFile.entries()) {
            const matches = (pending.fileSessionId && pending.fileSessionId === sessionId)
                || filePath.endsWith(`-${sessionId}.jsonl`);
            if (!matches) {
                continue;
            }
            emitted += this.emitEvents(pending.events, pending.fileSessionId);
        }
        this.pendingEventsByFile.clear();
        if (emitted > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emitted} pending events for session ${sessionId}`);
        }
    }
}

async function sortFilesByMtime(files: string[]): Promise<string[]> {
    const entries = await Promise.all(files.map(async (file) => {
        try {
            const stats = await stat(file);
            return { file, mtimeMs: stats.mtimeMs };
        } catch {
            return { file, mtimeMs: 0 };
        }
    }));

    return entries
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((entry) => entry.file);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

function normalizePath(value: string): string {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getSessionDatePrefixes(referenceTimestampMs: number, windowMs: number): Set<string> {
    const startDate = new Date(referenceTimestampMs - windowMs);
    const endDate = new Date(referenceTimestampMs + windowMs);
    const current = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const prefixes = new Set<string>();

    while (current <= last) {
        const year = String(current.getFullYear());
        const month = String(current.getMonth() + 1).padStart(2, '0');
        const day = String(current.getDate()).padStart(2, '0');
        prefixes.add(`${year}/${month}/${day}`);
        current.setDate(current.getDate() + 1);
    }

    return prefixes;
}

function shouldIncludeSessionPath(
    fullPath: string,
    sessionsRoot: string,
    prefixes: Set<string> | null
): boolean {
    if (!prefixes) {
        return true;
    }

    const relativePath = relative(sessionsRoot, fullPath);
    if (!relativePath || relativePath.startsWith('..')) {
        return true;
    }

    const normalized = relativePath.split(sep).filter(Boolean).join('/');
    if (!normalized) {
        return true;
    }

    for (const prefix of prefixes) {
        if (normalized === prefix) {
            return true;
        }
        if (normalized.startsWith(`${prefix}/`)) {
            return true;
        }
        if (prefix.startsWith(`${normalized}/`)) {
            return true;
        }
    }

    return false;
}
