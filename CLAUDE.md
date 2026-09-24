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
npm run check:luau       # roda o compilador oficial do Luau (baixado e travado por SHA-256) em out/**/*.luau: os limites reais de carregamento
npm run check:place      # propriedades de place que script não muda (Players.BanningEnabled) fixas no default.project.json
npm run theme            # design/tweakcn-theme.json -> src/client/ui/themeTokens.ts (nunca edite o gerado)
npm run locale           # exporta lang.ts para o CSV da tabela de localização do Roblox
npm run art:world        # pixel art da cidade e atlas dos ícones -> design/world-art/*.png + worldArtAssets.ts e itemIconAtlas.ts (gerados)
npm run render:map -- --preset all --out docs/art/after   # a cidade em PNG com o código real (antes/depois: docs/art)
```

**Arte (e áudio) da cidade no jogo: a CI sobe sozinha.** A cada push na `main` (ou Actions → CI → Run workflow), o job `assets` do `.github/workflows/ci.yml` roda **antes** do place: confere que a arte gerada está commitada (`npm run art:world` + `node tools/assets-ci.mjs drift`), sobe só as texturas novas ou alteradas (`npm run cloud -- upload-art --ci`, Open Cloud Assets API; `upload-audio` também, quando o `cloud.mjs` tiver), espera a moderação (até 10 min) e grava **só id aprovado**; compila e commita `design/world-art/assets.json` + os `.ts` gerados na `main` como `github-actions[bot]` com `[skip ci]` (se a `main` andou no meio: `git pull --rebase`, os módulos gerados refeitos do `assets.json` e mais uma tentativa). O job `build` do mesmo run monta o `ProjectZ-ci.rbxl` **desse** commit: o place do artefato já tem os ids. Upload que falhou ou foi recusado deixa o run vermelho e sem place (os aprovados são commitados mesmo assim). Ainda em análise depois da espera: fica em `pending` no `assets.json` (sem id = a superfície lisa, como antes) e é consultado no próximo run, nunca reenviado; recusado: fica em `rejected` e a CI não reenvia os mesmos bytes (mude o PNG). Sem os secrets o job só avisa e segue. Configuração única do dono: `docs/CREATOR_HUB.md` → "Open Cloud na CI". O comando local continua igual, para subir do PC com o `.env` (a chave com `asset:read` + `asset:write` e `ROBLOX_CREATOR_USER_ID` ou `ROBLOX_CREATOR_GROUP_ID`): `npm run cloud -- upload-art`, `npm run build` e commit dos mesmos arquivos. Sem id, cada superfície continua lisa como antes (`client/view/worldArt.ts`); `-- upload-art --dry-run` lista sem ler chave nenhuma.

Testes em Node rodam o TypeScript real com shims de Luau (`npm run test:<nome>`); rode os da área que você tocou:

- rede e servidor: `net`, `server-sim`, `replication`, `predict`, `input` (fila de input), `smoothness` (aliado desenhado), `zombie-motion` (a horda desenhada: servidor → fio → cliente → câmera → pixel, em link limpo, WAN e quadros do Studio)
- simulação e mundo: `sim`, `ai`, `combat`, `clock`, `life` (dia do mundo × dia de vida), `world` (itens/portas/construção no servidor), `save`, `items` (cada linha de WEAPONS, EQUIPS, USABLES, receitas, SKILLS, loot, pacotes e trajes pelos caminhos reais do cliente e do servidor; os bugs conhecidos aparecem como `BUG [id]` e a suíte falha quando um deles deixa de reproduzir)
- UI e conteúdo: `contrast` (contraste, texto sem contorno e nenhum texto prometendo pausa, em todo `src/`), `backpack` (o Bag não recria Instances), `hud` (o console da HUD: 600 quadros sem criar Instance, hotbar = teclas 1–5, clique = tecla, toque nunca coberto), `menus` (Bag aberto: o mundo segue), `lobby` (menu e tela Survivor da UI-10, a cidade atrás deles sem criar Instance), `tables` (Table e formulários da UI-12 sem churn, nada enviado com campo errado, o admin, o Records e o placar da partida, MP-23), `settings` (cada linha da Settings no seu efeito real: volume dos grupos de som, HUD montada, geometria de toque e preview, cada tecla de `SCHEMES` no bootstrap, Defaults, persistência), `nav` (cada menu abre e fecha sem sobra com o foco do controle, LB / Start pelo menu, teclas do lobby não vazam para a partida, conquistas e recordes, todo texto na `lang.ts` e o CSV do `locale` em dia; bugs só reportados aparecem como CONHECIDO), `cosmetics` (traje e pet desenhados), `flinch` (árvore/carro atingido para de tremer), `awareness` (as marcas dos zumbis — ponto azul, `?` dourado, `!` vermelho: forma e cor, contraste LEG-03 em todo chão e à noite, nunca sobre o sobrevivente, Reduzir Movimento, sem churn; `-- --out <dir>` grava os PNGs), `world-art` (arte da cidade: sem id é o desenho liso idêntico ao de antes, com id vira textura, sem churn, legibilidade LEG-03, a ferramenta de render), `pool` (o pool do renderer, um sub-pool por ZIndex: mesma ordem de desenho, decal que nasce/some custa 1 escrita, andar não escreve ZIndex, nenhuma Instance depois do aquecimento no lobby), `light` (o mapa de luz da noite e o nível de qualidade Auto / High / Low: reescritas de gradiente e alocações por quadro a 1080p no High e no Low contra o antes, o High igual ao de antes com a câmera parada, `lightAt` de acordo com o desenho, o teto do Low sem emenda, a histerese do Auto sem vaivém), `icons` (atlas dos ícones de item: célula = desenho dos Frames, sem id os mesmos Frames de antes, com id um ImageLabel por ícone sem churn, a volta aos Frames), `footsteps`, `chat`
- vida e noite: `body` (o corpo é do servidor: morte, Rebirth, amanhecer, reconexão), `waves` (a horda da noite de ponta a ponta), `reset` (MP-22: todos mortos → o mundo acaba, cidade nova no dia 1, registro do mundo; New game é vida nova, não corpo novo)
- analytics: `analytics` (o servidor real com um AnalyticsService falso: funil de onboarding uma vez e em ordem, eventos de economia que somam cada moeda, nenhum evento por abate, vidas e mundos encerrados uma vez, uma hora de 6 jogadores e uma enxurrada de compras abaixo do limite; catálogo em `docs/ANALYTICS.md`)
- CI e ferramentas: `assets-ci` (o job `assets` offline, contra o Open Cloud falso e repositórios git descartáveis: sem secrets pula sem falhar, moderação em análise espera e vira `pending`, recusado falha e não é reenviado, só id aprovado é gravado mesmo com falha parcial, 429/5xx com backoff, a chave só no `::add-mask::`, o gerador real escreve todo id aprovado, `drift`/`untouched`/`commit` com o rebase quando a `main` anda, e as promessas do `ci.yml`)

O que Node não pega (limite de registradores, asset que não carrega, remote) só aparece no Studio: rode `check:registers` e, com o Studio conectado ao MCP, um playtest.

## Como trabalhamos (nuvem + PC)

Forma híbrida, decidida com o dono em 2026-09-23 — vale para toda sessão, local ou na nuvem:

- **Nuvem = código.** Agentes, compilação, testes, commits e CI rodam numa sessão Claude Code na nuvem, para não travar o PC. Ela trabalha na branch do PR e envia (`git push`).
- **PC = Studio.** O Roblox Studio e o Rojo ficam no PC do dono. Para ver algo no jogo: `git pull` + `npm run build` com `rojo serve default.project.json --port 34872` rodando e o plugin do Rojo conectado; o playtest é feito por uma sessão local, com o MCP do Roblox Studio (a nuvem não alcança MCPs locais).
- **Voltar da nuvem para o PC:** `claude --teleport <id-da-sessão>` no terminal, `/teleport` dentro de uma sessão local, ou em claude.ai/code no menu da sessão → "Open in > Terminal". Precisa de worktree limpo e da branch já enviada; vem a conversa, a branch e o que foi commitado.
- **Agentes:** `.claude/agents/opus-complexo.md` (Opus, raciocínio Extra) para tarefas complexas e `.claude/agents/sonnet-rapido.md` (Sonnet, Extra) para rápidas; no máximo **16** ao mesmo tempo (decisão do dono, 2026-09-23; a nuvem tem 4 núcleos: suítes que medem tempo — `ai`, `server-sim`, `replication`, `input`, `zombie-motion` — rodam uma de cada vez). Agente que **edita código** roda em worktree isolado: começa com `git merge --ff-only <HEAD atual>` (o worktree pode nascer de um commit antigo) e `npm ci --prefer-offline` (nunca uma junção para outro `node_modules`), e commita na própria branch; quem orquestra revisa e faz o merge. Agente só de leitura pode usar a pasta compartilhada.
- **Correção pronta vai direto para o teste do dono** (pedido do dono, 2026-09-23): cada correção verificada vira um PR da branch da sessão para `main` e é mergeada assim que a CI fica verde, sem esperar outro pedido: o dono testa o place que a CI da `main` gera (`ProjectZ-ci.rbxl`, artefato do run em Actions) ou faz `git pull` na `main`. O portão é a publicação, não o merge.
- **Antes de cada merge:** `npx prettier --check <arquivos tocados> --end-of-line auto`, `build`, `lint`, `check:registers` e as suítes da área; um recorte que mistura trabalho de vários agentes é verificado numa cópia isolada. Merge grande (save, economia, rede) passa por revisão independente de correção e de segurança.
- **Apagar um jogador** (wipe ou pedido de exclusão, RTBF): os seis modelos de RTBF do Creator Hub (`ProjectZ_Save_v2`, `ProjectZ_Save_v1`, `ProjectZ_Titles` e as cópias `_studio`, chave `{UserId}`, escopo `global`; checklist em `docs/CREATOR_HUB.md`) apagam sozinhos; para cada pedido da mensagem diária, ou um wipe, com o jogador **fora do jogo** (online: kick e 1 minuto de espera), `npm run cloud -- erase <userId> --yes` (no PC, com o `.env` e a `ROBLOX_ERASE_API_KEY`, só data store; sem `--yes` só mostra o plano, `--dry-run` não lê chave, argumento a mais recusa tudo) apaga as seis chaves e tira as entradas dele do `ProjectZ_AdminLog`. Procedimento em `docs/MULTIPLAYER.md` §6.6.
- **Ferramentas:** Context7 para qualquer dúvida de API do Roblox/roblox-ts (não supor); `gh` para PR e CI (PR #1, com monitor de CI no app); no Studio, antes de testar, instalar `ScriptDebuggerService.OnStopped` nos dois lados (a pausa em exceção está ligada). **Não usar Aikido.** Segredos (a chave do Open Cloud) nunca vão para o git: no PC ficam no `.env`; na nuvem, em claude.ai/code → Cloud Environments → API Credentials; na CI do GitHub, só a chave de assets, em Settings → Secrets and variables → Actions (`ROBLOX_API_KEY` + `ROBLOX_CREATOR_USER_ID`), usada só pelo job `assets` na `main`.
- **Decisões de produto** estão em `docs/DESIGN_RULES.md` — entre elas UI-04 (texto sem contorno), UI-05, UI-06 (nenhum menu pausa), MP-21/MP-22 (morte e fim do mundo), MON-04 (cosmético aparece) e CON-03 (Núcleo 1). Leia antes de mexer na área.

## Arquitetura (resumo)

- `src/shared/engine`: câmera top-down, renderer com pool de Frames, luz noturna.
- `src/shared/game`: mundo (gerador de cidade, grade espacial), física (`moveActor`, raycast), entidades, save.
- `src/client/systems`: combate, IA dos zumbis (flow field), chefes, spawner, dia/noite, interação, construção, crafting.
- `src/client/ui`: kit de componentes (variantes do shadcn adaptadas ao Roblox) e telas.
- `src/server/main.server.ts`: save validado (UpdateAsync + trava de sessão), economia e loja.
