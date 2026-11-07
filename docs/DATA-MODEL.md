# DATA-MODEL — XVA.cl

Entidades del dominio como interfaces TypeScript. Son la **Fase 0** (ver `ROADMAP.md`): todo lo demás se cuelga de aquí. Viven en `src/domain/`, sin dependencias de UI ni motor.

## Enums y tipos base
```ts
export type Currency = 'USD' | 'CLP' | 'UF' | 'EUR';
export type CurveName = 'SOFR' | 'CAMARA_CLP' | 'CAMARA_UF';
export type Rating = 'AAA'|'AA'|'A'|'BBB'|'BB'|'B'|'CCC'|'NR';
export type CSAType = 'NO_CSA' | 'ONE_WAY' | 'TWO_WAY';
export type Direction = 'PAY' | 'RECEIVE';
export type ProductType = 'CCS_UF_CLP' | 'IRS' | 'FX_FORWARD';
```

## Curvas y mercado
```ts
export interface ZeroCurveData {
  name: CurveName;
  tenors: number[];        // años, estrictamente crecientes
  zeroRates: number[];     // tasa cero continua decimal (0.05 = 5%)
}

export interface CreditCurveData {
  // CDS directo cuando existe; si no, se deriva vía proxy (ver ProxyKey)
  tenors: number[];        // años
  cdsSpreads: number[];    // decimal (0.01 = 100 bps)
  recoveryRate: number;    // 0..1
}

export interface ProxyKey {
  rating: Rating;
  sector: string;          // p. ej. 'Corporate', 'Sovereign', 'Bank'
  region: string;          // p. ej. 'Chile', 'LatAm', 'DM'
}

export interface MarketEnv {
  asOf: string;            // ISO date
  curves: Record<CurveName, ZeroCurveData>;
  fxSpot: Record<string, number>;   // p. ej. { 'UFCLP': 37000 }
  fxVol: Record<string, number>;    // vol anualizada por par
  rateVol?: Record<CurveName, number>;
}
```

## Contraparte (cliente)
```ts
export interface Counterparty {
  id: string;
  name: string;
  rating: Rating;
  sector: string;
  region: string;
  recoveryRate: number;           // LGD = 1 - recovery
  // Fuente de crédito: curva CDS directa, O proxy si es ilíquida
  creditCurve?: CreditCurveData;  // si cotiza CDS
  proxyKey?: ProxyKey;            // si no cotiza → mapea a curva genérica
  ownParty?: boolean;             // true = nosotros (para DVA/FBA)
}
```
Regla (Gregory, Cap. 12): si no hay CDS, `proxyKey` es obligatorio; el motor arma la curva genérica por rating/sector/región. Nunca dejar una contraparte sin curva ni proxy.

## CSA / colateral
```ts
export interface CSA {
  id: string;
  scope: 'GLOBAL' | 'TRADE';      // global a la relación, o puntual por operación
  type: CSAType;                  // NO_CSA | ONE_WAY | TWO_WAY
  thresholdOwn: number;           // umbral que nos aplican
  thresholdCpty: number;          // umbral que aplicamos
  mta: number;                    // minimum transfer amount
  initialMargin: number;          // IM (independiente del MTM)
  rounding: number;
  eligibleCcy: Currency[];        // divisas de colateral elegibles
  haircuts: Record<string, number>; // por tipo de colateral
  mporDays: number;               // margin period of risk (días hábiles)
  collateralRate: CurveName;      // tasa de remuneración del colateral (OIS)
  segregatedIM: boolean;          // IM segregado → no reutilizable para funding
}
```
Notas (Gregory): IM ≈ threshold negativo (Cap. 6); MTA y threshold son aditivos (Cap. 6); IM segregado es inútil para funding (Cap. 15); MPOR bilateral ≈ 10 días hábiles, sube en ciertos casos (Cap. 8/11).

## Producto / operación
```ts
export interface TradeBase {
  id: string;
  counterpartyId: string;
  product: ProductType;
  notional: number;
  currency: Currency;
  startDate: string;              // ISO
  maturityYears: number;
  direction: Direction;
  csaOverrideId?: string;         // CSA puntual que pisa al CSA global
}

export interface CCSUFCLPTrade extends TradeBase {
  product: 'CCS_UF_CLP';
  notionalUF: number;
  ufClpFxFixed: number;           // FX UF/CLP fijado
  nonDeliverable: boolean;        // true = liquidación neta (NDS)
}
// IRS, FX_FORWARD se agregan después con la misma base.
```

## Netting set y portafolio
```ts
export interface NettingSet {
  id: string;
  counterpartyId: string;
  csaId: string;                  // CSA global aplicable (puede ser NO_CSA)
  tradeIds: string[];
}

export interface Portfolio {
  counterparties: Counterparty[];
  csas: CSA[];
  trades: TradeBase[];
  nettingSets: NettingSet[];
}
```
**El netting set es la unidad de agregación de todo XVA** (Gregory, Cap. 14: el CVA se calcula al nivel cubierto por los mitigantes). Resolución de CSA por operación: `trade.csaOverrideId ?? nettingSet.csaId`.

## Configuración de simulación
```ts
export interface MonteCarloConfig {
  numPaths: number;        // v1: ≤ 10000
  gridPointsPerYear: number;
  seed: number;            // reproducibilidad
  pathwise: boolean;       // true para path-dependent / colateral
}
```

## Escenario (unidad guardable)
```ts
export interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  market: MarketEnv;
  portfolio: Portfolio;
  mc: MonteCarloConfig;
}
```
Un `Scenario` es lo que se guarda en `localStorage` y se exporta/importa como JSON.

## Builder / repositorio
`src/domain/builder.ts` expone helpers para crear y validar entidades:
```ts
createCounterparty(partial): Counterparty   // valida rating/recovery, exige curva o proxy
createCSA(partial): CSA                      // valida type/threshold/MTA/MPOR
createTrade(partial): TradeBase
buildNettingSets(portfolio): NettingSet[]    // agrupa trades por contraparte+CSA
validatePortfolio(portfolio): ValidationIssue[]
```
Toda entrada de UI pasa por el builder → el motor nunca recibe datos inválidos.
