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
