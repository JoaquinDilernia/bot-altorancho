import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import styles from './Campaigns.module.css';
import TemplateComposer, { EMPTY_COMPOSER, IMAGE_SIZE_HINT } from '../components/Campaigns/TemplateComposer';
import WhatsAppPreview from '../components/Campaigns/WhatsAppPreview';
import CostEstimate from '../components/Campaigns/CostEstimate';
import { renderPreview } from '../utils/templateVars';

const STATUS_LABEL = { pending_template: 'Esperando aprobación', template_rejected: 'Plantilla rechazada', draft: 'Borrador', sending: 'Enviando…', sent: 'Enviada' };
const STATUS_CLASS = { pending_template: 'statusSending', template_rejected: 'statusRejected', draft: 'statusDraft', sending: 'statusSending', sent: 'statusSent' };
const EMPTY_SEGMENT = { q: '', channel: '', tags: [], hasOrders: false, spentMin: '', spentMonths: '12', product: '', productMonths: '12', orderCountMin: '', lastOrderMaxDays: '', lastOrderMinDays: '' };
const DEFAULT_FORM = { name: '', mode: 'existing', templateId: '', targetUrl: '', segment: { ...EMPTY_SEGMENT } };
const DELETABLE = new Set(['draft', 'pending_template', 'template_rejected']);

function formatDate(ts) {
  if (!ts) return '—';
  try {
    const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
    return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [params, setParams] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null); // { campaign, sends }
  const [sending, setSending] = useState(false);
  const pollRef = useRef(null);
  const [composer, setComposer] = useState(EMPTY_COMPOSER);
  const [imageFile, setImageFile] = useState(null); // para plantillas aprobadas con header IMAGE
  const [pricing, setPricing] = useState(null);
  const [testPhones, setTestPhones] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState(null);
  const [canUseButton, setCanUseButton] = useState(null); // null = todavía no respondió /meta-info
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [campRes, tplRes, tagsRes, cfgRes, infoRes] = await Promise.all([
        authFetch(BASE_URL + '/api/campaigns'),
        authFetch(BASE_URL + '/api/templates'),
        authFetch(BASE_URL + '/api/customers/tags'),
        authFetch(BASE_URL + '/api/config'),
        authFetch(BASE_URL + '/api/campaigns/meta-info'),
      ]);
      if (campRes.ok) setCampaigns((await campRes.json()).campaigns ?? []);
      // /api/templates devuelve un array plano (mismo endpoint que usa
      // Conversations.jsx) — sólo sirven las que Meta ya aprobó.
      if (tplRes.ok) setTemplates((await tplRes.json()).filter(t => t.metaStatus === 'APPROVED'));
      if (tagsRes.ok) setAllTags((await tagsRes.json()).tags ?? []);
      if (cfgRes.ok) {
        const { config } = await cfgRes.json();
        setPricing(config?.pricing ?? null);
        if (config?.campaignTestPhones?.length) setTestPhones(config.campaignTestPhones.join(', '));
      }
      if (infoRes.ok) setCanUseButton(!!(await infoRes.json()).canUseButton);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function refreshPreview(segment) {
    setPreviewing(true);
    try {
      const r = await authFetch(BASE_URL + '/api/campaigns/preview-segment', { method: 'POST', body: { segment } });
      if (r.ok) setPreview(await r.json());
    } finally {
      setPreviewing(false);
    }
  }

  function openCreate() {
    setForm({ ...DEFAULT_FORM, segment: { ...EMPTY_SEGMENT } });
    setParams([]);
    setPreview(null);
    setError('');
    setComposer(EMPTY_COMPOSER);
    setImageFile(null);
    refreshPreview({ ...EMPTY_SEGMENT });
  }

  function cancel() { setForm(null); setDetail(null); setError(''); }

  function setField(key, val) {
    setForm(p => ({ ...p, [key]: val }));
  }

  function setSegment(patch) {
    setForm(p => {
      const segment = { ...p.segment, ...patch };
      refreshPreview(segment);
      return { ...p, segment };
    });
  }

  function toggleTag(tag) {
    const tags = form.segment.tags.includes(tag)
      ? form.segment.tags.filter(t => t !== tag)
      : [...form.segment.tags, tag];
    setSegment({ tags });
  }

  function pickTemplate(id) {
    const tpl = templates.find(t => t.id === id);
    setField('templateId', id);
    setParams(tpl?.params?.map(() => '') ?? []);
  }

  const selectedTemplate = templates.find(t => t.id === form?.templateId);
  // Plantilla creada desde Difusiones con botón o link en el texto: la URL
  // destino deja de ser opcional (si no, se manda "-" o un botón sin link).
  const existingTemplateNeedsUrl = form?.mode === 'existing' && (selectedTemplate?.linkMode === 'button' || selectedTemplate?.linkMode === 'text');

  const activeImage = form?.mode === 'new' ? composer.imageFile : imageFile;
  useEffect(() => {
    if (!activeImage) { setImagePreviewUrl(null); return; }
    const url = URL.createObjectURL(activeImage);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [activeImage]);

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      let campaign;
      let imageError = null;
      if (form.mode === 'new') {
        const fd = new FormData();
        fd.append('data', JSON.stringify({
          name: form.name,
          templateName: composer.templateName,
          category: composer.category,
          bodyText: composer.bodyText,
          linkMode: composer.linkMode,
          buttonText: composer.buttonText,
          targetUrl: form.targetUrl,
          segment: form.segment,
        }));
        if (composer.imageFile) fd.append('image', composer.imageFile);
        const res = await authFetch(BASE_URL + '/api/campaigns/with-template', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!res.ok) throw new Error(data.error);
        campaign = data.campaign;
      } else {
        if (!selectedTemplate) throw new Error('Elegí una plantilla aprobada');
        const needsImage = selectedTemplate.headerFormat === 'IMAGE';
        if (needsImage && !imageFile) throw new Error('Esta plantilla lleva imagen: subila');
        const res = await authFetch(BASE_URL + '/api/campaigns', {
          method: 'POST',
          body: {
            name: form.name,
            templateName: selectedTemplate.name,
            language: selectedTemplate.language,
            category: selectedTemplate.category,
            paramsTemplate: selectedTemplate.varOrder ? [] : params,
            varOrder: selectedTemplate.varOrder ?? null,
            linkMode: selectedTemplate.linkMode ?? null,
            templateHasImage: needsImage,
            targetUrl: form.targetUrl,
            segment: form.segment,
          },
        });
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!res.ok) throw new Error(data.error);
        campaign = data.campaign;
        if (needsImage) {
          const fd = new FormData();
          fd.append('image', imageFile);
          const imgRes = await authFetch(BASE_URL + `/api/campaigns/${campaign.id}/image`, { method: 'POST', body: fd });
          const imgData = await imgRes.json().catch(() => ({ error: `HTTP ${imgRes.status}` }));
          // La difusión ya quedó creada en el servidor aunque falle la imagen: no
          // tiramos error acá (dejaría el form abierto y un reintento duplicaría
          // la campaña). Guardamos el mensaje y lo mostramos después de abrir el
          // detalle, donde el usuario puede reintentar con "Cambiar imagen".
          if (!imgRes.ok) imageError = `La difusión se creó pero falló la imagen: ${imgData.error}`;
        }
      }
      setForm(null);
      await load();
      await openDetail(campaign);
      if (imageError) alert(imageError);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(campaignStub) {
    setTestResults(null);
    const res = await authFetch(BASE_URL + `/api/campaigns/${campaignStub.id}`);
    if (res.ok) setDetail(await res.json());
  }

  useEffect(() => {
    clearInterval(pollRef.current);
    if (detail?.campaign?.status === 'sending') {
      pollRef.current = setInterval(async () => {
        const res = await authFetch(BASE_URL + `/api/campaigns/${detail.campaign.id}`);
        if (res.ok) {
          const data = await res.json();
          setDetail(data);
          setCampaigns(prev => prev.map(c => c.id === data.campaign.id ? data.campaign : c));
        }
      }, 4000);
    }
    return () => clearInterval(pollRef.current);
  }, [detail?.campaign?.status, detail?.campaign?.id]);

  const tplPollRef = useRef(null);
  useEffect(() => {
    clearInterval(tplPollRef.current);
    if (detail?.campaign?.status === 'pending_template') {
      const campaignId = detail.campaign.id;
      const checkTemplateStatus = async () => {
        const res = await authFetch(BASE_URL + `/api/campaigns/${campaignId}/template-status`);
        if (res.ok) {
          const { campaign } = await res.json();
          if (campaign.status !== 'pending_template') {
            setDetail(prev => ({ ...prev, campaign }));
            setCampaigns(prev => prev.map(c => c.id === campaign.id ? campaign : c));
          }
        }
      };
      // Chequea apenas se abre el detalle además de cada 10s — si no, el
      // agente que abre una difusión ya aprobada hace rato espera hasta 10s
      // viendo "Esperando aprobación" sin necesidad.
      checkTemplateStatus();
      tplPollRef.current = setInterval(checkTemplateStatus, 10000);
    }
    return () => clearInterval(tplPollRef.current);
  }, [detail?.campaign?.status, detail?.campaign?.id]);

  async function handleChangeImage(file) {
    if (!file || !detail) return;
    const fd = new FormData();
    fd.append('image', file);
    const res = await authFetch(BASE_URL + `/api/campaigns/${detail.campaign.id}/image`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) { alert(`No se pudo subir la imagen: ${data.error}`); return; }
    setDetail(prev => ({ ...prev, campaign: data.campaign }));
  }

  async function handleTestSend() {
    if (!detail) return;
    setTesting(true);
    setTestResults(null);
    try {
      const res = await authFetch(BASE_URL + `/api/campaigns/${detail.campaign.id}/test`, { method: 'POST', body: { phones: testPhones } });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(data.error);
      setTestResults(data.results);
    } catch (err) {
      alert(`No se pudo enviar la prueba: ${err.message}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleSend() {
    if (!detail) return;
    if (!confirm(`¿Mandar "${detail.campaign.name}" a ${preview?.whatsappCount ?? detail.campaign.stats.total} contactos? No se puede deshacer.`)) return;
    setSending(true);
    try {
      const res = await authFetch(BASE_URL + `/api/campaigns/${detail.campaign.id}/send`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await openDetail(detail.campaign);
      await load();
    } catch (err) {
      alert(`No se pudo enviar: ${err.message}`);
    } finally {
      setSending(false);
    }
  }

  async function handleDelete(c) {
    if (!confirm(`¿Eliminar la difusión "${c.name}"?`)) return;
    await authFetch(BASE_URL + `/api/campaigns/${c.id}`, { method: 'DELETE' });
    setCampaigns(prev => prev.filter(x => x.id !== c.id));
    if (detail?.campaign?.id === c.id) setDetail(null);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Difusiones</h1>
          <p className={styles.subtitle}>
            Mandá una plantilla aprobada a todos los contactos o a un segmento por tags, y
            mirá cuántos la recibieron, la leyeron y clickearon el link.
          </p>
        </div>
        {!form && !detail && (
          <button className={styles.btnPrimary} onClick={openCreate}>+ Nueva difusión</button>
        )}
      </header>

      <div className={styles.body}>
        {form && (
          <form className={styles.form} onSubmit={handleCreate}>
            <h2 className={styles.formTitle}>Nueva difusión</h2>

            <div className={styles.field}>
              <label className={styles.label}>Nombre (interno, no lo ve el destinatario)</label>
              <input className={styles.input} value={form.name} onChange={e => setField('name', e.target.value)} required placeholder="Ej: Promo octubre" />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Mensaje</label>
              <div className={styles.modeSwitch}>
                <button type="button" className={`${styles.tagChip} ${form.mode === 'existing' ? styles.tagChipActive : ''}`} onClick={() => setField('mode', 'existing')}>Usar plantilla aprobada</button>
                <button type="button" className={`${styles.tagChip} ${form.mode === 'new' ? styles.tagChipActive : ''}`} onClick={() => setField('mode', 'new')}>Crear plantilla nueva</button>
              </div>
            </div>

            <div className={styles.composeGrid}>
              <div className={styles.composeMain}>
                {form.mode === 'new' ? (
                  <TemplateComposer value={composer} onChange={setComposer} canUseButton={canUseButton} campaignName={form.name} />
                ) : (
                  <>
                    <div className={styles.field}>
                      <label className={styles.label}>Plantilla aprobada</label>
                      {templates.length === 0 ? (
                        <p className={styles.hint}>No hay plantillas aprobadas todavía. Creá una en la sección Plantillas.</p>
                      ) : (
                        <select className={styles.input} value={form.templateId} onChange={e => pickTemplate(e.target.value)} required={form.mode === 'existing'}>
                          <option value="">Seleccioná una plantilla…</option>
                          {templates.map(t => <option key={t.id} value={t.id}>{t.displayName} ({t.name})</option>)}
                        </select>
                      )}
                      {selectedTemplate && <p className={styles.templatePreview}>{selectedTemplate.bodyText}</p>}
                    </div>

                    {selectedTemplate?.headerFormat === 'IMAGE' && (
                      <div className={styles.field}>
                        <label className={styles.label}>Imagen de esta difusión</label>
                        <input type="file" accept="image/jpeg,image/png" onChange={e => setImageFile(e.target.files?.[0] ?? null)} required />
                        <p className={styles.hint}>{IMAGE_SIZE_HINT}</p>
                      </div>
                    )}

                    {selectedTemplate?.params?.length > 0 && !selectedTemplate.varOrder && (
                      <div className={styles.field}>
                        <label className={styles.label}>Parámetros de la plantilla</label>
                        <p className={styles.hint}>
                          Podés usar <code>{'{{nombre}}'}</code> para el nombre del contacto,{' '}
                          <code>{'{{pedidos}}'}</code> para su cantidad de compras en Tienda Nube,{' '}
                          <code>{'{{gastado}}'}</code> para el total gastado
                          {form.targetUrl && <> y <code>{'{{link}}'}</code> para el link trackeado</>}.
                        </p>
                        {selectedTemplate.params.map((desc, i) => (
                          <div key={i} className={styles.paramRow}>
                            <span className={styles.paramLabel}>{`{{${i + 1}}}`} {desc}</span>
                            <input
                              className={styles.input}
                              value={params[i] ?? ''}
                              onChange={e => setParams(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                              placeholder={desc}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {(form.mode === 'new' ? composer.linkMode !== 'none' : true) && (
                  <div className={styles.field}>
                    <label className={styles.label}>{form.mode === 'new' || existingTemplateNeedsUrl ? 'URL destino del link' : 'Link a trackear (opcional)'}</label>
                    <input className={styles.input} type="url" value={form.targetUrl} onChange={e => setField('targetUrl', e.target.value)} placeholder="https://..." required={form.mode === 'new' || existingTemplateNeedsUrl} />
                    <p className={styles.hint}>Cada contacto recibe un link corto propio para poder contar los clicks.</p>
                  </div>
                )}
              </div>

              <WhatsAppPreview
                imageUrl={imagePreviewUrl}
                text={renderPreview(form.mode === 'new' ? composer.bodyText : selectedTemplate?.bodyText ?? '', preview?.sample?.[0]?.contactName)}
                buttonText={form.mode === 'new'
                  ? (composer.linkMode === 'button' ? composer.buttonText : null)
                  : (selectedTemplate?.button?.text ?? (selectedTemplate?.hasUrlButton ? 'Link' : null))}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Segmento</label>
              <div className={styles.segmentRow}>
                <input
                  className={styles.input}
                  type="search"
                  placeholder="Buscar por nombre/teléfono…"
                  value={form.segment.q}
                  onChange={e => setSegment({ q: e.target.value })}
                />
                <select className={styles.input} value={form.segment.channel} onChange={e => setSegment({ channel: e.target.value })}>
                  <option value="">Todos los canales</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="instagram">Instagram</option>
                </select>
              </div>
              <label className={styles.ordersFilterLabel}>
                <input type="checkbox" checked={!!form.segment.hasOrders} onChange={e => setSegment({ hasOrders: e.target.checked })} />
                Ya compró (Tienda Nube)
              </label>

              <div className={styles.advPanel}>
                <p className={styles.advTitle}>Segmentar por compras de Tienda Nube (opcional)</p>
                <div className={styles.advRow}>
                  <span className={styles.advLabel}>Gastó ≥ $</span>
                  <input className={styles.advInput} type="number" min="0" value={form.segment.spentMin} onChange={e => setSegment({ spentMin: e.target.value })} placeholder="100000" />
                  <span className={styles.advLabel}>en los últimos</span>
                  <input className={styles.advInput} type="number" min="1" value={form.segment.spentMonths} onChange={e => setSegment({ spentMonths: e.target.value })} />
                  <span className={styles.advLabel}>meses</span>
                </div>
                <div className={styles.advRow}>
                  <span className={styles.advLabel}>Compró</span>
                  <input className={`${styles.advInput} ${styles.advInputWide}`} value={form.segment.product} onChange={e => setSegment({ product: e.target.value })} placeholder="nombre del producto" />
                  <span className={styles.advLabel}>en los últimos</span>
                  <input className={styles.advInput} type="number" min="1" value={form.segment.productMonths} onChange={e => setSegment({ productMonths: e.target.value })} />
                  <span className={styles.advLabel}>meses</span>
                </div>
                <div className={styles.advRow}>
                  <span className={styles.advLabel}>Tiene ≥</span>
                  <input className={styles.advInput} type="number" min="1" value={form.segment.orderCountMin} onChange={e => setSegment({ orderCountMin: e.target.value })} placeholder="3" />
                  <span className={styles.advLabel}>pedidos  ·  última compra hace ≤</span>
                  <input className={styles.advInput} type="number" min="1" value={form.segment.lastOrderMaxDays} onChange={e => setSegment({ lastOrderMaxDays: e.target.value })} placeholder="30" />
                  <span className={styles.advLabel}>días  ·  hace ≥</span>
                  <input className={styles.advInput} type="number" min="1" value={form.segment.lastOrderMinDays} onChange={e => setSegment({ lastOrderMinDays: e.target.value })} placeholder="90" />
                  <span className={styles.advLabel}>días</span>
                </div>
              </div>

              {allTags.length > 0 && (
                <div className={styles.tagFilterRow}>
                  {allTags.map(t => (
                    <button
                      type="button"
                      key={t}
                      className={`${styles.tagChip} ${form.segment.tags.includes(t) ? styles.tagChipActive : ''}`}
                      onClick={() => toggleTag(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
              <p className={styles.previewCount}>
                {previewing ? 'Calculando…' : preview ? (
                  <>📤 <strong>{preview.whatsappCount}</strong> contactos de WhatsApp van a recibir este mensaje{preview.total !== preview.whatsappCount ? ` (de ${preview.total} en el segmento)` : ''}.</>
                ) : ''}
              </p>
              <CostEstimate
                count={preview?.whatsappCount ?? 0}
                category={form.mode === 'new' ? composer.category : selectedTemplate?.category}
                pricing={pricing}
              />
            </div>

            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.formActions}>
              <button type="button" className={styles.btnSecondary} onClick={cancel}>Cancelar</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>
                {saving ? 'Guardando…' : form.mode === 'new' ? 'Guardar y mandar a aprobar' : 'Guardar borrador'}
              </button>
            </div>
          </form>
        )}

        {detail && (
          <div className={styles.detailPanel}>
            <div className={styles.detailHead}>
              <div>
                <h2 className={styles.formTitle}>{detail.campaign.name}</h2>
                <p className={styles.hint}>
                  Plantilla: {detail.campaign.templateName} · Creada {formatDate(detail.campaign.createdAt)}
                </p>
              </div>
              <button className={styles.btnSecondary} onClick={cancel}>← Volver</button>
            </div>

            <div className={styles.statsGrid}>
              <Stat label="Total" value={detail.campaign.stats.total} />
              <Stat label="Enviados" value={detail.campaign.stats.sent} />
              <Stat label="Fallidos" value={detail.campaign.stats.failed} tone="danger" />
              <Stat label="Entregados" value={detail.campaign.stats.delivered} />
              <Stat label="Leídos" value={detail.campaign.stats.read} tone="info" />
              <Stat label="Clicks" value={detail.campaign.stats.clicked} tone="success" />
            </div>

            {detail.campaign.status === 'pending_template' && (
              <p className={styles.hint}>⏳ Esperando que Meta apruebe la plantilla. Esto se actualiza solo; cuando se apruebe se habilita Enviar.</p>
            )}
            {detail.campaign.status === 'template_rejected' && (
              <p className={styles.error}>Meta rechazó la plantilla{detail.campaign.templateRejectedReason ? `: ${detail.campaign.templateRejectedReason}` : ''}. Borrá esta difusión y creala de nuevo corrigiendo el texto.</p>
            )}
            {detail.campaign.templateHasImage && ['draft', 'pending_template'].includes(detail.campaign.status) && (
              <div className={styles.imageRow}>
                {detail.campaign.headerImage?.mediaId && (
                  <img
                    className={styles.imageThumb}
                    alt=""
                    src={`${BASE_URL}/api/conversations/media/${detail.campaign.headerImage.mediaId}?token=${encodeURIComponent(localStorage.getItem('altorancho_token') ?? '')}`}
                  />
                )}
                <label className={styles.btnSecondary}>
                  Cambiar imagen
                  <input type="file" accept="image/jpeg,image/png" hidden onChange={e => handleChangeImage(e.target.files?.[0])} />
                </label>
              </div>
            )}

            {detail.campaign.status === 'draft' && (
              <div className={styles.testBox}>
                <label className={styles.label}>Enviar prueba</label>
                <textarea
                  className={styles.input}
                  rows={2}
                  value={testPhones}
                  onChange={e => setTestPhones(e.target.value)}
                  placeholder="11 5555-1234, 11 4444-3333"
                />
                <p className={styles.hint}>
                  Uno o varios números (hasta 10), separados por coma o uno por línea. Reciben el mismo mensaje, pero no
                  cuenta en las estadísticas ni cambia el estado de la difusión. Meta cobra cada prueba como un mensaje más.
                </p>
                <button type="button" className={styles.btnSecondary} onClick={handleTestSend} disabled={testing || !testPhones.trim()}>
                  {testing ? 'Enviando prueba…' : '🧪 Enviar prueba'}
                </button>
                {testResults && (
                  <ul className={styles.testResults}>
                    {testResults.map(r => (
                      <li key={r.phone} className={r.ok ? styles.testOk : styles.testFail}>
                        {r.ok ? '✓' : '✗'} {r.phone}{r.error ? ` — ${r.error}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {detail.campaign.status === 'draft' && (
              <button className={styles.btnPrimary} onClick={handleSend} disabled={sending}>
                {sending ? 'Enviando…' : '🚀 Enviar difusión ahora'}
              </button>
            )}
            {detail.campaign.status === 'sending' && (
              <p className={styles.hint}>Enviando… esto se actualiza solo cada pocos segundos.</p>
            )}
          </div>
        )}

        {!form && !detail && (
          loading ? (
            <p className={styles.empty}>Cargando…</p>
          ) : campaigns.length === 0 ? (
            <p className={styles.empty}>Todavía no creaste ninguna difusión.</p>
          ) : (
            <div className={styles.table}>
              <div className={styles.tableHead}>
                <span>Nombre</span>
                <span>Plantilla</span>
                <span>Estado</span>
                <span>Estadísticas</span>
                <span>Fecha</span>
                <span></span>
              </div>
              {campaigns.map(c => (
                <div key={c.id} className={styles.tableRow}>
                  <button className={styles.campaignNameBtn} onClick={() => openDetail(c)}>{c.name}</button>
                  <span className={styles.muted}>{c.templateName}</span>
                  <span className={`${styles.statusBadge} ${styles[STATUS_CLASS[c.status]] ?? ''}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
                  <span className={styles.muted}>
                    {c.stats.sent}/{c.stats.total} · {c.stats.read} leídos · {c.stats.clicked} clicks
                  </span>
                  <span className={styles.muted}>{formatDate(c.sentAt ?? c.createdAt)}</span>
                  <div className={styles.rowActions}>
                    {DELETABLE.has(c.status) && (
                      <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={() => handleDelete(c)}>Eliminar</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`${styles.statCard} ${tone ? styles[`stat_${tone}`] : ''}`}>
      <span className={styles.statValue}>{value ?? 0}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}
