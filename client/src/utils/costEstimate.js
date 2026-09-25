// Meta cobra por plantilla entregada según categoría. Es una estimación:
// asume que se entregan todos los mensajes del segmento.
export function estimateCost({ count, category, pricing }) {
  const rate = category === 'UTILITY' ? pricing?.utility : pricing?.marketing;
  if (rate === null || rate === undefined || rate === '' || isNaN(Number(rate))) return { missingRate: true };
  const usd = Number(count ?? 0) * Number(rate);
  const arsRate = pricing?.arsRate;
  const ars = arsRate === null || arsRate === undefined || arsRate === '' || isNaN(Number(arsRate)) ? null : usd * Number(arsRate);
  return { rate: Number(rate), usd, ars };
}

export function formatUsd(n) {
  const digits = Math.abs(n) < 1 && n !== 0 ? 4 : 2;
  return `USD ${Number(n).toFixed(digits).replace('.', ',')}`;
}

export function formatArs(n) {
  return `$ ${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}
