# XVA.cl

Sistema web de valorización **XVA** (CVA · DVA · FVA · MVA · KVA) para derivados OTC, con gestión de colateral/CSA, simulación de exposición por Monte Carlo y recomendación de cobertura. Convierte la metodología de Jon Gregory, _The xVA Challenge_ (3ª ed.), en software.

- **Stack:** TypeScript + React + Vite. Estático, sin backend.
- **Cómputo:** todo en el navegador.
- **Hosting:** GitHub Pages (`Coto-Trader/xva-cl`) vía Cloudflare DNS, servido en **xva.cl**.
- **Identidad:** tema "terminal" cian/near-black (ecosistema SegundaOpinión / TradeAI).

## Para el agente constructor

Empieza por **[AGENTS.md](AGENTS.md)** y sigue el orden de **[docs/ROADMAP.md](docs/ROADMAP.md)**. El quant está en **[docs/XVA-METHODOLOGY.md](docs/XVA-METHODOLOGY.md)**, fiel al libro, con citas por capítulo.

## Desarrollo

```bash
npm install
npm run dev        # servidor local
npm run test       # Vitest
npm run build      # genera dist/ estático
```

## Estructura esperada

```
xva-cl/
├── AGENTS.md
├── README.md
├── docs/                      # especificación (este set)
├── index.html
├── public/
│   ├── CNAME                  # xva.cl
│   └── .nojekyll
├── src/
│   ├── engine/                # motor XVA en TS (curves, credit, exposure, xva, sensitivities, hedging)
│   ├── domain/                # entidades (Counterparty, CSA, Trade, NettingSet, Portfolio)
│   ├── ui/                    # React: wizard, pantallas, design system
│   ├── auth/                  # Google Identity Services
│   └── store/                 # estado (zustand)
└── tests/                     # Vitest, reproducen ejemplos del libro / motor Python
```

## Alcance / posicionamiento

Entrega el **valor razonable IFRS 13 / precio de salida teórico**, no un precio de liquidación. Herramienta de valorización y análisis de cobertura; no ejecuta operaciones ni mueve dinero.

## Referencias

- Jon Gregory, _The xVA Challenge: Counterparty Credit Risk, Funding, Collateral and Capital_, 3ª ed., Wiley 2015.
- Motor de referencia Python: `../XVA-Engine/src/xva_engine/` (solo lectura, no se ejecuta ni se porta literal).
