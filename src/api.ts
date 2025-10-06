import type { MatchResp } from './components/CameraCapture';

const API_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || '';

export async function postMatch(descriptor: number[]) {
  const r = await fetch(`${API_URL}/userDescriptor/match`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoibWFzdGVyIiwiaWF0IjoxNzU5NjQwMjk5LCJleHAiOjE3NjAyNDUwOTksInN1YiI6ImE3ZDFmNjEyLTM4YzMtNDUxNy1hNmU0LWU0M2ViNTNjNDRiNCJ9.jSClKws1e_zGV5FuEJrrDBlTivMm3XKuwL727hq4n30',
    },
    body: JSON.stringify({ descriptor: JSON.stringify(descriptor) }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Erro ${r.status}: ${text}`);
  }
  return (await r.json()) as MatchResp;
}
