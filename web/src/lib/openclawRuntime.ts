export interface OpenClawRuntimeHealth {
  state: 'not_configured' | 'healthy' | 'degraded' | 'offline';
  healthy: boolean;
  degraded: boolean;
  processRunning: boolean;
  gatewayRunning: boolean;
  title: string;
  message: string;
}

export function resolveOpenClawRuntime(openclawStatus?: any, processStatus?: any, gatewayStatus?: any): OpenClawRuntimeHealth {
  const runtime = openclawStatus?.runtime;
  if (runtime && typeof runtime === 'object') {
    return {
      state: runtime.state || 'offline',
      healthy: !!runtime.healthy,
      degraded: !!runtime.degraded,
      processRunning: !!runtime.processRunning,
      gatewayRunning: !!runtime.gatewayRunning,
      title: runtime.title || 'OpenClaw 运行状态未知',
      message: runtime.message || '无法确认 OpenClaw 当前运行状态。',
    };
  }

  const configured = !!openclawStatus?.configured;
  const processRunning = !!processStatus?.running;
  const gatewayRunning = !!gatewayStatus?.running;

  if (!configured) {
    return {
      state: 'not_configured',
      healthy: false,
      degraded: false,
      processRunning,
      gatewayRunning,
      title: 'OpenClaw 尚未安装或配置',
      message: '当前页面可浏览，但模型、通道和网关相关能力尚未就绪。',
    };
  }

  if (processRunning && gatewayRunning) {
    return {
      state: 'healthy',
      healthy: true,
      degraded: false,
      processRunning,
      gatewayRunning,
      title: 'OpenClaw 运行正常',
      message: 'OpenClaw 与网关均在线，消息处理与配置写入可正常进行。',
    };
  }

  if (processRunning || gatewayRunning) {
    return {
      state: 'degraded',
      healthy: false,
      degraded: true,
      processRunning,
      gatewayRunning,
      title: gatewayRunning ? '网关在线，但运行状态异常' : 'OpenClaw 进程存在，但网关离线',
      message: gatewayRunning
        ? 'OpenClaw 网关仍可访问，但面板未确认到稳定主进程；运行相关页面可能出现状态不同步。'
        : 'ClawPanel 检测到 OpenClaw 进程仍在运行，但消息网关当前不可达；通道收发和 AI 请求可能失败。',
    };
  }

  return {
    state: 'offline',
    healthy: false,
    degraded: true,
    processRunning: false,
    gatewayRunning: false,
    title: 'OpenClaw 与网关均离线',
    message: '当前运行环境异常，依赖 OpenClaw 的页面可能无法保存配置、安装插件或处理消息。',
  };
}
