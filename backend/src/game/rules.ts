import { config, SEATS, SEGMENT_LEN, WINS_TO_TAKE_MATCH } from '../config.js';
import type {
  GroupMatchup,
  MatchMode,
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

const DEFAULT_FORMAL_MATCHUPS: GroupMatchup[] = [
  { groupA: 1, groupB: 2 },
  { groupA: 3, groupB: 4 },
  { groupA: 5, groupB: 6 },
  { groupA: 7, groupB: 8 },
  { groupA: 9, groupB: 10 },
];

export const FALLBACK_MATCHUP: GroupMatchup = { groupA: 1, groupB: 2 };

export function createRoom(roomId: string, hostId: string | null): RoomState {
  const now = Date.now();
  return {
    roomId,
    matchMode: 'formal',
    currentGameNumber: 0,
    matchupCursor: 0,
    phase: 'LOBBY',
    round: 0,
    topic: null,
    phaseEndsAt: null,
    paused: false,
    score: { A: 0, B: 0 },
    teams: { A: freshTeam(), B: freshTeam() },
    rounds: [],
    activeMatchup: null,
    matchups: DEFAULT_FORMAL_MATCHUPS,
    nextMatchup: null,
    rules: {
      introMs: config.durations.introMs,
      turnMs: config.durations.turnMs,
      resultMs: config.durations.resultMs,
      seats: SEATS,
      winsToTakeMatch: WINS_TO_TAKE_MATCH,
    },
    questions: [],
    nextTopic: null,
    hostId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Begin a new round: reset team chains, bump round, set topic. */
export function startRound(state: RoomState, topic: string, _matchup: GroupMatchup): RoomState {
  return {
    ...state,
    round: state.round + 1,
    activeMatchup: _matchup,
    topic,
    nextTopic: null,
    nextMatchup: state.matchMode === 'test' ? null : state.nextMatchup,
    teams: { A: freshTeam(), B: freshTeam() },
  };
}

export function scheduledMatchupForRound(state: RoomState, roundNumber: number): GroupMatchup | null {
  return state.matchups[roundNumber - 1] ?? null;
}

export function currentMatchup(state: RoomState): GroupMatchup | null {
  if (state.phase === 'LOBBY') {
    if (state.matchMode === 'formal') return state.matchups[state.matchupCursor] ?? null;
    return state.nextMatchup ?? state.activeMatchup ?? FALLBACK_MATCHUP;
  }
  if (state.phase === 'ROUND_RESULT') {
    if (state.matchMode === 'formal') return state.activeMatchup ?? state.matchups[state.matchupCursor] ?? null;
    return state.nextMatchup ?? state.activeMatchup ?? FALLBACK_MATCHUP;
  }
  if (state.activeMatchup) return state.activeMatchup;
  if (state.matchMode === 'test') return state.nextMatchup ?? FALLBACK_MATCHUP;
  return state.matchups[state.matchupCursor] ?? null;
}

export const other = (team: TeamId): TeamId => (team === 'A' ? 'B' : 'A');

export const answerOf = (t: TeamState): string => t.segments.join('');

export const bothTeamsDone = (state: RoomState): boolean =>
  state.teams.A.done && state.teams.B.done;

/** Append a validated segment and advance the seat. Caller must validate first. */
export function appendSegment(state: RoomState, team: TeamId, text: string): RoomState {
  const prev = state.teams[team];
  const segments = [...prev.segments, text];
  const next: TeamState = advance({ ...prev, segments }, state.rules.seats);
  return { ...state, teams: { ...state.teams, [team]: next } };
}

/** Record a forfeit (empty) segment for the current seat and advance. */
export function timeoutSegment(state: RoomState, team: TeamId): RoomState {
  const prev = state.teams[team];
  const segments = [...prev.segments, ''];
  const next = advance({ ...prev, segments }, state.rules.seats);
  return { ...state, teams: { ...state.teams, [team]: next } };
}

function advance(t: TeamState, seats: number): TeamState {
  const seat = t.currentSeat + 1;
  return { ...t, currentSeat: seat, done: t.segments.length >= seats };
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
  const matchup = state.activeMatchup ?? scheduledMatchupForRound(state, state.round) ?? state.nextMatchup ?? FALLBACK_MATCHUP;
  // Server is authoritative on winner; derive from totals, ignore drift.
  const winner: TeamId | 'tie' =
    judge.scoreA === judge.scoreB ? 'tie' : judge.scoreA > judge.scoreB ? 'A' : 'B';

  const result: RoundResult = {
    gameNumber: state.currentGameNumber,
    round: state.round,
    matchup,
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
  state.score.A >= state.rules.winsToTakeMatch || state.score.B >= state.rules.winsToTakeMatch;

export const matchWinner = (state: RoomState): TeamId | null =>
  state.score.A >= state.rules.winsToTakeMatch
    ? 'A'
    : state.score.B >= state.rules.winsToTakeMatch
      ? 'B'
      : null;

export function normalizeMatchups(mode: MatchMode, matchups?: GroupMatchup[]): GroupMatchup[] {
  if (mode === 'formal') return matchups?.length ? matchups : DEFAULT_FORMAL_MATCHUPS;
  return [];
}

export function hasUpcomingMatchup(state: RoomState): boolean {
  if (state.matchMode === 'test') return Boolean(state.nextMatchup);
  return state.matchupCursor < state.matchups.length;
}
