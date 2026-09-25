import { useEffect, useMemo, useRef } from 'react';
import { TEMPLATE_VARS, slugTemplateName } from '../../utils/templateVars';
import styles from './Composer.module.css';

export const EMPTY_COMPOSER = {
  templateName: '', templateNameTouched: false, category: 'MARKETING',
  bodyText: '', imageFile: null, linkMode: 'button', buttonText: 'Ver promo',
};

export default function TemplateComposer({ value, onChange, canUseButton, campaignName }) {
  const textRef = useRef(null);
  // Updater funcional: si dos set() se disparan en el mismo ciclo (ej. el
  // efecto del nombre técnico y el del botón corriendo juntos), cada uno
  // tiene que partir del estado más reciente y no de un `value` de props
  // que quedó viejo — si no, el segundo pisa lo que hizo el primero.
  const set = (patch) => onChange(prev => ({ ...prev, ...patch }));

  // El nombre técnico sigue al nombre de la difusión hasta que lo editan a mano
  useEffect(() => {
    if (!value.templateNameTouched) set({ templateName: slugTemplateName(campaignName) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignName]);

  // canUseButton arranca en null (todavía no respondió /meta-info) — sólo
  // hay que bajar el botón a "texto" cuando ya se confirmó que no se puede,
  // nunca mientras está cargando (si no, se pisa la elección del agente).
  useEffect(() => {
    if (canUseButton === false && value.linkMode === 'button') set({ linkMode: 'text' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseButton]);

  function insertVar(key) {
    const el = textRef.current;
    const token = `{{${key}}}`;
    const start = el?.selectionStart ?? value.bodyText.length;
    const end = el?.selectionEnd ?? value.bodyText.length;
    const bodyText = value.bodyText.slice(0, start) + token + value.bodyText.slice(end);
    set({ bodyText });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
  }

  const vars = useMemo(() => TEMPLATE_VARS, []);

  return (
    <div className={styles.composer}>
      <div className={styles.row}>
        <div>
          <label className={styles.label}>Nombre técnico de la plantilla</label>
          <input
            className={styles.input}
            value={value.templateName}
            onChange={e => set({ templateName: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'), templateNameTouched: true })}
            required
          />
        </div>
        <div>
          <label className={styles.label}>Categoría</label>
          <select className={styles.input} value={value.category} onChange={e => set({ category: e.target.value })}>
            <option value="MARKETING">Marketing (promos)</option>
            <option value="UTILITY">Utilidad (avisos)</option>
          </select>
        </div>
      </div>

      <div>
        <label className={styles.label}>Imagen (opcional)</label>
        <input type="file" accept="image/jpeg,image/png" onChange={e => set({ imageFile: e.target.files?.[0] ?? null })} />
      </div>

      <div>
        <label className={styles.label}>Texto del mensaje</label>
        <div className={styles.varBar}>
          <span className={styles.hint}>+ Insertar dato:</span>
          {vars.map(v => (
            <button
              key={v.key}
              type="button"
              className={styles.varChip}
              onClick={() => insertVar(v.key)}
              disabled={v.key === 'link' && value.linkMode !== 'text'}
              title={v.key === 'link' && value.linkMode !== 'text' ? 'Sólo con el link "En el texto"' : ''}
            >
              {v.label}
            </button>
          ))}
        </div>
        <textarea
          ref={textRef}
          className={styles.textarea}
          value={value.bodyText}
          onChange={e => set({ bodyText: e.target.value })}
          placeholder="Hola {{primer_nombre}}! Esta semana tenemos 20% off en toda la tienda."
          required
        />
        <p className={styles.hint}>No empieces ni termines el texto con un dato (Meta lo rechaza).</p>
        {/\p{Extended_Pictographic}/u.test(value.bodyText) && (
          <p className={styles.hint}>⚠ Tiene emojis: en esta cuenta las plantillas con emoji se quedaron trabadas en "pendiente" en Meta. Recomendado sacarlos.</p>
        )}
      </div>

      <div>
        <label className={styles.label}>Link</label>
        <div className={styles.segmented}>
          {[['button', 'Botón abajo'], ['text', 'En el texto'], ['none', 'Sin link']].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`${styles.segBtn} ${value.linkMode === mode ? styles.segBtnActive : ''}`}
              onClick={() => set({ linkMode: mode })}
              disabled={mode === 'button' && canUseButton === false}
            >
              {label}
            </button>
          ))}
        </div>
        {canUseButton === false && <p className={styles.hint}>El botón necesita PUBLIC_BASE_URL configurada en el servidor.</p>}
        {value.linkMode === 'button' && (
          <input
            className={styles.input}
            maxLength={25}
            value={value.buttonText}
            onChange={e => set({ buttonText: e.target.value })}
            placeholder="Ver promo"
            required
          />
        )}
        {value.linkMode === 'text' && <p className={styles.hint}>Insertá "Link de la promo" en el texto donde quieras que aparezca.</p>}
      </div>
    </div>
  );
}
