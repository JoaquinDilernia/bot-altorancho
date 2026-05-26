import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authFetch, BASE_URL } from '../lib/api';
import { useNotifications } from '../hooks/useNotifications.js';
import styles from './Conversations.module.css';

const AGENTS = [
  { id: 'sofia',   label: 'Sofía' },
  { id: 'joaquin', label: 'Joaquín' },
];

const STATUS_CONFIG = {
  bot:       { label: 'Bot activo',  cls: 'bot' },
  urgent:    { label: 'Urgente',     cls: 'urgent' },
  waiting:   { label: 'En espera',   cls: 'waiting' },
  escalated: { label: 'Derivado',    cls: 'escalated' },
  resolved:  { label: 'Resuelto',    cls: 'resolved' },
};

const CHANNEL_CONFIG = {
  whatsapp:  { label: 'WhatsApp', cls: 'wpp' },
  instagram: { label: 'Instagram', cls: 'ig' },
};

const FILTERS = [
  { value: 'all',       label: 'Todas' },
  { value: 'mine',      label: 'Las mías' },
  { value: 'bot',       label: 'Bot activo' },
  { value: 'urgent',    label: 'Urgente' },
  { value: 'escalated', label: 'Derivado' },
  { value: 'resolved',  label: 'Resuelto' },
];

function StatusChip({ status }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, cls: 'bot' };
  return <span className={`${styles.chip} ${styles['chip_' + cfg.cls]}`}>{cfg.label}</span>;
}

function ChannelBadge({ channel }) {
  const cfg = CHANNEL_CONFIG[channel] ?? { label: channel, cls: 'wpp' };
  return <span className={`${styles.badge} ${styles['badge_' + cfg.cls]}`}>{cfg.label}</span>;
}

function AgentBadge({ assignedTo }) {
  if (!assignedTo) return null;
  const agent = AGENTS.find(a => a.id === assignedTo);
  return <span className={styles.agentBadge}>{agent?.label ?? assignedTo}</span>;
}

function LabelChip({ label, labelMap, onRemove }) {
  const color = labelMap[label] ?? '#6b7280';
  return (
    <span
      className={styles.labelChip}
      style={{ background: color + '22', color, borderColor: color + '55' }}
    >
      {label}
      {onRemove && (
        <button className={styles.labelChipRemove} onClick={() => onRemove(label)}>×</button>
      )}
    </span>
  );
}

function formatAge(ts) {
  if (!ts) return '';
  const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
  if (isNaN(d)) return '';
  const diffMs = Date.now() - d.getTime();
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffH < 1) {
    const diffM = Math.floor(diffMs / (1000 * 60));
    return diffM < 1 ? 'ahora' : `${diffM}m`;
  }
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  if (!ts) return '';
  try {
    const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
    return d.toLocaleDateString('es-AR');
  } catch { return ''; }
}

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user';
  const isAdmin = msg.role === 'admin';
  return (
    <div className={`${styles.msg} ${isUser ? styles.msgUser : isAdmin ? styles.msgAdmin : styles.msgBot}`}>
      <div className={styles.msgBubble}>{msg.content}</div>
      <span className={styles.msgMeta}>
        {isUser ? 'Cliente' : isAdmin ? 'Agente' : 'Gina'}
        {msg.timestamp ? ` · ${formatTime(msg.timestamp)}` : ''}
      </span>
    </div>
  );
}

function ConvItem({ conv, active, onClick, labelMap }) {
  return (
    <button
      className={`${styles.item} ${active ? styles.itemActive : ''}`}
      onClick={onClick}
    >
      <div className={styles.itemTop}>
        <span className={styles.itemName}>{conv.contactName || conv.contactId}</span>
        <div className={styles.itemTopRight}>
          {conv.updatedAt && <span className={styles.itemAge}>{formatAge(conv.updatedAt)}</span>}
          {conv.unread > 0 && <span className={styles.itemUnread}>{conv.unread}</span>}
        </div>
      </div>
      <div className={styles.itemBottom}>
        <StatusChip status={conv.status || 'bot'} />
        <ChannelBadge channel={conv.channel} />
        <AgentBadge assignedTo={conv.assignedTo} />
      </div>
      {conv.lastMessage && <p className={styles.itemPreview}>{conv.lastMessage}</p>}
      {conv.labels?.length > 0 && (
        <div className={styles.itemLabels}>
          {conv.labels.map(l => (
            <span
              key={l}
              className={styles.labelChipSmall}
              style={{ background: (labelMap[l] ?? '#6b7280') + '22', color: labelMap[l] ?? '#6b7280', borderColor: (labelMap[l] ?? '#6b7280') + '55' }}
            >
              {l}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

export default function Conversations() {
  const { agent } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [labelFilter, setLabelFilter] = useState(null);
  const [search, setSearch] = useState('');
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewingAs, setViewingAs] = useState(() => agent?.id ?? 'sofia');
  const [allLabels, setAllLabels] = useState([]);
  const [labelDropOpen, setLabelDropOpen] = useState(false);
  const [quickReplies, setQuickReplies] = useState([]);
  const [qrOpen, setQrOpen] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [showNewConvModal, setShowNewConvModal] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState(null);
  const [newParams, setNewParams] = useState([]);
  const [newConvSaving, setNewConvSaving] = useState(false);
  const [newConvError, setNewConvError] = useState('');
  const messagesEndRef = useRef(null);
  const pollConvRef = useRef(null);
  const pollMsgRef = useRef(null);
  const selectedIdRef = useRef(null);

  const labelMap = Object.fromEntries(allLabels.map(l => [l.name, l.color]));

  useNotifications(conversations);

  useEffect(() => {
    loadConversations();
    loadAllLabels();
    loadQuickReplies();
    pollConvRef.current = setInterval(loadConversations, 10000);
    return () => clearInterval(pollConvRef.current);
  }, []);

  useEffect(() => {
    clearInterval(pollMsgRef.current);
    if (!selected) { setMessages([]); setCustomer(null); return; }
    selectedIdRef.current = selected.id;
    loadMessages(selected.id);
    loadCustomer(selected.id);
    markRead(selected.id);
    setLabelDropOpen(false);
    setQrOpen(false);
    pollMsgRef.current = setInterval(() => loadMessages(selectedIdRef.current), 5000);
    return () => clearInterval(pollMsgRef.current);
  }, [selected?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadAllLabels() {
    try {
      const r = await authFetch(BASE_URL + '/api/labels');
      if (r.ok) setAllLabels(await r.json());
    } catch { /* ignore */ }
  }

  async function loadQuickReplies() {
    try {
      const r = await authFetch(BASE_URL + '/api/quick-replies');
      if (r.ok) setQuickReplies(await r.json());
    } catch { /* ignore */ }
  }

  async function loadTemplates() {
    try {
      const r = await authFetch(BASE_URL + '/api/templates');
      if (r.ok) setTemplates(await r.json());
    } catch { /* ignore */ }
  }

  function openNewConvModal() {
    setNewPhone(''); setNewName(''); setNewTemplate(null); setNewParams([]); setNewConvError('');
    if (templates.length === 0) loadTemplates();
    setShowNewConvModal(true);
  }

  function selectTemplate(tpl) {
    setNewTemplate(tpl);
    setNewParams(Array.isArray(tpl?.params) ? tpl.params.map(() => '') : []);
  }

  async function handleStartConversation(e) {
    e.preventDefault();
    if (!newPhone.trim() || !newTemplate) return;
    setNewConvSaving(true); setNewConvError('');
    try {
      const r = await authFetch(BASE_URL + '/api/conversations/start', {
        method: 'POST',
        body: { phone: newPhone.trim(), contactName: newName.trim() || null, templateName: newTemplate.name, language: newTemplate.language, params: newParams },
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const conv = await r.json();
      setShowNewConvModal(false);
      await loadConversations();
      setSelected(conv);
    } catch (err) {
      setNewConvError(err.message);
    } finally {
      setNewConvSaving(false);
    }
  }

  async function loadConversations() {
    try {
      const res = await authFetch(BASE_URL + '/api/conversations');
      const data = await res.json();
      const list = data.conversations ?? [];
      setConversations(list);
      setSelected(prev => {
        if (!prev) return prev;
        return list.find(c => c.id === prev.id) ?? prev;
      });
    } finally {
      setLoading(false);
    }
  }

  async function loadMessages(contactId) {
    try {
      const res = await authFetch(`/api/conversations/${contactId}/messages`);
      const data = await res.json();
      setMessages(data.messages ?? []);
    } catch { setMessages([]); }
  }

  async function loadCustomer(contactId) {
    try {
      const res = await authFetch(`/api/customers/${contactId}`);
      if (!res.ok) { setCustomer(null); return; }
      const data = await res.json();
      setCustomer(data.customer ?? null);
      setNotes(data.customer?.agentNotes ?? '');
    } catch { setCustomer(null); }
  }

  async function markRead(contactId) {
    await authFetch(`/api/conversations/${contactId}/read`, { method: 'POST' }).catch(() => {});
    setConversations(prev => prev.map(c => c.id === contactId ? { ...c, unread: 0 } : c));
  }

  async function saveNotes() {
    if (!selected || savingNotes) return;
    setSavingNotes(true);
    try {
      await authFetch(`/api/customers/${selected.id}/notes`, {
        method: 'PATCH',
        body: { notes },
      });
    } finally { setSavingNotes(false); }
  }

  async function syncCustomer() {
    if (!selected || syncing) return;
    setSyncing(true);
    try {
      const res = await authFetch(`/api/customers/${selected.id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.customer) { setCustomer(data.customer); setNotes(data.customer.agentNotes ?? ''); }
    } finally { setSyncing(false); }
  }

  async function updateStatus(status) {
    if (!selected || updating) return;
    setUpdating(true);
    try {
      const res = await authFetch(`/api/conversations/${selected.id}/status`, {
        method: 'PATCH',
        body: { status },
      });
      if (res.ok) {
        const patch = { status };
        setSelected(prev => ({ ...prev, ...patch }));
        setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, ...patch } : c));
      }
    } finally { setUpdating(false); }
  }

  async function toggleHumanMode() {
    if (!selected || updating) return;
    const humanMode = !selected.humanMode;
    setUpdating(true);
    try {
      const res = await authFetch(`/api/conversations/${selected.id}/mode`, {
        method: 'PATCH',
        body: { humanMode },
      });
      if (res.ok) {
        setSelected(prev => ({ ...prev, humanMode }));
        setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, humanMode } : c));
      }
    } finally { setUpdating(false); }
  }

  async function assignTo(agentId) {
    if (!selected || updating) return;
    setUpdating(true);
    try {
      const assignedTo = selected.assignedTo === agentId ? null : agentId;
      const res = await authFetch(`/api/conversations/${selected.id}/assign`, {
        method: 'PATCH',
        body: { assignedTo },
      });
      if (res.ok) {
        setSelected(prev => ({ ...prev, assignedTo }));
        setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, assignedTo } : c));
      }
    } finally { setUpdating(false); }
  }

  async function addLabel(label) {
    if (!selected) return;
    setLabelDropOpen(false);
    if (selected.labels?.includes(label)) return;
    await authFetch(`/api/labels/conversations/${selected.id}`, {
      method: 'PATCH',
      body: { action: 'add', label },
    });
    const updated = [...(selected.labels ?? []), label];
    setSelected(prev => ({ ...prev, labels: updated }));
    setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, labels: updated } : c));
  }

  async function removeLabel(label) {
    if (!selected) return;
    await authFetch(`/api/labels/conversations/${selected.id}`, {
      method: 'PATCH',
      body: { action: 'remove', label },
    });
    const updated = (selected.labels ?? []).filter(l => l !== label);
    setSelected(prev => ({ ...prev, labels: updated }));
    setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, labels: updated } : c));
  }

  async function sendReply(e) {
    e.preventDefault();
    if (!reply.trim() || !selected || sending) return;
    setSending(true);
    try {
      const res = await authFetch(`/api/conversations/${selected.id}/reply`, {
        method: 'POST',
        body: { message: reply.trim() },
      });
      if (res.ok) { setReply(''); await loadMessages(selected.id); }
    } finally { setSending(false); }
  }

  const filtered = conversations.filter(c => {
    if (filter === 'mine') {
      if (c.assignedTo !== viewingAs) return false;
    } else if (filter !== 'all') {
      if ((c.status || 'bot') !== filter) return false;
    }
    if (labelFilter && !(c.labels ?? []).includes(labelFilter)) return false;
    if (search) {
      const q = search.toLowerCase();
      const name = (c.contactName || c.contactId || '').toLowerCase();
      if (!name.includes(q)) return false;
    }
    return true;
  });

  const isHuman = selected?.humanMode;
  const currentStatus = selected?.status || 'bot';
  const availableToAdd = allLabels.filter(l => !(selected?.labels ?? []).includes(l.name));

  const slashMatch = reply.match(/^\/(\w*)$/);
  const slashSuggestions = slashMatch
    ? quickReplies.filter(qr => (qr.shortcut ?? '').startsWith(slashMatch[1]))
    : [];

  return (
    <div className={styles.page}>
      {/* ---- Sidebar ---- */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTop}>
            <h1 className={styles.sidebarTitle}>Conversaciones</h1>
            <button className={styles.newConvBtn} onClick={openNewConvModal} title="Nueva conversación">＋</button>
          </div>
          <div className={styles.viewingAs}>
            {AGENTS.map(a => (
              <button
                key={a.id}
                className={`${styles.agentToggle} ${viewingAs === a.id ? styles.agentToggleActive : ''}`}
                onClick={() => setViewingAs(a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
          <input
            className={styles.searchInput}
            type="search"
            placeholder="Buscar contacto..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className={styles.chips}>
            {FILTERS.map(f => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`${styles.filterChip} ${filter === f.value ? styles.filterChipActive : ''}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {allLabels.length > 0 && (
            <select
              className={styles.labelSelect}
              value={labelFilter ?? ''}
              onChange={e => setLabelFilter(e.target.value || null)}
            >
              <option value="">Todas las etiquetas</option>
              {allLabels.map(l => (
                <option key={l.id} value={l.name}>{l.name}</option>
              ))}
            </select>
          )}
        </div>

        <div className={styles.convList}>
          {loading ? (
            <p className={styles.empty}>Cargando...</p>
          ) : filtered.length === 0 ? (
            <p className={styles.empty}>Sin resultados.</p>
          ) : (
            filtered.map(c => (
              <ConvItem
                key={c.id}
                conv={c}
                active={selected?.id === c.id}
                onClick={() => setSelected(c)}
                labelMap={labelMap}
              />
            ))
          )}
        </div>
      </aside>

      {/* ---- Thread ---- */}
      <main className={styles.thread}>
        {!selected ? (
          <div className={styles.threadEmpty}>
            <div className={styles.threadEmptyIcon}>💬</div>
            <p>Seleccioná una conversación</p>
          </div>
        ) : (
          <>
            <div className={styles.threadHeader}>
              {/* Row 1: name + primary actions */}
              <div className={styles.threadHeaderTop}>
                <span className={styles.threadName}>{selected.contactName || selected.contactId}</span>
                <div className={styles.threadActions}>
                  {currentStatus !== 'urgent' && (
                    <button className={`${styles.actionBtn} ${styles.actionUrgent}`} onClick={() => updateStatus('urgent')} disabled={updating}>
                      Urgente
                    </button>
                  )}
                  {currentStatus !== 'resolved' ? (
                    <button className={`${styles.actionBtn} ${styles.actionResolve}`} onClick={() => updateStatus('resolved')} disabled={updating}>
                      Resolver
                    </button>
                  ) : (
                    <button className={`${styles.actionBtn} ${styles.actionReopen}`} onClick={() => updateStatus('bot')} disabled={updating}>
                      Reabrir
                    </button>
                  )}
                  <button
                    className={`${styles.modeBtn} ${isHuman ? styles.modeBtnHuman : ''}`}
                    onClick={toggleHumanMode}
                    disabled={updating}
                  >
                    {isHuman ? '🤖 Activar bot' : '👤 Tomar control'}
                  </button>
                </div>
              </div>

              {/* Row 2: badges + assign + labels */}
              <div className={styles.threadHeaderBottom}>
                <div className={styles.threadHeaderBadges}>
                  <ChannelBadge channel={selected.channel} />
                  <StatusChip status={currentStatus} />
                  {selected.assignedTo && <AgentBadge assignedTo={selected.assignedTo} />}
                </div>
                {AGENTS.map(a => (
                  <button
                    key={a.id}
                    className={`${styles.assignBtn} ${selected.assignedTo === a.id ? styles.assignBtnActive : ''}`}
                    onClick={() => assignTo(a.id)}
                    disabled={updating}
                    title={selected.assignedTo === a.id ? `Quitar de ${a.label}` : `Asignar a ${a.label}`}
                  >
                    {selected.assignedTo === a.id ? `✓ ${a.label}` : `→ ${a.label}`}
                  </button>
                ))}
                <div className={styles.labelsRow}>
                  {(selected.labels ?? []).map(l => (
                    <LabelChip key={l} label={l} labelMap={labelMap} onRemove={removeLabel} />
                  ))}
                  <div className={styles.labelAddWrap}>
                    <button
                      className={styles.labelAddBtn}
                      onClick={() => setLabelDropOpen(v => !v)}
                      title="Agregar etiqueta"
                    >
                      + Etiqueta
                    </button>
                    {labelDropOpen && availableToAdd.length > 0 && (
                      <div className={styles.labelDropdown}>
                        {availableToAdd.map(l => (
                          <button
                            key={l.id}
                            className={styles.labelDropItem}
                            onClick={() => addLabel(l.name)}
                          >
                            <span className={styles.labelDropDot} style={{ background: l.color }} />
                            {l.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {labelDropOpen && availableToAdd.length === 0 && (
                      <div className={styles.labelDropdown}>
                        <span className={styles.labelDropEmpty}>Sin etiquetas disponibles</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.messages}>
              {messages.length === 0 ? (
                <p className={styles.noMessages}>Sin mensajes aún.</p>
              ) : (
                messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)
              )}
              <div ref={messagesEndRef} />
            </div>

            {isHuman ? (
              <form className={styles.replyForm} onSubmit={sendReply}>
                <div className={styles.replyHumanBadge}>
                  Modo agente activo — Gina no responde · Respondiendo como <strong>{AGENTS.find(a => a.id === viewingAs)?.label}</strong>
                </div>
                <div className={styles.replyRow}>
                  <div className={styles.replyInputWrap}>
                    {slashSuggestions.length > 0 && (
                      <div className={styles.slashDropdown}>
                        {slashSuggestions.map(qr => (
                          <button
                            type="button"
                            key={qr.id}
                            className={styles.slashDropItem}
                            onClick={() => setReply(qr.text)}
                          >
                            <span className={styles.slashDropShortcut}>/{qr.shortcut}</span>
                            <span className={styles.slashDropTitle}>{qr.title || qr.shortcut}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <textarea
                      className={styles.replyInput}
                      rows={2}
                      placeholder="Escribí tu respuesta... (Enter para enviar)"
                      value={reply}
                      onChange={e => setReply(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(e); } }}
                      disabled={sending}
                    />
                    {quickReplies.length > 0 && (
                      <div className={styles.qrWrap}>
                        <button
                          type="button"
                          className={styles.qrBtn}
                          onClick={() => setQrOpen(v => !v)}
                          title="Respuestas rápidas"
                        >
                          ⚡
                        </button>
                        {qrOpen && (
                          <div className={styles.qrDropdown}>
                            {quickReplies.map(qr => (
                              <button
                                type="button"
                                key={qr.id}
                                className={styles.qrDropItem}
                                onClick={() => { setReply(qr.text); setQrOpen(false); }}
                              >
                                <span className={styles.qrDropTitle}>
                                  {qr.shortcut && <code className={styles.qrDropShortcut}>/{qr.shortcut}</code>}
                                  {qr.title || qr.shortcut}
                                </span>
                                <span className={styles.qrDropText}>{qr.text}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <button type="submit" className={styles.replyBtn} disabled={sending || !reply.trim()}>
                    {sending ? '...' : 'Enviar'}
                  </button>
                </div>
              </form>
            ) : (
              <div className={styles.botFooter}>
                <span className={styles.botFooterDot} />
                <span className={styles.botFooterText}>Gina está respondiendo automáticamente</span>
              </div>
            )}
          </>
        )}
      </main>

      {/* ---- Profile Panel ---- */}
      {selected && (
        <aside className={styles.profilePanel}>
          <div className={styles.profileHeader}>
            <span className={styles.profileTitle}>Perfil del cliente</span>
            <button className={styles.syncBtn} onClick={syncCustomer} disabled={syncing} title="Sincronizar con Tienda Nube">
              {syncing ? '...' : '↻ TN'}
            </button>
          </div>

          {customer ? (
            <>
              <div className={styles.profileSection}>
                {customer.contactName && (
                  <div className={styles.profileRow}>
                    <span className={styles.profileKey}>Nombre</span>
                    <span className={styles.profileVal}>{customer.contactName}</span>
                  </div>
                )}
                {customer.tnEmail && (
                  <div className={styles.profileRow}>
                    <span className={styles.profileKey}>Email</span>
                    <span className={styles.profileVal}>{customer.tnEmail}</span>
                  </div>
                )}
                <div className={styles.profileRow}>
                  <span className={styles.profileKey}>Canal</span>
                  <span className={styles.profileVal}>{customer.channel}</span>
                </div>
                {customer.firstContactAt && (
                  <div className={styles.profileRow}>
                    <span className={styles.profileKey}>1er contacto</span>
                    <span className={styles.profileVal}>{formatDate(customer.firstContactAt)}</span>
                  </div>
                )}
                {customer.tnCustomerId && (
                  <div className={styles.profileRow}>
                    <span className={styles.profileKey}>ID Tienda Nube</span>
                    <span className={styles.profileVal}>#{customer.tnCustomerId}</span>
                  </div>
                )}
              </div>

              {customer.tnOrders?.length > 0 ? (
                <div className={styles.profileSection}>
                  <div className={styles.profileSectionTitle}>Compras ({customer.tnOrders.length})</div>
                  {customer.tnOrders.map(o => (
                    <div key={o.number} className={styles.orderCard}>
                      <div className={styles.orderTop}>
                        <span className={styles.orderNum}>Pedido #{o.number}</span>
                        <span className={styles.orderTotal}>${o.total}</span>
                      </div>
                      <div className={styles.orderMeta}>
                        <span>{o.date ?? '?'}</span>
                        <span className={styles.orderStatus}>{o.status}</span>
                      </div>
                      {o.products?.length > 0 && (
                        <div className={styles.orderProducts}>{o.products.join(', ')}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.profileSection}>
                  <div className={styles.profileSectionTitle}>Compras</div>
                  <p className={styles.profileEmpty}>Sin historial en Tienda Nube</p>
                </div>
              )}

              <div className={styles.profileSection}>
                <div className={styles.profileSectionTitle}>Notas del equipo</div>
                <textarea
                  className={styles.notesInput}
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Anotaciones internas sobre este cliente..."
                  rows={4}
                />
                <button className={styles.saveNotesBtn} onClick={saveNotes} disabled={savingNotes}>
                  {savingNotes ? 'Guardando...' : 'Guardar notas'}
                </button>
              </div>
            </>
          ) : (
            <p className={styles.profileEmpty}>Sin perfil aún.</p>
          )}
        </aside>
      )}

      {/* ---- Nueva Conversación Modal ---- */}
      {showNewConvModal && (
        <div className={styles.newConvOverlay} onClick={e => e.target === e.currentTarget && setShowNewConvModal(false)}>
          <div className={styles.newConvModal}>
            <div className={styles.newConvModalHeader}>
              <span className={styles.newConvModalTitle}>Nueva conversación</span>
              <button className={styles.newConvCloseBtn} onClick={() => setShowNewConvModal(false)}>×</button>
            </div>
            <form className={styles.newConvForm} onSubmit={handleStartConversation}>
              <div className={styles.newConvRow}>
                <div className={styles.newConvField}>
                  <label className={styles.newConvLabel}>Teléfono *</label>
                  <input
                    className={styles.newConvInput}
                    type="tel"
                    placeholder="ej: 5491112345678"
                    value={newPhone}
                    onChange={e => setNewPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 15))}
                    autoFocus
                  />
                </div>
                <div className={styles.newConvField}>
                  <label className={styles.newConvLabel}>Nombre del contacto</label>
                  <input
                    className={styles.newConvInput}
                    type="text"
                    placeholder="ej: María García"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    maxLength={60}
                  />
                </div>
              </div>
              <div className={styles.newConvField}>
                <label className={styles.newConvLabel}>Plantilla *</label>
                {templates.length === 0 ? (
                  <p className={styles.newConvHint}>Sin plantillas. Creá una en /templates primero.</p>
                ) : (
                  <select
                    className={styles.newConvSelect}
                    value={newTemplate?.id ?? ''}
                    onChange={e => selectTemplate(templates.find(t => t.id === e.target.value) ?? null)}
                  >
                    <option value="">Seleccionar plantilla...</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.displayName} ({t.name})</option>
                    ))}
                  </select>
                )}
              </div>
              {newTemplate && (
                <div className={styles.newConvPreview}>
                  <span className={styles.newConvPreviewText}>{newTemplate.bodyText}</span>
                </div>
              )}
              {newTemplate?.params?.length > 0 && (
                <div className={styles.newConvParamsGroup}>
                  <label className={styles.newConvLabel}>Parámetros de la plantilla</label>
                  {newTemplate.params.map((desc, i) => (
                    <div key={i} className={styles.newConvParamRow}>
                      <span className={styles.newConvParamLabel}>{`{{${i + 1}}}`} {desc}</span>
                      <input
                        className={styles.newConvInput}
                        type="text"
                        placeholder={desc}
                        value={newParams[i] ?? ''}
                        onChange={e => setNewParams(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                      />
                    </div>
                  ))}
                </div>
              )}
              {newConvError && <p className={styles.newConvError}>{newConvError}</p>}
              <div className={styles.newConvFooter}>
                <button type="button" className={styles.newConvCancelBtn} onClick={() => setShowNewConvModal(false)}>Cancelar</button>
                <button
                  className={styles.newConvSubmitBtn}
                  type="submit"
                  disabled={newConvSaving || !newPhone.trim() || !newTemplate}
                >
                  {newConvSaving ? 'Enviando...' : 'Iniciar conversación'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
