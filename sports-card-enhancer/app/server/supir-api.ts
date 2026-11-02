import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SCHEMA } from './supir-schema.js';

export const MAX_INPUT_BYTES = 1536 * 1024;
export type Query = (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
export type Transaction = (queries: { text: string; values?: unknown[] }[]) => Promise<Record<string, unknown>[][]>;
type Environment = Record<string, string | undefined>;

class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function authorized(header: unknown, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || typeof header !== 'string' || header.length > 1024) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export function validateInput(body: unknown) {
  if (!body || typeof body !== 'object') throw new RequestError(400, 'Expected a JSON image request.');
  const b = body as Record<string, unknown>;
  if (typeof b.image !== 'string' || b.image.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.image)) {
    throw new RequestError(413, 'Use an image no larger than 1.5 MiB.');
  }
  const image = Buffer.from(b.image, 'base64');
  const png = image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const webp = image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
  if (!image.length || image.length > MAX_INPUT_BYTES || !(png || jpeg || webp)) {
    throw new RequestError(400, 'Upload a PNG, JPEG or WebP image.');
  }
  if (b.model !== 'F' && b.model !== 'Q') throw new RequestError(400, 'Choose model F or Q.');
  if (b.scale !== 1 && b.scale !== 2) throw new RequestError(400, 'Choose scale 1 or 2.');
  if (!Number.isInteger(b.seed) || Number(b.seed) < 0 || Number(b.seed) > 2147483647) {
    throw new RequestError(400, 'Seed must be an integer between 0 and 2147483647.');
  }
  return { image: b.image, filename: String(b.filename || 'card').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120),
    model: b.model, scale: b.scale, seed: Number(b.seed) };
}

export function createHandler(query: Query, transaction: Transaction, env: Environment) {
  const namespace = env.VERCEL_ENV === 'production' ? 'production' : 'preview';
  let initialized: Promise<unknown> | undefined;
  function initialize() {
    initialized ??= transaction(SCHEMA.map(text => ({ text }))).catch(error => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  }
  return async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const action = req.query.action || 'health';
    try {
      if (action !== 'health') {
        if (!env.SUPIR_API_TOKEN || env.SUPIR_API_TOKEN.length < 32) {
          throw new RequestError(503, 'Set a SUPIR_API_TOKEN of at least 32 characters in the server environment.');
        }
        if (!authorized(req.headers.authorization, env.SUPIR_API_TOKEN)) throw new RequestError(401, 'Invalid access token.');
      }
      if (!env.SUPIR_DATABASE_URL) throw new RequestError(503, 'Neon is not connected.');
      if (action === 'health' && req.method === 'GET') {
        await initialize();
        const rows = await query(`SELECT EXISTS (SELECT 1 FROM supir_workers WHERE namespace=$1 AND seen_at > now() - interval '90 seconds') AS online`, [namespace]);
        return res.status(200).json({ database: 'connected', worker: rows[0]?.online === true,
          accessConfigured: (env.SUPIR_API_TOKEN?.length || 0) >= 32, namespace });
      }
      if (action === 'jobs' && req.method === 'POST') {
        const input = validateInput(req.body);
        await initialize();
        const id = randomUUID();
        const results = await transaction([
          { text: `INSERT INTO supir_queue_locks (namespace) VALUES ($1) ON CONFLICT DO NOTHING`, values: [namespace] },
          { text: `SELECT namespace FROM supir_queue_locks WHERE namespace=$1 FOR UPDATE`, values: [namespace] },
          { text: `DELETE FROM supir_jobs WHERE namespace=$1 AND created_at < now() - interval '24 hours' AND (status != 'processing' OR lease_until < now())`, values: [namespace] },
          { text: `INSERT INTO supir_jobs (id,namespace,filename,input_base64,model,scale,seed)
              SELECT $1,$2,$3,$4,$5,$6,$7 WHERE
              (SELECT count(*) FROM supir_jobs WHERE namespace=$2 AND status IN ('pending','processing')) < 5
              RETURNING id,status`, values: [id,namespace,input.filename,input.image,input.model,input.scale,input.seed] },
        ]);
        const job = results[3]?.[0];
        if (!job) throw new RequestError(429, 'The personal queue is full (5 active jobs).');
        return res.status(202).json(job);
      }
      if (action === 'jobs' && req.method === 'GET') {
        await initialize();
        const rows = await query(`SELECT id,status,filename,model,scale,seed,error,created_at,updated_at FROM supir_jobs
          WHERE namespace=$1 ORDER BY created_at DESC LIMIT 20`, [namespace]);
        return res.status(200).json({ jobs: rows });
      }
      if (action === 'result' && req.method === 'GET') {
        const id = req.query.id;
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new RequestError(400, 'Invalid job ID.');
        await initialize();
        const rows = await query(`SELECT output_base64 FROM supir_jobs WHERE id=$1 AND namespace=$2 AND status='completed'`, [id, namespace]);
        if (!rows[0]?.output_base64) throw new RequestError(404, 'Result not available.');
        const bytes = Buffer.from(String(rows[0].output_base64), 'base64');
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Disposition', `attachment; filename="supir-${id}.jpg"`);
        return res.status(200).send(bytes);
      }
      res.setHeader('Allow', action === 'jobs' ? 'GET, POST' : 'GET');
      throw new RequestError(405, 'Unsupported method or action.');
    } catch (error) {
      if (error instanceof RequestError) return res.status(error.status).json({ error: error.message });
      // Never return database errors: connection strings and image data are private.
      console.error('SUPIR database request failed');
      return res.status(503).json({ error: 'SUPIR storage is unavailable. Please try again.' });
    }
  };
}
