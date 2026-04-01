/**
 * Discord 슬래시 커맨드 등록 스크립트
 *
 * 사용법:
 *   npx tsx scripts/register-commands.ts
 *
 * 환경변수 필요:
 *   DISCORD_BOT_TOKEN, DISCORD_APP_ID
 */

const DISCORD_API = "https://discord.com/api/v10";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const APP_ID = process.env.DISCORD_APP_ID!;

if (!BOT_TOKEN || !APP_ID) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_APP_ID are required");
  process.exit(1);
}

const commands = [
  {
    name: "snippet",
    description: "데일리 스니펫을 강제 실행합니다",
    options: [
      {
        name: "person",
        description: "특정 사람만 실행 (생략 시 전체)",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "박영민", value: "youngmin" },
          { name: "조세연", value: "seyeon" },
        ],
      },
    ],
  },
];

async function main() {
  const res = await fetch(
    `${DISCORD_API}/applications/${APP_ID}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    }
  );

  if (!res.ok) {
    console.error("Failed:", await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log(`Registered ${data.length} command(s):`);
  for (const cmd of data) {
    console.log(`  /${cmd.name} — ${cmd.description}`);
  }
}

main();
