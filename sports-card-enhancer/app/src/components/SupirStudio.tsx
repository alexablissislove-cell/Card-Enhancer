import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Health { database?: string; worker?: boolean; accessConfigured?: boolean; namespace?: string }
interface SupirJob {
  id: string; status: 'pending' | 'processing' | 'completed' | 'failed'; filename: string;
  model: 'F' | 'Q'; scale: number; error?: string;
}

async function request(action: string, token = '', init: RequestInit = {}) {
  const response = await fetch(`/api/supir?action=${action}`, {
    ...init, headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed.' }));
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return response;
}

export function SupirStudio() {
  const [health, setHealth] = useState<Health>({});
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [model, setModel] = useState<'F' | 'Q'>('F');
  const [scale, setScale] = useState(1);
  const [seed, setSeed] = useState('1234');
  const [jobs, setJobs] = useState<SupirJob[]>([]);
  const [message, setMessage] = useState('Checking Neon and GPU worker…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      try {
        const result: Health = await (await request('health', '', { signal: controller.signal })).json();
        setHealth(result);
        setMessage(result.worker ? 'GPU worker is online.' : 'GPU worker offline. Follow the SUPIR setup guide to start it.');
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Connection failed.');
      }
    }
    void check();
    const interval = setInterval(() => void check(), 30000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const result = await (await request('jobs', token, { signal: controller.signal })).json();
        setJobs(result.jobs);
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : 'Cannot fetch jobs.');
          setConnected(false);
        }
      }
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [connected, token]);

  async function submit() {
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 1536 * 1024) throw new Error('Choose a PNG, JPEG or WebP no larger than 1.5 MiB.');
      const bitmap = await createImageBitmap(file);
      const tooLarge = Math.max(bitmap.width, bitmap.height) > 2048;
      bitmap.close();
      if (tooLarge) throw new Error('The input image must be at most 2048 pixels on either side.');
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read the image.'));
        reader.readAsDataURL(file);
      });
      await request('jobs', token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, filename: file.name, model, scale, seed: Number(seed) }) });
      const result = await (await request('jobs', token)).json();
      setJobs(result.jobs);
      setMessage('Image queued in Neon. The GPU worker will pick it up.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Submission failed.');
    } finally { setBusy(false); }
  }

  async function download(id: string) {
    try {
      const blob = await (await request(`result&id=${encodeURIComponent(id)}`, token)).blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `supir-${id}.jpg`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Download failed.'); }
  }

  return <div className="h-full overflow-auto p-6">
    <section className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-cyan-300">SUPIR restoration</h2>
        <p className="text-sm text-gray-400 mt-2">Non-commercial experiments · Vercel API → Neon queue → your GPU worker</p>
      </div>
      <div className="glass-dark border border-cyan-500/30 rounded-xl p-4 space-y-2">
        <p>Neon: <strong>{health.database === 'connected' ? 'connected' : 'not connected'}</strong></p>
        <p>GPU worker: <strong>{health.worker ? 'online' : 'offline'}</strong></p>
        <p>Access protection: <strong>{health.accessConfigured ? 'configured' : 'setup required'}</strong></p>
        <p className="text-sm text-gray-400">Vercel does not execute SUPIR on a GPU. Start the included worker on a CUDA machine. Neon stores this experiment’s bounded image jobs; originals are never overwritten.</p>
      </div>
      <p className="text-sm text-amber-200 border border-amber-500/30 rounded-lg p-3">Generative restoration can invent or change card text, artwork and surface defects. Keep originals; do not use restored images as evidence of card condition.</p>
      <div className="space-y-2">
        <Label htmlFor="supir-token">Personal access token (held in memory only)</Label>
        <Input id="supir-token" type="password" autoComplete="off" value={token} onChange={e => { setToken(e.target.value); setConnected(false); }} placeholder="Value configured as SUPIR_API_TOKEN on the server" />
        <Button variant="outline" disabled={!health.accessConfigured || token.length < 32} onClick={() => setConnected(true)}>Connect to private jobs</Button>
        {!health.accessConfigured && <p className="text-sm text-gray-400">Set a random SUPIR_API_TOKEN (32+ characters) in the project environment, then redeploy. Never use a VITE_ variable for secrets.</p>}
      </div>
      <div className="space-y-4">
        <div className="space-y-2"><Label htmlFor="supir-file">Card image · PNG, JPEG, WebP · up to 1.5 MiB and 2048px</Label>
          <Input id="supir-file" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} /></div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><Label htmlFor="supir-model">Model</Label><select id="supir-model" className="block mt-2 bg-black border border-gray-600 p-2 rounded w-full" value={model} onChange={e => setModel(e.target.value as 'F' | 'Q')}><option value="F">F · fidelity-oriented</option><option value="Q">Q · quality-oriented</option></select></div>
          <div><Label htmlFor="supir-scale">Requested scale</Label><select id="supir-scale" className="block mt-2 bg-black border border-gray-600 p-2 rounded w-full" value={scale} onChange={e => setScale(Number(e.target.value))}><option value={1}>1×</option><option value={2}>2×</option></select></div>
          <div><Label htmlFor="supir-seed">Seed</Label><Input id="supir-seed" className="mt-2" type="number" min={0} max={2147483647} step={1} value={seed} onChange={e => setSeed(e.target.value)} /></div>
        </div>
        <p className="text-xs text-gray-400">SUPIR uses a minimum output side of 1024px. Outputs above 4096px / 8 megapixels are rejected by the worker; exported as JPEG, up to 2.5 MiB. Five active jobs maximum.</p>
        <Button disabled={busy || !connected || !health.worker || !file || !seed || !Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 2147483647} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Restore with SUPIR'}</Button>
      </div>
      <p role="status" className="text-sm text-cyan-200">{message}</p>
      <div className="space-y-3"><h3 className="text-lg">Persistent jobs</h3>
        {!jobs.length && <p className="text-gray-400 text-sm">{connected ? 'No jobs yet.' : 'Connect with your token to view jobs.'}</p>}
        {jobs.map(job => <article key={job.id} className="border border-cyan-500/20 rounded-lg p-3 space-y-2">
          <p className="break-all">{job.filename} · {job.model} · {job.scale}× · <strong>{job.status}</strong></p>
          {job.error && <p className="text-red-300 text-sm">{job.error}</p>}
          {job.status === 'completed' && <Button variant="outline" onClick={() => void download(job.id)}>Download restored JPEG</Button>}
        </article>)}
      </div>
    </section>
  </div>;
}
