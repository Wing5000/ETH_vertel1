# Lucky Block — Instant Lottery (Sepolia)

Casino-style dApp UI for the `BlockInstantLottery` contract.

- Connect MetaMask (Sepolia 11155111)
- Play (1 try / address / block), instant result
- Claim pending prizes, fund the pot
- Owner panel to update params

## Quick start

```bash
npm i
npm run dev
```

Open http://localhost:5173 and connect MetaMask (Sepolia).

## Build

```bash
npm run build
```

The static site is in `dist/` — perfect for Vercel/Netlify.

## Configure

- Contract address is set in `src/App.jsx` (`CONTRACT_ADDRESS`).
- Uses ethers v6. RNG uses block data (not secure for big prizes).
