"""Run on a CUDA machine in the upstream SUPIR environment, never in a Function."""
import os
import threading
import time
import uuid

import psycopg
from psycopg.rows import dict_row

from runner import restore

DB_URL = os.environ["SUPIR_DATABASE_URL"]
NAMESPACE = os.environ.get("SUPIR_QUEUE_NAMESPACE", "preview")
if NAMESPACE not in ("preview", "production"):
    raise ValueError("SUPIR_QUEUE_NAMESPACE must be preview or production")
WORKER_ID = str(uuid.uuid4())


def connect():
    # Enforce TLS regardless of URL defaults. Never print the connection string.
    return psycopg.connect(DB_URL, sslmode="require", row_factory=dict_row, connect_timeout=15)


def mark_online(conn):
    conn.execute("""INSERT INTO supir_workers (id, namespace) VALUES (%s,%s)
      ON CONFLICT (id) DO UPDATE SET seen_at=now()""", (WORKER_ID, NAMESPACE))


def claim(conn):
    token = uuid.uuid4()
    # One statement atomically claims the oldest available job. Expired claims can retry.
    job = conn.execute("""WITH next AS (
      SELECT id FROM supir_jobs WHERE namespace=%s AND attempts < 3 AND
      (status='pending' OR (status='processing' AND lease_until < now()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE supir_jobs j SET status='processing', attempts=attempts+1,
        lease_token=%s, lease_until=now()+interval '2 minutes', updated_at=now()
      FROM next WHERE j.id=next.id RETURNING j.*""", (NAMESPACE, token)).fetchone()
    return job


def renew(stop, lost, job):
    while not stop.wait(20):
        try:
            with connect() as conn:
                mark_online(conn)
                updated = conn.execute("""UPDATE supir_jobs SET lease_until=now()+interval '2 minutes',
                  updated_at=now() WHERE id=%s AND lease_token=%s AND status='processing'""",
                  (job["id"], job["lease_token"]))
                if updated.rowcount != 1:
                    lost.set()
                    return
        except Exception:
            # A temporary DB outage may be recoverable; completion is still fenced by token.
            print("Lease renewal unavailable; results will only be saved if the claim is still valid.", flush=True)


def maintain(conn):
    conn.execute("""UPDATE supir_jobs SET status='failed',
      error='Worker lease expired after three attempts. Resubmit the image.', updated_at=now()
      WHERE namespace=%s AND status='processing' AND lease_until < now() AND attempts>=3""", (NAMESPACE,))
    conn.execute("""DELETE FROM supir_jobs WHERE namespace=%s AND created_at < now()-interval '24 hours'
      AND (status!='processing' OR lease_until < now())""", (NAMESPACE,))
    conn.execute("DELETE FROM supir_workers WHERE seen_at < now()-interval '1 day'")


def process(job):
    stop, lost = threading.Event(), threading.Event()
    heartbeat = threading.Thread(target=renew, args=(stop, lost, job), daemon=True)
    heartbeat.start()
    try:
        try:
            output = restore(job)
            status, error = "completed", None
        except ValueError as exc:
            output, status, error = None, "failed", str(exc)
        except Exception:
            output, status, error = None, "failed", "SUPIR inference failed. Check the GPU worker logs and checkpoints."
        if not lost.is_set():
            with connect() as conn:
                conn.execute("""UPDATE supir_jobs SET status=%s, output_base64=%s, error=%s,
                  input_base64='', lease_until=NULL, updated_at=now()
                  WHERE id=%s AND lease_token=%s AND status='processing' AND lease_until > now()""",
                  (status, output, error, job["id"], job["lease_token"]))
    finally:
        stop.set()
        heartbeat.join(timeout=35)


def main():
    # Fail before advertising an online worker if CUDA or the upstream checkout is missing.
    import torch
    from pathlib import Path
    if not torch.cuda.is_available():
        raise RuntimeError("SUPIR requires a CUDA GPU; this worker cannot run on Vercel Functions.")
    repo = Path(os.environ["SUPIR_REPO"])
    if not (repo / "test.py").is_file():
        raise RuntimeError("Set SUPIR_REPO to the installed upstream repository.")
    print("SUPIR worker starting in %s namespace. Ctrl+C to stop." % NAMESPACE, flush=True)
    while True:
        try:
            with connect() as conn:
                mark_online(conn)
                maintain(conn)
                job = claim(conn)
            if job:
                process(job)
            else:
                time.sleep(10)
        except KeyboardInterrupt:
            break
        except Exception:
            print("Queue unavailable. Check DB connectivity and initialize schema by opening the SUPIR tab.", flush=True)
            time.sleep(15)


if __name__ == "__main__":
    main()
