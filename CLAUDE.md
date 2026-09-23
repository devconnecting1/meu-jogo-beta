# Project Z

Remake 2D top-down de sobrevivência zumbi (inspirado em Dead Town) para Roblox, em roblox-ts, renderizado 100% em `ScreenGui` (Frames). Cada cliente simula o próprio mundo; o servidor é a fonte da verdade para save, moedas e loja.

## Regras de conteúdo

- Antes de mexer em mapa, sprites, spawns ou UI, siga `docs/DESIGN_RULES.md` (bíblia de ambientação). Regras `[auto]` são checadas por `npm run validate:world`.
- O nosso tem que ser melhor que o original e fazer sentido: copie o que o Dead Town faz bem, corrija o que ele faz mal e documente as exceções.
- UI: cores, fontes e raios só via tema (`design/tweakcn-theme.json` → `npm run theme` → `src/client/ui/themeTokens.ts`). Não rode `npx shadcn` aqui.
- Textos do jogo em inglês via `src/shared/data/lang.ts`.

## Comandos

```bash
npm run build            # rbxtsc
npm run watch            # rbxtsc -w (com `rojo serve` + plugin Rojo no Studio)
npm run lint
npm run format:check
npm run validate:world   # regras [auto] da bíblia de ambientação
npm run check:registers  # limite de 200 locais por chunk do Luau (invisível ao tsc; o cliente não sobe)
npm run theme            # design/tweakcn-theme.json -> src/client/ui/themeTokens.ts (nunca edite o gerado)
npm run locale           # exporta lang.ts para o CSV da tabela de localização do Roblox
npm run art:world        # pixel art da cidade -> design/world-art/*.png + src/client/view/worldArtAssets.ts (gerado)
npm run render:map -- --preset all --out docs/art/after   # a cidade em PNG com o código real (antes/depois: docs/art)
```

**Arte da cidade no jogo (comando do dono, no PC, com o `.env`):** `npm run cloud -- upload-art`, depois `npm run build` e commit de `design/world-art/assets.json` + `src/client/view/worldArtAssets.ts`. Sobe só as texturas novas ou alteradas (Open Cloud Assets API; a chave precisa de `asset:read` + `asset:write` e o `.env` de `ROBLOX_CREATOR_USER_ID` ou `ROBLOX_CREATOR_GROUP_ID`). Sem id, cada superfície continua lisa como antes (`client/view/worldArt.ts`); `-- upload-art --dry-run` lista sem ler chave nenhuma.

Testes em Node rodam o TypeScript real com shims de Luau (`npm run test:<nome>`); rode os da área que você tocou:

- rede e servidor: `net`, `server-sim`, `replication`, `predict`, `input` (fila de input), `smoothness` (aliado desenhado)
- simulação e mundo: `sim`, `ai`, `combat`, `clock`, `life` (dia do mundo × dia de vida), `world` (itens/portas/construção no servidor), `save`, `items` (cada linha de WEAPONS, EQUIPS, USABLES, receitas, SKILLS, loot, pacotes e trajes pelos caminhos reais do cliente e do servidor; os bugs conhecidos aparecem como `BUG [id]` e a suíte falha quando um deles deixa de reproduzir)
- UI e conteúdo: `contrast` (contraste, texto sem contorno e nenhum texto prometendo pausa, em todo `src/`), `backpack` (o Bag não recria Instances), `hud` (o console da HUD: 600 quadros sem criar Instance, hotbar = teclas 1–5, clique = tecla, toque nunca coberto), `menus` (Bag aberto: o mundo segue), `lobby` (menu e tela Survivor da UI-10, a cidade atrás deles sem criar Instance), `cosmetics` (traje e pet desenhados), `flinch` (árvore/carro atingido para de tremer), `world-art` (arte da cidade: sem id é o desenho liso idêntico ao de antes, com id vira textura, sem churn, legibilidade LEG-03, a ferramenta de render), `footsteps`, `chat`
- vida e noite: `body` (o corpo é do servidor: morte, Rebirth, amanhecer, reconexão), `waves` (a horda da noite de ponta a ponta), `reset` (MP-22: todos mortos → o mundo acaba, cidade nova no dia 1, registro do mundo; New game é vida nova, não corpo novo)

O que Node não pega (limite de registradores, asset que não carrega, remote) só aparece no Studio: rode `check:registers` e, com o Studio conectado ao MCP, um playtest.

## Como trabalhamos (nuvem + PC)

Forma híbrida, decidida com o dono em 2026-09-23 — vale para toda sessão, local ou na nuvem:

- **Nuvem = código.** Agentes, compilação, testes, commits e CI rodam numa sessão Claude Code na nuvem, para não travar o PC. Ela trabalha na branch do PR e envia (`git push`).
- **PC = Studio.** O Roblox Studio e o Rojo ficam no PC do dono. Para ver algo no jogo: `git pull` + `npm run build` com `rojo serve default.project.json --port 34872` rodando e o plugin do Rojo conectado; o playtest é feito por uma sessão local, com o MCP do Roblox Studio (a nuvem não alcança MCPs locais).
- **Voltar da nuvem para o PC:** `claude --teleport <id-da-sessão>` no terminal, `/teleport` dentro de uma sessão local, ou em claude.ai/code no menu da sessão → "Open in > Terminal". Precisa de worktree limpo e da branch já enviada; vem a conversa, a branch e o que foi commitado.
- **Agentes:** `.claude/agents/opus-complexo.md` (Opus, raciocínio Extra) para tarefas complexas e `.claude/agents/sonnet-rapido.md` (Sonnet, Extra) para rápidas; no máximo **10** ao mesmo tempo (decisão do dono, 2026-09-23; a nuvem tem 4 núcleos: suítes que medem tempo — `ai`, `server-sim`, `replication`, `input`, `zombie-motion` — rodam uma de cada vez). Agente que **edita código** roda em worktree isolado: começa com `git merge --ff-only <HEAD atual>` (o worktree pode nascer de um commit antigo) e `npm ci --prefer-offline` (nunca uma junção para outro `node_modules`), e commita na própria branch; quem orquestra revisa e faz o merge. Agente só de leitura pode usar a pasta compartilhada.
- **Correção pronta vai direto para o teste do dono** (pedido do dono, 2026-09-23): cada correção verificada vira um PR da branch da sessão para `main` e é mergeada assim que a CI fica verde, sem esperar outro pedido: o dono testa o place que a CI da `main` gera (`ProjectZ-ci.rbxl`, artefato do run em Actions) ou faz `git pull` na `main`. O portão é a publicação, não o merge.
- **Antes de cada merge:** `npx prettier --check <arquivos tocados> --end-of-line auto`, `build`, `lint`, `check:registers` e as suítes da área; um recorte que mistura trabalho de vários agentes é verificado numa cópia isolada. Merge grande (save, economia, rede) passa por revisão independente de correção e de segurança.
- **Apagar um jogador** (wipe ou pedido de exclusão): a chave `<UserId>` sai de `ProjectZ_Save_v2`, `ProjectZ_Save_v1` **e** `ProjectZ_Titles` (os títulos ganhos, MON-05); procedimento em `docs/MULTIPLAYER.md` §6.6.
- **Ferramentas:** Context7 para qualquer dúvida de API do Roblox/roblox-ts (não supor); `gh` para PR e CI (PR #1, com monitor de CI no app); no Studio, antes de testar, instalar `ScriptDebuggerService.OnStopped` nos dois lados (a pausa em exceção está ligada). **Não usar Aikido.** Segredos (a chave do Open Cloud) nunca vão para o git: no PC ficam no `.env`; na nuvem, em claude.ai/code → Cloud Environments → API Credentials.
- **Decisões de produto** estão em `docs/DESIGN_RULES.md` — entre elas UI-04 (texto sem contorno), UI-05, UI-06 (nenhum menu pausa), MP-21/MP-22 (morte e fim do mundo), MON-04 (cosmético aparece) e CON-03 (Núcleo 1). Leia antes de mexer na área.

## Arquitetura (resumo)

- `src/shared/engine`: câmera top-down, renderer com pool de Frames, luz noturna.
- `src/shared/game`: mundo (gerador de cidade, grade espacial), física (`moveActor`, raycast), entidades, save.
- `src/client/systems`: combate, IA dos zumbis (flow field), chefes, spawner, dia/noite, interação, construção, crafting.
- `src/client/ui`: kit de componentes (variantes do shadcn adaptadas ao Roblox) e telas.
- `src/server/main.server.ts`: save validado (UpdateAsync + trava de sessão), economia e loja.
