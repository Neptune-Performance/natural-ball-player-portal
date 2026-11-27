import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import { Hash, Lock, Send, Paperclip, X, Plus, Search, Check, MessageSquare, ArrowLeft, Image as ImageIcon, FileText } from 'lucide-react';
import { formatUserError } from './errorMessage';

const AUDIENCE_LABEL = { all: 'All staff', coaches: 'Coaches + admins', admin: 'Admins only', custom: 'Custom' };

function canonical(a, b) {
  return a < b ? [a, b] : [b, a];
}
function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function isImage(type) {
  return type && type.startsWith('image/');
}
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchDmThreadsForUser(userId) {
  const [asUserA, asUserB] = await Promise.all([
    supabase
      .from('work_dm_threads')
      .select('id, user_a_id, user_b_id, last_message_at')
      .eq('user_a_id', userId),
    supabase
      .from('work_dm_threads')
      .select('id, user_a_id, user_b_id, last_message_at')
      .eq('user_b_id', userId),
  ]);

  if (asUserA.error) throw asUserA.error;
  if (asUserB.error) throw asUserB.error;

  return Array.from(new Map([...(asUserA.data || []), ...(asUserB.data || [])].map(thread => [thread.id, thread])).values())
    .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
}

export default function WorkMessages({ userId, userRole }) {
  const [channels, setChannels] = useState([]);
  const [dms, setDms] = useState([]);
  const [staff, setStaff] = useState([]);
  const [reads, setReads] = useState({}); // { channel:{id->ts}, dm:{id->ts} }
  const [unreadCounts, setUnreadCounts] = useState({}); // { 'channel-uuid': N, 'dm-uuid': N }
  const [active, setActive] = useState(null); // { kind: 'channel'|'dm', id }
  const [showNewDm, setShowNewDm] = useState(false);
  const [mobileShowList, setMobileShowList] = useState(true);

  // Load channels, DMs, staff
  const loadSidebar = useCallback(async () => {
    try {
      const [chRes, dmThreads, staffRes, readsRes] = await Promise.all([
        supabase.from('work_channels').select('id, name, description, audience').order('name'),
        fetchDmThreadsForUser(userId),
        supabase.from('users').select('id, full_name, avatar_url, role').in('role', ['admin', 'coach']).neq('id', userId).order('full_name'),
        supabase.from('work_message_reads').select('channel_id, dm_thread_id, last_read_at').eq('user_id', userId),
      ]);
      if (chRes.data) setChannels(chRes.data);
      setDms(dmThreads || []);
      if (staffRes.data) setStaff(staffRes.data);
      if (readsRes.data) {
        const map = { channel: {}, dm: {} };
        readsRes.data.forEach(r => {
          if (r.channel_id) map.channel[r.channel_id] = r.last_read_at;
          else if (r.dm_thread_id) map.dm[r.dm_thread_id] = r.last_read_at;
        });
        setReads(map);
      }
    } catch (error) {
      console.error('Error loading work message sidebar:', error);
    }
  }, [userId]);

  // Compute unread counts per channel/DM
  const refreshUnread = useCallback(async () => {
    if (channels.length === 0 && dms.length === 0) return;
    const channelIds = channels.map(c => c.id);
    const dmIds = dms.map(d => d.id);

    const counts = {};
    if (channelIds.length > 0) {
      const { data } = await supabase.from('work_messages').select('channel_id, created_at, sender_id').in('channel_id', channelIds);
      (data || []).forEach(m => {
        if (m.sender_id === userId) return;
        const lr = reads.channel?.[m.channel_id];
        if (!lr || new Date(m.created_at) > new Date(lr)) {
          const k = `channel-${m.channel_id}`;
          counts[k] = (counts[k] || 0) + 1;
        }
      });
    }
    if (dmIds.length > 0) {
      const { data } = await supabase.from('work_messages').select('dm_thread_id, created_at, sender_id').in('dm_thread_id', dmIds);
      (data || []).forEach(m => {
        if (m.sender_id === userId) return;
        const lr = reads.dm?.[m.dm_thread_id];
        if (!lr || new Date(m.created_at) > new Date(lr)) {
          const k = `dm-${m.dm_thread_id}`;
          counts[k] = (counts[k] || 0) + 1;
        }
      });
    }
    setUnreadCounts(counts);
  }, [channels, dms, reads, userId]);

  useEffect(() => { if (userId) loadSidebar(); }, [userId, loadSidebar]);
  useEffect(() => { refreshUnread(); }, [refreshUnread]);

  // Keep the latest callbacks in refs so the realtime subscription can be created
  // once per userId instead of being torn down/rebuilt every time channels/dms/reads
  // change (which re-identify refreshUnread/loadSidebar).
  const refreshUnreadRef = useRef(refreshUnread);
  const loadSidebarRef = useRef(loadSidebar);
  useEffect(() => { refreshUnreadRef.current = refreshUnread; }, [refreshUnread]);
  useEffect(() => { loadSidebarRef.current = loadSidebar; }, [loadSidebar]);

  // Realtime: new messages → refresh unread; sidebar might need to refresh DM order
  useEffect(() => {
    if (!userId) return;
    const ch = supabase.channel(`work-msg-global-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_messages' }, () => {
        refreshUnreadRef.current();
        loadSidebarRef.current();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_dm_threads' }, () => loadSidebarRef.current())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [userId]);

  const openItem = async (kind, id) => {
    setActive({ kind, id });
    setMobileShowList(false);
    const now = new Date().toISOString();
    const filter = kind === 'channel' ? { channel_id: id } : { dm_thread_id: id };
    const { error } = await supabase
      .from('work_message_reads')
      .upsert({ user_id: userId, ...filter, last_read_at: now }, { onConflict: 'user_id,target_kind,target_id' });
    if (error) console.error('Read mark error:', error);
    setReads(prev => {
      const next = { ...prev, channel: { ...(prev.channel || {}) }, dm: { ...(prev.dm || {}) } };
      if (kind === 'channel') next.channel[id] = now;
      else next.dm[id] = now;
      return next;
    });
  };

  const openOrCreateDm = async (otherUserId) => {
    const [a, b] = canonical(userId, otherUserId);
    let { data: existing } = await supabase
      .from('work_dm_threads')
      .select('id')
      .eq('user_a_id', a)
      .eq('user_b_id', b)
      .maybeSingle();
    let threadId = existing?.id;
    if (!threadId) {
      const { data, error } = await supabase
        .from('work_dm_threads')
        .insert({ user_a_id: a, user_b_id: b })
        .select('id')
        .single();
      if (error) { alert('Could not create DM: ' + formatUserError(error)); return; }
      threadId = data.id;
      await loadSidebar();
    }
    setShowNewDm(false);
    openItem('dm', threadId);
  };

  const dmLabel = (t) => {
    const otherId = t.user_a_id === userId ? t.user_b_id : t.user_a_id;
    return staff.find(s => s.id === otherId);
  };

  const activeChannel = active?.kind === 'channel' ? channels.find(c => c.id === active.id) : null;
  const activeDm = active?.kind === 'dm' ? dms.find(d => d.id === active.id) : null;
  const activeDmOther = activeDm ? dmLabel(activeDm) : null;

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden flex" style={{ height: 'calc(100vh - 140px)' }}>
      {/* Sidebar */}
      <div className={`w-full md:w-72 border-r border-gray-200 flex flex-col ${active && !mobileShowList ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-3 border-b border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase text-gray-500 tracking-wider">Channels</h3>
          </div>
          <div className="space-y-0.5">
            {channels.map(c => {
              const unread = unreadCounts[`channel-${c.id}`] || 0;
              return (
                <button
                  key={c.id}
                  onClick={() => openItem('channel', c.id)}
                  className={`w-full flex items-center px-2 py-1.5 rounded text-sm transition ${
                    active?.kind === 'channel' && active.id === c.id ? 'bg-indigo-100 text-indigo-700' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {c.audience === 'admin' ? <Lock size={14} className="mr-1.5 flex-shrink-0" /> : <Hash size={14} className="mr-1.5 flex-shrink-0" />}
                  <span className={`flex-1 text-left truncate ${unread ? 'font-semibold' : ''}`}>{c.name}</span>
                  {unread > 0 && <span className="bg-red-500 text-white text-xs font-bold rounded-full h-5 min-w-[20px] flex items-center justify-center px-1">{unread > 99 ? '99+' : unread}</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-3 border-b border-gray-200 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase text-gray-500 tracking-wider">Direct messages</h3>
            <button
              onClick={() => setShowNewDm(true)}
              className="p-1 text-gray-500 hover:text-indigo-600 hover:bg-gray-100 rounded transition"
              title="New DM"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="space-y-0.5">
            {dms.length === 0 && <p className="text-xs text-gray-400 px-2 py-2">No DMs yet. Click + to start one.</p>}
            {dms.map(t => {
              const other = dmLabel(t);
              const unread = unreadCounts[`dm-${t.id}`] || 0;
              return (
                <button
                  key={t.id}
                  onClick={() => openItem('dm', t.id)}
                  className={`w-full flex items-center px-2 py-1.5 rounded text-sm transition ${
                    active?.kind === 'dm' && active.id === t.id ? 'bg-indigo-100 text-indigo-700' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {other?.avatar_url ? (
                    <img src={other.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover mr-1.5 flex-shrink-0" />
                  ) : (
                    <div className="w-5 h-5 bg-indigo-600 rounded-full flex items-center justify-center text-white text-xs font-bold mr-1.5 flex-shrink-0">
                      {other?.full_name?.charAt(0) || '?'}
                    </div>
                  )}
                  <span className={`flex-1 text-left truncate ${unread ? 'font-semibold' : ''}`}>{other?.full_name || 'Unknown'}</span>
                  {unread > 0 && <span className="bg-red-500 text-white text-xs font-bold rounded-full h-5 min-w-[20px] flex items-center justify-center px-1">{unread > 99 ? '99+' : unread}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Thread */}
      <div className={`flex-1 flex flex-col ${active && !mobileShowList ? 'flex' : 'hidden md:flex'}`}>
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <MessageSquare size={48} className="mx-auto mb-3 text-gray-300" />
              <p>Select a channel or DM to start chatting.</p>
            </div>
          </div>
        ) : (
          <Thread
            kind={active.kind}
            id={active.id}
            userId={userId}
            userRole={userRole}
            channel={activeChannel}
            dmOther={activeDmOther}
            onBack={() => { setMobileShowList(true); setActive(null); }}
            onSent={refreshUnread}
          />
        )}
      </div>

      {showNewDm && (
        <NewDmModal
          staff={staff}
          existingDmUserIds={new Set(dms.map(d => d.user_a_id === userId ? d.user_b_id : d.user_a_id))}
          onPick={openOrCreateDm}
          onClose={() => setShowNewDm(false)}
        />
      )}
    </div>
  );
}

function NewDmModal({ staff, existingDmUserIds, onPick, onClose }) {
  const [search, setSearch] = useState('');
  const filtered = staff.filter(s => !existingDmUserIds.has(s.id) && (search.trim() === '' || s.full_name?.toLowerCase().includes(search.toLowerCase())));
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold text-gray-900">Start a DM</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="p-3 border-b">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search staff..."
              className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              autoFocus
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-500 p-4 text-center">{staff.length === 0 ? 'No other staff yet.' : 'No matches.'}</p>
          ) : filtered.map(s => (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              className="w-full flex items-center space-x-3 px-4 py-2 hover:bg-gray-50 transition text-left"
            >
              {s.avatar_url ? (
                <img src={s.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
              ) : (
                <div className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center text-white text-sm font-bold">{s.full_name?.charAt(0) || '?'}</div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{s.full_name}</p>
                <p className="text-xs text-gray-500">{s.role}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Thread({ kind, id, userId, userRole, channel, dmOther, onBack, onSent }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [signedUrls, setSignedUrls] = useState({});
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  const fetchMessages = useCallback(async () => {
    setLoading(true);
    const col = kind === 'channel' ? 'channel_id' : 'dm_thread_id';
    // Cap at the most recent 200 — older history can be paged in later
    // (issue follow-up). Fetch DESC then reverse so the order/limit work
    // together.
    const { data, error } = await supabase
      .from('work_messages')
      .select('id, body, attachment_path, attachment_name, attachment_size, attachment_type, sender_id, created_at, edited_at, sender:sender_id(full_name, avatar_url)')
      .eq(col, id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) console.error(error);
    else setMessages((data || []).reverse());
    setLoading(false);
  }, [kind, id]);

  // Generate signed URLs for attachments
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      for (const m of messages) {
        if (m.attachment_path && !signedUrls[m.id]) {
          const { data } = await supabase.storage.from('work-attachments').createSignedUrl(m.attachment_path, 60 * 60);
          if (data?.signedUrl) next[m.id] = data.signedUrl;
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setSignedUrls(prev => ({ ...prev, ...next }));
      }
    })();
    return () => { cancelled = true; };
  }, [messages, signedUrls]);

  useEffect(() => {
    fetchMessages();
    const filter = kind === 'channel' ? `channel_id=eq.${id}` : `dm_thread_id=eq.${id}`;
    // Debounce burst refetches — Realtime will fire one event per row change,
    // so a five-person reply storm or an admin batch-edit was spawning a
    // refetch per event. Coalesce to one refetch per 200ms window.
    let timer = null;
    const debouncedRefetch = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; fetchMessages(); }, 200);
    };
    const ch = supabase.channel(`thread-${kind}-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_messages', filter }, debouncedRefetch)
      .subscribe();
    return () => { if (timer) clearTimeout(timer); supabase.removeChannel(ch); };
  }, [kind, id, fetchMessages]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    const text = body.trim();
    if (!text && !file) return;
    setSending(true);

    let attachment_path = null, attachment_name = null, attachment_size = null, attachment_type = null;

    if (file) {
      const ext = file.name.includes('.') ? file.name.split('.').pop() : 'bin';
      const folder = kind === 'channel' ? `channel/${id}` : `dm/${id}`;
      const path = `${folder}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('work-attachments').upload(path, file, { contentType: file.type });
      if (upErr) { alert('Upload failed: ' + formatUserError(upErr)); setSending(false); return; }
      attachment_path = path;
      attachment_name = file.name;
      attachment_size = file.size;
      attachment_type = file.type;
    }

    const payload = {
      sender_id: userId,
      body: text || null,
      attachment_path, attachment_name, attachment_size, attachment_type,
      ...(kind === 'channel' ? { channel_id: id } : { dm_thread_id: id }),
    };

    const { error } = await supabase.from('work_messages').insert(payload);
    if (error) { alert('Send failed: ' + formatUserError(error)); setSending(false); return; }

    setBody('');
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setSending(false);

    // Mark read up to now
    const now = new Date().toISOString();
    const filterCol = kind === 'channel' ? { channel_id: id } : { dm_thread_id: id };
    await supabase.from('work_message_reads').upsert(
      { user_id: userId, ...filterCol, last_read_at: now },
      { onConflict: 'user_id,target_kind,target_id' }
    );
    onSent?.();
  };

  const startEdit = (m) => {
    setEditingId(m.id);
    setEditBody(m.body || '');
  };

  const saveEdit = async () => {
    const text = editBody.trim();
    if (!text) { alert('Message cannot be empty.'); return; }
    const { error } = await supabase
      .from('work_messages')
      .update({ body: text, edited_at: new Date().toISOString() })
      .eq('id', editingId);
    if (error) alert('Edit failed: ' + formatUserError(error));
    setEditingId(null);
    setEditBody('');
  };

  const handleDelete = async (m) => {
    if (!window.confirm('Delete this message?')) return;
    const { error } = await supabase.from('work_messages').delete().eq('id', m.id);
    if (error) alert('Delete failed: ' + formatUserError(error));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const headerName = channel ? `#${channel.name}` : (dmOther?.full_name || 'Direct message');
  const headerSub = channel ? channel.description || AUDIENCE_LABEL[channel.audience] : (dmOther?.role?.toUpperCase() || '');

  return (
    <>
      <div className="border-b border-gray-200 px-4 py-3 flex items-center">
        <button onClick={onBack} className="md:hidden p-1 mr-2 text-gray-500 hover:text-gray-900"><ArrowLeft size={18} /></button>
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 flex items-center">
            {channel?.audience === 'admin' && <Lock size={14} className="mr-1 text-gray-500" />}
            <span className="truncate">{headerName}</span>
          </h3>
          {headerSub && <p className="text-xs text-gray-500 truncate">{headerSub}</p>}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <p className="text-center text-gray-400 text-sm">Loading...</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-8">No messages yet. Be the first to say hi.</p>
        ) : messages.map((m, idx) => {
          const prev = messages[idx - 1];
          const newSender = !prev || prev.sender_id !== m.sender_id || (new Date(m.created_at) - new Date(prev.created_at)) > 5 * 60 * 1000;
          const own = m.sender_id === userId;
          return (
            <div key={m.id} className={`flex space-x-3 ${newSender ? '' : 'mt-0.5'}`}>
              <div className="w-8 flex-shrink-0">
                {newSender && (
                  m.sender?.avatar_url ? (
                    <img src={m.sender.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
                  ) : (
                    <div className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                      {m.sender?.full_name?.charAt(0) || '?'}
                    </div>
                  )
                )}
              </div>
              <div className="flex-1 min-w-0 group">
                {newSender && (
                  <div className="flex items-baseline space-x-2">
                    <span className="font-semibold text-sm text-gray-900">{m.sender?.full_name || (m.sender_id ? 'Unknown' : 'Former staff')}</span>
                    <span className="text-xs text-gray-500">{formatTime(m.created_at)}</span>
                  </div>
                )}
                {editingId === m.id ? (
                  <div className="flex items-center space-x-2 mt-1">
                    <input
                      autoFocus
                      type="text"
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null); }}
                      className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <button onClick={saveEdit} className="p-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700"><Check size={14} /></button>
                    <button onClick={() => setEditingId(null)} className="p-1.5 text-gray-500 hover:text-gray-900"><X size={14} /></button>
                  </div>
                ) : (
                  <>
                    {m.body && <p className="text-sm text-gray-800 whitespace-pre-wrap">{m.body}{m.edited_at && <span className="text-xs text-gray-400 ml-1">(edited)</span>}</p>}
                    {m.attachment_path && (
                      <div className="mt-1">
                        {isImage(m.attachment_type) && signedUrls[m.id] ? (
                          <a href={signedUrls[m.id]} target="_blank" rel="noopener noreferrer">
                            <img src={signedUrls[m.id]} alt={m.attachment_name} className="max-w-xs max-h-64 rounded border border-gray-200" />
                          </a>
                        ) : (
                          <a
                            href={signedUrls[m.id] || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center space-x-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition text-sm max-w-sm"
                          >
                            <FileText size={16} className="text-gray-500 flex-shrink-0" />
                            <span className="truncate flex-1">{m.attachment_name}</span>
                            <span className="text-xs text-gray-500 flex-shrink-0">{formatSize(m.attachment_size)}</span>
                          </a>
                        )}
                      </div>
                    )}
                  </>
                )}
                {(own || userRole === 'admin') && editingId !== m.id && (
                  <div className="opacity-0 group-hover:opacity-100 transition flex items-center space-x-1 mt-0.5">
                    {own && m.body && (
                      <button onClick={() => startEdit(m)} className="text-xs text-gray-500 hover:text-indigo-600">Edit</button>
                    )}
                    <button onClick={() => handleDelete(m)} className="text-xs text-gray-500 hover:text-red-600">Delete</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-gray-200 p-3">
        {file && (
          <div className="mb-2 flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            <div className="flex items-center space-x-2 text-sm min-w-0">
              {isImage(file.type) ? <ImageIcon size={16} className="text-gray-500 flex-shrink-0" /> : <FileText size={16} className="text-gray-500 flex-shrink-0" />}
              <span className="truncate">{file.name}</span>
              <span className="text-xs text-gray-500 flex-shrink-0">{formatSize(file.size)}</span>
            </div>
            <button onClick={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }} className="text-gray-400 hover:text-gray-700"><X size={14} /></button>
          </div>
        )}
        <div className="flex items-end space-x-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 text-gray-500 hover:text-indigo-600 hover:bg-gray-100 rounded transition"
            title="Attach file"
          >
            <Paperclip size={18} />
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="hidden"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={`Message ${channel ? '#' + channel.name : dmOther?.full_name || ''}`}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            style={{ maxHeight: '120px' }}
          />
          <button
            onClick={handleSend}
            disabled={sending || (!body.trim() && !file)}
            className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            title="Send"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </>
  );
}
