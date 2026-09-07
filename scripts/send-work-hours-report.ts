import dotenv from "dotenv";

// 이 잡과 무관한 필수 환경변수는 자리표시자로 채워서 config 로딩만 통과시킨다
function fillUnrelatedRequiredEnv() {
  const placeholders = [
    "INTERNAL_ADMIN_TOKEN",
    "DISCORD_CHANNEL_ID",
    "NOTION_USER_YOUNGMIN",
    "NOTION_USER_SEYEON",
    "GCS_API_TOKEN_YOUNGMIN",
    "GCS_API_TOKEN_SEYEON",
  ];
  for (const name of placeholders) {
    if (!process.env[name]) process.env[name] = "unused-for-this-script";
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const weekIndex = args.indexOf("--week");
  const targetWeekStart = weekIndex === -1 ? undefined : args[weekIndex + 1];
  const envIndex = args.indexOf("--env");

  // --env 로 지정한 파일을 먼저 읽고, 없는 값만 .env / .env.local 이 채운다
  if (envIndex !== -1) {
    dotenv.config({ path: args[envIndex + 1], override: true });
  }

  const { loadEnvironment } = require("../src/load-env") as typeof import("../src/load-env");
  loadEnvironment();
  fillUnrelatedRequiredEnv();

  const { runWorkHoursReport } =
    require("../src/services/work-hours-service") as typeof import("../src/services/work-hours-service");

  const result = await runWorkHoursReport(new Date(), { dryRun, targetWeekStart });

  console.log("\n----- 전송 메시지 -----");
  console.log(result.message);
  console.log("----------------------\n");
  console.log({
    weekStart: result.weekStart,
    weekEnd: result.weekEnd,
    totalHours: result.totalHours,
    previousHours: result.previousHours,
    averageHours: result.averageHours,
    sessionCount: result.sessionCount,
    sent: result.sent,
  });
}

main().catch((error) => {
  console.error("[work-hours] 실패:", error);
  process.exit(1);
});
