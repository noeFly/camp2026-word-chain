import { Redis } from 'ioredis';
import { config, EVENT_LOG_CAP, ROOM_TTL_SECONDS } from '../config.js';
import type { EventLogEntry, Player, RoomState } from '../types/index.js';

export const redis = new Redis(config.redisUrl, { lazyConnect: true });

const NS = 'wc';
const roomKey = (id: string) => `${NS}:room:${id}`;
const playersKey = (id: string) => `${NS}:room:${id}:players`;
const eventsKey = (id: string) => `${NS}:room:${id}:events`;
const ROOMS_SET = `${NS}:rooms`;

/** Persist full room state (single JSON doc) + refresh TTLs + index the room. */
export async function saveRoom(state: RoomState): Promise<void> {
  const id = state.roomId;
  state.updatedAt = Date.now();
  const pipe = redis.pipeline();
  pipe.set(roomKey(id), JSON.stringify(state), 'EX', ROOM_TTL_SECONDS);
  pipe.sadd(ROOMS_SET, id);
  pipe.expire(playersKey(id), ROOM_TTL_SECONDS);
  pipe.expire(eventsKey(id), ROOM_TTL_SECONDS);
  await pipe.exec();
}

export async function loadRoom(id: string): Promise<RoomState | null> {
  const raw = await redis.get(roomKey(id));
  return raw ? (JSON.parse(raw) as RoomState) : null;
}

export async function roomExists(id: string): Promise<boolean> {
  return (await redis.exists(roomKey(id))) === 1;
}

export async function deleteRoom(id: string): Promise<void> {
  await redis
    .pipeline()
    .del(roomKey(id), playersKey(id), eventsKey(id))
    .srem(ROOMS_SET, id)
    .exec();
}

export async function listRoomIds(): Promise<string[]> {
  return redis.smembers(ROOMS_SET);
}

// ---- players ----
export async function savePlayer(roomId: string, p: Player): Promise<void> {
  await redis.hset(playersKey(roomId), p.playerId, JSON.stringify(p));
  await redis.expire(playersKey(roomId), ROOM_TTL_SECONDS);
}

export async function loadPlayers(roomId: string): Promise<Player[]> {
  const map = await redis.hgetall(playersKey(roomId));
  return Object.values(map).map((v) => JSON.parse(v) as Player);
}

// ---- event log (capped) ----
export async function pushEvent(roomId: string, entry: EventLogEntry): Promise<void> {
  await redis
    .pipeline()
    .lpush(eventsKey(roomId), JSON.stringify(entry))
    .ltrim(eventsKey(roomId), 0, EVENT_LOG_CAP - 1)
    .expire(eventsKey(roomId), ROOM_TTL_SECONDS)
    .exec();
}

export async function getEvents(roomId: string, limit = 50): Promise<EventLogEntry[]> {
  const raw = await redis.lrange(eventsKey(roomId), 0, limit - 1);
  return raw.map((v) => JSON.parse(v) as EventLogEntry);
}
