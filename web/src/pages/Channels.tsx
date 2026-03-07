import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import { Radio, Wifi, WifiOff, QrCode, Key, Zap, UserCheck, Check, X, Power, Loader2, RefreshCw, LogOut, Sparkles, Download, Package, Wrench, Search, Copy, CheckCircle, AlertTriangle, AlertCircle } from 'lucide-react';
import { useI18n } from '../i18n';

type ChannelDef = {
  id: string; label: string; description: string; type: 'builtin' | 'plugin';
  configFields: { key: string; label: string; type: 'text' | 'password' | 'toggle' | 'number' | 'select'; options?: string[]; placeholder?: string; help?: string }[];
  loginMethods?: ('qrcode' | 'quick' | 'password')[];
};

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function getNestedValue(raw: any, path: string): any {
  return path.split('.').reduce<any>((acc, key) => (isPlainObject(acc) ? acc[key] : undefined), raw);
}

function setNestedValue(raw: Record<string, any>, path: string, value: any) {
  const keys = path.split('.');
  let cur: Record<string, any> = raw;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
}

function deleteNestedValue(raw: Record<string, any>, path: string) {
  const keys = path.split('.');
  let cur: Record<string, any> | undefined = raw;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!isPlainObject(cur?.[key])) return;
    cur = cur[key];
  }
  if (!cur) return;
  delete cur[keys[keys.length - 1]];
}

function listFeishuAccountIDs(cfg: any): string[] {
  const accounts = isPlainObject(cfg?.accounts) ? cfg.accounts : {};
  return Object.keys(accounts).map(id => id.trim()).filter(Boolean).sort((a, b) => {
    if (a === 'default') return -1;
    if (b === 'default') return 1;
    return a.localeCompare(b);
  });
}

function pickFeishuDefaultAccount(cfg: any): string {
  const explicit = String(cfg?.defaultAccount || '').trim();
  if (explicit) return explicit;
  const ids = listFeishuAccountIDs(cfg);
  if (ids.includes('default')) return 'default';
  return ids[0] || 'default';
}

function hasFeishuAdvancedAccounts(cfg: any): boolean {
  return listFeishuAccountIDs(cfg).length > 0;
}

function resolveFeishuSimpleCredentials(cfg: any): { appId: string; appSecret: string } {
  const appId = String(cfg?.appId || '').trim();
  const appSecret = String(cfg?.appSecret || '').trim();
  if (appId || appSecret) return { appId, appSecret };
  const defaultAccount = pickFeishuDefaultAccount(cfg);
  const entry = isPlainObject(cfg?.accounts?.[defaultAccount]) ? cfg.accounts[defaultAccount] : {};
  return {
    appId: String(entry.appId || '').trim(),
    appSecret: String(entry.appSecret || '').trim(),
  };
}

function formatCommaList(value: any): string {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean).join(', ');
  }
  return String(value || '').trim();
}

const CHANNEL_DEFS: ChannelDef[] = [
  { id: 'qq', label: 'QQ (NapCat)', description: 'QQ个人号，NapCat OneBot11协议', type: 'plugin',
    loginMethods: ['qrcode', 'quick', 'password'],
    configFields: [
      { key: 'wsUrl', label: 'WebSocket 地址', type: 'text', placeholder: 'ws://127.0.0.1:3001' },
      { key: 'accessToken', label: 'Access Token', type: 'password' },
      { key: 'ownerQQ', label: '主人QQ号', type: 'number', help: '接收通知的QQ号' },
      { key: 'rateLimit.wakeProbability', label: '唤醒概率 (%)', type: 'number', help: '群聊中Bot回复的概率，0-100' },
      { key: 'rateLimit.minIntervalSec', label: '最小发送间隔 (秒)', type: 'number' },
      { key: 'rateLimit.wakeTrigger.keywords', label: '唤醒触发词', type: 'text', help: '逗号分隔关键词' },
      { key: 'pokeReplyText', label: '戳一戳回复内容', type: 'text', placeholder: '别戳我啦~', help: '自定义戳一戳回复文本' },
      { key: 'autoApprove.group.enabled', label: '自动同意加群', type: 'toggle' },
      { key: 'autoApprove.friend.enabled', label: '自动同意好友', type: 'toggle' },
      { key: 'notifications.antiRecall', label: '防撤回通知', type: 'toggle', help: '撤回消息时发送通知' },
      { key: 'notifications.memberChange', label: '成员变动通知', type: 'toggle', help: '群成员加入/退出通知' },
      { key: 'notifications.adminChange', label: '管理员变动通知', type: 'toggle', help: '管理员设置/取消通知' },
      { key: 'notifications.banNotice', label: '禁言通知', type: 'toggle', help: '禁言/解禁通知' },
      { key: 'notifications.pokeReply', label: '戳一戳回复', type: 'toggle', help: '收到戳一戳时自动回复' },
      { key: 'notifications.honorNotice', label: '荣誉通知', type: 'toggle', help: '群荣誉变动通知' },
      { key: 'notifications.fileUpload', label: '文件上传通知', type: 'toggle', help: '群文件上传通知' },
      { key: 'welcome.enabled', label: '入群欢迎', type: 'toggle', help: '新成员入群时发送欢迎消息' },
      { key: 'welcome.template', label: '欢迎模板', type: 'text', placeholder: '欢迎 {nickname} 加入本群！' },
    ] },
  { id: 'whatsapp', label: 'WhatsApp', description: 'Baileys QR扫码配对', type: 'builtin', loginMethods: ['qrcode'],
    configFields: [{ key: 'dmPolicy', label: 'DM策略', type: 'select', options: ['pairing','open','allowlist'] }] },
  { id: 'telegram', label: 'Telegram', description: 'Bot API via grammŸ，支持群组', type: 'builtin',
    configFields: [
      { key: 'token', label: 'Bot Token', type: 'password', placeholder: '123456:ABC-DEF...' },
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text' },
    ] },
  { id: 'discord', label: 'Discord', description: 'Discord Bot API + Gateway', type: 'builtin',
    configFields: [
      { key: 'token', label: 'Bot Token', type: 'password' },
      { key: 'applicationId', label: 'Application ID', type: 'text' },
      { key: 'guildIds', label: 'Guild IDs', type: 'text', help: '逗号分隔' },
    ] },
  { id: 'irc', label: 'IRC', description: '经典IRC服务器', type: 'builtin',
    configFields: [
      { key: 'server', label: '服务器', type: 'text', placeholder: 'irc.libera.chat' },
      { key: 'nick', label: '昵称', type: 'text' },
      { key: 'channels', label: '频道', type: 'text', help: '逗号分隔' },
    ] },
  { id: 'slack', label: 'Slack', description: 'Bolt SDK，工作区应用', type: 'builtin',
    configFields: [
      { key: 'appToken', label: 'App Token', type: 'password', placeholder: 'xapp-...' },
      { key: 'botToken', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...' },
    ] },
  { id: 'signal', label: 'Signal', description: 'signal-cli REST API', type: 'builtin',
    configFields: [
      { key: 'apiUrl', label: 'REST API URL', type: 'text', placeholder: 'http://signal-cli:8080' },
      { key: 'phoneNumber', label: '手机号', type: 'text' },
    ] },
  { id: 'googlechat', label: 'Google Chat', description: 'Google Chat API Webhook', type: 'builtin',
    configFields: [
      { key: 'serviceAccountKey', label: '服务账号 JSON', type: 'text' },
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text' },
    ] },
  { id: 'bluebubbles', label: 'BlueBubbles (iMessage)', description: 'macOS iMessage', type: 'builtin',
    configFields: [
      { key: 'serverUrl', label: '服务器URL', type: 'text' },
      { key: 'password', label: '密码', type: 'password' },
    ] },
  { id: 'webchat', label: 'WebChat', description: 'Gateway WebChat UI (内置)', type: 'builtin', configFields: [] },
  // Plugin channels
  { id: 'feishu', label: '飞书 / Lark', description: '飞书机器人 WebSocket (插件)', type: 'plugin',
    configFields: [
      { key: 'domain', label: '站点域（Domain）', type: 'select', options: ['feishu', 'lark'], help: '国际版 Lark 场景可切到 lark；不确定时保持 feishu' },
      { key: 'requireMention', label: '群聊回复策略', type: 'select', options: ['true', 'false', 'open'], help: 'true = 仅 @ 机器人；false = 放宽触发；open = 以插件支持的开放模式处理' },
      { key: 'groupPolicy', label: '群组准入策略', type: 'select', options: ['open', 'allowlist', 'closed'], help: 'open = 所有群可用；allowlist = 仅白名单；closed = 禁止群聊' },
      { key: 'groupAllowFrom', label: '群聊白名单', type: 'text', placeholder: 'oc_xxx,oc_yyy', help: '多个群 ID 请用英文逗号分隔；仅 groupPolicy=allowlist 时生效，保存时会自动转成数组' },
      { key: 'dmPolicy', label: '私聊准入策略', type: 'select', options: ['pairing', 'open', 'allowlist'], help: 'pairing = 需先配对；open = 所有私聊可用；allowlist = 仅白名单' },
      { key: 'streaming', label: '流式卡片输出', type: 'toggle', help: '仅飞书官方版支持，开启后回复以流式卡片形式呈现' },
      { key: 'threadSession', label: '话题独立上下文', type: 'toggle', help: '仅飞书官方版支持，每个话题拥有独立会话并可并行' },
      { key: 'footer.elapsed', label: '显示耗时页脚', type: 'toggle', help: '飞书官方文档已明确给出配置命令；其他版本若不识别会直接忽略' },
      { key: 'footer.status', label: '显示状态页脚', type: 'toggle', help: '飞书官方文档已明确给出配置命令；其他版本若不识别会直接忽略' },
      { key: 'replyInThread', label: '话题内回复', type: 'toggle', help: '仅 ClawTeam 版支持，优先在话题内回复' },
      { key: 'typingIndicator', label: '输入中提示', type: 'toggle', help: '仅 ClawTeam 版支持' },
      { key: 'resolveSenderNames', label: '解析发送者名称', type: 'toggle', help: '仅 ClawTeam 版支持，自动解析飞书用户显示名' },
      { key: 'dynamicAgentCreation', label: '动态创建 Agent', type: 'toggle', help: '仅 ClawTeam 版支持，按场景动态创建 Agent' },
    ] },
  { id: 'qqbot', label: 'QQ 官方机器人', description: 'QQ开放平台官方Bot API (插件)', type: 'plugin',
    configFields: [
      { key: 'appId', label: 'App ID', type: 'text' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password' },
    ] },
  { id: 'dingtalk', label: '钉钉', description: '钉钉机器人 (插件)', type: 'plugin',
    configFields: [
      { key: 'appKey', label: 'App Key', type: 'text' },
      { key: 'appSecret', label: 'App Secret', type: 'password' },
      { key: 'robotCode', label: 'Robot Code', type: 'text' },
    ] },
  { id: 'wecom', label: '企业微信', description: '企业微信应用消息 (插件)', type: 'plugin',
    configFields: [
      { key: 'corpId', label: 'Corp ID', type: 'text' },
      { key: 'agentId', label: 'Agent ID', type: 'text' },
      { key: 'secret', label: 'Secret', type: 'password' },
    ] },
  { id: 'msteams', label: 'Microsoft Teams', description: 'Bot Framework (插件)', type: 'plugin',
    configFields: [
      { key: 'appId', label: 'App ID', type: 'text' },
      { key: 'appPassword', label: 'App Password', type: 'password' },
    ] },
  { id: 'mattermost', label: 'Mattermost', description: 'Bot API + WebSocket (插件)', type: 'plugin',
    configFields: [
      { key: 'url', label: '服务器URL', type: 'text' },
      { key: 'token', label: 'Bot Token', type: 'password' },
    ] },
  { id: 'line', label: 'LINE', description: 'LINE Messaging API (插件)', type: 'plugin',
    configFields: [
      { key: 'channelAccessToken', label: 'Channel Access Token', type: 'password' },
      { key: 'channelSecret', label: 'Channel Secret', type: 'password' },
    ] },
  { id: 'matrix', label: 'Matrix', description: 'Matrix 协议 (插件)', type: 'plugin',
    configFields: [
      { key: 'homeserverUrl', label: 'Homeserver URL', type: 'text' },
      { key: 'accessToken', label: 'Access Token', type: 'password' },
    ] },
  { id: 'twitch', label: 'Twitch', description: 'Twitch Chat via IRC (插件)', type: 'plugin',
    configFields: [
      { key: 'username', label: '用户名', type: 'text' },
      { key: 'oauthToken', label: 'OAuth Token', type: 'password' },
      { key: 'channels', label: '频道', type: 'text', help: '逗号分隔' },
    ] },
];

// 飞书双版本：读取当前启用的变体
function getActiveFeishuVariant(ocConfig: any): 'official' | 'clawteam' | null {
  const entries = ocConfig?.plugins?.entries || {};
  if (entries['feishu-openclaw-plugin']?.enabled) return 'official';
  if (entries['feishu']?.enabled) return 'clawteam';
  return null;
}

// 飞书双版本：获取当前活跃的 plugin entry ID
function getFeishuPluginEntryId(ocConfig: any): string {
  const variant = getActiveFeishuVariant(ocConfig);
  if (variant === 'official') return 'feishu-openclaw-plugin';
  return 'feishu';
}

// Determine channel status: 'enabled' (green), 'configured' (red/orange), 'unconfigured' (gray)
function getChannelStatus(ch: ChannelDef, ocConfig: any): 'enabled' | 'configured' | 'unconfigured' {
  const chConf = ocConfig?.channels?.[ch.id] || {};
  const pluginConf = ocConfig?.plugins?.entries?.[ch.id] || {};
  // 飞书特殊处理：任一变体 enabled 即视为 enabled
  const isEnabled = ch.id === 'feishu'
    ? (pluginConf.enabled || ocConfig?.plugins?.entries?.['feishu-openclaw-plugin']?.enabled || chConf.enabled)
    : (chConf.enabled || pluginConf.enabled);
  // Check if any config field has a value
  const hasConfig = ch.configFields.some(f => {
    const v = getNestedValue(chConf, f.key);
    return v !== undefined && v !== null && v !== '';
  }) || (
    ch.id === 'feishu' && (
      !!String(chConf?.appId || '').trim()
      || !!String(chConf?.appSecret || '').trim()
      || hasFeishuAdvancedAccounts(chConf)
    )
  );
  if (isEnabled) return 'enabled';
  if (hasConfig) return 'configured';
  return 'unconfigured';
}

function statusDot(s: 'enabled' | 'configured' | 'unconfigured') {
  if (s === 'enabled') return 'bg-emerald-500';
  if (s === 'configured') return 'bg-red-400';
  return 'bg-gray-300 dark:bg-gray-600';
}

// statusLabel is now inside the component to access i18n

export default function Channels() {
  const { t } = useI18n();

  const statusLabel = (s: 'enabled' | 'configured' | 'unconfigured') => {
    if (s === 'enabled') return t.channels.statusEnabled;
    if (s === 'configured') return t.channels.statusConfigured;
    return t.channels.statusUnconfigured;
  };

  const [status, setStatus] = useState<any>(null);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [ocConfig, setOcConfig] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [requests, setRequests] = useState<any[]>([]);
  // QQ Login state
  const [loginModal, setLoginModal] = useState<'qrcode' | 'quick' | 'password' | null>(null);
  const [qrImg, setQrImg] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const [quickList, setQuickList] = useState<string[]>([]);
  const [loginUin, setLoginUin] = useState('');
  const [loginPwd, setLoginPwd] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginMsg, setLoginMsg] = useState('');
  const [softwareList, setSoftwareList] = useState<any[]>([]);
  const [serverPlatform, setServerPlatform] = useState<string>('');
  const [installingSw, setInstallingSw] = useState<string | null>(null);
  const [napcatStatus, setNapcatStatus] = useState<any>(null);
  const [reconnectLogs, setReconnectLogs] = useState<any[]>([]);
  const [showReconnectLogs, setShowReconnectLogs] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<any>(null);
  const [restarting, setRestarting] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<any[]>([]);
  const [feishuAdvancedAccounts, setFeishuAdvancedAccounts] = useState(false);
  const [feishuActiveAccountId, setFeishuActiveAccountId] = useState('default');
  const [feishuNewAccountId, setFeishuNewAccountId] = useState('');
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const syncFeishuUiState = useCallback((config: any) => {
    const feishuCfg = isPlainObject(config?.channels?.feishu) ? config.channels.feishu : {};
    const hasAccounts = hasFeishuAdvancedAccounts(feishuCfg);
    const defaultAccount = pickFeishuDefaultAccount(feishuCfg);
    const accountIDs = listFeishuAccountIDs(feishuCfg);
    setFeishuAdvancedAccounts(hasAccounts);
    setFeishuActiveAccountId(accountIDs.includes(defaultAccount) ? defaultAccount : (defaultAccount || accountIDs[0] || 'default'));
    setFeishuNewAccountId('');
  }, []);

  const updateChannelDraft = useCallback((channelId: string, mutate: (draft: any) => void) => {
    setOcConfig((prev: any) => {
      const next = deepClone(prev || {});
      if (!isPlainObject(next.channels)) next.channels = {};
      const current = isPlainObject(next.channels[channelId]) ? deepClone(next.channels[channelId]) : {};
      mutate(current);
      next.channels[channelId] = current;
      return next;
    });
  }, []);

  const updateFeishuDraft = useCallback((mutate: (draft: any) => void) => {
    updateChannelDraft('feishu', mutate);
  }, [updateChannelDraft]);

  const loadNapcatStatus = () => {
    api.napcatStatus().then(r => { if (r.ok) setNapcatStatus(r.status); }).catch(() => {});
  };

  const loadReconnectLogs = () => {
    api.napcatReconnectLogs().then(r => { if (r.ok) setReconnectLogs(r.logs || []); }).catch(() => {});
  };

  const handleReconnect = async () => {
    if (!confirm('确定要触发 NapCat 重连？将重启容器。')) return;
    setReconnecting(true);
    try {
      const r = await api.napcatReconnect();
      if (r.ok) setMsg('重连请求已发送，请等待...');
      else setMsg(r.error || '重连失败');
    } catch (err) { setMsg('重连失败: ' + String(err)); }
    finally { setReconnecting(false); setTimeout(() => { setMsg(''); loadNapcatStatus(); }, 10000); }
  };

  const loadSoftware = () => {
    api.getSoftwareList().then(r => { if (r.ok) { setSoftwareList(r.software || []); if (r.platform) setServerPlatform(r.platform); } }).catch(() => {});
  };

  const handleInstallContainer = async (id: string) => {
    setInstallingSw(id);
    try {
      const r = await api.installSoftware(id);
      if (r.ok) setMsg(`✅ ${id} 安装任务已创建，请在消息中心查看进度`);
      else setMsg(`❌ ${r.error || '安装失败'}`);
    } catch { setMsg('❌ 安装请求失败'); }
    finally { setInstallingSw(null); setTimeout(() => { setMsg(''); loadSoftware(); }, 5000); }
  };

  const isContainerInstalled = (id: string) => {
    const sw = softwareList.find(s => s.id === id);
    return sw?.installed || false;
  };

  const loadInstalledPlugins = () => {
    api.getSkills().then((r: any) => { if (r.ok) setInstalledPlugins(r.plugins || []); }).catch(() => {});
  };

  const isPluginInstalled = (channelId: string) => {
    // 飞书特殊处理：任一版本已安装即视为已安装
    if (channelId === 'feishu') {
      return installedPlugins.some((p: any) => p.id === 'feishu' || p.id === 'feishu-openclaw-plugin');
    }
    // Check if plugin extension is installed (in extensions dir or plugins.installs)
    return installedPlugins.some((p: any) => p.id === channelId);
  };

  const reload = () => {
    api.getStatus().then(r => { if (r.ok) setStatus(r); });
    api.getOpenClawConfig().then(r => {
      if (!r.ok) return;
      const nextConfig = r.config || {};
      setOcConfig(nextConfig);
      syncFeishuUiState(nextConfig);
    });
    api.getRequests().then(r => { if (r.ok) setRequests(r.requests || []); });
  };

  useEffect(() => { reload(); loadSoftware(); loadNapcatStatus(); loadInstalledPlugins(); }, []);
  // 自动选择第一个已启用的渠道（而非硬编码 QQ）
  useEffect(() => {
    if (selectedChannel) return; // 用户已手动选择
    const firstEnabled = CHANNEL_DEFS.find(ch => {
      const chConf = ocConfig?.channels?.[ch.id] || {};
      const pluginConf = ocConfig?.plugins?.entries?.[ch.id] || {};
      if (ch.id === 'feishu') {
        return chConf.enabled || pluginConf.enabled || ocConfig?.plugins?.entries?.['feishu-openclaw-plugin']?.enabled;
      }
      return chConf.enabled || pluginConf.enabled;
    });
    if (firstEnabled) setSelectedChannel(firstEnabled.id);
    else setSelectedChannel('feishu');
  }, [ocConfig, selectedChannel]);
  useEffect(() => {
    if (selectedChannel === 'feishu') syncFeishuUiState(ocConfig);
  }, [selectedChannel, syncFeishuUiState]);
  useEffect(() => {
    const timer = setInterval(loadNapcatStatus, 30000);
    return () => clearInterval(timer);
  }, []);

  const ocChannels = ocConfig?.channels || {};
  const ocPlugins = ocConfig?.plugins?.entries || {};
  const currentFeishuConfig = isPlainObject(ocChannels.feishu) ? ocChannels.feishu : {};
  const currentFeishuVariant = getActiveFeishuVariant(ocConfig);
  const currentFeishuAccounts = listFeishuAccountIDs(currentFeishuConfig);
  const currentFeishuDefaultAccount = pickFeishuDefaultAccount(currentFeishuConfig);
  const currentFeishuSimpleCredentials = resolveFeishuSimpleCredentials(currentFeishuConfig);
  const currentFeishuAccountConfig = isPlainObject(currentFeishuConfig.accounts?.[feishuActiveAccountId])
    ? currentFeishuConfig.accounts[feishuActiveAccountId]
    : {};
  const currentFeishuGroupPolicy = String(currentFeishuConfig.groupPolicy || '').trim();
  const currentFeishuGroupAllowFrom = formatCommaList(currentFeishuConfig.groupAllowFrom);
  const hasFeishuGroupAllowlistConflict = currentFeishuGroupPolicy !== '' && currentFeishuGroupPolicy !== 'allowlist' && !!currentFeishuGroupAllowFrom;

  const toggleDraftField = (channelId: string, key: string) => {
    updateChannelDraft(channelId, draft => {
      setNestedValue(draft, key, !getNestedValue(draft, key));
    });
  };

  const handleToggleFeishuAdvancedAccounts = (enabled: boolean) => {
    setFeishuAdvancedAccounts(enabled);
    if (!enabled) return;
    const seededAccount = currentFeishuDefaultAccount || 'default';
    updateFeishuDraft(draft => {
      if (!isPlainObject(draft.accounts)) draft.accounts = {};
      if (!isPlainObject(draft.accounts[seededAccount])) draft.accounts[seededAccount] = {};
      if (draft.appId && !draft.accounts[seededAccount].appId) draft.accounts[seededAccount].appId = draft.appId;
      if (draft.appSecret && !draft.accounts[seededAccount].appSecret) draft.accounts[seededAccount].appSecret = draft.appSecret;
      draft.defaultAccount = seededAccount;
    });
    setFeishuActiveAccountId(seededAccount);
  };

  const handleFeishuSimpleFieldChange = (key: 'appId' | 'appSecret', value: string) => {
    updateFeishuDraft(draft => {
      if (value) draft[key] = value;
      else delete draft[key];
      const defaultAccount = pickFeishuDefaultAccount(draft);
      if (!defaultAccount || !hasFeishuAdvancedAccounts(draft)) return;
      if (!isPlainObject(draft.accounts)) draft.accounts = {};
      if (!isPlainObject(draft.accounts[defaultAccount])) draft.accounts[defaultAccount] = {};
      if (value) draft.accounts[defaultAccount][key] = value;
      else delete draft.accounts[defaultAccount][key];
    });
  };

  const handleFeishuDefaultAccountChange = (accountId: string) => {
    updateFeishuDraft(draft => {
      if (accountId) draft.defaultAccount = accountId;
      else delete draft.defaultAccount;
      const entry = isPlainObject(draft.accounts?.[accountId]) ? draft.accounts[accountId] : {};
      if (entry.appId) draft.appId = entry.appId;
      else delete draft.appId;
      if (entry.appSecret) draft.appSecret = entry.appSecret;
      else delete draft.appSecret;
    });
    setFeishuActiveAccountId(accountId);
  };

  const handleFeishuAccountFieldChange = (accountId: string, key: 'appId' | 'appSecret', value: string) => {
    updateFeishuDraft(draft => {
      if (!isPlainObject(draft.accounts)) draft.accounts = {};
      if (!isPlainObject(draft.accounts[accountId])) draft.accounts[accountId] = {};
      if (value) draft.accounts[accountId][key] = value;
      else delete draft.accounts[accountId][key];
      if (pickFeishuDefaultAccount(draft) === accountId) {
        if (value) draft[key] = value;
        else delete draft[key];
      }
    });
  };

  const handleAddFeishuAccount = () => {
    const nextID = feishuNewAccountId.trim();
    if (!nextID) {
      setMsg('请先输入 Account ID');
      setTimeout(() => setMsg(''), 3000);
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(nextID)) {
      setMsg('Account ID 仅支持字母、数字、点、下划线和中划线');
      setTimeout(() => setMsg(''), 4000);
      return;
    }
    if (currentFeishuAccounts.includes(nextID)) {
      setMsg(`Account ID 已存在：${nextID}`);
      setTimeout(() => setMsg(''), 3000);
      return;
    }
    updateFeishuDraft(draft => {
      if (!isPlainObject(draft.accounts)) draft.accounts = {};
      draft.accounts[nextID] = {};
      if (!String(draft.defaultAccount || '').trim()) draft.defaultAccount = nextID;
    });
    setFeishuAdvancedAccounts(true);
    setFeishuActiveAccountId(nextID);
    setFeishuNewAccountId('');
  };

  const handleRemoveFeishuAccount = (accountId: string) => {
    if (currentFeishuAccounts.length <= 1) {
      setMsg('至少保留一个 Account；如果只需要单机器人，请关闭完整版 Account 功能。');
      setTimeout(() => setMsg(''), 4000);
      return;
    }
    const remaining = currentFeishuAccounts.filter(id => id !== accountId);
    const nextDefault = currentFeishuDefaultAccount === accountId ? remaining[0] : currentFeishuDefaultAccount;
    updateFeishuDraft(draft => {
      if (!isPlainObject(draft.accounts)) return;
      delete draft.accounts[accountId];
      if (nextDefault) draft.defaultAccount = nextDefault;
      else delete draft.defaultAccount;
      const entry = isPlainObject(draft.accounts?.[draft.defaultAccount]) ? draft.accounts[draft.defaultAccount] : {};
      if (entry.appId) draft.appId = entry.appId;
      else delete draft.appId;
      if (entry.appSecret) draft.appSecret = entry.appSecret;
      else delete draft.appSecret;
    });
    if (feishuActiveAccountId === accountId) setFeishuActiveAccountId(nextDefault || remaining[0] || 'default');
  };

  // Get the merged config for the current channel (supports nested keys like notifications.antiRecall)
  const getFieldValue = (channelId: string, key: string) => {
    const chConf = ocChannels[channelId] || {};
    if (channelId === 'qq') {
      if (key === 'rateLimit.wakeProbability') {
        const nested = chConf?.rateLimit?.wakeProbability;
        return nested ?? chConf?.wakeProbability;
      }
      if (key === 'rateLimit.minIntervalSec') {
        const nested = chConf?.rateLimit?.minIntervalSec;
        if (nested !== undefined && nested !== null) return nested;
        const legacyMs = chConf?.minSendIntervalMs;
        if (legacyMs !== undefined && legacyMs !== null) return Math.round(Number(legacyMs) / 1000);
      }
      if (key === 'rateLimit.wakeTrigger.keywords') {
        const nested = chConf?.rateLimit?.wakeTrigger?.keywords;
        if (Array.isArray(nested)) return nested.join(',');
        const legacy = chConf?.wakeTrigger;
        if (typeof legacy === 'string') return legacy;
      }
    }
    if (channelId === 'feishu' && key === 'groupAllowFrom') {
      return formatCommaList(chConf?.groupAllowFrom);
    }
    return key.split('.').reduce((o: any, k: string) => o?.[k], chConf);
  };

  const isChannelEnabled = (channelId: string) => {
    if (channelId === 'feishu') {
      return ocPlugins[channelId]?.enabled || ocPlugins['feishu-openclaw-plugin']?.enabled || ocChannels[channelId]?.enabled || false;
    }
    return ocChannels[channelId]?.enabled || ocPlugins[channelId]?.enabled || false;
  };

  const currentDef = CHANNEL_DEFS.find(c => c.id === selectedChannel);

  const handleToggleEnabled = async (channelId: string) => {
    const newEnabled = !isChannelEnabled(channelId);
    try {
      const r = await api.toggleChannel(channelId, newEnabled);
      if (r.ok) {
        setMsg(r.message || (newEnabled ? t.channels.channelEnabled : t.channels.channelDisabled));
        if (channelId === 'qq' && !newEnabled) {
          setMsg(t.channels.qqClosing);
        }
      } else {
        setMsg(r.error || t.common.operationFailed);
      }
      reload();
      setTimeout(() => setMsg(''), 5000);
    } catch (err) { setMsg(t.common.operationFailed + ': ' + String(err)); setTimeout(() => setMsg(''), 3000); }
  };

  const handleSave = async () => {
    if (!currentDef) return;
    setSaving(true); setMsg('');
    try {
      // Collect values from form inputs
      const formEl = document.getElementById('channel-config-form') as HTMLFormElement;
      if (!formEl) return;
      const formData = new FormData(formEl);
      const chData: any = deepClone(ocChannels[currentDef.id] || {});
      for (const f of currentDef.configFields) {
        if (f.type === 'toggle') continue; // toggles handled separately via handleToggleField
        const val = formData.get(f.key);
        if (val === null) continue;
        if (val === '') {
          deleteNestedValue(chData, f.key);
          continue;
        }
        let parsed: any = f.type === 'number' ? Number(val) : val;
        if (currentDef.id === 'qq' && f.key === 'rateLimit.wakeTrigger.keywords') {
          parsed = String(val)
            .split(',')
            .map(v => v.trim())
            .filter(Boolean);
        }
        setNestedValue(chData, f.key, parsed);
      }
      if (currentDef.id === 'feishu' && String(chData.groupPolicy || '').trim() !== 'allowlist') {
        delete chData.groupAllowFrom;
      }
      await api.updateChannel(currentDef.id, chData);
      // 飞书特殊处理：保存时操作当前活跃变体的 plugin entry
      if (currentDef.id === 'feishu') {
        const entryId = getFeishuPluginEntryId(ocConfig);
        await api.updatePlugin(entryId, { enabled: chData.enabled || false });
      } else if (currentDef.type === 'plugin') {
        await api.updatePlugin(currentDef.id, { enabled: chData.enabled || false });
      }
      setMsg(t.channels.saveSuccess);
      reload();
      setTimeout(() => setMsg(''), 2000);
    } catch (err) { setMsg(t.channels.saveFailed + ': ' + String(err)); }
    finally { setSaving(false); }
  };

  const handleToggleField = async (channelId: string, key: string) => {
    const chConf = JSON.parse(JSON.stringify(ocChannels[channelId] || {}));
    const keys = key.split('.');
    if (keys.length === 1) {
      chConf[key] = !chConf[key];
    } else {
      let cur = chConf;
      for (let i = 0; i < keys.length - 1; i++) { if (!cur[keys[i]]) cur[keys[i]] = {}; cur = cur[keys[i]]; }
      cur[keys[keys.length - 1]] = !cur[keys[keys.length - 1]];
    }
    try {
      await api.updateChannel(channelId, chConf);
      reload();
    } catch {}
  };

  // 飞书版本切换
  const handleSwitchFeishuVariant = async (variant: 'official' | 'clawteam') => {
    try {
      const r = await api.switchFeishuVariant(variant);
      if (r.ok) {
        setMsg(r.message || '飞书版本已切换');
      } else {
        setMsg(r.error || '切换失败');
      }
      reload();
      setTimeout(() => setMsg(''), 5000);
    } catch (err) { setMsg('切换失败: ' + String(err)); setTimeout(() => setMsg(''), 3000); }
  };

  // === QQ Login handlers ===
  const handleQRLogin = async () => {
    setLoginModal('qrcode'); setQrImg(''); setQrLoading(true); setLoginMsg('');
    try {
      const r = await api.napcatGetQRCode();
      if (r.ok && r.data?.qrcode) {
        setQrImg(r.data.qrcode);
        startQrPolling();
      } else if (r.message?.includes('Logined') || r.data?.message?.includes('Logined')) {
        setLoginMsg('QQ 已登录，无需重复登录');
      } else {
        setLoginMsg(r.message || r.data?.message || r.error || '获取二维码失败');
      }
    } catch (err) { setLoginMsg('获取二维码失败: ' + String(err)); }
    finally { setQrLoading(false); }
  };

  const handleRefreshQR = async () => {
    setQrLoading(true); setLoginMsg('');
    try {
      const r = await api.napcatRefreshQRCode();
      if (r.ok && r.data?.qrcode) {
        setQrImg(r.data.qrcode);
        startQrPolling();
      } else {
        setLoginMsg(r.data?.message || '刷新失败');
      }
    } catch { setLoginMsg('刷新失败'); }
    finally { setQrLoading(false); }
  };

  const handleQuickLoginOpen = async () => {
    setLoginModal('quick'); setQuickList([]); setLoginLoading(true); setLoginMsg('');
    try {
      const r = await api.napcatQuickLoginList();
      if (r.ok && r.data) {
        const list = Array.isArray(r.data) ? r.data : (r.data.QuickLoginList || r.data.quickLoginList || []);
        setQuickList(list.map((item: any) => typeof item === 'string' ? item : item.uin || String(item)));
        if (list.length === 0) {
          if (r.message?.includes('Logined') || r.data?.message?.includes('Logined')) {
            setLoginMsg('QQ 已登录，无需重复登录');
          } else {
            setLoginMsg('没有可用的快速登录账号，请先使用扫码登录一次');
          }
        }
      } else { setLoginMsg(r.message || r.error || '获取快速登录列表失败'); }
    } catch (err) { setLoginMsg('获取快速登录列表失败: ' + String(err)); }
    finally { setLoginLoading(false); }
  };

  const handleQuickLogin = async (uin: string) => {
    setLoginLoading(true); setLoginMsg('');
    try {
      const r = await api.napcatQuickLogin(uin);
      if (r.ok && (r.code === 0 || r.message?.includes('Logined'))) { setLoginMsg('登录成功！'); reload(); setTimeout(() => setLoginModal(null), 1500); }
      else { setLoginMsg(r.message || r.data?.message || r.error || '快速登录失败'); }
    } catch (err) { setLoginMsg('快速登录失败: ' + String(err)); }
    finally { setLoginLoading(false); }
  };

  const handlePasswordLoginOpen = () => {
    setLoginModal('password'); setLoginUin(''); setLoginPwd(''); setLoginMsg('');
  };

  const handlePasswordLogin = async () => {
    if (!loginUin || !loginPwd) { setLoginMsg('请输入QQ号和密码'); return; }
    setLoginLoading(true); setLoginMsg('');
    try {
      const r = await api.napcatPasswordLogin(loginUin, loginPwd);
      if (r.ok && (r.code === 0 || r.message?.includes('Logined'))) { setLoginMsg('登录成功！'); reload(); setTimeout(() => setLoginModal(null), 1500); }
      else { setLoginMsg(r.message || r.data?.message || r.error || '账密登录失败'); }
    } catch (err) { setLoginMsg('账密登录失败: ' + String(err)); }
    finally { setLoginLoading(false); }
  };

  const handleQQLogout = async () => {
    if (!confirm('确定要退出当前QQ登录？将重启 NapCat 容器，需要重新扫码登录。')) return;
    setLoginLoading(true); setLoginMsg('');
    try {
      const r = await api.napcatLogout();
      if (r.ok) {
        setMsg('QQ 正在退出登录，NapCat 容器重启中，请等待约 30 秒后重新扫码...');
        setTimeout(() => { reload(); setMsg(''); }, 15000);
      } else {
        setMsg(r.error || '退出登录失败');
      }
    } catch (err) { setMsg('退出登录失败: ' + String(err)); }
    finally { setLoginLoading(false); setTimeout(() => setMsg(''), 15000); }
  };

  const handleRestartNapcat = async () => {
    if (!confirm('确定要重启 NapCat 容器？重启期间 QQ 将暂时离线。')) return;
    setRestarting(true);
    try {
      const r = await api.napcatRestart();
      if (r.ok) {
        setMsg('NapCat 容器正在重启，请等待约 30 秒...');
        setTimeout(() => { reload(); setMsg(''); setRestarting(false); loadNapcatStatus(); }, 15000);
      } else {
        setMsg(r.error || '重启失败');
        setRestarting(false);
      }
    } catch (err) { setMsg('重启失败: ' + String(err)); setRestarting(false); }
  };

  const handleDiagnose = async (repair: boolean) => {
    setDiagnosing(true);
    setDiagnoseResult(null);
    try {
      const r = await api.napcatDiagnose(repair);
      if (r.ok) {
        setDiagnoseResult(r);
        loadNapcatStatus();
      } else {
        setMsg(r.error || '诊断失败');
      }
    } catch (err) { setMsg('诊断失败: ' + String(err)); }
    finally { setDiagnosing(false); }
  };

  // QR code polling: check login status every 3s after QR is shown
  const startQrPolling = () => {
    stopQrPolling();
    qrPollRef.current = setInterval(async () => {
      try {
        const r = await api.napcatLoginStatus();
        if (r.ok && r.data?.isLogin) {
          stopQrPolling();
          setLoginMsg('✅ 登录成功！');
          reload();
          loadNapcatStatus();
          setTimeout(() => setLoginModal(null), 1500);
        }
      } catch {}
    }, 3000);
  };

  const stopQrPolling = () => {
    if (qrPollRef.current) {
      clearInterval(qrPollRef.current);
      qrPollRef.current = null;
    }
  };

  // Cleanup polling on unmount or modal close
  useEffect(() => {
    if (!loginModal) stopQrPolling();
    return () => stopQrPolling();
  }, [loginModal]);

  const handleApprove = async (flag: string) => {
    await api.approveRequest(flag);
    setRequests(prev => prev.filter(r => r.flag !== flag));
  };
  const handleReject = async (flag: string) => {
    await api.rejectRequest(flag);
    setRequests(prev => prev.filter(r => r.flag !== flag));
  };

  // Sort channels: enabled first, then configured, then unconfigured
  const sortedBuiltin = CHANNEL_DEFS.filter(c => c.type === 'builtin').sort((a, b) => {
    const order = { enabled: 0, configured: 1, unconfigured: 2 };
    return order[getChannelStatus(a, ocConfig)] - order[getChannelStatus(b, ocConfig)];
  });
  const sortedPlugin = CHANNEL_DEFS.filter(c => c.type === 'plugin').sort((a, b) => {
    const order = { enabled: 0, configured: 1, unconfigured: 2 };
    return order[getChannelStatus(a, ocConfig)] - order[getChannelStatus(b, ocConfig)];
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold">{t.channels.title}</h2>
        <p className="text-xs text-gray-500 mt-0.5">{t.channels.subtitle} — <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />{t.channels.statusEnabled}</span> <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />{t.channels.statusConfigured}</span> <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block" />{t.channels.statusUnconfigured}</span></p>
      </div>

      {msg && (
        <div className={`px-3 py-2 rounded-lg text-xs ${msg.includes('失败') ? 'bg-red-50 dark:bg-red-950 text-red-600' : 'bg-emerald-50 dark:bg-emerald-950 text-emerald-600'}`}>
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Channel selector */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700/50 flex flex-col max-h-[75vh] overflow-hidden">
          <div className="p-3 border-b border-gray-100 dark:border-gray-700/50 bg-gray-50/50 dark:bg-gray-800/50">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider px-1">{t.channels.channelList}</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-4">
            <div>
              <h3 className="text-[10px] font-semibold text-gray-400 mb-2 px-2 uppercase tracking-wide">{t.channels.builtinChannels}</h3>
              <div className="space-y-1">
                {sortedBuiltin.map(ch => {
                  const st = getChannelStatus(ch, ocConfig);
                  return (
                    <button key={ch.id} onClick={() => setSelectedChannel(ch.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm transition-all duration-200 group ${
                        selectedChannel === ch.id
                          ? 'bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300 shadow-sm ring-1 ring-violet-100 dark:ring-violet-800'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                      }`}>
                      <div className={`p-1.5 rounded-md transition-colors ${selectedChannel === ch.id ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-600' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 group-hover:bg-white group-hover:shadow-sm'}`}>
                        <Radio size={14} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold truncate">{ch.label}</div>
                        <div className="text-[10px] text-gray-400 truncate opacity-80">{ch.description}</div>
                      </div>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(st)} ring-2 ring-white dark:ring-gray-800`} title={statusLabel(st)} />
                    </button>
                  );
                })}
              </div>
            </div>
            
            {sortedPlugin.length > 0 && (
              <div>
                <h3 className="text-[10px] font-semibold text-gray-400 mb-2 px-2 uppercase tracking-wide">{t.channels.pluginChannels}</h3>
                <div className="space-y-1">
                  {sortedPlugin.map(ch => {
                    const st = getChannelStatus(ch, ocConfig);
                    return (
                      <button key={ch.id} onClick={() => setSelectedChannel(ch.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm transition-all duration-200 group ${
                          selectedChannel === ch.id
                            ? 'bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300 shadow-sm ring-1 ring-violet-100 dark:ring-violet-800'
                            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                        }`}>
                        <div className={`p-1.5 rounded-md transition-colors ${selectedChannel === ch.id ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-600' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 group-hover:bg-white group-hover:shadow-sm'}`}>
                          <Radio size={14} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold truncate">{ch.label}</div>
                          <div className="text-[10px] text-gray-400 truncate opacity-80">{ch.description}</div>
                        </div>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(st)} ring-2 ring-white dark:ring-gray-800`} title={statusLabel(st)} />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Channel config */}
        <div className="lg:col-span-3 space-y-6">
          {/* QQ NapCat not installed overlay */}
          {currentDef && currentDef.id === 'qq' && !isContainerInstalled('napcat') && softwareList.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                <Package size={32} className="text-gray-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">NapCat (QQ个人号) 未安装</h3>
                <p className="text-sm text-gray-500 mt-1">
                  {serverPlatform === 'windows'
                    ? '需要安装 NapCat Shell 才能使用 QQ 个人号通道。安装后将自动配置 OneBot11 WebSocket 协议。'
                    : '需要安装 NapCat Docker 容器才能使用 QQ 个人号通道。安装后将自动配置 OneBot11 WebSocket 协议。'}
                </p>
              </div>
              {serverPlatform === 'windows' ? (
                <button
                  onClick={() => handleInstallContainer('napcat')}
                  disabled={installingSw !== null}
                  className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-xl bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-all shadow-lg shadow-violet-200 dark:shadow-none hover:shadow-xl"
                >
                  {installingSw ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  {installingSw ? '安装中...' : '一键安装 NapCat Shell'}
                </button>
              ) : !isContainerInstalled('docker') ? (
                <div className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-4 py-2 inline-block">
                  需要先安装 Docker，请前往 系统配置 → 运行环境 安装
                </div>
              ) : (
                <button
                  onClick={() => handleInstallContainer('napcat')}
                  disabled={installingSw !== null}
                  className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-xl bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-all shadow-lg shadow-violet-200 dark:shadow-none hover:shadow-xl"
                >
                  {installingSw ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  {installingSw ? '安装中...' : '一键安装 NapCat Docker'}
                </button>
              )}
              <p className="text-[11px] text-gray-400">安装进度可在左下角「消息中心」实时查看</p>
            </div>
          )}

          {/* Plugin channel not installed overlay (feishu, qqbot, dingtalk, wecom, etc.) */}
          {currentDef && currentDef.type === 'plugin' && currentDef.id !== 'qq' && !isPluginInstalled(currentDef.id) && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                <Package size={32} className="text-gray-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">{currentDef.label} 插件未安装</h3>
                <p className="text-sm text-gray-500 mt-1">
                  需要先安装 {currentDef.label} 插件才能配置此通道。请前往「插件中心」安装。
                </p>
              </div>
              <a href="#/plugins" className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-xl bg-violet-600 text-white hover:bg-violet-700 transition-all shadow-lg shadow-violet-200 dark:shadow-none hover:shadow-xl">
                <Download size={16} />
                前往插件中心安装
              </a>
            </div>
          )}

          {currentDef && !(
            (currentDef.id === 'qq' && !isContainerInstalled('napcat') && softwareList.length > 0) ||
            (currentDef.type === 'plugin' && currentDef.id !== 'qq' && !isPluginInstalled(currentDef.id))
          ) && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700/50 p-6 space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-4">
                  <div className={`p-2.5 rounded-xl ${isChannelEnabled(currentDef.id) ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
                    <Power size={20} />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="font-bold text-base text-gray-900 dark:text-white">{currentDef.label} {t.channels.config}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        getChannelStatus(currentDef, ocConfig) === 'enabled' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400' :
                        getChannelStatus(currentDef, ocConfig) === 'configured' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' :
                        'bg-gray-100 dark:bg-gray-800 text-gray-500'
                      }`}>{statusLabel(getChannelStatus(currentDef, ocConfig))}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{currentDef.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {/* Enable/Disable toggle switch */}
                  <div className="flex items-center gap-2 bg-gray-50 dark:bg-gray-900/50 px-3 py-1.5 rounded-lg border border-gray-100 dark:border-gray-800">
                    <span className={`text-[11px] font-medium ${isChannelEnabled(currentDef.id) ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}>
                      {isChannelEnabled(currentDef.id) ? t.channels.enabledState : t.channels.disabledState}
                    </span>
                    <button onClick={() => handleToggleEnabled(currentDef.id)}
                      className={`relative w-9 h-5 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-violet-500 ${isChannelEnabled(currentDef.id) ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${isChannelEnabled(currentDef.id) ? 'translate-x-4' : ''}`} />
                    </button>
                  </div>
                  
                  {currentDef.loginMethods && currentDef.loginMethods.length > 0 && (
                    <div className="flex items-center gap-2 border-l border-gray-200 dark:border-gray-700 pl-3 ml-1">
                      {currentDef.loginMethods.includes('qrcode') && (
                        <button onClick={handleQRLogin} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors">
                          <QrCode size={14} />{t.channels.qrLogin}
                        </button>
                      )}
                      {currentDef.loginMethods.includes('quick') && (
                        <button onClick={handleQuickLoginOpen} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors">
                          <Zap size={14} />{t.channels.quickLogin}
                        </button>
                      )}
                      {currentDef.loginMethods.includes('password') && (
                        <button onClick={handlePasswordLoginOpen} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors">
                          <Key size={14} />{t.channels.passwordLogin}
                        </button>
                      )}
                      {currentDef.id === 'qq' && (
                        <>
                          <button onClick={handleQQLogout} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors">
                            <LogOut size={14} />{t.channels.logoutQQ}
                          </button>
                          <button onClick={handleRestartNapcat} disabled={restarting} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/50 disabled:opacity-50 transition-colors">
                            {restarting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                            {restarting ? '重启中...' : '重启NapCat'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* NapCat Connection Status */}
              {currentDef.id === 'qq' && napcatStatus && (
                <div className={`rounded-xl border p-4 mb-2 ${
                  napcatStatus.status === 'online' ? 'bg-emerald-50/50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800/30' :
                  napcatStatus.status === 'reconnecting' ? 'bg-amber-50/50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/30' :
                  napcatStatus.status === 'login_expired' ? 'bg-orange-50/50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-800/30' :
                  'bg-red-50/50 dark:bg-red-900/10 border-red-200 dark:border-red-800/30'
                }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-2.5 h-2.5 rounded-full ${
                        napcatStatus.status === 'online' ? 'bg-emerald-500 animate-pulse' :
                        napcatStatus.status === 'reconnecting' ? 'bg-amber-500 animate-pulse' :
                        napcatStatus.status === 'login_expired' ? 'bg-orange-500' :
                        'bg-red-500'
                      }`} />
                      <div>
                        <span className="text-sm font-semibold text-gray-900 dark:text-white">
                          {napcatStatus.status === 'online' ? '🟢 NapCat 在线' :
                           napcatStatus.status === 'reconnecting' ? '🟡 正在重连...' :
                           napcatStatus.status === 'login_expired' ? '🟠 登录已失效' :
                           napcatStatus.status === 'stopped' ? '🔴 容器已停止' :
                           '🔴 NapCat 离线'}
                        </span>
                        {napcatStatus.qqId && (
                          <span className="ml-2 text-xs text-gray-500">
                            {napcatStatus.qqNickname || napcatStatus.qqId} ({napcatStatus.qqId})
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {napcatStatus.autoReconnect && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400">
                          自动重连 {napcatStatus.reconnectCount > 0 ? `(${napcatStatus.reconnectCount}/${napcatStatus.maxReconnect})` : '已启用'}
                        </span>
                      )}
                      {(napcatStatus.status === 'offline' || napcatStatus.status === 'stopped') && (
                        <button onClick={handleReconnect} disabled={reconnecting}
                          className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-900/50 disabled:opacity-50 transition-colors">
                          <RefreshCw size={11} className={reconnecting ? 'animate-spin' : ''} />
                          {reconnecting ? '重连中...' : '手动重连'}
                        </button>
                      )}
                      <button onClick={() => { setShowReconnectLogs(!showReconnectLogs); if (!showReconnectLogs) loadReconnectLogs(); }}
                        className="text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors underline">
                        {showReconnectLogs ? '收起日志' : '重连日志'}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-[11px] text-gray-500">
                    <span>容器: {napcatStatus.containerRunning ? '✅ 运行中' : '❌ 未运行'}</span>
                    <span>WS: {napcatStatus.wsConnected ? '✅ 已连接' : '❌ 未连接'}</span>
                    <span>HTTP: {napcatStatus.httpAvailable ? '✅ 可用' : '❌ 不可用'}</span>
                    <span>QQ: {napcatStatus.qqLoggedIn ? '✅ 已登录' : '❌ 未登录'}</span>
                  </div>
                  {showReconnectLogs && reconnectLogs.length > 0 && (
                    <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3 space-y-1.5 max-h-40 overflow-y-auto">
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">重连日志</p>
                      {reconnectLogs.slice(-10).reverse().map((log: any, i: number) => (
                        <div key={i} className="flex items-center gap-2 text-[11px]">
                          <span className={log.success ? 'text-emerald-500' : 'text-red-500'}>{log.success ? '✅' : '❌'}</span>
                          <span className="text-gray-400 font-mono">{new Date(log.time).toLocaleTimeString()}</span>
                          <span className="text-gray-600 dark:text-gray-400">{log.reason}</span>
                          {log.detail && <span className="text-gray-400 truncate">— {log.detail}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* NapCat Diagnose & Repair */}
              {currentDef.id === 'qq' && isContainerInstalled('napcat') && (
                <div className="rounded-xl border border-gray-100 dark:border-gray-700/50 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Wrench size={16} className="text-violet-500" />
                      <span className="text-sm font-bold text-gray-900 dark:text-white">NapCat 诊断修复</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => handleDiagnose(false)} disabled={diagnosing}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 transition-colors">
                        {diagnosing ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                        {diagnosing ? '诊断中...' : '检测状态'}
                      </button>
                      <button onClick={() => handleDiagnose(true)} disabled={diagnosing}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-all shadow-sm">
                        {diagnosing ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                        {diagnosing ? '修复中...' : '诊断并修复'}
                      </button>
                    </div>
                  </div>
                  {diagnoseResult && (
                    <div className="space-y-2">
                      <div className={`px-3 py-2 rounded-lg text-xs font-medium ${
                        diagnoseResult.summary?.includes('✅') ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600' :
                        diagnoseResult.summary?.includes('🔧') ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' :
                        'bg-red-50 dark:bg-red-900/20 text-red-600'
                      }`}>
                        {diagnoseResult.summary}
                      </div>
                      <div className="space-y-1 max-h-60 overflow-y-auto">
                        {diagnoseResult.steps?.map((step: any, i: number) => (
                          <div key={i} className="flex items-start gap-2 text-[11px] px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-900/30">
                            <span className="shrink-0 mt-0.5">
                              {step.status === 'ok' ? <CheckCircle size={13} className="text-emerald-500" /> :
                               step.status === 'fixed' ? <CheckCircle size={13} className="text-blue-500" /> :
                               step.status === 'warning' ? <AlertTriangle size={13} className="text-amber-500" /> :
                               step.status === 'error' ? <AlertCircle size={13} className="text-red-500" /> :
                               <Check size={13} className="text-gray-400" />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-gray-700 dark:text-gray-300">{step.step}</span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase ${
                                  step.status === 'ok' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600' :
                                  step.status === 'fixed' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600' :
                                  step.status === 'warning' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600' :
                                  step.status === 'error' ? 'bg-red-100 dark:bg-red-900/30 text-red-600' :
                                  'bg-gray-100 dark:bg-gray-800 text-gray-500'
                                }`}>{step.status}</span>
                              </div>
                              <p className="text-gray-600 dark:text-gray-400">{step.message}</p>
                              {step.detail && <p className="text-gray-400 text-[10px] mt-0.5">{step.detail}</p>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Restarting overlay */}
              {currentDef.id === 'qq' && restarting && (
                <div className="rounded-xl border-2 border-dashed border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-900/10 p-6 flex flex-col items-center justify-center gap-3">
                  <Loader2 size={32} className="animate-spin text-orange-500" />
                  <p className="text-sm font-medium text-orange-600 dark:text-orange-400">NapCat 正在重启中，请稍候...</p>
                  <p className="text-[11px] text-gray-400">重启期间 QQ 将暂时离线，通常需要 15-30 秒</p>
                </div>
              )}

              {/* 飞书双版本选择器 */}
              {currentDef.id === 'feishu' && (
                <div className="rounded-xl border border-violet-200 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-900/10 p-4 space-y-3">
                  <div className="text-sm font-semibold text-gray-900 dark:text-white">当前飞书实现</div>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <label className={`flex-1 flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                      getActiveFeishuVariant(ocConfig) === 'official'
                        ? 'border-violet-500 bg-violet-100/50 dark:bg-violet-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-violet-300 dark:hover:border-violet-600'
                    }`}>
                      <input type="radio" name="feishu-variant" value="official"
                        checked={getActiveFeishuVariant(ocConfig) === 'official'}
                        onChange={() => handleSwitchFeishuVariant('official')}
                        className="mt-0.5 accent-violet-600" />
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white">飞书官方版</div>
                        <div className="text-[11px] text-gray-500 mt-0.5">支持用户身份授权、文档/日历/任务操作、流式卡片、话题独立上下文</div>
                      </div>
                    </label>
                    <label className={`flex-1 flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                      getActiveFeishuVariant(ocConfig) === 'clawteam'
                        ? 'border-violet-500 bg-violet-100/50 dark:bg-violet-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-violet-300 dark:hover:border-violet-600'
                    }`}>
                      <input type="radio" name="feishu-variant" value="clawteam"
                        checked={getActiveFeishuVariant(ocConfig) === 'clawteam'}
                        onChange={() => handleSwitchFeishuVariant('clawteam')}
                        className="mt-0.5 accent-violet-600" />
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white">ClawTeam 社区版</div>
                        <div className="text-[11px] text-gray-500 mt-0.5">社区维护的基础飞书通道插件，支持话题回复、输入提示等</div>
                      </div>
                    </label>
                  </div>
                  {!getActiveFeishuVariant(ocConfig) && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">未检测到已启用的飞书插件，请选择一个版本并启用</p>
                  )}
                </div>
              )}

              {currentDef.id === 'feishu' && (
                <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-gray-900 dark:text-white">Account 兼容模式</div>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        默认使用简版单账号语法；开启「完整版 Account」后，会额外维护
                        <span className="mx-1 font-mono">channels.feishu.accounts/defaultAccount</span>
                        ，并与 Agent 路由里的 <span className="font-mono">accountId</span> 对齐。
                      </p>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        当前配置仍共享 <span className="font-mono">channels.feishu</span>；默认账号的凭证会同步镜像到顶层
                        <span className="mx-1 font-mono">appId/appSecret</span>
                        ，兼容简版与完整版两种写法。
                      </p>
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/30">
                      <span className={`text-xs ${feishuAdvancedAccounts ? 'text-violet-600 dark:text-violet-400 font-medium' : 'text-gray-500'}`}>
                        {feishuAdvancedAccounts ? '已开启完整版 Account' : '当前为简版单账号'}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleToggleFeishuAdvancedAccounts(!feishuAdvancedAccounts)}
                        className={`relative w-9 h-5 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-violet-500 ${feishuAdvancedAccounts ? 'bg-violet-600' : 'bg-gray-300 dark:bg-gray-600'}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${feishuAdvancedAccounts ? 'translate-x-4' : ''}`} />
                      </button>
                    </div>
                  </div>

                  {!feishuAdvancedAccounts && hasFeishuAdvancedAccounts(currentFeishuConfig) && (
                    <div className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-amber-50/70 dark:bg-amber-900/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
                      当前配置已存在多账号结构；关闭完整版 Account 仅隐藏编辑区，不会删除已有账号。简版输入会继续编辑默认账号
                      {currentFeishuDefaultAccount ? `（${currentFeishuDefaultAccount}）` : ''} 的凭证镜像。
                    </div>
                  )}

                  <div className="rounded-xl border border-gray-100 dark:border-gray-700 p-4 space-y-4">
                    <div>
                      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">基础凭证</h4>
                      <p className="text-xs text-gray-500 mt-1">
                        {currentFeishuVariant === 'official'
                          ? '官方版早期仍在快速迭代，面板优先展示确认过的共享字段。'
                          : currentFeishuVariant === 'clawteam'
                            ? 'ClawTeam 版字段更明确；这里仍统一写入 channels.feishu 共享配置。'
                            : '未检测到活动变体时，也会先写入共享的 channels.feishu 配置。'}
                      </p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">App ID</label>
                        <input
                          value={feishuAdvancedAccounts ? String(currentFeishuAccountConfig.appId || '') : currentFeishuSimpleCredentials.appId}
                          onChange={e => {
                            const value = e.target.value;
                            if (feishuAdvancedAccounts) handleFeishuAccountFieldChange(feishuActiveAccountId || currentFeishuDefaultAccount, 'appId', value);
                            else handleFeishuSimpleFieldChange('appId', value);
                          }}
                          placeholder="cli_xxx"
                          className="w-full px-3.5 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">App Secret</label>
                        <input
                          type="password"
                          value={feishuAdvancedAccounts ? String(currentFeishuAccountConfig.appSecret || '') : currentFeishuSimpleCredentials.appSecret}
                          onChange={e => {
                            const value = e.target.value;
                            if (feishuAdvancedAccounts) handleFeishuAccountFieldChange(feishuActiveAccountId || currentFeishuDefaultAccount, 'appSecret', value);
                            else handleFeishuSimpleFieldChange('appSecret', value);
                          }}
                          placeholder="请输入 App Secret"
                          className="w-full px-3.5 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                        />
                      </div>
                    </div>
                    {!feishuAdvancedAccounts && (
                      <p className="text-[11px] text-gray-500 leading-relaxed">
                        简版模式下只需维护顶层 <span className="font-mono">appId/appSecret</span>；如要给不同飞书机器人分配不同 Agent，再开启完整版 Account。
                      </p>
                    )}
                  </div>

                  {feishuAdvancedAccounts && (
                    <div className="rounded-xl border border-gray-100 dark:border-gray-700 p-4 space-y-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                        <div>
                          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">完整版 Account 管理</h4>
                          <p className="text-xs text-gray-500 mt-1">
                            默认账号会被 Agent 路由里的空 <span className="font-mono">accountId</span> 命中；写入后会同步镜像到顶层凭证。
                          </p>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            value={feishuNewAccountId}
                            onChange={e => setFeishuNewAccountId(e.target.value)}
                            placeholder="新 Account ID，例如 backup"
                            className="px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                          />
                          <button
                            type="button"
                            onClick={handleAddFeishuAccount}
                            className="px-3 py-2 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700"
                          >
                            添加 Account
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] gap-4">
                        <div className="space-y-3">
                          <div>
                            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">默认账号</label>
                            <select
                              value={currentFeishuDefaultAccount}
                              onChange={e => handleFeishuDefaultAccountChange(e.target.value)}
                              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                            >
                              {currentFeishuAccounts.map(accountId => (
                                <option key={accountId} value={accountId}>{accountId}</option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-2">
                            {currentFeishuAccounts.map(accountId => (
                              <button
                                key={accountId}
                                type="button"
                                onClick={() => setFeishuActiveAccountId(accountId)}
                                className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                                  feishuActiveAccountId === accountId
                                    ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300'
                                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 hover:border-violet-300'
                                }`}
                              >
                                <span className="truncate">{accountId}</span>
                                {accountId === currentFeishuDefaultAccount && (
                                  <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300">默认</span>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-lg border border-gray-100 dark:border-gray-700 p-4 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-gray-900 dark:text-white">当前编辑：{feishuActiveAccountId}</div>
                              <p className="text-xs text-gray-500 mt-1">如果它被设为默认账号，顶层 appId/appSecret 会自动同步为这个账号的值。</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveFeishuAccount(feishuActiveAccountId)}
                              className="px-3 py-2 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-900/20"
                            >
                              删除当前账号
                            </button>
                          </div>
                          <div className="text-[11px] text-gray-500">
                            Agent 页面里的路由会自动读取这里的 <span className="font-mono">accounts/defaultAccount</span>，从而为 <span className="font-mono">accountId</span> 提供下拉选择。
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {currentDef.id === 'feishu' && hasFeishuGroupAllowlistConflict && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-amber-50/70 dark:bg-amber-900/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                  当前 <span className="font-mono">groupPolicy</span> 为 <span className="font-mono">{currentFeishuGroupPolicy}</span>，
                  <span className="mx-1 font-mono">groupAllowFrom</span>
                  仅在 <span className="font-mono">allowlist</span> 模式下生效。若保持当前策略并保存，白名单会被自动清理。
                </div>
              )}

              <form id="channel-config-form" className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5" onSubmit={e => { e.preventDefault(); handleSave(); }}>
                {currentDef.configFields.map(field => {
                  const rawCurrentVal = getFieldValue(currentDef.id, field.key);
                  const currentVal = currentDef.id === 'feishu' && field.key === 'requireMention'
                    ? (rawCurrentVal === true ? 'true' : rawCurrentVal === false ? 'false' : (rawCurrentVal ?? ''))
                    : rawCurrentVal;
                  const isFullWidth = field.type === 'toggle' || field.key === 'webhookUrl' || field.key === 'token' || field.key === 'accessToken' || field.key === 'appSecret' || field.key === 'groupAllowFrom';
                  
                  return (
                    <div key={field.key} className={isFullWidth ? "md:col-span-2" : ""}>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300">
                          {field.label}
                        </label>
                        {field.help && <span className="text-[10px] text-gray-400">{field.help}</span>}
                      </div>
                      
                      {field.type === 'toggle' ? (
                        <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/30">
                          <button type="button"
                            onClick={() => currentDef.id === 'feishu' ? toggleDraftField(currentDef.id, field.key) : handleToggleField(currentDef.id, field.key)}
                            className={`relative w-9 h-5 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-violet-500 ${currentVal ? 'bg-violet-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${currentVal ? 'translate-x-4' : ''}`} />
                          </button>
                          <span className={`text-xs ${currentVal ? 'text-violet-600 dark:text-violet-400 font-medium' : 'text-gray-500'}`}>
                            {currentVal ? t.channels.opened : t.channels.closed}
                          </span>
                        </div>
                      ) : field.type === 'select' ? (
                        <div className="relative">
                          <select
                            name={field.key}
                            defaultValue={currentVal ?? ''}
                            className={`w-full px-3.5 py-2 text-sm border rounded-lg bg-white dark:bg-gray-900 transition-all focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/30 focus:border-violet-500 outline-none
                              ${(currentVal !== undefined && currentVal !== null && currentVal !== '')
                                ? 'border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                                : 'border-gray-200 dark:border-gray-800 text-gray-400'}`}
                          >
                            <option value="">未配置</option>
                            {field.options?.map(opt => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div className="relative">
                          <input
                            name={field.key}
                            type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                            defaultValue={currentVal ?? ''}
                            placeholder={field.placeholder || '未配置'}
                            className={`w-full px-3.5 py-2 text-sm border rounded-lg bg-white dark:bg-gray-900 transition-all focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/30 focus:border-violet-500 outline-none
                              ${(currentVal !== undefined && currentVal !== null && currentVal !== '') 
                                ? 'border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100' 
                                : 'border-gray-200 dark:border-gray-800 text-gray-400'}`}
                          />
                          {(currentVal !== undefined && currentVal !== null && currentVal !== '') && (
                            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500">
                              <Check size={14} strokeWidth={3} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </form>

              {currentDef.configFields.length === 0 && (
                <div className="py-12 flex flex-col items-center justify-center text-gray-400 border-2 border-dashed border-gray-100 dark:border-gray-800 rounded-xl">
                  <Sparkles size={32} className="mb-2 opacity-20" />
                  <p className="text-sm">{t.channels.noConfigNeeded}</p>
                </div>
              )}

              <div className="flex items-center justify-end pt-4 border-t border-gray-50 dark:border-gray-800">
                <button onClick={handleSave} disabled={saving}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 shadow-sm shadow-violet-200 dark:shadow-none transition-all hover:shadow-md hover:shadow-violet-200 dark:hover:shadow-none">
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  {saving ? t.channels.saving : t.channels.saveConfig}
                </button>
              </div>
            </div>
          )}

          {/* QQ Requests — only when QQ selected */}
          {selectedChannel === 'qq' && requests.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700/50 p-5 space-y-4">
              <div className="flex items-center gap-3 pb-2 border-b border-gray-50 dark:border-gray-800">
                <div className="p-1.5 rounded-lg bg-violet-100 dark:bg-violet-900/30 text-violet-600">
                  <UserCheck size={18} />
                </div>
                <h3 className="font-bold text-sm text-gray-900 dark:text-white">{t.channels.pendingRequests}</h3>
                <span className="bg-red-100 text-red-600 text-xs font-bold px-2 py-0.5 rounded-full">{requests.length}</span>
              </div>
              <div className="space-y-2.5">
                {requests.map((r: any) => (
                  <div key={r.flag} className="flex items-center gap-4 px-4 py-3 rounded-xl bg-gray-50 dark:bg-gray-900/30 border border-gray-100 dark:border-gray-800 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.type === 'group' ? 'bg-indigo-100 text-indigo-700' : 'bg-pink-100 text-pink-700'}`}>
                          {r.type === 'group' ? t.channels.groupRequest : t.channels.friendRequest}
                        </span>
                        <span className="font-mono text-gray-900 dark:text-gray-100 font-medium">{r.userId || r.groupId || ''}</span>
                      </div>
                      {r.comment && <div className="text-gray-500 text-xs truncate">{t.channels.comment}: "{r.comment}"</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => handleApprove(r.flag)} className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors" title={t.channels.approve}>
                        <Check size={16} />
                      </button>
                      <button onClick={() => handleReject(r.flag)} className="p-2 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors" title={t.channels.reject}>
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* QQ Login Modal */}
      {loginModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setLoginModal(null)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden transform transition-all border border-gray-100 dark:border-gray-800" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between bg-gray-50/50 dark:bg-gray-900">
              <h3 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
                {loginModal === 'qrcode' && <><QrCode size={18} className="text-blue-500" /> QQ {t.channels.qrLogin}</>}
                {loginModal === 'quick' && <><Zap size={18} className="text-emerald-500" /> QQ {t.channels.quickLogin}</>}
                {loginModal === 'password' && <><Key size={18} className="text-amber-500" /> QQ {t.channels.passwordLogin}</>}
              </h3>
              <button onClick={() => setLoginModal(null)} className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {loginMsg && (
                <div className={`px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2 ${loginMsg.includes(t.common.success) || loginMsg.includes('success') ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600' : 'bg-red-50 dark:bg-red-900/30 text-red-600'}`}>
                   {loginMsg.includes(t.common.success) || loginMsg.includes('success') ? <Check size={16} /> : <X size={16} />}
                  {loginMsg}
                </div>
              )}

              {/* QR Code Login */}
              {loginModal === 'qrcode' && (
                <div className="flex flex-col items-center gap-3">
                  {qrLoading ? (
                    <div className="w-48 h-48 flex items-center justify-center bg-gray-50 dark:bg-gray-800 rounded-lg">
                      <Loader2 size={24} className="animate-spin text-gray-400" />
                    </div>
                  ) : qrImg ? (
                    <img src={qrImg.startsWith('data:') ? qrImg : `data:image/png;base64,${qrImg}`} alt="QR Code" className="w-48 h-48 rounded-lg border border-gray-200 dark:border-gray-700" />
                  ) : (
                    <div className="w-48 h-48 flex items-center justify-center bg-gray-50 dark:bg-gray-800 rounded-lg text-xs text-gray-400">
                      {t.channels.cannotLoadQR}
                    </div>
                  )}
                  <p className="text-xs text-gray-500">{t.channels.scanQR}</p>
                  <button onClick={handleRefreshQR} disabled={qrLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                    <RefreshCw size={12} className={qrLoading ? 'animate-spin' : ''} />{t.channels.refreshQR}
                  </button>
                </div>
              )}

              {/* Quick Login */}
              {loginModal === 'quick' && (
                <div className="space-y-2">
                  {loginLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-gray-400" /></div>
                  ) : quickList.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-8">{t.channels.noQuickAccounts}</p>
                  ) : (
                    <>
                      <p className="text-xs text-gray-500">{t.channels.selectQuickAccount}</p>
                      {quickList.map(uin => (
                        <button key={uin} onClick={() => handleQuickLogin(uin)}
                          className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-50 dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-950 text-sm transition-colors">
                          <Zap size={14} className="text-emerald-500" />
                          <span className="font-mono">{uin}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}

              {/* Password Login */}
              {loginModal === 'password' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{t.channels.qqNumberLabel}</label>
                    <input type="text" value={loginUin} onChange={e => setLoginUin(e.target.value)}
                      placeholder={t.channels.qqNumberPlaceholder} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{t.channels.passwordLabel}</label>
                    <input type="password" value={loginPwd} onChange={e => setLoginPwd(e.target.value)}
                      placeholder={t.channels.passwordPlaceholder} className="w-full px-3 py-2 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent" />
                  </div>
                  <button onClick={handlePasswordLogin} disabled={loginLoading || !loginUin || !loginPwd}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
                    {loginLoading ? <Loader2 size={12} className="animate-spin" /> : <Key size={12} />}
                    {loginLoading ? t.login.loggingIn : t.login.loginButton}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
