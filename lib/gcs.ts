const GCS_API = "https://api.1000.school";

async function postSnippet(
  path: string,
  apiToken: string,
  content: string
): Promise<void> {
  const res = await fetch(`${GCS_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`GCS ${path} failed: ${res.status} ${await res.text()}`);
  }
}

export const postDailySnippet = (token: string, content: string) =>
  postSnippet("/daily-snippets", token, content);

export const postWeeklySnippet = (token: string, content: string) =>
  postSnippet("/weekly-snippets", token, content);

// AI 채점 트리거 — 게시 후 자동으로 피드백 생성 요청
async function triggerFeedback(path: string, apiToken: string): Promise<void> {
  const res = await fetch(`${GCS_API}${path}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) {
    throw new Error(`GCS ${path} feedback failed: ${res.status} ${await res.text()}`);
  }
  // SSE 스트림일 수 있으므로 body 소비
  await res.text();
}

export const triggerDailyFeedback = (token: string) =>
  triggerFeedback("/daily-snippets/feedback", token);

export const triggerWeeklyFeedback = (token: string) =>
  triggerFeedback("/weekly-snippets/feedback", token);
