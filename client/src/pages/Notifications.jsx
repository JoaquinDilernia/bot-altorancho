import { useState, useEffect } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import styles from './Notifications.module.css';

const STATUS_LABELS = {
  unpacked:   'Pendiente de preparar',
  unshipped:  'Armado / Listo para retirar',
  fulfilling: 'En preparación',
  shipped:    'Enviado (correo)',
  delivered:  'Entregado',
};

const STATUS_FILTER_OPTIONS = [
  { value: 'unpacked',  label: 'Pendiente de preparar' },
  { value: 'unshipped', label: 'Armado / Listo para retirar' },
];

export default function Notifications() {
  const [orders, setOrders]             = useState([]);
  const [templates, setTemplates]       = useState([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');
  const [statuses, setStatuses]         = useState(['unpacked', 'unshipped']);
  const [branchFilter, setBranchFilter] = useState('');
  const [selected, setSelected]         = useState(new Set());
  const [templateName, setTemplateName] = useState('');
  const [paramTemplate, setParamTemplate] = useState(['']);
  const [sending, setSending]           = useState(false);
  const [results, setResults]           = useState(null);

  useEffect(() => { loadTemplates(); }, []);

  async function loadTemplates() {
    try {
      const r = await authFetch(BASE_URL + '/api/templates');
      const data = await r.json();
      const approved = (Array.isArray(data) ? data : []).filter(t => t.metaStatus === 'APPROVED');
      setTemplates(approved);
    } catch { /* non-critical */ }
  }

  async function fetchOrders() {
    setLoading(true);
    setSelected(new Set());
    setResults(null);
    setError('');
    try {
      const r = await authFetch(BASE_URL + '/api/notifications/pickup-orders');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setOrders(data.orders ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const filtered = orders.filter(o => {
    if (statuses.length && !statuses.includes(o.shippingStatus)) return false;
    if (branchFilter && !o.branch?.toLowerCase().includes(branchFilter.toLowerCase())) return false;
    return true;
  });

  function toggleStatus(s) {
    setStatuses(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  function toggleOrder(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === filtered.length && filtered.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(o => o.id)));
    }
  }

  function onTemplateChange(name) {
    setTemplateName(name);
    const tpl = templates.find(t => t.name === name);
    if (!tpl) { setParamTemplate(['']); return; }
    const count = (tpl.bodyText?.match(/\{\{[^}]+\}\}/g) ?? []).length;
    setParamTemplate(Array(Math.max(count, 1)).fill(''));
  }

  async function handleSend() {
    if (!templateName) { setError('Seleccioná un template'); return; }
    if (!selected.size) { setError('Seleccioná al menos un pedido'); return; }

    const tpl = templates.find(t => t.name === templateName);
    if (!tpl) return;

    const ordersToSend = filtered.filter(o => selected.has(o.id));
    setSending(true);
    setResults(null);
    setError('');
    try {
      const r = await authFetch(BASE_URL + '/api/notifications/send-bulk', {
        method: 'POST',
        body: {
          orders: ordersToSend,
          templateName,
          languageCode: tpl.language ?? 'es_AR',
          paramTemplate,
        },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setResults(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  const tplBody = templates.find(t => t.name === templateName)?.bodyText ?? '';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Notificaciones masivas</h1>
          <p className={styles.subtitle}>Enviá templates de WhatsApp a pedidos con retiro en local</p>
        </div>
      </header>

      {/* Filters */}
      <div className={styles.filtersCard}>
        <div className={styles.filtersRow}>
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel}>Estado del envío</label>
            <div className={styles.checkRow}>
              {STATUS_FILTER_OPTIONS.map(s => (
                <label key={s.value} className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={statuses.includes(s.value)}
                    onChange={() => toggleStatus(s.value)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel}>Filtrar por sucursal</label>
            <input
              className={styles.filterInput}
              value={branchFilter}
              onChange={e => setBranchFilter(e.target.value)}
              placeholder="Belgrano, San Isidro, Nordelta…"
            />
          </div>
          <button className={styles.btnFetch} onClick={fetchOrders} disabled={loading}>
            {loading ? 'Cargando…' : 'Buscar pedidos'}
          </button>
        </div>
        {error && <div className={styles.errorBanner}>{error}</div>}
      </div>

      {orders.length > 0 && (
        <>
          {/* Orders table */}
          <div className={styles.tableCard}>
            <div className={styles.tableToolbar}>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && selected.size === filtered.length}
                  onChange={toggleAll}
                />
                Seleccionar todos ({filtered.length})
              </label>
              {selected.size > 0 && (
                <span className={styles.selectedCount}>{selected.size} seleccionado{selected.size > 1 ? 's' : ''}</span>
              )}
            </div>

            {filtered.length === 0 ? (
              <p className={styles.emptyFilter}>Ningún pedido coincide con los filtros actuales.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}></th>
                      <th>Pedido</th>
                      <th>Cliente</th>
                      <th>Teléfono</th>
                      <th>Sucursal</th>
                      <th>Estado</th>
                      <th>Total</th>
                      <th>Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(o => {
                      const res = results?.results?.find(r => r.number === o.number);
                      return (
                        <tr
                          key={o.id}
                          className={`${selected.has(o.id) ? styles.rowSelected : ''} ${res ? styles[`row_${res.status}`] : ''}`}
                          onClick={() => toggleOrder(o.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td onClick={e => e.stopPropagation()}>
                            <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggleOrder(o.id)} />
                          </td>
                          <td className={styles.orderNum}>#{o.number}</td>
                          <td>{o.customer.name}</td>
                          <td className={styles.phone}>
                            {o.customer.phone
                              ? <span className={styles.phoneOk}>{o.customer.phone}</span>
                              : <span className={styles.phoneMissing}>Sin tel.</span>
                            }
                          </td>
                          <td className={styles.branch}>{o.branch}</td>
                          <td>
                            <span className={`${styles.statusChip} ${styles[`chip_${o.shippingStatus}`]}`}>
                              {STATUS_LABELS[o.shippingStatus] ?? o.shippingStatus}
                            </span>
                          </td>
                          <td className={styles.total}>${o.total}</td>
                          <td>
                            {res && (
                              <span className={`${styles.resultBadge} ${styles[`result_${res.status}`]}`}>
                                {res.status === 'sent' ? '✓ Enviado' : res.status === 'skipped' ? '— Omitido' : `✗ ${res.reason}`}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Send panel */}
          {selected.size > 0 && (
            <div className={styles.sendPanel}>
              <h3 className={styles.sendTitle}>Enviar a {selected.size} pedido{selected.size > 1 ? 's' : ''}</h3>

              <div className={styles.field}>
                <label className={styles.label}>Template aprobado</label>
                {templates.length === 0 ? (
                  <p className={styles.cardHint}>No hay templates aprobados. Creá uno en la sección Plantillas y esperá la aprobación de Meta.</p>
                ) : (
                  <select className={styles.input} value={templateName} onChange={e => onTemplateChange(e.target.value)}>
                    <option value="">— Seleccioná un template —</option>
                    {templates.map(t => (
                      <option key={t.id ?? t.name} value={t.name}>{t.displayName ?? t.name} ({t.language})</option>
                    ))}
                  </select>
                )}
              </div>

              {tplBody && (
                <div className={styles.previewBox}>
                  <div className={styles.previewLabel}>Vista previa del cuerpo</div>
                  <p className={styles.previewText}>{tplBody}</p>
                </div>
              )}

              {paramTemplate.length > 0 && templateName && (
                <div className={styles.paramsGrid}>
                  <p className={styles.cardHint}>
                    Completá los valores de las variables. Podés usar: <code>{'{{name}}'}</code>, <code>{'{{number}}'}</code>, <code>{'{{branch}}'}</code>, <code>{'{{total}}'}</code> — o un texto fijo.
                  </p>
                  {paramTemplate.map((p, i) => (
                    <div key={i} className={styles.field}>
                      <label className={styles.label}>{`Variable {{${i + 1}}}`}</label>
                      <input
                        className={styles.input}
                        value={p}
                        onChange={e => setParamTemplate(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                        placeholder={`ej: {{name}}, {{number}}, texto fijo…`}
                      />
                    </div>
                  ))}
                </div>
              )}

              {results && (
                <div className={styles.resultSummary}>
                  <span className={styles.hSent}>✓ {results.summary.sent} enviados</span>
                  {results.summary.errors > 0 && <span className={styles.hFailed}>✗ {results.summary.errors} errores</span>}
                  {results.summary.skipped > 0 && <span className={styles.hSkipped}>— {results.summary.skipped} sin teléfono</span>}
                </div>
              )}

              <button className={styles.sendBtn} onClick={handleSend} disabled={sending || !templateName}>
                {sending
                  ? `Enviando (${selected.size} mensajes)…`
                  : `Enviar ${selected.size} mensaje${selected.size > 1 ? 's' : ''} por WhatsApp`
                }
              </button>
            </div>
          )}
        </>
      )}

      {!loading && orders.length === 0 && (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>📦</span>
          <p>Hacé clic en "Buscar pedidos" para cargar los retiros pendientes.</p>
          <p className={styles.cardHint}>Se detectan pedidos con retiro en local por tipo de envío o nombre de sucursal.</p>
        </div>
      )}
    </div>
  );
}
