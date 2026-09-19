export type Protocol = 'messages' | 'responses' | 'chat';

export type Alias = {
  id: string;
  name: string;
  upstreamUrl: string;
  linkCount: number;
  createdAt?: string;
  updatedAt?: string;
};

export type Link = {
  id: string;
  clientProtocol: Protocol;
  upstreamProtocol: Protocol;
  targetType: 'direct' | 'alias';
  targetUrl?: string;
  aliasId?: string;
  aliasName?: string;
  baseUrl?: string;
  endpoint?: string;
  upstreamUrl?: string;
  revokedAt?: string | null;
  createdAt?: string;
};

export type LinkResult = Link & {
  baseUrl: string;
  endpoint: string;
  upstreamPreview: string;
  sdkExample?: string;
  curlExample?: string;
};

export type Session = {
  authenticated: boolean;
  username?: string;
};

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
};

const API_ROOT = '/api/admin';

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'include',
      headers,
    });
  } catch {
    throw new ApiError('无法连接管理服务，请检查 Worker 是否已启动。');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');

  if (!response.ok) {
    const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
    const nestedError = record?.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null;
    const message = stringValue(record?.message) || stringValue(nestedError?.message) || stringValue(record?.error);
    throw new ApiError(message || `请求失败（${response.status}）`, response.status, payload);
  }

  return payload as T;
}

function dataOf<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function protocolValue(value: unknown): Protocol {
  return value === 'messages' || value === 'responses' || value === 'chat' ? value : 'chat';
}

function normalizeAlias(value: unknown): Alias {
  const item = (value ?? {}) as Record<string, unknown>;
  return {
    id: stringValue(item.id),
    name: stringValue(item.name),
    upstreamUrl: stringValue(item.upstreamUrl ?? item.upstream_url ?? item.baseUrl ?? item.base_url ?? item.url),
    linkCount: numberValue(item.linkCount ?? item.linksCount ?? item.link_count),
    createdAt: stringValue(item.createdAt ?? item.created_at) || undefined,
    updatedAt: stringValue(item.updatedAt ?? item.updated_at) || undefined,
  };
}

function normalizeLink(value: unknown): Link {
  const item = (value ?? {}) as Record<string, unknown>;
  const target = (item.target ?? {}) as Record<string, unknown>;
  const targetType = item.targetType === 'alias' || item.target_type === 'alias' || target.type === 'alias' ? 'alias' : 'direct';
  return {
    id: stringValue(item.id),
    clientProtocol: protocolValue(item.clientProtocol ?? item.client_protocol ?? item.client),
    upstreamProtocol: protocolValue(item.upstreamProtocol ?? item.upstream_protocol ?? item.upstream),
    targetType,
    targetUrl: stringValue(item.targetUrl ?? item.direct_base_url ?? item.alias_base_url ?? item.baseUrl ?? item.base_url ?? item.upstreamUrl ?? target.url ?? target.baseUrl) || undefined,
    aliasId: stringValue(item.aliasId ?? item.alias_id ?? target.aliasId ?? target.alias_id) || undefined,
    aliasName: stringValue(item.aliasName ?? item.alias_name ?? target.aliasName ?? target.alias_name) || undefined,
    baseUrl: stringValue(item.baseUrl ?? item.base_url ?? item.clientBaseUrl ?? item.client_base_url) || undefined,
    endpoint: stringValue(item.endpoint ?? item.fullEndpoint ?? item.full_endpoint) || undefined,
    upstreamUrl: stringValue(item.upstreamUrl ?? item.upstream_url ?? item.upstreamPreview ?? item.upstream_preview) || undefined,
    revokedAt:
      item.revokedAt === null || item.revoked_at === null
        ? null
        : stringValue(item.revokedAt ?? item.revoked_at) || undefined,
    createdAt: stringValue(item.createdAt ?? item.created_at) || undefined,
  };
}

export async function getSession(): Promise<Session | null> {
  try {
    const payload = await request<unknown>('/session');
    const value = dataOf<Record<string, unknown>>(payload);
    if (value && value.authenticated === false) return null;
    return {
      authenticated: true,
      username: stringValue(value?.username ?? value?.user),
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

export async function login(username: string, password: string): Promise<Session> {
  const payload = await request<unknown>('/login', {
    method: 'POST',
    body: { username, password },
  });
  const value = dataOf<Record<string, unknown>>(payload);
  return { authenticated: true, username: stringValue(value?.username ?? value?.user, username) };
}

export async function logout(): Promise<void> {
  await request('/logout', { method: 'POST' });
}

export async function listAliases(): Promise<Alias[]> {
  const payload = await request<unknown>('/aliases');
  const value = dataOf<unknown>(payload);
  const items = Array.isArray(value)
    ? value
    : (value as { aliases?: unknown[]; items?: unknown[] } | null)?.aliases ?? (value as { items?: unknown[] } | null)?.items ?? [];
  return items.map(normalizeAlias).filter((item) => item.id || item.name);
}

export async function createAlias(name: string, upstreamUrl: string): Promise<Alias> {
  const payload = await request<unknown>('/aliases', {
    method: 'POST',
    body: { name, base_url: upstreamUrl },
  });
  const value = dataOf<Record<string, unknown>>(payload);
  return normalizeAlias(value?.alias ?? value);
}

export async function updateAlias(id: string, upstreamUrl: string): Promise<Alias> {
  const payload = await request<unknown>(`/aliases/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { base_url: upstreamUrl },
  });
  const value = dataOf<Record<string, unknown>>(payload);
  return normalizeAlias(value?.alias ?? value);
}

export async function deleteAlias(id: string): Promise<void> {
  await request(`/aliases/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function listLinks(): Promise<Link[]> {
  const payload = await request<unknown>('/links');
  const value = dataOf<unknown>(payload);
  const items = Array.isArray(value)
    ? value
    : (value as { links?: unknown[]; items?: unknown[] } | null)?.links ?? (value as { items?: unknown[] } | null)?.items ?? [];
  return items.map(normalizeLink).filter((item) => item.id);
}

export type CreateLinkInput = {
  clientProtocol: Protocol;
  upstreamProtocol: Protocol;
  target: { type: 'direct'; upstreamUrl: string } | { type: 'alias'; aliasId: string };
};

export async function createLink(input: CreateLinkInput): Promise<LinkResult> {
  const body = input.target.type === 'direct'
    ? {
        client_protocol: input.clientProtocol,
        upstream_protocol: input.upstreamProtocol,
        target_type: 'direct' as const,
        base_url: input.target.upstreamUrl,
      }
    : {
        client_protocol: input.clientProtocol,
        upstream_protocol: input.upstreamProtocol,
        target_type: 'alias' as const,
        alias_id: input.target.aliasId,
      };
  const payload = await request<unknown>('/links', { method: 'POST', body });
  const envelope = dataOf<Record<string, unknown>>(payload);
  const value = (envelope?.link ?? envelope) as Record<string, unknown>;
  const link = normalizeLink(value);
  return {
    ...link,
    baseUrl: stringValue(value.baseUrl ?? value.base_url ?? value.clientBaseUrl ?? value.client_base_url ?? link.baseUrl),
    endpoint: stringValue(value.endpoint ?? value.fullEndpoint ?? link.endpoint),
    upstreamPreview: stringValue(value.upstreamPreview ?? value.upstream_url ?? value.upstreamUrl ?? link.upstreamUrl),
    sdkExample: stringValue(value.sdkExample ?? value.sdk ?? value.sdkConfig) || undefined,
    curlExample: stringValue(value.curlExample ?? value.curl) || undefined,
  };
}

export async function revokeLink(id: string): Promise<void> {
  await request(`/links/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
}
