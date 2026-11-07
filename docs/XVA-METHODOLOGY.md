# XVA-METHODOLOGY — fiel a Gregory, _The xVA Challenge_ (3ª ed.)

Especificación cuantitativa del motor. Cada regla cita el capítulo del libro. Las fórmulas son estándar; las citas breves respaldan los criterios y defaults. Si algo no está en el libro, va marcado como supuesto.

Mapa de capítulos del libro (índice completo en el vault `SegundaOpinion/Referencias/xVA-Challenge-Gregory-Indice.md`):
Cap. 5 netting · 6 colateral · 7 exposición · 8 capital · 10 Monte Carlo · 11 colateral+MPR · 12 default/curvas · 13 descuento/OIS · 14 CVA/DVA · 15 FVA · 16 MVA/KVA · 17 WWR · 18 gestión · 19 optimización.

---

## 1. Curvas de descuento (`engine/curves.ts`) — Cap. 13

- Tasa cero continua, interpolación **monótona (PCHIP)**; extrapolación plana fuera de los tenores. `df(t) = exp(-z(t)·t)`, `df(0)=1`.
- **Descuento a la tasa del colateral:** una operación perfectamente colateralizada se descuenta a la tasa que paga el colateral (OIS).
  > "the correct discounting rate for a derivative is the rate of return of collateral" — Cap. 13
- Una curva por divisa de colateral: `SOFR` (USD), `CAMARA_CLP` (CLP), `CAMARA_UF` (UF). La divisa de descuento la fija el CSA, no el producto.
- Cheapest-to-deliver (si el CSA admite varias divisas de colateral): postear en la de mayor rendimiento.
  > "A party should optimally post the collateral in the highest yielding currency" — Cap. 13
  (v1: puede quedar como supuesto simplificado si solo hay una divisa elegible.)

## 2. Crédito (`engine/credit.ts`) — Cap. 12

- **Probabilidades risk-neutral** derivadas de spreads de mercado (lo exigen reguladores/auditores e IFRS 13).
  > "regulators and auditors generally do not support the deviation from risk-neutral default probabilities" — Cap. 12
- Triángulo de crédito: hazard `λ ≈ s / LGD`, con `LGD = 1 − recovery`. Supervivencia `S(t)=exp(−∫λ)`, default marginal `S(t0)−S(t1)`.
- Curva de hazard **piecewise-constant** bootstrapeada por tenor; definir toda la estructura temporal hasta el vencimiento del portafolio.
  > "define fully the term structure of credit spreads up to the maturity" — Cap. 12
- Importa la **forma** de la curva, no solo el nivel.
  > "it is also important to know the precise curve shape" — Cap. 12
- **Proxy para ilíquidos (imprescindible):** si no hay CDS, mapear a una curva genérica por rating/industria/región.
  > "the bank must use a proxy spread that is appropriate based on the rating, industry and region" — Cap. 12
- Limitación a declarar: un bootstrap flat-average no representa curvas CDS invertidas (nombres distressed). Marcar la contraparte como no soportada en ese caso, no forzar.

## 3. Exposición por Monte Carlo (`engine/scenario.ts`, `engine/exposure.ts`) — Cap. 7, 10, 11

Definiciones (Cap. 7): exposición `E(t)=max(V(t),0)`, exposición negativa `NE(t)=min(V(t),0)` (guardar como magnitud positiva `ENE≥0` para consumo del XVA). Métricas: EE (=EPE instantánea), PFE (cuantil), EPE (promedio temporal de EE), EEPE (EPE efectiva, horizonte 1 año para capital).
- La exposición se define en **múltiples horizontes** (a diferencia del VAR).
  > "exposure needs to be defined over multiple time horizons" — Cap. 7
- Modelar el **roll-off / ageing** de las operaciones.
  > "'ageing' of transactions must be considered" — Cap. 7

Monte Carlo (Cap. 10):
- Un **modelo de simulación genérico y consistente** entre factores de riesgo; escenarios consistentes para ver riesgos que se compensan dentro del netting set.
  > "the simulation model must be generic to support consistent simulation of the many risk factors" — Cap. 10
- La **calibración** importa tanto como la elección del modelo.
  > "calibration of these models is just as important" — Cap. 10
- Grilla: última fecha ≥ vencimiento más largo; agregación **por netting set**.
  > "This must be done separately for each netting set." — Cap. 10
- **Pathwise** para path-dependent / bermudas / colateral.
  > "the pathwise method is more suitable for path-dependent derivatives... collateral modelling" — Cap. 10
- Parsimonia: los modelos no deben ser demasiado complejos para poder simularse.
  > "Models must obviously not be too complex" — Cap. 10

Colateral y MPR (Cap. 11):
- Exposición no colateralizada sobre todo el horizonte; colateralizada sobre el MPR.
- Para la exposición colateralizada en `t`, usar el colateral llamado en `t−MPR` según `MTM(t−MPR)`.
  > "what amount of collateral would have been requested previously at a time t - MPR" — Cap. 11
- El MPR no es la suma literal de los periodos pre/post default; el MTA no entra en el enfoque lookback.
- IM posteado no entra en la exposición si está segregado.
- Aplicar colateral: `colateral_llamado = max(MTM − threshold, 0)` redondeado al rounding, con MTA; IM como threshold negativo. Un CSA two-way no siempre reduce la exposición (advertencia del libro).

## 4. CVA / DVA / FVA (`engine/xva.ts`) — Cap. 14, 15

CVA (Cap. 14): `CVA = LGD · Σ EE(ti)·DF(ti)·PD_marg(ti)`.
- Integrar la **distribución** de EE y PD en el tiempo, no promedios; el default entra **solo vía PD**; descontar la EE.
  > "the formula must integrate over time to take into account the precise distribution of EE and PD" — Cap. 14
  > "default enters the expression via default probability only" — Cap. 14
- Calcular al **nivel del netting set**; al cargar CVA como spread el problema es no lineal → resolver recursivamente.
- Vista contable IFRS 13: reportar **CVA y DVA**. `accounting_xva = −CVA + DVA`.
  > "both CVA and DVA components to be reported" — Cap. 14

DVA (Cap. 14): `DVA = LGD_own · Σ ENE(ti)·DF(ti)·PD_own_marg(ti)`, a nivel netting set.

FVA (Cap. 15): `FCA = Σ EPE·FS·DF·dt`, `FBA = Σ ENE·FS·DF·dt` (FS = funding spread).
- La exposición genera coste de funding igual que genera CVA.
  > "exposure drives a funding cost, just as it drives CVA" — Cap. 15
- Horizonte FVA = recibir colateral en escenario **normal** (más corto que el MPR de CVA).
- IM **no** entra en FVA (va en MVA). Colateral segregado/no rehipotecable es inútil para funding.
  > "we will not include initial margin in the FVA discussion... as margin value adjustment (MVA)" — Cap. 15

**Corrección crítica (doble conteo DVA/FBA) — Cap. 15:** DVA y FBA monetizan la misma exposición negativa; sumar ambos duplica el beneficio.
> "double-counting... of DVA and FBA... meaning that only one should be considered" — Cap. 15

Por lo tanto el motor expone **dos vistas separadas, que nunca se suman**:
```ts
net_xva        = -CVA - FCA + FBA   // económica / pricing (DVA excluido, práctica de mercado)
accounting_xva = -CVA + DVA         // contable IFRS 13
```

## 5. MVA y KVA (`engine/xva.ts`) — Cap. 16 (simplificado en v1)

- **MVA:** coste de postear/recibir IM remunerado por debajo del risk-free. `MVA = Σ IM(ti)·(FC(ti)−sIM)·DF(ti)·dt`.
  > "IMs and default funds... not remunerated at anything more than a 'risk-free' rate (and typically less)" — Cap. 16
- **KVA (simplificado):** `KVA = Σ EC(ti)·CoC·DF(ti)·dt` sobre el perfil de capital. Calcular para todo el portafolio; usar parámetros **real-world** (KVA no se cubre); CVA/FVA sí se cubren → risk-neutral.
  > "KVA should be calculated with real-world and not risk-neutral parameters" — Cap. 16
- Criterio de producto (Cap. 19): IM recibido reduce CVA/KVA pero no es beneficio de funding si se segrega; IM/clearing se favorecen en productos de mayor plazo.

## 6. Wrong-way risk (`engine/xva.ts` / módulo WWR) — Cap. 17 (caso simple en v1)

- WWR = dependencia desfavorable entre exposición y calidad crediticia.
  > "unfavourable dependence between exposure and counterparty credit quality" — Cap. 17
- Hay que tratarlo para pricing/hedging correctos; crece a medida que mejora la calidad de la contraparte. v1: enfoque paramétrico simple (correlación exposición–default) sobre el CVA.
- El beneficio del colateral bajo WWR debe contar saltos y mayor volatilidad en el MPR.

## 7. Convenciones numéricas
- `ENE` siempre magnitud positiva (`≥0`); los signos de `net_xva`/`accounting_xva` asumen eso.
- Redondear solo en la capa de presentación, no en el cálculo.
- Todo cálculo determinista dado el `seed`.
- Cada función del motor lleva test que reproduce un ejemplo del motor Python de referencia o un caso del libro (tolerancia relativa documentada).

## 8. Límites declarados (3ª ed., 2015)
- No cubre SA-CVA de FRTB posterior ni SIMM al detalle.
- Capital regulatorio (SA-CCR/IMM exactos) fuera de alcance v1; KVA es una aproximación.
- Donde el motor vaya más allá del libro, marcar `// SUPUESTO (no en Gregory)`.
