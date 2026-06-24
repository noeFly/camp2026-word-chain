import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { RoomManager } from '../game/manager.js';
import {
  joinSchema,
  rejoinSchema,
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
  team?: TeamId;
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
      const { roomId, role, name, team, seat } = parsed.data;

      const eng = await manager.getOrCreate(roomId, role === 'host' ? socket.id : null);
      data.roomId = roomId;
      data.role = role;
      socket.join(roomId);

      if (role === 'player') {
        if (!team || !seat) return fail(ack, 'INVALID_PAYLOAD');
        if (eng.seatTaken(team, seat)) return fail(ack, 'SEAT_TAKEN');
        const player: Player = {
          playerId: randomUUID(),
          team,
          seat,
          name: name ?? `Player ${team}${seat}`,
          connected: true,
          lastSeen: Date.now(),
        };
        await eng.addPlayer(player);
        data.playerId = player.playerId;
        data.team = team;
        socket.join(teamRoom(roomId, team));
        ack?.({ ok: true, playerId: player.playerId, team, seat });
        eng.emitState(socket.id, team);
        return;
      }

      // host / observer
      socket.join(obsRoom(roomId));
      if (role === 'host' && !eng.state.hostId) {
        eng.state.hostId = socket.id;
      }
      ack?.({ ok: true });
      eng.emitState(socket.id);
    });

    socket.on('room:rejoin', async (payload: unknown, ack?: Ack) => {
      const parsed = rejoinSchema.safeParse(payload);
      if (!parsed.success) return fail(ack, 'INVALID_PAYLOAD');
      const eng = await manager.get(parsed.data.roomId);
      if (!eng) return fail(ack, 'ROOM_NOT_FOUND');
      const player = eng.players.get(parsed.data.playerId);
      if (!player) return fail(ack, 'FORBIDDEN');

      data.roomId = parsed.data.roomId;
      data.role = 'player';
      data.playerId = player.playerId;
      data.team = player.team;
      socket.join(parsed.data.roomId);
      socket.join(teamRoom(parsed.data.roomId, player.team));
      await eng.setConnected(player.playerId, true);
      ack?.({ ok: true, team: player.team, seat: player.seat });
      eng.emitState(socket.id, player.team);
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
