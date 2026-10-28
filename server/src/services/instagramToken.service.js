import axios from 'axios';
import { getDb } from './firebase.service.js';

// Token de usuario de Instagram (API de Instagram con inicio de sesión con
// Instagram). Es el flujo cuyos permisos aprobó Meta
// (instagram_business_manage_messages) — el viejo flujo vía página de Facebook
// quedó en acceso estándar y solo recibe DMs de cuentas con rol en la app.
//
// El token dura 60 días. El primero se carga a mano en META_IG_ACCESS_TOKEN;
// las renovaciones se guardan en Firestore y tienen prioridad sobre la env,
// así no hay que tocar Railway cada 2 meses.
const DOC = () => getDb().collection('bot-altorancho_config').doc('instagram_token');
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

let cache = null;

export function hasInstagramLoginToken() {
  return Boolean(process.env.META_IG_ACCESS_TOKEN);
}

export async function getInstagramToken() {
  if (cache) return cache.token;
  const envToken = process.env.META_IG_ACCESS_TOKEN;
  try {
    const snap = await DOC().get();
    const stored = snap.exists ? snap.data() : null;
    // Si alguien cargó un token nuevo en la env (p. ej. regenerado a mano),
    // ese manda sobre el guardado.
    if (stored?.token && stored.sourceEnvToken === envToken) {
      cache = stored;
      return stored.token;
    }
  } catch (err) {
    console.error('[ig-token] Error leyendo token guardado:', err.message);
  }
  cache = { token: envToken, refreshedAt: 0, sourceEnvToken: envToken };
  return envToken;
}

// Meta solo deja renovar tokens con más de 24 h; renovamos una vez por semana.
export async function refreshInstagramTokenIfNeeded() {
  if (!hasInstagramLoginToken()) return;
  const token = await getInstagramToken();
  if (Date.now() - (cache.refreshedAt || 0) < REFRESH_AFTER_MS && cache.refreshedAt) return;
  const { data } = await axios.get('https://graph.instagram.com/refresh_access_token', {
    params: { grant_type: 'ig_refresh_token', access_token: token },
  });
  cache = {
    token: data.access_token,
    refreshedAt: Date.now(),
    expiresIn: data.expires_in,
    sourceEnvToken: process.env.META_IG_ACCESS_TOKEN,
  };
  await DOC().set(cache);
  console.log(`[ig-token] Token renovado, vence en ${Math.round(data.expires_in / 86400)} días`);
}
