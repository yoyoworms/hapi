import type { CommandDefinition } from './types'

export const statusLineForwarderCommand: CommandDefinition = {
    name: 'statusline-forwarder',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        const { runStatusLineForwarder } = await import('@/claude/utils/statusLineForwarder')
        await runStatusLineForwarder(commandArgs)
    }
}
