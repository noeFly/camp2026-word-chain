import { io, Socket } from "socket.io-client"

const ENV_BACKEND_URL = import.meta.env.PUBLIC_BACKEND_URL

export function getBackendCandidates(): string[] {
  const candidates = new Set<string>()

  if (ENV_BACKEND_URL) {
    candidates.add(ENV_BACKEND_URL)
  }

  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location
    candidates.add(`${protocol}//${hostname}:3002`)
    candidates.add(`${protocol}//${hostname}:3001`)
  }

  candidates.add("http://127.0.0.1:3002")
  candidates.add("http://127.0.0.1:3001")
  candidates.add("http://localhost:3002")
  candidates.add("http://localhost:3001")

  return [...candidates]
}

export function getBackendUrl(): string {
  return getBackendCandidates()[0]!
}

export async function fetchBackend(path: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = null

  for (const baseUrl of getBackendCandidates()) {
    try {
      const response = await fetch(`${baseUrl}${path}`, init)
      if (response.ok) {
        return response
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error("BACKEND_UNREACHABLE")
}

export interface GameSession {
  roomId: string
  playerId: string
  team: "A" | "B" | null
  seat: number | null
  groupNumber?: number
}

const SESSION_KEYS = {
  roomId: "wc_room_id",
  playerId: "wc_player_id",
  team: "wc_team",
  seat: "wc_seat",
  groupNumber: "wc_group_number",
} as const

let socketInstance: Socket | null = null
let socketCandidateIndex = 0

function attachSocketFallback(socket: Socket) {
  socket.on("connect", () => {
    socketCandidateIndex = 0
  })

  socket.on("connect_error", () => {
    const candidates = getBackendCandidates()
    if (socket.connected || socket.active) return
    if (socketCandidateIndex >= candidates.length - 1) return

    socketCandidateIndex += 1
    const nextUrl = candidates[socketCandidateIndex]
    if (!nextUrl) return
    const manager = socket.io as any
    const parsed = new URL(nextUrl)

    manager.uri = nextUrl
    manager.opts.hostname = parsed.hostname
    manager.opts.port = parsed.port
    manager.opts.secure = parsed.protocol === "https:"
    socket.connect()
  })
}

export function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io(getBackendUrl(), {
      autoConnect: false,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    })
    attachSocketFallback(socketInstance)
  }
  return socketInstance
}

export function saveSession(session: GameSession): void {
  sessionStorage.setItem(SESSION_KEYS.roomId, session.roomId)
  sessionStorage.setItem(SESSION_KEYS.playerId, session.playerId)
  if (session.groupNumber !== undefined) {
    sessionStorage.setItem(SESSION_KEYS.groupNumber, String(session.groupNumber))
  } else {
    sessionStorage.removeItem(SESSION_KEYS.groupNumber)
  }

  if (session.team) {
    sessionStorage.setItem(SESSION_KEYS.team, session.team)
  } else {
    sessionStorage.removeItem(SESSION_KEYS.team)
  }

  if (session.seat !== null) {
    sessionStorage.setItem(SESSION_KEYS.seat, String(session.seat))
  } else {
    sessionStorage.removeItem(SESSION_KEYS.seat)
  }

  clearLegacySession()
}

export function updateSessionAssignment(
  team: "A" | "B" | null,
  groupNumber?: number | null
): void {
  if (team) {
    sessionStorage.setItem(SESSION_KEYS.team, team)
  } else {
    sessionStorage.removeItem(SESSION_KEYS.team)
  }

  if (typeof groupNumber === "number") {
    sessionStorage.setItem(SESSION_KEYS.groupNumber, String(groupNumber))
  } else if (groupNumber === null) {
    sessionStorage.removeItem(SESSION_KEYS.groupNumber)
  }

  clearLegacySession()
}

export function updateSessionTeam(team: "A" | "B" | null): void {
  updateSessionAssignment(team)
}

export function getSession(): GameSession | null {
  migrateLegacySession()

  const roomId = sessionStorage.getItem(SESSION_KEYS.roomId)
  const playerId = sessionStorage.getItem(SESSION_KEYS.playerId)
  const rawTeam = sessionStorage.getItem(SESSION_KEYS.team)
  const rawSeat = sessionStorage.getItem(SESSION_KEYS.seat)
  const rawGroupNumber = sessionStorage.getItem(SESSION_KEYS.groupNumber)
  const groupNumber = rawGroupNumber ? Number(rawGroupNumber) : undefined
  const team = rawTeam === "A" || rawTeam === "B" ? rawTeam : null
  const seat = rawSeat ? Number(rawSeat) : null

  if (
    roomId &&
    playerId &&
    (seat === null || !isNaN(seat)) &&
    (groupNumber === undefined || !isNaN(groupNumber))
  ) {
    return { roomId, playerId, team, seat, groupNumber }
  }
  return null
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEYS.roomId)
  sessionStorage.removeItem(SESSION_KEYS.playerId)
  sessionStorage.removeItem(SESSION_KEYS.team)
  sessionStorage.removeItem(SESSION_KEYS.seat)
  sessionStorage.removeItem(SESSION_KEYS.groupNumber)
  clearLegacySession()
}

function migrateLegacySession(): void {
  if (sessionStorage.getItem(SESSION_KEYS.playerId)) return

  const legacyRoomId = localStorage.getItem(SESSION_KEYS.roomId)
  const legacyPlayerId = localStorage.getItem(SESSION_KEYS.playerId)
  if (!legacyRoomId || !legacyPlayerId) return

  sessionStorage.setItem(SESSION_KEYS.roomId, legacyRoomId)
  sessionStorage.setItem(SESSION_KEYS.playerId, legacyPlayerId)

  const legacyTeam = localStorage.getItem(SESSION_KEYS.team)
  const legacySeat = localStorage.getItem(SESSION_KEYS.seat)
  const legacyGroupNumber = localStorage.getItem(SESSION_KEYS.groupNumber)

  if (legacyTeam) sessionStorage.setItem(SESSION_KEYS.team, legacyTeam)
  if (legacySeat) sessionStorage.setItem(SESSION_KEYS.seat, legacySeat)
  if (legacyGroupNumber) sessionStorage.setItem(SESSION_KEYS.groupNumber, legacyGroupNumber)

  clearLegacySession()
}

function clearLegacySession(): void {
  localStorage.removeItem(SESSION_KEYS.roomId)
  localStorage.removeItem(SESSION_KEYS.playerId)
  localStorage.removeItem(SESSION_KEYS.team)
  localStorage.removeItem(SESSION_KEYS.seat)
  localStorage.removeItem(SESSION_KEYS.groupNumber)
}
