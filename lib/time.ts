const KST_OFFSET_MINUTES = 9 * 60;

function getKstDate(date: Date): Date {
  return new Date(date.getTime() + KST_OFFSET_MINUTES * 60 * 1000);
}

export function shiftIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getPreviousWeekDateRange(anchorIsoDate: string) {
  const endIso = shiftIsoDate(anchorIsoDate, -1);
  const startIso = shiftIsoDate(endIso, -6);

  return {
    startIso,
    endIso,
  };
}

export function getKstDateInfo(now: Date = new Date()) {
  const kstDate = getKstDate(now);
  const isoDate = kstDate.toISOString().slice(0, 10);
  const weekday = kstDate.getUTCDay();

  return {
    isoDate,
    weekday,
  };
}

export function getDailySnippetDateInfo(now: Date = new Date()) {
  const { isoDate: triggerIsoDate, weekday } = getKstDateInfo(now);

  return {
    triggerIsoDate,
    targetIsoDate: shiftIsoDate(triggerIsoDate, -1),
    weekday,
  };
}

export function toKstIsoDate(dateValue: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return dateValue;
  }

  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return dateValue.slice(0, 10);
  }

  return getKstDate(parsed).toISOString().slice(0, 10);
}

export function getKstDateTimeRange(startIsoDate: string, endIsoDate: string) {
  return {
    start: `${startIsoDate}T00:00:00.000+09:00`,
    end: `${endIsoDate}T23:59:59.999+09:00`,
  };
}
