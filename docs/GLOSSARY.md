# GLOSSARY — términos XVA

Definiciones breves para alinear el vocabulario del sistema. Base: Gregory, _The xVA Challenge_ (3ª ed.).

- **XVA** — familia de ajustes de valoración sobre el precio base de un derivado: CVA, DVA, FVA, MVA, KVA (y ColVA).
- **Exposición** — valor en riesgo ante default de la contraparte. `E(t)=max(V(t),0)`.
- **EE (Expected Exposure)** — exposición esperada en cada tiempo. También EPE instantánea.
- **ENE (Expected Negative Exposure)** — exposición negativa esperada (magnitud ≥0 en el motor).
- **PFE (Potential Future Exposure)** — cuantil alto de la exposición futura.
- **EPE / EEPE** — EE promediada en el tiempo / EPE efectiva (horizonte 1 año para capital).
- **CVA (Credit Value Adjustment)** — coste esperado por default de la contraparte. `LGD·Σ EE·DF·PD`.
- **DVA (Debt Value Adjustment)** — beneficio por el propio default; contable (IFRS 13), no se cobra en pricing.
- **FVA (Funding Value Adjustment)** — coste/beneficio de fondear la exposición no colateralizada. FCA (coste) + FBA (beneficio).
- **MVA (Margin Value Adjustment)** — coste de fondear el margen inicial (IM).
- **KVA (Capital Value Adjustment)** — coste de mantener capital regulatorio por la operación.
- **ColVA** — ajuste por términos del colateral (optionality, tasa). Fuera de alcance v1.
- **Netting set** — conjunto de operaciones con una contraparte bajo un mismo acuerdo de netting/CSA; unidad de agregación del XVA.
- **CSA (Credit Support Annex)** — anexo que define el colateral: tipo, threshold, MTA, IM, haircuts, divisas, MPOR.
- **Threshold** — exposición no colateralizada tolerada antes de llamar colateral.
- **MTA (Minimum Transfer Amount)** — monto mínimo para transferir colateral.
- **IM (Initial Margin)** — colateral independiente del MTM; ≈ threshold negativo.
- **VM (Variation Margin)** — colateral que sigue al MTM.
- **MPOR / MPR (Margin Period of Risk)** — ventana entre el último intercambio de colateral y el cierre; bilateral ≈ 10 días hábiles, sube en ciertos casos.
- **Haircut** — descuento sobre el valor del colateral no-cash.
- **Rehipotecación** — reutilización del colateral recibido; si está prohibida/segregada, el colateral es inútil para funding.
- **Segregación** — colateral aislado; IM segregado no entra en la exposición ni da beneficio de funding.
- **Hazard rate (λ)** — intensidad de default; `λ≈spread/LGD` (triángulo de crédito).
- **LGD / Recovery** — pérdida dada default `= 1 − recovery`.
- **Risk-neutral vs real-world** — probabilidades implícitas de mercado (lo que se cubre y va a accounting: CVA/FVA) vs históricas (lo que no se cubre: KVA).
- **OIS discounting** — descontar a la tasa del colateral (p. ej. SOFR, Cámara) en operaciones perfectamente colateralizadas.
- **Wrong-way risk (WWR)** — dependencia desfavorable entre exposición y calidad crediticia de la contraparte.
- **CS01 / DV01 / Vega** — sensibilidad a 1 bp de spread de crédito / 1 bp de tasa / a la volatilidad.
- **Valor razonable IFRS 13 / precio de salida teórico** — el output del sistema; NO es precio de liquidación.
