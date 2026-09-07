import type { CalendarEventLike } from "./work-hours";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export const CALENDAR_READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";

interface ListEventsParams {
  calendarId: string;
  timeMin: string;
  timeMax: string;
}

let cachedToken: { value: string; expiresAtMs: number } | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name} (구글 캘린더 연동 설정이 필요해요)`
    );
  }
  return value;
}

// 리프레시 토큰으로 액세스 토큰 발급 (만료 1분 전까지 프로세스 내 캐시)
export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now()) {
    return cachedToken.value;
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      refresh_token: requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Google token refresh failed: ${res.status} ${await res.text()}`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };

  cachedToken = {
    value: data.access_token,
    expiresAtMs: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  };

  return cachedToken.value;
}

// 반복 일정을 개별 인스턴스로 펼쳐서(singleEvents) 기간 내 전체 일정 조회
export async function listCalendarEvents(
  params: ListEventsParams
): Promise<CalendarEventLike[]> {
  const accessToken = await getAccessToken();
  const events: CalendarEventLike[] = [];
  let pageToken: string | undefined;

  do {
    const query = new URLSearchParams({
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
    });
    if (pageToken) query.set("pageToken", pageToken);

    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(params.calendarId)}/events?${query}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) {
      throw new Error(
        `Google Calendar events.list failed: ${res.status} ${await res.text()}`
      );
    }

    const data = (await res.json()) as {
      items?: CalendarEventLike[];
      nextPageToken?: string;
    };

    events.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return events;
}
