import type { Server } from 'socket.io';
import * as repo from '../state/roomRepo.js';
import { GameEngine } from './engine.js';

/** In-memory registry of live room engines, backed by Redis for recovery. */
export class RoomManager {
  private engines = new Map<string, GameEngine>();

  constructor(private readonly io: Server) {}

  /** Load engine from memory or rehydrate from Redis. Null if room doesn't exist. */
  async get(roomId: string): Promise<GameEngine | null> {
    const cached = this.engines.get(roomId);
    if (cached) return cached;
    const state = await repo.loadRoom(roomId);
    if (!state) return null;
    const eng = await GameEngine.rehydrate(state, this.io);
    this.engines.set(roomId, eng);
    return eng;
  }

  async getOrCreate(roomId: string, hostId: string | null): Promise<GameEngine> {
    const existing = await this.get(roomId);
    if (existing) return existing;
    const eng = await GameEngine.create(roomId, hostId, this.io);
    this.engines.set(roomId, eng);
    return eng;
  }

  /** On boot: restore every active room and restart its timers. */
  async rehydrateAll(): Promise<number> {
    const ids = await repo.listRoomIds();
    let restored = 0;
    for (const id of ids) {
      const state = await repo.loadRoom(id);
      if (!state) {
        await repo.deleteRoom(id); // stale index entry
        continue;
      }
      this.engines.set(id, await GameEngine.rehydrate(state, this.io));
      restored++;
    }
    return restored;
  }

  dispose(): void {
    for (const e of this.engines.values()) e.dispose();
    this.engines.clear();
  }
}
