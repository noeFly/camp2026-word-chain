import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { currentMatchup } from './game/rules.js';
import { redis } from './state/roomRepo.js';
import * as repo from './state/roomRepo.js';
import { registerGateway } from './socket/gateway.js';

async function main() {
  await redis.connect();
  console.log(`[redis] connected → ${config.redisUrl}`);
  if (!config.gemini.enabled) {
    console.warn('[gemini] GEMINI_API_KEY not set — using fallback topics & judge.');
  }

  const httpServer = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', config.corsOrigin);
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    const match = req.url?.match(/^\/(?:api\/)?rooms\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const roomId = decodeURIComponent(match[1]!);
      void repo.loadRoom(roomId).then((state) => {
        if (!state) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'ROOM_NOT_FOUND' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            roomId: state.roomId,
            phase: state.phase,
            round: state.round,
            matchMode: state.matchMode ?? 'formal',
            matchupCursor: state.matchupCursor ?? 0,
            currentMatchup: currentMatchup(state),
            matchups: state.matchups ?? [],
            nextMatchup: state.nextMatchup ?? null,
            rounds: state.rounds ?? [],
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, methods: ['GET', 'POST'] },
  });

  const manager = registerGateway(io);
  const restored = await manager.rehydrateAll();
  console.log(`[game] rehydrated ${restored} room(s)`);

  httpServer.listen(config.port, () => {
    console.log(`[http] listening on :${config.port}`);
  });

  const shutdown = async () => {
    console.log('\n[shutdown] closing…');
    manager.dispose();
    io.close();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
