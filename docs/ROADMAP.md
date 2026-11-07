# ROADMAP — orden de construcción

De abajo hacia arriba, por dependencia. No saltar fases. Cada fase cierra con sus tests verdes (Vitest) y los criterios de `REQUIREMENTS.md`.

## Fase 0 — Modelo de dominio (`src/domain/`)
Entidades + builder + validación (`DATA-MODEL.md`). Sin esto no hay dónde crear clientes/CSAs/productos.
- Tipos: Currency, Rating, CSAType, Counterparty, CSA, Trade/CCSUFCLPTrade, NettingSet, Portfolio, MarketEnv, MonteCarloConfig, Scenario.
- `builder.ts`: create*/validate* (exige curva o proxy en la contraparte; valida CSA).
- **Done:** tests del builder (entidades válidas/ inválidas) verdes.

## Fase 1 — Curvas (`engine/curves.ts`)
ZeroCurve PCHIP, discountFactor, forwardRate, CurveSet.
- **Done:** FR-1; DFs coinciden con `curve_builder.py`.

## Fase 2 — Crédito (`engine/credit.ts`)
Bootstrap hazard, supervivencia, PD marginal, proxy por rating/sector/región, manejo de curva invertida.
- **Done:** FR-2.

## Fase 3 — Pricing (`engine/pricing.ts`) + escenarios (`engine/scenario.ts`)
Generación Monte Carlo (FX UF/CLP, tasas) pathwise con seed; `mtm`/`cashflows` del CCS UF/CLP.
- **Done:** MTM del CCS reproduce el caso de referencia; escenarios reproducibles por seed.

## Fase 4 — Exposición (`engine/exposure.ts`)
Agregación por netting set, colateral/CSA con MPOR, métricas EE/ENE/PFE/EPE/EEPE.
- **Done:** FR-3.

## Fase 5 — XVA (`engine/xva.ts`)
CVA, DVA, FCA/FBA, MVA, KVA; dos vistas separadas; **test anti-doble-conteo DVA/FBA**.
- **Done:** FR-4; números coinciden con `cva_dva_fva.py` corregido.

## Fase 6 — Wrong-way risk
Caso simple/paramétrico sobre el CVA.
- **Done:** FR-5.

## Fase 7 — Sensibilidades + cobertura (`engine/sensitivities.ts`, `engine/hedging.ts`)
Bump-and-revalue (DV01/CS01/vega/FX delta) y recomendación de cobertura.
- **Done:** FR-6.

## Fase 8 — Estado + Web Worker (`src/store/`, worker)
Zustand; correr el pipeline en Web Worker con progreso; guardar/cargar escenarios; export/import JSON.
- **Done:** FR-7, NFR-2, NFR-3.

## Fase 9 — UI (`src/ui/`)
Design system (tokens TradeAI), wizard de 5 pasos, pantallas, gráficos, resultados con las dos vistas + panel de cobertura.
- **Done:** FR-9, NFR-8.

## Fase 10 — Auth (`src/auth/`)
Google Identity Services, gate del wizard.
- **Done:** FR-8.

## Fase 11 — Build estático + handoff de deploy
`vite build` → `dist/`; `public/CNAME` = `xva.cl`; `public/.nojekyll`; hash router o `404.html`. **No ejecutar el deploy** (lo hace el humano/otra sesión, `DEPLOYMENT.md`); dejar el build reproducible y documentado.
- **Done:** `npm run build` produce `dist/` servible; `README` con pasos.

## Hitos
- **M1 (motor):** Fases 0–5 → se puede calcular XVA de un CCS por consola/test.
- **M2 (análisis):** Fases 6–8 → WWR, sensibilidades, cobertura, escenarios guardables.
- **M3 (producto):** Fases 9–10 → UI completa con auth.
- **M4 (deploy):** Fase 11 → listo para xva.cl (deploy a cargo del humano).

## Regla transversal
En cada fase: comentar las reglas con su capítulo de Gregory, marcar supuestos, y no avanzar sin tests. La fidelidad al libro manda sobre la velocidad.
