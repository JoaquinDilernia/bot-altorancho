import { useEffect, useState } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import styles from './Departments.module.css';

export default function Departments() {
  const { agent } = useAuth();
  const isAdmin = agent?.role === 'admin';

  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { id, name, description, active } | 'new'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await authFetch(BASE_URL + '/api/departments');
      if (r.ok) setDepartments(await r.json());
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setEditing({ id: '', name: '', description: '', active: true });
    setError('');
  }

  function startEdit(dept) {
    setEditing({ ...dept });
    setError('');
  }

  function cancelEdit() {
    setEditing(null);
    setError('');
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const isNew = !editing.id || !departments.find(d => d.id === editing.id);
      const url = isNew
        ? BASE_URL + '/api/departments'
        : BASE_URL + `/api/departments/${editing.id}`;
      const r = await authFetch(url, {
        method: isNew ? 'POST' : 'PUT',
        body: { name: editing.name, description: editing.description, active: editing.active },
      });
      if (!r.ok) throw new Error((await r.json()).error);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(dept) {
    await authFetch(BASE_URL + `/api/departments/${dept.id}`, {
      method: 'PUT',
      body: { active: !dept.active },
    });
    setDepartments(prev => prev.map(d => d.id === dept.id ? { ...d, active: !d.active } : d));
  }

  async function handleDelete(id) {
    if (!confirm('¿Eliminás este departamento? Las conversaciones asignadas no se van a borrar.')) return;
    await authFetch(BASE_URL + `/api/departments/${id}`, { method: 'DELETE' });
    setDepartments(prev => prev.filter(d => d.id !== id));
  }

  if (loading) return <div className={styles.loading}>Cargando...</div>;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Departamentos</h1>
          <p className={styles.subtitle}>
            Configurá a qué equipo deriva el bot cada tipo de consulta. La descripción le indica al bot cuándo escalar a cada departamento.
          </p>
        </div>
        {isAdmin && !editing && (
          <button className={styles.btnPrimary} onClick={startNew}>+ Nuevo departamento</button>
        )}
      </header>

      <div className={styles.body}>
        {/* Formulario nuevo / edición */}
        {editing && (
          <form className={styles.form} onSubmit={handleSave}>
            <h2 className={styles.formTitle}>
              {editing.id && departments.find(d => d.id === editing.id) ? 'Editar departamento' : 'Nuevo departamento'}
            </h2>
            <div className={styles.field}>
              <label className={styles.label}>Nombre</label>
              <input
                className={styles.input}
                value={editing.name}
                onChange={e => setEditing(p => ({ ...p, name: e.target.value }))}
                placeholder="Ej: Logística"
                required
                maxLength={50}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>¿Cuándo escala el bot a este departamento?</label>
              <textarea
                className={styles.textarea}
                value={editing.description}
                onChange={e => setEditing(p => ({ ...p, description: e.target.value }))}
                placeholder="Describí los casos en que el bot debe derivar a este equipo. Este texto va directo al modelo de IA."
                rows={4}
                required
              />
              <p className={styles.hint}>Sé específico. Ej: "Envíos, demoras, seguimiento de pedidos online, problemas de entrega, cambios de dirección."</p>
            </div>
            <div className={styles.field}>
              <label className={styles.toggleLabel}>
                <span>Activo</span>
                <div
                  className={`${styles.toggle} ${editing.active ? styles.toggleOn : ''}`}
                  onClick={() => setEditing(p => ({ ...p, active: !p.active }))}
                  role="checkbox"
                  aria-checked={editing.active}
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && setEditing(p => ({ ...p, active: !p.active }))}
                >
                  <div className={styles.toggleThumb} />
                </div>
              </label>
            </div>
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.formActions}>
              <button type="button" className={styles.btnSecondary} onClick={cancelEdit}>Cancelar</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>
                {saving ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </form>
        )}

        {/* Lista de departamentos */}
        <div className={styles.list}>
          {departments.length === 0 && (
            <p className={styles.empty}>No hay departamentos configurados.</p>
          )}
          {departments.map(dept => (
            <div key={dept.id} className={`${styles.card} ${!dept.active ? styles.cardInactive : ''}`}>
              <div className={styles.cardMain}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardName}>
                    <span className={`${styles.activeDot} ${dept.active ? styles.activeDotOn : ''}`} />
                    {dept.name}
                  </div>
                  <code className={styles.marker}>[ESCALAR_{dept.id.toUpperCase()}]</code>
                </div>
                <p className={styles.cardDesc}>{dept.description}</p>
              </div>
              {isAdmin && (
                <div className={styles.cardActions}>
                  <button
                    className={`${styles.actionBtn} ${dept.active ? styles.actionBtnWarning : styles.actionBtnSuccess}`}
                    onClick={() => toggleActive(dept)}
                    title={dept.active ? 'Desactivar' : 'Activar'}
                  >
                    {dept.active ? 'Desactivar' : 'Activar'}
                  </button>
                  <button className={styles.actionBtn} onClick={() => startEdit(dept)}>Editar</button>
                  <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={() => handleDelete(dept.id)}>Eliminar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
