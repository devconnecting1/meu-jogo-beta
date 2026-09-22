# Project Z

Remake 2D top-down de sobrevivência zumbi (inspirado em Dead Town) para Roblox, em roblox-ts, renderizado 100% em `ScreenGui` (Frames). Cada cliente simula o próprio mundo; o servidor é a fonte da verdade para save, moedas e loja.

## Regras de conteúdo

- Antes de mexer em mapa, sprites, spawns ou UI, siga `docs/DESIGN_RULES.md` (bíblia de ambientação). Regras `[auto]` são checadas por `npm run validate:world`.
- O nosso tem que ser melhor que o original e fazer sentido: copie o que o Dead Town faz bem, corrija o que ele faz mal e documente as exceções.
- UI: cores, fontes e raios só via tema (`design/tweakcn-theme.json` → `npm run theme` → `src/client/ui/themeTokens.ts`). Não rode `npx shadcn` aqui.
- Textos do jogo em inglês via `src/shared/data/lang.ts`.

## Comandos

```bash
npm run build          # rbxtsc
npm run watch          # rbxtsc -w (com `rojo serve` + plugin Rojo no Studio)
npm run lint
npm run format:check
npm run validate:world # regras [auto] da bíblia de ambientação
```

## Arquitetura (resumo)

- `src/shared/engine`: câmera top-down, renderer com pool de Frames, luz noturna.
- `src/shared/game`: mundo (gerador de cidade, grade espacial), física (`moveActor`, raycast), entidades, save.
- `src/client/systems`: combate, IA dos zumbis (flow field), chefes, spawner, dia/noite, interação, construção, crafting.
- `src/client/ui`: kit de componentes (variantes do shadcn adaptadas ao Roblox) e telas.
- `src/server/main.server.ts`: save validado (UpdateAsync + trava de sessão), economia e loja.
