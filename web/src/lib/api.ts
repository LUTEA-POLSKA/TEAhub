/**
 * The thin fetch wrapper the UI talks through.
 *
 * Two decisions here matter more than the method names:
 *
 *  * **No base URL.** The browser talks to the same origin, so a relative path is
 *    correct and cannot drift from where the app is actually served. Hardcoding
 *    a host here is how an app silently points at a staging environment.
 *  * **Errors are returned, not thrown.** A 401 is not an exception to catch; it is
 *    the normal state of an unauthenticated page. Throwing would force every
 *    caller to write try/catch around a condition that is routine.
 */

export interface ApiError {
  error: { code: string; detail: string };
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export const endpoints = {
  me: '/api/auth/me',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  register: '/api/auth/register',
  tasks: '/api/tasks',
  task: (id: string) => `/api/tasks/${id}/cancel`,
  approvals: '/api/approvals',
  approval: (id: string) => `/api/approvals/${id}`,
  health: '/api/health',
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (!response.ok) {
    let code = 'unknown';
    let detail = response.statusText;
    try {
      const body = (await response.json()) as ApiError;
      code = body.error?.code ?? code;
      detail = body.error?.detail ?? detail;
    } catch {
      /* body was not JSON — keep the status text */
    }
    throw new ApiRequestError(response.status, code, detail);
  }

  if (response.status === 204) return undefined as unknown as T;
  return (await response.json()) as T;
}
