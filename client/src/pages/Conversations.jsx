import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authFetch, BASE_URL } from '../lib/api';
import { useNotifications } from '../hooks/useNotifications.js';
import styles from './Conversations.module.css';


const STATUS_CONFIG = {
  bot:          { label: 'Bot activo',    cls: 'bot' },
  escalated:    { label: 'Con agente',    cls: 'escalated' },
  bot_archived: { label: 'Archivado Bot', cls: 'bot_archived' },
  resolved:     { label: 'Cerrado',       cls: 'resolved' },
  // Legacy
  urgent:       { label: 'Urgente',       cls: 'urgent' },
  waiting:      { label: 'En espera',     cls: 'waiting' },
};

const CHANNEL_CONFIG = {
  whatsapp:  { label: 'WhatsApp', cls: 'wpp' },
  instagram: { label: 'Instagram', cls: 'ig' },
};

const FILTERS = [
  { value: 'bot',      label: 'Bot' },
  { value: 'mine',     label: 'Mis casos' },
  { value: 'urgent',   label: 'Urgentes' },
  { value: 'archived', label: 'Archivos' },
  { value: 'teams',    label: 'Equipos',  minRole: 'atencion_cliente' },
];

function StatusChip({ status }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, cls: 'bot' };
  return <span className={`${styles.chip} ${styles['chip_' + cfg.cls]}`}>{cfg.label}</span>;
}

function ChannelBadge({ channel }) {
  const cfg = CHANNEL_CONFIG[channel] ?? { label: channel, cls: 'wpp' };
  return <span className={`${styles.badge} ${styles['badge_' + cfg.cls]}`}>{cfg.label}</span>;
}

function AgentBadge({ assignedTo, nameMap = {} }) {
  if (!assignedTo) return null;
  return <span className={styles.agentBadge}>{nameMap[assignedTo] ?? assignedTo}</span>;
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

function tsToDate(ts) {
  if (!ts) return null;
  const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
  return isNaN(d) ? null : d;
}

function formatAge(ts) {
  const d = tsToDate(ts);
  if (!d) return '';
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
  const d = tsToDate(ts);
  if (!d) return '';
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  const d = tsToDate(ts);
  if (!d) return '';
  return d.toLocaleDateString('es-AR');
}

function hoursAgo(ts) {
  const d = tsToDate(ts);
  if (!d) return 0;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

// Delivery status icon for agent messages
function MsgStatusIcon({ msgStatus }) {
  if (!msgStatus || msgStatus === 'sent') return <span className={styles.msgStatus}>✓</span>;
  if (msgStatus === 'sending') return <span className={styles.msgStatus}>⏳</span>;
  if (msgStatus === 'delivered') return <span className={styles.msgStatus}>✓✓</span>;
  if (msgStatus === 'read') return <span className={`${styles.msgStatus}`} style={{ color: '#3b82f6' }}>✓✓</span>;
  if (msgStatus === 'error') return <span className={`${styles.msgStatus} ${styles.msgStatusError}`}>✗ No enviado</span>;
  return null;
}

function MessageBubble({ msg, onRetry }) {
  const isUser = msg.role === 'user';
  const isAdmin = msg.role === 'admin';
  const token = localStorage.getItem('gineza_token');
  const mediaProxyUrl = msg.mediaId
    ? `${BASE_URL}/api/conversations/media/${msg.mediaId}?token=${encodeURIComponent(token ?? '')}`
    : null;
  const isError = isAdmin && msg.msgStatus === 'error';

  return (
    <div className={`${styles.msg} ${isUser ? styles.msgUser : isAdmin ? styles.msgAdmin : styles.msgBot}`}>
      <div className={`${styles.msgBubble} ${isError ? styles.msgBubbleError : ''}`}>
        {msg.mediaType === 'image' && mediaProxyUrl && (
          <img src={mediaProxyUrl} className={styles.msgMedia} alt="Imagen" loading="lazy" />
        )}
        {msg.mediaType === 'audio' && mediaProxyUrl && (
          <audio controls src={mediaProxyUrl} className={styles.msgAudio} />
        )}
        {msg.mediaType === 'video' && mediaProxyUrl && (
          <video controls src={mediaProxyUrl} className={styles.msgVideo} />
        )}
        {msg.content && <span>{msg.content}</span>}
        {onRetry && (
          <button type="button" className={styles.retryBtn} onClick={() => onRetry(msg.content)}>
            ↩ Reenviar
          </button>
        )}
      </div>
      <span className={styles.msgMeta}>
        {isUser ? 'Cliente' : isAdmin ? 'Agente' : 'Gina'}
        {msg.timestamp ? ` · ${formatTime(msg.timestamp)}` : ''}
        {isAdmin && <MsgStatusIcon msgStatus={msg.msgStatus} />}
      </span>
    </div>
  );
}

function ConvItem({ conv, active, onClick, labelMap }) {
  const isUrgent = conv.urgent;
  const isInsistent = (conv.consecutiveClientMessages ?? 0) >= 3;
  const isWaiting = (conv.consecutiveClientMessages ?? 0) > 0 && conv.lastClientMessageAt;

  return (
    <button
      className={`${styles.item} ${active ? styles.itemActive : ''}`}
      onClick={onClick}
    >
      <div className={styles.itemTop}>
        <span className={styles.itemName}>{conv.contactName || conv.contactId}</span>
        <div className={styles.itemTopRight}>
          <div className={styles.itemIndicators}>
            {isUrgent && <span className={styles.urgentFlagBadge} title="Urgente">⚡</span>}
            {isInsistent && <span className={styles.insistentBadge} title="Cliente insistente — escribió varias veces sin respuesta">⚠</span>}
            {isWaiting && <span className={styles.waitTimeBadge} title="Tiempo esperando respuesta">⏳{formatAge(conv.lastClientMessageAt)}</span>}
          </div>
          {conv.updatedAt && <span className={styles.itemAge}>{formatAge(conv.updatedAt)}</span>}
          {conv.unread > 0 && <span className={styles.itemUnread}>{conv.unread}</span>}
        </div>
      </div>
      <div className={styles.itemBottom}>
        <StatusChip status={conv.status || 'bot'} />
        <ChannelBadge channel={conv.channel} />
        <AgentBadge assignedTo={conv.assignedTo} nameMap={nameMap} />
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
  const [filter, setFilter] = useState('bot');
  const [labelFilter, setLabelFilter] = useState(null);
  const [search, setSearch] = useState('');
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [loading, setLoading] = useState(true);
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
  const [summary, setSummary] = useState(null);
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [nameMap, setNameMap] = useState({});
  const [teamsDeptFilter, setTeamsDeptFilter] = useState('');
  const [apiWindowError, setApiWindowError] = useState(false);
  const [templateSendOpen, setTemplateSendOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [templateParams, setTemplateParams] = useState([]);
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const [templateSendError, setTemplateSendError] = useState('');
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const atBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const pollConvRef = useRef(null);
  const pollMsgRef = useRef(null);
  const selectedIdRef = useRef(null);
  const mediaInputRef = useRef(null);

  const labelMap = Object.fromEntries(allLabels.map(l => [l.name, l.color]));
  const myId = agent?.id;

  useNotifications(conversations);

  useEffect(() => {
    loadConversations();
    loadAllLabels();
    loadQuickReplies();
    // Load departments + agents for name resolution
    Promise.all([
      authFetch(BASE_URL + '/api/departments').then(r => r.ok ? r.json() : { departments: [] }),
      authFetch(BASE_URL + '/api/auth/users').then(r => r.ok ? r.json() : []),
    ]).then(([deptsData, agents]) => {
      const depts = deptsData.departments ?? [];
      setDepartments(depts);
      const map = {};
      for (const d of depts) map[d.id] = d.name;
      for (const a of agents) { map[a.email] = a.name; map[a.id] = a.name; }
      setNameMap(map);
    });
    pollConvRef.current = setInterval(loadConversations, 10000);
    return () => clearInterval(pollConvRef.current);
  }, []);

  useEffect(() => {
    clearInterval(pollMsgRef.current);
    if (!selected) { setMessages([]); setCustomer(null); setSummary(null); return; }
    selectedIdRef.current = selected.id;
    atBottomRef.current = true;
    prevMsgCountRef.current = 0;
    loadMessages(selected.id);
    loadCustomer(selected.id);
    loadSummary(selected.id);
    markRead(selected.id);
    setLabelDropOpen(false);
    setQrOpen(false);
    // Reset window state when switching conversations
    setApiWindowError(false);
    setTemplateSendOpen(false);
    setSelectedTemplate(null);
    setTemplateParams([]);
    setTemplateSendError('');
    pollMsgRef.current = setInterval(() => loadMessages(selectedIdRef.current), 5000);
    return () => clearInterval(pollMsgRef.current);
  }, [selected?.id]);

  useEffect(() => {
    const newLen = messages.length;
    const hadMore = newLen > prevMsgCountRef.current;
    prevMsgCountRef.current = newLen;
    if (hadMore && atBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  function handleMessagesScroll() {
    const el = messagesContainerRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }

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
        body: {
          phone: newPhone.trim(),
          contactName: newName.trim() || null,
          templateName: newTemplate.name,
          language: newTemplate.language,
          params: newParams,
          createdBy: myId,
        },
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const conv = await r.json();
      setShowNewConvModal(false);
      await loadConversations();
      setSelected(conv);
      setFilter('mine');
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
      const res = await authFetch(BASE_URL + `/api/conversations/${contactId}/messages`);
      const data = await res.json();
      setMessages(data.messages ?? []);
    } catch { setMessages([]); }
  }

  async function loadCustomer(contactId) {
    try {
      const res = await authFetch(BASE_URL + `/api/customers/${contactId}`);
      if (!res.ok) { setCustomer(null); return; }
      const data = await res.json();
      setCustomer(data.customer ?? null);
      setNotes(data.customer?.agentNotes ?? '');
    } catch { setCustomer(null); }
  }

  async function loadSummary(contactId) {
    try {
      const r = await authFetch(BASE_URL + `/api/conversations/${contactId}/summary`);
      if (r.ok) { const d = await r.json(); setSummary(d.summary ?? null); }
      else setSummary(null);
    } catch { setSummary(null); }
  }

  async function generateSummary() {
    if (!selected || summaryGenerating) return;
    setSummaryGenerating(true);
    try {
      const r = await authFetch(BASE_URL + `/api/conversations/${selected.id}/summary`, { method: 'POST' });
      if (r.ok) { const d = await r.json(); setSummary(d.summary ?? null); }
    } finally { setSummaryGenerating(false); }
  }

  async function markRead(contactId) {
    await authFetch(BASE_URL + `/api/conversations/${contactId}/read`, { method: 'POST' }).catch(() => {});
    setConversations(prev => prev.map(c => c.id === contactId ? { ...c, unread: 0 } : c));
  }

  async function saveNotes() {
    if (!selected || savingNotes) return;
    setSavingNotes(true);
    try {
      await authFetch(BASE_URL + `/api/customers/${selected.id}/notes`, {
        method: 'PATCH',
        body: { notes },
      });
    } finally { setSavingNotes(false); }
  }

  async function syncCustomer() {
    if (!selected || syncing) return;
    setSyncing(true);
    try {
      const res = await authFetch(BASE_URL + `/api/customers/${selected.id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.customer) { setCustomer(data.customer); setNotes(data.customer.agentNotes ?? ''); }
    } finally { setSyncing(false); }
  }

  // dispatch supports extra body params (e.g. agentId for take_over)
  async function dispatch(action, extra = {}) {
    if (!selected || updating) return;
    setUpdating(true);
    try {
      const r = await authFetch(BASE_URL + `/api/conversations/${selected.id}/dispatch`, {
        method: 'PATCH',
        body: { action, ...extra },
      });
      if (r.ok) {
        const data = await r.json();
        const patch = {};
        if (data.status !== undefined)    patch.status = data.status;
        if (data.humanMode !== undefined)  patch.humanMode = data.humanMode;
        if (data.assignedTo !== undefined) patch.assignedTo = data.assignedTo;
        if (data.urgent !== undefined)     patch.urgent = data.urgent;
        setSelected(prev => ({ ...prev, ...patch }));
        setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, ...patch } : c));
      }
    } finally { setUpdating(false); }
  }

  async function addLabel(label) {
    if (!selected) return;
    setLabelDropOpen(false);
    if (selected.labels?.includes(label)) return;
    await authFetch(BASE_URL + `/api/labels/conversations/${selected.id}`, {
      method: 'PATCH',
      body: { action: 'add', label },
    });
    const updated = [...(selected.labels ?? []), label];
    setSelected(prev => ({ ...prev, labels: updated }));
    setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, labels: updated } : c));
  }

  async function removeLabel(label) {
    if (!selected) return;
    await authFetch(BASE_URL + `/api/labels/conversations/${selected.id}`, {
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
    const text = reply.trim();
    setReply('');
    try {
      const res = await authFetch(BASE_URL + `/api/conversations/${selected.id}/reply`, {
        method: 'POST',
        body: { message: text },
      });
      await loadMessages(selected.id);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.windowExpired) {
          setApiWindowError(true);
          if (templates.length === 0) loadTemplates();
        } else {
          alert(`⚠️ Mensaje guardado en el panel pero NO llegó al cliente.\n${data.error ?? 'Error desconocido'}`);
        }
      }
    } finally { setSending(false); }
  }

  async function handleRetry(text) {
    if (!selected || sending) return;
    setSending(true);
    try {
      const res = await authFetch(BASE_URL + `/api/conversations/${selected.id}/reply`, {
        method: 'POST',
        body: { message: text },
      });
      await loadMessages(selected.id);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.windowExpired) {
          setApiWindowError(true);
          if (templates.length === 0) loadTemplates();
        } else {
          alert(`⚠️ Reenvío fallido: ${data.error ?? 'Error desconocido'}`);
        }
      }
    } finally { setSending(false); }
  }

  async function sendTemplate() {
    if (!selected || !selectedTemplate || sendingTemplate) return;
    setSendingTemplate(true);
    setTemplateSendError('');
    try {
      const res = await authFetch(BASE_URL + `/api/conversations/${selected.id}/send-template`, {
        method: 'POST',
        body: { templateName: selectedTemplate.name, language: selectedTemplate.language, params: templateParams },
      });
      await loadMessages(selected.id);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTemplateSendError(data.error ?? 'Error enviando plantilla');
      } else {
        setTemplateSendOpen(false);
        setSelectedTemplate(null);
        setTemplateParams([]);
        setTemplateSendError('');
        // Don't clear apiWindowError yet — window only reopens when client replies
      }
    } finally {
      setSendingTemplate(false);
    }
  }

  function openTemplatePanel() {
    if (templates.length === 0) loadTemplates();
    setTemplateSendOpen(true);
    setSelectedTemplate(null);
    setTemplateParams([]);
    setTemplateSendError('');
  }

  function pickTemplate(id) {
    const tpl = templates.find(t => t.id === id) ?? null;
    setSelectedTemplate(tpl);
    setTemplateParams(tpl?.params?.map(() => '') ?? []);
  }

  async function handleMediaSelect(e) {
    const file = e.target.files?.[0];
    if (!file || !selected) return;
    e.target.value = '';
    setSending(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await authFetch(BASE_URL + `/api/conversations/${selected.id}/media`, {
        method: 'POST',
        body: form,
      });
      await loadMessages(selected.id);
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert(`⚠️ ${data.error ?? 'Error enviando archivo'}`);
      }
    } finally { setSending(false); }
  }

  const isHuman = selected?.humanMode;
  const currentStatus = selected?.status || 'bot';
  const isArchived = currentStatus === 'bot_archived' || currentStatus === 'resolved';
  const isUrgentFlag = selected?.urgent === true;
  const availableToAdd = allLabels.filter(l => !(selected?.labels ?? []).includes(l.name));

  const slashMatch = reply.match(/^\/(\w*)$/);
  const slashSuggestions = slashMatch
    ? quickReplies.filter(qr => (qr.shortcut ?? '').startsWith(slashMatch[1]))
    : [];

  // 24h WhatsApp window detection
  const lastClientHours = selected?.lastClientMessageAt
    ? hoursAgo(selected.lastClientMessageAt)
    : null;
  // Computed: client hasn't written in >24h (window likely expired)
  const computedWindowExpired = isHuman && lastClientHours !== null && lastClientHours > 24;
  // Combined: either computed from timestamp OR detected from API error response
  const isWindowExpired = computedWindowExpired || apiWindowError;
  // Warning shown when window is approaching (>20h) but not yet expired
  const windowApproaching = isHuman && lastClientHours !== null && lastClientHours > 20 && !isWindowExpired;
  // Clear apiWindowError when the window re-opens (client responds and lastClientHours resets)
  if (apiWindowError && !computedWindowExpired && lastClientHours !== null && lastClientHours < 1) {
    setApiWindowError(false);
  }

  const approvedTemplates = templates.filter(t => t.metaStatus === 'APPROVED');

  const filtered = conversations.filter(c => {
    const status = c.status || 'bot';
    const isConvArchived = status === 'bot_archived' || status === 'resolved';
    const convUrgent = c.urgent === true;
    const convHuman = c.humanMode === true;

    if (filter === 'bot') {
      if (isConvArchived) return false;
      if (convHuman) return false;
      if (status !== 'bot') return false;
    } else if (filter === 'mine') {
      if (isConvArchived) return false;
      if (!convHuman || c.assignedTo !== myId) return false;
    } else if (filter === 'urgent') {
      if (isConvArchived) return false;
      if (!convUrgent) return false;
    } else if (filter === 'teams') {
      if (isConvArchived) return false;
      if (!convHuman) return false;
      if (teamsDeptFilter && c.assignedTo !== teamsDeptFilter) return false;
    } else if (filter === 'all') {
      if (isConvArchived) return false;
    } else if (filter === 'archived') {
      if (!isConvArchived) return false;
    }

    if (labelFilter && !(c.labels ?? []).includes(labelFilter)) return false;
    if (search) {
      const q = search.toLowerCase();
      const name = (c.contactName || c.contactId || '').toLowerCase();
      if (!name.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className={styles.page}>
      {/* ---- Sidebar ---- */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTop}>
            <h1 className={styles.sidebarTitle}>Conversaciones</h1>
            <button className={styles.newConvBtn} onClick={openNewConvModal} title="Nueva conversación">＋</button>
          </div>
          <input
            className={styles.searchInput}
            type="search"
            placeholder="Buscar contacto..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className={styles.chips}>
            {FILTERS.filter(f => {
              if (!f.minRole) return true;
              if (f.minRole === 'atencion_cliente') return agent?.role === 'admin' || agent?.role === 'atencion_cliente';
              if (f.minRole === 'admin') return agent?.role === 'admin';
              return true;
            }).map(f => (
              <button
                key={f.value}
                onClick={() => { setFilter(f.value); if (f.value !== 'teams') setTeamsDeptFilter(''); }}
                className={`${styles.filterChip} ${filter === f.value ? styles.filterChipActive : ''}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {filter === 'teams' && departments.length > 0 && (
            <select
              className={styles.labelSelect}
              value={teamsDeptFilter}
              onChange={e => setTeamsDeptFilter(e.target.value)}
            >
              <option value="">Todos los departamentos</option>
              {departments.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
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
              {/* Row 1: name + close/reopen */}
              <div className={styles.threadHeaderTop}>
                <span className={styles.threadName}>
                  {selected.contactName || selected.contactId}
                  {isUrgentFlag && <span style={{ marginLeft: 6, fontSize: 14 }}>⚡</span>}
                </span>
                <div className={styles.threadActions}>
                  {isArchived ? (
                    <button className={`${styles.actionBtn} ${styles.actionReopen}`} onClick={() => dispatch('to_bot')} disabled={updating}>
                      ↩ Reabrir
                    </button>
                  ) : (
                    <button
                      className={`${styles.actionBtn} ${styles.actionResolve}`}
                      onClick={() => dispatch('bot_archive')}
                      disabled={updating}
                      title="Archivar conversación"
                    >
                      ✓ Archivar
                    </button>
                  )}
                </div>
              </div>

              {/* Row 2: badges + dispatch actions */}
              <div className={styles.threadHeaderBottom}>
                <div className={styles.threadHeaderBadges}>
                  <ChannelBadge channel={selected.channel} />
                  <StatusChip status={currentStatus} />
                  {selected.assignedTo && <AgentBadge assignedTo={selected.assignedTo} nameMap={nameMap} />}
                </div>

                {!isArchived && (
                  <div className={styles.dispatchActions}>
                    <button
                      className={`${styles.dispatchBtn} ${styles.dispatchBotBtn} ${!isHuman && currentStatus === 'bot' ? styles.dispatchBtnActive : ''}`}
                      onClick={() => dispatch('to_bot')}
                      disabled={updating}
                      title="Enviar al Bot"
                    >
                      🤖 Bot
                    </button>

                    {/* Take over button: visible when bot is handling the conv */}
                    {!isHuman && currentStatus === 'bot' && (
                      <button
                        className={styles.takeOverBtn}
                        onClick={() => dispatch('take_over', { agentId: myId })}
                        disabled={updating}
                        title="Tomar esta conversación — el bot deja de responder"
                      >
                        ✋ Tomar
                      </button>
                    )}

                    {departments.map(dept => (
                      <button
                        key={dept.id}
                        className={`${styles.dispatchBtn} ${selected.assignedTo === dept.id && isHuman ? styles.dispatchBtnActive : ''}`}
                        onClick={() => dispatch('assign_dept', { deptId: dept.id })}
                        disabled={updating}
                        title={`Derivar a ${dept.name}`}
                      >
                        → {dept.name}
                      </button>
                    ))}

                    {/* Urgent toggle: always visible, toggles the flag */}
                    {isUrgentFlag ? (
                      <button
                        className={`${styles.dispatchBtn} ${styles.dispatchUnurgentBtn}`}
                        onClick={() => dispatch('unset_urgent')}
                        disabled={updating}
                        title="Quitar urgente"
                      >
                        ⚡ Quitar urgente
                      </button>
                    ) : (
                      <button
                        className={`${styles.dispatchBtn} ${styles.dispatchUrgentBtn}`}
                        onClick={() => dispatch('set_urgent')}
                        disabled={updating}
                        title="Marcar como urgente"
                      >
                        ⚡ Urgente
                      </button>
                    )}
                  </div>
                )}

                <div className={styles.labelsRow}>
                  {(selected.labels ?? []).map(l => (
                    <LabelChip key={l} label={l} labelMap={labelMap} onRemove={!isArchived ? removeLabel : null} />
                  ))}
                  {!isArchived && (
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
                  )}
                </div>
              </div>
            </div>

            <div
              className={styles.messages}
              ref={messagesContainerRef}
              onScroll={handleMessagesScroll}
            >
              {messages.length === 0 ? (
                <p className={styles.noMessages}>Sin mensajes aún.</p>
              ) : (
                messages.map((msg, i) => {
                  const canRetry = msg.role === 'admin' && msg.msgStatus === 'error'
                    && msg.content?.trim() && !msg.mediaType
                    && !msg.content.startsWith('[Plantilla:');
                  return (
                    <MessageBubble
                      key={i}
                      msg={msg}
                      onRetry={canRetry ? handleRetry : null}
                    />
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Footer: depends on conversation state */}
            {isArchived ? (
              <div className={styles.archivedBanner}>
                <span>Conversación archivada</span>
                <button
                  className={`${styles.dispatchBtn}`}
                  onClick={() => dispatch('to_bot')}
                  disabled={updating}
                >
                  ↩ Reabrir al Bot
                </button>
              </div>
            ) : isWindowExpired ? (
              /* ---- Window expired: block text, force template ---- */
              <div className={styles.windowExpiredPanel}>
                <div className={styles.windowExpiredHeader}>
                  <span className={styles.windowExpiredIcon}>⛔</span>
                  <div>
                    <p className={styles.windowExpiredTitle}>Ventana de WhatsApp expirada</p>
                    <p className={styles.windowExpiredDesc}>
                      {lastClientHours !== null
                        ? `El cliente no escribió en las últimas ${Math.floor(lastClientHours)}h.`
                        : 'El cliente no ha iniciado la conversación.'}
                      {' '}No podés enviar mensajes de texto libre. Solo podés enviar una <strong>plantilla aprobada</strong> para retomar el contacto.
                    </p>
                  </div>
                </div>

                {!templateSendOpen ? (
                  <button className={styles.openTemplateSendBtn} onClick={openTemplatePanel}>
                    Enviar plantilla aprobada
                  </button>
                ) : (
                  <div className={styles.templateSendForm}>
                    {approvedTemplates.length === 0 ? (
                      <p className={styles.noApprovedWarning}>
                        No tenés plantillas aprobadas. Creá una en la sección Plantillas y esperá la aprobación de Meta.
                      </p>
                    ) : (
                      <>
                        <select
                          className={styles.templateSendSelect}
                          value={selectedTemplate?.id ?? ''}
                          onChange={e => pickTemplate(e.target.value)}
                        >
                          <option value="">Seleccioná una plantilla aprobada...</option>
                          {approvedTemplates.map(t => (
                            <option key={t.id} value={t.id}>
                              {t.displayName} ({t.name})
                            </option>
                          ))}
                        </select>

                        {selectedTemplate && (
                          <div className={styles.templatePreviewInChat}>
                            <p className={styles.templatePreviewText}>{selectedTemplate.bodyText}</p>
                          </div>
                        )}

                        {selectedTemplate?.params?.length > 0 && selectedTemplate.params.map((desc, i) => (
                          <div key={i} className={styles.templateParamRow}>
                            <span className={styles.templateParamLabel}>{`{{${i + 1}}}`} {desc}</span>
                            <input
                              className={styles.templateParamInput}
                              type="text"
                              placeholder={desc}
                              value={templateParams[i] ?? ''}
                              onChange={e => setTemplateParams(prev => {
                                const n = [...prev]; n[i] = e.target.value; return n;
                              })}
                            />
                          </div>
                        ))}

                        {templateSendError && (
                          <p className={styles.templateSendError}>⚠️ {templateSendError}</p>
                        )}

                        <div className={styles.templateSendActions}>
                          <button
                            className={styles.templateSendCancelBtn}
                            onClick={() => { setTemplateSendOpen(false); setSelectedTemplate(null); }}
                          >
                            Cancelar
                          </button>
                          <button
                            className={styles.templateSendSubmitBtn}
                            onClick={sendTemplate}
                            disabled={!selectedTemplate || sendingTemplate}
                          >
                            {sendingTemplate ? 'Enviando...' : 'Enviar plantilla'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : isHuman ? (
              /* ---- Normal agent reply form ---- */
              <form className={styles.replyForm} onSubmit={sendReply}>
                <div className={styles.replyHumanBadge}>
                  Modo agente — Gina no responde · Respondiendo como <strong>{AGENTS.find(a => a.id === myId)?.label ?? myId}</strong>
                </div>
                {windowApproaching && (
                  <div className={styles.windowWarning}>
                    ⚠️ El cliente no escribe hace {Math.floor(lastClientHours)}h. La ventana de WhatsApp de 24h está por cerrarse — si no responde pronto, los mensajes dejarán de llegar.
                  </div>
                )}
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
                  <input
                    ref={mediaInputRef}
                    type="file"
                    accept="image/*,video/*,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className={styles.mediaFileInput}
                    onChange={handleMediaSelect}
                    disabled={sending}
                  />
                  <button
                    type="button"
                    className={styles.mediaBtn}
                    onClick={() => mediaInputRef.current?.click()}
                    disabled={sending}
                    title="Enviar imagen / video / audio / documento"
                  >
                    📎
                  </button>
                  <button type="submit" className={styles.replyBtn} disabled={sending || !reply.trim()}>
                    {sending ? '...' : 'Enviar'}
                  </button>
                </div>
              </form>
            ) : (
              /* ---- Bot is handling the conversation ---- */
              <div className={styles.botFooter}>
                <span className={styles.botFooterDot} />
                <span className={styles.botFooterText}>Gina está respondiendo automáticamente</span>
                <button
                  className={styles.takeOverBtn}
                  onClick={() => dispatch('take_over', { agentId: myId })}
                  disabled={updating}
                  style={{ marginLeft: 8 }}
                  title="Intervenir — el bot deja de responder"
                >
                  ✋ Tomar conversación
                </button>
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
                <div className={styles.summaryHeader}>
                  <span className={styles.profileSectionTitle}>Resumen IA</span>
                  <button
                    className={styles.summaryBtn}
                    onClick={generateSummary}
                    disabled={summaryGenerating}
                  >
                    {summaryGenerating ? '...' : summary ? '↻ Actualizar' : 'Generar'}
                  </button>
                </div>
                {summary ? (
                  <>
                    <p className={styles.summaryText}>{summary.text}</p>
                    <div className={styles.summaryMetrics}>
                      <span className={styles.metricChip}>💬 {summary.metrics?.totalMessages ?? '?'} msgs</span>
                      {summary.metrics?.agentMessages > 0 && (
                        <span className={styles.metricChip}>👤 {summary.metrics.agentMessages} agente</span>
                      )}
                      {summary.metrics?.assignedTo && (
                        <span className={styles.metricChip}>→ {summary.metrics.assignedTo}</span>
                      )}
                      {summary.metrics?.avgResponseTimeSec != null && (
                        <span className={styles.metricChip}>⏱ {summary.metrics.avgResponseTimeSec}s resp.</span>
                      )}
                    </div>
                    {summary.generatedAt && (
                      <span className={styles.summaryTimestamp}>
                        Generado {formatDate(summary.generatedAt)}
                      </span>
                    )}
                  </>
                ) : (
                  <p className={styles.profileEmpty}>
                    {summaryGenerating ? 'Generando resumen...' : 'Sin resumen. Hacé click en "Generar".'}
                  </p>
                )}
              </div>

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
                <label className={styles.newConvLabel}>Plantilla aprobada *</label>
                {templates.length === 0 ? (
                  <p className={styles.newConvHint}>Sin plantillas. Creá una en la sección Plantillas primero.</p>
                ) : templates.every(t => t.metaStatus !== 'APPROVED') ? (
                  <p className={styles.newConvHint}>
                    Ninguna plantilla está aprobada por Meta todavía. Creá una plantilla y esperá la aprobación, o sincronizá el estado en la sección Plantillas.
                  </p>
                ) : (
                  <select
                    className={styles.newConvSelect}
                    value={newTemplate?.id ?? ''}
                    onChange={e => selectTemplate(templates.find(t => t.id === e.target.value) ?? null)}
                  >
                    <option value="">Seleccionar plantilla aprobada...</option>
                    {templates.map(t => {
                      const approved = t.metaStatus === 'APPROVED';
                      if (!approved) return null;
                      return (
                        <option key={t.id} value={t.id}>
                          ✓ {t.displayName} ({t.name})
                        </option>
                      );
                    })}
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
