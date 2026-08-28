import { useState, useEffect, useMemo } from 'react';
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

// Orden preferido de sucursales en el acordeón — cualquier otra que aparezca
// en los datos (ej: Nordelta) se agrega al final, no se pierde.
const BRANCH_ORDER = ['Belgrano', 'San Isidro', 'Alcorta'];

export default function Notifications() {
  const [orders, setOrders]             = useState([]);
  const [templates, setTemplates]       = useState([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');
  const [statuses, setStatuses]         = useState(['unpacked', 'unshipped']);
  const [openBranches, setOpenBranches] = useState(new Set());
  const [selected, setSelected]         = useState(new Set());
  const [templateName, setTemplateName] = useState('');
  const [paramTemplate, setParamTemplate] = useState(['{{number}}']);
  const [sending, setSending]           = useState(false);
  const [results, setResults]           = useState(null);

  // Seguimiento de retiro (recordatorios a día 3 / día 7)
  const [followupEnabled, setFollowupEnabled] = useState(false);
  const [day3Template, setDay3Template]       = useState('');
  const [day3Params, setDay3Params]           = useState(['']);
  const [day7Template, setDay7Template]       = useState('');
  const [day7Params, setDay7Params]           = useState(['']);
  const [followupSaving, setFollowupSaving]   = useState(false);
  const [followupSaved, setFollowupSaved]     = useState(false);

  useEffect(() => { loadTemplates(); loadFollowupConfig(); fetchOrders(); }, []);

  async function loadTemplates() {
    try {
      const r = await authFetch(BASE_URL + '/api/templates');
      const data = await r.json();
      const approved = (Array.isArray(data) ? data : []).filter(t => t.metaStatus === 'APPROVED');
      setTemplates(approved);
    } catch { /* non-critical */ }
  }

  async function loadFollowupConfig() {
    try {
      const r = await authFetch(BASE_URL + '/api/config');
      const data = await r.json();
      const cfg = data.config ?? {};
      setFollowupEnabled(!!cfg.pickupFollowupEnabled);
      setDay3Template(cfg.pickupFollowupDay3Template ?? '');
      setDay3Params(cfg.pickupFollowupDay3Params?.length ? cfg.pickupFollowupDay3Params : ['']);
      setDay7Template(cfg.pickupFollowupDay7Template ?? '');
      setDay7Params(cfg.pickupFollowupDay7Params?.length ? cfg.pickupFollowupDay7Params : ['']);
    } catch { /* non-critical */ }
  }

  function paramCountForTemplate(name) {
    const tpl = templates.find(t => t.name === name);
    const count = (tpl?.bodyText?.match(/\{\{[^}]+\}\}/g) ?? []).length;
    return Math.max(count, 1);
  }

  function onDay3TemplateChange(name) {
    setDay3Template(name);
    setDay3Params(Array.from({ length: paramCountForTemplate(name) }, (_, i) => i === 0 ? '{{number}}' : ''));
  }

  function onDay7TemplateChange(name) {
    setDay7Template(name);
    setDay7Params(Array.from({ length: paramCountForTemplate(name) }, (_, i) => i === 0 ? '{{number}}' : ''));
  }

  async function handleSaveFollowupConfig() {
    setFollowupSaving(true);
    try {
      await authFetch(BASE_URL + '/api/config', {
        method: 'PUT',
        body: {
          pickupFollowupEnabled: followupEnabled,
          pickupFollowupDay3Template: day3Template,
          pickupFollowupDay3Params: day3Params.filter(Boolean),
          pickupFollowupDay7Template: day7Template,
          pickupFollowupDay7Params: day7Params.filter(Boolean),
        },
      });
      setFollowupSaved(true);
      setTimeout(() => setFollowupSaved(false), 2500);
    } finally {
      setFollowupSaving(false);
    }
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

  const filteredByStatus = useMemo(
    () => orders.filter(o => !statuses.length || statuses.includes(o.shippingStatus)),
    [orders, statuses]
  );

  const branchGroups = useMemo(() => {
    const groups = new Map();
    for (const o of filteredByStatus) {
      const branch = o.branch || 'Sucursal';
      if (!groups.has(branch)) groups.set(branch, []);
      groups.get(branch).push(o);
    }
    const names = [...groups.keys()].sort((a, b) => {
      const ia = BRANCH_ORDER.indexOf(a);
      const ib = BRANCH_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return names.map(name => ({ name, orders: groups.get(name) }));
  }, [filteredByStatus]);

  function toggleStatus(s) {
    setStatuses(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  function toggleBranchOpen(name) {
    setOpenBranches(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  function toggleOrder(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleBranchAll(branchOrders) {
    const ids = branchOrders.map(o => o.id);
    const allSelected = ids.length > 0 && ids.every(id => selected.has(id));
    setSelected(prev => {
      const next = new Set(prev);
      ids.forEach(id => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  function onTemplateChange(name) {
    setTemplateName(name);
    const tpl = templates.find(t => t.name === name);
    if (!tpl) { setParamTemplate(['{{number}}']); return; }
    const count = (tpl.bodyText?.match(/\{\{[^}]+\}\}/g) ?? []).length;
    // Siempre es 1 sola variable — el número de pedido — así que se
    // autocompleta en vez de dejarla vacía para que la carguen a mano.
    setParamTemplate(Array.from({ length: Math.max(count, 1) }, (_, i) => i === 0 ? '{{number}}' : ''));
  }

  async function handleSend() {
    if (!templateName) { setError('Seleccioná un template'); return; }
    if (!selected.size) { setError('Seleccioná al menos un pedido'); return; }

    const tpl = templates.find(t => t.name === templateName);
    if (!tpl) return;

    const ordersToSend = filteredByStatus.filter(o => selected.has(o.id));
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
        <button className={styles.btnFetch} onClick={fetchOrders} disabled={loading}>
          {loading ? 'Actualizando…' : '↻ Actualizar'}
        </button>
      </header>

      {/* Seguimiento automático de retiro */}
      <div className={styles.followupCard}>
        <div className={styles.followupHeader}>
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={followupEnabled}
              onChange={e => setFollowupEnabled(e.target.checked)}
            />
            Seguimiento automático de retiro
          </label>
          <p className={styles.cardHint}>
            Si un pedido sigue pendiente de retirar, se le manda un recordatorio a los 3 días y otro a los 7. Se corta solo en cuanto el pedido cambia de estado en TiendaNube.
          </p>
        </div>

        {followupEnabled && (
          <div className={styles.followupGrid}>
            <div className={styles.followupStage}>
              <label className={styles.label}>Recordatorio día 3</label>
              <select className={styles.input} value={day3Template} onChange={e => onDay3TemplateChange(e.target.value)}>
                <option value="">— Seleccioná un template —</option>
                {templates.map(t => (
                  <option key={t.id ?? t.name} value={t.name}>{t.displayName ?? t.name} ({t.language})</option>
                ))}
              </select>
              {day3Template && day3Params.map((p, i) => (
                <input
                  key={i}
                  className={styles.input}
                  value={p}
                  onChange={e => setDay3Params(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                  placeholder={`Variable {{${i + 1}}} — ej: {{name}}, {{number}}, texto fijo…`}
                />
              ))}
            </div>

            <div className={styles.followupStage}>
              <label className={styles.label}>Recordatorio día 7</label>
              <select className={styles.input} value={day7Template} onChange={e => onDay7TemplateChange(e.target.value)}>
                <option value="">— Seleccioná un template —</option>
                {templates.map(t => (
                  <option key={t.id ?? t.name} value={t.name}>{t.displayName ?? t.name} ({t.language})</option>
                ))}
              </select>
              {day7Template && day7Params.map((p, i) => (
                <input
                  key={i}
                  className={styles.input}
                  value={p}
                  onChange={e => setDay7Params(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                  placeholder={`Variable {{${i + 1}}} — ej: {{name}}, {{number}}, texto fijo…`}
                />
              ))}
            </div>

            <div className={styles.followupSaveRow}>
              <button className={styles.sendBtn} onClick={handleSaveFollowupConfig} disabled={followupSaving}>
                {followupSaving ? 'Guardando…' : 'Guardar seguimiento'}
              </button>
              {followupSaved && <span className={styles.hSent}>✓ Guardado</span>}
            </div>
          </div>
        )}
      </div>

      {/* Estado del envío */}
      <div className={styles.statusFilterRow}>
        <span className={styles.filterLabel}>Estado del envío</span>
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
        {error && <div className={styles.errorBanner}>{error}</div>}
      </div>

      {/* Acordeón por sucursal */}
      <div className={styles.branchArea}>
        {loading ? (
          <p className={styles.emptyFilter}>Cargando pedidos…</p>
        ) : branchGroups.length === 0 ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>📦</span>
            <p>No hay pedidos con retiro pendiente en este momento.</p>
          </div>
        ) : (
          branchGroups.map(({ name, orders: branchOrders }) => {
            const isOpen = openBranches.has(name);
            const selectedInBranch = branchOrders.filter(o => selected.has(o.id)).length;
            return (
              <div key={name} className={styles.branchSection}>
                <button
                  className={styles.branchHeader}
                  onClick={() => toggleBranchOpen(name)}
                  aria-expanded={isOpen}
                >
                  <span className={styles.branchChevron}>{isOpen ? '▾' : '▸'}</span>
                  <span className={styles.branchName}>{name}</span>
                  <span className={styles.branchCount}>{branchOrders.length}</span>
                  {selectedInBranch > 0 && (
                    <span className={styles.selectedCount}>{selectedInBranch} seleccionado{selectedInBranch > 1 ? 's' : ''}</span>
                  )}
                </button>

                {isOpen && (
                  <div className={styles.branchBody}>
                    <div className={styles.tableToolbar}>
                      <label className={styles.checkLabel}>
                        <input
                          type="checkbox"
                          checked={branchOrders.length > 0 && branchOrders.every(o => selected.has(o.id))}
                          onChange={() => toggleBranchAll(branchOrders)}
                        />
                        Seleccionar todos en {name}
                      </label>
                    </div>
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th style={{ width: 32 }}></th>
                            <th>Pedido</th>
                            <th>Cliente</th>
                            <th>Teléfono</th>
                            <th>Estado</th>
                            <th>Total</th>
                            <th>Resultado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {branchOrders.map(o => {
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
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Barra de envío — siempre presente, no empuja ni achica el resto al seleccionar */}
      <div className={styles.sendBar}>
        {selected.size === 0 ? (
          <p className={styles.sendBarHint}>Seleccioná uno o más pedidos (de cualquier sucursal) para notificar.</p>
        ) : (
          <div className={styles.sendBarActive}>
            <div className={styles.sendBarRow}>
              <span className={styles.sendTitle}>Enviar a {selected.size} pedido{selected.size > 1 ? 's' : ''}</span>

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

              <button className={styles.sendBtn} onClick={handleSend} disabled={sending || !templateName}>
                {sending
                  ? `Enviando (${selected.size})…`
                  : `Enviar ${selected.size} mensaje${selected.size > 1 ? 's' : ''}`
                }
              </button>
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
          </div>
        )}
      </div>
    </div>
  );
}
