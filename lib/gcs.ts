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
