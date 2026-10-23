const TZ = 'America/Argentina/Buenos_Aires';

// true si `date` cae dentro del horario de atención, evaluado en hora Argentina.
export function isWithinBusinessHoursAt(date, botConfig = {}) {
  const now = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  const day = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  const timeMin = now.getHours() * 60 + now.getMinutes();

  const startH = botConfig.businessHoursStart ?? 9;
  const endH   = botConfig.businessHoursEnd   ?? 18;
  const days   = botConfig.businessDays        ?? [1, 2, 3, 4, 5]; // lun-vie

  return days.includes(day) && timeMin >= startH * 60 && timeMin < endH * 60;
}
