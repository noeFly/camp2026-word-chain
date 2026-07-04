import type { Server } from 'socket.io';
import { config, SEATS, WINS_TO_TAKE_MATCH } from '../config.js';
import * as repo from '../state/roomRepo.js';
import { generateTopic, judge } from '../ai/gemini.js';
import {
  advanceSeatWhenReady,
  appendSegment,
  applyJudge,
  bothTeamsDone,
  canAdvanceSeatManually,
  currentMatchup,
  hasSubmittedCurrentSeat,
  createRoom,
  isMatchOver,
  matchWinner,
  normalizeMatchups,
  startRound,
  timeoutSegment,
  validateSubmit,
} from './rules.js';
import type {
  EventLogEntry,
  GroupMatchup,
  MatchMode,
  Player,
  RoomRules,
  RoomState,
  TeamId,
} from '../types/index.js';

const r = (id: string) => id; // global room
const teamRoom = (id: string, t: TeamId) => `${id}:t:${t}`;
const obsRoom = (id: string) => `${id}:obs`;

/** Owns one room's state, timers, persistence and broadcasts. */
export class GameEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pausedRemaining = new Map<string, number>();
  private judgeToken = 0;
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
    // Backfill rules for rooms persisted before per-room rules existed.
    state.rules ??= {
      introMs: config.durations.introMs,
      turnMs: config.durations.turnMs,
      resultMs: config.durations.resultMs,
      seats: SEATS,
      winsToTakeMatch: WINS_TO_TAKE_MATCH,
    };
    state.questions ??= [];
    state.nextTopic ??= null;
    state.matchMode ??= 'formal';
    state.currentGameNumber ??= 0;
    state.matchupCursor ??= 0;
    state.activeMatchup ??= null;
    state.matchups ??= normalizeMatchups(state.matchMode);
    state.nextMatchup ??= null;
    const players = await repo.loadPlayers(state.roomId);
    const eng = new GameEngine(state, io, new Map(players.map((p) => [p.playerId, p])));
    if (!state.paused) eng.scheduleAll();
    return eng;
  }

  // ---------- players ----------
  async addPlayer(p: Player): Promise<void> {
    if (p.team) await this.clearTeamHolder(p.team, p.playerId);
    this.players.set(p.playerId, p);
    await repo.savePlayer(this.state.roomId, p);
    await this.log({ ts: Date.now(), type: 'player_join', team: p.team ?? undefined });
    this.broadcastPresence();
  }

  async setConnected(playerId: string, connected: boolean, socketId?: string): Promise<void> {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = connected;
    p.lastSeen = Date.now();
    if (connected && socketId) p.socketId = socketId;
    await repo.savePlayer(this.state.roomId, p);
    if (!connected) {
      await this.log({ ts: Date.now(), type: 'player_disconnect', team: p.team ?? undefined });
    }
    this.broadcastPresence();
  }

  /** Host assigns / switches a waiting device to a team (or null to release it). */
  async assignTeam(playerId: string, team: TeamId | null): Promise<boolean> {
    const p = this.players.get(playerId);
    if (!p) return false;

    if (team) await this.clearTeamHolder(team, playerId);
    p.team = team;
    p.groupNumber = team ? this.groupNumberForTeam(team) : null;
    await repo.savePlayer(this.state.roomId, p);
    this.moveSocketToTeam(p.socketId, team);
    await this.log({ ts: Date.now(), type: 'host_action', detail: { assignTeam: { playerId, team } } });
    this.broadcastPresence();
    // Push the right view to the (re)assigned device.
    if (p.socketId) {
      this.io.to(p.socketId).emit('room:state', team ? this.playerSnapshot(team) : this.fullSnapshot());
    }
    return true;
  }

  async removePlayer(playerId: string): Promise<boolean> {
    const player = this.players.get(playerId);
    if (!player) return false;

    this.players.delete(playerId);
    await repo.deletePlayer(this.state.roomId, playerId);
    this.moveSocketToTeam(player.socketId, null);
    if (player.socketId) {
      this.io.to(player.socketId).emit('room:kicked', { playerId });
      this.io.sockets.sockets.get(player.socketId)?.disconnect(true);
    }
    await this.log({ ts: Date.now(), type: 'host_action', detail: { removePlayer: playerId } });
    this.broadcastPresence();
    return true;
  }

  private moveSocketToTeam(socketId: string | undefined, team: TeamId | null): void {
    if (!socketId) return;
    const id = this.state.roomId;
    this.io.in(socketId).socketsLeave([teamRoom(id, 'A'), teamRoom(id, 'B')]);
    if (team) this.io.in(socketId).socketsJoin(teamRoom(id, team));
  }

  /** Host loads / replaces the question bank. */
  async setQuestions(questions: string[]): Promise<void> {
    this.state.questions = questions;
    await this.save();
    await this.log({ ts: Date.now(), type: 'host_action', detail: { setQuestions: questions.length } });
    this.broadcastState();
  }

  async clearHistory(): Promise<void> {
    this.state.rounds = [];
    this.state.currentGameNumber = 0;
    await this.save();
    await repo.clearEvents(this.state.roomId);
    await this.log({ ts: Date.now(), type: 'host_action', detail: 'clear_history' });
    this.broadcastState();
  }

  async setMatchConfig(matchMode: MatchMode, matchups?: GroupMatchup[]): Promise<void> {
    this.state.matchMode = matchMode;
    this.state.currentGameNumber = 0;
    this.state.matchupCursor = 0;
    this.state.matchups = normalizeMatchups(matchMode, matchups);
    if (matchMode !== 'test') this.state.nextMatchup = null;
    this.state.activeMatchup = null;
    this.state.round = 0;
    this.state.score = { A: 0, B: 0 };
    this.state.phase = 'LOBBY';
    this.state.phaseEndsAt = null;
    await this.resetAssignedPlayers();
    await this.save();
    await this.log({
      ts: Date.now(),
      type: 'host_action',
      detail: { setMatchConfig: { matchMode, matchups: this.state.matchups } },
    });
    this.broadcastState();
    this.broadcastPresence();
  }

  async setNextMatchup(matchup: GroupMatchup): Promise<boolean> {
    if (this.state.matchMode !== 'test') return false;
    this.state.nextMatchup = matchup;
    await this.resetAssignedPlayers();
    await this.save();
    await this.log({ ts: Date.now(), type: 'host_action', detail: { setNextMatchup: matchup } });
    this.broadcastState();
    this.broadcastPresence();
    return true;
  }

  // ---------- host actions ----------
  async startMatch(): Promise<boolean> {
    if (this.state.phase !== 'LOBBY' && this.state.phase !== 'ROUND_RESULT') return false;
    if (!this.resolveUpcomingMatchup()) return false;
    await this.toRoundIntro();
    return true;
  }

  async endGame(): Promise<boolean> {
    if (this.state.phase !== 'MATCH_OVER') return false;
    this.clearTimers();
    if (this.state.matchMode === 'formal' && this.state.activeMatchup) {
      this.state.matchupCursor += 1;
    }
    this.state.phase = 'LOBBY';
    this.state.phaseEndsAt = null;
    this.state.round = 0;
    this.state.topic = null;
    this.state.nextTopic = null;
    this.state.activeMatchup = null;
    this.state.score = { A: 0, B: 0 };
    this.state.teams = {
      A: { currentSeat: 1, segments: [], done: false, turnEndsAt: null },
      B: { currentSeat: 1, segments: [], done: false, turnEndsAt: null },
    };
    await this.resetAssignedPlayers();
    await this.save();
    await this.log({ ts: Date.now(), type: 'host_action', detail: 'end_game' });
    this.broadcastState();
    this.broadcastPresence();
    return true;
  }

  async forceEndCurrentGame(): Promise<boolean> {
    if (this.state.phase === 'LOBBY') return false;
    this.clearTimers();
    this.judgeToken += 1;
    this.state.phase = 'MATCH_OVER';
    this.state.phaseEndsAt = null;
    this.state.paused = false;
    for (const t of ['A', 'B'] as const) {
      this.state.teams[t].turnEndsAt = null;
    }
    await this.save();
    await this.log({ ts: Date.now(), type: 'host_action', detail: 'force_end_current_game' });
    this.io.to(r(this.state.roomId)).emit('match:over', {
      winner: matchWinner(this.state),
      finalScore: { ...this.state.score },
      forced: true,
    });
    this.broadcastState();
    return true;
  }

  async pause(): Promise<boolean> {
    if (this.state.paused) return false;
    const now = Date.now();
    for (const [key, endsAt] of this.activeDeadlines()) {
      this.pausedRemaining.set(key, Math.max(0, endsAt - now));
    }
    this.clearTimers();
    this.state.paused = true;
    await this.save();
    await this.log({ ts: now, type: 'host_action', detail: 'pause' });
    this.broadcastState();
    return true;
  }

  async resume(): Promise<boolean> {
    if (!this.state.paused) return false;
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
    return true;
  }

  async forceJudge(): Promise<boolean> {
    if (this.state.phase !== 'CHAINING') return false;
    await this.log({ ts: Date.now(), type: 'host_action', detail: 'force_judge' });
    await this.toJudging();
    return true;
  }

  /** Host chooses the next round's topic — an explicit question or a random pick from the bank. */
  async setTopic(opts: { topic?: string; random?: boolean }): Promise<boolean> {
    const topic = opts.random ? this.randomQuestion() : opts.topic;
    if (!topic) return false; // random requested but bank empty

    this.state.nextTopic = topic;
    if (this.state.phase === 'ROUND_INTRO') {
      this.state.topic = topic;
      this.state.nextTopic = null;
    }

    await this.save();
    this.broadcastState();
    await this.log({ ts: Date.now(), type: 'host_action', detail: { setTopic: topic } });
    return true;
  }

  private randomQuestion(): string | null {
    const q = this.state.questions ?? [];
    return q.length ? q[Math.floor(Math.random() * q.length)]! : null;
  }

  /** Host edits rules; takes effect immediately, rescheduling any active timer. */
  async setRules(patch: Partial<RoomRules>): Promise<void> {
    const now = Date.now();
    this.state.rules = { ...this.state.rules, ...patch };
    const rules = this.state.rules;

    // Re-anchor active deadlines to the new durations so the change is felt now.
    if (!this.state.paused) {
      if (this.state.phase === 'ROUND_INTRO' && this.state.phaseEndsAt) {
        this.state.phaseEndsAt = now + rules.introMs;
      } else if (this.state.phase === 'ROUND_RESULT' && this.state.phaseEndsAt) {
        this.state.phaseEndsAt = now + rules.resultMs;
      }
      this.scheduleAll();
    }
    await this.save();
    await this.log({ ts: now, type: 'host_action', detail: { setRules: patch } });
    this.broadcastState();
  }

  async skipTurn(team: TeamId): Promise<boolean> {
    if (this.state.phase !== 'CHAINING' || this.state.teams[team].done || hasSubmittedCurrentSeat(this.state.teams[team]))
      return false;
    await this.handleTurnTimeout(team, 'host_skip');
    return true;
  }

  async advanceSeat(): Promise<boolean> {
    if (this.state.phase !== 'CHAINING' || !canAdvanceSeatManually(this.state)) return false;
    this.state = advanceSeatWhenReady(this.state);
    await this.log({ ts: Date.now(), type: 'host_action', detail: 'advance_seat' });
    if (bothTeamsDone(this.state)) {
      await this.toJudging();
    } else {
      await this.save();
      this.emitTurnChanged('A');
      this.emitTurnChanged('B');
      this.broadcastState();
    }
    return true;
  }

  // ---------- player action ----------
  async submit(
    playerId: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; code: 'WRONG_PHASE' | 'FORBIDDEN' | 'NOT_YOUR_TURN' | 'BAD_LENGTH' }> {
    if (this.state.phase !== 'CHAINING') return { ok: false, code: 'WRONG_PHASE' };
    const p = this.players.get(playerId);
    if (!p || !p.team) return { ok: false, code: 'FORBIDDEN' };
    const team = this.state.teams[p.team];
    // One device per team submits each seat in turn, so the active seat is always the team's.
    const seat = team.currentSeat;
    const err = validateSubmit(team, seat, text);
    if (err) return { ok: false, code: err };

    this.state = appendSegment(this.state, p.team, text);
    this.clearTurnDeadline(p.team);
    await this.log({ ts: Date.now(), type: 'segment_submitted', team: p.team, seat, detail: text });
    this.io.to(teamRoom(this.state.roomId, p.team)).emit('segment:accepted', {
      team: p.team,
      seat,
      text,
    });

    await this.save();
    this.emitTurnChanged(p.team);
    this.broadcastState();
    return { ok: true };
  }

  // ---------- phase transitions ----------
  private async toRoundIntro(): Promise<void> {
    // Topic priority: host's explicit/random pick → random from bank → AI/fallback generator.
    const topic = this.state.nextTopic ?? this.randomQuestion() ?? (await generateTopic());
    const matchup = this.resolveUpcomingMatchup();
    if (!matchup) return;
    if (this.state.phase === 'LOBBY') {
      this.state.currentGameNumber += 1;
    }
    this.state = startRound(this.state, topic, matchup);
    if (this.state.matchMode === 'test') {
      this.state.nextMatchup = null;
    }
    this.state.phase = 'ROUND_INTRO';
    this.state.phaseEndsAt = Date.now() + this.state.rules.introMs;
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
    this.state.teams.A.turnEndsAt = null;
    this.state.teams.B.turnEndsAt = null;
    await this.save();
    await this.log({ ts: Date.now(), type: 'phase_change', detail: 'CHAINING' });
    this.emitTurnChanged('A');
    this.emitTurnChanged('B');
    this.broadcastState();
  }

  private async handleTurnTimeout(team: TeamId, kind: 'timeout' | 'host_skip' = 'timeout'): Promise<void> {
    this.state = timeoutSegment(this.state, team);
    this.clearTurnDeadline(team);
    await this.log({
      ts: Date.now(),
      type: kind === 'timeout' ? 'turn_timeout' : 'host_action',
      team,
      detail: kind,
    });
    await this.save();
    this.emitTurnChanged(team);
    this.broadcastState();
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

    const token = ++this.judgeToken;
    const { result, degraded } = await judge({
      topic: this.state.topic ?? '',
      answerA: this.state.teams.A.segments.join(''),
      answerB: this.state.teams.B.segments.join(''),
    });
    if (token !== this.judgeToken || this.state.phase !== 'JUDGING') return;
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
      this.state.phaseEndsAt = Date.now() + this.state.rules.resultMs;
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

    if (isMatchOver(this.state)) await this.toMatchOver();
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
  private clearTurnDeadline(team: TeamId): void {
    this.state.teams[team].turnEndsAt = null;
  }

  private activeDeadlines(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    const s = this.state;
    if ((s.phase === 'ROUND_INTRO' || s.phase === 'ROUND_RESULT') && s.phaseEndsAt) {
      out.push(['phase', s.phaseEndsAt]);
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

  private presenceList() {
    return [...this.players.values()].map((p) => ({
      playerId: p.playerId,
      team: p.team, // null = waiting for the host to assign a team
      groupNumber: p.groupNumber,
      name: p.name,
      connected: p.connected,
    }));
  }

  private broadcastPresence(): void {
    this.io.to(r(this.state.roomId)).emit('presence:update', { players: this.presenceList() });
  }

  /** Sends the current presence roster to a single freshly-joined socket. */
  emitPresence(socketId: string): void {
    this.io.to(socketId).emit('presence:update', { players: this.presenceList() });
  }

  private base() {
    const s = this.state;
    return {
      roomId: s.roomId,
      phase: s.phase,
      currentGameNumber: s.currentGameNumber,
      round: s.round,
      topic: s.topic,
      phaseEndsAt: s.phaseEndsAt,
      paused: s.paused,
      score: s.score,
      rounds: s.rounds,
      matchMode: s.matchMode,
      matchupCursor: s.matchupCursor,
      matchups: s.matchups,
      nextMatchup: s.nextMatchup,
      currentMatchup: currentMatchup(s),
      rules: s.rules,
      questions: s.questions,
      nextTopic: s.nextTopic,
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

  private async clearTeamHolder(team: TeamId, exceptPlayerId?: string): Promise<void> {
    for (const player of this.players.values()) {
      if (player.playerId !== exceptPlayerId && player.team === team) {
        player.team = null;
        player.groupNumber = null;
        await repo.savePlayer(this.state.roomId, player);
        this.moveSocketToTeam(player.socketId, null);
        if (player.socketId) this.io.to(player.socketId).emit('room:state', this.fullSnapshot());
      }
    }
  }

  private groupNumberForTeam(team: TeamId): number | null {
    const matchup = currentMatchup(this.state);
    if (!matchup) return null;
    return team === 'A' ? matchup.groupA : matchup.groupB;
  }

  private resolveUpcomingMatchup(): GroupMatchup | null {
    if (this.state.phase === 'ROUND_RESULT' && this.state.activeMatchup && !isMatchOver(this.state)) {
      return this.state.activeMatchup;
    }
    if (this.state.matchMode === 'test') return this.state.nextMatchup;
    return this.state.matchups[this.state.matchupCursor] ?? null;
  }

  private async resetAssignedPlayers(): Promise<void> {
    for (const player of this.players.values()) {
      if (!player.team && player.groupNumber == null) continue;
      player.team = null;
      player.groupNumber = null;
      await repo.savePlayer(this.state.roomId, player);
      this.moveSocketToTeam(player.socketId, null);
      if (player.socketId) this.io.to(player.socketId).emit('room:state', this.fullSnapshot());
    }
  }

  private async log(entry: EventLogEntry): Promise<void> {
    await repo.pushEvent(this.state.roomId, entry);
  }
}

export const FULL_SEGMENTS = SEATS; // re-export for clarity in tests
