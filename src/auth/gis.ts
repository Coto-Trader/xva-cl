/**
 * Fase 10 — Cliente Google Identity Services (GIS) y Persistencia de Sesión en Navegador (docs/AUTH.md).
 *
 * Sin backend: decodifica el payload JWT de Google (`sub`, `email`, `name`, `picture`, `exp`),
 * valida expiración y persiste en `localStorage['xvacl_user']`.
 */

import { GOOGLE_CLIENT_ID, SEEN_SESSION_KEY, USER_STORAGE_KEY } from './config';

export interface XvaUserProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  exp: number;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: 'outline' | 'filled_blue' | 'filled_black';
              size?: 'large' | 'medium' | 'small';
              shape?: 'rectangular' | 'pill';
              text?: 'signin_with' | 'signup_with' | 'continue_with';
              width?: number;
            },
          ) => void;
          prompt: () => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}

/**
 * Decodifica el segmento payload (base64url) de un JWT emitido por Google.
 */
export function decodeJwtPayload(jwt: string): XvaUserProfile {
  const parts = jwt.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid JWT credential format.');
  }
  const base64Url = parts[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const jsonStr = decodeURIComponent(
    atob(padded)
      .split('')
      .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join(''),
  );
  const parsed = JSON.parse(jsonStr) as Partial<XvaUserProfile>;
  if (!parsed.sub || !parsed.email) {
    throw new Error('JWT payload missing sub or email.');
  }
  return {
    sub: parsed.sub,
    email: parsed.email,
    name: parsed.name ?? parsed.email.split('@')[0],
    picture: parsed.picture,
    exp: parsed.exp ?? Math.floor(Date.now() / 1000) + 86_400,
  };
}

/**
 * Lee el usuario autenticado desde `localStorage['xvacl_user']` si no ha expirado.
 */
export function getStoredUser(): XvaUserProfile | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw) as XvaUserProfile;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!user.exp || user.exp <= nowSec) {
      localStorage.removeItem(USER_STORAGE_KEY);
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

/**
 * Persiste el perfil de usuario en `localStorage['xvacl_user']` y marca `sessionStorage['xvacl_seen']`.
 */
export function storeUserSession(user: XvaUserProfile): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SEEN_SESSION_KEY, '1');
    }
  } catch {
    // Ignore storage errors
  }
}

/**
 * Cierra la sesión actual borrando `localStorage['xvacl_user']` y desactivando auto-select de GIS.
 */
export function clearUserSession(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(USER_STORAGE_KEY);
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(SEEN_SESSION_KEY);
    }
    if (typeof window !== 'undefined') {
      window.google?.accounts?.id?.disableAutoSelect();
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Crea una sesión académica/institucional local cuando el usuario trabaja en entorno local
 * o mientras `GOOGLE_CLIENT_ID` aún tiene el placeholder de desarrollo.
 */
export function createInstitutionalDemoUser(
  customName = 'Mesa XVA · Quant Desk Chile',
  customEmail = 'quant.desk@xva.cl',
): XvaUserProfile {
  const profile: XvaUserProfile = {
    sub: 'demo_quant_xva_cl',
    email: customEmail,
    name: customName,
    exp: Math.floor(Date.now() / 1000) + 7 * 86_400,
  };
  storeUserSession(profile);
  return profile;
}

export function isPlaceholderClientId(): boolean {
  return GOOGLE_CLIENT_ID.startsWith('REEMPLAZAR_CON_CLIENT_ID');
}
