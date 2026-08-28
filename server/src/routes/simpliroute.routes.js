import { Router } from 'express';
import {
  verifySimpliRouteToken,
  handleSimpliRouteCheckout,
  handleSimpliRouteRouteStart,
} from '../services/simpliroute.service.js';

const router = Router();

// Un path distinto por evento en vez de inferir el tipo de evento del
// payload — el shape real de SimpliRoute para esta cuenta no está
// documentado con certeza, así que es más robusto configurar cada webhook
// en SimpliRoute apuntando a un endpoint específico.
router.post('/checkout', (req, res) => {
  if (!verifySimpliRouteToken(req)) {
    console.warn('[simpliroute-webhook] Token inválido o ausente (checkout)');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // SimpliRoute reintenta 3 veces si no recibe 200 rápido
  handleSimpliRouteCheckout(req.body).catch(err =>
    console.error('[simpliroute-webhook] Error procesando checkout:', err)
  );
});

router.post('/route-start', (req, res) => {
  if (!verifySimpliRouteToken(req)) {
    console.warn('[simpliroute-webhook] Token inválido o ausente (route-start)');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  handleSimpliRouteRouteStart(req.body).catch(err =>
    console.error('[simpliroute-webhook] Error procesando inicio de ruta:', err)
  );
});

export default router;
