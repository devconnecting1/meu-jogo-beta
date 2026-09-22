# Project Z

Port 2D top-down de **Dead Town: Zombie Survival** para Roblox, 100% renderizado em GUI (`ScreenGui`).

## Stack

- **roblox-ts** → Luau
- **Rojo** (`default.project.json`)
- **ESLint** + **Prettier**

## Desenvolvimento

```bash
npm ci
npm run build      # rbxtsc
npm run lint
npm run format:check
npm run serve      # rojo serve (sync no Studio)
```

O build roda no **GitHub Actions** (`.github/workflows/ci.yml`): `build` → `lint` → `format:check` → artifact `out/`.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `src/shared` | engine 2D, dados (armas, craft, zombies…), save, net |
| `src/client` | bootstrap, gameLoop, sistemas (combat, spawner, UI…) |
| `src/server` | DataStore save/load |
| `include` | runtime roblox-ts |
