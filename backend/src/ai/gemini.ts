import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai';
import { config } from '../config.js';
import {
  judgeOutputSchema,
  topicOutputSchema,
  type JudgeOutput,
} from '../types/index.js';

const client = config.gemini.enabled
  ? new GoogleGenerativeAI(config.gemini.apiKey)
  : null;

const FALLBACK_TOPICS = [
  '如何降低校園能源消耗？',
  '設計一個未來城市',
  'AI 對教育的影響',
  '如何改善交通壅塞問題',
  '如何讓校園更友善包容？',
  '科技如何幫助環境永續？',
];

const criteriaSchema = {
  type: SchemaType.OBJECT,
  properties: {
    logic: { type: SchemaType.NUMBER },
    relevance: { type: SchemaType.NUMBER },
    completeness: { type: SchemaType.NUMBER },
    creativity: { type: SchemaType.NUMBER },
  },
  required: ['logic', 'relevance', 'completeness', 'creativity'],
} satisfies Schema;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

/** Generate a round topic. Falls back to a static pool on any failure. */
export async function generateTopic(): Promise<string> {
  if (!client) return pick(FALLBACK_TOPICS);
  try {
    const model = client.getGenerativeModel({
      model: config.gemini.model,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: { topic: { type: SchemaType.STRING } },
          required: ['topic'],
        },
        temperature: 1.1,
      },
    });
    const prompt =
      '你是遊戲出題官。產生一個適合中學生團隊在 30 字內回答的繁體中文題目，' +
      '主題涵蓋科技、教育、城市、環境等。題目需開放、可發揮，不含敏感內容。只回傳 JSON。';
    const res = await withTimeout(model.generateContent(prompt), 8000);
    const parsed = topicOutputSchema.parse(JSON.parse(res.response.text()));
    return parsed.topic;
  } catch (err) {
    console.warn('[gemini] topic generation failed, using fallback:', String(err));
    return pick(FALLBACK_TOPICS);
  }
}

export interface JudgeArgs {
  topic: string;
  answerA: string;
  answerB: string;
}

/** Judge both answers. Returns { result, degraded } — never throws. */
export async function judge(
  args: JudgeArgs,
): Promise<{ result: JudgeOutput; degraded: boolean }> {
  if (client) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callJudge(args);
        return { result, degraded: false };
      } catch (err) {
        console.warn(`[gemini] judge attempt ${attempt + 1} failed:`, String(err));
      }
    }
  }
  return { result: fallbackJudge(args), degraded: true };
}

async function callJudge(args: JudgeArgs): Promise<JudgeOutput> {
  const model = client!.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          scoreA: { type: SchemaType.NUMBER },
          scoreB: { type: SchemaType.NUMBER },
          winner: { type: SchemaType.STRING, enum: ['A', 'B', 'tie'] },
          reason: { type: SchemaType.STRING },
          breakdown: {
            type: SchemaType.OBJECT,
            properties: { A: criteriaSchema, B: criteriaSchema },
            required: ['A', 'B'],
          },
        },
        required: ['scoreA', 'scoreB', 'winner', 'reason', 'breakdown'],
      },
      temperature: 0.4,
    },
  });

  const prompt =
    '你是公正的 AI 評審。依下列權重評分（每項 0–100）：邏輯性25、題目符合度30、完整性25、創意性20。' +
    '依權重計算 A、B 兩隊總分（0–100）並選出勝隊。reason 為繁體中文、80 字內。只回傳符合 schema 的 JSON。\n' +
    `題目：${args.topic}\n` +
    `A 隊答案：${args.answerA}\n` +
    `B 隊答案：${args.answerB}`;

  const res = await withTimeout(model.generateContent(prompt), 15000);
  return judgeOutputSchema.parse(JSON.parse(res.response.text()));
}

/** Deterministic tiebreak so a judging failure never stalls the match. */
function fallbackJudge(args: JudgeArgs): JudgeOutput {
  const uniq = (s: string) => new Set([...s]).size;
  const a = uniq(args.answerA);
  const b = uniq(args.answerB);
  const scoreA = 50 + Math.min(40, a);
  const scoreB = 50 + Math.min(40, b);
  const winner = scoreA === scoreB ? 'tie' : scoreA > scoreB ? 'A' : 'B';
  const flat = { logic: 50, relevance: 50, completeness: 50, creativity: 50 };
  return {
    scoreA,
    scoreB,
    winner,
    reason: '（評審服務暫時無法使用，依答案豐富度自動評分）',
    breakdown: { A: { ...flat }, B: { ...flat } },
  };
}

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
