import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { RoomManager } from '../game/manager.js';
import {
  assignTeamSchema,
  joinSchema,
  rejoinSchema,
  setQuestionsSchema,
  setRulesSchema,
  setTopicSchema,
  submitSchema,
  teamSchema,
  type Ack,
  type Player,
  type Role,
  type TeamId,
} from '../types/index.js';

interface SocketData {
  roomId?: string;
  role?: Role;
  playerId?: string;
  team?: TeamId | null;
}

const teamRoom = (id: string, t: TeamId) => `${id}:t:${t}`;
const obsRoom = (id: string) => `${id}:obs`;

const fail = (ack: Ack | undefined, error: string) => ack?.({ ok: false, error });

export function registerGateway(io: Server): RoomManager {
  const manager = new RoomManager(io);

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;

    socket.on('room:join', async (payload: unknown, ack?: Ack) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      const { roomId, role, name, team } = parsed.data;

      const eng = await manager.getOrCreate(roomId, role === 'host' ? socket.id : null);
      data.roomId = roomId;
      data.role = role;
      socket.join(roomId);

      if (role === 'player') {
        const assigned = team ?? null;
        const player: Player = {
          playerId: randomUUID(),
          team: assigned,
          name: name?.trim() || '未命名裝置',
          connected: true,
          lastSeen: Date.now(),
          socketId: socket.id,
        };
        await eng.addPlayer(player);
        data.playerId = player.playerId;
        data.team = assigned;
        if (assigned) socket.join(teamRoom(roomId, assigned));
        ack?.({ ok: true, playerId: player.playerId, team: assigned });
        eng.emitState(socket.id, assigned ?? undefined);
        eng.emitPresence(socket.id);
        return;
      }

      // host / observer
      socket.join(obsRoom(roomId));
      if (role === 'host' && !eng.state.hostId) {
        eng.state.hostId = socket.id;
      }
      ack?.({ ok: true });
      eng.emitState(socket.id);
      eng.emitPresence(socket.id);
    });

    socket.on('room:rejoin', async (payload: unknown, ack?: Ack) => {
      const parsed = rejoinSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      const eng = await manager.get(parsed.data.roomId);
      if (!eng) return fail(ack, 'ROOM_NOT_FOUND');
      const player = eng.players.get(parsed.data.playerId);
      if (!player) return fail(ack, 'FORBIDDEN');
      if (!player.team && parsed.data.team) {
        await eng.assignTeam(player.playerId, parsed.data.team);
      }

      data.roomId = parsed.data.roomId;
      data.role = 'player';
      data.playerId = player.playerId;
      data.team = player.team;
      socket.join(parsed.data.roomId);
      if (player.team) socket.join(teamRoom(parsed.data.roomId, player.team));
      await eng.setConnected(player.playerId, true, socket.id);
      ack?.({ ok: true, team: player.team });
      eng.emitState(socket.id, player.team ?? undefined);
      eng.emitPresence(socket.id);
    });

    socket.on('match:start', async (_payload: unknown, ack?: Ack) => {
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      await eng.startMatch();
      ack?.({ ok: true });
    });

    socket.on('segment:submit', async (payload: unknown, ack?: Ack) => {
      const parsed = submitSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      if (data.role !== 'player' || !data.roomId || !data.playerId) {
        return fail(ack, 'FORBIDDEN');
      }
      const eng = await manager.get(data.roomId);
      if (!eng) return fail(ack, 'ROOM_NOT_FOUND');
      const res = await eng.submit(data.playerId, parsed.data.text);
      if (!res.ok) {
        socket.emit('error', { code: res.code, message: res.code });
        return fail(ack, res.code);
      }
      ack?.({ ok: true });
    });

    socket.on('host:skip_turn', async (payload: unknown, ack?: Ack) => {
      const parsed = teamSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      await eng.skipTurn(parsed.data.team);
      ack?.({ ok: true });
    });

    socket.on('host:pause', async (_p: unknown, ack?: Ack) => {
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      await eng.pause();
      ack?.({ ok: true });
    });

    socket.on('host:resume', async (_p: unknown, ack?: Ack) => {
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      await eng.resume();
      ack?.({ ok: true });
    });

    socket.on('host:force_judge', async (_p: unknown, ack?: Ack) => {
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      await eng.forceJudge();
      ack?.({ ok: true });
    });

    socket.on('host:assign_team', async (payload: unknown, ack?: Ack) => {
      const parsed = assignTeamSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      const ok = await eng.assignTeam(parsed.data.playerId, parsed.data.team);
      if (!ok) return fail(ack, 'FORBIDDEN');
      ack?.({ ok: true });
    });

    socket.on('host:set_questions', async (payload: unknown, ack?: Ack) => {
      const parsed = setQuestionsSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      await eng.setQuestions(parsed.data.questions);
      ack?.({ ok: true });
    });

    socket.on('host:set_topic', async (payload: unknown, ack?: Ack) => {
      const parsed = setTopicSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      const ok = await eng.setTopic(parsed.data);
      if (!ok) return fail(ack, 'NO_QUESTIONS');
      ack?.({ ok: true });
    });

    socket.on('host:set_rules', async (payload: unknown, ack?: Ack) => {
      const parsed = setRulesSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      const eng = await requireHost(manager, data);
      if (!eng) return fail(ack, 'FORBIDDEN');
      await eng.setRules(parsed.data);
      ack?.({ ok: true });
    });

    socket.on('observer:subscribe', async (_p: unknown, ack?: Ack) => {
      if (!data.roomId) return fail(ack, 'ROOM_NOT_FOUND');
      const eng = await manager.get(data.roomId);
      if (!eng) return fail(ack, 'ROOM_NOT_FOUND');
      socket.join(obsRoom(data.roomId));
      ack?.({ ok: true });
      eng.emitState(socket.id);
    });

    socket.on('disconnect', async () => {
      if (data.role === 'player' && data.roomId && data.playerId) {
        const eng = await manager.get(data.roomId);
        await eng?.setConnected(data.playerId, false);
      }
    });
  });

  return manager;
}

async function requireHost(manager: RoomManager, data: SocketData) {
  if (data.role !== 'host' || !data.roomId) return null;
  return manager.get(data.roomId);
}
