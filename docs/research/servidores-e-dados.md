# Auditoria: servidores, matchmaking, dados e jogadores

Escopo: `src/server/main.server.ts`, `src/server/admin/adminServer.ts`, `src/shared/net/mpConfig.ts`,
`src/shared/admin/config.ts`, `src/server/chat/proximityChat.ts`, `src/server/sim/combat.ts`, `tools/`,
`.env.example`, confrontados com `docs/MULTIPLAYER.md` e com:

- Matchmaking: https://create.roblox.com/docs/matchmaking · https://create.roblox.com/docs/matchmaking/scoring ·
  https://create.roblox.com/docs/reference/engine/classes/MatchmakingService
- Teleporte e servidores: https://create.roblox.com/docs/projects/teleporting ·
  https://create.roblox.com/docs/reference/engine/classes/TeleportService ·
  https://create.roblox.com/docs/reference/engine/classes/SocialService ·
  https://create.roblox.com/docs/reference/engine/classes/DataModel ·
  https://create.roblox.com/docs/production/monetization/private-servers
- Dados: https://create.roblox.com/docs/cloud-services/data-stores ·
  https://create.roblox.com/docs/cloud-services/data-stores/player-data-purchasing ·
  https://create.roblox.com/docs/cloud-services/data-stores/error-codes-and-limits ·
  https://create.roblox.com/docs/cloud-services/memory-stores ·
  https://create.roblox.com/docs/cloud-services/data-stores-vs-memory-stores ·
  https://create.roblox.com/docs/reference/engine/classes/DataStoreService
- Jogadores: https://create.roblox.com/docs/players ·
  https://create.roblox.com/docs/reference/engine/classes/Players ·
  https://create.roblox.com/docs/reference/engine/classes/PolicyService
- Open Cloud: https://create.roblox.com/docs/cloud/open-cloud ·
  https://create.roblox.com/docs/cloud/features/luau-execution ·
  https://create.roblox.com/docs/cloud/features/bans-and-blocks

---

## 0. Resumo: o que é bloqueante para lançar

| # | Item | Onde | Bloqueante |
|---|---|---|---|
| B1 | `Players.MaxPlayers = 6` no Creator Dashboard. O código **já assume 6** e não tem nenhuma defesa se o place vier com o default. | `src/shared/net/mpConfig.ts:80` → `src/server/net/interest.ts:20,55,62,80-83`, `src/server/net/replication.ts:17,323` | **Sim**, para `MP_PHASE ≥ 1` |
| B2 | O place de testes tem que ser uma **experiência separada**, não um place dentro da mesma experiência. DataStore é por experiência. | plano em `docs/MULTIPLAYER.md:829` | **Sim** |
| B3 | "Enable Studio Access to API Services" **desligado** na experiência de produção. | configuração, sem código | **Sim** |
| B4 | Escopo de DataStore derivado do ambiente (defesa em profundidade para B2/B3, 1 linha). | `src/server/main.server.ts:163,168`, `src/server/admin/adminServer.ts:144` | Não, mas é barato |
| B5 | `ProjectZ_AdminLog` escreve numa chave única global a cada 30 s **por servidor**. | `src/server/admin/adminServer.ts:39-40,203` | Não hoje; sim se o jogo pegar |
| B6 | `Player:GetNetworkPing()` nunca é chamado — a rebobinagem roda com ping 0. | `src/server/sim/combat.ts:316` vs `src/server/net/mpHost.ts` | Não para o solo; sim para a F2/F6 |
| B7 | `PolicyService.ArePaidRandomItemsRestricted` antes de vender qualquer pack aleatório por Robux. | não existe no código | Não hoje; sim no dia da monetização |

Prioridade dentro do não-bloqueante: B5 > B6 > retry com jitter (§3.4) > filtro indevido no `DisplayReason` (§5.1)
> atributo de matchmaking por dia do mundo (§2.3).

---

## 1. Solo de verdade: qual é o caminho oficial?

**Pergunta:** servidor privado (VIP), `ReserveServer`, `TeleportPartyAsync`, `PrivateServerId` — qual cumpre
"sozinho ou com amigos" sem dividir a comunidade?

### Veredito

**Os dois, em camadas, e nenhum divide a comunidade.**

1. **Servidor reservado** (`TeleportOptions.ShouldReserveServer = true` + `TeleportService:TeleportAsync`) para
   o botão "Play solo". É o que `docs/MULTIPLAYER.md:585-593` (§7.4) já especifica, e está **correto**.
2. **Servidor privado (VIP)**, ligado no Creator Dashboard, para "com amigos" sem escrever código. É o que
   §7.5 (`docs/MULTIPLAYER.md:595-598`) já prevê, e também está correto.
3. `PrivateServerId` **não é um caminho** — é o detector que separa os três modos. §7.4 item 3 já usa a regra
   certa.

**Por quê não divide a comunidade:** a página de matchmaking diz que a etapa de filtragem remove do pool os
servidores "full, private, reserved, or shutting-down". Servidor reservado e VIP **não recebem matchmaking**
por definição — só entra quem tem o código ou o link. O pool público continua sendo um só.

### Detector de modo (confirmado na doc do `DataModel`)

| Modo | `game.PrivateServerId` | `game.PrivateServerOwnerId` |
|---|---|---|
| Público | `""` | `0` |
| Reservado (Play solo) | `≠ ""` | `0` |
| Privado / VIP | `≠ ""` | `≠ 0` (UserId do dono) |

`game.VIPServerId` e `game.VIPServerOwnerId` estão **deprecados** — usar sempre os `PrivateServer*`.
Em Studio, `PrivateServerId` é `""` e `PrivateServerOwnerId` é `0` (mesmo do público), o que confirma a
decisão de §7.4 de trocar o botão por "Play solo (Studio: servidor local)" com `RunService:IsStudio()`.

### Correções e lacunas no plano atual

**a) Métodos deprecados — não usar nenhum deles.** A página de referência de `TeleportService` lista como
deprecados: `Teleport` (cliente), `TeleportAsync`\*, `TeleportPartyAsync`, `TeleportToPrivateServer`,
`TeleportToPlaceInstance`, `TeleportToSpawnByName`, `ReserveServer`, `CustomizedTeleportUI`,
`GetArrivingTeleportGui`.

> \* **Cuidado com essa leitura.** O guia `projects/teleporting` apresenta `TeleportAsync` como *o* método
> moderno e server-only, com exemplo completo, e é ele que a doc manda usar. O agrupamento da página de
> referência é ambíguo. **Veredito: usar `TeleportAsync`**, como §7.4 já faz. O que é inequivocamente
> deprecado e deve ficar fora do código: `TeleportPartyAsync`, `TeleportToPrivateServer`, `ReserveServer`
> (a versão sem `Async`) e o `Teleport` de cliente.

`TeleportPartyAsync` é a resposta errada para "com amigos". O certo é `TeleportAsync(placeId, {p1, p2, ...},
options)` — ele já aceita um array de jogadores.

**b) Falta o `ReserveServerAsync` para "sozinho *ou* com amigos".** Com `ShouldReserveServer = true`, o
servidor é criado no ato do teleporte e o código de acesso **não volta para nós** — um amigo que chegue
depois não tem como entrar. `TeleportService:ReserveServerAsync(placeId)` (não deprecado) devolve
`(accessCode, privateServerId)` **antes** de qualquer teleporte; guardando o `accessCode`, qualquer outro
jogador entra com `TeleportOptions.ReservedServerAccessCode = accessCode`.

- **O que muda no código:** o `server/net/teleport.ts` previsto em `docs/MULTIPLAYER.md:829` (F5) deve ter os
  dois caminhos: `ShouldReserveServer` para o solo puro (descartável) e `ReserveServerAsync` +
  `accessCode` guardado quando o jogador quiser convidar. O `accessCode` é dado efêmero de sessão →
  `MemoryStoreHashMap` com TTL de horas, não DataStore (ver §3.6).
- Link: https://create.roblox.com/docs/reference/engine/classes/TeleportService

**c) Falta o convite nativo.** Para "sozinho ou com amigos" sem depender do VIP pago:

- `SocialService:CanSendGameInviteAsync(player)` → `SocialService:PromptGameInvite(player)` (ambos **cliente**,
  ambos em `pcall`) abrem o convite nativo do Roblox direto do lobby.
- `SocialService:GetPlayersByPartyId(partyId)` (**servidor**, não-yield) e `Player.PartyId` dizem quem já está
  no servidor pelo mesmo grupo. `SocialService:GetPartyAsync(partyId)` devolve `UserId`, `PlaceId`, `JobId`,
  `PrivateServerId` e `ReservedServerAccessCode` — ou seja, a própria Roblox já carrega o access code do grupo.
- **O que muda no código:** nada hoje. Entra na F5, ao lado do botão "Play solo" do `lobby.ts`.
- Link: https://create.roblox.com/docs/reference/engine/classes/SocialService

**d) VIP tem uma restrição que pode surpreender.** A doc de servidores privados é explícita: *"You cannot
enable paid access in Robux or paid access in local currency and private servers at the same time."* Se um
dia o Project Z for um jogo pago, os servidores privados morrem junto. Também: jogadores abaixo de 13 anos
podem ser restringidos por configuração de privacidade. E mudar o preço do servidor privado **cancela todas as
assinaturas ativas**.

- Link: https://create.roblox.com/docs/production/monetization/private-servers

### Prós e contras (veredito comparado)

| | Reservado (`ShouldReserveServer` / `ReserveServerAsync`) | Privado / VIP (Dashboard) |
|---|---|---|
| Custo para o jogador | Zero | Robux/mês, ou grátis se o autor quiser |
| Persistência | Efêmero: fecha quando esvazia | Persistente, com link próprio |
| Convite | Só por código nosso (`accessCode`) ou party | O Roblox cuida: link e lista de convidados |
| Fora do matchmaking | Sim | Sim |
| Trabalho de código | `server/net/teleport.ts` (F5) | Nenhum, só a detecção do modo |
| Encaixe no Project Z | "Play solo" e "jogar com um amigo agora" | "o servidor do meu clã" |

---

## 2. Matchmaking: o que existe e o que faz sentido para 6 jogadores

**Pergunta:** existe `MatchmakingService`? Filas? `SocialService`? O que faz sentido aqui?

### Veredito

**Não construa fila. Ajuste `MaxPlayers` para 6 e deixe o matchmaking da Roblox trabalhar.** A única coisa que
talvez valha depois é publicar **um** atributo de servidor: o dia do mundo.

### 2.1 `MatchmakingService` existe, mas não é o que o nome sugere

É uma classe de engine real (`Not Creatable`, `Not Replicated`), com exatamente três métodos:

- `MatchmakingService:GetServerAttribute(name) → (value, errorMessage)`
- `MatchmakingService:SetServerAttribute(name, value) → (success, errorMessage)`
- `MatchmakingService:InitializeServerAttributesForStudio(dict)` — só para testar em Studio

Ele **não enfileira, não pareia e não teleporta**. Ele publica atributos do servidor para o algoritmo de
scoring que roda **fora do jogo**, configurado no Creator Hub. Quem decide o pareamento é a Roblox.

- Link: https://create.roblox.com/docs/reference/engine/classes/MatchmakingService

### 2.2 Os pesos padrão já resolvem um co-op de 6

Sinais e pesos padrão (doc de scoring):

| Sinal | Peso |
|---|---|
| Friends | **15** |
| Latency | 3 |
| Text Chat | 3 |
| Occupancy | 2 |
| Play History | 2 |
| Language | 2 |
| Age | 1 |
| Voice Chat | 1 |
| Device Type | 0 |

A doc diz, literalmente, que o peso de *Friends* é maior que a **soma de todos os outros**. Ou seja: "cair no
servidor do amigo" já funciona sem nós escrevermos uma linha. `Occupancy` (peso 2) prefere servidor
parcialmente cheio a servidor vazio — com `MaxPlayers = 6` isso é exatamente o comportamento desejado num
co-op: o 2º jogador entra onde já tem alguém, em vez de abrir um mundo vazio.

- Link: https://create.roblox.com/docs/matchmaking/scoring

### 2.3 O único atributo customizado que vale aqui: o dia do mundo

`docs/MULTIPLAYER.md:947` (decisão do autor, item 5) diz que **servidores públicos começam no dia 1**. Isso
é uma decisão de balanceamento, mas não impede um jogador de entrar num servidor público que já está no dia
40 — e levar uma horda de dia 40 na cara no primeiro minuto (S(k) e a curva de dificuldade escalam com o dia).

- **Veredito:** publicar `MatchmakingService:SetServerAttribute("WorldDay", day)` a cada virada de dia e
  registrar um sinal numérico no Creator Hub agrupa jogadores em dias parecidos. Atributo **numérico**
  (a doc distingue numérico — proximidade — de categórico — coincidência), que é o caso.
- **O que muda no código:** uma chamada no lugar onde o host avança o dia do mundo (subsistema de dia/noite
  do servidor, F2+). `InitializeServerAttributesForStudio({WorldDay = 1})` permite testar em Studio.
- **Prioridade:** Média, **pós-F5**. Não é bloqueante: com o jogo pequeno, quase todo servidor novo está em
  dia baixo.

### 2.4 `MaxPlayers` é o bloqueante real (B1)

`Players.MaxPlayers` é **somente leitura** em script (doc de `Players`) — só se ajusta no Creator Dashboard.
`Players.PreferredPlayers` também é somente leitura, e não é usado no projeto.

O problema concreto: `src/shared/net/mpConfig.ts:80` define `MAX_PLAYERS = 6` e esse valor **dimensiona
estruturas**, não é decoração:

- `src/server/net/interest.ts:20,55,62,80-83` — tabela de interesse por slot
- `src/server/net/replication.ts:17,323` — rotação do índice de snapshot
- `src/server/net/mpHost.ts:427` — só loga (`"${MAX_PLAYERS} slots"`)

Não existe nenhuma escrita em `Players.MaxPlayers`, nenhuma rejeição em `PlayerAdded` por lotação, e o valor
real da plataforma só é **lido** em `src/server/admin/adminServer.ts:601` (`maxPlayers: Players.MaxPlayers`)
para exibir no painel. Se o place for publicado com o default da plataforma, o 7º jogador entra e não há slot.

- **O que muda no código:** uma asserção no boot do host (`src/server/net/mpHost.ts`), algo como
  `if (Players.MaxPlayers > MAX_PLAYERS) warn/error` — barato, e transforma um erro de configuração
  silencioso num erro visível. A configuração em si é manual, e já está listada como ação do autor em
  `docs/MULTIPLAYER.md:829`.
- **Prioridade: bloqueante para `MP_PHASE ≥ 1`.**

### 2.5 O que foi avaliado e descartado aqui

- **Fila via `MemoryStoreQueue`**: a doc de memory stores lista "skill-based matchmaking" como caso de uso de
  queue — mas isso é para o padrão lobby → partida, com pareamento explícito. No Project Z não há partida: o
  mundo é persistente *por servidor* e o jogador entra e sai dele. Construir fila seria reimplementar pior o
  que a Roblox já faz. **Descartado.**
- **`SocialService` como matchmaking**: party é "entrar com quem eu escolhi", não pareamento. Entra em §1c,
  não aqui. **Descartado como matchmaking, aprovado como convite.**
- **Lista de servidores própria** (`MessagingService` + browser): §3.7.

---

## 3. Save v3 e concorrência

**Pergunta:** a trava é `UpdateAsync` + token. O que a doc recomenda hoje? MemoryStore entra? Que limites
encostamos com 6 jogadores e save periódico?

### Veredito

**A trava atual está certa na essência e é melhor que a média do ecossistema. Três ajustes valem a pena,
nenhum é bloqueante. MemoryStore não entra na trava — entra em outras três coisas.**

### 3.1 O que a doc oficial recomenda, e o que já fazemos

O guia canônico é `cloud-services/data-stores/player-data-purchasing`, com o
`SessionLockedDataStoreWrapper`. Comparação item a item:

| Recomendação da doc | Nosso código | Status |
|---|---|---|
| Trava escrita **atomicamente no mesmo `UpdateAsync`** que lê o dado | `loadWithLock`, `src/server/main.server.ts:246-284` | ✅ |
| GUID de trava guardado em memória e verificado antes de cada escrita | `s.sid` (`main.server.ts:453`), checado em `writeWithLock` (`main.server.ts:296`) → `lost` | ✅ |
| Tomada de trava alheia só após o *lock expiry* | `LOCK_STALE = 300` (`main.server.ts:66`), aplicado em `main.server.ts:262` | ✅ |
| Renovar a trava pelo laço de autosave | `LOCK_REFRESH = 150` (`main.server.ts:67`), `main.server.ts:324-325` | ✅ |
| Erro de leitura → perfil "errored", **nunca** escrever por cima | `main.server.ts:408-427` (status `"error"`, sessão read-only) e `persists()` em `main.server.ts:183-185` | ✅ (exemplar) |
| Salvar em paralelo no `BindToClose` | `main.server.ts:813-829`, orçamento de 25 s (`SHUTDOWN_BUDGET`, `main.server.ts:59`) | ✅ (a doc cita 30 s de limite de plataforma) |
| Salvar ao sair e liberar a trava | `PlayerRemoving` → `flush(s, true)`, `main.server.ts:800-811` | ✅ |
| Fila serializada por chave | `s.writing` + `waitUntil` em `flush` (`main.server.ts:322`) | ✅ (equivalente para 1 chave/sessão) |
| Retry **5 tentativas, base 2 s, teto 32 s, com jitter aleatório** | `RETRY_DELAYS = [1, 2, 4]`, 4 tentativas (`main.server.ts:57`) | ⚠️ ver §3.4 |
| Autosave a cada **180 s**, com o primeiro desalinhado por `math.random() * intervalo` | `AUTOSAVE_INTERVAL = 60` (`main.server.ts:55`), todos na mesma volta do laço | ⚠️ ver §3.5 |

- Link: https://create.roblox.com/docs/cloud-services/data-stores/player-data-purchasing

### 3.2 Diferença de desenho (não é erro): trava no valor, não nos metadados

A doc põe o `LockId` nos **metadados** da chave (`DataStoreSetOptions:SetMetadata`). Nós pomos no **valor**:
`StoredDoc { data, lock }` em `src/server/main.server.ts:157-160`.

Consequência real, e vale registrar como exceção documentada:

1. `data` e `lock` dividem o limite de **4.194.304 caracteres por chave**.
2. Toda renovação de trava reescreve o save inteiro — `main.server.ts:326` sempre faz
   `HttpService.JSONEncode(s.save)`, mesmo quando só o `lock.t` mudou (`main.server.ts:324-325`, caminho
   `refreshDue` sem `dirty`).

Com o save de hoje isso é irrelevante. Se o save crescer (construções por jogador, por exemplo), cada
renovação de trava passa a custar o tamanho do save contra o teto de **4 MB/min de escrita por chave**.

- **O que muda:** nada agora. Um comentário em `main.server.ts:157-160` explicando a escolha e o gatilho
  ("se o save passar de X KB, mover a trava para metadados").
- Link: https://create.roblox.com/docs/cloud-services/data-stores/error-codes-and-limits

### 3.3 Limites com 6 jogadores: a conta exata

Limites por servidor, por minuto (doc de error-codes-and-limits):

| Tipo | Data store padrão | Com 6 jogadores |
|---|---|---|
| Leitura | `60 + jogadores × 40` | **300** |
| Escrita | `60 + jogadores × 40` | **300** |
| Listagem | `5 + jogadores × 2` | 17 |
| Remoção | `60 + jogadores × 40` | 300 |

Por experiência: leitura `300 + CCU × 40`, escrita `300 + CCU × 20`.
Por chave, janela móvel de 60 s: **leitura 25 MB/min, escrita 4 MB/min**.
Tamanho: nome da store ≤ 50 chars, escopo ≤ 50 chars, chave ≤ 50 chars, valor ≤ **4.194.304** chars.

**Nosso consumo, em regime permanente com 6 jogadores:**

- 6 sessões × 1 `UpdateAsync`/min (autosave de 60 s) = **6 requisições/min**. `UpdateAsync` conta contra
  leitura *e* escrita.
- Entrada: 1 `UpdateAsync` (`loadWithLock`) + eventualmente 1 `GetAsync` no store v1 (`readLegacy`,
  `main.server.ts:376`).
- Saída: 1 `UpdateAsync` com `release`.
- Log de admin: 1 `UpdateAsync` a cada 30 s = 2/min.
- **Pior caso realista** (os 6 entram e saem no mesmo minuto + autosave + audit): ~26/min contra 300.

**Veredito: folga de mais de 10×. Não encostamos em nada.** O guarda `AUTOSAVE_MIN_BUDGET = 4`
(`main.server.ts:63`, checado em `main.server.ts:841-842` via
`GetRequestBudgetForRequestType(Enum.DataStoreRequestType.UpdateAsync)`) está correto e é barato, mas na
prática nunca dispara com 6 jogadores. Manter — ele existe para o caso de a store ficar lenta e as
requisições se acumularem, não para a cota.

**Uma observação sobre o teto por chave:** cada jogador tem a própria chave (`s.key = tostring(UserId)`,
`main.server.ts:452`), então é 1 escrita/min por chave. Mas `MAX_STORED_LENGTH = 3900000`
(`main.server.ts:61`) está deliberadamente logo abaixo dos 4 MB do valor — e o teto de escrita por chave é
**4 MB/min**. Ou seja: **com um save no teto, uma única escrita já consome a cota de escrita daquele minuto
inteiro para aquela chave.** Não é um bug (nenhum save chegará perto disso), mas é a razão para tratar
`MAX_STORED_LENGTH` como um sinal de alarme, não como um limite operacional.

### 3.4 Retry: falta jitter (prioridade média-baixa)

Temos `RETRY_DELAYS = [1, 2, 4]` (`main.server.ts:57`), 4 tentativas, e `SHUTDOWN_RETRY_DELAYS = [0.5, 1]`
(`main.server.ts:58`) para o desligamento. A doc pede **exponencial com jitter aleatório** e 5 tentativas,
explicitamente para evitar *thundering herd*:

```lua
local backoff = math.min(MAX_DELAY, BASE_DELAY * (2 ^ (attempt - 1)))
local jitter = math.random() * backoff
task.wait(math.min(MAX_DELAY, backoff + jitter))
```

Com 6 jogadores num servidor, a diferença é ruído. Ela aparece quando a DataStore tem um incidente e **todos
os servidores do universo** repetem em cadência idêntica. Custo da correção: somar `math.random() * delay` em
`main.server.ts:281` e `main.server.ts:311`.

- **Prioridade:** Baixa-média. Não bloqueante.

### 3.5 Autosave: 60 s contra os 180 s da doc, e o desalinhamento

`AUTOSAVE_INTERVAL = 60` (`main.server.ts:55`) é **3× mais agressivo** que o padrão da doc. Isso é uma escolha
defensável — a folga de cota é enorme (§3.3) e save mais fresco é save menos perdido — mas convém registrar
como exceção consciente em vez de deixar parecer descuido.

O detalhe que a doc pede e nós não fazemos: **desalinhar o primeiro save** (`task.wait(math.random() *
AUTO_SAVE_INTERVAL)` antes de entrar no laço). Nós rodamos um laço global a cada 60 s
(`main.server.ts:831-847`) que percorre todas as sessões com `task.wait(0.2)` entre elas — funciona como um
desalinhamento pobre dentro da volta, mas o **pulso** continua sendo um só, a cada 60 s, e todos os
servidores do universo que subiram juntos pulsam juntos.

- **O que muda:** ou desalinhar por sessão (um laço por jogador, como a doc mostra), ou somar um
  `math.random() * AUTOSAVE_INTERVAL` inicial ao laço global em `main.server.ts:831`. O segundo é uma linha.
- **Prioridade:** Baixa.

Coerência das constantes, que está certa e vale registrar: `AUTOSAVE_INTERVAL = 60` <
`LOCK_REFRESH = 150` < `LOCK_STALE = 300` dá 2-3 voltas de folga entre uma renovação perdida e a trava ficar
tomável por outro servidor. `LOCK_WAIT = 15` (`main.server.ts:69`) cobre o caso de o servidor de origem ainda
estar escrevendo o último save — que é exatamente o cenário do teleporte para o servidor solo (§1).

### 3.6 MemoryStore entra? Para a trava, não. Para três outras coisas, sim

**Para a trava de sessão: não.** A doc de `data-stores-vs-memory-stores` é clara: memory stores guardam dado
**efêmero** (TTL padrão de 45 dias, máximo 45 dias), data stores guardam o que precisa durar. Session locking
é apresentado como padrão de DataStore, e `UpdateAsync` no DataStore já é atômico — é o que nos dá a garantia.
Trocar por MemoryStore acrescentaria um sistema que **expira** para proteger um dado que precisa ser durável.
**Descartado.**

**Onde MemoryStore encaixa de verdade** (nenhum é bloqueante; nada disso existe no código hoje —
`MemoryStoreService` não aparece em `src/`):

1. **`ReservedServerAccessCode` por sessão** (§1b) — `MemoryStoreHashMap`, TTL de algumas horas. É o que
   permite "convidar amigo para o meu servidor solo". Dado por definição descartável.
2. **Lista de servidores por faixa de dia do mundo** — já está registrado como ideia em
   `docs/MULTIPLAYER.md:535` ("lista de servidores por faixa de dia via MemoryStore/MessagingService").
   `MemoryStoreSortedMap` é o encaixe (ordenado por dia).
3. **Log de admin** — ver §3.7.

**Cotas de MemoryStore** (nível de experiência): memória `64 KB + 1,2 KB × CCU`; requisições
`1.000 + 120 × CCU` unidades/min; por estrutura, 1 M itens e 100 MB. `UpdateAsync` custa no mínimo 2 unidades;
`GetRangeAsync`/`ReadAsync` cobram por item devolvido. Para um access code por jogador, é de sobra — mas note
que com CCU baixo a memória total é de **64 KB + uns poucos KB**: não dá para guardar estado de mundo ali.

- Link: https://create.roblox.com/docs/cloud-services/memory-stores

### 3.7 A chave quente do log de admin (B5)

`src/server/admin/adminServer.ts:39-40`:

```ts
const AUDIT_STORE = "ProjectZ_AdminLog";
const AUDIT_KEY = "recent";
```

Todo servidor do universo escreve **na mesma chave**, via `store.UpdateAsync(AUDIT_KEY, ...)`
(`adminServer.ts:203`), a cada `AUDIT_FLUSH_INTERVAL = 30` s (`adminServer.ts:44`), reescrevendo até
`AUDIT_STORED = 300` entradas (`adminServer.ts:43`), mais um flush final no `BindToClose`
(`adminServer.ts:257`).

É o único lugar do projeto onde o desenho não escala. Com 20 servidores ativos são 40 escritas/min numa chave
única, cada uma carregando o documento inteiro — e o limite é **4 MB/min por chave**, além de o
`UpdateAsync` concorrente entre servidores virar disputa (a doc chama isso de conflito e recomenda backoff
exponencial, não laço de repetição).

- **Veredito:** trocar a chave única por uma chave particionada. Em ordem de esforço:
  1. `"recent:" .. os.date("!%Y-%m-%d")` — uma chave por dia UTC. Uma linha, resolve a concorrência quase
     toda, o painel lê as 2 últimas chaves.
  2. `"recent:" .. JOB_ID` — uma chave por servidor. Sem nenhuma disputa, mas o painel precisa de
     `ListKeysAsync` para juntar (e listagem tem cota bem menor: `5 + jogadores × 2`/min).
  3. `MemoryStoreSortedMap` ordenado por timestamp — é literalmente o caso de uso que a doc descreve
     ("high throughput, low latency, ephemeral"), mas perde o histórico além do TTL.
- **Prioridade:** Média. Não bloqueia lançar com poucos servidores; vira problema real se o jogo crescer.
  Recomendo a opção 1 antes do lançamento — é uma linha.

### 3.8 O que foi avaliado e descartado em dados

- **`OrderedDataStore`**: não existe no código e não há caso de uso — não temos ranking global persistente.
  `bestDay` é pessoal. Se um dia houver leaderboard de recorde, é aqui. **Descartado por falta de caso.**
- **`DataStoreOptions` / versionamento / `ListKeysAsync`**: a doc diz que data stores padrão guardam versões
  anteriores por **30 dias** automaticamente — isso já nos dá recuperação de save corrompido sem escrever
  código. Vale saber que existe; não vale instrumentar agora. **Descartado (já vem de graça).**
- **`MessagingService`**: nenhum uso no projeto. Com um mundo por servidor e 6 jogadores, não há nada para
  coordenar entre servidores. O único uso plausível é anúncio global ou lista de servidores (a doc cita
  "server browser atualizado a cada minuto, no máximo 20 servidores"). As páginas que li (`MessagingService`
  e `cross-server-messaging`) **não publicam a tabela de limites** — se um dia formos usar, é preciso achar a
  cota antes. **Descartado por ora.**
- **`BatchGetAsync`**: existe e cada chave conta como uma leitura. Sem uso aqui (1 chave por jogador, lidas em
  momentos diferentes). **Descartado.**

---

## 4. Separar teste de produção

**Pergunta:** nossos DataStores têm nome fixo. Qual o padrão oficial — `RunService:IsStudio()`,
`game.PlaceId`, escopos?

### Veredito

**O plano da F5 tem um erro que custa o save de todo mundo, e a defesa no código custa uma linha.**

### 4.1 O erro: "place de testes" não separa nada

`docs/MULTIPLAYER.md:829` (F5, ação manual do autor) manda "criar o place de testes 'Project Z [dev]'". A doc
de data stores é explícita:

> "Data stores are consistent per game, so any place in a game can access and change the same data, including
> places on different servers."

**DataStore é por experiência (universo), não por place.** Um place de teste *dentro da mesma experiência*
escreve no mesmo `ProjectZ_Save_v2`. Um bug no build de dev apaga o save de produção.

O padrão oficial é **uma experiência separada**. A própria doc, ao falar de "Enable Studio Access to API
Services", diz:

> "Studio accesses the same data stores as the client application. To avoid overwriting production data, do
> not enable this setting for live games. Instead, enable it for a separate test version."

- **O que muda:** `docs/MULTIPLAYER.md:829` precisa dizer *experiência* de testes, não *place*. É configuração,
  não código — mas é **B2, bloqueante**.
- Link: https://create.roblox.com/docs/cloud-services/data-stores

### 4.2 A defesa em profundidade: o escopo de `GetDataStore` (B4)

`DataStoreService:GetDataStore(name, scope, options)` — o segundo parâmetro é o **escopo**, default
`"global"`. Ele entra na composição da chave, então trocar o escopo isola completamente os dados.

Hoje nenhuma das três chamadas passa escopo:

- `src/server/main.server.ts:163` — `GetDataStore(DATA_STORE_NAME)` → `"ProjectZ_Save_v2"` (`main.server.ts:50`)
- `src/server/main.server.ts:168` — `GetDataStore(LEGACY_STORE_NAME)` → `"ProjectZ_Save_v1"` (`main.server.ts:52`)
- `src/server/admin/adminServer.ts:144` — `GetDataStore(AUDIT_STORE)` → `"ProjectZ_AdminLog"` (`adminServer.ts:39`)

**Veredito:** derivar o escopo do ambiente. Melhor do que `RunService:IsStudio()` sozinho (que não protege um
place de dev publicado) é uma allowlist de `game.PlaceId` — o id de produção é fixo, e qualquer outro cai num
escopo de dev. `game.PlaceId` já é lido em `adminServer.ts:596`, então o valor está à mão.

Esboço (uma constante nova em `shared/`, usada nos três pontos):

```ts
// produção continua em "global" — MUDAR O ESCOPO DE UM SAVE EXISTENTE PERDE O SAVE
const PROD_PLACE_ID = 0; // preencher com o id do place publicado
export const STORE_SCOPE = game.PlaceId === PROD_PLACE_ID ? "global" : "dev";
```

**A regra que não pode ser quebrada:** produção sempre em `"global"`. O escopo faz parte da chave; mover o
escopo de produção para outro valor torna todos os saves existentes invisíveis.

- **Prioridade:** não bloqueante por si, mas é a rede de segurança de B2 e B3, e custa uma linha por chamada.
- Link: https://create.roblox.com/docs/reference/engine/classes/DataStoreService

### 4.3 `RunService:IsStudio()` está certo onde está — e não é a separação

Ocorrências atuais, todas corretas e todas de **mensagem/UX**, nenhuma decidindo qual store é usada:

| Arquivo:linha | Para quê |
|---|---|
| `src/server/main.server.ts:417` | Em Studio, falha de leitura vira `"unavailable"` (joga em memória) em vez de `"error"` (read-only) |
| `src/server/admin/adminServer.ts:232` | Status do log de auditoria ("indisponível em Studio") |
| `src/server/admin/adminServer.ts:345` | Dica de erro da Ban API (em Studio precisa de place publicado) |
| `src/server/admin/adminServer.ts:598` | Campo `studio` do `serverInfo` do painel |

`main.server.ts:71` também merece nota: `JOB_ID = game.JobId !== "" ? game.JobId : "studio-" + GUID` — um
JobId sintético para Studio, onde `game.JobId` é vazio. É o tipo de detalhe que evita que a trava de sessão
se comporte de forma estranha em playtest. Correto.

`RunService:IsServer()` / `IsRunMode()`, `game.GameId`, `game.PrivateServerId`, `game.PrivateServerOwnerId`:
**nenhuma ocorrência em `src/`** — todos só aparecem na especificação da F5 em `docs/MULTIPLAYER.md`.

---

## 5. Jogadores: `BanAsync`, `PolicyService`, `UserService`, `GetNetworkPing`

### 5.1 `Players.BanAsync` — está certo, com uma ressalva

**Veredito: sim, está certo, e está acima da média.** `src/server/admin/adminServer.ts:465-473` passa o
conjunto completo de campos documentados:

```ts
Players.BanAsync({
    UserIds: [userId],
    Duration: duration,
    DisplayReason: displayReason,
    PrivateReason: privateText,
    ApplyToUniverse: req.applyToUniverse as boolean,
    ExcludeAltAccounts: req.excludeAlts as boolean,
})
```

E o resto do ciclo também usa a API nativa, sem DataStore paralelo:
`Players.UnbanAsync({ UserIds, ApplyToUniverse })` em `adminServer.ts:498` e
`Players.GetBanHistoryAsync(...)` em `adminServer.ts:512` (paginado com
`GetCurrentPage`/`AdvanceToNextPageAsync`). Todos os três exigem a capability `Players, Consequences` e são de
servidor.

Três observações:

**a) ⚠️ `DisplayReason` passa por `TextService:FilterStringAsync` — provavelmente errado.**
`adminServer.ts:452` faz `filterText(display, caller)` antes de montar o `displayReason`. A doc **não pede
isso**. `DisplayReason` é texto do criador exibido ao banido, não conteúdo de usuário sendo distribuído a
terceiros. O filtro de texto do Roblox pode transformar um motivo legítimo ("cheating: speed exploit",
"duping") em hashtags, e aí o banido recebe uma mensagem ilegível. Há um fallback
(`adminServer.ts:453-456`: se o filtro devolver vazio, usa a mensagem genérica), o que evita o pior caso, mas
não o caso médio.
- **O que muda:** reavaliar `adminServer.ts:452`. O `PrivateReason` (`adminServer.ts:458-464`), que é interno
  e nunca chega a jogador nenhum, corretamente **não** é filtrado.
- **Prioridade:** Baixa, mas é um erro real de leitura da doc.

**b) O `Kick` de garantia é redundante, mas inofensivo.** `adminServer.ts:482-487` faz
`task.delay(1, () => online.Kick(displayReason))` depois do ban. A doc diz que `BanAsync` já remove o jogador
online. Manter como defesa, documentar como exceção consciente.

**c) A doc não publica limites.** Nenhuma das páginas que li (`players`, `Players`) informa máximo de `UserIds`
por chamada, tamanho máximo de `DisplayReason`/`PrivateReason`, nem o valor de duração para banimento
permanente. Como banimos um por vez e já temos limites próprios (`ADMIN_LIMITS.DISPLAY_REASON` /
`PRIVATE_REASON`, aplicados em `adminServer.ts:443-448`), não encostamos em nada. **Não vou afirmar limites
que a doc não publica.**

### 5.2 `PolicyService` — não usamos, e hoje isso está ok (mas vira dívida na monetização)

`GetPolicyInfoForPlayerAsync` **não é chamado em lugar nenhum** de `src/`.

O que a página de `PolicyService` que consegui ler documenta de fato: `CanViewBrandProjectAsync(player,
brandProjectId)` (servidor) e `GetPolicyInfoForPlayerAsync(player)`, citando os campos
`ArePaidRandomItemsRestricted` e `IsEligibleToPurchaseCommerceProduct`. **Os outros campos que eu esperava
(`AllowedExternalLinkReferences`, `IsSubjectToChinaPolicies`, `IsPaidItemTradingAllowed`) não aparecem na
página atual** — não vou afirmar que existem.

Impacto real no Project Z:

- **Loja: 100% moeda interna.** Não há `MarketplaceService`, gamepass, developer product ou
  `PromptPurchase` em nenhum lugar de `src/` (busca vazia). `SHOP_PACKS`, `COSTUMES` e `rebirthPrice`
  (`src/shared/data/shop.ts`, importados em `main.server.ts:12`) movem só o `money` do save, ganho no jogo.
  Portanto `ArePaidRandomItemsRestricted` **não nos afeta hoje**: a regra é sobre itens aleatórios **pagos**.
  **No dia em que um pack aleatório for vendido por Robux, checar essa política vira obrigação** — é a regra
  de loot box. Registrar agora, aplicar antes da monetização. **(B7)**
- **Chat: coberto pelo `TextChatService`.** `src/server/chat/proximityChat.ts:45-46,53` pega o canal
  `RBXGeneral` e instala `ShouldDeliverCallback`, delegando a decisão de alcance para `shouldDeliver` de
  `shared/chat/chatRules.ts` (`proximityChat.ts:58-61`). A filtragem de texto e as restrições por idade/região
  são responsabilidade do próprio `TextChatService` — não precisamos de `PolicyService` para isso. ✅
- **Links externos:** não há link para Discord/YouTube/qualquer coisa na UI. Sem exposição.

### 5.3 `UserService` — descartado por falta de caso de uso

Não aparece no índice de classes sob nenhum dos termos que consultei; o que existe é o **tipo** `User`,
usado nas assinaturas de `Players` (`GetBanHistoryAsync(userId: User)`). Não mostramos perfil de terceiros, e
`Players:GetNameFromUserIdAsync` já cobriria o caso de resolver nome. O painel de admin usa
`ADMIN_LABELS` (`src/shared/admin/config.ts:15`) para exibir. **Descartado.**

### 5.4 `Player:GetNetworkPing()` — pendência concreta (B6)

**Não é chamado em lugar nenhum**, e isso não é uma opinião — é um gancho que ficou solto:

- `src/server/sim/combat.ts:316` define `setPing(slot, seconds)`, que clampa em 1 s e alimenta `pingS`.
- `src/server/sim/combat.ts:46` e `src/server/sim/history.ts:173` documentam que o host deve chamar
  `combat.setPing(slot, ms/1000)` de onde já lê `Player:GetNetworkPing()`.
- `src/server/net/mpHost.ts` **nunca chama `setPing`**.

Consequência: a rebobinagem de 300 ms prometida em `docs/MULTIPLAYER.md` §14.1 roda hoje com ping 0 para todo
mundo — ou seja, sem compensação de lag nenhuma.

Nota sobre a duplicação aparente: já existe um medidor de RTT próprio em `src/client/net/clockSync.ts`
(probe `TimePing`/`TimePong`, respondido pelo servidor em `mpHost.ts:326-359`, suavizado por média móvel
α=0.1). **Não é redundante:** o probe próprio mede o atraso *de aplicação* e serve ao relógio suavizado
(`CLOCK_MAX_RATE = 0.05`, `CLOCK_SNAP_S = 0.5`); `GetNetworkPing()` é a medida da engine, do lado do servidor,
mais barata e mais adequada como teto de rebobinagem. Usar os dois, cada um no seu papel.

- **Prioridade:** Alta dentro da F2/F6. Não bloqueia o lançamento solo (`MP_PHASE = 0`).

---

## 6. Open Cloud: o que vale automatizar

**Veredito: automatizar duas coisas, deixar três de fora.** O `.env.example` já descreve os escopos certos e o
aviso de menor privilégio está correto — o que falta é que **nada em `tools/` usa Open Cloud hoje**.

Estado atual de `tools/` (16 arquivos): geradores (`gen-theme.mjs`, `gen-sprites.mjs`, `gen-ui-skin.mjs`),
validadores (`validate-world.mjs`, `check-registers.mjs`), 10 testes de simulação em Node (`test-*.mjs`) e
`studio-smoke.luau`, que roda **dentro** do Studio. Nenhum script de `package.json` fala com a Roblox.

### 6.1 Vale automatizar

**1. Publicar o place** (`universe-places:write`) — **maior retorno.** `rbxtsc` + `rojo build` + publish por
API tira o Studio do caminho do release. Hoje publicar depende de alguém com o Studio aberto, que é
exatamente o gargalo que o `.env.example` já identifica. Endpoint em `apis.roblox.com`
(https://create.roblox.com/docs/cloud/api/publish).

**2. Luau Execution** (`universe.place.luau-execution-session:write`) — **segundo maior retorno.** Roda um
script Luau contra o place **publicado**, sem Studio:

- `POST /cloud/v2/universes/{universe_id}/places/{place_id}/luau-execution-session-tasks`
- `POST /cloud/v2/universes/{universe_id}/places/{place_id}/versions/{version_id}/luau-execution-session-tasks`
- `GET .../tasks/{task_id}` (status) e `GET .../tasks/{task_id}/logs` (saída)
- Limites: **até 5 minutos por tarefa, 10 tarefas concorrentes por place.**

**É o que transforma `tools/studio-smoke.luau` num teste de CI de verdade.** Também ataca parcialmente o risco
registrado em `docs/MULTIPLAYER.md` §14.1 ("teleporte e reservados não testáveis no Studio") — parcialmente,
porque a execução roda num servidor de sessão, então teleporte real entre servidores continua fora. O que dá
para validar sem Studio: que o `main.server.ts` sobe, que a DataStore responde, que `MAX_PLAYERS` bate com
`Players.MaxPlayers`, que o mundo gera dentro das regras de `validate:world`.

- Link: https://create.roblox.com/docs/cloud/features/luau-execution

**3. `assets:write`** — valeu uma vez (as 14 texturas do skin foram subidas à mão). Só vale de novo se o skin
mudar em lote. **Sob demanda.**

### 6.2 Não vale (e por quê)

- **DataStore por Open Cloud** (`universe-datastores:read`/`:write`): o `.env.example` já diz o certo — read
  para depurar, write desligado até existir um save para consertar. **Um detalhe que o `.env.example` não
  diz e deveria:** a API de DataStore do Open Cloud **não respeita a nossa trava de sessão**
  (`StoredDoc.lock`, `main.server.ts:157-160`). Uma escrita por fora com o jogador online é ou sobrescrita
  pelo próximo `flush` (`main.server.ts:319`), ou — pior — vence a trava e o servidor entra em `lockLost`
  (`main.server.ts:341-344`) no meio da sessão. **Regra: só escrever com o jogador offline, e ler o campo
  `lock` antes.** Nada recorrente deve ser automatizado aqui.
- **Bans por Open Cloud** (`/cloud/v2/universes/{universe_id}/user-restrictions` e a variante por place, em
  **beta**): já temos o painel in-game com a API nativa (§5.1), que é síncrona, autenticada por UserId e
  auditada. Duplicar o caminho duplica a superfície de erro. O único caso em que valeria: banir sem entrar no
  jogo. **Descartado por ora.**
- **Messaging por Open Cloud**: não há nada para anunciar (§3.8).

### 6.3 O que Open Cloud **não** faz — e por que isso importa

O `.env.example` acerta ao avisar que Open Cloud **não muda as configurações da experiência**. Isso confirma
que os três itens bloqueantes deste relatório continuam sendo ação manual no Creator Hub e não podem ser
automatizados nem esquecidos:

1. `Players.MaxPlayers = 6` (B1)
2. Criar a **experiência** de testes separada (B2)
3. "Enable Studio Access to API Services" **desligado** em produção (B3), ligado só na de testes

Some-se "habilitar servidores privados" (§1), que também é só Dashboard.

---

## 7. Avaliado e descartado (resumo)

| Item | Motivo |
|---|---|
| `https://create.roblox.com/docs/environment` | A página é sobre **iluminação e atmosfera** (Lighting, Atmosphere, Sky, Clouds, pós-processamento), não sobre ambientes de servidor. Não responde a nada desta auditoria. |
| `TeleportPartyAsync` | Deprecado. `TeleportAsync` já aceita um array de jogadores. |
| `TeleportToPrivateServer`, `ReserveServer` (sem `Async`), `Teleport` (cliente) | Deprecados. |
| `game.VIPServerId` / `VIPServerOwnerId` | Deprecados — usar `PrivateServerId` / `PrivateServerOwnerId`. |
| Fila de matchmaking própria (`MemoryStoreQueue`) | O Project Z não tem partida: o mundo é persistente por servidor. Reimplementaria pior o que a Roblox já faz. |
| MemoryStore para a trava de sessão | A trava precisa ser durável; MemoryStore expira (TTL ≤ 45 dias). `UpdateAsync` no DataStore já é atômico. |
| `MessagingService` | Nada para coordenar entre servidores com um mundo por servidor. As páginas lidas não publicam a tabela de limites — verificar antes de qualquer uso futuro. |
| `OrderedDataStore` | Sem ranking global persistente. Recordes são pessoais. |
| `UserService` | Sem caso de uso: não mostramos perfil de terceiros. |
| `BatchGetAsync` | 1 chave por jogador, lidas em momentos diferentes. |
| Versionamento de DataStore | Já vem de graça: a doc diz que data stores padrão guardam versões por 30 dias. |
| Bans por Open Cloud | Duplicaria o painel in-game, que já usa a API nativa e é auditado. |
| `AllScopes` de `DataStoreOptions` | A página de `DataStoreService` que li **não documenta** esse campo. Não vou afirmar que existe. |
| Limites de `BanAsync` (máx. de UserIds, tamanho de motivo, duração permanente) | **A doc não publica.** Não encostamos em nada de qualquer forma. |

---

## 8. Lacunas desta pesquisa

Coisas que eu quis confirmar e a documentação pública não me deu:

- **Tabela de limites de `MessagingService`** (tamanho de mensagem, publicações/min por tópico e por universo,
  assinaturas por servidor). Nem a página da classe nem `cloud-services/cross-server-messaging` publicam.
- **Campos completos de `GetPolicyInfoForPlayerAsync`.** A página lista só dois.
- **Limites de `BanAsync`** (§5.1c).
- **`DataStoreOptions.AllScopes`** e a propriedade `AutomaticRetry` de `DataStoreService` — não aparecem na
  página de referência que li.
- **O status real de `TeleportAsync`** (§1a): o guia e a referência se contradizem quanto à deprecação. O
  guia, que é a fonte prescritiva, usa `TeleportAsync` como o método atual, e é o que recomendo.
- A página de configuração de matchmaking no Creator Hub (`/docs/matchmaking/configure-matchmaking` e
  `/docs/matchmaking/custom-attributes-and-signals`) retorna **404**. O caminho para registrar um sinal
  customizado (§2.3) precisa ser confirmado no próprio Creator Hub antes de implementar.
