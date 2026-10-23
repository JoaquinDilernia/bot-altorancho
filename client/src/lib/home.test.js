import { describe, it, expect } from 'vitest';
import { fmt, kpiDelta, tediSummary, waitingQueue, activityFeed, relTime, shouldFetchWeek, WEEK_REFRESH_MS, firstResponseDelta } from './home';

const NOW = new Date('2026-10-20T15:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
const areas = [{ id: 'ventas', name: 'Ventas' }];
const nameMap = { ventas: 'Ventas', ag1: 'Joaquín' };
const ctx = { botName: 'Alto', areas, nameMap, now: NOW };

describe('fmt', () => {
  it('formats minutes', () => {
    expect(fmt(18)).toBe('18 min');
    expect(fmt(60)).toBe('1 h');
    expect(fmt(65)).toBe('1 h 5 min');
  });
});

describe('kpiDelta', () => {
  it('returns null when previous is empty', () => {
    expect(kpiDelta(5, 0)).toBeNull();
    expect(kpiDelta(5, null)).toBeNull();
    expect(kpiDelta(5, undefined)).toBeNull();
  });
  it('returns the percent change', () => {
    expect(kpiDelta(112, 100)).toBe(12);
    expect(kpiDelta(50, 100)).toBe(-50);
  });
});

describe('tediSummary', () => {
  it('no conversations', () => {
    expect(tediSummary({ total: 0 }, { botName: 'Alto' })).toEqual(['Todavía no entró nadie hoy. Acá te aviso apenas llegue alguien 👀']);
  });
  it('with waiting', () => {
    expect(tediSummary({ total: 42, resolvedByBot: 31, escalatedCount: 8, awaitingAgent: 3, oldestAwaitingMin: 18 }, { botName: 'Alto' }))
      .toEqual(['Hoy ya atendí 42 conversaciones y resolví 31 yo solo 💪', 'Te pasé 8 que necesitaban a alguien del equipo. 3 te están esperando, la más vieja hace 18 min.']);
  });
  it('singular', () => {
    expect(tediSummary({ total: 1, resolvedByBot: 1, escalatedCount: 0 }, { botName: 'Alto' })).toEqual(['Hoy ya atendí 1 conversación y resolví 1 yo solo 💪']);
  });
  it('all attended', () => {
    expect(tediSummary({ total: 5, resolvedByBot: 2, escalatedCount: 3, awaitingAgent: 0 }, { botName: 'Alto' })[1])
      .toBe('Te pasé 3 que necesitaban a alguien del equipo. Ya están todas atendidas 🙌');
  });
});

describe('waitingQueue', () => {
  const convs = [
    { id: 'nuevo', status: 'escalated', humanMode: true, assignedTo: 'ventas', waitingSince: ago(2) },
    { id: 'viejo', status: 'escalated', humanMode: true, waitingSince: ago(18) },
    { id: 'viejo2', status: 'bot', humanMode: true, escalatedAt: ago(7) },
    { id: 'tomada', status: 'escalated', humanMode: true, assignedTo: 'ag1', waitingSince: ago(30) },
    { id: 'bot', status: 'bot', humanMode: false, waitingSince: ago(40) },
    { id: 'res', status: 'resolved', waitingSince: ago(50) },
    // Derivada a un área y un agente ya respondió (sin "Intervenir"): no espera.
    { id: 'respondida', status: 'escalated', humanMode: true, assignedTo: 'ventas', escalatedAt: ago(90), firstAgentResponseAt: ago(80) },
  ];
  it('orders by wait desc and excludes taken / non escalated', () => {
    const q = waitingQueue(convs, { areas, nameMap, now: NOW });
    expect(q.map((c) => c.id)).toEqual(['viejo', 'viejo2', 'nuevo']);
    expect(q[0].waitMin).toBe(18);
    expect(q[1].waitMin).toBe(7);
  });
  it('incluye Instagram y el legado urgent; con agents solo un agente la saca', () => {
    const q = waitingQueue([
      { id: 'ig', channel: 'instagram', status: 'escalated', humanMode: true, waitingSince: ago(9) },
      { id: 'urg', status: 'urgent', humanMode: true, waitingSince: ago(4) },
      { id: 'raro', status: 'escalated', humanMode: true, assignedTo: 'no-es-agente', waitingSince: ago(1) },
      { id: 'tomada', status: 'escalated', humanMode: true, assignedTo: 'ag1', waitingSince: ago(30) },
    ], { areas, nameMap, agents: [{ id: 'ag1' }], now: NOW });
    expect(q.map((c) => c.id)).toEqual(['ig', 'urg', 'raro']);
  });
});

describe('activityFeed', () => {
  it('hides archived', () => {
    expect(activityFeed([{ id: 'a', status: 'bot_archived', updatedAt: ago(1) }], ctx)).toEqual([]);
  });
  it('maps states to events', () => {
    const feed = activityFeed([
      { id: '1', status: 'resolved', contactName: 'Diego', updatedAt: ago(1) },
      { id: '2', status: 'escalated', humanMode: true, assignedTo: 'ventas', contactName: 'Lucía', updatedAt: ago(7) },
      { id: '3', status: 'escalated', humanMode: true, assignedTo: 'ag1', contactName: 'Don José', updatedAt: ago(12) },
      { id: '4', status: 'bot', contactName: 'Martina', updatedAt: ago(90) },
    ], ctx);
    expect(feed.map((e) => e.icon)).toEqual(['ok', 'handoff', 'agent', 'bot']);
    expect(feed[0]).toMatchObject({ key: '1', title: 'Se resolvió la conversación con Diego', sub: 'hace 1 min' });
    expect(feed[1].title).toBe('Alto derivó a Lucía a Ventas');
    expect(feed[2].title).toBe('El equipo atiende a Don José');
    expect(feed[3]).toMatchObject({ title: 'Alto está hablando con Martina', sub: 'hace 1 h' });
  });
  it('takes the 6 most recent', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, status: 'bot', contactName: 'X', updatedAt: ago(i + 1) }));
    expect(activityFeed(many, ctx).map((e) => e.key)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });
});

describe('relTime', () => {
  it('formats', () => {
    expect(relTime(ago(0), NOW)).toBe('ahora');
    expect(relTime(ago(1500), NOW)).toBe('hace 1 d');
    expect(relTime(null, NOW)).toBe('');
  });
});

describe('shouldFetchWeek', () => {
  const T = 1_800_000_000_000;
  it('primera carga: sí', () => expect(shouldFetchWeek(null, T)).toBe(true));
  it('polling antes de 10 min: no', () => expect(shouldFetchWeek(T, T + 60_000)).toBe(false));
  it('polling a los 9:59: no', () => expect(shouldFetchWeek(T, T + WEEK_REFRESH_MS - 1000)).toBe(false));
  it('polling a los 10 min: sí', () => expect(shouldFetchWeek(T, T + WEEK_REFRESH_MS)).toBe(true));
  it('refresco manual: sí aunque sea reciente', () => expect(shouldFetchWeek(T, T + 1000, { force: true })).toBe(true));
});

describe('firstResponseDelta', () => {
  it('en minutos, igual que el valor', () => expect(firstResponseDelta(84, 39)).toBe('+45 min'));
  it('más de una hora', () => expect(firstResponseDelta(84, 19)).toBe('+1 h 5 min'));
  it('baja: signo menos', () => expect(firstResponseDelta(39, 84)).toBe('-45 min'));
  it('menos de un minuto: segundos', () => expect(firstResponseDelta(0.5, 1)).toBe('-30s'));
  it('sin variación', () => expect(firstResponseDelta(5, 5)).toBe('0 min'));
  it('sin base: null', () => {
    expect(firstResponseDelta(5, null)).toBeNull();
    expect(firstResponseDelta(null, 5)).toBeNull();
  });
});
