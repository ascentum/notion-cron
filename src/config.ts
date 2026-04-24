import { loadEnvironment } from "./load-env";

loadEnvironment();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer environment variable: ${name}=${raw}`);
  }

  return parsed;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid boolean environment variable: ${name}=${raw}`);
}

export const config = {
  port: optionalInteger("PORT", 3000),
  sqlitePath: process.env.SQLITE_DB_PATH ?? "./data/automation.sqlite",
  internalAdminToken: required("INTERNAL_ADMIN_TOKEN"),
  appBaseUrl: process.env.APP_BASE_URL ?? "",
  enableScheduler: optionalBoolean(
    "ENABLE_SCHEDULER",
    process.env.NODE_ENV === "production"
  ),
  discordChannelId: required("DISCORD_CHANNEL_ID"),
  autoPostDelayMinutes: optionalInteger("AUTO_POST_DELAY_MINUTES", 30),
  schedulerTickSeconds: optionalInteger("SCHEDULER_TICK_SECONDS", 60),
  notionUserIds: {
    youngmin: required("NOTION_USER_YOUNGMIN"),
    seyeon: required("NOTION_USER_SEYEON"),
  },
  gcsApiTokens: {
    youngmin: required("GCS_API_TOKEN_YOUNGMIN"),
    seyeon: required("GCS_API_TOKEN_SEYEON"),
  },
} as const;
