import { estimateCost, formatUsd, formatArs } from '../../utils/costEstimate';
import styles from './Composer.module.css';

const CATEGORY_LABEL = { MARKETING: 'Marketing', UTILITY: 'Utilidad' };

export default function CostEstimate({ count, category, pricing }) {
  if (!category) return null;
  const r = estimateCost({ count, category, pricing });
  return (
    <div>
      {r.missingRate ? (
        <p className={styles.cost}>💲 Cargá la tarifa de {CATEGORY_LABEL[category] ?? category} en Config para ver el costo estimado.</p>
      ) : (
        <p className={styles.cost}>
          💲 {count ?? 0} contactos de WhatsApp × {formatUsd(r.rate)} ({CATEGORY_LABEL[category] ?? category}) ≈ <strong>{formatUsd(r.usd)}</strong>
          {r.ars !== null && <> (≈ {formatArs(r.ars)})</>}
        </p>
      )}
      <p className={styles.costNote}>Estimado. Meta cobra sólo los mensajes entregados; las tarifas se editan en Config.</p>
    </div>
  );
}
