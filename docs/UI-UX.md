# UI-UX — XVA.cl

Misma identidad "terminal" que TradeAI / SegundaOpinión. Coherencia de marca obligatoria.

## 1. Design system (tokens, no inventar)
```css
:root {
  --signal: #2FD9E8;          /* cian señal */
  --signal-bright: #8CEFF6;
  --signal-deep: #1F9DAC;     /* para enlaces sobre fondo claro */
  --bg: #0A0E14;              /* canvas near-black */
  --panel-1: #0E141D;
  --panel-2: #121A24;
  --panel-3: #16202C;
  --up: #34D399;              /* P&L positivo / beneficio */
  --down: #F2574C;            /* P&L negativo / coste */
  --text: #E6ECF2;
  --text-dim: #9FB0BF;
  --border: #22303F;
  --font-display: 'Archivo', sans-serif;
  --font-sans: 'IBM Plex Sans', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```
- Fuentes vía Google Fonts (`<link>`): Archivo, IBM Plex Sans, JetBrains Mono.
- Números y tablas en `--font-mono` con cifras tabulares. Títulos en `--font-display`.
- Costes (CVA, FCA, MVA, KVA) en `--down`; beneficios (DVA, FBA) en `--up`. Nunca negro/gris puro sobre fondos de color.
- Modo oscuro es el único modo (es un terminal). Fondos de panel escalonados para jerarquía.

## 2. Ribbon de ecosistema (arriba, en todas las pantallas)
Barra delgada: **segundaopinion.cl · xva.cl (actual, marcado) · tradeai.cl ↗**, con chip "Ingresar / Registrarse" a la derecha (abre el modal de Google). Igual patrón que TradeAI.

## 3. Estructura y navegación
Hash router. Layout: ribbon + topbar (logo XVA, usuario) + sidebar de pasos del wizard + área de trabajo.

Pasos del wizard (sidebar, en orden; se puede volver a cualquiera):
1. **Curvas** · 2. **Cliente** · 3. **Colateral/CSA** · 4. **Productos** · 5. **Resultados**.
Indicador de completitud por paso (✓ / pendiente). No deja llegar a Resultados sin lo mínimo (al menos una curva de descuento, una contraparte con curva/proxy, una operación).

## 4. Pantallas

### 4.1 Ingreso
Modal Google (ver `AUTH.md`). Mientras no haya sesión válida, el wizard está bloqueado con un overlay "Ingresa con Google para continuar".

### 4.2 Curvas
- Tabla editable de tenores/tasas por curva (SOFR, Cámara CLP, Cámara UF) + curva(s) de crédito (CDS directo o proxy).
- Gráfico de la curva (zero rate y discount factor) que se actualiza al editar.
- Import/export de curvas (JSON/CSV).
- Validación: tenores crecientes, ≥2 puntos.

### 4.3 Cliente (contraparte)
- Formulario: nombre, rating, sector, región, recovery.
- Selector: **CDS directo** (ingresa curva) o **proxy** (rating/sector/región → curva genérica). Si elige proxy, muestra la curva derivada.
- Marca "somos nosotros" (ownParty) para DVA/FBA.
- Lista de contrapartes creadas (editar/eliminar).

### 4.4 Colateral / CSA
- Toggle **CSA global** (a la relación) vs **CSA puntual por operación**.
- Campos: tipo (sin CSA / one-way / two-way), threshold (propio y contraparte), MTA, IM, rounding, divisas elegibles, haircuts, MPOR (días), tasa de remuneración (curva OIS), IM segregado (sí/no).
- Ayudas inline citando el libro (IM ≈ threshold negativo; MTA+threshold aditivos; IM segregado inútil para funding).
- Visual: un diagrama simple de cómo el CSA recorta el perfil de exposición.

### 4.5 Productos
- Alta de operación: producto (CCS UF/CLP en v1), notional, divisa, inicio, vencimiento, dirección, FX UF/CLP fijo, non-deliverable.
- Opción de CSA override puntual (pisa al global).
- Agrupación automática en netting sets por contraparte+CSA; vista del netting set.

### 4.6 Resultados
Tres bloques:
- **Perfiles de exposición**: gráfico EE / ENE / PFE en el tiempo (con y sin colateral, para ver el efecto del CSA/MPR).
- **Waterfall XVA**: barras CVA, DVA, FCA, FBA, MVA, KVA; dos totales separados y claramente rotulados:
  - **XVA económico** `−CVA − FCA + FBA` (pricing; DVA excluido).
  - **XVA contable (IFRS 13)** `−CVA + DVA`.
  Nota visible: "no se suman entre sí; DVA y FBA no se cuentan juntos (doble conteo)".
- **Cobertura**: tabla de griegas + recomendación en lenguaje claro ("comprar/vender vega", "CDS", "DV01 por tramo") con botón "explicar" (regla + capítulo). Ver `HEDGING-STRATEGIES.md`.
- Barra de progreso de la corrida Monte Carlo (Web Worker); config MC editable (paths, grilla, seed) con aviso del trade-off coste/precisión.

## 5. Microcopy / posicionamiento
- Hablar de **valor razonable IFRS 13 / precio de salida teórico**, nunca "precio de liquidación" ni "lo que el banco te debe".
- Tono sobrio, técnico, no comercial agresivo (coherente con SegundaOpinión).
- Mostrar supuestos, no esconderlos.

## 6. Responsive / accesibilidad
- Funciona a ancho de teléfono (gutter 16px, sin scroll horizontal). Tablas con scroll contenido.
- Contraste suficiente del cian sobre near-black; estados de foco visibles.
- Sin font-size < 12px.

## 7. Estados vacíos y errores
- Cada paso con estado vacío que explica qué cargar.
- Validación inline (builder del dominio). El botón "Calcular" se deshabilita si falta lo mínimo, con el motivo.
