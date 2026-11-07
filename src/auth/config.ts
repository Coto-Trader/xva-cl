/**
 * Fase 10 — Configuración de Google Identity Services (GIS) (docs/AUTH.md, FR-8).
 *
 * El Client ID es público por diseño de OAuth2 implícito en navegador.
 * Para producción en https://xva.cl, configurar VITE_GOOGLE_CLIENT_ID o reemplazar la constante.
 */

export const GOOGLE_CLIENT_ID: string =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_GOOGLE_CLIENT_ID ||
  'REEMPLAZAR_CON_CLIENT_ID.apps.googleusercontent.com';

export const USER_STORAGE_KEY = 'xvacl_user';
export const SEEN_SESSION_KEY = 'xvacl_seen';
