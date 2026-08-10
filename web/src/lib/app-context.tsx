import { createContext, useContext, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'

type AppContextValue = {
    api: ApiClient
    token: string
    baseUrl: string
    signOut?: () => void
    /** True when authenticated via a session share link — the UI shows only
     *  the one shared session and hides all navigation/session-list chrome. */
    sharedMode?: boolean
    /** The single session id a shared viewer is scoped to. */
    sharedSessionId?: string
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppContextProvider(props: {
    value: AppContextValue
    children: ReactNode
}) {
    return (
        <AppContext.Provider value={props.value}>
            {props.children}
        </AppContext.Provider>
    )
}

export function useAppContext(): AppContextValue {
    const context = useContext(AppContext)
    if (!context) {
        throw new Error('AppContext is not available')
    }
    return context
}

export function useOptionalAppContext(): AppContextValue | null {
    return useContext(AppContext)
}
