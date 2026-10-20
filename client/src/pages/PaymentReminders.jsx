import { useState, useEffect } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import styles from './SimpliRouteHistory.module.css';
import cardStyles from './Notifications.module.css';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function StepResult({ step }) {
  if (!step) return <span className={styles.phoneMissing}>—</span>;
  const label = step.status === 'sent' ? '✓ Enviado'
    : step.status === 'error' ? `✗ ${step.reason}`
    : `— ${step.reason ?? 'Omitido'}`;
  return (
    <span className={`${styles.resultBadge} ${styles[`result_${step.status}`]}`} title={step.sentAt ? new Date(step.sentAt).toLocaleString('es-AR') : ''}>
      {label}
    </span>
  );
}

export default function PaymentReminders() {
  const [templates, setTemplates] = useState([]);
  const [history, setHistory]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');

  const [enabled, setEnabled]               = useState(false);
  const [firstTemplate, setFirstTemplate]   = useState('');
  const [firstParams, setFirstParams]       = useState(['']);
  const [firstDelay, setFirstDelay]         = useState(30);
  const [secondTemplate, setSecondTemplate] = useState('');
  const [secondParams, setSecondParams]     = useState(['']);
  const [secondHour, setSecondHour]         = useState(9);
  const [saving, setSaving]                 = useState(false);
  const [saved, setSaved]                   = useState(false);

  useEffect(() => { loadTemplates(); loadConfig(); loadHistory(); }, []);

  async function loadTemplates() {
    try {
      const r = await authFetch(BASE_URL + '/api/templates');
      const data = await r.json();
      setTemplates((Array.isArray(data) ? data : []).filter(t => t.metaStatus === 'APPROVED'));
    } catch { /* non-critical */ }
  }

  async function loadConfig() {
    try {
      const r = await authFetch(BASE_URL + '/api/config');
      const data = await r.json();
      const cfg = data.config ?? {};
      setEnabled(!!cfg.paymentReminderEnabled);
      setFirstTemplate(cfg.paymentReminderFirstTemplate ?? '');
      setFirstParams(cfg.paymentReminderFirstParams?.length ? cfg.paymentReminderFirstParams : ['']);
      setFirstDelay(cfg.paymentReminderFirstDelayMinutes ?? 30);
      setSecondTemplate(cfg.paymentReminderSecondTemplate ?? '');
      setSecondParams(cfg.paymentReminderSecondParams?.length ? cfg.paymentReminderSecondParams : ['']);
      setSecondHour(cfg.paymentReminderSecondHour ?? 9);
    } catch { /* non-critical */ }
  }

  async function loadHistory() {
    setLoading(true);
    setError('');
    try {
      const r = await authFetch(BASE_URL + '/api/notifications/payment-reminders');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setHistory(data.history ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function defaultParams(name) {
    const tpl = templates.find(t => t.name === name);
    const count = Math.max((tpl?.bodyText?.match(/\{\{[^}]+\}\}/g) ?? []).length, 1);
    const defaults = ['{{firstname}}', '{{number}}', '{{total}}', '{{cvu}}'];
    return Array.from({ length: count }, (_, i) => defaults[i] ?? '');
  }

  async function handleSave() {
    setSaving(true);
    try {
      await authFetch(BASE_URL + '/api/config', {
        method: 'PUT',
        body: {
          paymentReminderEnabled: enabled,
          paymentReminderFirstTemplate: firstTemplate,
          paymentReminderFirstParams: firstParams.filter(Boolean),
          paymentReminderFirstDelayMinutes: Math.max(Number(firstDelay) || 30, 10),
          paymentReminderSecondTemplate: secondTemplate,
          paymentReminderSecondParams: secondParams.filter(Boolean),
          paymentReminderSecondHour: Number(secondHour),
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  function renderStage({ label, template, onTemplate, params, onParams, extra }) {
    const body = templates.find(t => t.name === template)?.bodyText;
    return (
      <div className={cardStyles.followupStage}>
        <label className={cardStyles.label}>{label}</label>
        {extra}
        <select className={cardStyles.input} value={template} onChange={e => { onTemplate(e.target.value); onParams(defaultParams(e.target.value)); }}>
          <option value="">— Sin recordatorio —</option>
          {templates.map(t => (
            <option key={t.id ?? t.name} value={t.name}>{t.displayName ?? t.name} ({t.language})</option>
          ))}
        </select>
        {body && <p className={cardStyles.cardHint}>{body}</p>}
        {template && params.map((p, i) => (
          <input
            key={i}
            className={cardStyles.input}
            value={p}
            onChange={e => onParams(prev => prev.map((v, j) => j === i ? e.target.value : v))}
            placeholder={`Variable {{${i + 1}}} — ej: {{firstname}}, {{name}}, {{number}}, {{total}}, {{cvu}}, texto fijo…`}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Pagos pendientes</h1>
          <p className={styles.subtitle}>Recordatorio automático por WhatsApp a compras por transferencia que todavía no se pagaron</p>
        </div>
        <button className={styles.btnFetch} onClick={loadHistory} disabled={loading}>
          {loading ? 'Actualizando…' : '↻ Actualizar'}
        </button>
      </header>

      <div className={cardStyles.followupCard}>
        <div className={cardStyles.followupHeader}>
          <label className={cardStyles.checkLabel}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            Recordatorio de pago por transferencia
          </label>
          <p className={cardStyles.cardHint}>
            Cada 10 minutos se revisan en Tienda Nube los pedidos con transferencia (Pago Nube) pendientes de pago. Si ya pagó o la transferencia venció, no se manda nada. Cada recordatorio se manda una sola vez por pedido.
          </p>
        </div>

        <div className={cardStyles.followupGrid}>
          {renderStage({
            label: 'Primer recordatorio',
            template: firstTemplate, onTemplate: setFirstTemplate,
            params: firstParams, onParams: setFirstParams,
            extra: (
              <label className={cardStyles.cardHint}>
                A los{' '}
                <input type="number" min="10" step="5" className={cardStyles.input} style={{ width: 80, display: 'inline-block' }}
                  value={firstDelay} onChange={e => setFirstDelay(e.target.value)} />
                {' '}minutos de la compra
              </label>
            ),
          })}
          {renderStage({
            label: 'Segundo recordatorio',
            template: secondTemplate, onTemplate: setSecondTemplate,
            params: secondParams, onParams: setSecondParams,
            extra: (
              <label className={cardStyles.cardHint}>
                Al día siguiente a las{' '}
                <select className={cardStyles.input} style={{ width: 90, display: 'inline-block' }}
                  value={secondHour} onChange={e => setSecondHour(e.target.value)}>
                  {HOURS.map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
              </label>
            ),
          })}

          <div className={cardStyles.followupSaveRow}>
            <button className={cardStyles.sendBtn} onClick={handleSave} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
            {saved && <span className={cardStyles.hSent}>✓ Guardado</span>}
            {templates.length === 0 && (
              <span className={cardStyles.cardHint}>No hay plantillas aprobadas — creálas en Plantillas y esperá la aprobación de Meta.</span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className={styles.errorRow}>
          <div className={styles.errorBanner}>{error}</div>
        </div>
      )}

      <div className={styles.area}>
        {loading ? (
          <p className={styles.emptyFilter}>Cargando historial…</p>
        ) : history.length === 0 ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>📭</span>
            <p>Todavía no se mandó ningún recordatorio de pago.</p>
          </div>
        ) : (
          <div className={styles.tableSection}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Compra</th>
                    <th>Pedido</th>
                    <th>Cliente</th>
                    <th>Total</th>
                    <th>1º recordatorio</th>
                    <th>2º recordatorio</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.id}>
                      <td>{h.orderCreatedAt ? new Date(h.orderCreatedAt).toLocaleString('es-AR') : '—'}</td>
                      <td className={styles.orderNum}>#{h.orderNumber}</td>
                      <td>{h.customerName ?? '—'}</td>
                      <td>{h.total ? `$${h.total}` : '—'}</td>
                      <td><StepResult step={h.first} /></td>
                      <td><StepResult step={h.second} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
