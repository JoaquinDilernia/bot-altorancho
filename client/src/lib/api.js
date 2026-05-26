export const BASE_URL = import.meta.env.VITE_API_URL ?? '';

let _logout = null;

export function setLogoutHandler(fn) {
  _logout = fn;
}

export function authFetch(url, options = {}) {
  const token = localStorage.getItem('gineza_token');
  const headers = { ...(options.headers ?? {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    options = { ...options, body: JSON.stringify(options.body) };
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, { ...options, headers }).then(res => {
    if (res.status === 401 && _logout) _logout();
    return res;
  });
}
