import { verifyToken } from '../services/auth.service.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  // Accept token from Authorization header OR ?token= query param (needed for <img src> / <audio src>)
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.agent = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}
