# Project Z

Sobrevivência zumbi 2D top-down para Roblox, **inspirada em Dead Town**, 100% renderizada em GUI (`ScreenGui`). Código, arte e textos são nossos (`docs/DESIGN_RULES.md` CON-01).

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
