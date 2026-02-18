import { NextResponse } from "next/server";

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? "";
const CHANNEL = process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "";

let cachedToken = "";
let tokenExpiry = 0;

async function getAppToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) return "";

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

export async function GET() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !CHANNEL) {
    return NextResponse.json({ live: false });
  }

  try {
    const token = await getAppToken();
    if (!token) return NextResponse.json({ live: false });

    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${CHANNEL}`,
      {
        headers: {
          "Client-ID": TWITCH_CLIENT_ID,
          Authorization: `Bearer ${token}`,
        },
        next: { revalidate: 30 },
      }
    );

    if (!res.ok) return NextResponse.json({ live: false });

    const data = await res.json();
    const live = Array.isArray(data.data) && data.data.length > 0;

    return NextResponse.json({ live });
  } catch {
    return NextResponse.json({ live: false });
  }
}
