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

/** Per-room, host-editable rules. Seeded from env defaults on room creation. */
export interface RoomRules {
  introMs: number;
  turnMs: number;
  resultMs: number;
  seats: number; // players per team
  winsToTakeMatch: number;
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
  rules: RoomRules;
  questions: string[]; // host-curated question bank
  hostId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Player {
  playerId: string;
  team: TeamId | null; // null = joined but not yet assigned by the host
  name: string;
  connected: boolean;
  lastSeen: number;
  socketId?: string; // current socket, so the host can move it into a team room
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
  // Devices join unassigned and wait for the host to switch them to a team.
  team: z.enum(['A', 'B']).optional(),
});
export type JoinPayload = z.infer<typeof joinSchema>;

// Host assigns / switches a waiting device to a team (or null to un-assign).
export const assignTeamSchema = z.object({
  playerId: z.string().min(1).max(64),
  team: z.enum(['A', 'B']).nullable(),
});
export type AssignTeamPayload = z.infer<typeof assignTeamSchema>;

export const setQuestionsSchema = z.object({
  questions: z.array(z.string().min(1).max(60)).max(200),
});

export const rejoinSchema = z.object({
  roomId: z.string().min(1).max(64),
  playerId: z.string().min(1).max(64),
  team: z.enum(['A', 'B']).optional(),
});

export const submitSchema = z.object({ text: z.string() });
export const teamSchema = z.object({ team: z.enum(['A', 'B']) });

// Host chooses the next round's topic: an explicit question, or a random pick from the bank.
export const setTopicSchema = z
  .object({
    topic: z.string().min(1).max(60).optional(),
    random: z.boolean().optional(),
  })
  .refine((o) => o.topic !== undefined || o.random === true, { message: 'topic_or_random' });

// All fields optional — host may tweak any subset. Bounds keep the game sane.
export const setRulesSchema = z
  .object({
    introMs: z.number().int().min(3_000).max(300_000),
    turnMs: z.number().int().min(3_000).max(300_000),
    resultMs: z.number().int().min(3_000).max(300_000),
    seats: z.number().int().min(1).max(6),
    winsToTakeMatch: z.number().int().min(1).max(10),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: 'empty' });
export type SetRulesPayload = z.infer<typeof setRulesSchema>;

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
