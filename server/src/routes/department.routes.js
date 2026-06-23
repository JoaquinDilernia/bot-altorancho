import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import {
  getAllDepartments, createDepartment, updateDepartment, deleteDepartment,
} from '../services/department.service.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    res.json(await getAllDepartments());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, description, active } = req.body;
    if (!name || !description) return res.status(400).json({ error: 'name y description son requeridos' });
    res.status(201).json(await createDepartment({ name, description, active }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    res.json(await updateDepartment(req.params.id, req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await deleteDepartment(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
