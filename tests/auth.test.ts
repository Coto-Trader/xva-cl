import { describe, expect, it } from 'vitest';
import {
  clearUserSession,
  createInstitutionalDemoUser,
  decodeJwtPayload,
  getStoredUser,
  storeUserSession,
} from '../src/auth/gis';

describe('Fase 10 — Google Identity Services (GIS) JWT Decode & Browser Session Persistence (FR-8, docs/AUTH.md)', () => {
  it('decodes a valid Google JWT credential payload accurately', () => {
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const expFuture = Math.floor(Date.now() / 1000) + 3600;
    const payload = btoa(
      JSON.stringify({
        sub: 'google_12345',
        email: 'trader@xva.cl',
        name: 'Trader XVA Chile',
        picture: 'https://xva.cl/avatar.png',
        exp: expFuture,
      }),
    );
    const fakeJwt = `${header}.${payload}.signature_bytes`;

    const decoded = decodeJwtPayload(fakeJwt);
    expect(decoded.sub).toBe('google_12345');
    expect(decoded.email).toBe('trader@xva.cl');
    expect(decoded.name).toBe('Trader XVA Chile');
    expect(decoded.exp).toBe(expFuture);
  });

  it('persists and clears user session cleanly', () => {
    const demo = createInstitutionalDemoUser('Quant Tester', 'test@xva.cl');
    expect(demo.email).toBe('test@xva.cl');

    storeUserSession(demo);
    const stored = getStoredUser();
    if (typeof localStorage !== 'undefined') {
      expect(stored?.email).toBe('test@xva.cl');
    }

    clearUserSession();
    expect(getStoredUser()).toBeNull();
  });
});
