import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { redis } from './state/roomRepo.js';
import { registerGateway } from './socket/gateway.js';

async function main() {
  await redis.connect();
  console.log(`[redis] connected → ${config.redisUrl}`);
  if (!config.gemini.enabled) {
    console.warn('[gemini] GEMINI_API_KEY not set — using fallback topics & judge.');
  }

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
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
