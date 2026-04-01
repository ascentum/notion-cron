import { NextRequest, NextResponse, after } from "next/server";
import {
  verifyDiscordSignature,
  editDiscordMessage,
  getDiscordMessage,
} from "@/lib/discord";
import {
  postDailySnippet,
  postWeeklySnippet,
  triggerDailyFeedback,
  triggerWeeklyFeedback,
} from "@/lib/gcs";

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID!;
const GCS_TOKEN_YOUNGMIN = process.env.GCS_API_TOKEN_YOUNGMIN!;
const GCS_TOKEN_SEYEON = process.env.GCS_API_TOKEN_SEYEON!;
const DEFAULT_HEALTH_SCORE = "5";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature-ed25519") ?? "";
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";

  const isValid = verifyDiscordSignature(signature, timestamp, rawBody);
  if (!isValid) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // PING — Discord 엔드포인트 등록 시 검증용
  if (interaction.type === 1) {
    return NextResponse.json({ type: 1 });
  }

  // 슬래시 커맨드 (APPLICATION_COMMAND)
  if (interaction.type === 2) {
    return handleSlashCommand(interaction, req);
  }

  // 버튼 클릭 (MESSAGE_COMPONENT)
  if (interaction.type === 3) {
    return handleButtonClick(interaction);
  }

  // 모달 제출 (MODAL_SUBMIT)
  if (interaction.type === 5) {
    return handleModalSubmit(interaction);
  }

  return NextResponse.json({ type: 1 });
}

// ── 슬래시 커맨드 분기 ────────────────────────────────────────────────────

async function handleSlashCommand(interaction: any, req: NextRequest) {
  const commandName: string = interaction.data?.name ?? "";

  if (commandName === "snippet") {
    // /snippet person:youngmin 처럼 개인 지정 가능
    const personOption = interaction.data?.options?.find(
      (o: any) => o.name === "person"
    )?.value as string | undefined;

    const baseUrl = new URL(req.url).origin;
    const personParam = personOption ? `&person=${personOption}` : "";
    after(async () => {
      try {
        await fetch(
          `${baseUrl}/api/daily-snippet?action=send${personParam}`,
          {
            headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
          }
        );
      } catch (err) {
        console.error("[slash/snippet] trigger failed:", err);
      }
    });

    const targetLabel = personOption
      ? personOption === "youngmin"
        ? "박영민"
        : "조세연"
      : "전체";
    return NextResponse.json({
      type: 4,
      data: {
        content: `⚡ 스니펫 강제 실행 (${targetLabel})을 시작했어요! 잠시 후 채널에서 확인하세요.`,
        flags: 64, // ephemeral
      },
    });
  }

  return NextResponse.json({ type: 1 });
}

// ── 버튼 클릭 분기 ────────────────────────────────────────────────────────

async function handleButtonClick(interaction: any) {
  const customId: string = interaction.data.custom_id;
  const [action, person, type] = customId.split(":");
  const messageId: string = interaction.message.id;
  const snippetContent: string = interaction.message.embeds?.[0]?.description ?? "";
  const originalEmbed = interaction.message.embeds?.[0];

  // ① 그대로 게시 — 헬스체크 기본값 5
  if (action === "post") {
    const finalContent = appendHealthCheck(snippetContent, DEFAULT_HEALTH_SCORE);
    const result = await tryPost(person, type, finalContent);
    if (!result.ok) {
      return errorResponse(result.error);
    }
    await editDiscordMessage(
      CHANNEL_ID,
      messageId,
      [doneEmbed(originalEmbed, `✅ 게시 완료 (헬스체크: ${DEFAULT_HEALTH_SCORE}점)`)],
      []
    );
    return NextResponse.json({
      type: 4,
      data: { content: `✅ 게시 완료! (헬스체크 ${DEFAULT_HEALTH_SCORE}점)`, flags: 64 },
    });
  }

  // ② 헬스체크 입력 — 숫자만 입력하는 간단한 모달
  if (action === "health") {
    return NextResponse.json({
      type: 9, // MODAL
      data: {
        custom_id: `modalhealth:${person}:${type}:${messageId}`,
        title: "헬스체크 점수 입력",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "score",
                label: "오늘의 컨디션 점수 (1~10)",
                style: 1, // SHORT
                placeholder: "숫자만 입력 (예: 7)",
                value: DEFAULT_HEALTH_SCORE,
                required: true,
                max_length: 2,
              },
            ],
          },
        ],
      },
    });
  }

  // ④ 건너뛰기 — GCS 게시 없이 스킵
  if (action === "skip") {
    await editDiscordMessage(
      CHANNEL_ID,
      messageId,
      [doneEmbed({ ...originalEmbed, color: 0x95a5a6 }, "⏭️ 건너뛰기 — 게시하지 않음")],
      []
    );
    return NextResponse.json({
      type: 4,
      data: { content: "⏭️ 이 스니펫은 건너뛰었어요.", flags: 64 },
    });
  }

  // ③ 수정하기 — 전체 내용 + 헬스체크 2개 필드 모달
  if (action === "edit") {
    return NextResponse.json({
      type: 9, // MODAL
      data: {
        custom_id: `modal:${person}:${type}:${messageId}`,
        title: "스니펫 수정",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "content",
                label: "내용 수정",
                style: 2, // PARAGRAPH
                value: snippetContent,
                required: true,
                max_length: 4000,
              },
            ],
          },
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "score",
                label: "헬스체크 점수 (1~10)",
                style: 1, // SHORT
                value: DEFAULT_HEALTH_SCORE,
                required: true,
                max_length: 2,
              },
            ],
          },
        ],
      },
    });
  }

  return NextResponse.json({ type: 1 });
}

// ── 모달 제출 분기 ────────────────────────────────────────────────────────

async function handleModalSubmit(interaction: any) {
  const customId: string = interaction.data.custom_id;
  const parts = customId.split(":");
  const modalType = parts[0]; // "modal" | "modalhealth"
  const person = parts[1];
  const type = parts[2];
  const originalMessageId = parts[3];

  // ② 헬스체크 모달 제출 — 원본 내용 유지, 점수만 추가
  if (modalType === "modalhealth") {
    const score = getComponentValue(interaction, "score") ?? DEFAULT_HEALTH_SCORE;

    // 원본 Discord 메시지에서 snippet 내용 가져오기
    let snippetContent = "";
    try {
      const originalMsg = await getDiscordMessage(CHANNEL_ID, originalMessageId);
      snippetContent = originalMsg.embeds?.[0]?.description ?? "";
    } catch (err) {
      console.error("[discord-interact] fetch original message failed:", err);
      return errorResponse("원본 메시지를 불러오지 못했어요: " + String(err));
    }

    const finalContent = appendHealthCheck(snippetContent, score);
    const result = await tryPost(person, type, finalContent);
    if (!result.ok) return errorResponse(result.error);

    await safeEditMessage(originalMessageId, person, type, snippetContent, `✅ 게시 완료 (헬스체크: ${score}점)`);
    return NextResponse.json({
      type: 4,
      data: { content: `✅ 게시 완료! (헬스체크 ${score}점)`, flags: 64 },
    });
  }

  // ③ 수정하기 모달 제출 — 내용 + 점수 모두 수정
  if (modalType === "modal") {
    const editedContent = getComponentValue(interaction, "content") ?? "";
    const score = getComponentValue(interaction, "score") ?? DEFAULT_HEALTH_SCORE;

    const finalContent = appendHealthCheck(editedContent, score);
    const result = await tryPost(person, type, finalContent);
    if (!result.ok) return errorResponse(result.error);

    await safeEditMessage(originalMessageId, person, type, editedContent, `✅ 수정 후 게시 완료 (헬스체크: ${score}점)`);
    return NextResponse.json({
      type: 4,
      data: { content: `✅ 수정 후 게시 완료! (헬스체크 ${score}점)`, flags: 64 },
    });
  }

  return NextResponse.json({ type: 1 });
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────

// 헬스체크 섹션 덧붙이기
function appendHealthCheck(content: string, score: string): string {
  const safeScore = parseInt(score);
  const finalScore = isNaN(safeScore) || safeScore < 1 || safeScore > 10
    ? DEFAULT_HEALTH_SCORE
    : String(safeScore);
  return `${content.trimEnd()}\n\n헬스 체크 (10점)\n${finalScore}`;
}

// GCS Pulse 게시
async function tryPost(
  person: string,
  type: string,
  content: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = person === "youngmin" ? GCS_TOKEN_YOUNGMIN : GCS_TOKEN_SEYEON;
  try {
    if (type === "weekly") {
      await postWeeklySnippet(token, content);
    } else {
      await postDailySnippet(token, content);
    }
    // 게시 성공 후 AI 채점 자동 트리거 (fire-and-forget)
    fireFeedback(person, type);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// AI 채점 비동기 트리거
function fireFeedback(person: string, type: string) {
  const token = person === "youngmin" ? GCS_TOKEN_YOUNGMIN : GCS_TOKEN_SEYEON;
  const trigger = type === "weekly" ? triggerWeeklyFeedback : triggerDailyFeedback;
  trigger(token).catch((err) =>
    console.error(`[feedback] ${person}:${type} failed:`, err)
  );
}

// Discord 메시지 완료 상태로 수정
async function safeEditMessage(
  messageId: string,
  person: string,
  type: string,
  content: string,
  footerText: string
) {
  try {
    const nameKo = person === "youngmin" ? "박영민" : "조세연";
    const typeKo = type === "daily" ? "데일리" : "주간";
    await editDiscordMessage(
      CHANNEL_ID,
      messageId,
      [
        {
          title: `📋 ${nameKo} | ${typeKo} 스니펫`,
          description: content,
          color: 0x57f287, // 초록
          footer: { text: footerText },
        },
      ],
      [] // 버튼 제거
    );
  } catch (err) {
    console.error("[discord-interact] edit message failed:", err);
  }
}

// 완료 embed 생성 (원본 embed 재활용)
function doneEmbed(original: any, footerText: string) {
  return { ...original, color: 0x57f287, footer: { text: footerText } };
}

// 모달 컴포넌트 값 추출
function getComponentValue(interaction: any, customId: string): string | null {
  for (const row of interaction.data.components ?? []) {
    for (const comp of row.components ?? []) {
      if (comp.custom_id === customId) return comp.value ?? null;
    }
  }
  return null;
}

// 에러 응답
function errorResponse(message: string) {
  return NextResponse.json({
    type: 4,
    data: { content: `❌ 실패: ${message}`, flags: 64 },
  });
}
