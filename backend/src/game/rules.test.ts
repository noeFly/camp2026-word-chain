import { describe, expect, it } from 'vitest';
import {
  appendSegment,
  applyJudge,
  bothTeamsDone,
  charCount,
  createRoom,
  isMatchOver,
  startRound,
  timeoutSegment,
  validateSubmit,
} from './rules.js';
import type { JudgeOutput, RoomState } from '../types/index.js';

const fullChain = (state: RoomState, team: 'A' | 'B', word = '一二三四五') => {
  let s = state;
  for (let i = 0; i < 6; i++) s = appendSegment(s, team, word);
  return s;
};

describe('charCount', () => {
  it('counts chinese chars by code point', () => {
    expect(charCount('一二三四五')).toBe(5);
    expect(charCount('abc')).toBe(3);
  });
});

describe('validateSubmit', () => {
  it('rejects wrong seat', () => {
    const s = startRound(createRoom('r', null), 'topic');
    expect(validateSubmit(s.teams.A, 2, '一二三四五')).toBe('NOT_YOUR_TURN');
  });
  it('rejects wrong length', () => {
    const s = startRound(createRoom('r', null), 'topic');
    expect(validateSubmit(s.teams.A, 1, '一二三四')).toBe('BAD_LENGTH');
  });
  it('accepts valid', () => {
    const s = startRound(createRoom('r', null), 'topic');
    expect(validateSubmit(s.teams.A, 1, '一二三四五')).toBeNull();
  });
});

describe('chaining', () => {
  it('advances seat and marks done after 6 segments', () => {
    let s = startRound(createRoom('r', null), 'topic');
    s = fullChain(s, 'A');
    expect(s.teams.A.done).toBe(true);
    expect(s.teams.A.segments).toHaveLength(6);
    expect(s.teams.A.currentSeat).toBe(7);
  });

  it('bothTeamsDone only when both reach 6', () => {
    let s = startRound(createRoom('r', null), 'topic');
    s = fullChain(s, 'A');
    expect(bothTeamsDone(s)).toBe(false);
    s = fullChain(s, 'B');
    expect(bothTeamsDone(s)).toBe(true);
  });

  it('timeout records an empty segment and advances', () => {
    let s = startRound(createRoom('r', null), 'topic');
    s = timeoutSegment(s, 'A');
    expect(s.teams.A.segments).toEqual(['']);
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
    let s = startRound(createRoom('r', null), 'topic');
    s = applyJudge(s, judge(80, 60));
    expect(s.score.A).toBe(1);
    expect(s.rounds[0]!.winner).toBe('A');
  });

  it('match over at 3 round wins', () => {
    let s = startRound(createRoom('r', null), 'topic');
    for (let i = 0; i < 3; i++) {
      s = startRound(s, 'topic');
      s = applyJudge(s, judge(90, 10));
    }
    expect(isMatchOver(s)).toBe(true);
    expect(s.score.A).toBe(3);
  });
});
