/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MatchResp } from './components/CameraCapture';

const isElectron = typeof window !== 'undefined' && (window as any).env;
const API_BASE =
  (isElectron && (window as any).env.API_BASE) ||
  import.meta.env.VITE_API_URL ||
  '';

export async function postMatch(descriptor: number[]) {
  const r = await fetch(`${API_BASE}/userDescriptor/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descriptor: JSON.stringify(descriptor) }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Erro ${r.status}: ${text}`);
  }
  return (await r.json()) as MatchResp;
}
