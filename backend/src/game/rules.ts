import { SEATS, SEGMENT_LEN, WINS_TO_TAKE_MATCH } from '../config.js';
import type {
  RoomState,
  TeamId,
  TeamState,
  RoundResult,
  JudgeOutput,
} from '../types/index.js';

/** Grapheme-ish length by Unicode code points — correct for Chinese input. */
export const charCount = (s: string): number => [...s].length;

const freshTeam = (): TeamState => ({
  currentSeat: 1,
  segments: [],
  done: false,
  turnEndsAt: null,
});

export function createRoom(roomId: string, hostId: string | null): RoomState {
  const now = Date.now();
  return {
    roomId,
    phase: 'LOBBY',
    round: 0,
    topic: null,
    phaseEndsAt: null,
    paused: false,
    score: { A: 0, B: 0 },
    teams: { A: freshTeam(), B: freshTeam() },
    rounds: [],
    hostId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Begin a new round: reset team chains, bump round, set topic. */
export function startRound(state: RoomState, topic: string): RoomState {
  return {
    ...state,
    round: state.round + 1,
    topic,
    teams: { A: freshTeam(), B: freshTeam() },
  };
}

export const other = (team: TeamId): TeamId => (team === 'A' ? 'B' : 'A');

export const answerOf = (t: TeamState): string => t.segments.join('');

export const bothTeamsDone = (state: RoomState): boolean =>
  state.teams.A.done && state.teams.B.done;

/** Append a validated segment and advance the seat. Caller must validate first. */
export function appendSegment(state: RoomState, team: TeamId, text: string): RoomState {
  const prev = state.teams[team];
  const segments = [...prev.segments, text];
  const next: TeamState = advance({ ...prev, segments });
  return { ...state, teams: { ...state.teams, [team]: next } };
}

/** Record a forfeit (empty) segment for the current seat and advance. */
export function timeoutSegment(state: RoomState, team: TeamId): RoomState {
  const prev = state.teams[team];
  const segments = [...prev.segments, ''];
  const next = advance({ ...prev, segments });
  return { ...state, teams: { ...state.teams, [team]: next } };
}

function advance(t: TeamState): TeamState {
  const seat = t.currentSeat + 1;
  return { ...t, currentSeat: seat, done: t.segments.length >= SEATS };
}

export type SubmitError = 'NOT_YOUR_TURN' | 'BAD_LENGTH';

/** Pure validation for a player's submission attempt. */
export function validateSubmit(
  team: TeamState,
  seat: number,
  text: string,
): SubmitError | null {
  if (team.done || seat !== team.currentSeat) return 'NOT_YOUR_TURN';
  if (charCount(text) !== SEGMENT_LEN) return 'BAD_LENGTH';
  return null;
}

/** Apply a judge result to the score and round history. */
export function applyJudge(state: RoomState, judge: JudgeOutput): RoomState {
  const answerA = answerOf(state.teams.A);
  const answerB = answerOf(state.teams.B);
  // Server is authoritative on winner; derive from totals, ignore drift.
  const winner: TeamId | 'tie' =
    judge.scoreA === judge.scoreB ? 'tie' : judge.scoreA > judge.scoreB ? 'A' : 'B';

  const result: RoundResult = {
    round: state.round,
    topic: state.topic ?? '',
    answerA,
    answerB,
    scoreA: judge.scoreA,
    scoreB: judge.scoreB,
    winner,
    reason: judge.reason,
    breakdown: judge.breakdown,
  };

  const score = { ...state.score };
  if (winner !== 'tie') score[winner] += 1;

  return { ...state, score, rounds: [...state.rounds, result] };
}

export const isMatchOver = (state: RoomState): boolean =>
  state.score.A >= WINS_TO_TAKE_MATCH || state.score.B >= WINS_TO_TAKE_MATCH;

export const matchWinner = (state: RoomState): TeamId | null =>
  state.score.A >= WINS_TO_TAKE_MATCH ? 'A' : state.score.B >= WINS_TO_TAKE_MATCH ? 'B' : null;
