import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  Clipboard,
  Copy,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import {
  Alias,
  ApiError,
  createAlias,
  createLink,
  deleteAlias,
  getSession,
  Link,
  LinkResult,
  Session,
  listAliases,
  listLinks,
  login,
  logout,
  Protocol,
  revokeLink,
  updateAlias,
} from './lib/api';

type View = 'generator' | 'aliases' | 'links';

const protocolMeta: Record<Protocol, { label: string; short: string; description: string }> = {
  messages: { label: 'Anthropic Messages', short: 'Messages', description: 'Anthropic Messages API' },
  responses: { label: 'OpenAI Responses', short: 'Responses', description: 'OpenAI Responses API' },
  chat: { label: 'Chat Completions', short: 'Chat', description: 'OpenAI Chat Completions API' },
};

const protocolOrder: Protocol[] = ['messages', 'responses', 'chat'];

function readableError(error: unknown, fallback = '操作失败，请稍后重试。'): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function protocolLabel(protocol: Protocol): string {
  return protocolMeta[protocol]?.short ?? protocol;
}

function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async () => {
    setCopyError(false);
    try {
      if (!value) throw new Error('Nothing to copy');
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = value;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        const didCopy = document.execCommand('copy');
        textArea.remove();
        if (!didCopy) throw new Error('Copy command failed');
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setCopyError(true);
      window.setTimeout(() => setCopyError(false), 2600);
    }
  };
  return (
    <span className="copy-control">
      <button className="icon-button subtle" type="button" onClick={copy} title={copied ? '已复制' : label} aria-label={copied ? '已复制' : label}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
      {copyError && <span className="copy-feedback error" role="status">复制失败，请手动复制</span>}
    </span>
  );
}

function Notice({ kind = 'error', children, onClose }: { kind?: 'error' | 'warning' | 'success'; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <AlertCircle size={17} aria-hidden="true" />
      <span>{children}</span>
      {onClose && (
        <button className="icon-button notice-close" type="button" onClick={onClose} title="关闭" aria-label="关闭">
          <X size={15} />
        </button>
      )}
    </div>
  );
}

function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="state-panel" role="status">
      <RefreshCw className="spin" size={18} />
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="state-panel empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <span>{detail}</span>
      {action}
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('请输入管理员用户名和密码。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onLogin(username.trim(), password);
    } catch (reason) {
      setError(readableError(reason, '登录失败，请检查账号和密码。'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="brand-mark"><Waypoints size={21} /></div>
        <div className="eyebrow">PROTOCOL GATEWAY</div>
        <h1 id="login-title">管理员登录</h1>
        <p className="auth-subtitle">使用部署时配置的管理员账号进入控制台。</p>
        {error && <Notice>{error}</Notice>}
        <form onSubmit={submit} className="stack-form">
          <label>
            <span>用户名</span>
            <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="管理员用户名" autoFocus />
          </label>
          <label>
            <span>密码</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="管理员密码" />
          </label>
          <button className="primary-button full-button" type="submit" disabled={submitting}>
            {submitting ? <RefreshCw className="spin" size={17} /> : <LogIn size={17} />}
            {submitting ? '正在登录' : '登录控制台'}
          </button>
        </form>
      </section>
    </main>
  );
}

function ProtocolSelect({ value, onChange, label }: { value: Protocol; onChange: (value: Protocol) => void; label: string }) {
  return (
    <fieldset className="protocol-fieldset">
      <legend>{label}</legend>
      <div className="segmented-control" role="radiogroup" aria-label={label}>
        {protocolOrder.map((protocol) => (
          <button
            key={protocol}
            className={value === protocol ? 'segment selected' : 'segment'}
            type="button"
            role="radio"
            aria-checked={value === protocol}
            onClick={() => onChange(protocol)}
          >
            <span>{protocolMeta[protocol].short}</span>
            <small>{protocol === 'messages' ? 'Anthropic' : 'OpenAI'}</small>
          </button>
        ))}
      </div>
      <p className="field-hint">{protocolMeta[value].description}</p>
    </fieldset>
  );
}

function CodeField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="code-field">
      <div className="code-field-heading"><span>{label}</span><CopyButton value={value} /></div>
      <code className={mono ? 'mono' : ''}>{value || '—'}</code>
    </div>
  );
}

function buildSdkExample(result: LinkResult): string {
  const key = 'YOUR_UPSTREAM_API_KEY';
  if (result.clientProtocol === 'messages') {
    return `import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({\n  apiKey: "${key}",\n  baseURL: "${result.baseUrl}",\n});\n\nconst message = await client.messages.create({\n  model: "your-model",\n  max_tokens: 512,\n  messages: [{ role: "user", content: "Hello" }],\n});`;
  }
  if (result.clientProtocol === 'responses') {
    return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  apiKey: "${key}",\n  baseURL: "${result.baseUrl}",\n});\n\nconst response = await client.responses.create({\n  model: "your-model",\n  input: "Hello",\n});`;
  }
  return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  apiKey: "${key}",\n  baseURL: "${result.baseUrl}",\n});\n\nconst completion = await client.chat.completions.create({\n  model: "your-model",\n  messages: [{ role: "user", content: "Hello" }],\n});`;
}

function buildCurlExample(result: LinkResult): string {
  const header = result.clientProtocol === 'messages'
    ? '-H "x-api-key: YOUR_UPSTREAM_API_KEY" \\\n  -H "anthropic-version: 2023-06-01"'
    : '-H "Authorization: Bearer YOUR_UPSTREAM_API_KEY"';
  const path = result.endpoint || result.baseUrl;
  const body = result.clientProtocol === 'messages'
    ? '{"model":"your-model","max_tokens":512,"messages":[{"role":"user","content":"Hello"}]}'
    : result.clientProtocol === 'responses'
      ? '{"model":"your-model","input":"Hello"}'
      : '{"model":"your-model","messages":[{"role":"user","content":"Hello"}]}';
  return `curl ${path} \\\n  ${header} \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
}

function ResultPanel({ result }: { result: LinkResult }) {
  const sdk = result.sdkExample || buildSdkExample(result);
  const curl = buildCurlExample(result);
  return (
    <section className="result-panel" aria-labelledby="result-title">
      <div className="section-heading compact-heading">
        <div>
          <div className="eyebrow">LINK READY</div>
          <h2 id="result-title">链接已生成</h2>
        </div>
        <span className="status-chip success"><Check size={14} />可用</span>
      </div>
      <div className="result-grid">
        <CodeField label="客户端 Base URL" value={result.baseUrl} />
        <CodeField label="完整请求端点" value={result.endpoint} />
        <div className="preview-block">
          <span className="code-label">上游请求地址预览</span>
          <div className="flow-line">
            <span className="flow-node">{protocolLabel(result.clientProtocol)}</span>
            <ArrowRight size={15} />
            <span className="flow-node">{protocolLabel(result.upstreamProtocol)}</span>
            <ArrowRight size={15} />
            <span className="flow-node">{protocolLabel(result.clientProtocol)}</span>
          </div>
          <code className="mono upstream-preview">{result.upstreamPreview || '由别名在请求时解析'}</code>
        </div>
      </div>
      <div className="examples-grid">
        <div className="example-block">
          <div className="code-field-heading"><span>SDK 配置示例</span><CopyButton value={sdk} /></div>
          <pre><code>{sdk}</code></pre>
        </div>
        <div className="example-block">
          <div className="code-field-heading"><span>cURL 示例</span><CopyButton value={curl} /></div>
          <pre><code>{curl}</code></pre>
        </div>
      </div>
      <p className="result-footnote"><KeyRound size={14} />请求中的 API Key 仍使用你的上游 Key，网关不会保存它。</p>
    </section>
  );
}

function GeneratorPage({ aliases, onLinkCreated }: { aliases: Alias[]; onLinkCreated: (link: Link) => void }) {
  const [clientProtocol, setClientProtocol] = useState<Protocol>('responses');
  const [upstreamProtocol, setUpstreamProtocol] = useState<Protocol>('chat');
  const [targetMode, setTargetMode] = useState<'direct' | 'alias'>('direct');
  const [upstreamUrl, setUpstreamUrl] = useState('');
  const [aliasId, setAliasId] = useState('');
  const [result, setResult] = useState<LinkResult | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = targetMode === 'direct' ? upstreamUrl.trim().length > 0 : aliasId.length > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) {
      setError(targetMode === 'direct' ? '请输入上游 Base URL。' : '请选择一个别名。');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const created = await createLink({
        clientProtocol,
        upstreamProtocol,
        target: targetMode === 'direct' ? { type: 'direct', upstreamUrl: upstreamUrl.trim() } : { type: 'alias', aliasId },
      });
      setResult(created);
      onLinkCreated(created);
    } catch (reason) {
      setError(readableError(reason, '链接生成失败，请检查输入。'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-content">
      <div className="page-intro">
        <div>
          <div className="eyebrow">LINK BUILDER</div>
          <h1>生成代理链接</h1>
          <p>为一个固定上游地址或可更新的别名创建独立访问凭证。</p>
        </div>
        <div className="intro-stat"><Link2 size={18} /><span>生成操作不会调用上游</span></div>
      </div>
      {error && <Notice onClose={() => setError('')}>{error}</Notice>}
      <section className="form-panel" aria-labelledby="generator-form-title">
        <div className="section-heading">
          <div>
            <h2 id="generator-form-title">协议方向</h2>
            <p>选择客户端发出的协议和上游接收的协议。</p>
          </div>
          <span className="step-label">01 / 02</span>
        </div>
        <form onSubmit={submit}>
          <div className="protocol-grid">
            <ProtocolSelect value={clientProtocol} onChange={setClientProtocol} label="客户端协议" />
            <ProtocolSelect value={upstreamProtocol} onChange={setUpstreamProtocol} label="上游协议" />
          </div>
          <div className="divider" />
          <div className="section-heading inline-heading">
            <div><h2>上游目标</h2><p>别名会跟随后续地址更新，直填地址在生成后固定。</p></div>
            <div className="toggle-control" role="radiogroup" aria-label="上游目标类型">
              <button type="button" className={targetMode === 'direct' ? 'toggle-option selected' : 'toggle-option'} onClick={() => setTargetMode('direct')}>直接地址</button>
              <button type="button" className={targetMode === 'alias' ? 'toggle-option selected' : 'toggle-option'} onClick={() => setTargetMode('alias')}>使用别名</button>
            </div>
          </div>
          {targetMode === 'direct' ? (
            <label className="wide-field">
              <span>上游 Base URL</span>
              <input value={upstreamUrl} onChange={(event) => setUpstreamUrl(event.target.value)} placeholder="例如 api.example.com/v1" inputMode="url" />
              <small>可填写完整 HTTPS 地址；不要填写具体协议端点、查询参数或 fragment。</small>
            </label>
          ) : (
            <label className="wide-field">
              <span>选择别名</span>
              <select value={aliasId} onChange={(event) => setAliasId(event.target.value)}>
                <option value="">请选择已配置的别名</option>
                {aliases.map((alias) => <option key={alias.id} value={alias.id}>{alias.name} · {alias.upstreamUrl}</option>)}
              </select>
              {aliases.length === 0 && <small>还没有别名，请先在别名管理中创建。</small>}
            </label>
          )}
          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={submitting || !canSubmit}>
              {submitting ? <RefreshCw className="spin" size={17} /> : <Link2 size={17} />}
              {submitting ? '正在生成' : '生成链接'}
            </button>
          </div>
        </form>
      </section>
      {result && <ResultPanel result={result} />}
    </div>
  );
}

function AliasPage({ aliases, loading, error, onRefresh, onChanged }: { aliases: Alias[]; loading: boolean; error: string; onRefresh: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !url.trim()) {
      setActionError('请输入别名和上游 Base URL。');
      return;
    }
    setSaving(true); setActionError('');
    try {
      await createAlias(name.trim(), url.trim());
      setName(''); setUrl(''); await onChanged();
    } catch (reason) { setActionError(readableError(reason)); }
    finally { setSaving(false); }
  };

  const beginEdit = (alias: Alias) => { setEditingId(alias.id); setEditUrl(alias.upstreamUrl); setActionError(''); };
  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingId || !editUrl.trim()) { setActionError('上游 Base URL 不能为空。'); return; }
    const editingAlias = aliases.find((alias) => alias.id === editingId);
    if (editingAlias && editingAlias.upstreamUrl !== editUrl.trim()) {
      const confirmed = window.confirm(`更新别名“${editingAlias.name}”后，${editingAlias.linkCount} 条关联链接会访问新的上游地址。继续吗？`);
      if (!confirmed) return;
    }
    setSaving(true); setActionError('');
    try { await updateAlias(editingId, editUrl.trim()); setEditingId(null); await onChanged(); }
    catch (reason) { setActionError(readableError(reason)); }
    finally { setSaving(false); }
  };
  const remove = async (alias: Alias) => {
    if (!window.confirm(`确定删除别名“${alias.name}”吗？这将撤销 ${alias.linkCount} 条关联链接。`)) return;
    setSaving(true); setActionError('');
    try { await deleteAlias(alias.id); await onChanged(); }
    catch (reason) { setActionError(readableError(reason)); }
    finally { setSaving(false); }
  };

  return (
    <div className="page-content">
      <div className="page-intro">
        <div><div className="eyebrow">UPSTREAM ALIASES</div><h1>别名管理</h1><p>集中维护上游地址，关联别名的已有链接会自动跟随更新。</p></div>
        <button className="secondary-button" type="button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} />刷新</button>
      </div>
      {(error || actionError) && <Notice onClose={() => setActionError('')}>{error || actionError}</Notice>}
      <section className="form-panel compact-form-panel">
        <div className="section-heading"><div><h2>新建别名</h2><p>别名名称需保持唯一；地址不包含 API Key。</p></div><Plus size={20} className="heading-icon" /></div>
        <form className="alias-create-form" onSubmit={create}>
          <label><span>别名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 production" /></label>
          <label className="url-field"><span>上游 Base URL</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="例如 api.example.com/v1" inputMode="url" /></label>
          <button className="primary-button" type="submit" disabled={saving}><Plus size={17} />创建别名</button>
        </form>
      </section>
      <section className="table-panel" aria-labelledby="alias-table-title">
        <div className="table-heading"><div><h2 id="alias-table-title">已配置别名</h2><span className="muted">{aliases.length} 个别名</span></div></div>
        {loading ? <LoadingState label="正在加载别名…" /> : aliases.length === 0 ? <EmptyState icon={<Server size={21} />} title="还没有别名" detail="创建一个别名后，可在生成器中重复使用。" /> : (
          <div className="table-scroll"><table><thead><tr><th>名称</th><th>上游地址</th><th>关联链接</th><th>更新时间</th><th className="actions-column">操作</th></tr></thead><tbody>
            {aliases.map((alias) => editingId === alias.id ? (
              <tr key={alias.id} className="editing-row"><td colSpan={5}><form className="inline-edit-form" onSubmit={saveEdit}><strong>{alias.name}</strong><input aria-label="上游 Base URL" value={editUrl} onChange={(event) => setEditUrl(event.target.value)} /><span className="inline-actions"><button className="primary-button small-button" type="submit" disabled={saving}><Check size={15} />保存</button><button className="secondary-button small-button" type="button" onClick={() => setEditingId(null)}><X size={15} />取消</button></span></form></td></tr>
            ) : (
              <tr key={alias.id}><td><strong>{alias.name}</strong><span className="mobile-label">别名</span></td><td><code className="mono table-url">{alias.upstreamUrl}</code></td><td><span className="count-badge">{alias.linkCount}</span></td><td className="muted">{formatDate(alias.updatedAt || alias.createdAt)}</td><td className="actions-cell"><button className="icon-button" type="button" onClick={() => beginEdit(alias)} title="编辑别名" aria-label={`编辑 ${alias.name}`}><Pencil size={16} /></button><button className="icon-button danger-icon" type="button" onClick={() => remove(alias)} title="删除别名" aria-label={`删除 ${alias.name}`} disabled={saving}><Trash2 size={16} /></button></td></tr>
            ))}
          </tbody></table></div>
        )}
      </section>
    </div>
  );
}

function LinkPage({ links, loading, error, onRefresh, onLinksChanged }: { links: Link[]; loading: boolean; error: string; onRefresh: () => void; onLinksChanged: () => Promise<void> }) {
  const [actionError, setActionError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [regenerated, setRegenerated] = useState<LinkResult | null>(null);
  const activeLinks = useMemo(() => links.filter((link) => !link.revokedAt), [links]);
  const revoke = async (link: Link) => {
    if (!window.confirm('确定撤销这条链接吗？撤销后客户端将无法继续访问。')) return;
    setRevoking(link.id); setActionError('');
    try { await revokeLink(link.id); await onLinksChanged(); }
    catch (reason) { setActionError(readableError(reason)); }
    finally { setRevoking(null); }
  };
  const regenerate = async (link: Link) => {
    const target = link.targetType === 'alias'
      ? (link.aliasId ? { type: 'alias' as const, aliasId: link.aliasId } : null)
      : (link.targetUrl || link.upstreamUrl ? { type: 'direct' as const, upstreamUrl: link.targetUrl || link.upstreamUrl || '' } : null);
    if (!target) {
      setActionError('这条链接缺少上游目标，无法自动重新生成。');
      return;
    }
    if (!window.confirm('将按原协议和上游目标创建一条新链接，旧链接状态不变。继续吗？')) return;
    setRegenerating(link.id); setActionError('');
    try {
      const created = await createLink({ clientProtocol: link.clientProtocol, upstreamProtocol: link.upstreamProtocol, target });
      setRegenerated(created);
      await onLinksChanged();
    } catch (reason) { setActionError(readableError(reason, '链接重新生成失败。')); }
    finally { setRegenerating(null); }
  };
  return (
    <div className="page-content">
      <div className="page-intro"><div><div className="eyebrow">ACCESS LINKS</div><h1>链接管理</h1><p>查看已生成的凭证，复制客户端地址或逐条撤销访问。</p></div><button className="secondary-button" type="button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} />刷新</button></div>
      {(error || actionError) && <Notice onClose={() => setActionError('')}>{error || actionError}</Notice>}
      <div className="summary-strip"><div><span>全部链接</span><strong>{links.length}</strong></div><div><span>有效链接</span><strong>{activeLinks.length}</strong></div><div><span>已撤销</span><strong>{links.length - activeLinks.length}</strong></div></div>
      <section className="table-panel" aria-labelledby="link-table-title">
        <div className="table-heading"><div><h2 id="link-table-title">生成记录</h2><span className="muted">凭证只在生成时完整展示，列表中仅保留可再次复制的 Base URL。</span></div></div>
        {loading ? <LoadingState label="正在加载链接…" /> : links.length === 0 ? <EmptyState icon={<Link2 size={21} />} title="还没有生成链接" detail="使用链接生成器创建第一条代理链接。" /> : (
          <div className="table-scroll"><table><thead><tr><th>协议方向</th><th>目标</th><th>客户端 Base URL</th><th>创建时间</th><th>状态</th><th className="actions-column">操作</th></tr></thead><tbody>
            {links.map((link) => <tr key={link.id} className={link.revokedAt ? 'revoked-row' : ''}><td><div className="direction-cell"><span>{protocolLabel(link.clientProtocol)}</span><ArrowRight size={14} /><span>{protocolLabel(link.upstreamProtocol)}</span></div><span className="mobile-label">客户端 → 上游</span></td><td><div className="target-cell"><span className="target-kind">{link.targetType === 'alias' ? '别名' : '直连'}</span><code className="mono">{link.targetType === 'alias' ? link.aliasName || link.aliasId || '—' : link.targetUrl || link.upstreamUrl || '—'}</code></div></td><td>{link.baseUrl ? <div className="copyable-url"><code className="mono">{link.baseUrl}</code><CopyButton value={link.baseUrl} label="复制 Base URL" /></div> : <span className="muted">—</span>}</td><td className="muted">{formatDate(link.createdAt)}</td><td><span className={link.revokedAt ? 'status-chip revoked' : 'status-chip success'}>{link.revokedAt ? '已撤销' : '有效'}</span></td><td className="actions-cell"><button className="icon-button" type="button" onClick={() => regenerate(link)} title="重新生成链接" aria-label="重新生成链接" disabled={regenerating === link.id}>{regenerating === link.id ? <RefreshCw className="spin" size={16} /> : <Link2 size={16} />}</button>{!link.revokedAt && <button className="icon-button danger-icon" type="button" onClick={() => revoke(link)} title="撤销链接" aria-label="撤销链接" disabled={revoking === link.id}>{revoking === link.id ? <RefreshCw className="spin" size={16} /> : <X size={16} />}</button>}</td></tr>)}
          </tbody></table></div>
        )}
      </section>
      {regenerated && <ResultPanel result={regenerated} />}
    </div>
  );
}

function Dashboard({ session, onLoggedOut }: { session: Session; onLoggedOut: () => void }) {
  const [view, setView] = useState<View>('generator');
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [aliasLoading, setAliasLoading] = useState(true);
  const [linkLoading, setLinkLoading] = useState(true);
  const [aliasError, setAliasError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  const refreshAliases = useCallback(async () => {
    setAliasLoading(true); setAliasError('');
    try { setAliases(await listAliases()); } catch (reason) { setAliasError(readableError(reason, '别名加载失败。')); }
    finally { setAliasLoading(false); }
  }, []);
  const refreshLinks = useCallback(async () => {
    setLinkLoading(true); setLinkError('');
    try { setLinks(await listLinks()); } catch (reason) { setLinkError(readableError(reason, '链接加载失败。')); }
    finally { setLinkLoading(false); }
  }, []);
  const refreshAliasesAndLinks = useCallback(async () => {
    await Promise.all([refreshAliases(), refreshLinks()]);
  }, [refreshAliases, refreshLinks]);
  useEffect(() => { void refreshAliases(); void refreshLinks(); }, [refreshAliases, refreshLinks]);

  const handleLogout = async () => {
    setLoggingOut(true);
    setLogoutError('');
    try {
      await logout();
      onLoggedOut();
    } catch (reason) {
      setLogoutError(readableError(reason, '退出登录失败，当前登录状态仍保留。'));
    } finally { setLoggingOut(false); }
  };
  const addLink = (link: Link) => setLinks((current) => [link, ...current.filter((item) => item.id !== link.id)]);
  const navItems: { id: View; label: string; icon: ReactNode }[] = [
    { id: 'generator', label: '生成器', icon: <Link2 size={17} /> },
    { id: 'aliases', label: '别名管理', icon: <Server size={17} /> },
    { id: 'links', label: '链接管理', icon: <Clipboard size={17} /> },
  ];
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><div className="brand-mark small"><Waypoints size={17} /></div><span>Protocol Gateway</span></div>
          <nav className="main-nav" aria-label="主导航">{navItems.map((item) => <button key={item.id} type="button" className={view === item.id ? 'nav-item active' : 'nav-item'} onClick={() => setView(item.id)}>{item.icon}<span>{item.label}</span></button>)}</nav>
          <div className="account-area"><span className="account-name"><ShieldCheck size={15} />{session.username || '管理员'}</span><button className="icon-button" type="button" onClick={handleLogout} disabled={loggingOut} title="退出登录" aria-label="退出登录">{loggingOut ? <RefreshCw className="spin" size={16} /> : <LogOut size={16} />}</button></div>
        </div>
      </header>
      <main className="main-area">
        {logoutError && <Notice onClose={() => setLogoutError('')}>{logoutError}</Notice>}
        {view === 'generator' && <GeneratorPage aliases={aliases} onLinkCreated={addLink} />}
        {view === 'aliases' && <AliasPage aliases={aliases} loading={aliasLoading} error={aliasError} onRefresh={() => void refreshAliases()} onChanged={refreshAliasesAndLinks} />}
        {view === 'links' && <LinkPage links={links} loading={linkLoading} error={linkError} onRefresh={() => void refreshLinks()} onLinksChanged={refreshLinks} />}
      </main>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [sessionError, setSessionError] = useState('');
  useEffect(() => { getSession().then(setSession).catch((reason) => setSessionError(readableError(reason, '无法读取登录状态。'))); }, []);
  if (session === undefined && !sessionError) return <main className="auth-shell"><LoadingState label="正在检查登录状态…" /></main>;
  if (sessionError) return <main className="auth-shell"><section className="auth-panel"><div className="brand-mark"><AlertCircle size={21} /></div><h1>管理服务不可用</h1><p className="auth-subtitle">{sessionError}</p><button className="secondary-button full-button" type="button" onClick={() => window.location.reload()}><RefreshCw size={16} />重新检查</button></section></main>;
  if (!session) return <LoginScreen onLogin={async (username, password) => setSession(await login(username, password))} />;
  return <Dashboard session={session} onLoggedOut={() => setSession(null)} />;
}
