import { io, Socket } from "socket.io-client"

const BACKEND_URL = import.meta.env.PUBLIC_BACKEND_URL ?? "http://localhost:3001"

export interface GameSession {
  roomId: string
  playerId: string
  team: "A" | "B" | null
  seat: number | null
  groupNumber: number
}

let socketInstance: Socket | null = null

export function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io(BACKEND_URL, {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    })
  }
  return socketInstance
}

export function saveSession(session: GameSession): void {
  localStorage.setItem("wc_room_id", session.roomId)
  localStorage.setItem("wc_player_id", session.playerId)
  localStorage.setItem("wc_group_number", String(session.groupNumber))

  if (session.team) {
    localStorage.setItem("wc_team", session.team)
  } else {
    localStorage.removeItem("wc_team")
  }

  if (session.seat !== null) {
    localStorage.setItem("wc_seat", String(session.seat))
  } else {
    localStorage.removeItem("wc_seat")
  }
}

export function getSession(): GameSession | null {
  const roomId = localStorage.getItem("wc_room_id")
  const playerId = localStorage.getItem("wc_player_id")
  const rawTeam = localStorage.getItem("wc_team")
  const rawSeat = localStorage.getItem("wc_seat")
  const rawGroupNumber = localStorage.getItem("wc_group_number")
  const groupNumber = rawGroupNumber ? Number(rawGroupNumber) : NaN
  const inferredTeam = !isNaN(groupNumber) ? (groupNumber <= 5 ? "A" : "B") : null
  const team = rawTeam === "A" || rawTeam === "B" ? rawTeam : inferredTeam
  const seat = rawSeat ? Number(rawSeat) : null

  if (roomId && playerId && (seat === null || !isNaN(seat)) && !isNaN(groupNumber)) {
    return { roomId, playerId, team, seat, groupNumber }
  }
  return null
}

export function clearSession(): void {
  localStorage.removeItem("wc_room_id")
  localStorage.removeItem("wc_player_id")
  localStorage.removeItem("wc_team")
  localStorage.removeItem("wc_seat")
  localStorage.removeItem("wc_group_number")
}
