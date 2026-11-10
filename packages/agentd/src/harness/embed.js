/*
 * 仅在 /harness/?embed=1 中启用。复用原版 uiWorkspace / layout 服务，不重绘聊天、不修改用户 profile。
 * 适配 dsh 0.2.1-rc.2 的客户端模块协议；父子页面只交换会话 ID，不传凭据或消息正文。
 */
(() => {
  const CHANNEL = 'projdeck-harness';
  const standalone = window.parent === window;
  if (standalone && new URL(location.href).searchParams.get('embed') !== '1') return;
  document.documentElement.dataset.projdeckEmbed = 'loading';
  // 原版启动时会从 localStorage 恢复「上次看的会话」，而且晚于下面的切换几毫秒，会把目标会话覆盖掉。
  // 在原版模块运行前把目标写进它记住的选中项，让它恢复出来的就是目标会话。
  const initial = new URL(location.href).searchParams.get('session');
  if (initial && initial.length <= 512) {
    try { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: initial })); } catch { /* 无痕模式等 */ }
  }
  /** 切换后这段时间内，原版自己把选中项改走（启动恢复等）一律改回目标会话。 */
  const GUARD_MS = 2500;
  /** 最多遮住这么久：历史迟迟加载不完也要露出界面，不能卡在空白。 */
  const REVEAL_MAX_MS = 4000;
  // 启动和切换会话期间遮住原版界面（启动画面、空白新会话页、「Loading history…」），
  // 目标会话的历史渲染好后再淡入。超过 0.4 秒才出现转圈，快速切换不闪。
  const root = document.documentElement;
  const veil = document.createElement('style');
  // 遮住是瞬间的（不能让加载画面淡出时露出来），揭开时淡入
  veil.textContent = 'html[data-projdeck-pending] body{opacity:0!important;pointer-events:none!important;transition:none!important}'
    + 'body{transition:opacity .18s ease-out}'
    + 'html[data-projdeck-pending]::after{content:"";position:fixed;left:50%;top:50%;width:18px;height:18px;margin:-11px;'
    + 'border:2px solid rgba(128,128,128,.55);border-top-color:transparent;border-radius:50%;opacity:0;'
    + 'animation:projdeck-spin .8s linear infinite,projdeck-fade .2s .4s forwards}'
    + '@keyframes projdeck-spin{to{transform:rotate(360deg)}}@keyframes projdeck-fade{to{opacity:1}}';
  (document.head ?? root).append(veil);
  const conceal = () => { root.dataset.projdeckPending = ''; };
  const uncover = () => { delete root.dataset.projdeckPending; };
  conceal();
  // 原版版本不兼容、嵌入适配没生效时，不能一直遮着
  const bootSafety = setTimeout(uncover, 15000);
  const send = (type, data = {}) => window.parent.postMessage({ channel: CHANNEL, type, ...data }, location.origin);
  let stop;
  const bind = (owner) => {
    document.documentElement.dataset.projdeckEmbed = 'applied';
    clearTimeout(bootSafety);
    owner.plugin({ name: 'projdeck-harness-embedded', inject: ['uiWorkspace', 'sessions', 'layout'], apply(ctx) {
    stop?.();
    ctx.effect(() => {
      document.documentElement.dataset.projdeckEmbed = 'bound';
      const workspace = ctx.get('uiWorkspace');
      const sessions = ctx.get('sessions');
      const layout = ctx.get('layout');
      if (!workspace?.openSession || !workspace.selection?.subscribe || !sessions?.list || !layout?.beginNavigation) {
        uncover();
        send('error', { message: '此 Harness 版本暂不支持嵌入会话联动，可单独打开原版网页。' });
        return;
      }
      let command;
      let accepted = false;
      let deadline;
      let applying = false;
      let guardUntil = 0;
      let reassert;
      let revealTimer;
      /** 历史还在加载：对话列里有「Loading history…」提示（原版的 *_hint 元素）。 */
      const loading = () => !!document.querySelector('[data-chat-flow]')?.querySelector?.(':scope > [class$="_hint"], :scope > [class*="_hint "]');
      /** 目标会话渲染好后揭开遮罩并告诉父页面；没被遮住（同一个会话）时立即告诉。 */
      const reveal = (commandId, sessionId) => {
        clearTimeout(revealTimer);
        if (root.dataset.projdeckPending === undefined) { send('shown', { sessionId, commandId }); return; }
        const started = Date.now();
        const tick = () => {
          const waited = Date.now() - started;
          // 至少等原版把新会话渲染出来（选中后下一帧才换掉旧会话的画面）
          if (waited < 80 || (loading() && waited < REVEAL_MAX_MS)) { revealTimer = setTimeout(tick, 40); return; }
          revealTimer = undefined;
          uncover();
          send('shown', { sessionId, commandId });
        };
        tick();
      };
      const selected = () => {
        const id = workspace.selection.getSnapshot().sessionId;
        if (!accepted || typeof id !== 'string') return;
        const target = command?.sessionId;
        if (target && id !== target && Date.now() < guardUntil) {
          // 不能在原版的选中通知里同步再切换（它还没更新完内部引用），放到下一轮执行；也不把这个临时的选中项报告给父页面
          clearTimeout(reassert);
          reassert = setTimeout(() => {
            reassert = undefined;
            if (command?.sessionId === target && workspace.selection.getSnapshot().sessionId !== target) workspace.openSession(target);
          }, 0);
          return;
        }
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
          guardUntil = Date.now() + GUARD_MS;
          clearTimeout(deadline);
          selected();
          send('selected', { sessionId: workspace.selection.getSnapshot().sessionId ?? null, commandId: command.commandId });
          reveal(command.commandId, workspace.selection.getSnapshot().sessionId ?? null);
        } catch {
          uncover();
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
        // 换到别的会话才遮住；同一个会话（例如父页面重新显示）保持原样
        if (msg.sessionId !== null && msg.sessionId !== workspace.selection.getSnapshot().sessionId) conceal();
        deadline = setTimeout(() => {
          uncover();
          send('error', { commandId: msg.commandId, message: '等待 Harness 会话同步超时，可刷新或单独打开原版。' });
        }, 15000);
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
        clearTimeout(deadline); clearTimeout(reassert); clearTimeout(revealTimer); unlist(); unselected();
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
