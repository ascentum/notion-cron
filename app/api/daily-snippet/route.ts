import { NextRequest, NextResponse } from "next/server";
import {
  formatWorkItem,
  getLegacyWorkItemsForDateRange,
  getPageDate,
  getWorkPages,
  splitWorkDateRanges,
  buildFormattedTasks,
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
import { getKstDateInfo, getPreviousWeekDateRange } from "@/lib/time";

export const maxDuration = 60;

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID!;
const YOUNGMIN_ID = process.env.NOTION_USER_YOUNGMIN!;
const SEYEON_ID = process.env.NOTION_USER_SEYEON!;
const GCS_TOKEN_YOUNGMIN = process.env.GCS_API_TOKEN_YOUNGMIN!;
const GCS_TOKEN_SEYEON = process.env.GCS_API_TOKEN_SEYEON!;
const USER_IDS = { youngmin: YOUNGMIN_ID, seyeon: SEYEON_ID };

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();
    // ?action=send 또는 ?action=timeout 으로 강제 실행 (테스트용)
    const forceAction = req.nextUrl.searchParams.get("action");
    // ?person=youngmin 또는 ?person=seyeon 으로 특정 사람만 실행
    const targetPerson = req.nextUrl.searchParams.get("person") as
      | "youngmin"
      | "seyeon"
      | null;
    const isTimeoutRun = forceAction
      ? forceAction === "timeout"
      : now.getUTCMinutes() >= 20; // 13:00 UTC = 전송 / 13:30 UTC = 타임아웃 체크

    if (isTimeoutRun) {
      return handleTimeoutCheck();
    } else {
      return handleSendSnippets(now, targetPerson);
    }
  } catch (error) {
    console.error("[daily-snippet] route failed:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

// ── 00:00 KST: 스니펫 생성 & Discord 전송 ───────────────────────────────

async function handleSendSnippets(
  now: Date,
  targetPerson: "youngmin" | "seyeon" | null
) {
  const { isoDate: todayIso, weekday } = getKstDateInfo(now);
  const isMonday = weekday === 1;
  const shortDate = toShortDate(todayIso);

  // 오늘 이미 전송된 스니펫이 있는지 확인 (중복 방지)
  const alreadySent = await getAlreadySentPersons(shortDate, "데일리");
  console.log(`[daily-snippet] already sent today: ${[...alreadySent].join(", ") || "none"}`);

  // 대상 사람 결정
  const targets: ("youngmin" | "seyeon")[] = targetPerson
    ? [targetPerson]
    : ["youngmin", "seyeon"];

  // 이미 전송된 사람 제외 (단, targetPerson 직접 지정 시에는 강제 재전송)
  const filteredTargets = targetPerson
    ? targets
    : targets.filter((p) => !alreadySent.has(p));

  if (filteredTargets.length === 0) {
    console.log("[daily-snippet] all targets already have snippets, skipping");
    return NextResponse.json({
      success: true,
      date: todayIso,
      skipped: true,
      reason: "all targets already have snippets for today",
    });
  }

  // 오늘 완료된 업무 조회 (어센텀 업무 DB에서 완료일=오늘 & 완료=true)
  const workPages = await getWorkPages(todayIso, todayIso);
  console.log(`[daily-snippet] ${workPages.length} tasks for ${todayIso}`);

  // 계층 구조 + 카테고리 포맷으로 사람별 업무 목록 생성
  const tasksByPerson = await buildFormattedTasks(workPages, USER_IDS);
  const youngminTasks = tasksByPerson.youngmin ?? [];
  const seyeonTasks = tasksByPerson.seyeon ?? [];

  // 일간 스니펫 Discord 전송 (태스크 있는 사람만, 없으면 경고)
  const jobs: Promise<void>[] = [];
  for (const person of filteredTargets) {
    const tasks = person === "youngmin" ? youngminTasks : seyeonTasks;
    if (tasks.length > 0) {
      const nameKo = person === "youngmin" ? "박영민" : "조세연";
      jobs.push(
        generateDailySnippetContent(nameKo, todayIso, tasks).then((content) =>
          sendSnippetMessage(content, person, "daily", shortDate)
        )
      );
    } else {
      jobs.push(sendNoTaskWarning(person, shortDate));
    }
  }
  await Promise.all(jobs);

  // 월요일: 주간 스니펫 추가 전송
  if (isMonday) {
    await handleWeeklySnippets(todayIso);
  }

  return NextResponse.json({
    success: true,
    date: todayIso,
    isMonday,
    targets: filteredTargets,
    youngminTasks: youngminTasks.length,
    seyeonTasks: seyeonTasks.length,
  });
}

async function handleWeeklySnippets(todayIso: string) {
  const { startIso, endIso } = getPreviousWeekDateRange(todayIso);
  const ranges = splitWorkDateRanges(startIso, endIso);

  const byDate = new Map<string, { youngmin: string[]; seyeon: string[] }>();

  for (const range of ranges) {
    if (range.source === "latest") {
      const latestPages = await getWorkPages(range.startDate, range.endDate);
      const pagesByDate = new Map<string, any[]>();

      for (const page of latestPages) {
        const date = getPageDate(page) ?? range.endDate;
        const entries = pagesByDate.get(date) ?? [];
        entries.push(page);
        pagesByDate.set(date, entries);
      }

      for (const [date, datePages] of [...pagesByDate.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        const tasksByPerson = await buildFormattedTasks(datePages, USER_IDS);
        const entry = byDate.get(date) ?? { youngmin: [], seyeon: [] };

        entry.youngmin.push(...(tasksByPerson.youngmin ?? []));
        entry.seyeon.push(...(tasksByPerson.seyeon ?? []));
        byDate.set(date, entry);
      }

      continue;
    }

    const legacyItems = await getLegacyWorkItemsForDateRange(
      range.startDate,
      range.endDate
    );

    for (const item of legacyItems) {
      const entry = byDate.get(item.date) ?? { youngmin: [], seyeon: [] };
      const formatted = formatWorkItem(item);

      if (item.users.includes(YOUNGMIN_ID)) entry.youngmin.push(formatted);
      if (item.users.includes(SEYEON_ID)) entry.seyeon.push(formatted);

      byDate.set(item.date, entry);
    }
  }

  const sortedByDate = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));

  const ymWeekly = sortedByDate
    .filter(([, value]) => value.youngmin.length > 0)
    .map(([date, value]) => ({ date, tasks: value.youngmin }));
  const syWeekly = sortedByDate
    .filter(([, value]) => value.seyeon.length > 0)
    .map(([date, value]) => ({ date, tasks: value.seyeon }));

  const endShort = toShortDate(endIso);
  const weekLabel = `${toShortDate(startIso)}~${toShortDate(endIso)}`;
  const weeklyJobs: Promise<void>[] = [];

  if (ymWeekly.length > 0) {
    weeklyJobs.push(
      generateWeeklySnippetContent("박영민", toShortDate(startIso), endShort, ymWeekly).then(
        (content) => sendSnippetMessage(content, "youngmin", "weekly", weekLabel)
      )
    );
  } else {
    weeklyJobs.push(sendNoTaskWarning("youngmin", weekLabel));
  }
  if (syWeekly.length > 0) {
    weeklyJobs.push(
      generateWeeklySnippetContent("조세연", toShortDate(startIso), endShort, syWeekly).then(
        (content) => sendSnippetMessage(content, "seyeon", "weekly", weekLabel)
      )
    );
  } else {
    weeklyJobs.push(sendNoTaskWarning("seyeon", weekLabel));
  }
  await Promise.all(weeklyJobs);
}

// ── 00:30 KST: 타임아웃 체크 & 자동 게시 ───────────────────────────────

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

// ── 중복 방지: 오늘 이미 전송된 스니펫 확인 ──────────────────────────────

async function getAlreadySentPersons(
  dateLabel: string,
  typeKo: string
): Promise<Set<"youngmin" | "seyeon">> {
  const sent = new Set<"youngmin" | "seyeon">();
  try {
    const messages = await getChannelMessages(CHANNEL_ID, 30);
    for (const msg of messages) {
      const title: string = msg.embeds?.[0]?.title ?? "";
      // 제목 형식: "📋 박영민 | 데일리 스니펫 (4/1)" 또는 "⚠️ ..."
      if (!title.includes(dateLabel)) continue;
      if (!title.includes(typeKo) && !title.includes("업무 없음")) continue;

      if (title.includes("박영민")) sent.add("youngmin");
      if (title.includes("조세연")) sent.add("seyeon");
    }
  } catch (err) {
    console.error("[daily-snippet] failed to check existing messages:", err);
  }
  return sent;
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────

async function sendNoTaskWarning(
  person: "youngmin" | "seyeon",
  dateLabel: string
) {
  const nameKo = person === "youngmin" ? "박영민" : "조세연";
  const color = person === "youngmin" ? 0x5865f2 : 0xeb459e;
  const embed = {
    title: `⚠️ ${nameKo} | 오늘 기록된 업무 없음 (${dateLabel})`,
    description:
      "어센텀 업무 DB에 오늘 완료 처리된 업무가 없어요!\n" +
      "혹시 까먹으셨나요? 업무의 '완료' 체크 후 `/snippet` 명령어로 다시 실행할 수 있어요.",
    color,
    footer: { text: "업무를 완료 체크한 뒤 /snippet 으로 강제 실행하세요" },
  };
  await sendDiscordMessage(CHANNEL_ID, [embed], []);
}

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
        {
          type: 2,
          style: 4, // DANGER (빨강)
          label: "건너뛰기 ⏭️",
          custom_id: `skip:${person}:${type}`,
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
