import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const adminToken = req.headers.get('X-Admin-Token') || '';
    
    // De radio-server draait lokaal op de server op poort 3001
    const targetUrl = 'http://localhost:3001/api/soundboard/voice';

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'X-Admin-Token': adminToken,
      },
      body: formData,
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Proxy error:', error);
    return NextResponse.json({ error: 'Kon geen verbinding maken met de radio-server' }, { status: 500 });
  }
}
