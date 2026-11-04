/* Self-contained DSH browser bundle; React is supplied by the host. */
window.__ModuleLoader__.load({
  id: 'dsh-history-rag',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    const css = `
.hrag{max-width:780px;color:var(--dsw-alias-label-primary,#242628);font-family:inherit;line-height:1.55;padding:4px 0 24px;color-scheme:light;--hr-muted:var(--dsw-alias-label-secondary,#777c86);--hr-line:var(--dsw-alias-border-l2,rgba(128,138,158,.25));--hr-bg:var(--dsw-alias-bg-layer-2,#f4f5f7);--hr-input:var(--dsw-alias-bg-layer-1,#fff);--hr-error:#b34a45;--hr-accent:#3478ed}
body[data-ds-dark-theme] .hrag{color-scheme:dark;color:var(--dsw-alias-label-primary,#e8eaed);--hr-muted:var(--dsw-alias-label-secondary,#a0a5af);--hr-bg:var(--dsw-alias-bg-layer-2,#303238);--hr-input:var(--dsw-alias-bg-layer-1,#25272c);--hr-error:#f0928b}
.hrag *{box-sizing:border-box}.hrag h2{font-size:21px;letter-spacing:-.4px;margin:0;font-weight:650}.hrag p{margin:5px 0 0}.hrag .hr-muted{color:var(--hr-muted);font-size:13px}.hrag .hr-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:22px}.hrag .hr-pill{font-size:12px;color:var(--hr-muted);background:var(--hr-bg);border:1px solid var(--hr-line);padding:4px 10px;border-radius:20px;white-space:nowrap}
.hrag .hr-card{border:1px solid var(--hr-line);border-radius:13px;padding:22px;margin-top:18px;background:transparent}.hrag h3{margin:0 0 18px;font-size:15px;font-weight:650}.hrag label.hr-field{display:block;font-size:13px;font-weight:550;margin-top:17px}.hrag label.hr-field:first-of-type{margin-top:0}.hrag input[type=url],.hrag input[type=text],.hrag input[type=password]{display:block;width:100%;border:1px solid var(--hr-line);border-radius:8px;padding:10px 12px;background:var(--hr-input);color:inherit;font:inherit;font-size:14px;outline:none;margin-top:7px;transition:border-color .15s,box-shadow .15s}
.hrag input:focus{border-color:var(--hr-accent);box-shadow:0 0 0 3px rgba(52,120,237,.12)}.hrag input:disabled{opacity:.6}.hrag .hr-key{position:relative}.hrag .hr-key input{padding-right:60px}.hrag .hr-key button{position:absolute;right:6px;top:6px;border:0;background:none;color:var(--hr-muted);padding:6px;font-size:12px}.hrag .hr-note{font-size:12px;color:var(--hr-muted);margin-top:5px}.hrag .hr-check{display:flex;align-items:center;gap:7px;font-size:12px;margin-top:9px;color:var(--hr-muted)}.hrag input[type=checkbox]{accent-color:var(--hr-accent)}
.hrag button{cursor:pointer;font:inherit;font-size:13px;border:1px solid var(--hr-line);border-radius:8px;padding:9px 14px;color:inherit;background:transparent}.hrag button:hover:enabled{background:var(--hr-bg)}.hrag button:disabled{opacity:.48;cursor:default}.hrag button.hr-primary{background:var(--hr-accent);border-color:var(--hr-accent);color:#fff}.hrag button.hr-primary:hover:enabled{background:#2468da}.hrag .hr-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:22px}.hrag .hr-feedback{padding:9px 11px;border-radius:7px;margin-top:13px;font-size:13px;white-space:pre-wrap;background:rgba(52,120,237,.07)}.hrag .hr-feedback[data-error=true]{color:#b34a45;background:rgba(190,69,59,.08)}
.hrag .hr-models{display:flex;align-items:center;gap:9px;margin-top:9px;flex-wrap:wrap}.hrag .hr-models select{flex:1;min-width:180px;max-width:100%;border:1px solid var(--hr-line);border-radius:8px;padding:9px;color:inherit;background:var(--hr-input);font:inherit;font-size:13px}.hrag .hr-models button{white-space:nowrap}.hrag .hr-feedback{overflow-wrap:anywhere}
.hrag textarea{display:block;width:100%;min-height:190px;max-height:560px;resize:vertical;padding:12px;border:1px solid var(--hr-line);border-radius:8px;background:var(--hr-input);color:inherit;font:inherit;font-size:14px;line-height:1.7;margin-top:8px}.hrag textarea:focus{outline:2px solid rgba(52,120,237,.25)}.hrag .hr-memory-meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:8px;color:var(--hr-muted);font-size:12px}
.hrag a{color:var(--hr-accent);text-decoration:none}.hrag a:hover{text-decoration:underline}.hrag .hr-update-version{font-size:12px;color:var(--hr-muted);white-space:nowrap}.hrag .hr-update-line{margin-top:12px;font-size:14px}.hrag .hr-update-line[data-available=true]{color:var(--hr-accent);font-weight:600}
.hrag .hr-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.hrag .hr-section-head h3{margin:0}.hrag .hr-section-head button{padding:6px 10px;font-size:12px}.hrag .hr-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:17px 0 22px}.hrag .hr-stat{padding:13px;border-radius:9px;background:var(--hr-bg)}.hrag .hr-stat strong{font-size:24px;font-weight:600;display:block;letter-spacing:-.5px;line-height:1.3}.hrag .hr-stat span{color:var(--hr-muted);font-size:12px}.hrag .hr-progress-label{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin:15px 0 6px}.hrag progress{display:block;width:100%;height:7px;border:0;overflow:hidden;border-radius:10px;accent-color:var(--hr-accent);background:var(--hr-bg)}.hrag progress::-webkit-progress-bar{background:var(--hr-bg);border-radius:10px}.hrag progress::-webkit-progress-value{background:var(--hr-accent);border-radius:10px}.hrag .hr-state{font-size:13px;display:flex;gap:8px;align-items:center}.hrag .hr-dot{width:7px;height:7px;border-radius:100%;background:var(--hr-accent);flex-shrink:0}.hrag details{font-size:12px;color:var(--hr-muted);margin-top:14px}.hrag summary{cursor:pointer}.hrag code{word-break:break-all;font-size:11px}.hrag .hr-footer{margin-top:15px;color:var(--hr-muted);font-size:12px}.hrag .hr-error{color:#b34a45}
@media(max-width:560px){.hrag .hr-card{padding:16px}.hrag .hr-stats{gap:6px}.hrag .hr-stat{padding:10px}.hrag .hr-stat strong{font-size:21px}.hrag .hr-head{align-items:flex-start}.hrag h2{font-size:19px}.hrag .hr-actions button{flex:1}}
.hrag input[type=url],.hrag input[type=text],.hrag input[type=password],.hrag textarea,.hrag select,.hrag option,.hrag optgroup{background:var(--hr-input);color:inherit}.hrag input::placeholder,.hrag textarea::placeholder{color:var(--hr-muted);opacity:.85}.hrag .hr-error,.hrag .hr-feedback[data-error=true]{color:var(--hr-error)}
`;
    const number = value => Number(value || 0).toLocaleString('zh-CN');
    const errors = { HTTP_401: 'Embedding 鉴权失败，请检查 Key', HTTP_403: 'Embedding 接口拒绝访问', HTTP_429: 'Embedding 接口限流或额度不足', NETWORK_ERROR: '无法连接 Embedding 服务', ABORTED: 'Embedding 请求已取消或超时', DIMENSION_MISMATCH: '向量维度不一致', KEY_FILE_ERROR: '无法读取本地 Key 文件' };

    function SettingsPage({ call }) {
      const [settings, setSettings] = useState(null);
      const [endpoint, setEndpoint] = useState('');
      const [model, setModel] = useState('');
      const [key, setKey] = useState('');
      const [clearKey, setClearKey] = useState(false);
      const [showKey, setShowKey] = useState(false);
      const [models, setModels] = useState(null);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState('');
      const [feedback, setFeedback] = useState(null);
      const [pollError, setPollError] = useState(false);
      const [memory, setMemory] = useState(null);
      const [memoryText, setMemoryText] = useState('');
      const [memoryAuto, setMemoryAuto] = useState(true);
      const [memoryModel, setMemoryModel] = useState('');
      const [memoryModels, setMemoryModels] = useState([]);
      const [memoryModelsBusy, setMemoryModelsBusy] = useState(false);
      const [memoryDirty, setMemoryDirty] = useState(false);
      const [memoryBusy, setMemoryBusy] = useState('');
      const [memoryFeedback, setMemoryFeedback] = useState(null);
      const [updateBusy, setUpdateBusy] = useState(false);
      const [updateFeedback, setUpdateFeedback] = useState('');
      const memoryDirtyRef = useRef(false);
      const memoryRevisionRef = useRef(null);
      const backendReady = useRef(false);
      const mounted = useRef(true);
      const requests = useRef(new Set());
      const invoke = async (action, payload = {}) => {
        const abort = new AbortController(); requests.current.add(abort);
        const timeout = setTimeout(() => abort.abort(), action === 'scan' ? 30000 : action === 'updates-check' ? 65000 : 15000);
        try { return await call(action, payload, abort.signal); }
        finally { clearTimeout(timeout); requests.current.delete(abort); }
      };
      const accept = value => {
        setSettings(value); setEndpoint(value.embeddingEndpoint); setModel(value.embeddingModel);
        setKey(''); setClearKey(false); setShowKey(false); setModels(null);
      };
      const load = async () => {
        try { const value = await invoke('settings'); if (mounted.current) {
          accept(value); setFeedback(null); backendReady.current = value.apiVersion >= 2;
          if (!backendReady.current) setMemoryFeedback({ error: true, text: '设置页已更新，但插件后台仍是旧版。请从「应用 → 退出」完全退出 DSH 后重新打开，再加载摘要。' });
          else if (memoryRevisionRef.current === null) { loadMemory(); loadMemoryModels(); }
        } }
        catch (error) { if (mounted.current) setFeedback({ error: true, text: error.message || '设置加载失败，请重试' }); }
      };
      const acceptMemory = value => {
        setMemory(value); setMemoryText(value.text); setMemoryAuto(value.autoUpdate);
        setMemoryModel(value.modelSelection ? JSON.stringify([value.modelSelection.provider, value.modelSelection.model]) : '');
        memoryRevisionRef.current = value.revision; memoryDirtyRef.current = false; setMemoryDirty(false);
      };
      const loadMemory = async () => {
        if (!backendReady.current) { await load(); return; }
        setMemoryBusy('load');
        try { const value = await invoke('memory'); if (mounted.current) { acceptMemory(value); setMemoryFeedback(null); } }
        catch (error) { if (mounted.current) setMemoryFeedback({ error: true, text: error.message || '摘要加载失败' }); }
        finally { if (mounted.current) setMemoryBusy(''); }
      };
      const loadMemoryModels = async () => {
        if (!backendReady.current) return;
        setMemoryModelsBusy(true);
        try { const value = await invoke('memory-models'); if (mounted.current) setMemoryModels(value.providers); }
        catch (error) { if (mounted.current) setMemoryFeedback({ error: true, text: error.message || 'DSH 模型列表加载失败，请重试' }); }
        finally { if (mounted.current) setMemoryModelsBusy(false); }
      };
      useEffect(() => {
        mounted.current = true;
        load();
        let timer;
        const poll = async () => {
          try {
            const value = await invoke('status');
            if (mounted.current) {
              setStatus(value); setPollError(false);
              if (backendReady.current && value.memory && value.memory.revision !== memoryRevisionRef.current && !memoryDirtyRef.current) {
                const fresh = await invoke('memory');
                if (mounted.current && !memoryDirtyRef.current && fresh.revision >= (memoryRevisionRef.current ?? -1)) acceptMemory(fresh);
              }
            }
          }
          catch { if (mounted.current) setPollError(true); }
          if (mounted.current) timer = setTimeout(poll, 2000);
        };
        poll();
        return () => { mounted.current = false; clearTimeout(timer); for (const abort of requests.current) abort.abort(); requests.current.clear(); };
      }, []);
      const payload = () => ({ embeddingEndpoint: endpoint.trim(), embeddingModel: model.trim(),
        apiKey: key, clearApiKey: clearKey, expectedRevision: settings.revision });
      const perform = async action => {
        if (!settings || busy) return;
        setBusy(action); setFeedback(null);
        try {
          const value = await invoke(action, action === 'scan' ? {} : payload());
          if (!mounted.current) return;
          if (action === 'save') { accept(value); setStatus(await invoke('status')); }
          else if (action === 'scan') setStatus(value);
          else if (action === 'models') setModels(value.models);
          setFeedback({ error: false, text: action === 'test'
            ? `连接成功 · ${number(value.dimensions)} 维 · ${number(value.elapsedMs)} ms${value.endpoint ? `\n请求地址：${value.endpoint}` : ''}`
            : action === 'models' ? value.models.length
              ? `已获取 ${number(value.models.length)} 个模型${value.truncated ? '（部分列表，可继续手填）' : ''}。疑似向量模型优先展示；请选择后测试连接。`
              : '服务返回的模型列表为空，仍可手动填写模型后测试连接。'
            : action === 'save' ? '已保存，后台索引会自动继续。' : '已开始检查历史对话。' });
        } catch (error) { if (mounted.current) setFeedback({ error: true, text: error.message || '操作失败，请重试' }); }
        finally { if (mounted.current) setBusy(''); }
      };
      const editMemory = () => { memoryDirtyRef.current = true; setMemoryDirty(true); setMemoryFeedback(null); };
      const performMemory = async action => {
        if (!memory || memoryBusy) return;
        setMemoryBusy(action); setMemoryFeedback(null);
        try {
          const selected = memoryModel ? JSON.parse(memoryModel) : null;
          const result = await invoke(action, action === 'memory-save' ? { text: memoryText, autoUpdate: memoryAuto, expectedRevision: memory.revision,
            modelSelection: selected ? { provider: selected[0], model: selected[1] } : null } : {});
          if (!mounted.current) return;
          if (action === 'memory-save') acceptMemory(result);
          const currentStatus = await invoke('status');
          if (!mounted.current) return;
          setStatus(currentStatus);
          setMemoryFeedback({ error: false, text: action === 'memory-save' ? '摘要已保存，新会话会自动带入。' : '已请求在后台逐批整理待处理片段，可继续聊天。' });
        } catch (error) { if (mounted.current) setMemoryFeedback({ error: true, text: error.message || '摘要操作失败，草稿已保留' }); }
        finally { if (mounted.current) setMemoryBusy(''); }
      };
      const memoryState = status?.memory;
      const memoryFailure = memoryState?.lastError;
      const memoryFailureText = memoryFailure ? ({
        SUMMARY_TRUNCATED: `模型达到摘要输出上限${memoryFailure.maxTokens ? `（${number(memoryFailure.maxTokens)} token）` : ''}。此批已停止自动重试，原摘要和待处理片段已保留。`,
        SUMMARY_INPUT_TOO_LARGE: '原文片段超过单批输入上限，待处理片段已保留。',
        SUMMARY_TOO_LONG: '模型返回的摘要超过字符上限，已保留原摘要。', SUMMARY_EMPTY: '模型未返回摘要正文，已保留原摘要。',
        ABORTED: '摘要请求已取消或超时。', TIMEOUT: '摘要模型响应超时。', TRANSPORT: '摘要模型连接失败，请检查 DSH 中该模型的连接。',
        NO_ADAPTER: '摘要模型的服务商尚未启用，请在 DSH 中检查模型配置。',
        ACCOUNT_TOKEN_INVALID: 'DSH 账号登录状态失效，请重新登录。', ACCOUNT_QUOTA_EXCEEDED: 'DSH 账号额度不足，请检查账号余额。',
        UNEXPECTED_ERROR: 'DSH 模型适配器处理失败，请检查插件与 DSH 版本。',
      }[memoryFailure.code] || '摘要模型调用失败，请检查 DSH 中所选模型的配置。') : '';
      const memoryStateText = memoryState?.running ? '正在后台更新摘要…'
        : memoryFailure?.code === 'SUMMARY_TRUNCATED' ? '摘要队列已暂停，可调整预算或手动重试。'
        : memoryState?.autoUpdate === false ? '自动更新已暂停，已保存的摘要仍会带入新会话。'
        : memoryState?.retryAt > Date.now() ? '上次摘要更新未完成，稍后会自动重试；已保存的摘要仍可使用。'
        : memoryState?.pending && !memoryState.modelReady ? '等待 DSH 默认聊天模型；你也可以先手动填写摘要。'
        : memoryState?.pending ? `等待整理 ${number(memoryState.pending)} 个新增原文片段，后台会在对话稳定后更新。`
        : memoryState?.hasText ? '摘要已就绪，新会话会自动带入。' : '尚无摘要，可手动填写，或等待后台根据历史对话生成。';
      const locks = settings?.locks || {};
      const updates = status?.updates;
      const updateResult = updates?.result;
      const repository = 'https://github.com/viiiseven/dsh-history-memory';
      let updateUrl = repository;
      try {
        const link = new URL(updateResult?.url || repository);
        if (link.origin === 'https://github.com' && !link.username && !link.password
          && (link.pathname === '/viiiseven/dsh-history-memory' || link.pathname.startsWith('/viiiseven/dsh-history-memory/'))) updateUrl = link.href;
      } catch {}
      const checkUpdates = async () => {
        if (updateBusy || updates?.checking) return;
        setUpdateBusy(true); setUpdateFeedback('');
        try {
          const value = await invoke('updates-check');
          if (mounted.current) setStatus(previous => ({ ...previous, updates: value }));
        } catch (error) { if (mounted.current) setUpdateFeedback(error.message || '更新检查暂未完成，请稍后重试'); }
        finally { if (mounted.current) setUpdateBusy(false); }
      };
      const updateText = updates?.checking || updateBusy ? '正在检查 GitHub…'
        : updates?.error ? ({ TIMEOUT: '检查超时，将在稍后自动重试。', RATE_LIMITED: 'GitHub 暂时限流，已延后重试。', INVALID_RESPONSE: '仓库返回的信息无法识别，请稍后重试。' }[updates.error.code] || '暂时无法完成检查，将在稍后自动重试。')
        : !updateResult ? updates?.enabled === false ? '自动检查已关闭，仍可手动检查。' : '启动后自动检查，之后默认每 6 小时检查一次。'
        : updateResult.kind === 'release' ? `发现新版本 ${updateResult.latestVersion}`
        : updateResult.kind === 'version' ? `仓库版本已更新至 ${updateResult.latestVersion}`
        : updateResult.kind === 'commit' ? '仓库有新提交（版本号未变）'
        : updateResult.kind === 'local-newer' ? '当前安装的版本或提交领先于仓库。'
        : updateResult.kind === 'diverged' ? '当前安装与仓库存在不同修改，可查看差异。'
        : updateResult.kind === 'version-only' ? `版本号一致（${updateResult.latestVersion}），尚未核对提交差异。`
        : `当前版本与仓库一致（${updateResult.latestVersion}）。`;
      const updateNote = updateResult?.note === 'RATE_LIMITED' ? 'GitHub API 限流，本次已改用公开版本文件；同版本号的提交变化暂未检查。'
        : ['LOCAL_CHANGES', 'NO_BUILD_COMMIT', 'UNKNOWN_BUILD_COMMIT'].includes(updateResult?.note) ? '当前构建缺少可比较的提交标识或包含本地修改，本次仅比较版本号。'
        : updateResult?.note ? '本次仅核对公开版本号，提交差异检查暂不可用。' : '';
      const failures = status?.state?.sessionFailures || [];
      const progress = status?.progress || status?.state?.indexProgress;
      const discovered = progress?.total ?? status?.state?.lastScan?.discoveredSessions;
      const pending = status?.pending || 0;
      let stateText = '正在读取索引状态…';
      if (status) {
        if (progress?.phase === 'failed') stateText = '历史扫描失败，请检查后重试';
        else if (progress?.phase === 'listing') stateText = '正在发现历史会话…';
        else if (status.indexing) stateText = '正在读取历史原文';
        else if (!status.configured) stateText = '等待配置 Embedding，原文索引仍会继续建立';
        else if (failures.length) stateText = `有 ${number(failures.length)} 个会话读取失败，将自动重试`;
        else if (status.embeddingRetryAt > Date.now()) stateText = 'Embedding 请求未完成，正在等待自动重试';
        else if (pending) stateText = '正在为原文生成向量';
        else if (!status.chunks) stateText = '还没有历史原文，开始聊天后会自动建立索引';
        else stateText = '索引已就绪，新对话会自动同步';
      }
      const sourcePercent = progress?.total ? Math.min(100, progress.completed / progress.total * 100) : progress?.phase === 'complete' ? 100 : undefined;
      const vectorPercent = status?.chunks ? Math.min(100, status.embeddedChunks / status.chunks * 100) : 0;
      const field = (label, id, value, change, placeholder, disabled, note) => h('label', { className: 'hr-field', htmlFor: id }, label,
        h('input', { id, type: id === 'hr-endpoint' ? 'url' : 'text', value, onChange: e => change(e.target.value), placeholder, disabled, autoComplete: 'off', spellCheck: false }),
        h('div', { className: 'hr-note' }, note));
      const stat = (label, value) => h('div', { className: 'hr-stat' }, h('strong', null, value), h('span', null, label));
      return h('section', { className: 'hrag', 'aria-label': '对话历史 RAG 设置' },
        h('div', { className: 'hr-head' }, h('div', null, h('h2', null, '对话历史 RAG'), h('p', { className: 'hr-muted' }, '把聊过的原话，带回当前对话。')),
          h('span', { className: 'hr-pill' }, status?.configured ? '已配置' : '待配置')),
        h('div', { className: 'hr-card', 'aria-label': '插件更新' },
          h('div', { className: 'hr-section-head' }, h('h3', null, '插件更新'), h('span', { className: 'hr-update-version' }, updates ? `当前版本 ${updates.currentVersion}` : '读取版本信息…')),
          h('p', { className: 'hr-note' }, '检查 GitHub 新版本及源码提交，升级由你决定。'),
          h('p', { className: 'hr-update-line', 'data-available': Boolean(updateResult?.available), role: 'status' }, updateText),
          updateNote ? h('p', { className: 'hr-note' }, updateNote) : null,
          updates?.lastCheckedAt ? h('p', { className: 'hr-note' }, `上次检查：${new Date(updates.lastCheckedAt).toLocaleString('zh-CN')}${updates.enabled && updates.nextCheckAt ? ` · 下次自动检查：${new Date(updates.nextCheckAt).toLocaleString('zh-CN')}` : ''}`) : null,
          updates?.canCheckAt > Date.now() ? h('p', { className: 'hr-note' }, `下次可手动检查：${new Date(updates.canCheckAt).toLocaleString('zh-CN')}`) : null,
          h('div', { className: 'hr-actions' },
            h('button', { type: 'button', disabled: !updates || updateBusy || updates.checking || updates.canCheckAt > Date.now(), onClick: checkUpdates }, updateBusy || updates?.checking ? '正在检查…' : '检查插件更新'),
            h('a', { href: updateUrl, target: '_blank', rel: 'noopener noreferrer' }, updateResult?.available ? '查看更新' : updateResult?.kind === 'diverged' ? '查看差异' : '打开 GitHub 仓库')),
          updateFeedback ? h('p', { className: 'hr-error', role: 'alert' }, updateFeedback) : null),
        h('form', { className: 'hr-card', 'aria-label': '常驻记忆摘要设置', onSubmit: e => { e.preventDefault(); performMemory('memory-save'); } },
          h('h3', null, '常驻记忆摘要'),
          h('p', { className: 'hr-note' }, '一份跨会话共享的摘要。新会话首次发送时自动带入；同会话不重复，压缩移出后会补回。'),
          h('label', { className: 'hr-field', htmlFor: 'hr-memory-model' }, '摘要生成模型'),
          h('div', { className: 'hr-models' },
            h('select', { id: 'hr-memory-model', value: memoryModel, disabled: !memory || Boolean(memoryBusy), onChange: e => { setMemoryModel(e.target.value); editMemory(); } },
              h('option', { value: '' }, '跟随对话模型（默认）'),
              memoryModel && !memoryModels.some(p => p.models.some(m => JSON.stringify([p.id, m.id]) === memoryModel))
                ? h('option', { value: memoryModel }, `已保存：${JSON.parse(memoryModel).join(' / ')}`) : null,
              ...memoryModels.map(p => h('optgroup', { key: p.id, label: p.name }, ...p.models.map(m => h('option', { key: m.id, value: JSON.stringify([p.id, m.id]) }, m.name))))),
            h('button', { type: 'button', disabled: !memory || memoryModelsBusy, onClick: loadMemoryModels }, memoryModelsBusy ? '正在读取…' : '刷新 DSH 模型')),
          h('p', { className: 'hr-note' }, '默认使用最近对话实际选用的模型；尚未聊天时使用 DSH 默认模型。指定模型同样沿用本机 .dsh 的接口和 Key，选择后请保存摘要。'),
          h('label', { className: 'hr-field', htmlFor: 'hr-memory' }, '摘要内容',
            h('textarea', { id: 'hr-memory', value: memoryText, maxLength: memoryState?.maxChars || 6000,
              placeholder: '用户背景、偏好、当前进展、约定和待办…', disabled: !memory || Boolean(memoryBusy),
              onChange: e => { setMemoryText(e.target.value); editMemory(); } })),
          h('div', { className: 'hr-memory-meta' }, h('span', null, memory?.updatedAt ? `更新于 ${new Date(memory.updatedAt).toLocaleString('zh-CN')} · ${memory.source === 'manual' ? '手动保存' : '自动整理'}` : '尚未生成'),
            h('span', null, `${number(memoryText.length)} / ${number(memoryState?.maxChars || 6000)} 字符${memoryDirty ? ' · 未保存' : ''}`)),
          h('label', { className: 'hr-check' }, h('input', { id: 'hr-memory-auto', type: 'checkbox', checked: memoryAuto, disabled: !memory || Boolean(memoryBusy),
            onChange: e => { setMemoryAuto(e.target.checked); editMemory(); } }), '后台自动增量更新'),
          h('p', { className: 'hr-note', role: 'status' }, memoryStateText),
          memoryFailure ? h('p', { className: 'hr-error', role: 'alert' }, `${memoryFailureText}（${memoryFailure.code}${memoryFailure.status ? ` · HTTP ${memoryFailure.status}` : ''}）`) : null,
          memoryState?.running && memoryState.startedAt ? h('p', { className: 'hr-note' }, `本次已等待 ${Math.max(0, Math.floor((Date.now() - memoryState.startedAt) / 1000))} 秒；完成后会自动显示摘要。`) : null,
          memoryState ? h('p', { className: 'hr-note' }, `已整理 ${number(memoryState.processed)} / ${number(memoryState.total)} 个去重原文片段${memoryState.model ? ` · 摘要模型：${memoryState.model}` : ''}`) : null,
          memoryDirty && memoryState && memoryState.revision !== memory?.revision ? h('p', { className: 'hr-error', role: 'alert' }, '后台摘要已更新，当前草稿未被覆盖。请复制草稿，再重新加载摘要后合并保存。') : null,
          h('div', { className: 'hr-actions' },
            h('button', { type: 'submit', className: 'hr-primary', disabled: !memory || Boolean(memoryBusy) }, memoryBusy === 'memory-save' ? '正在保存…' : '保存摘要'),
            h('button', { type: 'button', disabled: !memory || Boolean(memoryBusy) || Boolean(memoryState?.running) || !memoryState?.modelReady || memoryDirty, onClick: () => performMemory('memory-update') }, '立即更新摘要'),
            h('button', { type: 'button', disabled: Boolean(memoryBusy), onClick: loadMemory }, '重新加载摘要')),
          memoryFeedback ? h('div', { className: 'hr-feedback', 'data-error': memoryFeedback.error, role: memoryFeedback.error ? 'alert' : 'status' }, memoryFeedback.text) : null,
          h('p', { className: 'hr-footer' }, '自动更新通过 DSH 调用所选聊天模型，会产生该模型用量；仅处理新增原文，原文 RAG 继续独立工作。')),
        h('form', { className: 'hr-card', 'aria-label': 'Embedding 服务设置', onSubmit: e => { e.preventDefault(); perform('save'); } },
          h('h3', null, 'Embedding 服务'),
          field('接口地址', 'hr-endpoint', endpoint, value => { setEndpoint(value); setModels(null); setFeedback(null); }, 'https://example.com/v1', !settings || Boolean(locks.embeddingEndpoint) || Boolean(busy),
            locks.embeddingEndpoint ? '由环境变量或插件配置提供。' : '支持基础地址（如 …/v1）或完整 Embedding 请求地址，会自动补全 /embeddings。'),
          field('模型', 'hr-model', model, setModel, '填写服务商提供的向量模型名称', !settings || Boolean(locks.embeddingModel) || Boolean(busy),
            locks.embeddingModel ? '由环境变量或插件配置提供。' : '可手动填写，也可填好 Key 后获取模型列表。选择后请测试连接。'),
          h('div', { className: 'hr-models' },
            h('button', { type: 'button', disabled: !settings || Boolean(busy) || !endpoint.trim(), onClick: () => perform('models') }, busy === 'models' ? '正在获取…' : '获取模型列表'),
            models?.length ? h('select', { id: 'hr-model-select', 'aria-label': '从服务模型列表选择', value: models.some(item => item.id === model) ? model : '',
              disabled: Boolean(locks.embeddingModel) || Boolean(busy), onChange: e => { if (e.target.value) setModel(e.target.value); } },
              h('option', { value: '' }, '选择模型（仍可在上方手填）'),
              ...[true, false].map(likely => models.some(item => item.likelyEmbedding === likely) ? h('optgroup', { key: String(likely), label: likely ? '疑似向量模型' : '其他模型（能力待验证）' },
                ...models.filter(item => item.likelyEmbedding === likely).map(item => h('option', { key: item.id, value: item.id }, item.id))) : null)) : null),
          h('label', { className: 'hr-field', htmlFor: 'hr-key' }, 'API Key',
            h('div', { className: 'hr-key' }, h('input', { id: 'hr-key', type: showKey ? 'text' : 'password', value: key, autoComplete: 'new-password', spellCheck: false,
              placeholder: settings?.key.configured ? '已配置，留空保留原 Key' : '本地无鉴权服务可留空', disabled: !settings || locks.apiKey || Boolean(busy),
              onChange: e => { setKey(e.target.value); setModels(null); if (e.target.value) setClearKey(false); } }),
              h('button', { type: 'button', onClick: () => setShowKey(!showKey), disabled: !key, 'aria-label': showKey ? '隐藏 Key' : '显示 Key' }, showKey ? '隐藏' : '显示')),
            h('div', { className: 'hr-note' }, locks.apiKey ? 'Key 由环境变量或插件配置提供，请在对应位置修改。' : 'Key 保存在本机，已保存的 Key 不会回显。')),
          settings?.key.configured && !locks.apiKey ? h('label', { className: 'hr-check' }, h('input', { type: 'checkbox', checked: clearKey, disabled: Boolean(busy),
            onChange: e => { setClearKey(e.target.checked); setModels(null); if (e.target.checked) setKey(''); } }), '清除已保存的 Key') : null,
          h('div', { className: 'hr-actions' },
            h('button', { type: 'button', disabled: !settings || Boolean(busy) || !endpoint.trim() || !model.trim(), onClick: () => perform('test') }, busy === 'test' ? '正在测试…' : '测试连接'),
            h('button', { className: 'hr-primary', type: 'submit', disabled: !settings || Boolean(busy) || !endpoint.trim() || !model.trim() }, busy === 'save' ? '正在保存…' : '保存并开始索引'),
            h('button', { type: 'button', onClick: load, disabled: Boolean(busy) }, '重新加载设置')),
          feedback ? h('div', { className: 'hr-feedback', 'data-error': feedback.error, role: feedback.error ? 'alert' : 'status' }, feedback.text) : null),
        h('div', { className: 'hr-card' },
          h('div', { className: 'hr-section-head' }, h('h3', null, '索引进度'), h('button', { type: 'button', disabled: !settings || Boolean(busy), onClick: () => perform('scan') }, busy === 'scan' ? '正在检查…' : '检查历史')),
          h('div', { className: 'hr-state', role: 'status' }, h('span', { className: 'hr-dot', 'aria-hidden': true }), stateText),
          pollError ? h('p', { className: 'hr-error', role: 'alert' }, '进度暂时无法刷新，正在重试。') : null,
          h('div', { className: 'hr-stats' }, stat('发现的会话', discovered == null ? '—' : number(discovered)), stat('原文片段', number(status?.chunks)), stat('等待向量化', number(pending))),
          h('div', { className: 'hr-progress-label' }, h('span', null, '历史扫描'), h('span', null, discovered == null ? '正在统计…' : `${number(progress?.completed)} / ${number(discovered)} 个会话`)),
          h('progress', { 'aria-label': '历史扫描进度', max: 100, value: sourcePercent }),
          h('div', { className: 'hr-progress-label' }, h('span', null, '原文向量化'), h('span', null, `${number(status?.embeddedChunks)} / ${number(status?.chunks)} · ${vectorPercent.toFixed(0)}%`)),
          h('progress', { 'aria-label': '原文向量化进度', max: 100, value: vectorPercent }),
          h('p', { className: 'hr-note' }, '新发现的历史会增加片段总数；扫描完成后，向量化进度才代表完整覆盖率。'),
          failures.length ? h('details', null, h('summary', null, `${number(failures.length)} 个会话尚未读取成功`), ...failures.map(f => h('div', { key: f.sessionId }, h('code', null, f.sessionId), ` · ${f.code}`))) : null,
          status?.state?.lastError ? h('details', null, h('summary', null, '最近一次错误'), h('div', null, errors[status.state.lastError.code] || `处理失败（${status.state.lastError.code}）`),
            h('div', null, new Date(status.state.lastError.time).toLocaleString('zh-CN'))) : null,
          h('div', { className: 'hr-footer' }, '完整保留原文，不自动遗忘。远程 Embedding 会接收历史片段；测试连接只发送固定测试文字。')));
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
        return () => style.remove();
      });
      const call = async (action, payload, signal) => {
        let result;
        try { result = await ctx.connection.rpc.call('/api', `history-rag/${action}`, payload, signal); }
        catch (error) {
          if (/HTTP 404\b/.test(error.message || '')) throw new Error('插件后台接口尚未就绪或仍为旧版。请从「应用 → 退出」完全退出 DSH 后重新打开，再重新加载设置。');
          throw error;
        }
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      };
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'history-rag', order: 65, label: '对话历史 RAG', inject: () => ({ call }),
      }, SettingsPage));
    }
    return { name: 'history-rag-ui', inject: ['slots', 'connection'], apply };
  },
});
