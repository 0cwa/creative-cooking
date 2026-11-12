export class AccountApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(
    message: string,
    status: number,
    code: string | null
  ) {
    super(message);
    this.name = 'AccountApiError';
    this.status = status;
    this.code = code;
  }
}

export class AccountTransportError extends Error {
  readonly mutationMayHaveCompleted: boolean;

  constructor(mutationMayHaveCompleted: boolean, action = 'this action') {
    super(mutationMayHaveCompleted
      ? `The connection ended before the service confirmed ${action}. It may have completed. Check the current account state before trying again; the app will not repeat the request automatically.`
      : 'The account service could not be reached. Check the API address and connection, then retry.');
    this.name = 'AccountTransportError';
    this.mutationMayHaveCompleted = mutationMayHaveCompleted;
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  token?: string;
  body?: unknown;
  mutationLabel?: string;
  fetchImpl?: typeof fetch;
}

export function normalizeApiUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter a complete API URL, such as https://api.example.com.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The API URL must use HTTPS. HTTP is allowed only for localhost development.');
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
    || url.hostname === '::1';
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('Use HTTPS for remote API services. Plain HTTP is allowed only on localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The API URL cannot contain credentials, a query, or a fragment.');
  }
  if (url.pathname.replace(/\/+$/, '').endsWith('/v1')) {
    throw new Error('Enter the API base URL without the /v1 path.');
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export async function accountApiRequest<T>(
  apiUrl: string,
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);

  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl}/v1${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error'
    });
  } catch {
    throw new AccountTransportError(method !== 'GET', options.mutationLabel);
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) {
      throw new AccountApiError('The account service returned an unreadable response.', response.status, null);
    }
  }

  if (!response.ok) {
    const errorPayload = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof errorPayload?.code === 'string' ? errorPayload.code : null;
    const message = typeof errorPayload?.message === 'string' ? errorPayload.message : `The account service returned ${response.status}.`;
    throw new AccountApiError(message, response.status, code);
  }

  return payload as T;
}
