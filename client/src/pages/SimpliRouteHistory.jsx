import { useState, useEffect } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import styles from './SimpliRouteHistory.module.css';

const EVENT_LABELS = {
  route_start: 'En ruta',
  checkout: 'Checkout',
};

export default function SimpliRouteHistory() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const r = await authFetch(BASE_URL + '/api/notifications/simpliroute-history');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setHistory(data.history ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Historial SimpliRoute</h1>
          <p className={styles.subtitle}>Envíos automáticos disparados por SimpliRoute (en ruta / entregado / no entregado)</p>
        </div>
        <button className={styles.btnFetch} onClick={load} disabled={loading}>
          {loading ? 'Actualizando…' : '↻ Actualizar'}
        </button>
      </header>

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
            <p>Todavía no se disparó ningún envío automático desde SimpliRoute.</p>
          </div>
        ) : (
          <div className={styles.tableSection}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Evento</th>
                    <th>Pedido</th>
                    <th>Cliente</th>
                    <th>Teléfono</th>
                    <th>Plantilla</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.id} className={h.status ? styles[`row_${h.status}`] : ''}>
                      <td>{h.sentAt ? new Date(h.sentAt).toLocaleString('es-AR') : '—'}</td>
                      <td>{EVENT_LABELS[h.event] ?? h.event ?? '—'}</td>
                      <td className={styles.orderNum}>#{h.orderNumber}</td>
                      <td>{h.customerName ?? '—'}</td>
                      <td>
                        {h.phone
                          ? <span className={styles.phoneOk}>{h.phone}</span>
                          : <span className={styles.phoneMissing}>—</span>
                        }
                      </td>
                      <td>{h.templateName}</td>
                      <td>
                        <span className={`${styles.resultBadge} ${styles[`result_${h.status}`]}`}>
                          {h.status === 'sent' ? '✓ Enviado' : h.status === 'error' ? `✗ ${h.reason}` : `— ${h.reason ?? 'Omitido'}`}
                        </span>
                      </td>
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
