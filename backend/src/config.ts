import 'dotenv/config';
import { z } from 'zod';

const intFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  PORT: intFromEnv(3001),
  CORS_ORIGIN: z.string().default('*'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  INTRO_MS: intFromEnv(30_000),
  TURN_MS: intFromEnv(20_000),
  RESULT_MS: intFromEnv(30_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  corsOrigin: env.CORS_ORIGIN,
  redisUrl: env.REDIS_URL,
  gemini: {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    enabled: env.GEMINI_API_KEY.length > 0,
  },
  durations: {
    introMs: env.INTRO_MS,
    turnMs: env.TURN_MS,
    resultMs: env.RESULT_MS,
  },
} as const;

export const SEGMENT_LEN = 5; // chars per player
export const SEATS = 6; // players per team
export const WINS_TO_TAKE_MATCH = 3; // best-of-5
export const EVENT_LOG_CAP = 200;
export const ROOM_TTL_SECONDS = 6 * 60 * 60;
