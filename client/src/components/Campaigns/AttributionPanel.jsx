import { useState } from 'react';
import { authFetch, BASE_URL } from '../../lib/api';
import { formatArs } from '../../utils/costEstimate';
import styles from './Composer.module.css';

function formatWhen(ts) {
  if (!ts) return '';
  const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '');
  return m ? `${m[3]}/${m[2]}` : day;
}

export default function AttributionPanel({ campaign, onUpdated }) {
  const [loading, setLoading] = useState(false);
  const a = campaign.attribution;

  async function refresh() {
    setLoading(true);
    try {
      const res = await authFetch(BASE_URL + `/api/campaigns/${campaign.id}/attribution`, { method: 'POST' });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(data.error);
      onUpdated(data.campaign);
    } catch (err) {
      alert(`No se pudieron calcular las ventas: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  const conversion = a?.recipients ? ((a.buyers / a.recipients) * 100).toFixed(1).replace('.', ',') : '0';

  return (
    <div className={styles.attribution}>
      <div className={styles.attributionHead}>
        <span className={styles.label}>🛒 Ventas atribuidas</span>
        <button type="button" className={styles.segBtn} onClick={refresh} disabled={loading}>
          {loading ? 'Calculando…' : 'Actualizar ventas'}
        </button>
      </div>

      {!a ? (
        <p className={styles.hint}>Todavía no se calcularon. Se calculan solas cada noche, o tocá "Actualizar ventas".</p>
      ) : (
        <>
          <p className={styles.cost}>
            Compraron <strong>{a.buyers}</strong> de {a.recipients} ({a.clickedBuyers} tocaron el link) ·
            Facturación <strong>{formatArs(a.revenue)}</strong> · Conversión <strong>{conversion}%</strong>
          </p>
          {a.buyersList?.length > 0 && (
            <table className={styles.buyersTable}>
              <thead>
                <tr><th>Cliente</th><th>Pedido</th><th>Fecha</th><th>Total</th><th>Tocó el link</th></tr>
              </thead>
              <tbody>
                {a.buyersList.map(b => (
                  <tr key={b.contactId}>
                    <td>{b.contactName || b.contactId}</td>
                    <td>#{b.orderNumber}</td>
                    <td>{formatDay(b.orderDate)}</td>
                    <td>{formatArs(b.total)}</td>
                    <td>{b.clicked ? '✓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={styles.costNote}>
            Pedidos pagados en Tienda Nube hasta {a.windowDays} días después del envío, cruzados por teléfono.
            Indica que compró después de recibirla (no prueba que fue por la difusión; "tocó el link" es la señal fuerte).
            Los pedidos se actualizan cada noche; "Actualizar ventas" re-consulta al momento a los que tocaron el link.
            Calculado: {formatWhen(a.computedAt)}.
          </p>
        </>
      )}
    </div>
  );
}
