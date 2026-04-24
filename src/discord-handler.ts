import { sendDailySnippets } from "./services/daily-snippet-service";
import { finalizeDispatch } from "./services/dispatch-service";
import { DEFAULT_HEALTH_SCORE } from "./snippets";
import { Person, SnippetType } from "./types";

function interactionResponse(body: object, status = 200) {
  return { status, body };
}

function errorResponse(message: string) {
  return interactionResponse({
    type: 4,
    data: { content: `❌ ${message}`, flags: 64 },
  });
}

function getComponentValue(interaction: any, customId: string): string | null {
  for (const row of interaction.data.components ?? []) {
    for (const component of row.components ?? []) {
      if (component.custom_id === customId) {
        return component.value ?? null;
      }
    }
  }
  return null;
}

async function handleSlashCommand(interaction: any) {
  const commandName: string = interaction.data?.name ?? "";
  if (commandName !== "snippet") {
    return interactionResponse({ type: 1 });
  }

  const personOption = interaction.data?.options?.find(
    (option: any) => option.name === "person"
  )?.value as Person | undefined;

  setImmediate(() => {
    sendDailySnippets(new Date(), {
      targetPerson: personOption ?? null,
      force: Boolean(personOption),
    }).catch((error) => {
      console.error("[slash/snippet] trigger failed:", error);
    });
  });

  const targetLabel = personOption
    ? personOption === "youngmin"
      ? "박영민"
      : "조세연"
    : "전체";

  return interactionResponse({
    type: 4,
    data: {
      content: `⚡ 스니펫 강제 실행 (${targetLabel})을 시작했어요! 잠시 후 채널에서 확인하세요.`,
      flags: 64,
    },
  });
}

async function handleButtonClick(interaction: any) {
  const customId: string = interaction.data.custom_id;
  const [action] = customId.split(":") as [string, Person, SnippetType];
  const messageId: string = interaction.message.id;
  const snippetContent: string = interaction.message.embeds?.[0]?.description ?? "";

  if (action === "post") {
    const result = await finalizeDispatch({
      messageId,
      completionSource: "manual-post",
      healthScore: DEFAULT_HEALTH_SCORE,
    });

    if (!result.ok) return errorResponse(result.message);
    return interactionResponse({
      type: 4,
      data: { content: result.message, flags: 64 },
    });
  }

  if (action === "health") {
    return interactionResponse({
      type: 9,
      data: {
        custom_id: `modalhealth:${messageId}`,
        title: "헬스체크 점수 입력",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "score",
                label: "오늘의 컨디션 점수 (1~10)",
                style: 1,
                placeholder: "숫자만 입력 (예: 7)",
                value: String(DEFAULT_HEALTH_SCORE),
                required: true,
                max_length: 2,
              },
            ],
          },
        ],
      },
    });
  }

  if (action === "skip") {
    const result = await finalizeDispatch({
      messageId,
      completionSource: "manual-skip",
      baseContent: snippetContent,
      skip: true,
    });

    if (!result.ok) return errorResponse(result.message);
    return interactionResponse({
      type: 4,
      data: { content: result.message, flags: 64 },
    });
  }

  if (action === "edit") {
    return interactionResponse({
      type: 9,
      data: {
        custom_id: `modal:${messageId}`,
        title: "스니펫 수정",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "content",
                label: "내용 수정",
                style: 2,
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
                style: 1,
                value: String(DEFAULT_HEALTH_SCORE),
                required: true,
                max_length: 2,
              },
            ],
          },
        ],
      },
    });
  }

  return interactionResponse({ type: 1 });
}

async function handleModalSubmit(interaction: any) {
  const customId: string = interaction.data.custom_id;

  if (customId.startsWith("modalhealth:")) {
    const messageId = customId.split(":")[1];
    const score = getComponentValue(interaction, "score") ?? String(DEFAULT_HEALTH_SCORE);
    const result = await finalizeDispatch({
      messageId,
      completionSource: "manual-health",
      healthScore: score,
    });

    if (!result.ok) return errorResponse(result.message);
    return interactionResponse({
      type: 4,
      data: { content: result.message, flags: 64 },
    });
  }

  if (customId.startsWith("modal:")) {
    const messageId = customId.split(":")[1];
    const editedContent = getComponentValue(interaction, "content") ?? "";
    const score = getComponentValue(interaction, "score") ?? String(DEFAULT_HEALTH_SCORE);
    const result = await finalizeDispatch({
      messageId,
      completionSource: "manual-edit",
      healthScore: score,
      baseContent: editedContent,
    });

    if (!result.ok) return errorResponse(result.message);
    return interactionResponse({
      type: 4,
      data: { content: result.message, flags: 64 },
    });
  }

  return interactionResponse({ type: 1 });
}

export async function handleDiscordInteraction(rawBody: string) {
  const interaction = JSON.parse(rawBody);

  if (interaction.type === 1) {
    return interactionResponse({ type: 1 });
  }

  if (interaction.type === 2) {
    return handleSlashCommand(interaction);
  }

  if (interaction.type === 3) {
    return handleButtonClick(interaction);
  }

  if (interaction.type === 5) {
    return handleModalSubmit(interaction);
  }

  return interactionResponse({ type: 1 });
}
