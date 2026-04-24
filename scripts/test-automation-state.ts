import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-cron-db-"));
  process.env.SQLITE_DB_PATH = path.join(tempDir, "automation.sqlite");

  const database = await import("../src/database");
  const snippets = await import("../src/snippets");

  const created = database.createDispatch({
    discordMessageId: "message-1",
    person: "youngmin",
    snippetType: "daily",
    dateLabel: "4/24",
    content: "**오늘 한 일**\n- 테스트",
    dueAt: "2026-04-24T00:30:00.000Z",
    createdAt: "2026-04-24T00:00:00.000Z",
  });

  assert.equal(created.status, "pending");
  assert.deepEqual(database.listExistingDispatchPeople("4/24", "daily"), [
    "youngmin",
  ]);

  const claimed = database.claimPendingDispatchByMessageId(
    "message-1",
    "2026-04-24T00:31:00.000Z"
  );
  assert.ok(claimed);
  assert.equal(claimed?.status, "posting");

  database.markDispatchPosted("message-1", {
    content: created.content,
    healthScore: 5,
    completionSource: "auto",
    postedAt: "2026-04-24T00:31:30.000Z",
  });

  const posted = database.getDispatchByMessageId("message-1");
  assert.equal(posted?.status, "posted");
  assert.equal(posted?.healthScore, 5);
  assert.equal(
    snippets.appendHealthCheck("내용", 5),
    "내용\n\n헬스 체크 (10점)\n5"
  );

  database.createDispatch({
    discordMessageId: "message-2",
    person: "seyeon",
    snippetType: "weekly",
    dateLabel: "4/14~4/20",
    content: "초안",
    dueAt: "2026-04-24T00:30:00.000Z",
    createdAt: "2026-04-24T00:00:00.000Z",
  });
  database.claimPendingDispatchByMessageId(
    "message-2",
    "2026-04-24T00:31:00.000Z"
  );
  database.markDispatchFailed("message-2", {
    content: "초안",
    error: "GCS failed",
    failedAt: "2026-04-24T00:31:30.000Z",
  });

  const failed = database.getDispatchByMessageId("message-2");
  assert.equal(failed?.status, "failed");

  const requeued = database.requeueFailedDispatch(
    failed!.id,
    "2026-04-24T00:32:00.000Z"
  );
  assert.equal(requeued?.status, "pending");

  database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("automation state tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
