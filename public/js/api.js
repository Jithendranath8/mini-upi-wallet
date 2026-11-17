// Thin client for the REST API. Returns a uniform result and never throws on HTTP errors.

const BASE = '/api/v1';
const STORAGE_KEY = 'miniupi.user';

export const session = {
  userId: readStoredUser(),
  /** Remembered in memory only, to pre-fill PIN fields during a demo. */
  pin: '',
};

function readStoredUser() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function signInAs(userId) {
  session.userId = userId;
  session.pin = '';
  try {
    localStorage.setItem(STORAGE_KEY, userId);
  } catch {
    /* private mode: the choice simply is not remembered */
  }
}

/** A fresh Idempotency-Key. Falls back when crypto.randomUUID is unavailable (plain http on a LAN). */
export function newKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @returns {Promise<{ok:boolean,status:number,data:any,error:any,ms:number,
 *   meta:{requestId:string|null,servedBy:string|null,dataSource:string|null,replayed:boolean,retryAfter:string|null}}>}
 */
export async function api(method, path, { body, user = session.userId, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (user) headers['X-User-Id'] = user;
  if (key) headers['Idempotency-Key'] = key;

  const started = performance.now();
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      data: undefined,
      error: { code: 'NETWORK_ERROR', message: 'Could not reach the server. Check that it is still running.' },
      ms: Math.round(performance.now() - started),
      meta: { requestId: null, servedBy: null, dataSource: null, replayed: false, retryAfter: null },
    };
  }
  const json = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data: json.data,
    page: json.page,
    error: json.error,
    ms: Math.round(performance.now() - started),
    meta: {
      requestId: response.headers.get('X-Request-Id'),
      servedBy: response.headers.get('X-Served-By'),
      dataSource: response.headers.get('X-Data-Source'),
      replayed: response.headers.get('Idempotent-Replayed') === 'true',
      retryAfter: response.headers.get('Retry-After'),
    },
  };
}

/** Operator endpoints: not tied to a user. */
export const system = (method, path, body) => api(method, `/system${path}`, { body, user: null });
