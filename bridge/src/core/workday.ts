export function isWorkday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

export function workdayGap(from: string, to: string): number {
  if (to <= from) return -1;
  const start = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  let count = 0;
  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor < end) {
    if (isWorkday(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}
