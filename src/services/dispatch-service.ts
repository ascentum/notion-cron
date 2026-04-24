import { config } from "../config";
import {
  claimPendingDispatchByMessageId,
  createDispatch,
  getDispatchById,
  getDispatchByMessageId,
  listDuePendingDispatches,
  markDispatchFailed,
  markDispatchPosted,
  markDispatchSkipped,
  requeueFailedDispatch,
} from "../database";
import {
  DEFAULT_HEALTH_SCORE,
  appendHealthCheck,
  buildCompletedSnippetEmbed,
  buildPendingSnippetComponents,
  buildPendingSnippetEmbed,
  normalizeHealthScore,
} from "../snippets";
import {
  CompletionSource,
  DispatchRecord,
  Person,
  SnippetType,
} from "../types";
import { editDiscordMessage, sendDiscordMessage } from "../../lib/discord";
import {
  postDailySnippet,
  postWeeklySnippet,
  triggerDailyFeedback,
  triggerWeeklyFeedback,
} from "../../lib/gcs";

export interface FinalizeDispatchOptions {
  messageId: string;
  completionSource: CompletionSource;
  healthScore?: number | string;
  baseContent?: string;
  skip?: boolean;
}

export interface FinalizeDispatchResult {
  ok: boolean;
  dispatch: DispatchRecord | null;
  message: string;
  alreadyProcessed?: boolean;
}

function getDueAt(now: Date) {
  return new Date(
    now.getTime() + config.autoPostDelayMinutes * 60 * 1000
  ).toISOString();
}

function footerTextForPosted(
  completionSource: CompletionSource,
  healthScore: number
) {
  if (completionSource === "manual-edit") {
    return `✅ 수정 후 게시 완료 (헬스체크: ${healthScore}점)`;
  }
  if (completionSource === "auto") {
    return `⏰ 자동 게시됨 (헬스체크: ${healthScore}점)`;
  }
  return `✅ 게시 완료 (헬스체크: ${healthScore}점)`;
}

function alreadyProcessedMessage(dispatch: DispatchRecord | null) {
  if (!dispatch) {
    return "이 메시지는 현재 시스템에 등록되어 있지 않아요.";
  }

  switch (dispatch.status) {
    case "posted":
      return "이미 게시 완료된 스니펫이에요.";
    case "skipped":
      return "이미 건너뛴 스니펫이에요.";
    case "posting":
      return "이 스니펫은 현재 처리 중이에요.";
    case "failed":
      return "이 스니펫은 이전 처리에 실패했어요. 관리자 재시도가 필요해요.";
    default:
      return "이 스니펫은 현재 처리할 수 없는 상태예요.";
  }
}

function getGcsToken(person: Person) {
  return config.gcsApiTokens[person];
}

async function postSnippetToGcs(
  person: Person,
  snippetType: SnippetType,
  content: string
) {
  const token = getGcsToken(person);

  if (snippetType === "weekly") {
    await postWeeklySnippet(token, content);
    triggerWeeklyFeedback(token).catch((error) => {
      console.error(`[feedback] ${person}:${snippetType} failed:`, error);
    });
    return;
  }

  await postDailySnippet(token, content);
  triggerDailyFeedback(token).catch((error) => {
    console.error(`[feedback] ${person}:${snippetType} failed:`, error);
  });
}

async function updateDiscordMessageBestEffort(
  dispatch: DispatchRecord,
  embed: object
) {
  try {
    await editDiscordMessage(
      config.discordChannelId,
      dispatch.discordMessageId,
      [embed],
      []
    );
    return null;
  } catch (error) {
    const message = String(error);
    console.error(
      `[dispatch] failed to update Discord message ${dispatch.discordMessageId}:`,
      error
    );
    return message;
  }
}

export async function queuePendingSnippetMessage(
  person: Person,
  snippetType: SnippetType,
  dateLabel: string,
  content: string
) {
  const messageId = await sendDiscordMessage(
    config.discordChannelId,
    [buildPendingSnippetEmbed(person, snippetType, dateLabel, content)],
    buildPendingSnippetComponents(person, snippetType)
  );

  return createDispatch({
    discordMessageId: messageId,
    person,
    snippetType,
    dateLabel,
    content,
    dueAt: getDueAt(new Date()),
  });
}

export async function finalizeDispatch(
  options: FinalizeDispatchOptions
): Promise<FinalizeDispatchResult> {
  const nowIso = new Date().toISOString();
  const claimed = claimPendingDispatchByMessageId(options.messageId, nowIso);

  if (!claimed) {
    const existing = getDispatchByMessageId(options.messageId);
    return {
      ok: false,
      dispatch: existing,
      message: alreadyProcessedMessage(existing),
      alreadyProcessed: true,
    };
  }

  const baseContent = options.baseContent ?? claimed.content;

  if (options.skip) {
    const footerText = "⏭️ 건너뛰기 — 게시하지 않음";
    await updateDiscordMessageBestEffort(
      claimed,
      buildCompletedSnippetEmbed(
        claimed.person,
        claimed.snippetType,
        claimed.dateLabel,
        baseContent,
        footerText,
        0x95a5a6
      )
    );

    markDispatchSkipped(options.messageId, {
      content: baseContent,
      completionSource: options.completionSource,
      skippedAt: new Date().toISOString(),
    });

    return {
      ok: true,
      dispatch: getDispatchByMessageId(options.messageId),
      message: "⏭️ 이 스니펫은 건너뛰었어요.",
    };
  }

  const healthScore = normalizeHealthScore(
    options.healthScore ?? DEFAULT_HEALTH_SCORE
  );
  const finalContent = appendHealthCheck(baseContent, healthScore);

  try {
    await postSnippetToGcs(claimed.person, claimed.snippetType, finalContent);

    const editError = await updateDiscordMessageBestEffort(
      claimed,
      buildCompletedSnippetEmbed(
        claimed.person,
        claimed.snippetType,
        claimed.dateLabel,
        baseContent,
        footerTextForPosted(options.completionSource, healthScore),
        0x57f287
      )
    );

    const postedAt = new Date().toISOString();
    markDispatchPosted(options.messageId, {
      content: baseContent,
      healthScore,
      completionSource: options.completionSource,
      postedAt,
      lastError: editError,
    });

    return {
      ok: true,
      dispatch: getDispatchByMessageId(options.messageId),
      message:
        options.completionSource === "manual-edit"
          ? `✅ 수정 후 게시 완료! (헬스체크 ${healthScore}점)`
          : `✅ 게시 완료! (헬스체크 ${healthScore}점)`,
    };
  } catch (error) {
    markDispatchFailed(options.messageId, {
      content: baseContent,
      error: String(error),
      failedAt: new Date().toISOString(),
    });

    return {
      ok: false,
      dispatch: getDispatchByMessageId(options.messageId),
      message: `게시 중 오류가 발생했어요: ${String(error)}`,
    };
  }
}

export async function sweepDueDispatches(now: Date = new Date()) {
  const dueDispatches = listDuePendingDispatches(now.toISOString());
  let autoPosted = 0;
  let failed = 0;

  for (const dispatch of dueDispatches) {
    const result = await finalizeDispatch({
      messageId: dispatch.discordMessageId,
      completionSource: "auto",
      healthScore: DEFAULT_HEALTH_SCORE,
    });

    if (result.ok) {
      autoPosted++;
    } else if (!result.alreadyProcessed) {
      failed++;
    }
  }

  return {
    checked: dueDispatches.length,
    autoPosted,
    failed,
  };
}

export async function retryFailedDispatch(id: number) {
  const requeued = requeueFailedDispatch(id, new Date().toISOString());
  if (!requeued) {
    return {
      ok: false,
      dispatch: getDispatchById(id),
      message: "재시도 가능한 실패 건을 찾지 못했어요.",
    };
  }

  return finalizeDispatch({
    messageId: requeued.discordMessageId,
    completionSource: "auto",
    healthScore: DEFAULT_HEALTH_SCORE,
  });
}
