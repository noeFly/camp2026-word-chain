import { describe, expect, it } from 'vitest';
import {
  advanceSeatWhenReady,
  appendSegment,
  applyJudge,
  areBothTeamsReadyForNextSeat,
  bothTeamsDone,
  canAdvanceSeatManually,
  charCount,
  FALLBACK_MATCHUP,
  createRoom,
  isMatchOver,
  startRound,
  timeoutSegment,
  validateSubmit,
} from './rules.js';
import type { JudgeOutput, RoomState } from '../types/index.js';

describe('charCount', () => {
  it('counts chinese chars by code point', () => {
    expect(charCount('一二三四五')).toBe(5);
    expect(charCount('abc')).toBe(3);
  });
});

describe('validateSubmit', () => {
  it('rejects wrong seat', () => {
    const s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    expect(validateSubmit(s.teams.A, 2, '一二三四五')).toBe('NOT_YOUR_TURN');
  });
  it('rejects wrong length', () => {
    const s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    expect(validateSubmit(s.teams.A, 1, '一二三四')).toBe('BAD_LENGTH');
  });
  it('accepts valid', () => {
    const s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    expect(validateSubmit(s.teams.A, 1, '一二三四五')).toBeNull();
  });

  it('rejects submitting the same seat twice before the other team finishes', () => {
    let s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    s = appendSegment(s, 'A', '一二三四五');
    expect(validateSubmit(s.teams.A, 1, '五四三二一')).toBe('NOT_YOUR_TURN');
  });
});

describe('chaining', () => {
  it('waits for both teams to finish the same seat before advancing', () => {
    let s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    s = appendSegment(s, 'A', '一二三四五');
    expect(areBothTeamsReadyForNextSeat(s)).toBe(false);
    expect(canAdvanceSeatManually(s)).toBe(false);
    expect(s.teams.A.currentSeat).toBe(1);
    expect(s.teams.B.currentSeat).toBe(1);

    s = appendSegment(s, 'B', '甲乙丙丁戊');
    expect(areBothTeamsReadyForNextSeat(s)).toBe(true);
    expect(canAdvanceSeatManually(s)).toBe(true);

    s = advanceSeatWhenReady(s);
    expect(s.teams.A.currentSeat).toBe(2);
    expect(s.teams.B.currentSeat).toBe(2);
  });

  it('advances seat and marks done after 6 paired segments', () => {
    let s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    for (let i = 0; i < 6; i++) {
      s = appendSegment(s, 'A', '一二三四五');
      s = appendSegment(s, 'B', '甲乙丙丁戊');
      s = advanceSeatWhenReady(s);
    }
    expect(s.teams.A.done).toBe(true);
    expect(s.teams.B.done).toBe(true);
    expect(s.teams.A.segments).toHaveLength(6);
    expect(s.teams.A.currentSeat).toBe(7);
  });

  it('bothTeamsDone only when both reach 6', () => {
    let s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    for (let i = 0; i < 5; i++) {
      s = appendSegment(s, 'A', '一二三四五');
      s = appendSegment(s, 'B', '甲乙丙丁戊');
      s = advanceSeatWhenReady(s);
    }
    expect(bothTeamsDone(s)).toBe(false);

    s = appendSegment(s, 'A', '一二三四五');
    s = appendSegment(s, 'B', '甲乙丙丁戊');
    s = advanceSeatWhenReady(s);
    expect(bothTeamsDone(s)).toBe(true);
  });

  it('timeout records an empty segment and waits for the other team before advancing', () => {
    let s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    s = timeoutSegment(s, 'A');
    expect(s.teams.A.segments).toEqual(['']);
    expect(s.teams.A.currentSeat).toBe(1);

    s = timeoutSegment(s, 'B');
    s = advanceSeatWhenReady(s);
    expect(s.teams.A.currentSeat).toBe(2);
  });
});

describe('judging', () => {
  const judge = (scoreA: number, scoreB: number): JudgeOutput => ({
    scoreA,
    scoreB,
    winner: 'tie',
    reason: 'x',
    breakdown: {
      A: { logic: 0, relevance: 0, completeness: 0, creativity: 0 },
      B: { logic: 0, relevance: 0, completeness: 0, creativity: 0 },
    },
  });

  it('derives winner from totals, ignoring model field', () => {
    let s = startRound(createRoom('r', null), 'topic', FALLBACK_MATCHUP);
    s = applyJudge(s, judge(80, 60));
    expect(s.score.A).toBe(1);
    expect(s.rounds[0]!.winner).toBe('A');
  });

  it('match ends after reaching winsToTakeMatch', () => {
    let s = createRoom('r', null);
    for (let i = 0; i < s.rules.winsToTakeMatch; i++) {
      s = startRound(s, 'topic', FALLBACK_MATCHUP);
      s = applyJudge(s, judge(90, 10));
    }
    expect(isMatchOver(s)).toBe(true);
    expect(s.score.A).toBe(s.rules.winsToTakeMatch);
  });
});
