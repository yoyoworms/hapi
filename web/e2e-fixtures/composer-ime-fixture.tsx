import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
    AssistantRuntimeProvider,
    type ChatModelAdapter,
    useLocalRuntime,
} from '@assistant-ui/react'
import '../src/index.css'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { I18nProvider } from '../src/lib/i18n-context'

declare global {
    interface Window {
        __composerImeE2E?: {
            setPending: (pending: boolean) => void
            rerender: () => void
        }
    }
}

const adapter: ChatModelAdapter = {
    async *run() {},
}

function Harness() {
    const runtime = useLocalRuntime(adapter)
    const [pending, setPending] = useState(false)
    const [, setRenderVersion] = useState(0)
    window.__composerImeE2E = {
        setPending,
        rerender: () => setRenderVersion((version) => version + 1),
    }

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <I18nProvider>
                <div className="mx-auto mt-20 max-w-2xl">
                    <HappyComposer sessionId="composer-ime-e2e" sendPending={pending} />
                </div>
            </I18nProvider>
        </AssistantRuntimeProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <Harness />
    </React.StrictMode>,
)
