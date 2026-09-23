# Auditoria: APIs do motor Roblox que deveríamos usar e não usamos

Varredura rápida, nova (a tentativa anterior travou e foi descartada). Escopo: `src/{client,server,shared}`,
comparado com:

- Motor (índice): https://create.roblox.com/docs/reference/engine
- Globals (`task`, `tick`, `wait`, `require`...): https://create.roblox.com/docs/reference/engine/globals
- Bibliotecas (`task`, `os`, `string`, `table`, `buffer`, `debug`...): https://create.roblox.com/docs/reference/engine/libraries
- Datatypes (`Vector2`, `Random`, `Rect`, `DateTime`...): https://create.roblox.com/docs/reference/engine/datatypes
- Scripting (visão geral): https://create.roblox.com/docs/scripting

**Achado de fundo, antes de tudo:** boa parte dos módulos em `src/shared/{engine,game,sim,net}` roda em dois
runtimes — Luau no Studio, e um subconjunto reimplementado à mão em JS puro nos harnesses de teste
(`tools/test-*.mjs`, 10 arquivos), porque esses testes transpilam o TypeScript direto para JS e rodam sob
Node — não compilam para Luau nem usam uma VM Luau. Cada arquivo de teste declara à mão os globals que os
módulos sob teste usam (hoje: `math`, `buffer`, `typeIs`, `print`/`warn`, `Array#size()`, `String#size()`, e
um `math.random` seedado — ver achado do `Random`). Qualquer API do motor que os módulos **puros** passem a
usar tem que ganhar um shim igual nesses 10 arquivos, ou os testes quebram. Isso explica de cara vários dos
"não usamos" abaixo (`Vector2`/`Vector3` nativos, `Random.new`, `DateTime`, `Instance`/serviços) — não é
desconhecimento da API, é o preço de rodar puro sob Node. Vou marcar isso em cada achado onde se aplica.

---

## 1. `task`, `os.clock` vs `tick`, `DateTime`

| API | Ganho | Onde | Prioridade | Link |
|---|---|---|---|---|
| `task.cancel` | `src/client/ui/nameplate.ts:204-217` (`pulse()`) agenda `task.delay(FLASH_TIME, …)` e invalida a callback com um contador `pulseGen` (linha 206/211) em vez de cancelar a thread. `task.cancel(thread)` sobre o handle que `task.delay` retorna evitaria manter a callback viva até o timer estourar — hoje ela sempre dispara, só decide não fazer nada. | `src/client/ui/nameplate.ts:210` | Baixa (o padrão atual é correto, só não é o mais direto; nenhum bug) | https://create.roblox.com/docs/reference/engine/libraries/task |
| `task.desynchronize`/`synchronize` | Não há hoje nenhum trabalho pesado por-frame que valha rodar fora do grafo de sincronização do Studio (a simulação já é toda Lua/dados, sem Instances por zumbi). Sem caso de uso identificado agora — ficaria para quando/se houver geração de terreno ou processamento de imagem custoso client-side. | — | — (não aplicável hoje) | https://create.roblox.com/docs/reference/engine/libraries/task |

**Já bem usado:** `os.clock()` é o relógio de tudo que é sessão (rate-limit, TTL de toast, `lastError`,
`credits.day` em `src/server/main.server.ts:192`), e os comentários em `src/server/sim/{zombies,waves,simulation,players,history,progress}.ts`
deixam explícito "no os.clock" nos módulos puros — ele só entra em arquivos client/server-only. `tick()`
global (deprecado a favor de `os.clock`/`task`) não aparece em nenhum lugar — checado.

**`DateTime` — descartado.** Não há nenhuma feature de calendário (reset diário por horário UTC, cooldown que
atravessa a meia-noite real). O "day" de `credits` (`src/server/main.server.ts:192,199`) é tempo de sessão
acumulado (`dt`), não um dia calendário — trocar por `DateTime` não mudaria comportamento nenhum, só
adicionaria uma dependência de tipo do motor (não teria shim nos testes) sem ganho. Link: https://create.roblox.com/docs/reference/engine/datatypes/DateTime

**Deprecados checados, não usados (bom sinal):** `wait()`/`spawn()`/`delay()` globais soltos (pré-`task`) —
zero ocorrências, todo o código já usa `task.wait`/`task.spawn`/`task.delay`/`task.defer`. `ypcall` — zero.

---

## 2. `buffer`

Já é a espinha dorsal do protocolo (`src/shared/net/codec.ts`, `src/shared/net/protocol.ts`,
`src/server/net/replication.ts`) — `create`, `len`, `copy`, `write{u8,i8,u16,i16,u32,f32,f64,string}`,
`read{u8,i8,u16,i16,u32,f32,f64,string}` todos em uso.

| API | Ganho | Onde | Prioridade | Link |
|---|---|---|---|---|
| `buffer.fill` | Zerar/pré-encher a região crescida de `NetWriter.reserve` (`src/shared/net/codec.ts:233-239`, o `buffer.create(grown)` novo) em vez de confiar em `buffer.create` já zerar. Ganho é cosmético — o cursor já limita o que é lido, então bytes "sujos" fora do cursor nunca são expostos. | `src/shared/net/codec.ts:233-239` | Muito baixa | https://create.roblox.com/docs/reference/engine/libraries/buffer |
| `buffer.readbits`/`writebits` | **Checado e descartado.** Os campos de bits do protocolo (`hasBits`/`getBits`/`setBits`, `src/shared/net/codec.ts:154-168`) operam sobre um número já lido inteiro (um `u8`/`u16` completo), não cruzam byte a byte dentro do buffer. `readbits`/`writebits` só valeriam a pena se os campos não fossem alinhados a byte — aqui são, então trocar adicionaria a aritmética de bit-offset do motor pelo mesmo resultado. | `src/shared/net/codec.ts:154-168` | — (descartado) | https://create.roblox.com/docs/reference/engine/libraries/buffer |

---

## 3. `table.clone`, `table.freeze`, `table.move`, `table.create`

**Checado e descartado, com uma ressalva:** `table.insert`/`table.remove`/`pairs` aparecem só 3 vezes no
código (`src/shared/data/sounds.ts:634`, `src/client/admin/patches.ts:33`, `src/client/admin/world.ts:832`) —
roblox-ts prefere `Array.push`/`for...of`, que já compilam para o idioma certo. `table.clone`/`create`/`move`
não têm nenhum shim nos 10 `tools/test-*.mjs` (custo de adoção real: dez arquivos a atualizar) e os laços que
existem (ex.: `FlowField` em `src/shared/game/physics.ts:316-327`, que preenche 4 arrays de 6400 células no
construtor) não são hot-path por-frame — só rodam na criação do campo, então a alocação manual não pesa.

| API | Ganho | Onde | Prioridade | Link |
|---|---|---|---|---|
| `table.freeze` / `table.isfrozen` | Os registros compartilhados (`WEAPONS` em `src/shared/data/weapons.ts:19`, e o mesmo padrão em `zombies.ts`, `shop.ts`, `crafts.ts`...) são `const Array<...>` mas nada impede uma mutação acidental em runtime (ex.: um `sort` ou um `.push` de debug esquecido). `table.freeze` tem shim trivial (`Object.freeze`), então é a única desta lista que vale sem custo real nos testes — mas é defensivo, não corrige um bug visto. | `src/shared/data/weapons.ts:19` (e demais registros de `shared/data/`) | Baixa (defensivo, especulativo — não achei mutação real) | https://create.roblox.com/docs/reference/engine/libraries/table |

**Nota à parte:** `src/shared/game/world.ts:1858` documenta explicitamente por que `table.sort` NÃO é usado
("Luau's table.sort is unstable and would change the town") — usam partição em vez de sort para determinismo
entre Luau e o shim de teste. Isso é uma decisão correta e documentada, não um gap.

---

## 4. `debug.profilebegin`/`profileend`, `debug.traceback`, `debug.info`

| API | Ganho | Onde | Prioridade | Link |
|---|---|---|---|---|
| `debug.profilebegin`/`profileend` | O servidor já mede o tick inteiro (`sim.sample(...)` em `src/server/net/mpHost.ts:396-398`, alimentando `avgMs`/`p95Ms`/`droppedTicks`), mas isso é uma média agregada — não diz SE o gasto é o loop de sobreviventes ou `horde.step()` dentro de `src/server/sim/simulation.ts:205-217`. Rótulos de profiler ali (`"sim.players"`, `"sim.horde"`) apareceriam no Microprofiler do Studio e dariam a um dev a repartição por sistema sem precisar instrumentar de novo. | `src/server/sim/simulation.ts:205-217`, complementando `src/server/net/mpHost.ts:396-398` | Média — útil para depurar os `droppedTicks` que o código já rastreia, mas não é bloqueio | https://create.roblox.com/docs/reference/engine/libraries/debug |
| `debug.traceback` | 41 `pcall(...)` no código (`src/server/main.server.ts:254,293`, `src/server/admin/adminServer.ts:202,465,497`, `src/server/net/mpHost.ts:391`, `src/client/admin/adminClient.ts:341`...), todos guardando `[ok, err]` e só logando a mensagem de erro — nenhum captura a stack. Nos caminhos críticos (save/DataStore em `main.server.ts`, `UpdateAsync` em `adminServer.ts`) trocar `pcall(fn)` por `xpcall(fn, debug.traceback)` custa uma linha e dá stack completa quando um `UpdateAsync` falhar em produção, em vez de só a mensagem. | `src/server/main.server.ts:254`, `src/server/admin/adminServer.ts:202` | Média-alta — é justamente onde a doc de save já é cuidadosa (trava de sessão, retry) e um erro sem stack é o pior momento para faltar contexto | https://create.roblox.com/docs/reference/engine/libraries/debug |
| `debug.info` | Nenhum caso de uso encontrado (não há necessidade de introspecção de função em runtime). | — | — (não aplicável hoje) | https://create.roblox.com/docs/reference/engine/libraries/debug |

---

## 5. `string.pack`/`unpack`

**Checado e descartado.** `src/shared/net/codec.ts` já é construído inteiramente sobre `buffer.*` (o cabeçalho
do arquivo, linhas 1-28, é explícito: "Little-endian, like buffer.*"). `string.pack`/`unpack` produzem uma
STRING formatada por um format-string em runtime; `buffer.*` já dá acesso direto e tipado a cada campo sem
parsear um format-string a cada chamada, e é o que o resto do protocolo (`NetWriter`/`NetReader`) espera
receber/devolver. Trocar seria uma regressão de clareza e de uma camada de parsing extra, não um ganho.
Link: https://create.roblox.com/docs/reference/engine/libraries/string

---

## 6. Tipos subutilizados: `Vector2`/`Vector3` nativos, `Random`, `Rect`, `NumberSequence`

| Tipo | Situação |
|---|---|
| **`Vector2`/`Vector3` nativos (SIMD)** | **Checado e descartado, de propósito.** `src/shared/engine/vec2.ts` reimplementa `{x, y}` como objeto plano com funções `v2add`/`v2sub`/`v2norm`/etc. em vez de `Vector2.new`. Isso é a mesma restrição do topo: `Vector2`/`Vector3` são datatypes do motor sem equivalente nos shims de `tools/test-*.mjs` — usá-los em `shared/game/physics.ts` ou `shared/sim/ai/*` quebraria os testes de física/IA que rodam sob Node (`test-ai.mjs`, `test-sim.mjs`, `test-server-sim.mjs`). O ganho de SIMD do motor também é menor do que parece aqui: a maior parte das operações (`v2add`, `v2sub`, `v2scale`) já usa `out` mutável para não alocar, o que `Vector2` (imutável) não permite de qualquer forma. |
| **`Random`** | **Checado e descartado — é a peça central do determinismo dos testes.** `src/shared/engine/rng.ts` usa `math.random()` global de propósito: os três harnesses de simulação/IA (`tools/test-sim.mjs:285`, `tools/test-ai.mjs:28,43-45`, `tools/test-server-sim.mjs:55-58,97`) SUBSTITUEM `math.random` por um gerador mulberry32 seedado, e os comentários são explícitos ("nothing in the test may depend on math.random", "never math.random" sobre o PRNG determinístico). Isso só funciona porque `math.random` é uma função global que pode ser trocada de fora. Instâncias de `Random.new()` guardam estado privado por objeto — não têm um ponto único para o harness substituir — então adotar `Random` quebraria exatamente a reprodutibilidade que os testes de IA/spawn dependem hoje (fuzz com seed, `--seed` nos três arquivos). |
| **`Rect`** | Já em uso — `src/client/ui/skin.ts:342` (`new Rect(tex.slice[0..3])` para `SliceCenter` do 9-slice da UI, dados vindo de `src/client/ui/skinAssets.ts:8`). Nada a fazer aqui. |
| **`NumberSequence`** | Já em uso — `src/shared/engine/renderer.ts:801-810` e `src/client/ui/hud.ts:774` (gradiente de `UIGradient.Transparency`). Nada a fazer aqui. |

---

## 7. Atributos (`SetAttribute`/`GetAttribute`) e `CollectionService`

**Atributos:** já usados de forma consistente para métricas de servidor (`Workspace.SetAttribute("pz_tick_avg_ms"|"pz_tick_p95_ms"|"pz_sim_players"|"pz_dropped_ticks", ...)` em `src/server/net/mpHost.ts:401-405`), para o flag de admin replicado (`ADMIN_ATTRIBUTE`, `src/client/admin/adminClient.ts:328,336` via `GetAttributeChangedSignal`), e como "estado leve" em Frames de UI (`Variant`/`Disabled`/`Born`/`Pad` em `src/client/ui/widgets.ts`, `src/client/ui/hud.ts:1060-1099`). Não achei um caso óbvio de métrica ou estado faltando — o padrão já cobre bem o que a doc recomenda (dado leve, replicado, sem remoto dedicado).

**`CollectionService` — checado e descartado.** Zero ocorrências. O caso de uso normal (marcar um grupo de
`Instance`s físicas na árvore do jogo — luzes, portas, spawns — e iterar/observar por tag) não se aplica aqui:
o mundo é dado puro (`shared/game/world.ts`, grade espacial), não `Part`s no Workspace, e a única árvore de
`Instance`s real do jogo é a pool de `Frame`s do renderer 2D (`src/shared/engine/renderer.ts`), que já é
gerenciada diretamente pelo pool, não por tag. Não há hoje nenhuma coleção de Instances heterogênea que
precisasse de tag + `GetInstanceAddedSignal`/`GetInstanceRemovedSignal` em vez de uma referência direta.

---

## 8. Depreciações em uso

Nenhuma encontrada. Checados especificamente e ausentes do código: `wait()`/`spawn()`/`delay()` globais
(pré-`task`), `ypcall`, `table.foreach`/`table.foreachi`/`table.getn` (o `table.*` usado é só `pairs`, e nem
isso com frequência — ver seção 3). O código já está na API atual em tudo que toquei.

---

## Resumo por prioridade

- **Média-alta:** `debug.traceback`/`xpcall` nos `pcall` de save/DataStore (`main.server.ts`, `adminServer.ts`) — §4.
- **Média:** `debug.profilebegin`/`profileend` em `simulation.ts`/`mpHost.ts` para repartir o custo do tick — §4.
- **Baixa:** `table.freeze` nos registros de `shared/data/` (defensivo) — §3; `task.cancel` em `nameplate.ts` (cosmético) — §1.
- **Descartado com justificativa própria:** `Random.new` (quebra o determinismo dos testes), `Vector2`/`Vector3` nativos (sem shim, sem ganho real dado o uso de `out` mutável), `DateTime` (sem feature de calendário), `string.pack`/`unpack` (regressão frente a `buffer.*`), `CollectionService` (sem árvore de Instances para taguear), `buffer.readbits`/`writebits` (campos já alinhados a byte).
- **Já em uso, sem gap:** `os.clock`, `task.wait`/`spawn`/`delay`/`defer`, `buffer.*` (o grosso), `Rect`, `NumberSequence`, atributos para métricas/estado de UI.
