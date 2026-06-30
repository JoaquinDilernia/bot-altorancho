import { useEffect, useRef } from 'react';

const APP_TITLE = 'Alto Rancho';

function playBeep(type = 'normal') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    // Higher pitch for agent conversations, lower for bot
    osc.frequency.value = type === 'agent' ? 1047 : 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch { /* audio not available */ }
}

export function useNotifications(conversations) {
  const prevRef = useRef(null);

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const totalUnread = conversations.reduce((sum, c) => sum + (c.unread ?? 0), 0);
    document.title = totalUnread > 0 ? `(${totalUnread}) ${APP_TITLE}` : APP_TITLE;
  }, [conversations]);

  useEffect(() => {
    if (prevRef.current === null) {
      prevRef.current = conversations;
      return;
    }
    const prev = prevRef.current;
    prevRef.current = conversations;

    // Only notify when tab is in background
    if (document.visibilityState === 'visible') return;

    conversations.forEach(conv => {
      // Skip archived conversations
      const status = conv.status || 'bot';
      if (status === 'bot_archived' || status === 'resolved') return;

      const old = prev.find(c => c.id === conv.id);
      // New conversation (not seen before)
      if (!old) {
        const isAgent = conv.humanMode;
        const notifTitle = isAgent
          ? `Nueva derivación — ${conv.contactName || 'Cliente'}`
          : `Nuevo mensaje (Bot) — ${conv.contactName || 'Cliente'}`;
        playBeep(isAgent ? 'agent' : 'normal');
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(notifTitle, {
            body: conv.lastMessage || 'Nuevo mensaje recibido',
            icon: '/favicon.ico',
            tag: `altorancho-${conv.id}`,
          });
        }
        return;
      }

      const newUnread = conv.unread ?? 0;
      const oldUnread = old.unread ?? 0;
      if (newUnread <= oldUnread) return;

      // Differentiate notification by conversation type
      const isAgentConv = conv.humanMode;
      const isUrgent = conv.urgent;

      let title = conv.contactName || 'Nuevo mensaje';
      let body = conv.lastMessage || 'Nuevo mensaje recibido';

      if (isUrgent) {
        title = `⚡ URGENTE — ${title}`;
      } else if (isAgentConv) {
        title = `👤 Mis casos — ${title}`;
      } else {
        title = `🤖 Bot — ${title}`;
      }

      playBeep(isAgentConv || isUrgent ? 'agent' : 'normal');
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, {
          body,
          icon: '/favicon.ico',
          tag: `altorancho-${conv.id}`,
        });
      }
    });
  }, [conversations]);
}
