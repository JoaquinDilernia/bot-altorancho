import { useEffect, useState, useCallback } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import styles from './Notifications.module.css';

const VARIABLE_OPTIONS = [
  { value: 'orderNumber', label: 'Número de pedido' },
  { value: 'customerName', label: 'Nombre del cliente' },
  { value: 'storeName', label: 'Nombre de la tienda (Alto Rancho)' },
];

const DEFAULT_CONFIG = {
  templateName: '',
  language: 'es_AR',
  variables: ['orderNumber', 'customerName'],
};

export default function Notifications() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [phase, setPhase] = useState('list'); // 'list' | 'sending' | 'result'
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch(BASE_URL + '/api/notifications/pickup-ready');
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await authFetch(BASE_URL + '/api/notifications/history');
      if (res.ok) setHistory((await res.json()).history ?? []);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { loadOrders(); loadHistory(); }, [loadOrders, loadHistory]);

  function setVariable(index, value) {
    setConfig(prev => {
      const vars = [...prev.variables];
      vars[index] = value;
      return { ...prev, variables: vars };
    });
  }

  function addVariable() {
    if (config.variables.length >= 4) return;
    setConfig(prev => ({ ...prev, variables: [...prev.variables, 'orderNumber'] }));
  }

  function removeVariable(index) {
    setConfig(prev => ({ ...prev, variables: prev.variables.filter((_, i) => i !== index) }));
  }

  async function handleSend() {
    if (!config.templateName.trim()) {
      setError('Ingresá el nombre de la plantilla antes de enviar.');
      return;
    }
    const withPhone = orders.filter(o => o.hasPhone);
    if (withPhone.length === 0) {
      setError('Ningún pedido tiene número de teléfono disponible.');
      return;
    }

    setError('');
    setPhase('sending');

    const recipients = withPhone.map(o => ({
      phone: o.phone,
      orderNumber: o.number,
      customerName: o.customerName,
    }));

    try {
      const res = await authFetch(BASE_URL + '/api/notifications/send', {
        method: 'POST',
        body: {
          templateName: config.templateName.trim(),
          language: config.language,
          variables: config.variables,
          recipients,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
      setPhase('result');
      loadHistory();
    } catch (err) {
      setError(err.message);
      setPhase('list');
    }
  }

  function reset() {
    setPhase('list');
    setResult(null);
    loadOrders();
  }

  const withPhone = orders.filter(o => o.hasPhone);
  const withoutPhone = orders.filter(o => !o.hasPhone);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Notificaciones masivas</h1>
          <p className={styles.subtitle}>
            Pedidos con retiro en local listos para retirar. Enviá una plantilla de WhatsApp a todos de una vez.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={() => { setShowHistory(v => !v); }}>
            {showHistory ? 'Ocultar historial' : 'Ver historial'}
          </button>
          {phase === 'list' && (
            <button className={styles.ghostBtn} onClick={loadOrders} disabled={loading}>
              Actualizar
            </button>
          )}
        </div>
      </header>

      {showHistory && <HistoryPanel history={history} onClose={() => setShowHistory(false)} />}

      <div className={styles.body}>
        {phase === 'result' ? (
          <ResultPanel result={result} onReset={reset} />
        ) : phase === 'sending' ? (
          <SendingPanel total={withPhone.length} />
        ) : (
          <>
            {error && <div className={styles.errorBanner}>{error}</div>}

            {/* Template config */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Plantilla a enviar</h2>
              <p className={styles.cardHint}>
                La plantilla debe estar aprobada en Meta Business Manager. El nombre es el que figura en el panel de Meta (ej: <code>retiro_listo</code>).
              </p>
              <div className={styles.configGrid}>
                <div className={styles.field}>
                  <label className={styles.label}>Nombre de la plantilla</label>
                  <input
                    className={styles.input}
                    value={config.templateName}
                    onChange={e => setConfig(p => ({ ...p, templateName: e.target.value }))}
                    placeholder="ej: retiro_listo"
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Idioma</label>
                  <select
                    className={styles.input}
                    value={config.language}
                    onChange={e => setConfig(p => ({ ...p, language: e.target.value }))}
                  >
                    <option value="es_AR">Español (Argentina)</option>
                    <option value="es">Español</option>
                    <option value="en_US">Inglés</option>
                  </select>
                </div>
              </div>

              <div className={styles.variablesSection}>
                <div className={styles.variablesHeader}>
                  <span className={styles.label}>Variables de la plantilla</span>
                  {config.variables.length < 4 && (
                    <button className={styles.addVarBtn} onClick={addVariable}>+ Agregar</button>
                  )}
                </div>
                <div className={styles.variablesList}>
                  {config.variables.map((v, i) => (
                    <div key={i} className={styles.variableRow}>
                      <span className={styles.varTag}>{`{{${i + 1}}}`}</span>
                      <select
                        className={styles.varSelect}
                        value={v}
                        onChange={e => setVariable(i, e.target.value)}
                      >
                        {VARIABLE_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      <button className={styles.removeVarBtn} onClick={() => removeVariable(i)} title="Quitar">×</button>
                    </div>
                  ))}
                </div>
                {config.variables.length > 0 && (
                  <p className={styles.previewHint}>
                    Preview: {config.variables.map((v, i) => {
                      const opt = VARIABLE_OPTIONS.find(o => o.value === v);
                      return `{{${i + 1}}} → ${opt?.label ?? v}`;
                    }).join(' · ')}
                  </p>
                )}
              </div>
            </section>

            {/* Orders list */}
            <section className={styles.card}>
              <div className={styles.ordersHeader}>
                <h2 className={styles.cardTitle}>
                  Pedidos listos para retirar
                  {!loading && (
                    <span className={styles.countBadge}>{orders.length}</span>
                  )}
                </h2>
                {!loading && withPhone.length > 0 && (
                  <button
                    className={styles.sendBtn}
                    onClick={handleSend}
                    disabled={!config.templateName.trim()}
                  >
                    Enviar a {withPhone.length} {withPhone.length === 1 ? 'pedido' : 'pedidos'}
                  </button>
                )}
              </div>

              {loading ? (
                <OrdersSkeleton />
              ) : orders.length === 0 ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>📦</span>
                  <p>No hay pedidos con retiro en local listos para retirar.</p>
                  <p className={styles.emptyHint}>Se muestran pedidos pagados con estado "empaquetado" y tipo de envío "retiro en local".</p>
                </div>
              ) : (
                <>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Pedido</th>
                          <th>Cliente</th>
                          <th>Teléfono</th>
                          <th>Productos</th>
                          <th>Fecha</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map(order => (
                          <tr key={order.id} className={!order.hasPhone ? styles.rowNoPhone : ''}>
                            <td className={styles.orderNum}>#{order.number}</td>
                            <td>{order.customerName}</td>
                            <td>
                              {order.hasPhone
                                ? <span className={styles.phoneOk}>{order.phone}</span>
                                : <span className={styles.phoneMissing}>Sin teléfono</span>
                              }
                            </td>
                            <td className={styles.products}>{order.products || '—'}</td>
                            <td className={styles.date}>{order.createdAt ? new Date(order.createdAt).toLocaleDateString('es-AR') : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {withoutPhone.length > 0 && (
                    <p className={styles.warnPhones}>
                      {withoutPhone.length} {withoutPhone.length === 1 ? 'pedido no tiene' : 'pedidos no tienen'} teléfono en TiendaNube y {withoutPhone.length === 1 ? 'será omitido' : 'serán omitidos'}.
                    </p>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SendingPanel({ total }) {
  return (
    <div className={styles.sendingPanel}>
      <div className={styles.sendingSpinner} />
      <p className={styles.sendingText}>Enviando plantilla a {total} {total === 1 ? 'pedido' : 'pedidos'}...</p>
      <p className={styles.sendingHint}>No cerrés esta página.</p>
    </div>
  );
}

function ResultPanel({ result, onReset }) {
  const successRate = result.sent + result.failed > 0
    ? Math.round((result.sent / (result.sent + result.failed)) * 100)
    : 0;

  return (
    <div className={styles.resultPanel}>
      <div className={styles.resultHeader}>
        <h2 className={styles.resultTitle}>Envío completado</h2>
        <button className={styles.ghostBtn} onClick={onReset}>Volver</button>
      </div>

      <div className={styles.resultStats}>
        <div className={`${styles.resultStat} ${styles.statSent}`}>
          <span className={styles.resultNum}>{result.sent}</span>
          <span className={styles.resultLabel}>Enviados</span>
        </div>
        <div className={`${styles.resultStat} ${styles.statFailed}`}>
          <span className={styles.resultNum}>{result.failed}</span>
          <span className={styles.resultLabel}>Fallidos</span>
        </div>
        <div className={`${styles.resultStat} ${styles.statSkipped}`}>
          <span className={styles.resultNum}>{result.skipped}</span>
          <span className={styles.resultLabel}>Sin teléfono</span>
        </div>
        <div className={`${styles.resultStat} ${styles.statRate}`}>
          <span className={styles.resultNum}>{successRate}%</span>
          <span className={styles.resultLabel}>Tasa de éxito</span>
        </div>
      </div>

      {result.details?.filter(d => d.status === 'failed').length > 0 && (
        <div className={styles.failedList}>
          <h3 className={styles.failedTitle}>Pedidos fallidos</h3>
          {result.details.filter(d => d.status === 'failed').map((d, i) => (
            <div key={i} className={styles.failedRow}>
              <span>#{d.orderNumber}</span>
              <span className={styles.failedPhone}>{d.phone}</span>
              <span className={styles.failedReason}>{d.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryPanel({ history, onClose }) {
  if (history.length === 0) return (
    <div className={styles.historyPanel}>
      <div className={styles.historyHeader}>
        <h3 className={styles.historyTitle}>Historial de envíos</h3>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
      </div>
      <p className={styles.historyEmpty}>Sin envíos registrados.</p>
    </div>
  );

  return (
    <div className={styles.historyPanel}>
      <div className={styles.historyHeader}>
        <h3 className={styles.historyTitle}>Historial de envíos</h3>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
      </div>
      <div className={styles.historyList}>
        {history.map(h => (
          <div key={h.id} className={styles.historyRow}>
            <div className={styles.historyMeta}>
              <span className={styles.historyTemplate}>{h.templateName}</span>
              <span className={styles.historyDate}>{h.sentAt ? new Date(h.sentAt).toLocaleString('es-AR') : '—'}</span>
            </div>
            <div className={styles.historyNums}>
              <span className={styles.hSent}>{h.totalSent} enviados</span>
              {h.totalFailed > 0 && <span className={styles.hFailed}>{h.totalFailed} fallidos</span>}
              {h.totalSkipped > 0 && <span className={styles.hSkipped}>{h.totalSkipped} omitidos</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrdersSkeleton() {
  return (
    <div className={styles.skeletonRows}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className={styles.skeletonRow} style={{ animationDelay: `${i * 80}ms` }}>
          <div className={styles.skLine} style={{ width: 60 }} />
          <div className={styles.skLine} style={{ width: 140 }} />
          <div className={styles.skLine} style={{ width: 120 }} />
          <div className={styles.skLine} style={{ width: 200 }} />
          <div className={styles.skLine} style={{ width: 80 }} />
        </div>
      ))}
    </div>
  );
}
