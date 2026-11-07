# DEPLOYMENT — GitHub Pages + Cloudflare + xva.cl

> Esta parte la ejecuta el **humano / otra sesión de Claude Code**, no Antigravity. Antigravity solo deja el build estático reproducible en `dist/`. Documentado aquí para cerrar el círculo. Patrón idéntico a tradeai.cl.

## 1. Estado de partida de xva.cl (importante)
`xva.cl` **hoy redirige 301 → segundaopinion.cl** (está en el proyecto Vercel de SegundaOpinión, DNS en Cloudflare). Para servir este sitio hay que **repuntar xva.cl a GitHub Pages**, quitando el redirect de Vercel.

Dominio: NIC Chile `xva.cl` (id 9233439), cuenta `carlos.alberto.rt@gmail.com`. DNS en Cloudflare (cuenta `e81fa08cd00bbe8e1c497eb1b296121d`, nameservers `chip.ns.cloudflare.com` + `emerie.ns.cloudflare.com`).

## 2. Repo y Pages
- Crear repo **`Coto-Trader/xva-cl`** (gh CLI ya autenticado como `Coto-Trader`).
- Publicar el build: contenido de `dist/` en branch **`main`**, path **`/`**, con `CNAME` = `xva.cl` y `.nojekyll` en la raíz.
- Activar Pages: `gh api -X PUT repos/Coto-Trader/xva-cl/pages -f cname=xva.cl -f 'source[branch]=main' -f 'source[path]=/'`.

## 3. DNS (Cloudflare, quitando el redirect Vercel)
1. En Vercel (proyecto segundaopinion): **quitar** `xva.cl` y `www.xva.cl` del proyecto (ya no redirige).
2. En Cloudflare, zona `xva.cl`, reemplazar los A → 76.76.21.21 (Vercel) por los **4 IPs de GitHub Pages**, todos **DNS only (grey cloud)**:
   - `A @` → 185.199.108.153 / 185.199.109.153 / 185.199.110.153 / 185.199.111.153
   - `CNAME www` → `coto-trader.github.io`
3. Grey cloud (DNS only) para que GitHub emita su propio cert Let's Encrypt y permita "Enforce HTTPS" (mismo criterio que tradeai.cl).

## 4. HTTPS
- Esperar a que GitHub emita el cert (`cert_state: approved`). Si se atasca, hacer **un** reset limpio del dominio (remove cname → esperar ~6 min → re-add), no togglear repetido (causa backoff). Lección de tradeai.cl.
- Activar Enforce HTTPS: `gh api -X PUT repos/Coto-Trader/xva-cl/pages -F https_enforced=true` (mayúscula `-F`, es booleano).

## 5. Google OAuth
- El Client ID de `AUTH.md` debe tener como Authorized JavaScript origins `https://xva.cl`, `https://www.xva.cl`, `https://coto-trader.github.io`. El botón de Google solo funciona sobre HTTPS (gated por el cert).

## 6. Ecosistema
- Actualizar el ribbon de las otras marcas (segundaopinion.cl, tradeai.cl) para que `xva.cl` apunte al sitio real (ya no un redirect).

## 7. Checklist de salida
- [ ] `dist/` build limpio con CNAME + .nojekyll.
- [ ] Repo `Coto-Trader/xva-cl` con Pages activo.
- [ ] Vercel: xva.cl removido del redirect.
- [ ] Cloudflare: A → IPs GitHub Pages, grey cloud; CNAME www.
- [ ] Cert approved + Enforce HTTPS.
- [ ] OAuth origins con xva.cl.
- [ ] Login Google funciona sobre https://xva.cl.
- [ ] Ribbon de ecosistema actualizado.
