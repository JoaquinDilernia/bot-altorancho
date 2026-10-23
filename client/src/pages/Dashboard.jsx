import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authFetch, BASE_URL } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useBrand } from '../contexts/BrandContext';
import BotFace from '../components/ui/BotFace';
import Skeleton from '../components/ui/Skeleton';
import { useCountUp } from '../hooks/useCountUp';
import { useFirstLoad } from '../hooks/useFirstLoad';
import { waitLevel, avatarColor, initials, pillFor, mergeWaiting } from '../lib/conversationView';
import { tediSummary, waitingQueue, activityFeed, kpiDelta, fmt, relTime, shouldFetchWeek, firstResponseDelta } from '../lib/home';
import styles from './Dashboard.module.css';

const TYPING_MS = 800;
const POLL_MS = 60000;
const FEED_ICON = { ok: '✓', handoff: '↪', agent: '👤', bot: '💬' };

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

function todayLabel() {
  const s = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clock() {
  return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function CountNum({ value, animate, suffix = '' }) {
  const v = useCountUp(value, { animate });
  return <>{v}{suffix}</>;
}

function Spark({ values, color, delay }) {
  if (!values || values.length < 2 || Math.max(...values) === Math.min(...values)) {
    return <div className={styles.sparkEmpty} />;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pts = values
    .map((v, i) => `${Math.round((i / (values.length - 1)) * 120)},${(20 - ((v - min) / (max - min)) * 17).toFixed(1)}`)
    .join(' ');
  return (
    <svg width="100%" height="22" viewBox="0 0 120 22" preserveAspectRatio="none" className={styles.spark}>
      <polyline className="anim-draw" style={{ '--d': `${delay}ms` }} fill="none" stroke={color} strokeWidth="2" points={pts} />
    </svg>
  );
}

function Delta({ text, good }) {
  if (text === null) return <span className={`${styles.delta} ${styles.deltaNone}`}>—</span>;
  return <span className={`${styles.delta} ${good ? '' : styles.deltaDown}`}>{text}</span>;
}

function signed(n, unit = '') {
  return `${n > 0 ? '+' : ''}${n}${unit}`;
}

export default function Dashboard() {
  const { agent } = useAuth();
  const { botName } = useBrand();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [week, setWeek] = useState(null);
  const [convs, setConvs] = useState([]);
  const [areas, setAreas] = useState([]);
  const [agents, setAgents] = useState([]);
  const [nameMap, setNameMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const firstLoad = useFirstLoad(loading);

  const loadingRef = useRef(false);
  const weekFetchedAtRef = useRef(null);
  // force = refresco manual (botón): trae también la semana aunque sea reciente.
  // El polling de 60 s solo pide el día; la semana, como mucho cada 10 min.
  const load = useCallback(async ({ force = false } = {}) => {
    if (loadingRef.current) return; // no superponer cargas (botón + polling)
    loadingRef.current = true;
    setRefreshing(true);
    try {
      const withWeek = shouldFetchWeek(weekFetchedAtRef.current, Date.now(), { force });
      const [dayRes, weekRes, convsRes, waitingRes, areasRes, usersRes] = await Promise.all([
        authFetch(BASE_URL + '/api/stats?period=day'),
        withWeek ? authFetch(BASE_URL + '/api/stats?period=week') : null,
        authFetch(BASE_URL + '/api/conversations'),
        // las que esperan fuera de las 200 más recientes (misma lista que Conversaciones)
        authFetch(BASE_URL + '/api/conversations/waiting').catch(() => null),
        authFetch(BASE_URL + '/api/departments').catch(() => null),
        authFetch(BASE_URL + '/api/auth/users').catch(() => null),
      ]);
      if (!dayRes.ok || (weekRes && !weekRes.ok) || !convsRes.ok) throw new Error('No se pudo cargar el resumen');
      const [dayData, weekData, convsData] = await Promise.all([dayRes.json(), weekRes?.json() ?? null, convsRes.json()]);
      const deptsData = areasRes?.ok ? await areasRes.json() : { departments: [] };
      const users = usersRes?.ok ? await usersRes.json() : [];
      const loadedAreas = deptsData.departments ?? []; // en Alto las "áreas" son los departamentos
      const map = {};
      for (const a of loadedAreas) map[a.id] = a.name;
      for (const u of Array.isArray(users) ? users : []) { map[u.email] = u.name; map[u.id] = u.name; }
      setAreas(loadedAreas);
      setAgents(Array.isArray(users) ? users : []);
      setNameMap(map);
      setStats(dayData);
      if (weekData) {
        setWeek(weekData);
        weekFetchedAtRef.current = Date.now();
      }
      const waitingData = waitingRes?.ok ? await waitingRes.json() : { conversations: [] };
      setConvs(mergeWaiting(convsData.conversations ?? [], waitingData.conversations ?? []));
      setError(false);
    } catch {
      setError(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresco silencioso cada 60 s (no reanima: los números ya contaron una vez).
  // Con la pestaña oculta se saltea el tick.
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // "escribiendo…" solo en la primera carga animada; después los globos entran directo.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!firstLoad) return undefined;
    setTyping(true);
    const t = setTimeout(() => setTyping(false), TYPING_MS);
    return () => clearTimeout(t);
  }, [firstLoad]);

  const messages = useMemo(() => tediSummary(stats, { botName }), [stats, botName]);
  const queue = useMemo(() => waitingQueue(convs, { areas, nameMap, agents }), [convs, areas, nameMap, agents]);
  const feed = useMemo(() => activityFeed(convs, { botName, areas, nameMap, agents }), [convs, botName, areas, nameMap, agents]);
  const time = useMemo(() => clock(), [stats]); // eslint-disable-line react-hooks/exhaustive-deps

  const recent = useMemo(() => convs.slice(0, 6), [convs]);
  const trend = week?.dailyTrend ?? [];
  const prev = stats?.previous ?? {};
  const rate = stats?.botResolutionRate ?? 0;
  const first = stats?.avgFirstResponseMin;

  const convDelta = kpiDelta(stats?.total, prev.total);
  const rateDelta = prev.botResolutionRate ? rate - prev.botResolutionRate : null;
  const firstDelta = firstResponseDelta(first, prev.avgFirstResponseMin);
  const firstWorse = first != null && prev.avgFirstResponseMin ? first > prev.avgFirstResponseMin : false;

  const firstLabel = first == null ? '—' : first < 1 ? `${Math.round(first * 60)}s` : fmt(first);

  const kpis = [
    {
      key: 'conv', label: 'Conversaciones', value: stats?.total ?? 0, color: 'var(--brand)',
      delta: convDelta === null ? null : signed(convDelta, '%'), good: (convDelta ?? 0) >= 0,
      series: trend.map((d) => d.started),
    },
    {
      key: 'rate', label: `Resolvió ${botName}`, value: rate, suffix: '%', color: 'var(--brand)',
      delta: rateDelta === null ? null : signed(rateDelta, ' pts'), good: (rateDelta ?? 0) >= 0,
      series: trend.map((d) => (d.started ? Math.round((d.resolvedByBot / d.started) * 100) : 0)),
    },
    {
      key: 'first', label: '1ª respuesta', text: firstLabel, color: 'var(--brand)',
      delta: firstDelta, good: !firstWorse,
      series: null,
    },
    {
      key: 'wait', label: 'Esperando', value: stats?.awaitingAgent ?? 0, color: '#e8473f', valueColor: '#e8473f',
      delta: null, good: true,
      series: trend.map((d) => d.escalated),
    },
  ];

  const attend = (c) => navigate(`/conversations?open=${encodeURIComponent(c.id)}`);

  return (
    <div className={`${styles.page} ${firstLoad ? 'is-entering' : ''}`}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.hello}>{greeting()}, {agent?.name?.split(' ')[0]} 👋</h1>
          <p className={styles.sub}><span className={styles.live} />{todayLabel()} · en vivo</p>
        </div>
        <button className={`${styles.refreshBtn} ${refreshing ? styles.spinning : ''}`} onClick={() => load({ force: true })} title="Actualizar" aria-label="Actualizar">
          <IconRefresh />
        </button>
      </header>

      {error && !stats ? (
        <p className={styles.error}>No pudimos cargar el resumen. Probá actualizar.</p>
      ) : (
        <div className={styles.grid}>
          <div className={styles.main}>
            <section className={styles.tedi}>
              <div className={styles.from}><BotFace size={24} />{botName}</div>
              {loading ? (
                <div className={styles.skelBubbles}>
                  <Skeleton w="70%" h={34} radius={9} />
                  <Skeleton w="55%" h={34} radius={9} />
                </div>
              ) : typing ? (
                <div className={styles.typing} aria-label="escribiendo"><i /><i /><i /></div>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className={`${styles.msg} anim-pop`} style={{ '--d': `${i * 350}ms` }}>
                    {m}
                    <small>{time}</small>
                  </div>
                ))
              )}
            </section>

            <div className={styles.kpis}>
              {kpis.map((k, i) => (
                loading ? (
                  <div key={k.key} className={styles.kpi}>
                    <Skeleton w="60%" h={12} />
                    <Skeleton w="45%" h={26} style={{ marginTop: 8 }} />
                    <Skeleton h={22} style={{ marginTop: 6 }} />
                  </div>
                ) : (
                  <div key={k.key} className={`${styles.kpi} anim-rise`} style={{ '--d': `${500 + i * 80}ms` }}>
                    <small>{k.label}</small>
                    <div className={styles.kpiRow}>
                      <strong className={styles.num} style={k.valueColor ? { color: k.valueColor } : undefined}>
                        {k.text ?? <CountNum value={k.value} animate={firstLoad} suffix={k.suffix} />}
                      </strong>
                      <Delta text={k.delta} good={k.good} />
                    </div>
                    <Spark values={k.series} color={k.color} delay={700 + i * 80} />
                  </div>
                )
              ))}
            </div>

            <section className={styles.card}>
              <div className={styles.cardHead}><b>Te esperan</b><small>ordenadas por tiempo de espera</small></div>
              {loading ? (
                <>
                  <Skeleton h={36} style={{ marginBottom: 10 }} />
                  <Skeleton h={36} />
                </>
              ) : queue.length === 0 ? (
                <p className={styles.empty}>No hay nadie esperando 🙌</p>
              ) : (
                queue.map((c) => {
                  const name = c.contactName || c.contactId;
                  return (
                    <div key={c.id} className={styles.it}>
                      <span className={styles.av} style={{ background: avatarColor(c.contactId || c.id) }}>
                        {initials(name)}
                        <sub className={c.channel === 'instagram' ? styles.ig : ''} />
                      </span>
                      <div className={styles.itBody}>
                        <b>{name}</b>
                        <p>{c.lastMessage || ' '}</p>
                      </div>
                      <span className={`${styles.timer} ${styles[`timer_${waitLevel(c.waitMin)}`] || ''}`}>{fmt(c.waitMin)}</span>
                      <button className={styles.attend} onClick={() => attend(c)}>Atender</button>
                    </div>
                  );
                })
              )}
            </section>
          </div>

          <aside className={styles.card}>
            <div className={styles.cardHead}><b>Pasando ahora</b><small><span className={styles.live} /></small></div>
            {loading ? (
              <>
                <Skeleton h={30} style={{ marginBottom: 10 }} />
                <Skeleton h={30} style={{ marginBottom: 10 }} />
                <Skeleton h={30} />
              </>
            ) : feed.length === 0 ? (
              <p className={styles.empty}>Todavía no pasó nada.</p>
            ) : (
              feed.map((e, i) => (
                <div key={e.key} className={`${styles.ev} anim-pop`} style={{ '--d': `${900 + i * 100}ms` }}>
                  <span className={`${styles.ic} ${styles[`ic_${e.icon}`]}`}>{FEED_ICON[e.icon]}</span>
                  <div><b>{e.title}</b><p>{e.sub}</p></div>
                </div>
              ))
            )}
          </aside>
        </div>
      )}

      {!(error && !stats) && (
        <div className={styles.extras}>
          <section className={styles.card}>
            <div className={styles.cardHead}><b>Detalle de hoy</b><small>canales y resolución</small></div>
            {loading ? (
              <Skeleton h={64} />
            ) : (
              <>
                <div className={styles.mini}>
                  <div>
                    <strong className={styles.num}>{stats?.resolved ?? 0}</strong>
                    <small>Resueltas</small>
                    {stats?.resolved > 0 && <em>{stats.resolvedByBot} {botName} · {stats.resolvedByAgent} equipo</em>}
                  </div>
                  <div><strong className={styles.num}>{stats?.byStatus?.bot ?? 0}</strong><small>{botName} activo</small></div>
                  <div><strong className={styles.num}>{stats?.byChannel?.whatsapp ?? 0}</strong><small>WhatsApp</small></div>
                  <div><strong className={styles.num}>{stats?.byChannel?.instagram ?? 0}</strong><small>Instagram</small></div>
                </div>
                {stats?.resolved > 0 ? (
                  <div className={styles.rateBar}>
                    <span className={styles.rateLabel}>De {stats.resolved} resueltas, {botName} cerró {stats.resolvedByBot} sin ayuda del equipo</span>
                    <div className={styles.barTrack}><div className={styles.barFill} style={{ width: `${stats.botResolutionRate}%` }} /></div>
                    <span className={styles.rateValue}>{stats.botResolutionRate}%</span>
                  </div>
                ) : (
                  <p className={styles.empty}>Todavía no se resolvió ninguna conversación hoy.</p>
                )}
              </>
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <b>Últimas conversaciones</b>
              <button className={styles.linkBtn} onClick={() => navigate('/conversations')}>Ver todas →</button>
            </div>
            {loading ? (
              <>
                <Skeleton h={36} style={{ marginBottom: 10 }} />
                <Skeleton h={36} />
              </>
            ) : recent.length === 0 ? (
              <p className={styles.empty}>Sin conversaciones todavía. Cuando llegue el primer mensaje aparecerá acá.</p>
            ) : (
              recent.map((c) => {
                const name = c.contactName || c.contactId;
                const pill = pillFor(c, { botName, areas, nameMap, agents });
                return (
                  <button key={c.id} className={styles.recent} onClick={() => attend(c)}>
                    <span className={styles.av} style={{ background: avatarColor(c.contactId || c.id) }}>
                      {initials(name)}
                      <sub className={c.channel === 'instagram' ? styles.ig : ''} />
                    </span>
                    <span className={styles.itBody}>
                      <b>{name}</b>
                      <p>{c.lastMessage || '—'}</p>
                    </span>
                    <span className={styles.recentMeta}>
                      <small>{relTime(c.lastMessageAt)}</small>
                      <span className={`${styles.pill} ${styles[`pill_${pill.tone}`] || ''}`}>{pill.text}</span>
                    </span>
                  </button>
                );
              })
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function IconRefresh() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>;
}
