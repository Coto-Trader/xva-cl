# AGENTS.md — Instrucciones maestras para el agente constructor (Antigravity)

> Este archivo es la fuente de verdad para construir **XVA.cl**. Léelo completo antes de escribir una línea de código, y vuelve a él en cada iteración. Los documentos de `docs/` amplían cada sección; este archivo manda sobre ellos si hay conflicto.

## 0. Qué estás construyendo

Un **sistema web de valorización XVA** (CVA / DVA / FVA / MVA / KVA) para derivados OTC, que **convierte la metodología del libro de Jon Gregory, _The xVA Challenge_ (3ª ed., 2015), en software**. El usuario crea contrapartes (clientes), configura colateral/CSA (global o puntual por operación), carga productos y curvas de mercado, el sistema simula exposición por **Monte Carlo** y entrega los ajustes XVA más una **recomendación de cobertura** (p. ej. "comprar/vender vega", "comprar/vender DV01").

El sistema es **100% estático**, hosteado en **GitHub Pages** y servido en **xva.cl**. Todo el cálculo corre **en el navegador** (TypeScript/JS, WASM opcional). No hay backend.

## 1. Stack técnico (obligatorio)

- **Lenguaje:** TypeScript (estricto, `strict: true`).
- **Build:** Vite. Salida estática a `dist/`.
- **Framework UI:** React 18 + TypeScript. Sin SSR (es estático).
- **Estado:** Zustand (ligero) o Context; nada de Redux.
- **Gráficos:** Recharts o Chart.js (perfiles de exposición, curvas, waterfall XVA).
- **Numérico:** implementación propia en TS para álgebra/estadística ligera; si hace falta, `mathjs` para utilidades. **No** traer Python al navegador (se descartó Pyodide).
- **Auth:** Google Identity Services (GIS) client-side — ver `docs/AUTH.md`.
- **Routing:** `react-router` en modo hash o con `404.html` fallback (GitHub Pages no hace rewrites).
- **Sin backend, sin base de datos de servidor.** La persistencia es `localStorage` (escenarios guardados por el usuario) y export/import JSON.

## 2. El motor XVA se REIMPLEMENTA en TypeScript

Existe un motor de referencia en Python en `C:\Users\carlo\OneDrive\Desarrollos\Curso Bencorde\XVA-Engine` (`src/xva_engine/`). **No lo portes literalmente ni lo ejecutes**: úsalo como **especificación ejecutable** junto con el libro. Módulos de referencia y su equivalente TS:

| Python (referencia) | Módulo TS a crear | Doc |
|---|---|---|
| `curves/curve_builder.py` | `engine/curves.ts` | `docs/XVA-METHODOLOGY.md` §Curvas |
| `xva/credit.py` | `engine/credit.ts` | §Crédito |
| `xva/exposure.py` | `engine/exposure.ts` | §Exposición |
| `xva/cva_dva_fva.py` | `engine/xva.ts` | §XVA |
| `sensitivities/` (aad, quicksens) | `engine/sensitivities.ts` | `docs/HEDGING-STRATEGIES.md` |
| `hedging/advisor.py` | `engine/hedging.ts` | `docs/HEDGING-STRATEGIES.md` |

**Corrección ya incorporada que debes respetar:** el `net_xva` económico es `-CVA - FCA + FBA` (DVA **excluido**, para no duplicar el beneficio con FBA); el DVA va aparte como figura contable `-CVA + DVA` (IFRS 13). Nunca sumes DVA y FBA juntos. Ver `docs/XVA-METHODOLOGY.md` §CVA/DVA/FVA.

## 3. Fidelidad al libro (regla de oro)

Cada fórmula, criterio o default del motor debe poder respaldarse con el libro de Gregory, citando **capítulo**. `docs/XVA-METHODOLOGY.md` ya trae las reglas con su cita. Si algo no está en el libro, no lo inventes: márcalo como supuesto en un comentario `// SUPUESTO (no en Gregory): ...`. Es la 3ª ed. (2015): no cubre SA-CVA de FRTB posterior ni SIMM al detalle — decláralo donde corresponda, no lo improvises.

## 4. Flujo de usuario (el "wizard")

1. **Ingreso** → validación Google (Gmail).
2. **Curvas** → construir/parametrizar curvas de descuento (OIS por divisa: SOFR, Cámara CLP, Cámara UF) y curvas de crédito (CDS/proxy).
3. **Cliente (contraparte)** → crear y parametrizar: rating, sector, región, recovery, curva de crédito o proxy.
4. **Colateral / CSA** → configurar CSA **global** (aplica a toda la relación) o **puntual por operación**; tipo (sin CSA / one-way / two-way), threshold, MTA, IM, haircuts, divisa elegible, MPOR.
5. **Productos** → cargar operaciones (empezar por CCS UF/CLP), agruparlas en netting sets.
6. **Resultados** → perfiles de exposición (EE/ENE/PFE), waterfall XVA (CVA/DVA/FVA/MVA/KVA), y **recomendación de cobertura** (sensibilidades + estrategia: comprar/vender vega, DV01, etc.).

Ver `docs/UI-UX.md` para pantallas y `docs/DATA-MODEL.md` para las entidades.

## 5. Identidad visual (idéntica a TradeAI)

Tema "terminal" oscuro. **No inventes colores.** Tokens en `:root`:

- Señal cian: `--signal: #2FD9E8;` `--signal-bright: #8CEFF6;` `--signal-deep: #1F9DAC;`
- Fondos: `--bg: #0A0E14;` paneles `#0E141D` / `#121A24` / `#16202C`.
- P&L: up `--up: #34D399;` down `--down: #F2574C;`
- Fuentes: display **Archivo**, texto **IBM Plex Sans**, mono **JetBrains Mono** (Google Fonts).
- Ribbon de ecosistema arriba: segundaopinion.cl · xva.cl (actual) · tradeai.cl, con chip "Ingresar / Registrarse".

Ver `docs/UI-UX.md` §Design system para el detalle y las clases.

## 6. Cómo trabajar (proceso)

- Construye en el **orden de `docs/ROADMAP.md`** (de abajo hacia arriba: modelo de dominio → curvas → crédito → pricing → exposición → XVA → hedging → UI → auth → deploy). No saltes fases.
- Cada fase tiene **criterios de aceptación** en `docs/REQUIREMENTS.md`. No marques una fase como hecha sin cumplirlos.
- **Tests:** Vitest. Cada módulo del motor lleva tests que reproducen un ejemplo numérico del libro o del motor Python de referencia. Sin tests verdes, la fase no está hecha.
- **Commits:** pequeños y por fase. Mensajes claros en inglés. Rama por feature; nunca commitees directo sobre `main` si hay PR abierto.
- **No toques** el repo Python `XVA-Engine` ni la copia en `Desktop\God`: son solo referencia de lectura.

## 7. Qué NO hacer

- No backend, no base de datos de servidor, no secretos en el repo.
- No cobrar ni mover dinero: es una herramienta de valorización, no de ejecución.
- No prometer que es precio de liquidación: es **valor razonable IFRS 13 / precio de salida teórico** (lenguaje de SegundaOpinión), nunca "lo que el banco te debe".
- No sumar DVA y FBA juntos (doble conteo).
- No inventar reglas que no estén en el libro sin marcarlas como supuesto.

## 8. Entregable final

Un sitio estático en `dist/` listo para GitHub Pages, con `CNAME` = `xva.cl` y `.nojekyll`. El montaje en GitHub + Cloudflare + flip de xva.cl lo hace el humano/otra sesión — ver `docs/DEPLOYMENT.md` (no ejecutes tú el deploy; deja el build reproducible).

## 9. Índice de documentos

- `docs/PRD.md` — qué y para quién.
- `docs/ARCHITECTURE.md` — cómo está armado técnicamente.
- `docs/DATA-MODEL.md` — entidades y tipos TS.
- `docs/XVA-METHODOLOGY.md` — el quant, fiel a Gregory, con citas.
- `docs/HEDGING-STRATEGIES.md` — sensibilidades y la recomendación de cobertura.
- `docs/UI-UX.md` — design system y pantallas.
- `docs/AUTH.md` — validación Google/Gmail.
- `docs/REQUIREMENTS.md` — requisitos funcionales/no funcionales + aceptación.
- `docs/ROADMAP.md` — orden de construcción por fases.
- `docs/DEPLOYMENT.md` — hosting GH Pages + xva.cl (lo ejecuta el humano).
- `docs/GLOSSARY.md` — glosario xVA.
