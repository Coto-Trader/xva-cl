# AUTH — Validación Google (Gmail), client-side

Mismo patrón que TradeAI: **Google Identity Services (GIS)**, 100% client-side, sin backend. Es la "validación vía Gmail".

## 1. Cómo funciona
- Se carga `https://accounts.google.com/gsi/client`.
- El usuario pulsa "Ingresar / Registrarse" → botón/One-Tap de Google.
- GIS devuelve un **JWT (credential)**; se decodifica en el cliente para obtener nombre, email y avatar.
- Se guarda el perfil en `localStorage['xvacl_user']`. El chip muestra nombre/avatar; "salir" limpia el storage.
- El modal se auto-abre una vez por sesión para visitantes sin sesión (`sessionStorage['xvacl_seen']`).

## 2. Configuración OAuth
- Reusar el proyecto GCP existente **My First Project** (`vocal-nova-471909-q5`), donde ya viven los clients de TradeAI/alcallo.
- Crear un **OAuth Client nuevo "XVA.cl"** (o reusar el de Coto-TradeAI si se decide compartir), con **Authorized JavaScript origins**: `https://xva.cl`, `https://www.xva.cl`, `https://coto-trader.github.io`.
- El **Client ID es público** (va en el bundle). No hay client secret (GIS es client-side).
- Guardar el Client ID en un único lugar: `src/auth/config.ts` → `export const GOOGLE_CLIENT_ID = '...'`. El humano lo pega tras crear el client (no lo inventes).

## 3. Control de acceso (gating)
- v1: **gate de sesión** — sin login válido, el wizard está bloqueado (overlay). No hay roles ni backend que verifique nada; es un gate de cortesía/registro, no seguridad fuerte.
- La consent screen del proyecto está en modo **Testing** → solo **test users** autorizados pueden entrar. Añadir `carlos.alberto.rt@gmail.com` como test user. Para abrir al público: publicar la app a Producción (requiere URLs de privacidad y términos; scopes básicos email/profile no requieren verificación de Google).
- Los nuevos orígenes OAuth tardan de 5 min a varias horas en propagar.

## 4. Qué NO hacer
- No tratar el login como seguridad real (todo el cómputo y los datos son client-side de todos modos).
- No pedir ni almacenar contraseñas. Solo el flujo de Google.
- No enviar datos del usuario a ningún servidor (el único "afuera" es el login de Google).
- No poner secretos en el repo.

## 5. Implementación (`src/auth/`)
```
auth/
├── config.ts        // GOOGLE_CLIENT_ID
├── gis.ts           // carga GIS, decodifica JWT, expone signIn()/signOut()/getUser()
└── AuthGate.tsx     // componente overlay que bloquea el wizard sin sesión
```
Decodificar el JWT sin validación de firma server-side es aceptable para este gate (no es un control de seguridad); envolver todo acceso a `localStorage` en try/catch (puede fallar en modo privado).
