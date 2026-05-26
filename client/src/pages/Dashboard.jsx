import { useEffect, useState } from 'react';
import { authFetch, BASE_URL } from '../lib/api';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  async function fetchStats() {
    try {
      const res = await authFetch(BASE_URL + '/api/conversations');
      const data = await res.json();
      const conversations = data.conversations ?? [];

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const todayConvs = conversations.filter((c) => {
        const d = c.lastMessageAt?.seconds
          ? new Date(c.lastMessageAt.seconds * 1000)
          : new Date(c.lastMessageAt);
        return d >= today;
      });

      setStats({
        total: conversations.length,
        today: todayConvs.length,
        urgent: conversations.filter((c) => c.status === 'urgent').length,
        escalated: conversations.filter((c) => c.status === 'escalated').length,
        whatsapp: conversations.filter((c) => c.channel === 'whatsapp').length,
        instagram: conversations.filter((c) => c.channel === 'instagram').length,
        recent: conversations.slice(0, 5),
      });
    } catch {
      setStats({ total: 0, today: 0, whatsapp: 0, instagram: 0, recent: [] });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Dashboard</h1>
          <p className={styles.subtitle}>Resumen de actividad del bot</p>
        </div>
      </header>

      {loading ? (
        <div className={styles.loading}>Cargando...</div>
      ) : (
        <>
          <div className={styles.statsGrid}>
            <StatCard label="Conversaciones totales" value={stats.total} accent="primary" />
            <StatCard label="Hoy" value={stats.today} accent="success" />
            <StatCard label="Urgentes" value={stats.urgent} accent="urgent" />
            <StatCard label="Derivadas" value={stats.escalated} accent="escalated" />
            <StatCard label="WhatsApp" value={stats.whatsapp} accent="whatsapp" />
            <StatCard label="Instagram" value={stats.instagram} accent="instagram" />
          </div>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Últimas conversaciones</h2>
            {stats.recent.length === 0 ? (
              <p className={styles.empty}>Sin conversaciones aún.</p>
            ) : (
              <div className={styles.conversationList}>
                {stats.recent.map((c) => (
                  <ConversationRow key={c.id} conversation={c} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div className={`${styles.statCard} ${styles[`accent_${accent}`]}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function ConversationRow({ conversation }) {
  const channelLabel = conversation.channel === 'whatsapp' ? 'WhatsApp' : 'Instagram';
  const channelClass = conversation.channel === 'whatsapp' ? styles.badgeWpp : styles.badgeIg;

  return (
    <div className={styles.convRow}>
      <div className={styles.convInfo}>
        <span className={styles.convId}>{conversation.contactId}</span>
        <span className={styles.convMsg}>{conversation.lastMessage}</span>
      </div>
      <div className={styles.convMeta}>
        <span className={`${styles.badge} ${channelClass}`}>{channelLabel}</span>
        <span className={styles.convCount}>{conversation.messageCount} msg</span>
      </div>
    </div>
  );
}
