import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Bot, Check, Copy, Loader2, MessageSquarePlus, Send, Square, Trash2, Users } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import { useI18n } from '../i18n';

type PanelChatSession = {
  id: string;
  openclawSessionId: string;
  agentId: string;
  chatType: 'direct' | 'group';
  title: string;
  targetId?: string;
  targetName?: string;
  createdAt: number;
  updatedAt: number;
  processing?: boolean;
  messageCount: number;
  lastMessage?: string;
};

type PanelChatMessage = {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  sessionId?: string;
  images?: { src: string; mimeType?: string }[];
  agentId?: string;
  stage?: 'user' | 'plan' | 'dispatch' | 'report' | 'final';
};

type ChatMode = 'direct' | 'group';

type AgentOption = {
  id: string;
  name?: string;
};

function normalizeUserMessageContent(content: string) {
  return content.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function stageLabel(stage: PanelChatMessage['stage'], locale: string) {
  if (locale === 'en') {
    switch (stage) {
      case 'user': return 'User Request';
      case 'plan': return 'Main Agent Analysis';
      case 'dispatch': return 'Task Dispatch';
      case 'report': return 'Agent Reports';
      case 'final': return 'Main Agent Summary';
      default: return '';
    }
  }
  switch (stage) {
    case 'user': return '用户任务';
    case 'plan': return '主 Agent 分析';
    case 'dispatch': return '任务分派';
    case 'report': return 'Agent 回报';
    case 'final': return '主 Agent 汇总';
    default: return '';
  }
}

function agentBadgeTone(agentId: string) {
  const tones = [
    'border border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-200',
    'border border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200',
    'border border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200',
    'border border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-200',
  ];
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) hash = (hash + agentId.charCodeAt(i)) % tones.length;
  return tones[hash];
}

function buildMockGroupMessages(agentIds: string[], locale: string): PanelChatMessage[] {
  const now = Date.now();
  const mainAgent = agentIds[0] || 'main';
  const workers = agentIds.slice(1, 4);
  const list = workers.length > 0 ? workers : ['research', 'coding', 'qa'];
  const lines = locale === 'en'
    ? {
        user: 'Please prepare a coordinated plan for the next game patch. We need a spring version update with a new boss event, balance tuning for three classes, shop bundle refresh, and a low-risk rollout schedule for live servers.',
        mainPlan: `**${mainAgent}** received the patch request and split it into production tracks:\n\n- **${list[0]}**: review event content scope, boss mechanics, and reward pacing\n- **${list[1]}**: define combat balance adjustments and patch-note wording for the affected classes\n- **${list[2]}**: assess release risks, shop refresh timing, and live rollout safeguards`,
        workerA: `**${list[0]}**: Event proposal ready. The new seasonal boss should run as a 14-day limited event with three difficulty tiers, milestone rewards on days 3/7/14, and a story intro that reuses the current chapter hub to reduce asset risk.`,
        workerB: `**${list[1]}**: Balance draft ready. Warrior survivability can be reduced slightly in PvP, Mage burst should gain a longer cooldown window, and Ranger sustained damage needs a small uplift for raid viability. Patch notes should frame this as role differentiation rather than hard nerfs.`,
        workerC: `**${list[2]}**: Release risks are manageable if we stage the update: deploy data and store bundles first, enable the boss event behind a timed switch, and monitor payment, matchmaking, and boss clear-rate metrics in the first 2 hours.`,
        final: `**${mainAgent}**: Final rollout summary: launch the spring version in three phases - preload assets and store refresh, publish balance adjustments with clear notes, then open the seasonal boss event by switch control. This keeps monetization, gameplay, and live risk under separate checkpoints.`,
      }
    : {
        user: '请为下一次游戏版本更新准备一份协同方案：版本主题是春季庆典，需要上线新世界 Boss 活动、调整三个职业平衡、更新商城礼包，并给出一个适合正式服的低风险发布节奏。',
        mainPlan: `**${mainAgent}** 已接收版本更新任务，并拆分为具体工作流：\n\n- **${list[0]}**：梳理活动内容范围、Boss 机制与奖励节奏\n- **${list[1]}**：制定职业平衡调整方案，并整理公告文案口径\n- **${list[2]}**：评估上线风险、商城刷新时机与正式服灰度策略`,
        workerA: `**${list[0]}**：活动方案已整理。建议新世界 Boss 采用 14 天限时活动，设置 3 档难度，并在第 3 / 7 / 14 天发放阶段奖励；剧情入口复用现有章节大厅，可以显著降低资源制作风险。`,
        workerB: `**${list[1]}**：平衡草案已完成。战士在 PvP 的生存能力建议小幅下调，法师爆发保留但延长关键技能冷却窗口，游侠则提升持续输出能力，以增强团本存在感。公告中应强调“职业定位优化”，避免玩家直接理解为单纯削弱。`,
        workerC: `**${list[2]}**：上线风险可控，前提是分阶段发布：先预热资源和商城礼包，再推送平衡调整与版本说明，最后通过开关开放世界 Boss 活动，并在前 2 小时重点观察支付、匹配和 Boss 通关率指标。`,
        final: `**${mainAgent}**：我已汇总各 Agent 结果。建议春季版本按三阶段落地：先完成资源预加载与商城刷新，再发布平衡改动与说明公告，最后通过开关控制开放新 Boss 活动。这样能把商业、玩法和正式服风险拆开管理，便于逐段验证。`,
      };
  return [
    { id: 'group-user', role: 'user', content: lines.user, timestamp: new Date(now).toISOString(), sessionId: 'group-demo', stage: 'user' },
    { id: 'group-main-plan', role: 'assistant', agentId: mainAgent, content: lines.mainPlan, timestamp: new Date(now + 1000).toISOString(), sessionId: 'group-demo', stage: 'plan' },
    { id: 'group-worker-a', role: 'assistant', agentId: list[0], content: lines.workerA, timestamp: new Date(now + 2000).toISOString(), sessionId: 'group-demo', stage: 'dispatch' },
    { id: 'group-worker-b', role: 'assistant', agentId: list[1], content: lines.workerB, timestamp: new Date(now + 3000).toISOString(), sessionId: 'group-demo', stage: 'dispatch' },
    { id: 'group-worker-c', role: 'assistant', agentId: list[2], content: lines.workerC, timestamp: new Date(now + 4000).toISOString(), sessionId: 'group-demo', stage: 'report' },
    { id: 'group-main-final', role: 'assistant', agentId: mainAgent, content: lines.final, timestamp: new Date(now + 5000).toISOString(), sessionId: 'group-demo', stage: 'final' },
  ];
}

export default function PanelChat() {
  const { uiMode } = (useOutletContext() as { uiMode?: 'modern' }) || {};
  const { locale } = useI18n();
  const modern = uiMode === 'modern';
  const [sessions, setSessions] = useState<PanelChatSession[]>([]);
  const [chatMode, setChatMode] = useState<ChatMode>('direct');
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<PanelChatMessage[]>([]);
  const [groupSessions, setGroupSessions] = useState<PanelChatSession[]>([]);
  const [groupMessages, setGroupMessages] = useState<Record<string, PanelChatMessage[]>>({});
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [processingSessionId, setProcessingSessionId] = useState('');
  const [booting, setBooting] = useState(true);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [highlightedId, setHighlightedId] = useState('');
  const [pendingUserMessage, setPendingUserMessage] = useState<PanelChatMessage | null>(null);
  const [errorText, setErrorText] = useState('');
  const [copiedCode, setCopiedCode] = useState('');
  const [abortedMarkers, setAbortedMarkers] = useState<Record<string, PanelChatMessage[]>>({});
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const previousAssistantRef = useRef('');
  const selectedIdRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const abortMarkerHandledRef = useRef<Record<string, boolean>>({});
  const activeRequestIdRef = useRef(0);

  const text = useMemo(() => {
    if (locale === 'en') {
      return {
        title: 'Panel Chat',
        subtitle: 'Talk to the local OpenClaw agent directly in the panel. Single-chat first, with group-chat structure reserved.',
        direct: 'Direct chat',
        group: 'Group chat (reserved)',
        newChat: 'New chat',
        emptyTitle: 'Start a local OpenClaw conversation',
        emptyDesc: 'Configure a model first, then chat with OpenClaw here directly.',
        hint: 'OpenClaw can use local files, workspace context, and installed skills here just like its native local mode.',
        input: 'Ask OpenClaw to analyze files, edit code, or use installed skills...',
        groupInput: 'Coming soon.',
        sending: 'Sending...',
        stop: 'Stop',
        processing: 'OpenClaw is thinking...',
        processingHint: '',
        send: 'Send',
        delete: 'Delete',
        rename: 'Rename',
        renamePlaceholder: 'Session title',
        loading: 'Loading...',
        failedLoad: 'Failed to load chat data. Refresh and try again.',
        failedCreate: 'Failed to create a chat session.',
        failedDetail: 'Failed to load conversation detail.',
        failedSend: 'Send failed. Your draft has been restored.',
        failedRename: 'Rename failed.',
        failedDelete: 'Delete failed.',
        copy: 'Copy',
        copied: 'Copied',
        enterHint: 'Enter to send, Shift + Enter for newline',
        deleteConfirm: 'Delete this panel chat session?',
        noSessions: 'No panel chats yet',
        noMessages: 'No messages yet',
      };
    }
    return {
      title: '面板聊天',
      subtitle: '直接在面板里和本地 OpenClaw 交互。',
      direct: '单聊',
      group: '群聊（预留）',
      newChat: '新建会话',
      emptyTitle: '开始一段本地 OpenClaw 对话',
      emptyDesc: '先在系统配置里配好模型，然后就可以在这里与OpenClaw直接聊天。',
      hint: '这里会直接调用本地 OpenClaw，能继续使用它已安装的技能、工作区上下文和本地文件能力。',
      input: '给 OpenClaw 发消息，比如让它分析文件、修改代码或调用已安装技能...',
      groupInput: '即将上线，敬请期待',
      sending: '发送中...',
      stop: '中止',
      processing: 'OpenClaw 思考中...',
      processingHint: '',
      send: '发送',
      delete: '删除',
      rename: '重命名',
      renamePlaceholder: '会话标题',
      loading: '加载中...',
      failedLoad: '聊天数据加载失败，请刷新后重试。',
      failedCreate: '创建会话失败。',
      failedDetail: '加载会话详情失败。',
      failedSend: '发送失败，已恢复你的输入内容。',
      failedRename: '重命名失败。',
      failedDelete: '删除失败。',
      copy: '复制',
      copied: '已复制',
      enterHint: 'Enter 发送，Shift + Enter 换行',
      deleteConfirm: '确定删除当前面板会话吗？',
      noSessions: '还没有面板会话',
      noMessages: '还没有消息',
    };
  }, [locale]);

  const displayedSessions = chatMode === 'group' ? groupSessions : sessions;
  const selectedSession = displayedSessions.find(item => item.id === selectedId) || null;
  const liveMessages = chatMode === 'group' ? (groupMessages[selectedId] || []) : messages;
  const processing = chatMode === 'direct' && ((!!selectedId && processingSessionId === selectedId) || !!selectedSession?.processing);
  const interactionLocked = loading || !!processingSessionId || creating;
  const sessionSwitchLocked = creating;
  const timelineMessages = useMemo(() => {
    const pending = chatMode === 'direct' && pendingUserMessage && pendingUserMessage.sessionId === selectedId && !liveMessages.some(item => item.role === 'user' && normalizeUserMessageContent(item.content) === normalizeUserMessageContent(pendingUserMessage.content)) ? [pendingUserMessage] : [];
    return [...liveMessages, ...(chatMode === 'direct' ? (abortedMarkers[selectedId] || []) : []), ...pending].sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      if (ta === tb) return a.id.localeCompare(b.id);
      return ta - tb;
    });
  }, [abortedMarkers, chatMode, liveMessages, pendingUserMessage, selectedId]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    setDraftTitle(selectedSession?.title || '');
  }, [selectedSession?.id, selectedSession?.title]);

  useEffect(() => {
    if (!selectedSession) {
      setRenaming(false);
    }
  }, [selectedSession]);

  useEffect(() => {
    if (!pendingUserMessage || pendingUserMessage.sessionId !== selectedId) return;
    const matched = liveMessages.some(item => item.role === 'user' && normalizeUserMessageContent(item.content) === normalizeUserMessageContent(pendingUserMessage.content));
    if (matched) {
      setPendingUserMessage(null);
    }
  }, [liveMessages, pendingUserMessage, selectedId]);

  const loadSessions = useCallback(async (preferredId?: string) => {
    const res = await api.getPanelChatSessions();
    if (!res?.ok) {
      setErrorText(text.failedLoad);
      return;
    }
    const next = Array.isArray(res.sessions) ? res.sessions : [];
    setErrorText('');
    setSessions(next);
    setSelectedId(current => {
      if (preferredId && next.some((item: PanelChatSession) => item.id === preferredId)) return preferredId;
      if (current && next.some((item: PanelChatSession) => item.id === current)) return current;
      return next[0]?.id || '';
    });
  }, [text.failedLoad]);

  const ensureGroupDemoSession = useCallback((agentList: AgentOption[]) => {
    const workerIds = agentList.map(item => item.id).filter(Boolean);
    const demoSession: PanelChatSession = {
      id: 'group-demo',
      openclawSessionId: 'group-demo',
      agentId: workerIds[0] || 'main',
      chatType: 'group',
      title: locale === 'en' ? 'Multi-Agent Demo' : '多 Agent 协作演示',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 6,
      lastMessage: locale === 'en' ? 'Main agent completed the orchestration summary.' : '主 Agent 已完成协作汇总。',
    };
    setGroupSessions([demoSession]);
    setGroupMessages({ 'group-demo': buildMockGroupMessages(workerIds, locale) });
    return demoSession.id;
  }, [locale]);

  const loadAgents = useCallback(async () => {
    try {
      const res = await api.getAgentsConfig();
      const list = Array.isArray(res?.agents?.list) ? res.agents.list : [];
      const normalized = list.map((item: any) => ({ id: String(item?.id || '').trim(), name: String(item?.name || '').trim() })).filter((item: AgentOption) => item.id);
      setAgents(normalized);
      ensureGroupDemoSession(normalized);
    } catch {
      const fallback = [{ id: 'main' }, { id: 'planner' }, { id: 'coder' }, { id: 'reviewer' }];
      setAgents(fallback);
      ensureGroupDemoSession(fallback);
    }
  }, [ensureGroupDemoSession]);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) {
      setMessages([]);
      return;
    }
    const res = await api.getPanelChatSessionDetail(id);
    if (!res?.ok) {
      setErrorText(text.failedDetail);
      return;
    }
    setErrorText('');
    setMessages(Array.isArray(res.messages) ? res.messages : []);
    setPendingUserMessage(null);
  }, [text.failedDetail]);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadSessions(), loadAgents()]);
      } finally {
        setBooting(false);
      }
    })();
  }, [loadAgents, loadSessions]);

  useEffect(() => {
    if (chatMode === 'group') return;
    loadDetail(selectedId);
  }, [chatMode, loadDetail, selectedId]);

  useEffect(() => {
    const container = messageListRef.current;
    if (!container) return;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }, [messages, pendingUserMessage, processing]);

  useEffect(() => {
    const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
    if (!lastAssistant) return;
    if (lastAssistant.id !== previousAssistantRef.current) {
      previousAssistantRef.current = lastAssistant.id;
      setHighlightedId(lastAssistant.id);
      const timer = window.setTimeout(() => setHighlightedId(current => current === lastAssistant.id ? '' : current), 3500);
      return () => window.clearTimeout(timer);
    }
  }, [messages]);

  const createSession = useCallback(async () => {
    if (creating) return '';
    setCreating(true);
    setErrorText('');
    try {
      const res = await api.createPanelChatSession({ chatType: 'direct' });
      if (!res?.ok || !res.session?.id) {
        setErrorText(text.failedCreate);
        return '';
      }
      await loadSessions(res.session.id);
      setSelectedId(res.session.id);
      setMessages([]);
      return res.session.id as string;
    } finally {
      setCreating(false);
    }
  }, [creating, loadSessions, text.failedCreate]);

  const appendAbortMarker = useCallback((sessionId: string) => {
    if (abortMarkerHandledRef.current[sessionId]) return;
    abortMarkerHandledRef.current[sessionId] = true;
    const marker: PanelChatMessage = {
      id: `abort-${Date.now()}`,
      role: 'system',
      content: locale === 'en' ? 'Generation stopped' : '已中止',
      timestamp: new Date().toISOString(),
      sessionId,
    };
    setAbortedMarkers(current => ({
      ...current,
      [sessionId]: [...(current[sessionId] || []), marker],
    }));
  }, [locale]);

  const handleAbort = useCallback(() => {
    const sessionId = processingSessionId || selectedIdRef.current;
    if (!sessionId) return;
    activeRequestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    void api.cancelPanelChatMessage(sessionId);
    setProcessingSessionId('');
    setLoading(false);
    setPendingUserMessage(null);
    appendAbortMarker(sessionId);
  }, [appendAbortMarker, processingSessionId]);

  const handleSend = useCallback(async () => {
    const message = input.trim();
    if (!message || loading) return;
    let sessionId = selectedId;
    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;
    setErrorText('');
    setLoading(true);
    setInput('');
    try {
      if (!sessionId) {
        sessionId = await createSession();
      }
      if (!sessionId) return;
      setPendingUserMessage({
        id: `pending-user-${Date.now()}`,
        role: 'user',
        content: message,
        timestamp: new Date().toISOString(),
        sessionId,
      });
      setProcessingSessionId(sessionId);
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const token = localStorage.getItem('admin-token') || '';
      const response = await fetch(`/api/panel-chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      const res = await response.json();
      abortControllerRef.current = null;
      if (activeRequestIdRef.current !== requestId) return;
      if (res?.ok) {
        abortMarkerHandledRef.current[sessionId] = false;
        if (selectedIdRef.current === sessionId) {
          setMessages(Array.isArray(res.messages) ? res.messages : []);
          setPendingUserMessage(null);
        }
        await loadSessions(sessionId);
      } else if (res?.canceled) {
        appendAbortMarker(sessionId);
        await loadSessions(sessionId);
      } else {
        if (selectedIdRef.current === sessionId) {
          setPendingUserMessage(null);
        }
        setInput(message);
        setErrorText(res?.error || text.failedSend);
      }
    } catch (error: any) {
      abortControllerRef.current = null;
      if (activeRequestIdRef.current !== requestId) return;
      if (error?.name === 'AbortError') {
        if (sessionId) appendAbortMarker(sessionId);
        return;
      }
      setPendingUserMessage(null);
      setInput(message);
      setErrorText(text.failedSend);
    } finally {
      if (activeRequestIdRef.current !== requestId) return;
      if (sessionId) {
        if (!processingSessionId || processingSessionId === sessionId) {
          abortMarkerHandledRef.current[sessionId] = false;
        }
        setProcessingSessionId(current => current === sessionId ? '' : current);
      }
      setLoading(false);
    }
  }, [appendAbortMarker, createSession, input, loadSessions, loading, selectedId, text.failedSend]);

  const handleDelete = useCallback(async () => {
    if (!selectedSession || interactionLocked || !window.confirm(text.deleteConfirm)) return;
    if (chatMode === 'group') {
      setGroupSessions([]);
      setGroupMessages({});
      setSelectedId('');
      setMessages([]);
      return;
    }
    const deletingId = selectedSession.id;
    const fallback = sessions.find(item => item.id !== deletingId)?.id || '';
    const res = await api.deletePanelChatSession(deletingId);
    if (!res?.ok) {
      setErrorText(text.failedDelete);
      return;
    }
    setErrorText('');
    setSelectedId(fallback);
    if (!fallback) setMessages([]);
    await loadSessions(fallback);
  }, [chatMode, interactionLocked, loadSessions, selectedSession, sessions, text.deleteConfirm, text.failedDelete]);

  const handleRename = useCallback(async () => {
    if (!selectedSession) return;
    if (chatMode === 'group') {
      const title = draftTitle.trim() || selectedSession.title;
      setGroupSessions(current => current.map(item => item.id === selectedSession.id ? { ...item, title } : item));
      setRenaming(false);
      return;
    }
    const title = draftTitle.trim();
    if (!title || title === selectedSession.title) {
      setRenaming(false);
      setDraftTitle(selectedSession.title);
      return;
    }
    const res = await api.renamePanelChatSession(selectedSession.id, title);
    if (!res?.ok) {
      setErrorText(text.failedRename);
      return;
    }
    setErrorText('');
    setRenaming(false);
    await loadSessions(selectedSession.id);
  }, [chatMode, draftTitle, loadSessions, selectedSession, text.failedRename]);

  const handleCopyCode = useCallback(async (content: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        throw new Error('clipboard api unavailable');
      }
      setCopiedCode(content);
      window.setTimeout(() => {
        setCopiedCode(current => current === content ? '' : current);
      }, 1800);
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = content;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) throw new Error('execCommand failed');
        setCopiedCode(content);
        window.setTimeout(() => {
          setCopiedCode(current => current === content ? '' : current);
        }, 1800);
      } catch {
        setErrorText(locale === 'en' ? 'Copy failed.' : '复制失败。');
      }
    }
  }, [locale]);

  return (
    <div className={`flex h-full min-h-0 flex-col gap-4 ${modern ? 'page-modern' : ''}`}>
      <section className={modern ? 'page-modern-header shrink-0' : 'ui-modern-card flex flex-wrap items-start justify-between gap-4 p-5'}>
        <div>
          <h2 className={modern ? 'page-modern-title text-xl' : 'text-xl font-bold text-gray-900 dark:text-white'}>{text.title}</h2>
          <p className={modern ? 'page-modern-subtitle mt-1 text-sm' : 'text-sm text-gray-500 mt-1'}>{text.subtitle}</p>
        </div>
        <div className="flex items-center gap-2 rounded-2xl border border-blue-100 bg-blue-50/80 px-3 py-2 text-xs text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200">
          <Bot size={14} />
          <span>{text.hint}</span>
        </div>
      </section>

      {errorText && (
        <section className="ui-modern-card border border-rose-200 bg-rose-50/90 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
          {errorText}
        </section>
      )}

      <section className={`grid min-h-0 flex-1 gap-4 ${modern ? 'xl:grid-cols-[320px_minmax(0,1fr)]' : 'lg:grid-cols-[320px_minmax(0,1fr)]'}`}>
        <aside className={`${modern ? 'page-modern-panel' : 'ui-modern-card'} flex min-h-[240px] flex-col overflow-hidden p-0`}>
          <div className="shrink-0 border-b border-slate-200/70 bg-white/80 px-4 py-4 dark:border-slate-700/70 dark:bg-slate-950/40">
            <div className="flex items-center justify-between gap-3">
              <div className="flex gap-2 text-xs">
                <button type="button" onClick={() => { setChatMode('direct'); setSelectedId(sessions[0]?.id || ''); }} className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition ${chatMode === 'direct' ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200' : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900'}`}>{text.direct}</button>
                <button type="button" onClick={() => { const nextId = groupSessions[0]?.id || ensureGroupDemoSession(agents); setChatMode('group'); setSelectedId(nextId); }} className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition ${chatMode === 'group' ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200' : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900'}`}>{text.group}</button>
              </div>
              <button onClick={chatMode === 'group' ? () => { const nextId = ensureGroupDemoSession(agents); setSelectedId(nextId); } : createSession} disabled={interactionLocked} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100">
                {creating ? <Loader2 size={14} className="animate-spin" /> : <MessageSquarePlus size={14} />}
                {text.newChat}
              </button>
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{displayedSessions.length}</span>
              <span>会话</span>
              {selectedSession && <span className={`rounded-full px-2 py-1 ${agentBadgeTone(selectedSession.agentId)}`}>{selectedSession.agentId}</span>}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/70 p-3 dark:bg-slate-950/30">
            {booting ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400"><Loader2 size={16} className="mr-2 animate-spin" />{text.loading}</div>
            ) : displayedSessions.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-400">{text.noSessions}</div>
            ) : (
              <div className="space-y-2">
                {displayedSessions.map(session => (
                  <button
                    key={session.id}
                    onClick={() => {
                      if (sessionSwitchLocked) return;
                      setErrorText('');
                      setSelectedId(session.id);
                    }}
                    disabled={sessionSwitchLocked}
                    className={`w-full rounded-2xl border px-3 py-3 text-left transition ${selectedId === session.id ? 'border-blue-200 bg-blue-50 shadow-sm ring-1 ring-blue-100 dark:border-blue-500/40 dark:bg-blue-500/12 dark:ring-blue-500/20' : 'border-transparent bg-white/75 hover:border-slate-200 hover:bg-white dark:bg-slate-900/30 dark:hover:border-slate-800 dark:hover:bg-slate-900/55'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`truncate text-sm font-semibold ${selectedId === session.id ? 'text-blue-900 dark:text-blue-100' : 'text-slate-800 dark:text-slate-100'}`}>{session.title || text.newChat}</span>
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-500 dark:border-slate-600 dark:bg-transparent dark:text-slate-300">{session.chatType === 'group' ? <Users size={12} className="inline-block" /> : text.direct}</span>
                    </div>
                    <p className={`mt-1 line-clamp-2 text-xs ${selectedId === session.id ? 'text-blue-700 dark:text-blue-200' : 'text-slate-500 dark:text-slate-400'}`}>{session.processing ? text.processing : (session.lastMessage || `Agent: ${session.agentId}`)}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <div className={`${modern ? 'page-modern-panel' : 'ui-modern-card'} flex min-h-[480px] min-w-0 flex-col overflow-hidden p-0`}>
          <div className="flex items-center justify-between border-b border-slate-200/70 bg-white/80 px-5 py-4 dark:border-slate-700/70 dark:bg-slate-950/40">
            <div>
              {renaming && selectedSession ? (
                <div className="flex items-center gap-2">
                  <input value={draftTitle} onChange={event => setDraftTitle(event.target.value)} onKeyDown={event => {
                    if (event.key === 'Enter') void handleRename();
                    if (event.key === 'Escape') { setRenaming(false); setDraftTitle(selectedSession.title); }
                  }} placeholder={text.renamePlaceholder} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
                  <button onClick={() => void handleRename()} className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-medium text-white dark:bg-white dark:text-slate-900">OK</button>
                </div>
              ) : (
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">{selectedSession?.title || text.emptyTitle}</h3>
              )}
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{selectedSession ? `Agent: ${selectedSession.agentId} · ${selectedSession.chatType}` : text.emptyDesc}</p>
              {processing && <p className="mt-1 text-xs font-medium text-blue-600 dark:text-blue-300">{text.processing}</p>}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setRenaming(value => !value)} disabled={!selectedSession || interactionLocked} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900">{text.rename}</button>
              <button onClick={handleDelete} disabled={!selectedSession || interactionLocked} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900">
                <Trash2 size={14} />
                {text.delete}
              </button>
            </div>
          </div>

          <div ref={messageListRef} className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.08),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.16),transparent_36%)] px-5 py-5 dark:bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.03),transparent_36%)]">
            {timelineMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-400">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-blue-100 bg-white/80 text-blue-500 shadow-sm dark:border-blue-500/20 dark:bg-slate-900/70 dark:text-blue-200">
                  <Bot size={28} />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-300">{selectedSession ? text.noMessages : text.emptyTitle}</p>
                  <p className="mt-1 text-xs">{text.emptyDesc}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {timelineMessages.map((message, index) => {
                  const isUser = message.role === 'user';
                  const isSystem = message.role === 'system';
                  const showStageDivider = chatMode === 'group' && !!message.stage && (index === 0 || timelineMessages[index - 1]?.stage !== message.stage);
                  return (
                    <Fragment key={message.id}>
                    {showStageDivider && (
                      <div key={`${message.id}-stage`} className="my-2 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400 dark:text-slate-500">
                        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                        <span>{stageLabel(message.stage, locale)}</span>
                        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                      </div>
                    )}
                    <div className={`flex gap-3 ${isSystem ? 'justify-center' : isUser ? 'justify-end' : 'justify-start'}`}>
                      {isSystem ? (
                        <div className="my-2 flex w-full items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
                          <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                          <span className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 font-medium dark:border-slate-700 dark:bg-slate-900">{message.content}</span>
                          <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                        </div>
                      ) : (
                        <>
                      {!isUser && <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"><Bot size={15} /></div>}
                      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm transition ${isUser ? 'rounded-tr-sm bg-[linear-gradient(135deg,#1d4ed8,#0284c7)] text-right text-white shadow-blue-200/50 dark:shadow-none' : 'rounded-tl-sm border border-slate-200/70 bg-white/95 text-slate-700 dark:border-slate-700/70 dark:bg-slate-900/92 dark:text-slate-200'} ${highlightedId === message.id ? 'ring-2 ring-blue-300 dark:ring-blue-500/50' : ''}`}>
                        {!isUser && chatMode === 'group' && message.agentId && (
                          <div className="mb-2 flex items-center gap-2 text-[11px]">
                            <span className={`rounded-full px-2.5 py-1 font-semibold ${agentBadgeTone(message.agentId)}`}>{message.agentId}</span>
                            {message.agentId === (agents[0]?.id || 'main') && <span className="text-slate-400 dark:text-slate-500">{locale === 'en' ? 'Lead Agent' : '主 Agent'}</span>}
                          </div>
                        )}
                        {isUser ? message.content : (
                          <>
                            {message.content && (
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                                  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
                                  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
                                  code: ({ className, children, ...props }: any) => {
                                    const isBlock = Boolean(className);
                                    return isBlock
                                      ? <code className="block text-[13px] text-slate-100">{children}</code>
                                      : <code className="rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[13px] text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" {...props}>{children}</code>;
                                  },
                                  pre: ({ children }) => {
                                    const raw = String((children as any)?.props?.children ?? '').replace(/\n$/, '');
                                    const copied = copiedCode === raw;
                                    return (
                                      <div className="my-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-900 shadow-sm dark:border-slate-700">
                                        <div className="flex items-center justify-between border-b border-slate-700/80 bg-slate-800/95 px-3 py-2 text-xs text-slate-300">
                                          <span>shell</span>
                                          <button
                                            type="button"
                                            onClick={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              void handleCopyCode(raw);
                                            }}
                                            className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 text-slate-200 transition hover:bg-slate-700"
                                          >
                                            {copied ? <Check size={12} /> : <Copy size={12} />}
                                            {copied ? text.copied : text.copy}
                                          </button>
                                        </div>
                                        <pre className="overflow-x-auto px-3 py-3 text-[13px] leading-6 text-slate-100">{children}</pre>
                                      </div>
                                    );
                                  },
                                }}
                              >
                                {message.content}
                              </ReactMarkdown>
                            )}
                            {Array.isArray(message.images) && message.images.length > 0 && (
                              <div className="mt-3 space-y-3">
                                {message.images.map((image, index) => (
                                  <a key={`${message.id}-image-${index}`} href={image.src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md dark:border-slate-700 dark:bg-slate-950">
                                    <img src={image.src} alt={`assistant-image-${index + 1}`} className="max-h-[420px] w-full object-contain bg-slate-50 dark:bg-slate-950" loading="lazy" />
                                  </a>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                        <div className={`mt-2 text-[11px] ${isUser ? 'text-white/75' : 'text-slate-400 dark:text-slate-500'}`}>{new Date(message.timestamp).toLocaleString()}</div>
                      </div>
                        </>
                      )}
                    </div>
                    </Fragment>
                  );
                })}
                {processing && (
                  <div className="flex gap-3 justify-start">
                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"><Bot size={15} /></div>
                    <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-dashed border-blue-200 bg-white/90 px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm animate-pulse dark:border-blue-500/30 dark:bg-slate-900/90 dark:text-slate-200">
                      <div className="flex items-center gap-1.5 text-blue-500 dark:text-blue-300">
                        <span className="h-2 w-2 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
                        <span className="h-2 w-2 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
                        <span className="h-2 w-2 rounded-full bg-current animate-bounce" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-slate-200/70 bg-white/85 px-5 py-4 dark:border-slate-700/70 dark:bg-slate-950/60">
            <div className="rounded-3xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-700 dark:bg-slate-950/90">
              <textarea
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
                rows={3}
                placeholder={chatMode === 'group' ? text.groupInput : text.input}
                disabled={chatMode === 'group'}
                className="w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-slate-400 dark:text-slate-100"
              />
              <div className="flex items-center justify-between px-2 pb-1 pt-2">
                <div className="text-xs text-slate-400">{text.enterHint}</div>
                <button onClick={loading ? handleAbort : handleSend} disabled={chatMode === 'group' || creating || (!loading && !input.trim())} className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${loading ? 'bg-rose-600 hover:bg-rose-500 dark:bg-rose-500 dark:text-white dark:hover:bg-rose-400' : 'bg-slate-900 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100'}`}>
                  {loading ? <Square size={15} fill="currentColor" /> : <Send size={16} />}
                  {loading ? text.stop : text.send}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
