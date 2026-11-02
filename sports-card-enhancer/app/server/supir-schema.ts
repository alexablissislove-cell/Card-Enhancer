// Shared migration; run by the API before queries. No model or credential ships to the browser.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS supir_jobs (
    id uuid PRIMARY KEY, namespace text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
    filename text NOT NULL, input_base64 text NOT NULL, output_base64 text,
    model text NOT NULL CHECK (model IN ('F','Q')), scale integer NOT NULL CHECK (scale IN (1,2)),
    seed integer NOT NULL, attempts integer NOT NULL DEFAULT 0,
    lease_token uuid, lease_until timestamptz, error text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS supir_queue_idx ON supir_jobs (namespace, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS supir_workers (
    id text PRIMARY KEY, namespace text NOT NULL, seen_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Serialize submissions for a bounded personal-use queue, even across Function instances.
  `CREATE TABLE IF NOT EXISTS supir_queue_locks (namespace text PRIMARY KEY)`,
] as const;
