import { memo, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Search, Trash2, ArrowDown, RefreshCw, Download, Filter, MessageSquare } from 'lucide-react';
import type { LogEntry } from '../hooks/useWebSocket';
import { useI18n } from '../i18n';

interface Props {
  logEntries: LogEntry[];
  clearEvents: () => void;
  refreshLog: () => void;
}

type MessageRole = 'user' | 'bot' | 'system';

interface ParsedLogEntry extends LogEntry {
  role: MessageRole;
  channel: string;
  sessionId: string;
  conversationId: string;
  userId: string;
  text: string;
  meta: Record<string, string>;
}

interface ConversationGroup {
  key: string;
  channel: string;
  sessionId: string;
  conversationId: string;
  userId: string;
  entries: ParsedLogEntry[];
  latestTime: number;
  latestText: string;
  counts: Record<MessageRole, number>;
}

function ActivityLogPage({ logEntries, clearEvents, refreshLog }: Props) {
  const { t } = useI18n();
  const { uiMode } = (useOutletContext() as { uiMode?: 'modern' }) || {};
  const modern = uiMode === 'modern';
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedConversation, setSelectedConversation] = useState('');

  const parsedEntries = useMemo(() => logEntries.map(parseEntry), [logEntries]);

  const filteredEntries = useMemo(() => parsedEntries.filter(entry => {
    if (sourceFilter && entry.source !== sourceFilter && entry.channel !== sourceFilter) return false;
    if (typeFilter === 'text' && isMediaEntry(entry)) return false;
    if (typeFilter === 'media' && !isMediaEntry(entry)) return false;
    if (typeFilter === 'sticker' && !isStickerEntry(entry)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      entry.text.toLowerCase().includes(q) ||
      entry.userId.toLowerCase().includes(q) ||
      entry.sessionId.toLowerCase().includes(q) ||
      entry.conversationId.toLowerCase().includes(q) ||
      (entry.detail || '').toLowerCase().includes(q)
    );
  }), [parsedEntries, search, sourceFilter, typeFilter]);

  const conversations = useMemo(() => {
    const map = new Map<string, ConversationGroup>();
    filteredEntries.forEach(entry => {
      const key = `${entry.channel}::${entry.sessionId || entry.conversationId || 'default'}`;
      const current = map.get(key);
      if (!current) {
        map.set(key, {
          key,
          channel: entry.channel,
          sessionId: entry.sessionId,
          conversationId: entry.conversationId,
          userId: entry.userId,
          entries: [entry],
          latestTime: entry.time,
          latestText: entry.text,
          counts: { user: entry.role === 'user' ? 1 : 0, bot: entry.role === 'bot' ? 1 : 0, system: entry.role === 'system' ? 1 : 0 },
        });
        return;
      }
      current.entries.push(entry);
      current.latestTime = Math.max(current.latestTime, entry.time);
      if (entry.time >= current.latestTime) current.latestText = entry.text;
      if (!current.userId && entry.userId) current.userId = entry.userId;
      current.counts[entry.role] += 1;
    });
    return Array.from(map.values())
      .map(group => ({ ...group, entries: [...group.entries].sort((a, b) => a.time - b.time) }))
      .sort((a, b) => b.latestTime - a.latestTime);
  }, [filteredEntries]);

  useEffect(() => {
    if (!selectedConversation || !conversations.some(item => item.key === selectedConversation)) {
      const preferred = conversations.find(item => item.channel !== 'system' && item.channel !== 'workflow') || conversations[0];
      setSelectedConversation(preferred?.key || '');
    }
  }, [conversations, selectedConversation]);

  const activeConversation = conversations.find(item => item.key === selectedConversation) || null;

  const sourceCounts = useMemo(() => logEntries.reduce((acc, entry) => {
    acc[entry.source] = (acc[entry.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>), [logEntries]);

  const handleExport = () => {
    const lines = filteredEntries.map(entry => `[${new Date(entry.time).toLocaleString()}] [${entry.channel}] [${roleLabel(entry.role)}] ${entry.text}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clawpanel-log-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`h-full flex flex-col space-y-4 ${modern ? 'page-modern' : ''}`}>
      <div className={`${modern ? 'page-modern-header shrink-0' : 'flex items-center justify-between shrink-0'}`}>
        <div>
          <h2 className={`${modern ? 'page-modern-title' : 'text-xl font-bold text-gray-900 dark:text-white tracking-tight'}`}>{t.activityLog.title}</h2>
          <p className={`${modern ? 'page-modern-subtitle' : 'text-sm text-gray-500 mt-1'}`}>按会话查看各通道用户消息、机器人回复和系统通知。</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} className={`${modern ? 'page-modern-accent' : 'flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700'} `}>
            <Download size={14} />{t.activityLog.exportLog}
          </button>
        </div>
      </div>

      <div className={`${modern ? 'page-modern-panel' : 'bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700/50'} flex-1 flex flex-col min-h-0 overflow-hidden`}>
        <div className="flex flex-col gap-3 px-5 py-4 border-b border-gray-100 dark:border-gray-800 bg-white/80 dark:bg-slate-950/40 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <span className="font-semibold text-gray-900 dark:text-white tabular-nums">{filteredEntries.length}</span>{t.common.records}
              <span className="text-xs text-gray-400">/ {conversations.length} 个会话</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setAutoScroll(!autoScroll)} className={`p-2 rounded-lg transition-all ${autoScroll ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-100' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`} title={autoScroll ? t.dashboard.pauseScroll : t.dashboard.resumeScroll}><ArrowDown size={14} /></button>
              <button onClick={refreshLog} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 transition-colors" title={t.common.refresh}><RefreshCw size={14} /></button>
              <button onClick={clearEvents} className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 transition-colors" title={t.activityLog.clear}><Trash2 size={14} /></button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索消息、用户、会话..." className="w-full pl-9 pr-4 py-2 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all" />
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-hide">
              {[
                { key: '', label: t.common.all, count: logEntries.length },
                { key: 'qq', label: 'QQ', count: sourceCounts.qq || 0 },
                { key: 'wecom', label: '企微', count: sourceCounts.wecom || 0 },
                { key: 'feishu', label: '飞书', count: sourceCounts.feishu || 0 },
                { key: 'openclaw', label: t.activityLog.botReply, count: sourceCounts.openclaw || 0 },
                { key: 'workflow', label: 'Workflow', count: sourceCounts.workflow || 0 },
                { key: 'system', label: t.dashboard.sourceSystem, count: sourceCounts.system || 0 },
              ].map(item => (
                <button key={item.key} onClick={() => setSourceFilter(item.key)} className={`px-2.5 py-1.5 text-xs rounded-lg transition-all whitespace-nowrap flex items-center gap-1.5 ${sourceFilter === item.key ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-semibold shadow-sm' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-700 dark:hover:text-gray-300'}`}>
                  {item.label}
                  {item.count > 0 && <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${sourceFilter === item.key ? 'bg-white/50 text-blue-800' : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}`}>{item.count}</span>}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <Filter size={14} className="text-gray-400" />
              {[
                { key: '', label: t.activityLog.allTypes },
                { key: 'text', label: t.activityLog.text },
                { key: 'media', label: t.activityLog.media },
                { key: 'sticker', label: t.activityLog.sticker },
              ].map(item => (
                <button key={item.key} onClick={() => setTypeFilter(item.key)} className={`px-2.5 py-1.5 text-xs rounded-lg transition-all whitespace-nowrap ${typeFilter === item.key ? 'border border-blue-100/80 bg-blue-50/85 dark:bg-blue-900/20 dark:border-blue-800/40 text-blue-700 dark:text-blue-300 font-semibold shadow-sm' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-700 dark:hover:text-gray-300'}`}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)]">
          <div className="border-r border-gray-100 dark:border-gray-800 min-h-0 overflow-y-auto p-3 space-y-2 bg-slate-50/70 dark:bg-slate-950/30">
            {conversations.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3 py-16">
                <MessageSquare size={24} className="opacity-20" />
                <p className="text-sm">{t.activityLog.noMatch}</p>
              </div>
            ) : conversations.map(group => {
              const active = group.key === selectedConversation;
              return (
                <button key={group.key} onClick={() => setSelectedConversation(group.key)} className={`w-full text-left rounded-2xl border px-3 py-3 transition-all ${active ? 'border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900/80' : 'border-transparent bg-white/75 hover:border-slate-200 hover:bg-white dark:bg-slate-900/30 dark:hover:border-slate-800 dark:hover:bg-slate-900/55'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${sourceColor(group.channel)}`}>{sourceLabel(group.channel)}</span>
                        {group.counts.bot > 0 && <span className="text-[10px] text-slate-400">{group.counts.user}/{group.counts.bot}</span>}
                      </div>
                      <div className="mt-2 truncate text-sm font-semibold text-slate-900 dark:text-white">{group.userId || sourceLabel(group.channel)}</div>
                      <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{group.latestText || '暂无内容'}</div>
                    </div>
                    <span className="shrink-0 text-[11px] text-gray-400">{formatLogTime(group.latestTime)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-400">
                    <span className="truncate">{shortMeta(group.conversationId || group.sessionId || '-')}</span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex flex-col bg-white dark:bg-slate-950">
            {!activeConversation ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-400">选择左侧会话查看消息流</div>
            ) : (
              <>
                <div className="border-b border-gray-100 dark:border-gray-800 px-6 py-4 bg-white dark:bg-slate-950">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${sourceColor(activeConversation.channel)}`}>{sourceLabel(activeConversation.channel)}</span>
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">{activeConversation.userId || '未识别用户'}</span>
                    <span className="text-xs text-slate-400">最近更新 {formatLogTime(activeConversation.latestTime)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>通道会话 {shortMeta(activeConversation.conversationId || '-')}</span>
                    <span>内部会话 {shortMeta(activeConversation.sessionId || '-')}</span>
                    <span>用户 {activeConversation.counts.user}</span>
                    <span>机器人 {activeConversation.counts.bot}</span>
                    {activeConversation.counts.system > 0 && <span>系统 {activeConversation.counts.system}</span>}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
                  {activeConversation.entries.map(entry => (
                    <div key={entry.id} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[72%] rounded-2xl border px-4 py-3 ${messageTone(entry)}`}>
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] opacity-70">
                          <span className="font-semibold">{roleLabel(entry.role)}</span>
                          <span>{formatLogTime(entry.time)}</span>
                          {entry.userId && entry.role === 'user' && <span>{entry.userId}</span>}
                        </div>
                        <div className="whitespace-pre-wrap break-all text-sm leading-6">{entry.text}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function parseEntry(entry: LogEntry): ParsedLogEntry {
  const meta = parseDetail(entry.detail);
  const role = inferRole(entry);
  const channel = inferChannel(entry);
  const conversationId = meta.conversationId || meta.chatId || meta.to || fallbackConversation(entry);
  const sessionId = meta.sessionKey || conversationId || `${channel}:default`;
  const userId = meta.userId || meta.senderId || inferUserId(entry.summary, role);
  return { ...entry, role, channel, sessionId, conversationId, userId, text: cleanSummary(entry.summary), meta };
}

function parseDetail(detail?: string) {
  const meta: Record<string, string> = {};
  (detail || '').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx <= 0) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  });
  return meta;
}

function inferRole(entry: LogEntry): MessageRole {
  if (entry.source === 'openclaw') return 'bot';
  if (entry.source === 'workflow' || entry.source === 'system') return 'system';
  return 'user';
}

function inferChannel(entry: LogEntry) {
  if (entry.source === 'openclaw') {
    if (entry.summary.includes('[飞书回复]')) return 'feishu';
    if (entry.summary.includes('[企微回复]')) return 'wecom';
    if (entry.summary.includes('[私聊]') || entry.summary.includes('[群聊]')) return 'qq';
  }
  return entry.source;
}

function fallbackConversation(entry: LogEntry) {
  if (entry.source === 'qq') return entry.summary.includes('群') ? 'qq-group' : 'qq-private';
  return `${inferChannel(entry)}:unknown`;
}

function inferUserId(summary: string, role: MessageRole) {
  if (role !== 'user') return '';
  const match = summary.match(/^\[[^\]]+\]\s*([^:：]+)[:：]/);
  return match?.[1]?.trim() || '';
}

function cleanSummary(summary: string) {
  return summary
    .replace(/^\[(飞书|企微)回复\]\s*/, '')
    .replace(/^\[(飞书|企微)\]\s*/, '')
    .trim();
}

function shortMeta(value: string) {
  if (!value) return '-';
  return value.length > 28 ? `${value.slice(0, 28)}...` : value;
}

function isMediaEntry(entry: ParsedLogEntry) {
  return entry.text.includes('[图片]') || entry.text.includes('[动画表情]') || entry.text.includes('[视频]') || entry.text.includes('[语音]');
}

function isStickerEntry(entry: ParsedLogEntry) {
  return entry.text.includes('[动画表情]') || entry.text.includes('[QQ表情');
}

function sourceColor(s: string) {
  switch (s) {
    case 'qq': return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
    case 'wecom': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300';
    case 'feishu': return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300';
    case 'wechat': return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
    case 'system': return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    case 'openclaw': return 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300';
    case 'workflow': return 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300';
    default: return 'bg-gray-100 text-gray-600';
  }
}

function sourceLabel(s: string) {
  switch (s) {
    case 'qq': return 'QQ';
    case 'wecom': return '企微';
    case 'feishu': return '飞书';
    case 'wechat': return 'WeChat';
    case 'system': return '系统';
    case 'openclaw': return 'Bot';
    case 'workflow': return 'Workflow';
    default: return s;
  }
}

function roleLabel(role: MessageRole) {
  if (role === 'user') return '用户';
  if (role === 'bot') return '机器人';
  return '系统';
}

function roleChipTone(role: MessageRole) {
  if (role === 'user') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  if (role === 'bot') return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300';
  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
}

function messageTone(entry: ParsedLogEntry) {
  if (entry.role === 'user') return 'border-blue-100 bg-blue-50 text-blue-950 dark:border-blue-900/30 dark:bg-blue-950/20 dark:text-blue-50';
  if (entry.role === 'bot') return 'border-violet-100 bg-white text-slate-900 dark:border-violet-900/30 dark:bg-slate-900 dark:text-slate-50';
  return 'border-amber-100 bg-amber-50 text-amber-950 dark:border-amber-900/30 dark:bg-amber-950/20 dark:text-amber-50';
}

function formatLogTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default memo(ActivityLogPage);
