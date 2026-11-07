# PRD — XVA.cl

## 1. Visión
Convertir la metodología de _The xVA Challenge_ (Gregory, 3ª ed.) en una herramienta web que permita a un analista valorizar los ajustes XVA de un portafolio de derivados OTC, con colateral/CSA configurable, exposición por Monte Carlo, y una recomendación de cobertura accionable. Parte del ecosistema SegundaOpinión (valor razonable IFRS 13).

## 2. Problema
Los ajustes XVA (CVA/DVA/FVA/MVA/KVA) son decisivos para el valor de salida IFRS 13 de un derivado OTC, pero calcularlos exige simular exposición, mapear crédito, modelar colateral y entender funding/capital. Hoy eso vive en hojas de cálculo frágiles o sistemas caros. XVA.cl lo pone en una herramienta guiada, fiel al libro de referencia del área.

## 3. Usuarios
- **Analista de valorización / riesgo** (usuario primario): crea contrapartes, configura CSAs, carga operaciones, lee XVA y cobertura.
- **Tesorería / mesa**: usa la recomendación de cobertura (vega, DV01) para decidir hedges.
- **Auditor / contabilidad**: usa la figura IFRS 13 (CVA + DVA) para cierre contable/tributario.

## 4. Propuesta de valor
- Guiado por el libro: cada número rastreable a un capítulo de Gregory.
- Transparente: perfiles de exposición y waterfall XVA visibles, no una caja negra.
- Accionable: no solo el número, sino "qué cubrir y en qué dirección".
- Cero fricción: estático, corre en el navegador, sin instalar nada.

## 5. Alcance v1 (MVP)
**Incluye:**
- Construcción/parametrización de curvas de descuento (OIS por divisa) y de crédito (CDS directo + proxy por rating/sector/región).
- Contrapartes parametrizables (rating, sector, región, recovery, curva/proxy).
- CSA **global** y **puntual por operación**: sin CSA / one-way / two-way, threshold, MTA, IM, haircuts, divisa elegible, MPOR.
- Netting sets.
- Producto inicial: **cross-currency swap UF/CLP** (NDS, liquidación neta). Arquitectura extensible a IRS, FX forward.
- Exposición por Monte Carlo (EE, ENE, PFE, EPE, EEPE).
- CVA, DVA, FVA (FCA/FBA). MVA y KVA en versión simplificada.
- Wrong-way risk: al menos el caso simple/paramétrico.
- Sensibilidades (delta/DV01, vega) y recomendación de cobertura.
- Validación de acceso vía Google (Gmail).
- Guardar/cargar escenarios (localStorage + export/import JSON).

**No incluye (v1):**
- SA-CVA de FRTB posterior a 2015, SIMM al detalle.
- Capital regulatorio completo (SA-CCR/IMM exactos) — solo KVA simplificado.
- Multi-usuario con backend, colaboración en tiempo real.
- Datos de mercado en vivo (las curvas se cargan/parametrizan a mano o por import).

## 6. Métricas de éxito
- Reproduce los ejemplos numéricos del motor Python de referencia dentro de tolerancia.
- Un analista configura contraparte + CSA + una operación y obtiene XVA + cobertura en < 5 min.
- Los números cuadran con la intuición del libro (p. ej. IM/clearing reducen CVA/KVA pero suben MVA).

## 7. Principios de producto
- **Fidelidad al libro** sobre features vistosas.
- **Transparencia** sobre precisión falsa: mostrar supuestos.
- **IFRS 13**, nunca "precio de liquidación" ni "lo que el banco te debe".
- Misma identidad visual que TradeAI (coherencia de marca).

## 8. Riesgos
- Monte Carlo pesado en el navegador → limitar escenarios/pasos y mostrar el trade-off (el libro: los modelos no deben ser demasiado complejos para poder simularse).
- Contrapartes ilíquidas sin CDS → el proxy por rating/sector/región es imprescindible (no un extra).
- Confundir vista económica (pricing) con vista contable (IFRS 13) → separarlas explícitamente en la UI.
