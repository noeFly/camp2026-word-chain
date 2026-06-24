import type { Server } from 'socket.io';
import { config, SEATS } from '../config.js';
import * as repo from '../state/roomRepo.js';
import { generateTopic, judge } from '../ai/gemini.js';
import {
  appendSegment,
  applyJudge,
  bothTeamsDone,
  createRoom,
  isMatchOver,
  matchWinner,
  startRound,
  timeoutSegment,
  validateSubmit,
} from './rules.js';
import type { EventLogEntry, Player, RoomState, TeamId } from '../types/index.js';

const r = (id: string) => id; // global room
const teamRoom = (id: string, t: TeamId) => `${id}:t:${t}`;
const obsRoom = (id: string) => `${id}:obs`;

/** Owns one room's state, timers, persistence and broadcasts. */
export class GameEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pausedRemaining = new Map<string, number>();

  private constructor(
    public state: RoomState,
    private readonly io: Server,
    public players = new Map<string, Player>(),
  ) {}

  static async create(roomId: string, hostId: string | null, io: Server): Promise<GameEngine> {
    const eng = new GameEngine(createRoom(roomId, hostId), io);
    await eng.save();
    return eng;
  }

  static async rehydrate(state: RoomState, io: Server): Promise<GameEngine> {
    const players = await repo.loadPlayers(state.roomId);
    const eng = new GameEngine(state, io, new Map(players.map((p) => [p.playerId, p])));
    if (!state.paused) eng.scheduleAll();
    return eng;
  }

  // ---------- players ----------
  async addPlayer(p: Player): Promise<void> {
    this.players.set(p.playerId, p);
    await repo.savePlayer(this.state.roomId, p);
    await this.log({ ts: Date.now(), type: 'player_join', team: p.team, seat: p.seat });
    this.broadcastPresence();
  }

  async setConnected(playerId: string, connected: boolean): Promise<void> {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = connected;
    p.lastSeen = Date.now();
    await repo.savePlayer(this.state.roomId, p);
    if (!connected) {
      await this.log({ ts: Date.now(), type: 'player_disconnect', team: p.team, seat: p.seat });
    }
    this.broadcastPresence();
  }

  seatTaken(team: TeamId, seat: number): boolean {
    return [...this.players.values()].some((p) => p.team === team && p.seat === seat);
  }

  // ---------- host actions ----------
  async startMatch(): Promise<void> {
    if (this.state.phase !== 'LOBBY' && this.state.phase !== 'ROUND_RESULT') return;
    await this.toRoundIntro();
  }

  async pause(): Promise<void> {
    if (this.state.paused) return;
    const now = Date.now();
    for (const [key, endsAt] of this.activeDeadlines()) {
      this.pausedRemaining.set(key, Math.max(0, endsAt - now));
    }
    this.clearTimers();
    this.state.paused = true;
    await this.save();
    await this.log({ ts: now, type: 'host_action', detail: 'pause' });
    this.broadcastState();
  }

  async resume(): Promise<void> {
    if (!this.state.paused) return;
    const now = Date.now();
    for (const [key, remaining] of this.pausedRemaining) {
      const endsAt = now + remaining;
      if (key === 'phase') this.state.phaseEndsAt = endsAt;
      else if (key === 'turn:A') this.state.teams.A.turnEndsAt = endsAt;
      else if (key === 'turn:B') this.state.teams.B.turnEndsAt = endsAt;
    }
    this.pausedRemaining.clear();
    this.state.paused = false;
    await this.save();
    this.scheduleAll();
    await this.log({ ts: now, type: 'host_action', detail: 'resume' });
    this.broadcastState();
  }

  async forceJudge(): Promise<void> {
    if (this.state.phase !== 'CHAINING') return;
    await this.log({ ts: Date.now(), type: 'host_action', detail: 'force_judge' });
    await this.toJudging();
  }

  async skipTurn(team: TeamId): Promise<void> {
    if (this.state.phase !== 'CHAINING' || this.state.teams[team].done) return;
    await this.handleTurnTimeout(team, 'host_skip');
  }

  // ---------- player action ----------
  async submit(
    playerId: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; code: 'WRONG_PHASE' | 'FORBIDDEN' | 'NOT_YOUR_TURN' | 'BAD_LENGTH' }> {
    if (this.state.phase !== 'CHAINING') return { ok: false, code: 'WRONG_PHASE' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, code: 'FORBIDDEN' };
    const team = this.state.teams[p.team];
    const err = validateSubmit(team, p.seat, text);
    if (err) return { ok: false, code: err };

    this.state = appendSegment(this.state, p.team, text);
    this.setTurnDeadline(p.team);
    await this.log({ ts: Date.now(), type: 'segment_submitted', team: p.team, seat: p.seat, detail: text });
    this.io.to(teamRoom(this.state.roomId, p.team)).emit('segment:accepted', {
      team: p.team,
      seat: p.seat,
      text,
    });

    if (bothTeamsDone(this.state)) {
      await this.toJudging();
    } else {
      this.scheduleAll();
      await this.save();
      this.emitTurnChanged(p.team);
      this.broadcastState();
    }
    return { ok: true };
  }

  // ---------- phase transitions ----------
  private async toRoundIntro(): Promise<void> {
    const topic = await generateTopic();
    this.state = startRound(this.state, topic);
    this.state.phase = 'ROUND_INTRO';
    this.state.phaseEndsAt = Date.now() + config.durations.introMs;
    await this.save();
    await this.log({ ts: Date.now(), type: 'phase_change', detail: 'ROUND_INTRO' });
    this.io.to(r(this.state.roomId)).emit('round:intro', {
      round: this.state.round,
      topic,
      phaseEndsAt: this.state.phaseEndsAt,
    });
    this.scheduleAll();
    this.broadcastState();
  }

  private async beginChaining(): Promise<void> {
    this.state.phase = 'CHAINING';
    this.state.phaseEndsAt = null;
    this.setTurnDeadline('A');
    this.setTurnDeadline('B');
    await this.save();
    await this.log({ ts: Date.now(), type: 'phase_change', detail: 'CHAINING' });
    this.scheduleAll();
    this.emitTurnChanged('A');
    this.emitTurnChanged('B');
    this.broadcastState();
  }

  private async handleTurnTimeout(team: TeamId, kind: 'timeout' | 'host_skip' = 'timeout'): Promise<void> {
    this.state = timeoutSegment(this.state, team);
    this.setTurnDeadline(team);
    await this.log({
      ts: Date.now(),
      type: kind === 'timeout' ? 'turn_timeout' : 'host_action',
      team,
      detail: kind,
    });
    if (bothTeamsDone(this.state)) {
      await this.toJudging();
    } else {
      this.scheduleAll();
      await this.save();
      this.emitTurnChanged(team);
      this.broadcastState();
    }
  }

  private async toJudging(): Promise<void> {
    this.clearTimers();
    this.state.phase = 'JUDGING';
    this.state.phaseEndsAt = null;
    for (const t of ['A', 'B'] as const) this.state.teams[t].turnEndsAt = null;
    await this.save();
    await this.log({ ts: Date.now(), type: 'phase_change', detail: 'JUDGING' });
    this.io.to(r(this.state.roomId)).emit('judging:started', { round: this.state.round });
    this.broadcastState();

    const { result, degraded } = await judge({
      topic: this.state.topic ?? '',
      answerA: this.state.teams.A.segments.join(''),
      answerB: this.state.teams.B.segments.join(''),
    });
    this.state = applyJudge(this.state, result);
    const last = this.state.rounds[this.state.rounds.length - 1]!;
    last.degraded = degraded;
    await this.log({ ts: Date.now(), type: 'judge_result', detail: { ...last } });
    await this.toRoundResult();
  }

  private async toRoundResult(): Promise<void> {
    const last = this.state.rounds[this.state.rounds.length - 1]!;
    if (isMatchOver(this.state)) {
      this.state.phase = 'ROUND_RESULT';
    } else {
      this.state.phase = 'ROUND_RESULT';
      this.state.phaseEndsAt = Date.now() + config.durations.resultMs;
    }
    await this.save();
    await this.log({ ts: Date.now(), type: 'phase_change', detail: 'ROUND_RESULT' });
    this.io.to(r(this.state.roomId)).emit('round:result', {
      round: last.round,
      scoreA: last.scoreA,
      scoreB: last.scoreB,
      winner: last.winner,
      reason: last.reason,
      breakdown: last.breakdown,
      degraded: last.degraded,
    });
    this.broadcastState();

    if (isMatchOver(this.state)) {
      await this.toMatchOver();
    } else {
      this.scheduleAll();
    }
  }

  private async toMatchOver(): Promise<void> {
    this.clearTimers();
    this.state.phase = 'MATCH_OVER';
    this.state.phaseEndsAt = null;
    await this.save();
    await this.log({ ts: Date.now(), type: 'phase_change', detail: 'MATCH_OVER' });
    this.io.to(r(this.state.roomId)).emit('match:over', {
      winner: matchWinner(this.state),
      finalScore: { ...this.state.score },
    });
    this.broadcastState();
  }

  // ---------- timers ----------
  private setTurnDeadline(team: TeamId): void {
    const t = this.state.teams[team];
    t.turnEndsAt = t.done ? null : Date.now() + config.durations.turnMs;
  }

  private activeDeadlines(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    const s = this.state;
    if ((s.phase === 'ROUND_INTRO' || s.phase === 'ROUND_RESULT') && s.phaseEndsAt) {
      out.push(['phase', s.phaseEndsAt]);
    }
    if (s.phase === 'CHAINING') {
      if (!s.teams.A.done && s.teams.A.turnEndsAt) out.push(['turn:A', s.teams.A.turnEndsAt]);
      if (!s.teams.B.done && s.teams.B.turnEndsAt) out.push(['turn:B', s.teams.B.turnEndsAt]);
    }
    return out;
  }

  private scheduleAll(): void {
    this.clearTimers();
    if (this.state.paused) return;
    const now = Date.now();
    for (const [key, endsAt] of this.activeDeadlines()) {
      const delay = Math.max(0, endsAt - now);
      this.timers.set(
        key,
        setTimeout(() => void this.onTimer(key), delay),
      );
    }
  }

  private async onTimer(key: string): Promise<void> {
    this.timers.delete(key);
    const phase = this.state.phase;
    if (key === 'phase' && phase === 'ROUND_INTRO') return void this.beginChaining();
    if (key === 'phase' && phase === 'ROUND_RESULT') return void this.toRoundIntro();
    if (key === 'turn:A' && phase === 'CHAINING') return void this.handleTurnTimeout('A');
    if (key === 'turn:B' && phase === 'CHAINING') return void this.handleTurnTimeout('B');
  }

  private clearTimers(): void {
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
  }

  dispose(): void {
    this.clearTimers();
  }

  // ---------- emit ----------
  emitState(socketId: string, team?: TeamId): void {
    this.io.to(socketId).emit('room:state', team ? this.playerSnapshot(team) : this.fullSnapshot());
  }

  private emitTurnChanged(team: TeamId): void {
    const t = this.state.teams[team];
    this.io.to(teamRoom(this.state.roomId, team)).emit('turn:changed', {
      team,
      currentSeat: t.currentSeat,
      phaseEndsAt: t.turnEndsAt,
      segments: t.segments,
    });
  }

  private broadcastState(): void {
    const id = this.state.roomId;
    this.io.to(obsRoom(id)).emit('room:state', this.fullSnapshot());
    this.io.to(teamRoom(id, 'A')).emit('room:state', this.playerSnapshot('A'));
    this.io.to(teamRoom(id, 'B')).emit('room:state', this.playerSnapshot('B'));
  }

  private broadcastPresence(): void {
    const players = [...this.players.values()].map((p) => ({
      playerId: p.playerId,
      team: p.team,
      seat: p.seat,
      name: p.name,
      connected: p.connected,
    }));
    this.io.to(r(this.state.roomId)).emit('presence:update', { players });
  }

  private base() {
    const s = this.state;
    return {
      roomId: s.roomId,
      phase: s.phase,
      round: s.round,
      topic: s.topic,
      phaseEndsAt: s.phaseEndsAt,
      paused: s.paused,
      score: s.score,
    };
  }

  fullSnapshot() {
    return { ...this.base(), teams: this.state.teams };
  }

  /** Hides the opponent's segment text (kept as length-preserving blanks). */
  private playerSnapshot(team: TeamId) {
    const opp = team === 'A' ? 'B' : 'A';
    const o = this.state.teams[opp];
    return {
      ...this.base(),
      teams: {
        [team]: this.state.teams[team],
        [opp]: {
          currentSeat: o.currentSeat,
          done: o.done,
          turnEndsAt: o.turnEndsAt,
          segments: o.segments.map(() => ''),
        },
      },
    };
  }

  private async save(): Promise<void> {
    await repo.saveRoom(this.state);
  }

  private async log(entry: EventLogEntry): Promise<void> {
    await repo.pushEvent(this.state.roomId, entry);
  }
}

export const FULL_SEGMENTS = SEATS; // re-export for clarity in tests
