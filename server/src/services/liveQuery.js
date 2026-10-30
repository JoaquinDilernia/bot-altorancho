// Resultado de una query de Firestore mantenido en memoria con onSnapshot.
//
// El panel pide las mismas listas de conversaciones cada pocos segundos por
// cada pestaña abierta. Con .get() eso relee la query completa en cada pedido
// (200 docs × miles de veces por día = el grueso de la factura de Firestore).
// Con un listener, Firestore cobra la carga inicial y después solo los docs
// que cambian. Si el listener se cae, se vuelve a .get() hasta reconectar.
const RETRY_MS = 60 * 1000;

export function createLiveQuery(buildQuery, label) {
  let docs = null;
  let unsub = null;

  function start() {
    if (unsub) return;
    unsub = buildQuery().onSnapshot(
      (snap) => { docs = snap.docs; },
      (err) => {
        console.error(`[liveQuery:${label}]`, err.message);
        docs = null;
        unsub = null;
        setTimeout(start, RETRY_MS).unref?.();
      },
    );
  }

  return {
    async getDocs() {
      start();
      if (docs) return docs;
      return (await buildQuery().get()).docs;
    },
  };
}
