import { useEffect, useState } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import styles from './Templates.module.css';

const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
const LANGUAGES = [
  { code: 'es_AR', label: 'Español (AR)' },
  { code: 'es_MX', label: 'Español (MX)' },
  { code: 'es', label: 'Español' },
  { code: 'en_US', label: 'English (US)' },
  { code: 'pt_BR', label: 'Português (BR)' },
];

export default function Templates() {
  const [templates, setTemplates] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [language, setLanguage] = useState('es_AR');
  const [category, setCategory] = useState('UTILITY');
  const [paramsText, setParamsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    const r = await authFetch(BASE_URL + '/api/templates');
    if (r.ok) setTemplates(await r.json());
  }

  function openModal() {
    setName(''); setDisplayName(''); setBodyText('');
    setLanguage('es_AR'); setCategory('UTILITY'); setParamsText('');
    setError('');
    setShowModal(true);
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim() || !bodyText.trim()) return;
    setSaving(true); setError('');
    try {
      const params = paramsText.split('\n').map(s => s.trim()).filter(Boolean);
      const r = await authFetch(BASE_URL + '/api/templates', {
        method: 'POST',
        body: { name: name.trim(), displayName: displayName.trim() || name.trim(), bodyText: bodyText.trim(), language, category, params },
      });
      if (!r.ok) throw new Error((await r.json()).error);
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    await authFetch(`/api/templates/${id}`, { method: 'DELETE' });
    setTemplates(prev => prev.filter(t => t.id !== id));
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Plantillas de WhatsApp</h1>
          <p className={styles.subtitle}>
            Plantillas aprobadas en Meta Business Manager para iniciar conversaciones fuera de la ventana de 24h
          </p>
        </div>
        <button className={styles.newBtn} onClick={openModal}>+ Nueva plantilla</button>
      </div>

      <div className={styles.body}>
        {templates.length === 0 ? (
          <p className={styles.empty}>No hay plantillas guardadas todavía.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>NOMBRE TÉC.</th>
                <th className={styles.th}>DISPLAY NAME</th>
                <th className={styles.th}>IDIOMA</th>
                <th className={styles.th}>CATEGORÍA</th>
                <th className={styles.th}>PARÁMETROS</th>
                <th className={styles.th}>PREVIEW</th>
                <th className={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {templates.map(t => (
                <tr key={t.id} className={styles.tr}>
                  <td className={styles.td}>
                    <span className={styles.nameBadge}>{t.name}</span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.displayName}>{t.displayName}</span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.meta}>{t.language}</span>
                  </td>
                  <td className={styles.td}>
                    <span className={`${styles.catBadge} ${styles[`cat_${t.category}`]}`}>{t.category}</span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.meta}>{t.params?.length ?? 0}</span>
                  </td>
                  <td className={styles.tdPreview}>
                    <span className={styles.preview}>{t.bodyText}</span>
                  </td>
                  <td className={styles.tdAction}>
                    <button className={styles.deleteBtn} onClick={() => handleDelete(t.id)} title="Eliminar">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className={styles.overlay} onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>Nueva plantilla</span>
              <button className={styles.closeBtn} onClick={() => setShowModal(false)}>×</button>
            </div>
            <form className={styles.modalForm} onSubmit={handleCreate}>
              <div className={styles.modalRow}>
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>Nombre técnico *</label>
                  <input
                    className={styles.input}
                    type="text"
                    placeholder="ej: saludo_inicial"
                    value={name}
                    onChange={e => setName(e.target.value.replace(/[^a-z0-9_]/gi, '').toLowerCase())}
                    maxLength={60}
                    autoFocus
                  />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>Display name</label>
                  <input
                    className={styles.input}
                    type="text"
                    placeholder="ej: Saludo inicial"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    maxLength={60}
                  />
                </div>
              </div>
              <div className={styles.modalRow}>
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>Idioma</label>
                  <select className={styles.select} value={language} onChange={e => setLanguage(e.target.value)}>
                    {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                  </select>
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>Categoría</label>
                  <select className={styles.select} value={category} onChange={e => setCategory(e.target.value)}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>Texto de la plantilla *</label>
                <textarea
                  className={styles.textarea}
                  placeholder="Hola {{1}}, tu pedido {{2}} está listo."
                  value={bodyText}
                  onChange={e => setBodyText(e.target.value)}
                  rows={4}
                />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>Parámetros (uno por línea)</label>
                <textarea
                  className={styles.textarea}
                  placeholder={'nombre del cliente\nnúmero de pedido'}
                  value={paramsText}
                  onChange={e => setParamsText(e.target.value)}
                  rows={3}
                />
                <p className={styles.hint}>Descripción de cada {"{{n}}"} en orden. Dejá vacío si no hay parámetros.</p>
              </div>
              {error && <p className={styles.error}>{error}</p>}
              <div className={styles.modalFooter}>
                <button type="button" className={styles.cancelBtn} onClick={() => setShowModal(false)}>Cancelar</button>
                <button className={styles.createBtn} type="submit" disabled={saving || !name.trim() || !bodyText.trim()}>
                  {saving ? 'Guardando…' : 'Crear plantilla'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
