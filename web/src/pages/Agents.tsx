import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Plus, RefreshCw, Save, Trash2, ArrowUp, ArrowDown, Route, Bot, Settings } from 'lucide-react';

interface AgentItem {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: any;
  tools?: any;
  sandbox?: any;
  groupChat?: any;
  identity?: any;
  subagents?: any;
  params?: any;
  default?: boolean;
  sessions?: number;
  lastActive?: number;
}

interface AgentFormState {
  id: string;
  name: string;
  workspace: string;
  agentDir: string;
  isDefault: boolean;
  modelText: string;
  toolsText: string;
  sandboxText: string;
  groupChatText: string;
  identityText: string;
  subagentsText: string;
  paramsText: string;
}

interface BindingDraft {
  name: string;
  agent: string;
  enabled: boolean;
  match: Record<string, any>;
  matchText: string;
  mode: 'structured' | 'json';
  rowError?: string;
}

interface PreviewResult {
  agent?: string;
  matchedBy?: string;
  trace?: string[];
}

interface ChannelMeta {
  accounts: string[];
  defaultAccount?: string;
}

const ALLOWED_MATCH_KEYS = ['channel', 'sender', 'peer', 'parentPeer', 'guildId', 'teamId', 'accountId', 'roles'];

function isPlainObject(v: any): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function splitPeer(raw: string): { kind: string; id: string } {
  const text = (raw || '').trim();
  if (!text) return { kind: '', id: '' };
  const parts = text.split(':');
  if (parts.length <= 1) return { kind: parts[0].trim(), id: '' };
  return { kind: parts[0].trim(), id: parts.slice(1).join(':').trim() };
}

function normalizePeerValue(v: any): { kind: string; id: string } | null {
  if (typeof v === 'string') {
    const out = splitPeer(v);
    if (!out.kind) return null;
    return out;
  }
  if (isPlainObject(v)) {
    const kind = String(v.kind ?? v.type ?? '').trim();
    let id = String(v.id ?? '').trim();
    if (!kind && typeof v.raw === 'string') {
      const out = splitPeer(v.raw);
      if (!out.kind) return null;
      return out;
    }
    if (!kind) return null;
    if (!id && typeof v.raw === 'string') {
      const out = splitPeer(v.raw);
      id = out.id;
    }
    return { kind, id };
  }
  return null;
}

function compactMatch(raw: any): Record<string, any> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, any> = {};
  for (const key of ALLOWED_MATCH_KEYS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (v === undefined || v === null) continue;

    if (key === 'peer' || key === 'parentPeer') {
      if (isPlainObject(v)) {
        const peer = normalizePeerValue(v);
        if (!peer || !peer.kind) continue;
        out[key] = peer.id ? { kind: peer.kind, id: peer.id } : { kind: peer.kind };
        continue;
      }
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) continue;
        out[key] = s;
        continue;
      }
      if (Array.isArray(v)) {
        const arr = v.map(item => String(item).trim()).filter(Boolean);
        if (arr.length > 0) out[key] = arr;
      }
      continue;
    }

    if (Array.isArray(v)) {
      const arr = v.map(item => String(item).trim()).filter(Boolean);
      if (arr.length > 0) out[key] = arr;
      continue;
    }

    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      out[key] = s;
      continue;
    }

    out[key] = v;
  }
  return out;
}

function isStructuredMatchSupported(match: Record<string, any>): boolean {
  if (!isPlainObject(match)) return false;
  for (const key of Object.keys(match)) {
    if (!ALLOWED_MATCH_KEYS.includes(key)) return false;
    const v = match[key];
    if (key === 'roles') {
      if (typeof v === 'string') continue;
      if (Array.isArray(v) && v.every(item => typeof item === 'string')) continue;
      return false;
    }
    if (key === 'peer' || key === 'parentPeer') {
      if (typeof v === 'string') continue;
      if (isPlainObject(v)) {
        if (normalizePeerValue(v)) continue;
        return false;
      }
      return false;
    }
    if (typeof v === 'string') continue;
    return false;
  }
  return true;
}

function toBindingDraft(raw: any, fallbackAgent: string): BindingDraft {
  const match = compactMatch(isPlainObject(raw?.match) ? deepClone(raw.match) : {});
  const mode: 'structured' | 'json' = isStructuredMatchSupported(match) ? 'structured' : 'json';
  return {
    name: String(raw?.name || ''),
    agent: String(raw?.agentId || raw?.agent || fallbackAgent || 'main'),
    enabled: raw?.enabled !== false,
    match,
    mode,
    matchText: JSON.stringify(match, null, 2),
    rowError: '',
  };
}

function hasWildcard(raw: any): boolean {
  if (typeof raw === 'string') {
    const s = raw.trim();
    return /[*?\[\]]/.test(s);
  }
  if (Array.isArray(raw)) {
    return raw.some(hasWildcard);
  }
  return false;
}

function parseCSV(input: string): string[] {
  return (input || '').split(',').map(x => x.trim()).filter(Boolean);
}

function matchPriorityLabel(matchRaw: any): string {
  const match = compactMatch(matchRaw);
  if ('sender' in match) return 'sender';
  if ('peer' in match) return 'peer';
  if ('parentPeer' in match) return 'parentPeer';
  if ('guildId' in match && 'roles' in match) return 'guildId+roles';
  if ('guildId' in match) return 'guildId';
  if ('teamId' in match) return 'teamId';
  if ('accountId' in match) return hasWildcard(match.accountId) ? 'accountId:*' : 'accountId';
  if ('channel' in match) return 'channel';
  return 'generic';
}

function validateBindingMatchClient(matchRaw: any, idx: number): string | null {
  if (!isPlainObject(matchRaw)) {
    return `第 ${idx} 条 binding 的 match 必须是对象`;
  }
  for (const key of Object.keys(matchRaw)) {
    if (!ALLOWED_MATCH_KEYS.includes(key)) {
      return `第 ${idx} 条 binding 使用了不支持字段: ${key}`;
    }
  }
  const match = compactMatch(matchRaw);
  if (!('channel' in match)) {
    return `第 ${idx} 条 binding 缺少 match.channel`;
  }
  for (const key of Object.keys(match)) {
    if (key === 'roles' && !('guildId' in match)) {
      return `第 ${idx} 条 binding 的 roles 必须与 guildId 同时使用`;
    }
    if ((key === 'peer' || key === 'parentPeer') && isPlainObject(match[key])) {
      const peer = normalizePeerValue(match[key]);
      if (!peer || !peer.kind) {
        return `第 ${idx} 条 binding 的 ${key}.kind 不能为空`;
      }
    }
  }
  return null;
}

function extractTextValue(v: any): string {
  if (typeof v === 'string') return v;
  return '';
}

function extractRolesText(match: Record<string, any>): string {
  const raw = match.roles;
  if (Array.isArray(raw)) return raw.map(x => String(x).trim()).filter(Boolean).join(', ');
  if (typeof raw === 'string') return raw;
  return '';
}

function extractPeerForm(match: Record<string, any>, key: 'peer' | 'parentPeer'): { kind: string; id: string } {
  const peer = normalizePeerValue(match[key]);
  return peer || { kind: '', id: '' };
}

function parseChannelsMeta(raw: any): Record<string, ChannelMeta> {
  const out: Record<string, ChannelMeta> = {};
  if (!isPlainObject(raw)) return out;

  for (const [channel, cfgRaw] of Object.entries(raw)) {
    const channelID = String(channel || '').trim();
    if (!channelID) continue;
    const cfg = isPlainObject(cfgRaw) ? cfgRaw : {};
    const accountsObj = isPlainObject(cfg.accounts) ? cfg.accounts : {};
    const accounts = Object.keys(accountsObj).map(x => x.trim()).filter(Boolean).sort();
    let defaultAccount = String(cfg.defaultAccount || '').trim();
    if (!defaultAccount) {
      if (accounts.includes('default')) defaultAccount = 'default';
      else if (accounts.length > 0) defaultAccount = accounts[0];
    }
    out[channelID] = { accounts, defaultAccount: defaultAccount || undefined };
  }

  return out;
}

export default function Agents() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const [defaultAgent, setDefaultAgent] = useState('main');
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [bindings, setBindings] = useState<BindingDraft[]>([]);
  const [channelMeta, setChannelMeta] = useState<Record<string, ChannelMeta>>({});

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<AgentFormState>({
    id: '',
    name: '',
    workspace: '',
    agentDir: '',
    isDefault: false,
    modelText: '',
    toolsText: '',
    sandboxText: '',
    groupChatText: '',
    identityText: '',
    subagentsText: '',
    paramsText: '',
  });

  const [previewMeta, setPreviewMeta] = useState<Record<string, string>>({
    channel: '',
    sender: '',
    peer: '',
    parentPeer: '',
    guildId: '',
    teamId: '',
    accountId: '',
    roles: '',
  });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);

  const agentOptions = useMemo(() => {
    return agents.map(a => a.id).filter(Boolean);
  }, [agents]);

  const channelOptions = useMemo(() => {
    return Object.keys(channelMeta).sort();
  }, [channelMeta]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [agentsRes, channelsRes] = await Promise.all([
        api.getAgentsConfig(),
        api.getChannels(),
      ]);

      if (agentsRes?.ok) {
        const data = agentsRes.agents || {};
        const list: AgentItem[] = data.list || [];
        const incomingBindings = (data.bindings || []) as any[];
        const fallback = data.default || 'main';
        setDefaultAgent(fallback);
        setAgents(list);
        setBindings(incomingBindings.map((b: any) => toBindingDraft(b, fallback)));
      } else {
        setDefaultAgent('main');
        setAgents([]);
        setBindings([]);
      }

      if (channelsRes?.ok) {
        setChannelMeta(parseChannelsMeta(channelsRes.channels || {}));
      } else {
        setChannelMeta({});
      }
    } catch {
      setDefaultAgent('main');
      setAgents([]);
      setBindings([]);
      setChannelMeta({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({
      id: '',
      name: '',
      workspace: '',
      agentDir: '',
      isDefault: false,
      modelText: '',
      toolsText: '',
      sandboxText: '',
      groupChatText: '',
      identityText: '',
      subagentsText: '',
      paramsText: '',
    });
    setShowForm(true);
  };

  const openEdit = (agent: AgentItem) => {
    setEditingId(agent.id);
    setForm({
      id: agent.id,
      name: agent.name || '',
      workspace: agent.workspace || '',
      agentDir: agent.agentDir || '',
      isDefault: !!agent.default,
      modelText: agent.model ? JSON.stringify(agent.model, null, 2) : '',
      toolsText: agent.tools ? JSON.stringify(agent.tools, null, 2) : '',
      sandboxText: agent.sandbox ? JSON.stringify(agent.sandbox, null, 2) : '',
      groupChatText: agent.groupChat ? JSON.stringify(agent.groupChat, null, 2) : '',
      identityText: agent.identity ? JSON.stringify(agent.identity, null, 2) : '',
      subagentsText: agent.subagents ? JSON.stringify(agent.subagents, null, 2) : '',
      paramsText: agent.params ? JSON.stringify(agent.params, null, 2) : '',
    });
    setShowForm(true);
  };

  const parseJSONText = (raw: string, fieldName: string) => {
    const text = raw.trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`${fieldName} JSON 格式错误: ${String(err)}`);
    }
  };

  const saveAgent = async () => {
    const id = form.id.trim();
    if (!id) {
      setMsg('Agent ID 不能为空');
      return;
    }
    let modelObj: any;
    let toolsObj: any;
    let sandboxObj: any;
    let groupChatObj: any;
    let identityObj: any;
    let subagentsObj: any;
    let paramsObj: any;
    try {
      modelObj = parseJSONText(form.modelText, 'model');
      toolsObj = parseJSONText(form.toolsText, 'tools');
      sandboxObj = parseJSONText(form.sandboxText, 'sandbox');
      groupChatObj = parseJSONText(form.groupChatText, 'groupChat');
      identityObj = parseJSONText(form.identityText, 'identity');
      subagentsObj = parseJSONText(form.subagentsText, 'subagents');
      paramsObj = parseJSONText(form.paramsText, 'params');
    } catch (err) {
      setMsg(String(err));
      return;
    }

    const payload: any = {
      id,
      name: form.name.trim() || undefined,
      workspace: form.workspace.trim() || undefined,
      agentDir: form.agentDir.trim() || undefined,
      default: form.isDefault,
    };
    if (modelObj !== undefined) payload.model = modelObj;
    if (toolsObj !== undefined) payload.tools = toolsObj;
    if (sandboxObj !== undefined) payload.sandbox = sandboxObj;
    if (groupChatObj !== undefined) payload.groupChat = groupChatObj;
    if (identityObj !== undefined) payload.identity = identityObj;
    if (subagentsObj !== undefined) payload.subagents = subagentsObj;
    if (paramsObj !== undefined) payload.params = paramsObj;

    setSaving(true);
    try {
      if (editingId) {
        await api.updateAgent(editingId, payload);
      } else {
        await api.createAgent(payload);
      }
      setMsg('Agent 保存成功');
      setShowForm(false);
      await loadData();
    } catch (err) {
      setMsg('保存失败: ' + String(err));
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const deleteAgent = async (agent: AgentItem) => {
    if (!window.confirm(`确认删除 Agent "${agent.id}"？`)) return;
    const preserveSessions = window.confirm('是否保留该 Agent 的 sessions 文件？\n确定=保留，取消=删除');
    try {
      await api.deleteAgent(agent.id, preserveSessions);
      setMsg('删除成功');
      await loadData();
    } catch (err) {
      setMsg('删除失败: ' + String(err));
    } finally {
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const setBindingAt = (idx: number, updater: (row: BindingDraft) => BindingDraft) => {
    setBindings(prev => prev.map((row, i) => (i === idx ? updater(row) : row)));
  };

  const touchBindingMatch = (idx: number, updater: (match: Record<string, any>) => Record<string, any>) => {
    setBindingAt(idx, row => {
      const nextMatch = compactMatch(updater(deepClone(row.match || {})));
      return {
        ...row,
        match: nextMatch,
        matchText: JSON.stringify(nextMatch, null, 2),
        rowError: '',
      };
    });
  };

  const setPeerField = (idx: number, key: 'peer' | 'parentPeer', part: 'kind' | 'id', value: string) => {
    touchBindingMatch(idx, cur => {
      const now = extractPeerForm(cur, key);
      const kind = part === 'kind' ? value.trim() : now.kind;
      const id = part === 'id' ? value.trim() : now.id;
      if (!kind && !id) {
        delete cur[key];
        return cur;
      }
      if (!kind) {
        // 结构化模式下 peer 必须有 kind，避免生成歧义字符串。
        delete cur[key];
        return cur;
      }
      cur[key] = id ? { kind, id } : { kind };
      return cur;
    });
  };

  const switchBindingMode = (idx: number, targetMode: 'structured' | 'json') => {
    setBindingAt(idx, row => {
      if (row.mode === targetMode) return row;
      if (targetMode === 'json') {
        const match = compactMatch(row.match);
        return {
          ...row,
          mode: 'json',
          match,
          matchText: JSON.stringify(match, null, 2),
          rowError: '',
        };
      }

      try {
        const parsed = compactMatch(JSON.parse(row.matchText || '{}'));
        if (!isStructuredMatchSupported(parsed)) {
          return {
            ...row,
            rowError: '当前 match 包含数组或高级表达式，请继续使用 JSON 模式。',
          };
        }
        return {
          ...row,
          mode: 'structured',
          match: parsed,
          matchText: JSON.stringify(parsed, null, 2),
          rowError: '',
        };
      } catch (err) {
        return {
          ...row,
          rowError: 'JSON 解析失败，无法切换到结构化模式: ' + String(err),
        };
      }
    });
  };

  const saveBindings = async () => {
    const parsed: any[] = [];
    const nextBindings = [...bindings];

    for (let i = 0; i < nextBindings.length; i++) {
      const row = nextBindings[i];
      if (!row.agent.trim()) {
        setMsg(`第 ${i + 1} 条 binding 缺少 agent`);
        return;
      }

      let matchObj: Record<string, any>;
      if (row.mode === 'json') {
        try {
          const parsedRaw = JSON.parse(row.matchText || '{}');
          const clientError = validateBindingMatchClient(parsedRaw, i + 1);
          if (clientError) {
            nextBindings[i] = {
              ...row,
              rowError: clientError,
            };
            setBindings(nextBindings);
            setMsg(clientError);
            return;
          }
          matchObj = compactMatch(parsedRaw);
          nextBindings[i] = {
            ...row,
            match: matchObj,
            matchText: JSON.stringify(matchObj, null, 2),
            rowError: '',
          };
        } catch (err) {
          nextBindings[i] = {
            ...row,
            rowError: `match JSON 错误: ${String(err)}`,
          };
          setBindings(nextBindings);
          setMsg(`第 ${i + 1} 条 binding 的 match JSON 错误`);
          return;
        }
      } else {
        matchObj = compactMatch(row.match);
      }

      const clientError = validateBindingMatchClient(matchObj, i + 1);
      if (clientError) {
        nextBindings[i] = {
          ...row,
          rowError: clientError,
        };
        setBindings(nextBindings);
        setMsg(clientError);
        return;
      }

      parsed.push({
        name: row.name.trim() || undefined,
        agentId: row.agent.trim(),
        enabled: row.enabled,
        match: matchObj,
      });
    }

    setBindings(nextBindings);
    setSaving(true);
    try {
      const r = await api.updateBindings(parsed);
      if (r?.ok === false) {
        setMsg('Bindings 保存失败: ' + (r.error || 'unknown error'));
        return;
      }
      setMsg('Bindings 保存成功');
      await loadData();
    } catch (err) {
      setMsg('Bindings 保存失败: ' + String(err));
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const addBinding = () => {
    const firstChannel = channelOptions[0] || 'qq';
    const match = compactMatch({ channel: firstChannel });
    setBindings(prev => [
      ...prev,
      {
        name: '',
        agent: defaultAgent || agentOptions[0] || 'main',
        enabled: true,
        match,
        matchText: JSON.stringify(match, null, 2),
        mode: 'structured',
        rowError: '',
      },
    ]);
  };

  const removeBinding = (idx: number) => {
    setBindings(prev => prev.filter((_, i) => i !== idx));
  };

  const moveBinding = (idx: number, delta: number) => {
    const to = idx + delta;
    if (to < 0 || to >= bindings.length) return;
    setBindings(prev => {
      const arr = [...prev];
      const [item] = arr.splice(idx, 1);
      arr.splice(to, 0, item);
      return arr;
    });
  };

  const runPreview = async () => {
    const meta: Record<string, any> = {};
    Object.entries(previewMeta).forEach(([k, v]) => {
      if (!v.trim()) return;
      if (k === 'roles') {
        const roles = parseCSV(v);
        if (roles.length > 0) meta[k] = roles;
        return;
      }
      meta[k] = v.trim();
    });

    setPreviewLoading(true);
    try {
      const r = await api.previewRoute(meta);
      if (r.ok) {
        setPreviewResult(r.result || {});
      } else {
        setPreviewResult({ trace: [r.error || '预览失败'] });
      }
    } catch (err) {
      setPreviewResult({ trace: [String(err)] });
    } finally {
      setPreviewLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="py-16 text-center text-gray-400 text-sm">
        <RefreshCw size={18} className="animate-spin inline mr-2" />
        加载中...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <datalist id="agent-channel-options">
        {channelOptions.map(ch => (
          <option key={ch} value={ch} />
        ))}
      </datalist>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Agents</h2>
          <p className="text-sm text-gray-500 mt-1">管理 OpenClaw 多智能体、bindings 路由规则和命中预览</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadData} className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 transition-colors shadow-sm">
            <RefreshCw size={14} /> 刷新
          </button>
          <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 shadow-sm shadow-violet-200 dark:shadow-none transition-all">
            <Plus size={14} /> 新建 Agent
          </button>
        </div>
      </div>

      {msg && (
        <div className={`px-4 py-3 rounded-lg text-sm ${msg.includes('失败') || msg.includes('错误') ? 'bg-red-50 dark:bg-red-900/20 text-red-600' : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600'}`}>
          {msg}
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700/50 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700/50 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Bot size={15} className="text-violet-500" />
            Agent 列表
          </h3>
          <span className="text-xs text-gray-500">默认: {defaultAgent}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100 dark:border-gray-700/50">
                <th className="px-4 py-2">ID</th>
                <th className="px-4 py-2">Workspace</th>
                <th className="px-4 py-2">AgentDir</th>
                <th className="px-4 py-2">会话数</th>
                <th className="px-4 py-2">最后活跃</th>
                <th className="px-4 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-400 text-xs">暂无 Agent</td>
                </tr>
              ) : agents.map(agent => (
                <tr key={agent.id} className="border-b border-gray-50 dark:border-gray-700/30">
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs">{agent.id}</span>
                    {agent.default && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">DEFAULT</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">{agent.workspace || '-'}</td>
                  <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">{agent.agentDir || '-'}</td>
                  <td className="px-4 py-3 text-xs">{agent.sessions ?? 0}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{agent.lastActive ? new Date(agent.lastActive).toLocaleString('zh-CN') : '-'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(agent)} className="px-2 py-1 text-xs rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600">编辑</button>
                      <button onClick={() => deleteAgent(agent)} className="px-2 py-1 text-xs rounded bg-red-50 text-red-600 hover:bg-red-100">删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700/50 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700/50 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Settings size={15} className="text-violet-500" />
            Bindings（结构化 + JSON 高级模式）
          </h3>
          <div className="flex items-center gap-2">
            <button onClick={addBinding} className="px-2 py-1 text-xs rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600">新增规则</button>
            <button onClick={saveBindings} disabled={saving} className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
              <Save size={12} /> 保存 Bindings
            </button>
          </div>
        </div>

        <div className="p-4 space-y-3">
          {bindings.length === 0 && (
            <div className="text-xs text-gray-400">暂无 bindings，消息将落到默认 Agent。</div>
          )}

          {bindings.map((row, idx) => {
            const match = compactMatch(row.match);
            const channel = extractTextValue(match.channel);
            const accountId = extractTextValue(match.accountId);
            const peer = extractPeerForm(match, 'peer');
            const parentPeer = extractPeerForm(match, 'parentPeer');
            const channelCfg = channel ? channelMeta[channel] : undefined;
            const defaultAccount = channelCfg?.defaultAccount;
            const accounts = channelCfg?.accounts || [];
            const priority = matchPriorityLabel(match);

            return (
              <div key={idx} className="border border-gray-100 dark:border-gray-700 rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    value={row.name}
                    onChange={e => setBindingAt(idx, r => ({ ...r, name: e.target.value }))}
                    placeholder="规则名（可选）"
                    className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                  />
                  <select
                    value={row.agent}
                    onChange={e => setBindingAt(idx, r => ({ ...r, agent: e.target.value }))}
                    className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                  >
                    {(agentOptions.length ? agentOptions : ['main']).map(id => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                  <label className="text-xs text-gray-600 flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={e => setBindingAt(idx, r => ({ ...r, enabled: e.target.checked }))}
                    />
                    启用
                  </label>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                    优先级: {priority}
                  </span>
                  <button onClick={() => moveBinding(idx, -1)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700" title="上移"><ArrowUp size={13} /></button>
                  <button onClick={() => moveBinding(idx, 1)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700" title="下移"><ArrowDown size={13} /></button>
                  <button onClick={() => removeBinding(idx)} className="p-1 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="删除"><Trash2 size={13} /></button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => switchBindingMode(idx, 'structured')}
                    className={`px-2 py-1 text-[11px] rounded border ${row.mode === 'structured' ? 'bg-violet-600 text-white border-violet-600' : 'bg-white dark:bg-gray-900 text-gray-600 border-gray-200 dark:border-gray-700'}`}
                  >
                    结构化
                  </button>
                  <button
                    onClick={() => switchBindingMode(idx, 'json')}
                    className={`px-2 py-1 text-[11px] rounded border ${row.mode === 'json' ? 'bg-violet-600 text-white border-violet-600' : 'bg-white dark:bg-gray-900 text-gray-600 border-gray-200 dark:border-gray-700'}`}
                  >
                    JSON
                  </button>
                  <span className="text-[11px] text-gray-400">官方语义：省略 accountId 仅匹配默认账号</span>
                </div>

                {row.mode === 'structured' ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="text-[11px] text-gray-500">channel *</label>
                      <input
                        list="agent-channel-options"
                        value={channel}
                        onChange={e => touchBindingMatch(idx, cur => ({ ...cur, channel: e.target.value }))}
                        placeholder="whatsapp / telegram / discord"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-gray-500">accountId</label>
                      {accounts.length > 0 ? (
                        <select
                          value={accountId}
                          onChange={e => touchBindingMatch(idx, cur => ({ ...cur, accountId: e.target.value || undefined }))}
                          className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                        >
                          <option value="">(默认账号)</option>
                          <option value="*">*（全部账号）</option>
                          {accounts.map(acc => <option key={acc} value={acc}>{acc}</option>)}
                          {accountId && accountId !== '*' && !accounts.includes(accountId) && (
                            <option value={accountId}>{accountId} (custom)</option>
                          )}
                        </select>
                      ) : (
                        <input
                          value={accountId}
                          onChange={e => touchBindingMatch(idx, cur => ({ ...cur, accountId: e.target.value }))}
                          placeholder="留空=默认账号，*=全部账号"
                          className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                        />
                      )}
                      <p className="text-[10px] text-gray-400 mt-1">
                        {!accountId
                          ? `当前留空，仅匹配默认账号${defaultAccount ? ` (${defaultAccount})` : ''}`
                          : accountId === '*'
                            ? '匹配该 channel 的所有账号（兜底规则）'
                            : `仅匹配账号 ${accountId}`}
                      </p>
                    </div>

                    <div>
                      <label className="text-[11px] text-gray-500">sender</label>
                      <input
                        value={extractTextValue(match.sender)}
                        onChange={e => touchBindingMatch(idx, cur => ({ ...cur, sender: e.target.value }))}
                        placeholder="例如 +15551230001"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-gray-500">peer.kind</label>
                      <input
                        value={peer.kind}
                        onChange={e => setPeerField(idx, 'peer', 'kind', e.target.value)}
                        placeholder="direct / group"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500">peer.id</label>
                      <input
                        value={peer.id}
                        onChange={e => setPeerField(idx, 'peer', 'id', e.target.value)}
                        placeholder="+1555... / 1203...@g.us"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-gray-500">guildId</label>
                      <input
                        value={extractTextValue(match.guildId)}
                        onChange={e => touchBindingMatch(idx, cur => ({ ...cur, guildId: e.target.value }))}
                        placeholder="Discord guild id"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-gray-500">roles（逗号分隔）</label>
                      <input
                        value={extractRolesText(match)}
                        onChange={e => touchBindingMatch(idx, cur => ({ ...cur, roles: parseCSV(e.target.value) }))}
                        placeholder="admin, maintainer"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-gray-500">teamId</label>
                      <input
                        value={extractTextValue(match.teamId)}
                        onChange={e => touchBindingMatch(idx, cur => ({ ...cur, teamId: e.target.value }))}
                        placeholder="Slack team id"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-gray-500">parentPeer.kind</label>
                      <input
                        value={parentPeer.kind}
                        onChange={e => setPeerField(idx, 'parentPeer', 'kind', e.target.value)}
                        placeholder="thread / group"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500">parentPeer.id</label>
                      <input
                        value={parentPeer.id}
                        onChange={e => setPeerField(idx, 'parentPeer', 'id', e.target.value)}
                        placeholder="上级会话 id"
                        className="w-full mt-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                      />
                    </div>
                  </div>
                ) : (
                  <textarea
                    value={row.matchText}
                    onChange={e => setBindingAt(idx, r => ({ ...r, matchText: e.target.value, rowError: '' }))}
                    rows={7}
                    className="w-full font-mono text-xs px-2 py-2 border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900"
                  />
                )}

                {row.rowError && (
                  <div className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1.5">
                    {row.rowError}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700/50 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700/50 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Route size={15} className="text-violet-500" />
            路由预览
          </h3>
          <button onClick={runPreview} disabled={previewLoading} className="px-3 py-1.5 text-xs rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
            {previewLoading ? '预览中...' : '执行预览'}
          </button>
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {Object.keys(previewMeta).map(key => (
            <div key={key}>
              <label className="text-xs text-gray-500">{key}</label>
              <input
                value={previewMeta[key] || ''}
                onChange={e => setPreviewMeta(prev => ({ ...prev, [key]: e.target.value }))}
                className="w-full mt-1 px-2 py-2 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
              />
            </div>
          ))}
        </div>
        <div className="px-4 pb-2 text-[11px] text-gray-400">
          roles 支持逗号分隔（会转为数组）；peer / parentPeer 可直接输入 <span className="font-mono">kind:id</span>。
        </div>
        {previewResult && (
          <div className="px-4 pb-4">
            <div className="rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-700 p-3 text-xs space-y-2">
              <div><span className="text-gray-500">命中 Agent:</span> <span className="font-mono text-violet-600">{previewResult.agent || '-'}</span></div>
              <div><span className="text-gray-500">匹配来源:</span> <span className="font-mono">{previewResult.matchedBy || '-'}</span></div>
              <div>
                <div className="text-gray-500 mb-1">Trace:</div>
                <ul className="list-disc pl-4 space-y-1">
                  {(previewResult.trace || []).map((line, i) => (
                    <li key={i} className="font-mono">{line}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 shadow-xl">
            <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 dark:text-white">{editingId ? `编辑 Agent: ${editingId}` : '新建 Agent'}</h3>
              <button onClick={() => setShowForm(false)} className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-700">关闭</button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs text-gray-500">ID</label>
                  <input
                    value={form.id}
                    disabled={!!editingId}
                    onChange={e => setForm(prev => ({ ...prev, id: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">Name</label>
                  <input
                    value={form.name}
                    onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">Workspace</label>
                  <input
                    value={form.workspace}
                    onChange={e => setForm(prev => ({ ...prev, workspace: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">AgentDir</label>
                  <input
                    value={form.agentDir}
                    onChange={e => setForm(prev => ({ ...prev, agentDir: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 space-y-1">
                <div>官方建议：不同 Agent 不要复用同一个 <span className="font-mono">agentDir</span>，否则会导致 auth/session 冲突。</div>
                <div>注意：<span className="font-mono">workspace</span> 是默认工作目录，不是硬隔离沙箱；严格隔离请结合 <span className="font-mono">sandbox</span> 配置。</div>
              </div>

              <label className="text-xs text-gray-600 flex items-center gap-2">
                <input type="checkbox" checked={form.isDefault} onChange={e => setForm(prev => ({ ...prev, isDefault: e.target.checked }))} />
                设为默认 Agent
              </label>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-gray-500">model (JSON)</label>
                  <textarea
                    rows={8}
                    value={form.modelText}
                    onChange={e => setForm(prev => ({ ...prev, modelText: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">tools (JSON)</label>
                  <textarea
                    rows={8}
                    value={form.toolsText}
                    onChange={e => setForm(prev => ({ ...prev, toolsText: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">sandbox (JSON)</label>
                  <textarea
                    rows={8}
                    value={form.sandboxText}
                    onChange={e => setForm(prev => ({ ...prev, sandboxText: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500">groupChat (JSON)</label>
                  <textarea
                    rows={6}
                    value={form.groupChatText}
                    onChange={e => setForm(prev => ({ ...prev, groupChatText: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">identity (JSON)</label>
                  <textarea
                    rows={6}
                    value={form.identityText}
                    onChange={e => setForm(prev => ({ ...prev, identityText: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">subagents (JSON)</label>
                  <textarea
                    rows={6}
                    value={form.subagentsText}
                    onChange={e => setForm(prev => ({ ...prev, subagentsText: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">params (JSON)</label>
                  <textarea
                    rows={6}
                    value={form.paramsText}
                    onChange={e => setForm(prev => ({ ...prev, paramsText: e.target.value }))}
                    className="w-full mt-1 px-2 py-2 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900"
                  />
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-gray-100 dark:border-gray-700 flex items-center justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-xs rounded bg-gray-100 dark:bg-gray-700">取消</button>
              <button onClick={saveAgent} disabled={saving} className="px-4 py-2 text-xs rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
