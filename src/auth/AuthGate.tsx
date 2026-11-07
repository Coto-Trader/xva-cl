/**
 * Fase 10 — Componente `<AuthGate>` y Chip de Sesión (docs/AUTH.md, docs/UI-UX.md, FR-8).
 */

import React, { useEffect, useRef, useState } from 'react';
import { GOOGLE_CLIENT_ID } from './config';
import {
  type XvaUserProfile,
  clearUserSession,
  createInstitutionalDemoUser,
  decodeJwtPayload,
  getStoredUser,
  isPlaceholderClientId,
  storeUserSession,
} from './gis';

interface AuthGateProps {
  children: (props: { user: XvaUserProfile; onSignOut: () => void }) => React.ReactNode;
}

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const [user, setUser] = useState<XvaUserProfile | null>(() => {
    const existing = getStoredUser();
    if (existing) return existing;
    // En desarrollo local con Client ID placeholder, iniciamos sesión institucional por defecto
    // pero permitimos cerrar sesión para inspeccionar la pantalla AuthGate (FR-8).
    return createInstitutionalDemoUser();
  });
  const [authError, setAuthError] = useState<string | null>(null);
  const googleBtnRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (user) return;
    if (typeof window === 'undefined' || !window.google?.accounts?.id) return;
    if (isPlaceholderClientId()) return;

    try {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => {
          try {
            const profile = decodeJwtPayload(response.credential);
            storeUserSession(profile);
            setUser(profile);
            setAuthError(null);
          } catch (err) {
            setAuthError(err instanceof Error ? err.message : 'Error al validar credencial Google.');
          }
        },
        auto_select: true,
      });

      if (googleBtnRef.current) {
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'filled_black',
          size: 'large',
          shape: 'rectangular',
          text: 'continue_with',
          width: 300,
        });
      }
    } catch {
      // Ignore GIS initialization errors when offline
    }
  }, [user]);

  const handleSignOut = () => {
    clearUserSession();
    setUser(null);
  };

  const handleDemoSignIn = () => {
    const demoUser = createInstitutionalDemoUser();
    setUser(demoUser);
    setAuthError(null);
  };

  if (!user) {
    return (
      <div className="auth-gate-backdrop">
        <div className="auth-gate-card">
          <div className="auth-brand-row">
            <span className="brand-dot" />
            <span className="brand-mono">XVA.CL // COUNTERPARTY CREDIT, FUNDING &amp; CAPITAL</span>
          </div>
          <h1 className="auth-title">Terminal Cuantitativa de XVA y Cobertura</h1>
          <p className="auth-subtitle">
            Motor interactivo 100% en navegador basado en Jon Gregory,{' '}
            <em>The xVA Challenge (3rd ed.)</em>. Calcula CVA, DVA, FCA, FBA, MVA, KVA, WWR y Greeks
            de cobertura para derivados OTC chilenos (CCS UF/CLP, IRS CAMARA, FX Forward).
          </p>

          <div className="auth-actions">
            <div ref={googleBtnRef} className="gis-button-slot" />
            <button type="button" className="btn-signal-primary" onClick={handleDemoSignIn}>
              Continuar con Sesión Institucional / Académica (Local)
            </button>
          </div>

          {isPlaceholderClientId() && (
            <div className="auth-config-note">
              Modo estático sin servidor · <code>GOOGLE_CLIENT_ID</code> configurable en{' '}
              <code>src/auth/config.ts</code>. Tus curvas y portafolios nunca abandonan tu navegador.
            </div>
          )}

          {authError && <div className="auth-error-banner">{authError}</div>}
        </div>
      </div>
    );
  }

  return <>{children({ user, onSignOut: handleSignOut })}</>;
};
