# ARCHITECTURE — XVA.cl

## 1. Modelo de despliegue
Sitio **100% estático** (HTML/JS/CSS) servido por **GitHub Pages** en **xva.cl**. Sin backend, sin base de datos de servidor. Todo el cálculo corre en el navegador. Persistencia: `localStorage` + export/import JSON.

```
Navegador del usuario
 ├─ UI (React)
 ├─ Motor XVA (TypeScript, puro, sin I/O)
 ├─ Auth (Google Identity Services, client-side)
 └─ Persistencia (localStorage, JSON export/import)
        │
        ▼
GitHub Pages (Coto-Trader/xva-cl, branch main, /) ── Cloudflare DNS (grey cloud) ── xva.cl
```

## 2. Capas
1. **`domain/`** — entidades puras (tipos + validación), sin dependencias de UI ni de motor. Ver `DATA-MODEL.md`.
2. **`engine/`** — motor XVA en TypeScript puro (funciones sin estado, deterministas dado un seed). No importa React ni toca el DOM. Testeable con Vitest.
3. **`store/`** — estado de la app (zustand): portafolio actual, escenario, resultados, usuario.
4. **`ui/`** — React. Wizard, pantallas, gráficos, design system.
5. **`auth/`** — Google Identity Services.

Regla de dependencia: `ui → store → engine → domain`. Nunca al revés. El motor **no** conoce la UI.

## 3. Módulos del motor (`engine/`)
- `curves.ts` — `ZeroCurve` (interpolación monótona PCHIP sobre tasas cero continuas), `discountFactor(t)`, `forwardRate(t1,t2)`, `CurveSet` (SOFR, Cámara CLP, Cámara UF). Ref: `curve_builder.py`.
- `credit.ts` — bootstrap de hazard desde CDS (triángulo de crédito `λ ≈ s/LGD`), curva de hazard piecewise-constant, probabilidades de supervivencia/default marginal, **proxy por rating/sector/región** para ilíquidos. Ref: `credit.py` + `XVA-METHODOLOGY.md §Crédito`.
- `scenario.ts` — generación de escenarios Monte Carlo (factores de riesgo: FX UF/CLP, tasas) sobre una grilla temporal; pathwise; un seed reproducible.
- `pricing.ts` — pricers por producto: `mtm(trade, market, t, scenario)` y `cashflows(trade)`. Empezar por CCS UF/CLP.
- `exposure.ts` — agrega MTM por netting set, aplica colateral/CSA con lookback MPOR, produce EE/ENE/PFE/EPE/EEPE. Ref: `exposure.py`.
- `xva.ts` — CVA, DVA, FCA/FBA (FVA), MVA, KVA simplificados; vistas económica y contable. Ref: `cva_dva_fva.py` (con la corrección del doble conteo ya aplicada).
- `sensitivities.ts` — bump-and-revalue (y/o AAD futuro) para delta/DV01 y vega. Ref: `sensitivities/`.
- `hedging.ts` — traduce sensibilidades + reglas del libro en recomendación de cobertura. Ref: `hedging/advisor.py` + `HEDGING-STRATEGIES.md`.

## 4. Pipeline de cálculo (una corrida)
```
Portfolio + MarketEnv + config MC
  → scenario.generate(seed, grid, factors)        // N paths × T puntos
  → pricing.mtm por trade por (path, t)
  → exposure.aggregate por netting set              // MTM neto
  → exposure.applyCollateral (threshold, MTA, IM, MPOR)
  → exposure.metrics → EE, ENE, PFE, EPE, EEPE
  → xva.cva/dva/fva/mva/kva  (usa credit + curves + funding)
  → sensitivities.bump → delta/DV01, vega
  → hedging.recommend → acciones de cobertura
  → resultados (perfiles + waterfall + cobertura)
```
Determinista dado el seed. La corrida se puede ejecutar en un **Web Worker** para no bloquear la UI; mostrar progreso.

## 5. Rendimiento en el navegador
- Monte Carlo en un **Web Worker**; postMessage con progreso.
- Parámetros acotados en v1 (p. ej. ≤ 10.000 paths, ≤ 100 puntos de grilla) con aviso del trade-off. El libro: hay que equilibrar realismo y parsimonia; los modelos deben poder simularse.
- Buckets de cashflows por divisa para reducir revaluaciones (optimización del libro, Cap. 10).
- Tipar arrays con `Float64Array` donde el volumen lo justifique.

## 6. Persistencia
- `localStorage['xvacl_scenarios']`: lista de escenarios guardados (portafolio + config).
- Export/import **JSON** de un escenario completo (para compartir/respaldar).
- `localStorage['xvacl_user']`: perfil Google (igual que TradeAI). Todo client-side; nada sale del navegador salvo el login de Google.

## 7. Routing
GitHub Pages no reescribe rutas. Usar **hash router** (`/#/curvas`, `/#/cliente`, …) o copiar `index.html` a `404.html`. Preferir hash router por simplicidad.

## 8. Qué NO está en la arquitectura
- Sin servidor de cálculo, sin API propia, sin datos de mercado en vivo.
- Sin almacenamiento compartido entre usuarios (es per-navegador).
- Sin secretos en el bundle (el Client ID de Google es público por diseño).
