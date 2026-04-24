import { getKstDateInfo } from "../lib/time";
import { config } from "./config";
import {
  createJobRun,
  finishJobRun,
  getSchedulerState,
  setSchedulerState,
} from "./database";
import { sendDailySnippets } from "./services/daily-snippet-service";
import { sweepDueDispatches } from "./services/dispatch-service";
import { runWeeklyReport } from "./services/weekly-report-service";

const DAILY_STATE_KEY = "last_daily_send_trigger_date";
const WEEKLY_STATE_KEY = "last_weekly_report_trigger_date";

function bootstrapSchedulerState(now: Date) {
  const { isoDate } = getKstDateInfo(now);
  const timestamp = now.toISOString();

  if (!getSchedulerState(DAILY_STATE_KEY)) {
    setSchedulerState(DAILY_STATE_KEY, isoDate, timestamp);
  }

  if (!getSchedulerState(WEEKLY_STATE_KEY)) {
    setSchedulerState(WEEKLY_STATE_KEY, isoDate, timestamp);
  }
}

async function runTrackedJob<T>(
  jobName: string,
  scheduledFor: string,
  work: () => Promise<T>
) {
  const startedAt = new Date().toISOString();
  const jobRunId = createJobRun(jobName, scheduledFor, startedAt);

  try {
    const result = await work();
    finishJobRun(jobRunId, "success", new Date().toISOString());
    return result;
  } catch (error) {
    finishJobRun(jobRunId, "failed", new Date().toISOString(), String(error));
    throw error;
  }
}

export function startScheduler() {
  let stopped = false;
  let running = false;

  bootstrapSchedulerState(new Date());

  const tick = async () => {
    if (stopped || running) return;
    running = true;

    try {
      await sweepDueDispatches();

      const now = new Date();
      const { isoDate, weekday } = getKstDateInfo(now);

      if (getSchedulerState(DAILY_STATE_KEY) !== isoDate) {
        await runTrackedJob("scheduled-daily-snippets", isoDate, async () => {
          const result = await sendDailySnippets(now);
          setSchedulerState(DAILY_STATE_KEY, isoDate, new Date().toISOString());
          return result;
        });
      }

      if (weekday === 4 && getSchedulerState(WEEKLY_STATE_KEY) !== isoDate) {
        await runTrackedJob("scheduled-weekly-report", isoDate, async () => {
          const result = await runWeeklyReport(now);
          setSchedulerState(WEEKLY_STATE_KEY, isoDate, new Date().toISOString());
          return result;
        });
      }
    } catch (error) {
      console.error("[scheduler] tick failed:", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const intervalId = setInterval(() => {
    void tick();
  }, config.schedulerTickSeconds * 1000);

  return {
    stop() {
      stopped = true;
      clearInterval(intervalId);
    },
  };
}
