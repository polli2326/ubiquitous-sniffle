import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); console.log('Schema ready.'); }
finally { await pool.end(); }
