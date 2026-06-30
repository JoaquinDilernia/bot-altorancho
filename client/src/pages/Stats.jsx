import { useEffect, useState } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import styles from './Stats.module.css';

const PERIODS = [
  { key: 'day',   label: 'Hoy' },
  { key: 'week',  label: '7 días' },
  { key: 'month', label: '30 días' },
];

const STATUS_META = {
  bot:       { label: 'Bot activo', color: 'var(--color-primary)' },
  urgent:    { label: 'Urgente',    color: 'var(--color-status-urgent)' },
  escalated: { label: 'Escalado',   color: '#8b5cf6' },
  resolved:  { label: 'Resuelto',   color: 'var(--color-status-resolved)' },
};

const AGENT_COLORS = ['var(--color-primary)', '#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444'];
const DEPT_COLORS  = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899'];
function agentColor(idx) { return AGENT_COLORS[idx % AGENT_COLORS.length]; }
function deptColor(idx)  { return DEPT_COLORS[idx % DEPT_COLORS.length]; }

const CHANNEL_META = {
  whatsapp:  { label: 'WhatsApp',  color: '#25d366' },
  instagram: { label: 'Instagram', color: '#e1306c' },
};

function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

function fmtMin(min) {
  if (min === null || min === undefined) return '—';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function barLabel(dateStr, period, idx, total) {
  const d = new Date(dateStr + 'T12:00:00');
  if (period === 'week')  return ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d.getDay()];
  if (period === 'month') return (idx % 5 === 0 || idx === total - 1) ? `${d.getDate()}/${d.getMonth()+1}` : '';
  return 'Hoy';
}

export default function Stats() {
  const [period, setPeriod] = useState('week');
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    authFetch(BASE_URL + `/api/stats?period=${period}`)
      .then(r => {
        if (!r.ok) throw new Error(`Error ${r.status} al cargar estadísticas`);
        return r.json();
      })
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [period]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Estadísticas</h1>
          <p className={styles.subtitle}>Rendimiento del bot y los agentes</p>
        </div>
        <div className={styles.tabs}>
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`${styles.tab} ${period === p.key ? styles.tabActive : ''}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {loading ? (
        <div className={styles.loading}>Cargando estadísticas...</div>
      ) : error ? (
        <div className={styles.error}>{error}</div>
      ) : !data ? null : (
        <div className={styles.body}>

          {/* KPI Row 1: volumen */}
          <div className={styles.kpiRow}>
            <KpiCard title="Conversaciones" value={data.total} />
            <KpiCard
              title="Resueltas" value={data.resolved}
              sub={`${pct(data.resolved, data.total)}% del total`}
              accent="var(--color-status-resolved)"
            />
            <KpiCard
              title="Bot autónomo" value={`${data.botResolutionRate}%`}
              sub="sin intervención humana"
              accent="var(--color-primary)"
            />
            <KpiCard
              title="Pendientes" value={data.pending}
              sub="activas sin resolver"
              accent={data.pending > 0 ? 'var(--color-status-urgent)' : undefined}
            />
          </div>

          {/* KPI Row 2: tiempos y SLA */}
          <div className={styles.kpiRow3}>
            <KpiCard
              title="Tasa de escalación" value={`${data.escalationRate}%`}
              sub={`${data.escalatedCount} derivadas a humano`}
              accent={data.escalationRate > 40 ? 'var(--color-status-urgent)' : '#8b5cf6'}
            />
            <KpiCard
              title="1ª respuesta (prom.)" value={fmtMin(data.avgFirstResponseMin)}
              sub="desde escalación hasta respuesta del agente"
              accent={
                data.avgFirstResponseMin === null ? undefined :
                data.avgFirstResponseMin > 30 ? 'var(--color-status-urgent)' :
                data.avgFirstResponseMin > 10 ? '#f59e0b' :
                'var(--color-status-resolved)'
              }
              hint={data.avgFirstResponseMin === null ? 'Sin datos suficientes' : undefined}
            />
            <KpiCard
              title="Resolución (prom.)" value={fmtMin(data.avgResolutionMin)}
              sub="desde apertura hasta cierre"
              hint={data.avgResolutionMin === null ? 'Sin datos suficientes' : undefined}
            />
          </div>

          {/* Trend */}
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>
              Actividad {period === 'day' ? 'de hoy' : period === 'week' ? 'últimos 7 días' : 'últimos 30 días'}
            </h2>
            <TrendChart data={data.dailyTrend} period={period} />
          </section>

          {/* By agent + by status */}
          <div className={styles.grid2}>
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Por agente</h2>
              <div className={styles.agentRows}>
                {data.byAgent.map((a, idx) => {
                  const color = agentColor(idx);
                  return (
                    <div key={a.id} className={styles.agentRow}>
                      <div className={styles.agentLeft}>
                        <span className={styles.dot} style={{ background: color }} />
                        <div>
                          <div className={styles.agentName}>{a.name}</div>
                          <div className={styles.agentSub}>{a.handled} conv · {a.resolved} res.</div>
                        </div>
                      </div>
                      <div className={styles.hBarTrack}>
                        <div className={styles.hBarFill} style={{ width: `${pct(a.handled, data.total)}%`, background: color }} />
                      </div>
                      <span className={styles.hBarNum}>{pct(a.handled, data.total)}%</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Por estado</h2>
              <HBars
                entries={Object.entries(data.byStatus).map(([k, v]) => ({
                  label: STATUS_META[k]?.label ?? k,
                  color: STATUS_META[k]?.color ?? 'var(--color-primary)',
                  value: v,
                }))}
                max={data.total}
              />
            </section>
          </div>

          {/* By department + by channel */}
          <div className={styles.grid2}>
            {data.byDepartment?.length > 0 ? (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>Por departamento</h2>
                <div className={styles.agentRows}>
                  {data.byDepartment.map((d, idx) => {
                    const color = deptColor(idx);
                    return (
                      <div key={d.id} className={styles.agentRow}>
                        <div className={styles.agentLeft}>
                          <span className={styles.dot} style={{ background: color }} />
                          <div>
                            <div className={styles.agentName}>{d.name}</div>
                            <div className={styles.agentSub}>
                              {d.handled} conv · {d.resolved} res.
                              {d.avgFirstResponseMin !== null && ` · ⏱ ${fmtMin(d.avgFirstResponseMin)}`}
                            </div>
                          </div>
                        </div>
                        <div className={styles.hBarTrack}>
                          <div className={styles.hBarFill} style={{ width: `${pct(d.handled, data.total)}%`, background: color }} />
                        </div>
                        <span className={styles.hBarNum}>{pct(d.handled, data.total)}%</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>Por departamento</h2>
                <p className={styles.empty}>Sin derivaciones en el período</p>
              </section>
            )}

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Por canal</h2>
              <HBars
                entries={Object.entries(data.byChannel).map(([k, v]) => ({
                  label: CHANNEL_META[k]?.label ?? k,
                  color: CHANNEL_META[k]?.color ?? 'var(--color-primary)',
                  value: v,
                }))}
                max={data.total}
              />
            </section>
          </div>

          {/* Labels */}
          {data.labelCounts.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Etiquetas más usadas</h2>
              <HBars
                entries={data.labelCounts.map(l => ({ label: l.name, color: 'var(--color-primary)', value: l.count }))}
                max={data.labelCounts[0].count}
              />
            </section>
          )}

        </div>
      )}
    </div>
  );
}

function KpiCard({ title, value, sub, accent, hint }) {
  return (
    <div className={styles.kpiCard}>
      <span className={styles.kpiTitle}>{title}</span>
      <span className={styles.kpiValue} style={accent ? { color: accent } : undefined}>{value}</span>
      {sub && <span className={styles.kpiSub}>{sub}</span>}
      {hint && <span className={styles.kpiHint}>{hint}</span>}
    </div>
  );
}

const CHART_H = 80;

function TrendChart({ data, period }) {
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className={styles.trendChart}>
      {data.map((d, i) => {
        const h = Math.round((d.count / max) * CHART_H);
        return (
          <div key={d.date} className={styles.trendCol}>
            <span className={styles.trendCount}>{d.count > 0 ? d.count : ''}</span>
            <div className={styles.trendBarWrap}>
              <div
                className={styles.trendBar}
                style={{ height: `${Math.max(h, d.count > 0 ? 3 : 0)}px` }}
              />
            </div>
            <span className={styles.trendLabel}>{barLabel(d.date, period, i, data.length)}</span>
          </div>
        );
      })}
    </div>
  );
}

function HBars({ entries, max }) {
  return (
    <div className={styles.hBars}>
      {entries.map(e => (
        <div key={e.label} className={styles.hBarRow}>
          <span className={styles.hBarLabel}>{e.label}</span>
          <div className={styles.hBarTrack}>
            <div className={styles.hBarFill} style={{ width: `${pct(e.value, max)}%`, background: e.color }} />
          </div>
          <span className={styles.hBarNum}>{e.value}</span>
        </div>
      ))}
    </div>
  );
}
