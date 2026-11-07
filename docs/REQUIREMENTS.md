# REQUIREMENTS — XVA.cl

Requisitos numerados con criterios de aceptación. "Hecho" = criterio verificable + test verde.

## Funcionales (FR)

### FR-1 Curvas
- FR-1.1 Construir curvas de descuento cero por divisa (SOFR, Cámara CLP, Cámara UF) con interpolación monótona (PCHIP) y extrapolación plana.
- FR-1.2 `discountFactor(t)` y `forwardRate(t1,t2)` correctos; `df(0)=1`.
- FR-1.3 Editar tenores/tasas en UI con validación (crecientes, ≥2 puntos) y gráfico en vivo.
- **Aceptación:** reproduce los DFs del motor Python de referencia (tol. rel. 1e-6) para las curvas de ejemplo.

### FR-2 Crédito
- FR-2.1 Bootstrap de hazard desde CDS (triángulo `λ≈s/LGD`), curva piecewise-constant, supervivencia y PD marginal.
- FR-2.2 **Proxy obligatorio** por rating/sector/región cuando no hay CDS.
- FR-2.3 Rechazar/avisar curvas CDS invertidas (hazard marginal negativo) en lugar de producir basura.
- **Aceptación:** PDs marginales coinciden con `credit.py` (tol. 1e-6); una contraparte sin CDS y sin proxy es inválida en el builder.

### FR-3 Exposición
- FR-3.1 Monte Carlo pathwise con seed reproducible; grilla hasta el vencimiento; agregación por netting set.
- FR-3.2 Métricas EE, ENE (≥0), PFE (cuantil configurable), EPE, EEPE.
- FR-3.3 Aplicar colateral/CSA con lookback MPOR; IM segregado excluido de la exposición.
- **Aceptación:** con misma seed, resultados estables; el colateral reduce EE respecto al caso no colateralizado en el ejemplo base; perfiles coherentes con `exposure.py`.

### FR-4 XVA
- FR-4.1 CVA = `LGD·Σ EE·DF·PD` a nivel netting set; EE descontada; default solo vía PD.
- FR-4.2 DVA a nivel netting set.
- FR-4.3 FVA: FCA y FBA con funding spread; IM fuera de FVA.
- FR-4.4 **Dos totales separados:** `net_xva = −CVA−FCA+FBA` y `accounting_xva = −CVA+DVA`. **Nunca** sumar DVA y FBA.
- FR-4.5 MVA y KVA simplificados.
- **Aceptación:** test que falla si el código vuelve a sumar DVA+FBA en un mismo total; números coinciden con `cva_dva_fva.py` (ya corregido) en el ejemplo.

### FR-5 Wrong-way risk
- FR-5.1 Caso simple/paramétrico: correlación exposición–default que ajusta el CVA.
- **Aceptación:** CVA con WWR>0 ≥ CVA sin WWR en el ejemplo.

### FR-6 Sensibilidades y cobertura
- FR-6.1 Bump-and-revalue para DV01 (por tramo), CS01, vega (FX y tasas), FX delta.
- FR-6.2 Recomendación de cobertura por griega material (comprar/vender vega, CDS, pagar/recibir fijo, comprar/vender FX) con racional (deterioro vs coste) y cita del libro.
- **Aceptación:** una posición con vega>0 genera la acción "vender vega"; el panel explica la regla y el capítulo.

### FR-7 Modelo de dominio y escenarios
- FR-7.1 Crear/editar/eliminar contrapartes, CSAs (global y puntual), operaciones, netting sets, vía builder con validación.
- FR-7.2 Resolución de CSA por operación: override puntual pisa al global.
- FR-7.3 Guardar/cargar escenarios en localStorage; export/import JSON.
- **Aceptación:** un escenario exportado e importado reproduce idénticos resultados.

### FR-8 Auth
- FR-8.1 Login Google (GIS) client-side; perfil en localStorage; gate del wizard sin sesión.
- **Aceptación:** sin sesión, el wizard está bloqueado; con sesión, el chip muestra nombre/avatar y "salir" limpia.

### FR-9 UI
- FR-9.1 Wizard de 5 pasos con indicador de completitud; identidad visual TradeAI.
- FR-9.2 Resultados: perfiles de exposición, waterfall XVA con las dos vistas separadas, panel de cobertura.
- FR-9.3 Microcopy IFRS 13 (nunca "precio de liquidación").

## No funcionales (NFR)
- NFR-1 **Estático**: build a `dist/` servible por GitHub Pages; sin backend.
- NFR-2 **Rendimiento**: Monte Carlo en Web Worker; UI no se bloquea; progreso visible; v1 ≤10k paths/≤100 puntos con aviso de trade-off.
- NFR-3 **Reproducibilidad**: mismo seed → mismo resultado.
- NFR-4 **Trazabilidad**: cada regla del motor comentada con su capítulo de Gregory; supuestos marcados `// SUPUESTO (no en Gregory)`.
- NFR-5 **Tests**: Vitest; cada módulo del motor con test numérico contra el motor Python o el libro.
- NFR-6 **TypeScript estricto**; sin `any` salvo justificado.
- NFR-7 **Privacidad**: ningún dato sale del navegador salvo el login de Google; sin secretos en el repo.
- NFR-8 **Accesibilidad/responsive**: ancho de teléfono, contraste, foco visible, font ≥12px.
- NFR-9 **Fidelidad**: si no está en el libro, no se inventa (se marca supuesto). 3ª ed. 2015: límites declarados.
