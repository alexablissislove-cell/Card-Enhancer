import { neon } from '@neondatabase/serverless';
import { createHandler, type Query, type Transaction } from '../server/supir-api.js';

// This module is compiled as a Vercel Function, never a Vite client module.
const url = process.env.SUPIR_DATABASE_URL;
const sql = url ? neon(url) : undefined;
const query: Query = async (text, values = []) => {
  if (!sql) throw new Error('Database unavailable');
  return await sql.query(text, values);
};
const transaction: Transaction = async queries => {
  if (!sql) throw new Error('Database unavailable');
  return await sql.transaction(queries.map(({ text, values = [] }) => sql.query(text, values)));
};
export default createHandler(query, transaction, process.env);
