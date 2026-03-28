import { NextRequest, NextResponse } from "next/server";
import {
  getWorkPages,
  getAllBlocks,
  extractCheckedTodos,
  getPageUsers,
  getPageDate,
} from "@/lib/notion";
import {
  generateDailySnippetContent,
  generateWeeklySnippetContent,
} from "@/lib/openai";
import {
  sendDiscordMessage,
  getChannelMessages,
  editDiscordMessage,
} from "@/lib/discord";
import {
  postDailySnippet,
  postWeeklySnippet,
  triggerDailyFeedback,
  triggerWeeklyFeedback,
} from "@/lib/gcs";

export const maxDuration = 60;

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID!;
const YOUNGMIN_ID = process.env.NOTION_USER_YOUNGMIN!;
const SEYEON_ID = process.env.NOTION_USER_SEYEON!;
const GCS_TOKEN_YOUNGMIN = process.env.GCS_API_TOKEN_YOUNGMIN!;
const GCS_TOKEN_SEYEON = process.env.GCS_API_TOKEN_SEYEON!;
const BATCH_SIZE = 3;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  // ?action=send 또는 ?action=timeout 으로 강제 실행 (테스트용)
  const forceAction = req.nextUrl.searchParams.get("action");
  const isTimeoutRun = forceAction
    ? forceAction === "timeout"
    : now.getUTCMinutes() >= 20; // 13:00 UTC = 전송 / 13:30 UTC = 타임아웃 체크

  if (isTimeoutRun) {
    return handleTimeoutCheck();
  } else {
    return handleSendSnippets(now);
  }
}

// ── 10:00pm KST: 스니펫 생성 & Discord 전송 ──────────────────────────────

async function handleSendSnippets(now: Date) {
  const todayIso = now.toISOString().split("T")[0];
  const isMonday = now.getUTCDay() === 1;

  // 오늘 업무 페이지 조회
  const workPages = await getWorkPages(todayIso, todayIso);
  console.log(`[daily-snippet] ${workPages.length} pages for ${todayIso}`);

  // 배치 처리로 각 페이지의 완료 task 파싱
  const youngminTasks: string[] = [];
  const seyeonTasks: string[] = [];

  for (let i = 0; i < workPages.length; i += BATCH_SIZE) {
    const batch = workPages.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (page: any) => {
        const users = getPageUsers(page);
        const blocks = await getAllBlocks(page.id, 2);
        const tasks = extractCheckedTodos(blocks);
        if (users.includes(YOUNGMIN_ID)) youngminTasks.push(...tasks);
        if (users.includes(SEYEON_ID)) seyeonTasks.push(...tasks);
      })
    );
  }

  const shortDate = toShortDate(todayIso);

  // 일간 스니펫 Discord 전송 (태스크 있는 사람만)
  const jobs: Promise<void>[] = [];
  if (youngminTasks.length > 0) {
    jobs.push(
      generateDailySnippetContent("박영민", todayIso, youngminTasks).then(
        (content) => sendSnippetMessage(content, "youngmin", "daily", shortDate)
      )
    );
  }
  if (seyeonTasks.length > 0) {
    jobs.push(
      generateDailySnippetContent("조세연", todayIso, seyeonTasks).then(
        (content) => sendSnippetMessage(content, "seyeon", "daily", shortDate)
      )
    );
  }
  await Promise.all(jobs);

  // 월요일: 주간 스니펫 추가 전송
  if (isMonday) {
    await handleWeeklySnippets(now, todayIso, shortDate);
  }

  return NextResponse.json({
    success: true,
    date: todayIso,
    isMonday,
    youngminTasks: youngminTasks.length,
    seyeonTasks: seyeonTasks.length,
  });
}

async function handleWeeklySnippets(
  now: Date,
  todayIso: string,
  todayShort: string
) {
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setUTCDate(now.getUTCDate() - 7);
  const startIso = sevenDaysAgo.toISOString().split("T")[0];

  const weeklyPages = await getWorkPages(startIso, todayIso);

  // 날짜별로 그룹화
  const byDate: Record<string, { youngmin: string[]; seyeon: string[] }> = {};

  for (let i = 0; i < weeklyPages.length; i += BATCH_SIZE) {
    const batch = weeklyPages.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (page: any) => {
        const date = getPageDate(page) ?? todayIso;
        const users = getPageUsers(page);
        const blocks = await getAllBlocks(page.id, 2);
        const tasks = extractCheckedTodos(blocks);

        if (!byDate[date]) byDate[date] = { youngmin: [], seyeon: [] };
        if (users.includes(YOUNGMIN_ID)) byDate[date].youngmin.push(...tasks);
        if (users.includes(SEYEON_ID)) byDate[date].seyeon.push(...tasks);
      })
    );
  }

  const ymWeekly = Object.entries(byDate)
    .filter(([, v]) => v.youngmin.length > 0)
    .map(([date, v]) => ({ date, tasks: v.youngmin }));
  const syWeekly = Object.entries(byDate)
    .filter(([, v]) => v.seyeon.length > 0)
    .map(([date, v]) => ({ date, tasks: v.seyeon }));

  const weekLabel = `${toShortDate(startIso)}~${todayShort}`;
  const weeklyJobs: Promise<void>[] = [];

  if (ymWeekly.length > 0) {
    weeklyJobs.push(
      generateWeeklySnippetContent("박영민", toShortDate(startIso), todayShort, ymWeekly).then(
        (content) => sendSnippetMessage(content, "youngmin", "weekly", weekLabel)
      )
    );
  }
  if (syWeekly.length > 0) {
    weeklyJobs.push(
      generateWeeklySnippetContent("조세연", toShortDate(startIso), todayShort, syWeekly).then(
        (content) => sendSnippetMessage(content, "seyeon", "weekly", weekLabel)
      )
    );
  }
  await Promise.all(weeklyJobs);
}

// ── 10:30pm KST: 타임아웃 체크 & 자동 게시 ──────────────────────────────

async function handleTimeoutCheck() {
  const messages = await getChannelMessages(CHANNEL_ID, 50);
  const now = Date.now();
  const THIRTY_MIN = 30 * 60 * 1000;
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  let autoPosted = 0;

  for (const msg of messages) {
    // 버튼이 없는 메시지는 이미 처리됨
    if (!msg.components?.length) continue;

    const age = now - new Date(msg.timestamp).getTime();
    if (age < THIRTY_MIN || age > TWO_HOURS) continue;

    // 첫 번째 버튼의 custom_id로 사람/타입 판별
    const firstButtonId: string =
      msg.components?.[0]?.components?.[0]?.custom_id ?? "";
    if (!firstButtonId.startsWith("post:")) continue;

    const [, person, type] = firstButtonId.split(":");
    const content: string = msg.embeds?.[0]?.description ?? "";
    if (!content) continue;

    const token =
      person === "youngmin" ? GCS_TOKEN_YOUNGMIN : GCS_TOKEN_SEYEON;

    try {
      if (type === "weekly") {
        await postWeeklySnippet(token, content);
        triggerWeeklyFeedback(token).catch((err) =>
          console.error(`[timeout-feedback] ${person}:weekly failed:`, err)
        );
      } else {
        await postDailySnippet(token, content);
        triggerDailyFeedback(token).catch((err) =>
          console.error(`[timeout-feedback] ${person}:daily failed:`, err)
        );
      }

      // Discord 메시지 업데이트 (버튼 제거)
      const updatedEmbed = {
        ...msg.embeds[0],
        color: 0x95a5a6,
        footer: { text: "⏰ 자동 게시됨 (무응답)" },
      };
      await editDiscordMessage(CHANNEL_ID, msg.id, [updatedEmbed], []);
      autoPosted++;
      console.log(`[timeout] auto-posted ${person}:${type}`);
    } catch (err) {
      console.error(`[timeout] failed ${person}:${type}:`, err);
    }
  }

  return NextResponse.json({ success: true, action: "timeout-check", autoPosted });
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────

async function sendSnippetMessage(
  content: string,
  person: "youngmin" | "seyeon",
  type: "daily" | "weekly",
  dateLabel: string
) {
  const nameKo = person === "youngmin" ? "박영민" : "조세연";
  const typeKo = type === "daily" ? "데일리" : "주간";
  const color = person === "youngmin" ? 0x5865f2 : 0xeb459e;

  const embed = {
    title: `📋 ${nameKo} | ${typeKo} 스니펫 (${dateLabel})`,
    description: content,
    color,
    footer: { text: "30분 내 응답 없으면 자동 게시됩니다" },
  };

  const components = [
    {
      type: 1, // ACTION_ROW
      components: [
        {
          type: 2, // BUTTON
          style: 3, // SUCCESS (초록)
          label: "그대로 게시 ✅",
          custom_id: `post:${person}:${type}`,
        },
        {
          type: 2,
          style: 1, // PRIMARY (파랑)
          label: "헬스체크 입력 🔢",
          custom_id: `health:${person}:${type}`,
        },
        {
          type: 2,
          style: 2, // SECONDARY (회색)
          label: "수정하기 ✏️",
          custom_id: `edit:${person}:${type}`,
        },
      ],
    },
  ];

  await sendDiscordMessage(CHANNEL_ID, [embed], components);
}

function toShortDate(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${parseInt(m)}/${parseInt(d)}`;
}
