import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { PushNotificationChannel } from './pushNotificationChannel'
import type { PushPayload } from './pushService'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-task-toast',
        namespace: 'default',
        name: 'Demo task',
        active: true,
        metadata: { flavor: 'codex' },
        ...overrides
    } as Session
}

describe('PushNotificationChannel', () => {
    it('always sends task notifications via push (visibility optimization intentionally removed)', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            ''
        )

        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'Background work finished'
        })

        expect(pushed).toHaveLength(1)
    })

    it('does not reuse one replacement tag for all task notifications in a session', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            ''
        )

        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'First task'
        })
        await channel.sendTaskNotification(createSession(), {
            status: 'failed',
            summary: 'Second task'
        })

        expect(pushed).toHaveLength(2)
        expect(pushed[0].payload.tag).toBeUndefined()
        expect(pushed[1].payload.tag).toBeUndefined()
    })
})
