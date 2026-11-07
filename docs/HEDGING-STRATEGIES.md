# HEDGING-STRATEGIES — sensibilidades y recomendación de cobertura

El sistema no solo entrega el número XVA: entrega **qué cubrir y en qué dirección**. Ej.: "comprar vega", "vender DV01 en el tramo 5Y". Fiel a Gregory, Cap. 18 (gestión/hedging) y 16/19.

## 1. Sensibilidades (`engine/sensitivities.ts`)
Método v1: **bump-and-revalue** sobre el pipeline XVA (AAD queda para después, ref `sensitivities/aad.py`).

Griegas que debe producir por netting set y agregadas al portafolio:
- **Delta / DV01**: ∂XVA/∂(tasa) por tramo de curva (bump 1 bp por tenor de la curva de descuento y de la forward). Reporta DV01 por tenor (grilla QuickSens, ref `quicksens_grid.py`).
- **Credit delta (CS01)**: ∂CVA/∂(spread de crédito) por tenor de la curva de crédito.
- **Vega**: ∂XVA/∂(volatilidad) — vol FX UF/CLP y vol de tasas. Clave porque el XVA es una opción.
  > xVA se comporta como una opción exótica: "xVA as an exotic option" — Cap. 18
- **FX delta**: ∂XVA/∂(spot UF/CLP).

Regla de bump (Cap. 10): los shifts se aplican **a nivel de transacción**.
> "shifts should be applied at the transaction level" — Cap. 10

## 2. De sensibilidad a estrategia (`engine/hedging.ts`)
La recomendación traduce el signo y magnitud de cada griega en una acción, con umbral de materialidad y coste de cobertura. Ref `hedging/advisor.py` (regla de ejecución forzada: cubrir cuando el deterioro proyectado del XVA supera el coste del hedge hoy).

Lógica base (una acción por griega materialmente distinta de cero):

| Griega del XVA | Signo | Acción recomendada | Instrumento |
|---|---|---|---|
| Vega > 0 (XVA sube si sube la vol) | largo vol | **Vender vega** (vender opcionalidad) | swaptions / opciones FX |
| Vega < 0 | corto vol | **Comprar vega** | swaptions / opciones FX |
| CS01 (CVA sube si suben spreads) | — | **Comprar protección CDS** (o índice si es proxy) | CDS single-name / índice |
| DV01 por tramo | según signo | **Pagar/recibir fijo** en ese tramo | IRS |
| FX delta | según signo | **Comprar/vender** el par | FX forward |

La salida para el usuario es explícita, p. ej.:
> "El XVA de esta contraparte es **largo vega** (∂XVA/∂vol = +X por punto de vol). Para cubrir: **vender vega** vía swaptions por ~Y. Deterioro proyectado del CVA (Z) > coste del hedge hoy (W) → se recomienda ejecutar."

## 3. Reglas del libro que condicionan el hedging (Cap. 18)
- La mesa xVA debe cubrir el xVA como una opción (potencialmente compleja).
  > "hedging should be approached in a similar way to that of hedging options" — Cap. 18
- Los xVA **no son aditivos** → la cobertura se arma a nivel portafolio, con cuidado de los cross-gamma.
- Mesa xVA = utility con P&L objetivo cero; estructura de límites. Esto es gobierno (no se modela en el motor) → mostrarlo como contexto, no como cálculo.
- CVA se cubre (risk-neutral); KVA normalmente no se cubre (real-world). La recomendación de cobertura aplica a CVA/FVA, no a KVA.

## 4. Presentación (UI)
- Panel "Cobertura" con: tabla de griegas (valor + materialidad), la(s) acción(es) recomendada(s) en lenguaje claro, y el racional (deterioro proyectado vs coste).
- Botón "explicar" por acción que muestre la regla y el capítulo del libro que la respalda.
- Separar siempre cobertura económica (CVA/FVA) de la figura contable (no se cubre para "maquillar" IFRS 13).

## 5. Límites v1
- Sin optimización de portafolio de hedges (solo recomendación por griega).
- Cross-gamma: mencionado, no cuantificado en v1 (Cap. 18.3.6) → marcar supuesto.
- Costes de hedge: parametrizables por el usuario (bid-offer), no de mercado en vivo.
