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

  try {
    let res = await attempt();
    if (res.status === 503) {
      await new Promise(r => setTimeout(r, 2000));
      res = await attempt();
    }
    if (!res.ok) return NextResponse.json({ error: 'Upstream error' }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    try {
      await new Promise(r => setTimeout(r, 2000));
      const res = await attempt();
      if (!res.ok) return NextResponse.json({ error: 'Upstream error' }, { status: res.status });
      return NextResponse.json(await res.json());
    } catch {
      return NextResponse.json({ error: 'Node unreachable' }, { status: 502 });
    }
  }
}
