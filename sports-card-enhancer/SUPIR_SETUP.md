# SUPIR + Neon (non-commercial experiments)

## Architecture and current limits

- **Vercel** builds the existing Vite UI and the Node Function at `/api/supir`.
- **Neon Postgres** persists jobs, their bounded image payloads, attempts, leases and worker heartbeats.
- **Your CUDA GPU machine** runs `supir-worker/worker.py`. It polls Neon directly; no inbound GPU port or public worker URL is needed.
- SUPIR is **not** run inside Vercel Functions. Neon is a database, not GPU compute. No GPU hosting or model weights are provisioned by this change.
- The original FastAPI / Real-ESRGAN workflow is unchanged. The new **SUPIR** tab is a separate, same-origin workflow; it does not need `VITE_API_URL`.
- No eBay listing/publishing integration is included. The supplied eBay file imports a separate `cardlister` package absent from this repository; the existing shadcn components are reused rather than overwritten by the archive.

This personal-use implementation accepts **one PNG/JPEG/WebP per job**, at most **1.5 MiB**, with each side between 32 and 2048 pixels. F (fidelity-oriented) and Q (quality-oriented) models support requested scales of 1×/2×. SUPIR's upstream minimum output side is 1024px, so actual scale can be higher. The worker rejects outputs beyond **4096px / 8 megapixels** and exports a **JPEG of at most 2.5 MiB**. These bounds keep Function payloads under Vercel's 4.5 MB limit. ZIP/bulk uploads are not supported in this path.

Small experiment images are stored as base64 in Neon to avoid an additional storage dependency. This is not a large-scale image store. The queue accepts at most five active jobs per environment namespace, exposes the latest twenty jobs, and cleans records older than 24 hours during submissions and worker maintenance. **Cleanup is activity-driven, not a guaranteed wall-clock TTL:** stop the worker and submissions, and records remain until activity resumes. Results are private behind the token. Do not use this for sensitive photos or high-volume workloads without dedicated private object storage and scheduled retention.

SUPIR is generative and may alter text, artwork or defects even with fidelity settings. Keep originals; restored images must not be treated as evidence of collectible condition. A prompt is not a guarantee of fidelity.

## 1. Neon connection (already provisioned for card-enhancer)

The Neon Free resource `card-enhancer-supir` is connected to production and preview with a `SUPIR_` prefix. Code uses **`SUPIR_DATABASE_URL`** only. Existing Nile `POSTGRES_URL` and Redis variables are untouched. Do not put the connection string in a `VITE_` variable or client code.

On the first API health request the server applies additive `CREATE TABLE IF NOT EXISTS` statements in `app/server/supir-schema.ts`. The database role needs DDL rights for this initial setup. Health returns only database availability, recent worker heartbeat, access-token configuration and namespace—not connection details or jobs. SQL errors are sanitized.

Production and preview use separate `namespace` values in the same database. This prevents normal API/worker cross-environment job access but is not a database-level security boundary: the shared database credential can read both. All preview branches share the `preview` namespace. For untrusted previews use an isolated Neon branch/database and a separate access token instead.

## 2. Configure private API access

Create a random, unique **32+ character** `SUPIR_API_TOKEN` through the project's protected environment-variable input. Set it on the environment you intend to use, then redeploy that environment. For CLI use an interactive `vercel env add SUPIR_API_TOKEN preview` or `production` prompt; never pass the value on the command line, in chat, in a URL or in Git. This is a personal shared-token gate, **not multi-user authentication**: anyone with it can list/download all jobs in that namespace. Use a different token for each environment.

Open the SUPIR tab and enter that value in its password field. It is held in component memory only, sent in an Authorization header, and is never persisted to localStorage or included in download URLs. The API fails closed until the server token is configured. GPU submissions are also disabled in the UI while no recent worker heartbeat is present. The token does not need to be copied to the GPU machine; only the database connection is required there.

## 3. Prepare a GPU host

Use a CUDA-enabled Linux machine or your GPU provider's equivalent. This is a manual provider/setup step; the repository does not select a paid plan or create a GPU instance. Check the upstream SUPIR README for current GPU memory guidance and model requirements. The upstream reduced-memory Gradio example lists 12 GB for diffusion and 16 GB for LLaVA; this worker disables LLaVA captions but **no exact GPU memory requirement has been measured for this wrapper**. Size the GPU with a test image before relying on it.

Follow [upstream installation](https://github.com/Fanghua-Yu/SUPIR#-dependencies-and-installation) in its own environment:

```sh
git clone https://github.com/Fanghua-Yu/SUPIR.git
cd SUPIR
# Pin/review an upstream revision before installing; record the tested revision.
git rev-parse HEAD
conda create -n SUPIR python=3.8 -y
conda activate SUPIR
pip install --upgrade pip
pip install -r requirements.txt
pip install 'psycopg[binary]>=3.1,<3.2'
```

Download the upstream SUPIR-v0F / SUPIR-v0Q and SDXL checkpoints following the upstream links and their terms. Edit `options/SUPIR_v0.yaml` (`SDXL_CKPT`, `SUPIR_CKPT_Q`, `SUPIR_CKPT_F`) and `CKPT_PTH.py` CLIP paths/cache settings as documented upstream. Do not commit checkpoints or credentials. LLaVA inference is disabled with `--no_llava`, but upstream `test.py` still imports its modules, so do not omit upstream Python dependencies. No upstream model files or code are vendored here.

Check out Card-Enhancer on the GPU machine as well. In the **same activated SUPIR Python environment**, configure these values using your host's secret manager or protected shell input:

- `SUPIR_DATABASE_URL`: the Neon connection for this experiment (TLS required).
- `SUPIR_REPO`: absolute filesystem path to the upstream SUPIR checkout.
- `SUPIR_QUEUE_NAMESPACE`: `preview` for testing; explicitly choose `production` only for production jobs. Default is `preview`.

First open the matching deployment's SUPIR tab once to initialize its schema, then run:

```sh
# Run from the Card-Enhancer checkout; SUPIR's Python environment must remain active.
python sports-card-enhancer/supir-worker/worker.py
```

The worker defaults to one image at a time. It invokes upstream `test.py` using argument arrays (never a shell), tiled VAE, half parameters, 50 sampling steps, one sample, and a 15-minute subprocess timeout. Each job reloads the upstream model; this favors isolation over latency. A process supervisor can restart the worker; keep logs private. Model download and CUDA inference are not run on the Vercel build machine.

## 4. Verify the integration

1. Wait for the PR preview to be Ready. Open **SUPIR**: Neon should say **connected**, the worker **offline**, and access protection **setup required** until configured.
2. Configure the access token, redeploy, and start the worker in the matching namespace. Its heartbeat updates while idle and every 20 seconds during inference; the UI considers it online for 90 seconds.
3. Enter the token and click **Connect to private jobs**. Submit a small non-sensitive card photo with model F and 1× first. Watch `pending → processing → completed`, then download the JPEG and compare manually with the original.
4. Refresh/reopen and reconnect: job state must persist. Stop a worker mid-job: another worker can reclaim after its two-minute lease expires. Completions are fenced by lease token and expiration to prevent stale overwrites. After three expired attempts the job fails; inference/validation errors fail immediately rather than silently falling back to Lanczos.
5. Switch to Q or 2× only after validating fidelity and memory usage. No successful CUDA inference is claimed until this step has actually been performed on a GPU.

## Local checks

```sh
cd sports-card-enhancer/app
pnpm install --frozen-lockfile
pnpm run build                # includes API/server and frontend TypeScript checks
pnpm run test:supir
pnpm exec eslint api server src/components/SupirStudio.tsx

# Lightweight worker tests need Pillow and requirements-worker.txt, not CUDA or weights.
cd ../supir-worker
python -m unittest discover -v
```

Tests mock inference and database calls; they validate contracts, authorization, bounds and CLI wiring, not image quality or GPU compatibility. The repository's pre-existing broad ESLint failures are outside this integration.

## References

- [SUPIR README / installation / model checkpoints](https://github.com/Fanghua-Yu/SUPIR)
- [Upstream CLI API used by this worker](https://github.com/Fanghua-Yu/SUPIR/blob/master/test.py)
- [SUPIR terms (user confirms non-commercial use)](https://github.com/Fanghua-Yu/SUPIR/blob/master/LICENSE)
- [Vercel GPU application architecture](https://vercel.com/i/what-is-serverless-gpu)
- [Vercel Node Functions in /api](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel payload limits](https://vercel.com/docs/functions/limitations)
- [Neon integration](https://vercel.com/marketplace/neon/neon)
