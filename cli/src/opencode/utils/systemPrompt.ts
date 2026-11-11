/**
 * OpenCode-specific system prompt for hapi MCP tools (change_title, display_image, display_video, display_media).
 *
 * OpenCode exposes MCP tools with the naming pattern: <server-name>_<tool-name>
 * The hapi MCP server exposes `change_title`, `display_image`, `display_video`, and `display_media`.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildSessionCitationSteerInstruction, SESSION_CITATION_DISABLED_STEER } from '@hapi/protocol/sessionCitation';
import { isPeerToolsDisabled } from '@/modules/common/peerTools';
import { HAPI_MCP_BRIDGE_PROMPT } from '@/modules/common/hapiMcpBridgePrompt';
import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction';
import { withSessionJobInstruction } from '@/modules/common/sessionJobInstruction';
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction';
import { isPeerCollaborationEnabled } from '@/modules/common/peerCollaboration';

/**
 * Title and display_image / display_video / display_media instructions for OpenCode to call the hapi MCP tools.
 */
function buildTitleInstruction(env: NodeJS.ProcessEnv = process.env): string {
    return trimIdent(`
    ${HAPI_MCP_BRIDGE_PROMPT}
    ${isPeerToolsDisabled(env) ? SESSION_CITATION_DISABLED_STEER : buildSessionCitationSteerInstruction({
        inspectTool: 'hapi_inspect_peer',
        pingTool: 'hapi_ping_peer',
        listPeersTool: 'hapi_list_peers',
        spawnTool: 'hapi_spawn_peer',
        enabled: isPeerCollaborationEnabled(env),
    })}
    ${SKILL_LOOKUP_INSTRUCTION}
`);
}

export const TITLE_INSTRUCTION = buildTitleInstruction();

export function getTitleInstruction(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(withSessionJobInstruction(buildTitleInstruction(env)), env)
}

/**
 * Instruction prepended to native ACP session prompts. change_title rides the
 * same MCP bridge; manual titles take precedence over native ACP title sync.
 */
function buildNativeToolInstruction(env: NodeJS.ProcessEnv = process.env): string {
    return trimIdent(`
    ${HAPI_MCP_BRIDGE_PROMPT}
    ${isPeerToolsDisabled(env) ? SESSION_CITATION_DISABLED_STEER : buildSessionCitationSteerInstruction({
        inspectTool: 'hapi_inspect_peer',
        pingTool: 'hapi_ping_peer',
        listPeersTool: 'hapi_list_peers',
        spawnTool: 'hapi_spawn_peer',
        enabled: isPeerCollaborationEnabled(env),
    })}
    ${SKILL_LOOKUP_INSTRUCTION}
`);
}

export const OPENCODE_NATIVE_TOOL_INSTRUCTION = buildNativeToolInstruction();

export function getOpencodeNativeToolInstruction(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(withSessionJobInstruction(buildNativeToolInstruction(env)), env)
}

/**
 * The system prompt to inject for OpenCode sessions.
 */
export const opencodeSystemPrompt = TITLE_INSTRUCTION;

/**
 * Instruction prepended to OpenCode prompts while HAPI plan mode is active.
 */
export const PLAN_MODE_INSTRUCTION = trimIdent(`
    You are in plan mode. Do not execute tools or make changes. Analyze the request, ask clarifying questions if needed, and respond with a concise implementation plan only.
`);
