import nacl from "tweetnacl";

const DISCORD_API = "https://discord.com/api/v10";

function botHeaders(): Record<string, string> {
  return {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

// 채널에 메시지 전송 → 메시지 ID 반환
export async function sendDiscordMessage(
  channelId: string,
  embeds: object[],
  components: object[]
): Promise<string> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify({ embeds, components }),
  });
  if (!res.ok) throw new Error(`Discord send failed: ${await res.text()}`);
  const data = await res.json();
  return data.id as string;
}

// 메시지 수정 (버튼 제거, 상태 업데이트 등)
export async function editDiscordMessage(
  channelId: string,
  messageId: string,
  embeds: object[],
  components: object[] = []
): Promise<void> {
  const res = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ embeds, components }),
    }
  );
  if (!res.ok) throw new Error(`Discord edit failed: ${await res.text()}`);
}

// 특정 메시지 조회
export async function getDiscordMessage(
  channelId: string,
  messageId: string
): Promise<any> {
  const res = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
    { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Discord getMessage failed: ${await res.text()}`);
  return res.json();
}

// 채널 최근 메시지 조회
export async function getChannelMessages(
  channelId: string,
  limit = 50
): Promise<any[]> {
  const res = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages?limit=${limit}`,
    { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Discord getMessages failed: ${await res.text()}`);
  return res.json();
}

// Discord Interactions 서명 검증 (tweetnacl 사용)
export function verifyDiscordSignature(
  signature: string,
  timestamp: string,
  rawBody: string
): boolean {
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, "hex"),
      Buffer.from(process.env.DISCORD_APP_PUBLIC_KEY!, "hex")
    );
  } catch (e) {
    console.error("[discord] signature verify error:", e);
    return false;
  }
}
