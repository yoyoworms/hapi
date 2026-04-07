import type { ClientToServerEvents, ServerToClientEvents } from '@hapi/protocol'
import type { DefaultEventsMap, Server, Socket } from 'socket.io'

export type SocketData = {
    namespace?: string
    userId?: number
    clockOffset?: number  // hubTime - clientTime (ms), used to normalize client timestamps to Hub time
}

export type SocketServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>
export type SocketWithData = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>
export type CliSocketServer = Server<ServerToClientEvents, ClientToServerEvents, DefaultEventsMap, SocketData>
export type CliSocketWithData = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>
