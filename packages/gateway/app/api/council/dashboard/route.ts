import { NextResponse } from 'next/server';
import { getNodeUrl } from '@/lib/node-connection';

export async function GET() {
  const nodeUrl = getNodeUrl();

  const attempt = async () => {
    const res = await fetch(`${nodeUrl}/v1/council/dashboard`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    return res;
  };

  const delays = [2000, 3000, 4000];
  try {
    let res = await attempt();
    for (const delay of delays) {
      if (res.status !== 503) break;
      await new Promise(r => setTimeout(r, delay));
      res = await attempt();
    }
    if (!res.ok) return NextResponse.json({ error: 'Upstream error' }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    for (const delay of delays) {
      try {
        await new Promise(r => setTimeout(r, delay));
        const res = await attempt();
        if (!res.ok) return NextResponse.json({ error: 'Upstream error' }, { status: res.status });
        return NextResponse.json(await res.json());
      } catch { continue; }
    }
    return NextResponse.json({ error: 'Node unreachable' }, { status: 502 });
  }
}
