import { z } from 'zod';

export type Phase =
  | 'LOBBY'
  | 'ROUND_INTRO'
  | 'CHAINING'
  | 'JUDGING'
  | 'ROUND_RESULT'
  | 'MATCH_OVER';

export type TeamId = 'A' | 'B';
export type Role = 'player' | 'host' | 'observer';

export interface TeamState {
  currentSeat: number; // 1..SEATS, or SEATS+1 when done
  segments: string[]; // index i = seat i+1
  done: boolean;
  turnEndsAt: number | null; // epoch ms — deadline for the current seat
}

export interface RoundResult {
  round: number;
  topic: string;
  answerA: string;
  answerB: string;
  scoreA: number;
  scoreB: number;
  winner: TeamId | 'tie';
  reason: string;
  breakdown: JudgeBreakdown;
  degraded?: boolean;
}

export interface RoomState {
  roomId: string;
  phase: Phase;
  round: number; // 1-based
  topic: string | null;
  phaseEndsAt: number | null; // epoch ms
  paused: boolean;
  score: { A: number; B: number }; // round wins
  teams: { A: TeamState; B: TeamState };
  rounds: RoundResult[];
  hostId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Player {
  playerId: string;
  team: TeamId;
  seat: number; // 1..SEATS
  name: string;
  connected: boolean;
  lastSeen: number;
}

export interface EventLogEntry {
  ts: number;
  type:
    | 'phase_change'
    | 'segment_submitted'
    | 'turn_timeout'
    | 'host_action'
    | 'judge_result'
    | 'player_join'
    | 'player_disconnect';
  team?: TeamId;
  seat?: number;
  detail?: unknown;
}

// ---- Gemini judge output ----
const criteria = z.object({
  logic: z.number().min(0).max(100),
  relevance: z.number().min(0).max(100),
  completeness: z.number().min(0).max(100),
  creativity: z.number().min(0).max(100),
});
export type Criteria = z.infer<typeof criteria>;

export const judgeOutputSchema = z.object({
  scoreA: z.number().min(0).max(100),
  scoreB: z.number().min(0).max(100),
  winner: z.enum(['A', 'B', 'tie']),
  reason: z.string().max(200),
  breakdown: z.object({ A: criteria, B: criteria }),
});
export type JudgeOutput = z.infer<typeof judgeOutputSchema>;
export type JudgeBreakdown = JudgeOutput['breakdown'];

export const topicOutputSchema = z.object({ topic: z.string().min(1).max(60) });

// ---- Inbound socket payloads ----
export const joinSchema = z.object({
  roomId: z.string().min(1).max(64),
  role: z.enum(['player', 'host', 'observer']),
  name: z.string().min(1).max(40).optional(),
  team: z.enum(['A', 'B']).optional(),
  seat: z.number().int().min(1).max(6).optional(),
});
export type JoinPayload = z.infer<typeof joinSchema>;

export const rejoinSchema = z.object({
  roomId: z.string().min(1).max(64),
  playerId: z.string().min(1).max(64),
});

export const submitSchema = z.object({ text: z.string() });
export const teamSchema = z.object({ team: z.enum(['A', 'B']) });

export type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string }) => void;

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'SEAT_TAKEN'
  | 'NOT_YOUR_TURN'
  | 'BAD_LENGTH'
  | 'ALREADY_SUBMITTED'
  | 'FORBIDDEN'
  | 'INVALID_PAYLOAD'
  | 'WRONG_PHASE';
