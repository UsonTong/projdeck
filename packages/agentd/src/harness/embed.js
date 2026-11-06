/*
 * 仅在 /harness/?embed=1 中启用。复用原版 uiWorkspace / layout 服务，不重绘聊天、不修改用户 profile。
 * 适配 dsh 0.2.1-rc.2 的客户端模块协议；父子页面只交换会话 ID，不传凭据或消息正文。
 */
(() => {
  const CHANNEL = 'projdeck-harness';
  const standalone = window.parent === window;
  if (standalone && new URL(location.href).searchParams.get('embed') !== '1') return;
  document.documentElement.dataset.projdeckEmbed = 'loading';
  const send = (type, data = {}) => window.parent.postMessage({ channel: CHANNEL, type, ...data }, location.origin);
  let stop;
  const bind = (owner) => {
    document.documentElement.dataset.projdeckEmbed = 'applied';
    owner.plugin({ name: 'projdeck-harness-embedded', inject: ['uiWorkspace', 'sessions', 'layout'], apply(ctx) {
    stop?.();
    ctx.effect(() => {
      document.documentElement.dataset.projdeckEmbed = 'bound';
      const workspace = ctx.get('uiWorkspace');
      const sessions = ctx.get('sessions');
      const layout = ctx.get('layout');
      if (!workspace?.openSession || !workspace.selection?.subscribe || !sessions?.list || !layout?.beginNavigation) {
        send('error', { message: '此 Harness 版本暂不支持嵌入会话联动，可单独打开原版网页。' });
        return;
      }
      let command;
      let accepted = false;
      let deadline;
      let applying = false;
      const selected = () => {
        const id = workspace.selection.getSnapshot().sessionId;
        if (!accepted || typeof id !== 'string') return;
        document.documentElement.dataset.projdeckSession = id;
        send('selected', { sessionId: id, commandId: command?.commandId });
      };
      const apply = () => {
        if (!command || accepted || applying) return;
        const snapshot = sessions.list.getSnapshot();
        if (snapshot.phase !== 'ready') return;
        if (command.sessionId !== null && !snapshot.byId[command.sessionId]) return;
        applying = true;
        try {
          // 取消原版启动时尚未结束的默认会话导航，防止它覆盖父页面选中的会话。
          layout.beginNavigation();
          if (command.sessionId !== null) workspace.openSession(command.sessionId);
          accepted = true;
          clearTimeout(deadline);
          selected();
          send('selected', { sessionId: workspace.selection.getSnapshot().sessionId ?? null, commandId: command.commandId });
        } catch {
          send('error', { commandId: command.commandId, message: '无法打开此 Harness 会话，请刷新后重试。' });
        } finally { applying = false; }
      };
      const message = (event) => {
        if (event.source !== window.parent || event.origin !== location.origin) return;
        const msg = event.data;
        if (msg?.channel !== CHANNEL || msg.type !== 'select' || !Number.isSafeInteger(msg.commandId)) return;
        if (msg.sessionId !== null && (typeof msg.sessionId !== 'string' || !msg.sessionId || msg.sessionId.length > 512)) return;
        clearTimeout(deadline);
        command = { sessionId: msg.sessionId, commandId: msg.commandId };
        accepted = false;
        deadline = setTimeout(() => send('error', { commandId: msg.commandId, message: '等待 Harness 会话同步超时，可刷新或单独打开原版。' }), 15000);
        apply();
      };
      const unlist = sessions.list.subscribe(apply);
      const unselected = workspace.selection.subscribe(selected);
      window.addEventListener('message', message);
      // 保留导航列的 grid item，不能用 display:none：原版中心/右列是自动排位，移除首项会把聊天挤进 0px 轨道。
      const style = document.createElement('style');
      style.textContent = '[data-projdeck-harness-frame]>div:first-of-type{visibility:hidden!important;pointer-events:none!important;overflow:hidden!important;min-width:0!important;width:0!important;box-sizing:border-box!important;border:0!important;padding:0!important}[data-projdeck-harness-frame] [data-side="left"]{display:none!important}[data-projdeck-harness-frame] [aria-label="打开侧边栏"],[data-projdeck-harness-frame] [aria-label="Open sidebar"],[data-projdeck-harness-frame] [aria-label="收起侧边栏"],[data-projdeck-harness-frame] [aria-label="Collapse sidebar"]{display:none!important}';
      document.head.append(style);
      const compact = () => {
        const frame = document.querySelector('[data-rightbar-collapsed], [data-rightbar-fullscreen], [data-sidebar-collapsed]');
        if (!frame) return;
        frame.setAttribute('data-projdeck-harness-frame', '');
        const columns = frame.style.gridTemplateColumns;
        const next = columns.replace(/^[\d.]+px\s+/, '0px ');
        if (next !== columns) frame.style.gridTemplateColumns = next;
      };
      const observer = new MutationObserver(compact);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-sidebar-collapsed', 'data-rightbar-collapsed'] });
      compact();
      send('ready');
      // 安卓内嵌 WebView 没有父网页，通过非敏感的 session 查询参数选择同一个会话。
      if (standalone) {
        const id = new URL(location.href).searchParams.get('session');
        message({ source: window, origin: location.origin, data: { channel: CHANNEL, type: 'select', sessionId: id || null, commandId: 1 } });
      }
      // 原生 WebView 复用页面时，通过自定义事件切换会话，避免每次重新加载整个 SPA。
      let nativeCommand = 0;
      const nativeSelect = (event) => {
        if (!standalone) return;
        const id = event?.detail;
        if (id !== null && (typeof id !== 'string' || id.length > 512)) return;
        message({
          source: window, origin: location.origin,
          data: { channel: CHANNEL, type: 'select', sessionId: id || null, commandId: ++nativeCommand + 100000 },
        });
      };
      window.addEventListener('projdeck-select', nativeSelect);
      stop = () => {
        clearTimeout(deadline); unlist(); unselected();
        window.removeEventListener('message', message); window.removeEventListener('projdeck-select', nativeSelect); observer.disconnect(); style.remove();
      };
      return stop;
    }, 'projdeck: embedded original Harness navigation');
    } });
  };
  const hooked = new WeakSet();
  const intercept = (loader) => {
    if (!loader || typeof loader.load !== 'function' || hooked.has(loader)) return loader;
    hooked.add(loader);
    const wrap = (load) => function (record, ...args) {
      if (record?.id === '@deepseek-ai/dsh-client-ui-workspace' && typeof record.factory === 'function') {
        document.documentElement.dataset.projdeckEmbed = 'registered';
        const factory = record.factory;
        record = { ...record, factory: (...params) => {
          const exports = factory(...params);
          if (typeof exports.apply !== 'function') return exports;
          return { ...exports, apply: function (ctx, ...rest) {
            const result = exports.apply.call(this, ctx, ...rest);
            bind(ctx);
            return result;
          } };
        } };
      }
      return load.call(this, record, ...args);
    };
    // 原版从预加载队列进入运行态时会替换 load；两阶段都需要保留这个很小的导航适配。
    let load = wrap(loader.load);
    Object.defineProperty(loader, 'load', { configurable: true,
      get: () => load, set: next => { load = wrap(next); },
    });
    return loader;
  };
  let loader = intercept(window.__ModuleLoader__);
  Object.defineProperty(window, '__ModuleLoader__', { configurable: true,
    get: () => loader, set: value => { loader = intercept(value); },
  });
})();
