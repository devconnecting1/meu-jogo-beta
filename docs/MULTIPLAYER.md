# Project Z — Arquitetura multiplayer nativo

> Status: **proposta de arquitetura** (nada implementado). Base: HEAD `9797780`.
> Escopo: transformar o jogo (hoje, cada cliente simula o próprio mundo) em **mundo compartilhado por servidor, com simulação autoritativa no servidor**, até 6 jogadores, co-op sem PvP.
> Regra de ouro herdada da bíblia (`docs/DESIGN_RULES.md`, P2): **sempre melhor que o original e fazendo sentido**. Em MP isso vira: *jogar sozinho continua exatamente como hoje*, e jogar em grupo acrescenta sem tirar nada.

---

## 0. Resumo executivo

| # | Decisão | Por quê (resumo) |
|---|---|---|
| D1 | **O servidor simula tudo**: jogadores, zumbis, chefes, relógio, ondas, itens, loot, portas, construções, combate, XP, inventário e moedas. O cliente envia **inputs e intenções**, e só desenha. | Pedido do autor: o máximo possível no servidor, para impedir trapaças. Não há Humanoid (`CharacterAutoLoads = false`): o "corpo" já é só dado, o que deixa o modelo autoritativo barato. |
| D2 | **Movimento por inputs**: o cliente manda direção, mira e botões, **nunca a posição**. O servidor roda o mesmo `moveActor` compartilhado. O cliente prevê localmente e **reconcilia**. | Speedhack, teleporte e noclip ficam impossíveis por construção. A sensação continua instantânea para quem joga. |
| D3 | **Tick fixo de 30 Hz** para toda a simulação. | Todas as regras foram escritas em "px/frame a 30 fps" (`SPEED_SCALE = 30`), então 30 Hz reproduz o quadro do original. Custo estimado de ~6 ms/tick com 6 jogadores e 150 zumbis. |
| D4 | **Snapshots de 15 Hz** (anel próximo) e 7,5 Hz (anel médio), em `UnreliableRemoteEvent` com `buffer` binário de até 900 bytes. Eventos que não podem se perder vão em `RemoteEvent`. | Pior caso estimado em ~18 KB/s por cliente (6 jogadores, noite, horda máxima). Caso típico: ~6 KB/s. |
| D5 | **Combate resolvido no servidor**, com a **dispersão sorteada em segredo pelo servidor**. O cliente só prevê cosméticos (clarão, traçante, tranco). A **compensação de latência** do hitscan rebobina os zumbis em até **300 ms**. O melee **não rebobina**: ganha margem de **+12 u de alcance e ±6° de arco**. | Sem PvP, rebobinar só favorece o jogador. A dispersão secreta elimina o "no-spread". |
| D6 | **Flow field multi-fonte**: um único Dijkstra (fila de Dial) semeado em **todos** os jogadores em pé, em tiles de 512 u alinhados ao mundo. Cada célula guarda a distância e **qual jogador** a alcançou (o alvo do zumbi). O orçamento é **por tempo** (≤ 2 ms/tick). | O custo cresce com a área coberta, não com o número de jogadores. O alvo passa a ser "o jogador mais próximo pelo caminho" e sai de graça do algoritmo. |
| D7 | **População por aglomerado**: jogadores a ≤ 1500 u uns dos outros formam um aglomerado de *k* jogadores, com fator **S(k) = 1 + 0,5·(k − 1)**. O teto do servidor é **150 zumbis + 2 chefes**. | Solo (k = 1) fica idêntico a hoje. Um grupo enfrenta mais zumbis, mas menos que *k* vezes, o que recompensa jogar junto. |
| D8 | **Interest management com visibilidade**: o cliente só recebe o que poderia ver. Isso exclui zumbis no escuro fora de qualquer luz, o interior de prédios com telhado (se ele estiver fora) e o conteúdo do loot. | Anti-wallhack, e ainda economiza banda. |
| D9 | **Dia do mundo × dia da vida**: o relógio e as ondas são do servidor. `save.day` passa a significar "dias sobrevividos nesta vida". Um servidor novo herda o dia de quem entra primeiro. | Recorde pessoal e moedas por dia continuam por jogador, e o solo continua igual ao de hoje. |
| D10 | **Fim dos "relatórios de progresso"**: o servidor gera XP, itens, dias e chefes a partir de eventos que ele mesmo resolveu. Save **v3**. | Elimina a maior superfície de trapaça atual (`SaveRequest`). |
| D11 | **Derrubado (30 s) → reviver (segurar E por 4 s a ≤ 70 u) → morto → Rebirth pago, New game ou Espectar.** Sem aliado em pé, a espera é pulada. Sair derrubado conta como morte. | Decisão do autor, mais anti-"combat log". |
| D12 | **Play solo** cria um servidor reservado (`TeleportAsync` com `ShouldReserveServer`). No Studio o teleporte não funciona e cai no servidor local. | Documentado: o TeleportService não roda em playtest do Studio. |
| D13 | **Anti-cheat com resposta proporcional**: corrigir em silêncio → sinalizar com evidências no painel de admin → kick automático **só** para flood inequívoco → ban **só** por decisão humana. | Justo com a comunidade: falso positivo nunca bane ninguém. |

Estimativa total: **~22–28 agente-dias** em 7 fases (F0–F6). Cada fase deixa o jogo jogável e testável (seção 11).

---

## 1. Ponto de partida (o que o código faz hoje e importa para o MP)

| Fato do código | Onde | Consequência para o MP |
|---|---|---|
| O cliente simula tudo em `GameLoop.update` (Heartbeat): jogador, combate, zumbis, chefes, spawner, dia/noite, interação e construção | `src/client/gameLoop.ts`, `src/client/systems/*` | Esses sistemas **mudam de lado** (para `src/server/sim/*`). |
| O servidor só valida save, moedas e loja, e aceita **relatórios de progresso** do cliente, limitados por "créditos" de tempo (`applyProgressLimits`) | `src/server/main.server.ts`, `src/shared/game/save.ts` (`sanitizeClientReport`) | Relatórios somem na F3; o servidor passa a gerar o progresso. |
| O mapa é gerado por `generateTown(DESIGN.TOWN_SEED = 7331)` com `TownRng` semeado (~1,9 mil sólidos) e grade espacial de 512 u | `src/shared/game/world.ts` | Cliente e servidor geram **o mesmo mapa** localmente, com os **mesmos ids**. Só os *deltas* trafegam. |
| `world.nextId` é usado tanto por sólidos quanto por itens no chão (`spawnGroundItem`) | `world.ts` | Ids dinâmicos (construções, itens) passam a ser atribuídos **só pelo servidor**, numa faixa separada (≥ 1 000 000). |
| `moveActor`: círculo × AABB, subpassos ≤ raio/2, trava de 400 u por chamada | `src/shared/game/physics.ts` | É o núcleo do movimento compartilhado (predição e autoridade). Já é puro. |
| `FlowField`: Dijkstra de Dial em grade de 80×80 células de 32 u (janela de 2560 u) **centrada no único jogador**, reconstruída a cada 0,4 s com 800 células/quadro | `physics.ts`, `zombieAI.ts` | Vira **multi-fonte** e passa a ser só do servidor (seção 3.3). |
| A separação entre zumbis é **O(n²)** (`computeSeparation`) | `zombieAI.ts` | Com 150 zumbis dá 11 mil pares por tick: troca por hash espacial. |
| Sistemas chamam `getCtx()` (tremida de câmera) e usam `refs.player` (um jogador só) | `zombieAI.ts`, `combat.ts`, `bossAI.ts`, `spawner.ts` | Na F0 passam a emitir **eventos de efeito** e a aceitar **vários jogadores**. |
| A pausa e a mochila **congelam o mundo** | `main.client.ts` (`simulate = …`) | Nova regra: o mundo pausa só se **todos** os jogadores do servidor estão em menu (seção 7.6). |
| O pente nasce cheio a cada mundo novo (`createPlayer`), e a troca de arma devolve o pente à reserva | `player.ts`, `combat.ts` | Em MP, "sair e voltar" daria pente grátis. Por isso o pente volta à reserva ao sair (seção 6.1). |
| Dia/noite: `TIME_SPEED = 0,042 h/s`, dia ×0,8 e noite ×1,2 → **dia (6h–19h) 387 s + noite (19h–6h) 218 s = 605 s ≈ 10,1 min** por dia de jogo | `daynight.ts`, `constants.ts` | O relógio vira do servidor; o cliente só o reproduz (seção 4.6). |
| População solo: até 40 comuns + 4 especiais simultâneos; ondas às 19h/22h/1h de até 30/30/50 (dia ≥ 20) | `spawns.ts`, `spawner.ts` | É a base de S(k) (seção 3.5). |
| O save já tem trava de sessão (`UpdateAsync`, `LOCK_WAIT` 15 s, `releasing`), autosave de 60 s e `BindToClose` com 25 s de orçamento | `main.server.ts` | Reaproveitado. O teleporte do Play solo é coberto pela espera de trava que já existe. |
| Já existe um módulo de admin em andamento (`src/shared/admin/{config,ops,protocol}.ts`): autorização por UserId no servidor, `AdminOp` de edição de save e `BanAsync` | outro agente | As ferramentas de mundo viram operações no servidor, **no mesmo protocolo** (seção 10). |

### 1.1 APIs do Roblox verificadas (Context7 `/roblox/creator-docs` e tipagens `@rbxts/types`)

| API / limite | Fato | Uso aqui |
|---|---|---|
| `UnreliableRemoteEvent` | Payload > **1000 bytes é descartado**. Sem garantia de entrega nem de **ordem**. Indicado para dados efêmeros ou que mudam continuamente. O engine **codifica e comprime** buffers (o que dificulta medir o tamanho final). | Snapshots S→C e inputs C→S. Teto próprio de **900 bytes crus** por pacote. |
| Throttling de remotes | ~**500 requisições/s por cliente**, **compartilhado entre remotes do mesmo tipo** (C→S) | Enviamos ~30 unreliable/s + ≤ 20 reliable/s por cliente. |
| Banda por cliente | A documentação consultada **não fixa um número**. Recomenda enviar só o essencial, por mudança de estado, e testar com simulação de rede. | Referência prática da comunidade: ~50 KB/s por cliente (**não oficial**). Alvo: ≤ 20 KB/s no pior caso, medido na F2. |
| `buffer` (Luau) | Armazenamento binário de tamanho fixo (`writeu8/u16/f32`, `readbits/writebits`…). Passa por RemoteEvents **como cópia**. Tipado em `@rbxts/types` (`roblox.d.ts`, `declare namespace buffer`). | Codec binário compartilhado (`shared/net/codec.ts`). |
| `TeleportService:TeleportAsync` + `TeleportOptions.ShouldReserveServer = true` | Cria um servidor reservado novo. `ReservedServerAccessCode` leva a um reservado existente. Chamado **só no servidor**. Recomenda-se `pcall` + retentativa e `TeleportInitFailed`. **Não funciona em playtest do Studio** (é preciso publicar e testar no cliente Roblox). | Botão "Play solo" (seção 7.4). |
| `game.PrivateServerOwnerId` | **0 em servidores públicos e reservados**; UserId do dono em servidor privado (VIP) | Detecção do tipo de servidor (junto com `PrivateServerId` ≠ ""). |
| Servidores privados | Habilitados no Creator Dashboard (Audience/Access), grátis ou pagos em Robux. Mudar o preço cancela as assinaturas. | Seção 7.5. |
| `Players.MaxPlayers` | **Só configurável** nas configurações do place no Creator Dashboard, não por script | O autor ajusta para **6** manualmente (F5). |
| `BindToClose` | Limite de **30 s** para salvar no desligamento | Já usamos 25 s (`SHUTDOWN_BUDGET`). |
| `MessagingService` | Mensagem ≤ **1 024 caracteres**, entrega **best effort** (não garantida) | Opcional, só para avisos globais de admin (seção 10). |
| Heartbeat do servidor | Limitado a **60 FPS**. Quedas indicam problema de CPU (MicroProfiler e Server Jobs). | O tick de 30 Hz roda em heartbeats alternados. |
| Latência típica | "A maioria dos jogadores tem 100–300 ms". A doc recomenda simular **50–150 ms em cada sentido** (entrada e saída) no Studio. | Tamanho da rebobinagem e plano de teste. |
| Modo "Server & Clients" do Studio | Servidor com **1 a 8 clientes**. Janela do servidor com borda verde e dos clientes com borda azul. Encerrar em uma fecha todas. | Plano de teste (seção 12). |
| Simulação de rede no Studio | Atraso de entrada/saída (one-way), jitter e perda de pacote; vale para o teste multi-cliente | Plano de teste. |
| Native codegen (`--!native`) | Compila scripts do **servidor** para código de máquina; é melhor em matemática e `buffer`. Tem custo de memória e de inicialização. | Opcional para `server/sim/*` (risco: o rbxtsc emitir o cabeçalho, seção 11, F6). |
| `workspace:GetServerTimeNow()` / `Player:GetNetworkPing()` | Relógio sincronizado com o servidor e RTT do jogador em segundos (tipagens `@rbxts/types`) | Linha do tempo da interpolação e teto da rebobinagem. |

---

## 2. Modelo de autoridade

### 2.1 Tabela sistema → dono

| Sistema | Servidor (autoridade) | Cliente | Observação |
|---|---|---|---|
| Posição e velocidade do jogador | ✅ simula com `moveActor` a partir dos inputs | prevê o próprio e interpola os outros | O cliente **nunca** envia posição. |
| Mira (ângulo) | valida e usa no tiro | ✅ fonte (é input) | É input humano, logo inevitavelmente do cliente; os limites estão na seção 8. |
| HP, fome, buffs, veneno, i-frames, knockback | ✅ | exibe e prevê o que afeta velocidade | |
| Arma equipada, pente, recarga, cadência, recuo, dispersão, arco, motosserra | ✅ | prevê para a HUD (contador e barra de recarga) | A dispersão é sorteada **só** no servidor. |
| Acerto e dano (hitscan, melee, flechas, fogo, choque, torretas) | ✅ com rebobinagem (seção 2.3) | cosméticos previstos | Sangue e dano só aparecem com confirmação. |
| Zumbis (IA, flow field, spawn, ondas) | ✅ | interpola | |
| Chefes | ✅ | interpola (o corpo da centopeia é reconstruído pelo rastro) | |
| Relógio, dia, chuva, ondas | ✅ | reproduz localmente e corrige a cada 10 s | |
| Itens no chão, loot de prédios, árvores/carros/lixeiras golpeados | ✅ (o primeiro pedido válido leva) | mostra | O conteúdo do loot só chega a quem revista. |
| Portas, luzes, fogueiras (combustível), construções (HP, dono) | ✅ | espelho do mundo | |
| Crafting, construção (posicionamento), reparo | ✅ valida e executa | fantasma de pré-visualização | |
| Inventário, XP, nível, skills, conquistas | ✅ | espelho somente leitura | |
| Moedas, loja, Rebirth, New game | ✅ (já é assim) | | |
| Derrubado, reviver, morte, espectar | ✅ | UI e câmera | |
| Câmera, UI, áudio, partículas, telhados/copas, mapa de luz | — | ✅ | Seção 2.5. |

### 2.2 Movimento: inputs no cliente, simulação no servidor, predição e reconciliação

#### Por que inputs, e não posição validada

| Critério | A) Cliente manda posição + servidor valida | **B) Cliente manda input + servidor simula (escolhido)** |
|---|---|---|
| Speedhack | Validar velocidade exige tolerância (latência e jitter geram rajadas), e o trapaceiro vive dentro dela (+20–30%) | **Impossível**: o servidor consome no máximo 1 comando por tick (30/s) com velocidade calculada por ele |
| Teleporte / noclip | Exige raycast de cada deslocamento contra paredes, com casos de borda (portas, knockback) e falso positivo em lag | **Impossível**: não existe campo de posição no protocolo |
| Knockback, lentidão (ácido, fome, dano) | O cliente pode "esquecer" de aplicar; o servidor precisa detectar | Aplicado pelo servidor; o cliente só prevê |
| Custo de CPU | Baixo | 6 × 30 = 180 `moveActor`/s: **desprezível** |
| Sensação | Instantânea | Instantânea (predição) com correções raras e suaves |
| Complexidade | Validação cheia de heurística e falso positivo | Reconciliação padrão (histórico de comandos) |
| Robustez a lag switch | Rajada de posições "legítimas" depois do lag | O servidor segura o personagem parado; o que chega atrasado é descartado |

A escolha B também combina com o que já existe: o "personagem" é só dado (sem Humanoid e sem física do engine), e `moveActor` já é puro e compartilhado (`shared/game/physics.ts`).

#### Comando (8 bytes, quantizado **antes** de prever)

| Campo | Tipo | Conteúdo |
|---|---|---|
| `seq` | u16 | Sequência (módulo 65536, comparação modular) |
| `moveAng` | u8 | Direção do movimento em 256 passos (1,406°). As 8 direções do teclado caem exatas (45° = 32 passos). |
| `moveMag` | u8 | Magnitude 0–255 (0 = parado); o joystick analógico usa a faixa toda |
| `aim` | u16 | Ângulo de mira em 65 536 passos (0,0055°; erro de 0,1 u a 1200 u, o alcance do sniper) |
| `held` | u8 | Bits: ataque segurado, ação (E) segurada, mira do sniper, reservados |
| `edges` | u8 | 2 bits: nº de toques de ataque no tick (0–3); 2 bits: nº de solturas (arco/sniper); 2 bits: nº de toques de E; 2 bits: recarregar |

Pacote C→S (`Input`, **UnreliableRemoteEvent**, 30/s): cabeçalho de 4 bytes (`count`, `viewTick u16`, `viewFrac u8`, com o tick do snapshot que o cliente desenhava, usado na rebobinagem) mais **3 comandos** (o novo e os 2 anteriores, como redundância). Total de 28 bytes. Duas perdas seguidas se recuperam sem retransmissão.

> O cliente **quantiza o próprio input** exatamente como o servidor vai ler e só então roda a predição. Assim cliente e servidor aplicam o mesmo valor, bit a bit.

#### Buffer de inputs no servidor

- Uma fila por jogador, ordenada por `seq`, com **profundidade-alvo de 2** comandos (66 ms) e **máximo de 4** (133 ms).
- A cada tick o servidor **consome exatamente 1 comando** por jogador:
  - **Atrasado (fila vazia)**: repete o movimento do último comando por 1 tick e depois usa "parado". Esse slot é marcado como *preenchido*, e o comando real que chegar depois com esse `seq` é **descartado** (o servidor já simulou aquele tempo).
  - **Duplicado** (`seq` ≤ último consumido): ignorado. Acontece normalmente por causa da redundância.
  - **Fora de ordem**: inserido na posição correta, se ainda não foi consumido.
  - **Fila > 4** (relógio do cliente adiantado, rajada ou trapaça): descarta os mais antigos até 4 e incrementa o contador `inputOverflow`.
- **Dilatação de tempo**: o snapshot devolve a profundidade da fila (`bufDepth`). O cliente ajusta seu ritmo de amostragem em ±2% (29,4–30,6 Hz) para manter a fila perto de 2, o mesmo método do Overwatch. Isso cobre deriva de relógio sem quebrar o determinismo, porque cada comando continua valendo 1/30 s.
- **Limite de taxa**: token bucket de 60 pacotes/s (rajada de 20). O excesso é descartado e contado. Flood sustentado leva a kick (seção 8.2).

**Por que isso elimina trapaça de movimento por construção:** o protocolo não tem posição nem dt. O servidor usa sua própria velocidade (`recalcMoveSpeed` com skills, equipamento, buffs, fome, dano e ácido), sua própria colisão e seu próprio relógio. O único jeito de "andar mais" seria o servidor consumir mais de 1 comando por tick, e isso nunca acontece.

#### Reconciliação no cliente

```text
a cada tick local (30 Hz, sincronizado ao servidor):
  cmd = amostrarInput()            -- já quantizado
  enviar(cmd + 2 anteriores)
  estado = stepPlayer(mundoLocal, estado, cmd, 1/30)   -- shared/sim/playerMove.ts
  historico[cmd.seq] = estado

ao receber snapshot (ackSeq, estadoServidor):
  apagar historico com seq < ackSeq
  erro = estadoServidor.pos - historico[ackSeq].pos        -- métrica de divergência
  se |erro| > 0,01 u:
     e = estadoServidor
     para cada cmd pendente (seq > ackSeq): e = stepPlayer(mundoLocal, e, cmd, 1/30)
     offsetVisual += posDesenhada - e.pos      -- o que está na tela não pula
     estado = e
     se |offsetVisual| > 64 u: offsetVisual = 0 (teleporte/admin/knockback grande: snap)

a cada quadro (60 fps):
  pos = lerp(estadoAnterior, estado, α) + offsetVisual
  offsetVisual *= exp(-dt / 0,1)                -- some em ~100 ms
  -- extrapolação só de render: + velocidadeDoInputAtual × (t desde o tick), até 1 tick,
  -- colidida por moveActor; nunca volta para o estado
```

Fontes de divergência esperadas e como são tratadas:

| Fonte | Frequência | Tratamento |
|---|---|---|
| Knockback de mordida ou explosão (vem do servidor) | Em combate | O snapshot traz `reactionSpeed/Dir`; a correção é suavizada |
| Porta aberta ou fechada por outro jogador, ou construção nova | Raro | O mundo local recebe o delta em ≤ 1 RTT; correção pequena |
| Lentidão por ácido e mudança de buff | Ocasional | O estado próprio traz as flags; a predição usa as mesmas regras |
| Ordem do `querySolids` | Nunca, se a grade for idêntica | Autoteste de determinismo (seção 12) |

### 2.3 Combate

**Fluxo de um tiro** (arma hitscan):

1. O cliente processa um comando com toque de ataque e a arma permite (previsão da cadência). Ele mostra na hora o clarão, o tranco, a tremida, o som e um traçante com **dispersão cosmética local**.
2. O servidor consome o mesmo comando e checa arma, pente, cadência (`fireCd` do servidor), recarga, estar derrubado e posição de construção. Então sorteia a dispersão com **o RNG dele** (cone + recuo + movimento, igual a `fireGun`/`spreadRoll`) e traça cada projétil:
   - **Paredes e sólidos no presente** (não se movem; portas usam o estado atual).
   - **Zumbis e chefes rebobinados** para o instante que o atirador via: `tickVisto = viewTick + viewFrac`, com a posição interpolada no anel de histórico.
   - O dano, a reação (`reactToHit`) e o knockback se aplicam ao zumbi **no presente**.
3. O servidor manda `ShotResult` (Fx) para todos no interesse: slot do atirador, arma e os pontos finais de cada projétil com o tipo de impacto. O atirador troca o impacto previsto pelo real (sangue verde, detritos). Os outros jogadores desenham os traçantes a partir do corpo interpolado do atirador.

**Compensação de latência (hitscan):**

| Parâmetro | Valor | Motivo |
|---|---|---|
| Histórico | Anel de **12 ticks (400 ms)** com x, y de cada zumbi e chefe (e segmentos da centopeia) | Cobre a rebobinagem máxima com folga para interpolar |
| Rebobinagem máxima | **300 ms** (9 ticks) | Latência típica de 100–300 ms (doc) + interpolação de 133 ms: cobre a maioria. Acima disso o jogador precisa antecipar um pouco (e lag switch deixa de compensar). |
| Teto por jogador | `min(300 ms, RTT_medido/2 + atrasoInterp + 2 ticks)` com `Player:GetNetworkPing()` | Impede declarar um `viewTick` antigo de propósito para rebobinar mais |
| Sem PvP | — | Sem o problema clássico de "levar tiro atrás da parede": rebobinar só ajuda quem atira |

**Melee (lâminas e motosserra):** o servidor avança a varredura (`updateSwing`/`sweep`) a cada tick com a mira do comando, contra os zumbis **no presente**. Não rebobina, porque o melee acontece na distância de contato, onde a posição de servidor do zumbi é a mesma que decide a mordida dele; misturar os dois tempos criaria "matei, mas ele me mordeu antes". Em troca, ganha **margem de latência**: alcance **+12 u** (≈ o que um andador anda em 130 ms) e **±6°** no arco. A cadência (`fireCd`), o hitstop (5/30 s) e o limite de 2 alvos por golpe continuam no servidor.

**Projéteis (flechas, fogo, choque, agulhas e cuspe):** são simulados no servidor. O disparo gera `ProjSpawn` (origem, ângulo, velocidade e tipo), e o cliente anima o voo localmente (linha reta com atrito, determinística). O fim (cravou, caiu no chão, bateu) chega por evento. A flecha do próprio jogador aparece prevista e se funde à autoritativa em 100 ms.

**Dano em jogadores:** é do servidor (`damageToPlayer`: i-frames de 1,5 s, armadura, knockback). **Mordida justa** (opcional, via flag): a mordida só vale se o zumbi também estiver a ≤ contato + 24 u **na posição que a vítima via** (rebobinada pelo `viewTick` dela, com teto de 150 ms). Isso evita "fui mordido de longe" sem dar imunidade a quem tem lag.

**Sem fogo amigo:** tiros, flechas, fogo, choque e golpes **atravessam aliados** (o raycast e a varredura ignoram jogadores). Torretas nunca miram jogadores. Exceção proposta: a **explosão do exploder fere todos no raio**, porque é um ataque do zumbi, não de um jogador (P3: "parece explosão, se comporta como explosão"). O ponto está listado em "Questões abertas".

**Seed da dispersão:** sorteada com `Random` do servidor e **nunca enviada**. Custo: o traçante previsto pode divergir alguns graus do real. Com 0,2 s de vida isso é imperceptível no meio do caos, e o impacto real chega com a confirmação.

### 2.4 Tick de ações discretas (ordem com o movimento)

As intenções confiáveis (trocar arma, usar item, craftar, colocar, equipar) carregam `atSeq`, o `seq` do comando em que o jogador as fez. O servidor aplica a intenção **ao processar aquele comando**. Assim "troquei de arma e atirei" nunca vira "atirei com a arma velha" por causa de canais diferentes, e a ordem é a mesma da predição.

### 2.5 Onde o cliente mantém autoridade (e por quê)

Nada desta lista afeta outro jogador, o mundo ou a economia.

| Item | Por que fica no cliente |
|---|---|
| Câmera (seguir, zoom, tremida, câmera livre de admin **só visual**) | É apresentação. O que um admin pode *ver* é limitado pelo interesse, que o servidor controla (seção 10). |
| UI: menus, mochila, HUD, layout, tamanho da interface, idioma e volume | Preferência pessoal. As configurações são persistidas por intenção validada (`readSettings`). |
| Mira | É input humano; não há como não vir do cliente. O servidor limita cadência, dispersão e alcance. |
| Cosméticos previstos: clarão, traçante, tranco, som, animação do golpe, passos, ciclo de caminhada | Dão sensação imediata. Nenhum aplica dano. |
| Partículas, sangue, detritos, tremida de sólidos, fade de telhados e copas, mapa de luz, alpha dos zumbis pela luz | Visual derivado de estado replicado. |
| Interpolação e extrapolação dos outros | Visual. |
| Predição do próprio movimento | Sempre sobrescrita pelo servidor. |
| Dicas "E: …", lista do que dá para craftar, fantasma de construção | Pré-visualização. O servidor revalida tudo ao executar. |
| Tutorial (slides) | Não toca o mundo. `tutorialDone` é persistido por intenção (booleano inofensivo). |

---

## 3. Loop do servidor

### 3.1 Tick

- **30 Hz, passo fixo** (`TICK_DT = 1/30`), acumulado no `RunService.Heartbeat` (que tem teto de 60 FPS). Recupera no máximo **2 ticks por heartbeat**. Se o atraso passar disso, o mundo desacelera (o tempo é descartado e registrado) em vez de entrar em espiral de recuperação.
- **Ordem dentro do tick:**
  1. **Entrada**: para cada jogador no mundo, consome 1 comando (ou preenchimento) → `stepPlayer` (movimento, fome, HP, buffs) → máquina da arma (recarga, cadência, tiro com rebobinagem, varredura) → intenções com `atSeq` deste comando.
  2. **Mundo**: relógio e ondas → população por aglomerado → flow field (orçamento por tempo) → zumbis (com LOD) → chefes → projéteis, explosões e poças → torretas e armadilhas → fogueiras, loot, cooldowns de árvore/carro → física de itens → sangramento e reviver.
  3. **Histórico**: grava x, y dos zumbis e chefes no anel.
  4. **Replicação** (ticks pares, 15 Hz): interesse → codificação por cliente → `FireClient`. Os deltas confiáveis acumulados no tick são enviados em lote a cada tick.
  5. **Métricas e anti-cheat**: decaimento de contadores, tempo do tick e bytes enviados.

### 3.2 Orçamento de CPU por tick (6 jogadores, noite, 150 zumbis)

Estimativas para validar na F2 com `os.clock()` por etapa (seção 12). O período do tick é 33,3 ms. Meta: **média ≤ 6 ms e p95 ≤ 10 ms** (≤ 20% de um núcleo), para o heartbeat seguir em 60.

| Etapa | Custo estimado | Notas |
|---|---|---|
| Entrada + movimento de 6 jogadores | 0,1 ms | 6 `moveActor` com ≤ 2 subpassos |
| Combate (armas, hitscan com rebobinagem, projéteis, torretas) | 0,5 ms (pico 1,5) | Pico com 6 escopetas (5 projéteis cada) no mesmo tick |
| IA de 150 zumbis | 2,5 ms | ~15 µs por zumbi (lógica + `moveActor`). **LOD**: zumbis a > 1600 u de todos os jogadores atualizam a 10 Hz. |
| Separação por hash espacial (célula de 64 u) | 0,3 ms | Substitui o O(n²) |
| Flow field multi-fonte | ≤ 2,0 ms | **Orçamento por tempo**, não por contagem |
| Chefes, spawner, relógio, interação, itens, fogueiras | 0,3 ms | |
| Anel de histórico | 0,05 ms | |
| Replicação (6 clientes, só em ticks pares) | 1,0 ms (0,5 amortizado) | Consulta de interesse no hash + escrita em `buffer` |
| Anti-cheat e métricas | 0,05 ms | |
| **Total** | **~6 ms médio / ~9 ms p95** | |

Se passar do alvo, na ordem: LOD mais agressivo (10 Hz a partir de 1200 u), teto de 120 zumbis, `--!native` nos módulos de simulação e, por último, flow field em Actor (Parallel Luau).

### 3.3 IA: flow field multi-fonte

**Hoje:** uma janela de 80×80 células (32 u) centrada no jogador, reconstruída a cada 0,4 s.

**Proposta:**

- **Grade alinhada ao mundo em tiles de 512 u** (16×16 células de 32 u), casando com `TOWN.GRID_CELL`. Um tile fica **ativo** se estiver a ≤ 1280 u de algum jogador em pé (a mesma meia-janela de hoje). Com 1 jogador isso dá o mesmo alcance atual.
- **Rasterização em cache por tile:** a camada estática (paredes, árvores, carros) é rasterizada uma vez, na geração. A camada dinâmica (construções e portas) é refeita só nos tiles **sujos** (`addSolid`, `removeSolid`, porta abrindo ou fechando e HP chegando a 0 marcam o tile). Isso remove o maior custo fixo de hoje (`rasterize` a cada rebuild).
- **Dijkstra multi-fonte (fila de Dial, os mesmos custos: 10 ortogonal, 14 diagonal, +60 construção "macia"):**
  - Sementes: **todo jogador em pé**, com distância inicial 0.
  - **Derrubados** entram com distância inicial **200** (+20 células): um jogador em pé perto é preferido, mas o zumbi sem outro alvo vai até o derrubado (a mordida acelera o sangramento, seção 7.3).
  - Jogadores no lobby, mortos, espectando ou em proteção de spawn **não são fontes**.
  - Cada célula guarda `dist` e **`owner`** (o índice do jogador que a alcançou primeiro). `owner` é o **alvo** do zumbi naquela célula: "o jogador mais próximo pelo caminho", de graça.
- **Consulta:** `heading(x, y)` igual à de hoje (desce o gradiente e mira na célula mais distante em linha livre). Novo: `targetOf(x, y) → jogador`.
- **Perseguição direta:** mantida quando o alvo está a < 72 u com linha livre, e ampliada para **< 200 u com linha livre** (o campo pode estar até 0,4 s velho).
- **Orçamento:** o rebuild é *double-buffered* como hoje (consultas leem o último campo completo) e expande células até gastar **2 ms/tick**. Custo estimado de ~2 µs/célula interpretado (~0,7–1 µs com `--!native`; medir na F2).

| Cenário | Células ativas | Rebuild completo a cada |
|---|---|---|
| Solo | ~6,4 mil–9 mil | ~0,4 s (igual a hoje) |
| 6 jogadores juntos | ~12 mil–15 mil | ~0,4–0,5 s |
| 6 jogadores espalhados (pior) | ~46 mil–55 mil | ~1,5 s interpretado, ~0,5 s nativo (degrada suave: só o caminho fica mais velho) |

- **Zumbi fora de qualquer tile ativo:** usa `steer` direto até o jogador mais próximo em linha reta, como hoje fora da janela.
- **Coleira** (`LEASH_SPAWN` 2000 / `LEASH_PLAYER` 600), detecção por ruído (anéis de **todos** os jogadores), mira do cuspidor, pulo e investida passam a usar `targetOf(z)`, com o jogador mais próximo como fallback.

### 3.4 Separação e LOD

- **Hash espacial** de zumbis (célula de 64 u, maior que 2 × o raio do zumbi grande de 23 u). Só testa pares em células vizinhas. Custo O(n) na prática.
- O mesmo hash serve à consulta de interesse, ao `actorOverlapsRect` (fechar porta) e às armadilhas.
- **LOD**: zumbi a > 1600 u de todos os jogadores atualiza a 10 Hz (dt de 0,1 s; `moveActor` subdivide sozinho), sem ruído nem alpha. Ninguém o vê.

### 3.5 População, spawn e ondas escalando com jogadores

**Aglomerados:** a cada 1 s, jogadores em pé a ≤ 1500 u uns dos outros formam um aglomerado (union-find com no máximo 6 nós). Seja *k* o tamanho do aglomerado e **S(k) = 1 + 0,5·(k − 1)**:

| k | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| S(k) | 1,0 | 1,5 | 2,0 | 2,5 | 3,0 | 3,5 |
| Teto de comuns no aglomerado (40·S) | 40 | 60 | 80 | 100 | 120 | 140 |
| Teto de especiais no aglomerado (4 + k − 1) | 4 | 5 | 6 | 7 | 8 | 9 |

- **Teto rígido do servidor:** 150 zumbis vivos + 2 chefes. Protege CPU e banda mesmo com 6 aglomerados de 1.
- **Ambiente:** a quota do aglomerado é `pop.ambient × S(k)` (e `ambientSpecial × S(k)`). Os zumbis contam para o aglomerado cujo jogador mais próximo está a ≤ 1600 u. Com k = 1, idêntico a hoje.
- **Ondas:** às 18h o servidor enche as filas **por aglomerado** com `pop.waveN × S(k)`. Às 19h, 22h e 1h cada aglomerado as consome no ritmo atual (1 a cada 2/30 s). Os aglomerados são recalculados a cada 1 s: se o grupo se separa, as filas restantes se dividem proporcionalmente.
- **Ponto de spawn:** anel de 720–1080 u ao redor de um jogador do aglomerado (round-robin), mais três regras novas:
  - não nascer a < 720 u de **nenhum** jogador (nunca na cara de outro);
  - não nascer dentro do cone de lanterna ou da luz de nenhum jogador à noite;
  - `circleBlocked` livre (já existe).
- **Limpeza:** um andador comum some quando está a > 1080 u de **todos** os jogadores (e não só "do jogador"). Os de onda e os especiais são realocados no anel do jogador mais próximo, como hoje.
- **Itens de chão aleatórios:** `ITEM_NUMBER × S(k)` por aglomerado.
- **Chefes:** nascem quando um jogador em pé chega a ≤ 900 u de uma âncora com `day ≥ nextDay`; no máximo 2 simultâneos. HP = `10 000 × S(k_perto)` (jogadores a ≤ 1500 u na hora do spawn). A regeneração continua igual.
- **Dificuldade** (`difficultyOfDay`) usa o **dia do mundo** (seção 6.2).

**Por que S(k) sublinear:** *k* jogadores juntos têm mais que *k* vezes a eficácia de um (controle de multidão, foco e reviver). Escalar 1:1 puniria o grupo. Com 0,5 por jogador extra, o grupo de 6 enfrenta 3,5× a horda solo, e o jogador isolado num servidor cheio enfrenta **exatamente o solo** (S(1)).

### 3.6 XP e recompensas geradas no servidor

| Evento | Quem ganha | Quanto |
|---|---|---|
| Zumbi morto | Quem deu o golpe final | 100% do `exp` |
| | Cada outro jogador que o feriu nos últimos 10 s | 60% (assistência: acaba com o "roubo de abate") |
| Torreta ou armadilha mata | O construtor (se estiver no servidor) | 100% |
| Chefe morto | Cada participante (causou ≥ 3% do HP **ou** ficou ≥ 20 s a ≤ 1200 u com o chefe vivo) | 100% do XP, +1 em `bossKills` e moedas de chefe |
| Dia sobrevivido (virada 0h do mundo) | Cada jogador no mundo (em pé ou derrubado) que passou **≥ 50% daquele dia** no mundo e **não estava AFK** (sem input de movimento ou ataque nos últimos 3 min) | +1 em `day` (dia da vida), `COINS_PER_DAY` e bônus de marco por `bestDay` |
| Horas puladas por admin | Ninguém | 0 (flag `skipped`) |

O drop de zumbi usa a skill do **matador** (`skillLevels[9]`). O loot de prédio usa a do **revistador**.

---

## 4. Replicação

### 4.1 Canais (em `ReplicatedStorage/Net`)

| Remote | Tipo | Sentido | Conteúdo | Taxa |
|---|---|---|---|---|
| `Input` | Unreliable | C→S | `buffer` de 28 B: 3 comandos + `viewTick` | 30/s |
| `Intent` | RemoteEvent | C→S | `{k, atSeq, …}` (tabela pequena, validada) | Sob demanda, ≤ 20/s |
| `ShopAction` | RemoteFunction | C→S | **Já existe** (loja, Rebirth, New game) | Existente |
| `LoadRequest` / `LoadAck` | RemoteEvent | ↔ | **Já existe**. O `LoadAck` passa a trazer também as informações do servidor (modo, dia do mundo, seed, hash do mapa, `tick0`). | Existente |
| `Snap` | Unreliable | S→C | `buffer` ≤ 900 B por parte (1–2 partes por snapshot, cada parte **autocontida**) | 15/s |
| `Fx` | Unreliable | S→C | Lote por tick: `ShotResult`, `ProjSpawn/End`, sangue, impacto, explosão, tremida de sólido, som | ≤ 30/s |
| `World` | RemoteEvent | S→C | Deltas do mundo (seção 4.5), `WorldInit` em blocos, relógio, anúncios, morte de zumbi, entrada e saída de jogador, derrubado/reviveu/morreu | Lote por tick, só quando há algo |
| `Self` | RemoteEvent | S→C | Espelho do save próprio: deltas de inventário, XP/nível/skills, conquistas, carteira | Sob demanda |
| `SaveRequest` / `SaveAck` | — | — | **Removidos na F3** | — |

Regra geral: tudo que for contínuo ou efêmero e se autocorrige no próximo pacote vai em **Unreliable**. Tudo que muda estado persistente do mundo ou do jogador e não pode se perder vai em **RemoteEvent** (confiável e ordenado).

### 4.2 Layout binário (`shared/net/codec.ts` + `shared/net/snapshot.ts`)

Quantização: posição em **u16 com 0,5 u** de resolução (x ≤ 22 400 → 44 800; y ≤ 16 640 → 33 280, ambos < 65 535). Ângulo em **u8** (1,41°). Estado próprio em **f32** (reconciliação exata).

**Cabeçalho do `Snap` (8 B):**

| Offset | Tipo | Campo |
|---|---|---|
| 0 | u8 | `kind` (4 bits) · `part` (2 bits) · `parts` (2 bits) |
| 1 | u16 | `tick` do servidor (módulo 65 536; wrap a cada 36 min a 30 Hz, com comparação modular) |
| 3 | u8 | `nPlayers` |
| 4 | u8 | `nZombies` |
| 5 | u8 | `nBosses` |
| 6 | u8 | `flags` (tem bloco próprio, tem relógio, …) |
| 7 | u8 | reservado |

**Bloco próprio (28 B, só na parte 0):** `x f32`, `y f32`, `ackSeq u16`, `bufDepth u8`, `reactionSpeed u8 (×1/25)`, `reactionDir u8`, `hp u16 (×1/100)`, `hunger u8`, `flags u8` (atingido, veneno, velocidade, calma, dor, ácido, derrubado, morto), `iframe u8 (×1/100 s)`, `mag u8`, `reload u8 (0–255 de progresso)`, `spread u8`, `draw u8` (arco ou motosserra), `bleed u8` (s do sangramento ou progresso do reviver), `modFlags u8` (noclip e deus do admin, proteção de spawn), 2 reservados.

**Outro jogador (12 B):** `slot u8`, `x u16`, `y u16`, `aim u8`, `flags u8` (andando, golpeando, recarregando, atirou, derrubado, morto, lanterna, espectando), `weapon u8`, `swing i8` (ângulo relativo da lâmina), `hp% u8`, `revive u8`, `moveAng u8` (direção dos pés).

**Zumbi (9 B, +1 opcional):** `netId u16`, `x u16`, `y u16`, `angle u8`, `state u8` (detect "!", atordoado, hitFlash, pulando, investindo, pavio aceso, preparando cuspe, `hasExtra`), `meta u8` (tipo em 3 bits, grande em 1 bit, reservados). Se `hasExtra`: `+ u8` (altura do pulo ou recuo da cabeça do cuspidor).

**Chefe (14 B):** `netId u8`, `type u8`, `x u16`, `y u16`, `angle u8`, `hp u16`, `flags u8`, `phase u8` (`movePos`/`moveCycle`), `extra u8`, 2 reservados. O corpo da centopeia (50 segmentos) **não trafega**: o cliente reconstrói o rastro a partir da cabeça interpolada. Os acertos nos segmentos são do servidor.

**Fx:** `ShotResult` = `slot u8, weapon u8, n u8` + n × (`x u16, y u16, hit u8`), ou seja 3 + 5n B. `ProjSpawn` (12 B) = `projId u16, kind u8, ownerSlot u8, x u16, y u16, angle u16, speed u8, _`. `ProjEnd` (7 B). `Blood/Debris/Shake` (6–8 B).

**Tamanho de um snapshot no pior caso:** 8 + 28 + 5×12 + 60×9 (anel próximo) + 30×9 (metade do anel médio por snapshot, em rodízio) + 2×14 ≈ **934 B** → 2 partes. Com menos zumbis visíveis, 1 parte.

### 4.3 Interest management (por jogador)

- **Centro:** a posição do jogador, **ou** o aliado espectado (derrubado ou morto), **ou** a câmera do admin (seção 10).
- **Anéis:** próximo **≤ 800 u** (15 Hz), médio **800–1500 u** (7,5 Hz: metade dos zumbis do anel em cada snapshot, em rodízio) e saída com histerese em **1650 u**. Cobrem uma tela de 1920 × 1080 (meia-diagonal ≈ 1100 u) com margem para telas largas.
- **Visibilidade (anti-wallhack), avaliada por zumbi e por cliente:**
  1. **Dentro de prédio:** se o zumbi está dentro da planta de um prédio (`buildingAt`) e o jogador **não** está nesse prédio, ele não é enviado. O telhado já esconde o interior (EDI-04), então o cliente não perde nada visível.
  2. **Escuro:** à noite, ou na chuva com `darkAlpha` alto, o zumbi só é enviado se estiver dentro de **alguma** luz (a luz de 250 u de qualquer jogador, lanterna de 560 u em cone, lampião, fogueira, braseiro, clarão de tiro ou explosão, com a mesma tabela que `collectLights`/`updateAlpha` já usam), **ou** a ≤ 150 u do jogador (ele ouve e sente). O fade de alpha que já existe (3/s) esconde o surgimento.
  3. **De dia:** tudo no raio é visível, exceto o caso 1.
- **Loot:** o flag "tem loot" de um prédio só vai para quem está **dentro** dele (é quando a dica aparece). O **conteúdo** nunca vai; o servidor entrega os itens direto no inventário de quem revistou.
- **Chefes:** só dentro do raio (não há "radar" de chefe).

### 4.4 Spawn e despawn de entidades

- **Implícitos pelo snapshot:** o registro do zumbi traz tipo e variante (`meta`). O cliente cria a entidade na primeira vez que a vê e a remove (com fade de 150 ms) se ela não aparecer por **300 ms** no anel próximo ou **600 ms** no médio. Isso aguenta a rotatividade do interesse sem precisar de eventos confiáveis para cada entrada e saída.
- **Morte explícita (confiável):** `ZombieDied{netId, x, y, cause}` dispara sangue, cadáver e drop no lugar certo e remove na hora. Um snapshot atrasado com esse `netId` e `tick` anterior à morte é ignorado.
- **`netId`:** pool reciclável de u16 (1–65 535) com lista livre. Um id liberado só é reusado depois de 2 s, para não colidir com snapshots atrasados.
- **Jogadores:** `slot` de 0 a 5, estável durante a sessão. `PlayerJoined{slot, userId, displayName, level, costume/deco}` e `PlayerLeft{slot}` são confiáveis.

### 4.5 Deltas do mundo (confiáveis, em lote por tick, filtrados por interesse quando fizer sentido)

| Delta | Conteúdo | Filtro |
|---|---|---|
| `SolidAdd` (construção) | `id u32, placeable u8, x, y, rot, hp%, powered/open, ownerSlot` | Global (poucos; todo mundo precisa para prever colisão) |
| `SolidRemove` | `id` | Global |
| `DoorSet` | `id, open` | Global (afeta a predição de movimento de todos) |
| `SolidHp` | Lote de `id, hp%` a **4 Hz** | Interesse |
| `LightSet` | `id, powered` (lampião, fogueira) | Interesse |
| `MapItemHit` | `solidId` (tremida de árvore, carro ou lixeira) | Interesse (via `Fx`, efêmero) |
| `ItemAdd` / `ItemRemove` | `id u32, kind, itemId, count, x, y, vx, vy` / `id` | Interesse (1800 u) |
| `LootFlag` | `buildingId, hasLoot` | Só para quem está dentro |
| `Clock` | `worldDay, dayTime, tick, rain, waveFlags` | Global (a cada 10 s e na mudança) |
| `Announce` | "Wave 1", "Good morning", chefe apareceu… | Global ou interesse |
| `WorldInit` | Hash do mapa (checagem de seed/versão), `tick0` (`GetServerTimeNow` no tick 0), todas as construções e portas alteradas, itens no interesse, relógio | Na entrada, em blocos de `buffer` ≤ 16 KB |

**Ids:** o mapa estático é gerado igual nos dois lados (`generateTown(seed)` com `TownRng`), então sólidos estáticos têm o **mesmo id**. O `WorldInit` traz um hash (quantidade de sólidos + soma de id×coordenadas mod 2³²) e o cliente o compara; uma divergência gera log e aviso. Ids dinâmicos (construções e itens) começam em **1 000 000** e só o servidor os cria; o espelho do cliente insere com o id recebido.

### 4.6 Sincronização de relógio

- **Tempo de simulação:** `tickEstimado = (workspace:GetServerTimeNow() − tick0Time) × 30`. O tempo de render dos outros é `agora − atrasoInterp`.
- **Relógio do jogo:** o cliente avança `dayTime` localmente com a mesma regra (`TIME_SPEED` ×0,8 de dia e ×1,2 de noite, em `shared/sim/clock.ts`) e se corrige a cada `Clock` (10 s ou mudança). Erros < 0,05 h se ajustam suavemente; maiores (admin mudou a hora) saltam.
- **Ondas e anúncios:** vêm do servidor. O cliente não decide nada pelo relógio local.

### 4.7 Estimativa de banda

**Pior caso por cliente:** 6 jogadores juntos, noite, horda no teto, combate pesado, 120 dos 150 zumbis visíveis (base iluminada).

| Item | Quantidade | Bytes | Hz | B/s |
|---|---|---|---|---|
| Cabeçalho + bloco próprio | 1 | 36 | 15 | 540 |
| Outros jogadores | 5 | 12 | 15 | 900 |
| Zumbis, anel próximo | 60 | 9 | 15 | 8 100 |
| Zumbis, anel médio | 60 | 9 | 7,5 | 4 050 |
| Extras de especiais | 9 | 1 | 15 | 135 |
| Chefes | 2 | 14 | 15 | 420 |
| `ShotResult` (6 jogadores, ~10 tiros/s, escopeta com 5 projéteis) | ~60/s | ~13 | — | 780 |
| Projéteis (spawn e fim) | ~40/s | ~10 | — | 400 |
| Sangue, impacto e morte | ~60/s | 8 | — | 480 |
| Deltas confiáveis (morte de zumbi, HP de construção a 4 Hz, itens, portas) | — | — | — | 800 |
| Overhead por evento (estimado em ~20 B × ~75 eventos/s) | | | | 1 500 |
| **Total por cliente** | | | | **≈ 18 KB/s (≈ 146 kbit/s)** |

- **Servidor, saída:** 6 × 18 ≈ **110 KB/s**. **Entrada:** 6 × (30 × 28 B + overhead) ≈ **9 KB/s**.
- **Cliente, subida:** ≈ **1,4 KB/s**.
- **Caso típico** (dia, 3 jogadores, 25 zumbis visíveis): ≈ **5–6 KB/s** por cliente.
- **Comparação:** a documentação não fixa limite de banda; a referência prática usada pela comunidade é ~50 KB/s por cliente. O pior caso fica em **~36%** disso, com folga para a compressão de buffers do engine (que só reduz o número). **Medir na F2** (seção 12). Alavancas, se precisar: anel médio a 5 Hz, codificação delta em relação ao último snapshot confirmado (o ack já viaja no `Input`) e teto de 120 zumbis.

---

## 5. Cliente

### 5.1 Interpolação e extrapolação (outros jogadores, zumbis, chefes)

- **Buffer de interpolação:** padrão de **133 ms** (2 intervalos de snapshot a 15 Hz), **adaptativo**: `clamp(2 × intervalo + 2 × desvioDoJitter, 100, 250) ms`. A mudança é lenta (o relógio de render dilata ±5%), para não dar solavanco.
- **Posição:** interpolação linear entre os dois snapshots que cercam `tempoRender`. **Ângulo:** pelo caminho mais curto.
- **Buffer vazio** (perda): **extrapola até 100 ms** com a velocidade dos dois últimos snapshots, sem atravessar parede (checagem barata com `circleBlocked` do espelho). Depois segura parado. O próximo snapshot corrige com blend de 100 ms.
- **Anel médio (7,5 Hz):** os mesmos 133 ms de atraso, só que com amostras mais espaçadas (interpolação mais longa). Aceitável, porque ficam longe do combate.

### 5.2 Predição do próprio movimento

Seção 2.2. Resumo: passo fixo de 30 Hz igual ao do servidor, histórico de comandos, reconciliação com ressimulação e erro visual suavizado (τ = 100 ms, snap acima de 64 u). Há extrapolação de render de até 1 tick com o input vivo, para o movimento começar no mesmo quadro da tecla.

A predição também cobre, só para a HUD: pente (−1 por tiro previsto), barra de recarga e cadência. O bloco próprio de cada snapshot corrige.

### 5.3 Render dos outros jogadores

- **Corpo e pés:** o `drawPlayer` atual, parametrizado por estado (hoje ele lê `this.player`). O ciclo de caminhada vem da velocidade interpolada.
- **Arma e mãos:** pelo `weapon u8`. A lâmina, pelo `swing` relativo.
- **Direção:** `aim` interpolado.
- **Clarão, traçante e som:** pelo `ShotResult`.
- **Figurino e decoração:** vêm de `PlayerJoined` e mudam por delta confiável.
- **Nameplate:** o componente `Nameplate` (`src/client/ui/nameplate.ts`) passa a receber o `Player` no construtor (hoje lê `Players.LocalPlayer`), e há **um por jogador no mundo** (pool). Mostra nível e nome, mais uma barra fina de HP para aliados (melhoria sobre o original: legibilidade em co-op). O derrubado ganha anel de progresso do reviver e contagem do sangramento, **visíveis no escuro** (legibilidade vence realismo, LEG).
- **Luz:** cada jogador em pé projeta sua luz de 250 u no `LightMap` de todos (hoje `drawLight` só usa a do próprio). A lanterna, se equipada, aparece como cone.

### 5.4 Câmera

| Situação | Comportamento |
|---|---|
| Vivo | Segue a si mesmo (`cam.follow`, como hoje) |
| Derrubado | Continua em si; um botão alterna para **seguir um aliado em pé** (o interesse acompanha) |
| Morto (tela de Rebirth/New game) | Por padrão segue o aliado mais próximo; setas ou botões alternam; "Voltar a mim" |
| Admin espectando | Segue qualquer jogador, ou câmera livre (a câmera livre já existe em `camera.ts`), com o interesse centrado nela (seção 10) |

### 5.5 Mudanças de UI decorrentes

- **Pausa e mochila:** viram sobreposição quando há outros jogadores (o personagem fica parado e vulnerável). O mundo só pausa se **todos** estiverem em menu (seção 7.6). Os textos do tutorial ("The game pauses while it's open") precisam de variante em `lang.ts`.
- **HUD:** "Day 14 · your run: 6" (dia do mundo e dia da vida), lista de aliados (nível e HP) e contador de sangramento.
- **Lobby:** botões **Play** (servidor atual), **Play solo** e informações do servidor (jogadores, dia do mundo, modo).

---

## 6. Estado e persistência

### 6.1 O que é de quem

| Dado | Persistido por jogador (DataStore) | Sessão do servidor (morre com ele) |
|---|---|---|
| Nível, XP, pontos e níveis de skill, conquistas | ✅ | |
| Moedas, pacotes (comprados e abertos), figurinos, `runRev`, `deathCount`, `bestDay`, `bossKills` | ✅ (o servidor já é o dono) | |
| Inventário (armas, equipamentos, usáveis, etc), munição, óleo, eletricidade, equipados | ✅ | |
| `day` = **dias sobrevividos nesta vida**, `runOver` | ✅ | |
| **Novo (v3):** `runHp`, `runHunger` (0 = cheio) | ✅ | |
| Configurações, `tutorialDone`, `firstInstall` | ✅ (por intenção validada) | |
| Pente atual | ❌: volta para a reserva ao sair (a mesma regra da troca de arma) | |
| Posição, buffs, i-frames, derrubado | | ✅ (guardado 5 min após desconectar, para retomar no mesmo servidor) |
| Dia e hora do mundo, chuva, filas de ondas, `nextDay` das âncoras de chefe | | ✅ |
| Zumbis, chefes, projéteis, poças | | ✅ |
| Construções (HP, dono, combustível), portas, luzes | | ✅ (como hoje: o mapa já recomeça a cada run) |
| Itens no chão, estado e timers do loot de prédios, cooldown de árvore e carro | | ✅ |

### 6.2 Dia global × recordes pessoais

- O **dia do mundo** (`worldDay`) comanda relógio, ondas, dificuldade (`difficultyOfDay`) e população (`getDayPopulation`).
- O **dia da vida** (`save.day`) conta dias sobrevividos por aquele jogador desde o último New game. Cresce na virada 0h do mundo pelas regras da seção 3.6 e alimenta `bestDay`, marcos e moedas por dia.
- **Servidor novo:** `worldDay` = `save.day` do **primeiro jogador que entra no mundo**, com hora inicial 7h. No solo (reservado ou público vazio) o jogo fica **idêntico ao de hoje**: `DayNight` já começa em `save.day`. Quem entra depois mantém o próprio dia da vida.
- **Custo aceito:** um jogador de dia 1 que entra num servidor de dia 40 enfrenta dificuldade 2. Mitigações: o lobby mostra o dia do mundo antes de entrar, e o Play solo está sempre disponível. Futuro (fora do escopo): lista de servidores por faixa de dia via MemoryStore/MessagingService.

### 6.3 Fim dos relatórios de progresso

- O servidor passa a ter, por jogador em sessão, o `PlayerSaveData` **vivo**, mutado pelos eventos que ele resolve: XP de abate, item pego, loot, craft (consome e produz), construção (consome), uso de item, munição gasta, dia sobrevivido, chefe, conquistas e pacotes entregues (a entrega de `deliverPacks` sai do cliente).
- **Removidos:** `SaveRequest`/`SaveAck`, `sanitizeClientReport`, `applyProgressLimits` e os "créditos" de dia, chefe e nível (a plausibilidade deixa de ser necessária porque o servidor é a fonte). Em defesa de profundidade, fica um teto de sanidade de XP por minuto que só **sinaliza**.
- **Mantidos:** `sanitizeStoredSave` (leitura do DataStore), `enforceSaveInvariants`, a trava de sessão, o autosave de 60 s, o save ao sair e no `BindToClose`, e a loja/Rebirth/New game (`ShopAction`).
- **Cliente:** `ctx.save` vira **espelho somente leitura**. Recebe o save inteiro no `LoadAck` e depois deltas (`Self`). A UI (mochila, HUD, loja) continua lendo `ctx.save` e quase não muda. Toda mutação vira intenção.

### 6.4 Migração do save v2 → v3

- Os campos v2 continuam. Entram `runHp`, `runHunger` e `version = 3`. `day` não muda de valor, só de significado (já era o dia da run).
- **Mesmo DataStore** (`ProjectZ_Save_v2`, documento `{data, lock}`). O `sanitizeStoredSave` v2 descarta chaves desconhecidas, então um servidor antigo que ler um save v3 só perde `runHp`/`runHunger` (inofensivo). O rollback de código também é seguro.
- **Corte no lançamento:** publicar com "desligar todos os servidores". Servidores v2 ainda aceitam relatórios do cliente (a brecha que queremos fechar) e **não podem conviver** com servidores MP.
- **Testar** com uma cópia de save real v2 (e um v1 legado, pelo caminho `ProjectZ_Save_v1` que já existe).

---

## 7. Fluxos

### 7.1 Entrar no servidor

1. `PlayerAdded` → carregar o save com trava (existente) → `LoadAck` com o save, o modo do servidor, `worldDay`, jogadores, seed, hash e `tick0`.
2. O cliente mostra logo e **lobby local** (como hoje) e gera o mapa pelo seed em segundo plano. O jogador **não está no mundo**: não é alvo, não conta em S(k) e não recebe snapshots.
3. **Play:** se `runOver` → escolha de game over (Rebirth/New game). Senão, intenção `JoinWorld`.
4. O servidor escolhe o **ponto de spawn seguro**:
   - **(a)** Se há aliado em pé: anel de 150–400 u ao redor dele (priorizando o aliado com menos zumbis a 600 u).
   - **(b)** Senão: o `findSpawnPoint` atual (rua perto do centro).
   - Restrições: fora de prédio, círculo livre de 40 u (`rectHitsSolid` 80×80), **≥ 900 u de qualquer zumbi vivo**, ≥ 600 u de chefe, fora de poça ou explosão, alcançável (tile ativo ou rua).
   - Relaxa para 600 u de zumbi depois de 200 tentativas.
5. Cria a entidade com `hp = runHp` (ou cheio), fome = `runHunger` e **pente vazio** (recarga automática). **Proteção de spawn de 3 s**: sem dano, não é fonte do flow field e aparece translúcido; acaba antes se o jogador atacar.
6. `WorldInit` (confiável, em blocos) → o cliente aplica os deltas no espelho → primeiro snapshot → mostra o mundo.

### 7.2 Sair e voltar ("continuar")

- **Ir ao lobby** (menu): intenção `LeaveWorld`. Se levou dano nos últimos 5 s, há **canal de 5 s** (o corpo fica, vulnerável, com barra de "saindo…"); senão sai na hora. O estado (posição, HP, fome, buffs) fica guardado na sessão. **Continuar** volta à mesma posição se ela ainda for segura (≥ 600 u de zumbi), senão cai no spawn seguro mais próximo.
- **Desconectar:** o pente volta à reserva; `runHp`/`runHunger` vão para o save (flush com trava, como hoje). O estado de mundo fica 5 min em memória, e se ele voltar ao **mesmo** servidor retoma a posição. **Sair derrubado = morte** (`runOver = true` persistido), para acabar com o "combat log".
- **Servidor desligando** (`BindToClose`): para a simulação, captura HP e fome, trata derrubados como **vivos** (culpa do servidor, não do jogador) e salva todos em paralelo no orçamento de 25 s que já existe.

### 7.3 Derrubado → reviver → morto → Rebirth/New game

| Estado | Regras |
|---|---|
| **Em pé → Derrubado** | HP ≤ 0. Se **não há nenhum aliado em pé no servidor**, pula direto para Morto (sem espera inútil: o solo continua como hoje). |
| **Derrubado** | Sangramento de **30 s**. Rasteja a 20% da velocidade. Não ataca, não interage, não usa item. Continua alvo com prioridade menor (semente +200 no flow field). **Cada mordida tira 3 s** do sangramento (1 s de recarga por zumbi). A câmera pode seguir aliados. |
| **Reviver** | Um aliado em pé a **≤ 70 u** (centro a centro) segura **E por 4 s**. O progresso é do servidor e é contado em ticks com o bit `actionHeld`. Interrompe se o reanimador soltar E, sair do raio ou for derrubado; **tomar dano não interrompe** (defender quem revive é o jogo). Revive com **30% do HP** e 1,5 s de i-frames. E tem prioridade sobre outras interações quando há um derrubado no raio. |
| **Morto** | O sangramento acabou (ou não havia aliado): `runOver = true` salvo. O corpo some com fade. Tela com **Rebirth** (pago, `rebirthPrice(deathCount)` no `ShopAction` existente, idempotente por `runRev`), **New game** (`resetRun`), **Espectar** e **Lobby**. |
| **Rebirth** | Mantém inventário e dia da vida. Renasce no **spawn seguro perto de aliados**, com HP e fome cheios e proteção de 3 s. |
| **New game** | Dia da vida volta a 1 com o kit inicial (o nível, as skills, as moedas e os pacotes ficam, como hoje). Renasce no mesmo mundo. |

### 7.4 Play solo (servidor reservado)

1. Lobby → **Play solo** → intenção `RequestSolo` (limite de 1 a cada 30 s por jogador).
2. O servidor faz `flush(save, release = true)` proativo (encurta a espera de trava no destino) → `TeleportAsync(game.PlaceId, {player}, opts)` com `opts.ShouldReserveServer = true` e dados `{mode: "solo"}`. Usa `pcall` + 5 tentativas + `TeleportInitFailed` (o padrão SafeTeleport da documentação). Se falhar: aviso e o jogador continua no servidor atual.
3. **Destino:** `PrivateServerId ≠ ""` e `PrivateServerOwnerId == 0` indicam servidor **reservado**. Só entra quem é teleportado com o código, então fica solo. O `LOCK_WAIT` que já existe cobre a trava ainda presa no servidor de origem.
4. `worldDay = save.day`, com S(1) e a pausa real disponível: **exatamente o jogo de hoje**.
5. Quando o jogador sai, o servidor esvazia e fecha.

**No Studio:** o TeleportService não funciona em playtest (documentado). Com `RunService.IsStudio()`, o botão vira "Play solo (Studio: servidor local)" e só entra no mundo do servidor de teste. **Como testar de verdade:** publicar num *place de testes* separado (por exemplo "Project Z [dev]", com as mesmas configurações e MaxPlayers 6), entrar pelo cliente Roblox com 1–2 contas, apertar Play solo e conferir no console do desenvolvedor (F9) o `PrivateServerId` e o modo.

### 7.5 Servidores privados (VIP)

- O autor habilita no Creator Dashboard (Audience/Access), grátis ou pago. Um servidor VIP tem `PrivateServerOwnerId ≠ 0`.
- **Regras iguais às públicas** (6 jogadores, S(k), sem PvP). Proposta de comunidade (P2): o dono do VIP pode **expulsar do próprio servidor** (não banir), com registro no log de admin.

### 7.6 Pausa

- O mundo **pausa** (simulação congelada no servidor) se, e só se, **todos** os jogadores no mundo estiverem com pausa ou mochila aberta.
  - Solo: pausa real, como hoje.
  - Grupo: ninguém congela o mundo dos outros.
- Com o mundo rodando, abrir menu só deixa o personagem parado (comandos com input zero). Não há proteção extra: o menu não é esconderijo.

---

## 8. Segurança: validação de toda intenção

### 8.1 Checagens por mensagem

| Mensagem | Checagens no servidor |
|---|---|
| `Input` | É `buffer` com `len == 4 + 8n`, `n ≤ 3`. `seq` dentro de ±64 do último consumido. Token bucket de 60/s (rajada de 20). Os valores são bytes, logo sempre dentro da faixa (NaN impossível). |
| `switchWeapon(id)` | Possui a arma (`ownsWeapon`), não está derrubado nem posicionando construção, ≥ 0,1 s desde a última troca |
| `reload` | A arma usa pente, há reserva e não está no máximo |
| `pickup(itemId)` | O item existe, a distância do servidor é ≤ 40 + 10 u (folga de latência) e não está derrubado |
| `interact(solidId)` (porta, luz, árvore, carro, lixeira) | Distância da borda ≤ 40 u (porta ≤ 30) + 10 u, com linha livre (`segmentClear`). Fechar porta exige não haver ator sobreposto. A árvore e o carro respeitam a recarga global de 0,67 s **por sólido**. |
| `search(buildingId)` | O jogador **está dentro** (`buildingAt` na posição do servidor) e o loot não está vazio. O primeiro pedido processado leva tudo; o seguinte recebe "vazio". |
| `repair(solidId)` | Alcance, é reparável, HP < máximo e material no inventário |
| `craft(recipeId)` | A receita existe, a estação está perto (`stationNear` na posição do servidor), há ingredientes e skills. Até 4/s. |
| `place(x, y, rot)` | Há construção pendente, **≤ 250 u** do jogador, dentro do mundo, fantasma válido (as regras de `build.ts` movidas para `shared/sim/placement.ts`: sem sobrepor sólidos nem atores, sem bloquear porta de prédio). Teto de **150 construções por jogador e 600 por servidor**. Até 2/s. |
| `cancelPlace` | Devolve os ingredientes da receita pendente (servidor) |
| `useItem(id)` | Possui o item e ele tem efeito (`itemUseEffect`). Recarga de 0,25 s. |
| `equip(id)` / `unequip(slot)` | `ownsEquip` + slot correto (`equipSlotOf`) |
| `learnSkill(id)` | `skillPoint > 0` e nível < `maxLevel` |
| `spectate(slot)` | O próprio jogador está derrubado ou morto e o alvo é um aliado, **ou** é admin |
| `JoinWorld` / `LeaveWorld` / `RequestSolo` | Máquina de estados de presença e limite de taxa |
| `settings` | JSON ≤ 1 KB, `readSettings`, até 1 a cada 2 s |
| `ShopAction` | Já existe: token bucket de 6 de rajada a 2/s, `runRev`, preços do servidor |
| Admin | UserId na lista do servidor (`shared/admin/config.ts`), para **toda** requisição |

### 8.2 Limites anti-spam (por jogador)

| Canal | Limite | Excesso |
|---|---|---|
| `Input` | 60 pacotes/s (rajada de 20) | Descarta e conta |
| `Intent` | 20/s (rajada de 30); por tipo, como na tabela acima | Descarta, conta e responde "rate" se for UI |
| `ShopAction` | 2/s (rajada de 6), já existe | "rate" |
| Admin | 10/s | "rate" |
| **Flood** | > 3× o limite por 5 s **ou** > 500 mensagens em 2 s **ou** > 50 payloads malformados em 10 s | **Kick automático** ("network flood"), registrado |

### 8.3 Nunca confiar do cliente

Posição, velocidade, dt/tempo, HP, dano, resultado de acerto, alvo atingido, quem matou quem, XP, nível, contagem de inventário, munição, pente, cooldowns e timers, dispersão/RNG, conteúdo de loot, preços, dia/hora, "estou dentro do prédio", "sou admin" e latência (o servidor mede). O `Player` do remetente vem **sempre** do primeiro argumento do `OnServerEvent`, nunca do payload.

**Atomicidade:** Luau no servidor é single-thread. Toda operação de inventário e loot faz "checar + mutar" **sem yield no meio**, o que torna a duplicação por corrida impossível dentro do servidor. Entre servidores, a trava de sessão do DataStore que já existe impede duas cópias vivas.

---

## 9. Anti-cheat e comunidade

### 9.1 Catálogo de trapaças comuns no Roblox e contramedidas

| Trapaça | Como costuma funcionar | Contramedida nesta arquitetura | Sinal para o painel |
|---|---|---|---|
| Speedhack | Alterar WalkSpeed ou acelerar o relógio do cliente | Não há Humanoid nem posição. O servidor consome 1 comando por tick. **Impossível por construção.** | `inputOverflow` (fila > 4 com frequência) |
| Teleporte / noclip / fly | Setar CFrame, desligar colisão | Não existe campo de posição, e a colisão é do servidor. **Impossível.** | — |
| Aimbot | Mira automática nos zumbis | Não dá para impedir (a mira é input). A cadência, a dispersão secreta, o recuo e o alcance do servidor limitam o ganho. A rebobinagem tem teto. | Precisão e headshot por arma acima do percentil 99,5 do servidor, snaps angulares > 1500°/s repetidos no instante do tiro, abates/min fora da curva |
| Triggerbot | Atira quando a mira cruza o alvo | Idem | Tempo de reação mira→tiro sistematicamente < 40 ms |
| No-spread / no-recoil | Remover dispersão local | A dispersão e o recuo são do servidor, com RNG secreto. **Impossível.** | — |
| Spam de remotes / flood | Disparar remotes em loop | Token buckets por canal; flood leva kick | Contagem por canal |
| Payload malformado (NaN, tabela gigante, tipo errado) | Quebrar o servidor ou achar brecha | Decodificação tipada de `buffer` com tamanho exato, `typeIs` e limites. O erro é descartado. | Malformados/min |
| Dupe de item | Corrida entre remotes, rejoin ou teleporte no meio do save | Inventário só no servidor, ops atômicas, trava de sessão, `runRev` e nenhuma troca entre jogadores | Salto de inventário sem evento de origem (auditoria em debug) |
| Exploit de economia | Forjar relatório ou repetir compra | As moedas só vêm de eventos do servidor. Moedas por dia exigem presença e não estar AFK. Horas puladas por admin não pagam. A loja é idempotente. | Moedas/hora fora da curva |
| Lag switch / manipulação de tempo | Parar de enviar e depois despejar | Sem comandos o personagem **fica parado e vulnerável**. O atrasado é descartado. A rebobinagem tem teto de 300 ms e depende do ping medido. **Dá desvantagem.** | Rajadas de preenchimento seguidas de overflow |
| Wallhack / ESP (estado oculto) | Ler entidades replicadas | **Não enviamos** zumbis no escuro fora de luz, nem o interior de prédio com o jogador fora, nem o conteúdo de loot (o flag de loot só vai de dentro), nem nada fora do raio | — |
| Bot / macro de farm AFK | Ficar parado farmando dias | Moeda por dia exige input nos últimos 3 min. O Roblox já derruba após 20 min ocioso. | Sessões longas sem variação de input |
| Griefing (atrapalhar aliados) | Bloquear porta, puxar horda, abrir a base | Jogadores **não colidem** entre si. Sem fogo amigo. Ninguém destrói construção alheia (só zumbis). Proposta: o construtor pode **trancar** a porta que construiu (abre para ele e amigos Roblox). Denúncia pelo Roblox + kick/ban pelo painel. | Portas alheias abertas à noite (informativo) |
| Combat log | Sair derrubado para não morrer | Sair derrubado conta como morte | — |
| Roubo de abate | Dar só o último tiro | XP de assistência de 60% | — |
| Falsificar admin | Setar atributo local | O servidor checa o UserId em toda requisição (o módulo de admin já faz isso) | Tentativas de admin por não-admin |

### 9.2 Política de resposta proporcional

| Nível | Quando | Ação |
|---|---|---|
| 0: corrigir em silêncio | **Sempre** | O servidor simplesmente não aplica o que é inválido (comando extra, alvo fora de alcance, tiro sem munição). Nada acontece com o jogador. |
| 1: sinalizar | Pontuação de suspeita acima do limiar (decai com o tempo: meia-vida de 10 min) | Aparece em **"Sinalizados"** no painel de admin, com evidências. Nenhuma ação automática. |
| 2: kick automático | **Só abuso inequívoco**: flood de remotes ou enxurrada de payloads malformados (seção 8.2) | `Player:Kick("Network flood")` + log de auditoria |
| 3: ban | **Só por decisão humana** no painel (o `BanAsync` do módulo de admin, com duração e motivo) | Log de auditoria com o admin responsável |

Falso positivo em estatística (aimbot, triggerbot) **nunca** vira punição automática. Um jogador muito bom é só um jogador muito bom até um humano olhar.

### 9.3 O que o admin vê

- **Lista "Sinalizados"** ordenada por pontuação. Por jogador: pontuação, ping, tempo de sessão, e contadores por categoria (entrada, combate, interação, economia, rede).
- **Evidências:** as últimas 20 ocorrências com tick, tipo e detalhe legível. Exemplos: "Pistol: 14 tiros/s pedidos, máximo 4,3/s", "precisão de 97% em 200 tiros (servidor p99 = 71%)", "search em prédio a 900 u".
- **Ações:** espectar (câmera no jogador, seção 10), kick, ban (fluxo existente), limpar sinalização.
- **Métricas do servidor:** tick médio/p95/máx, zumbis vivos, bytes/s por cliente e fila de inputs por jogador.
- As evidências contêm **só dados de jogo** (nada pessoal). Ficam em memória no servidor e vão para o log de auditoria do módulo de admin. Um histórico entre servidores (DataStore `ProjectZ_Flags`) é opcional (F6).

---

## 10. Painel de admin no multiplayer

O módulo de admin em desenvolvimento (`src/shared/admin/*`: autorização por UserId no servidor, `AdminRequest` via RemoteFunction, `AdminOp` para editar save, `BanAsync`) ganha **operações de mundo** no mesmo protocolo. Hoje as ferramentas de mundo "só mexem no próprio mundo simulado" (comentário em `config.ts`); em MP todas viram **ações autoritativas no servidor**, com auditoria.

| Ferramenta | Pedido | O que o servidor faz |
|---|---|---|
| Spawn no mouse (zumbi, especial, chefe) | `{kind: "world", op: "spawn", type, x, y, count}` | O cliente converte o mouse em mundo (`camera.screenToWorld`). O servidor limita ao mundo, move para o ponto livre mais próximo (`circleBlocked`), respeita o teto de 150 (o admin pode ultrapassar até 250 com confirmação) e registra. |
| Hora e dia | `op: "setTime", hour, day?` | Ajusta o relógio do servidor, emite `Clock` imediato e marca as horas puladas como **sem recompensa** |
| Ondas | `op: "wave", n` / `op: "clearZombies"` | Enche a fila da onda agora ou remove zumbis (com um raio opcional) |
| Deus | `op: "god", userId, on` | Flag no servidor: o dano é ignorado. Vai no `modFlags` do bloco próprio para a HUD. |
| Noclip | `op: "noclip", userId, on` | Flag no servidor: o `stepPlayer` daquele jogador pula a colisão. O **cliente prevê com a mesma flag** (vinda do `modFlags`), sem correções. Nunca pode ser ativado por não-admin. |
| Teleporte | `op: "teleport", userId, x, y` ou até outro jogador | O servidor seta a posição. A reconciliação dá snap (> 64 u). |
| Espectar jogador | `op: "spectate", userId` | O **centro de interesse** do admin passa para o alvo. Isso só é possível porque o servidor decide o que cada cliente recebe. |
| Câmera livre | `op: "freecam", x, y, zoom` (5/s) | Interesse centrado na câmera, com raio proporcional ao zoom (teto de 3000 u, anel médio a 5 Hz) |
| Editar save / dar itens | Os `AdminOp` que já existem | Aplicados **direto** no save vivo do servidor (sem o `AdminPatchAck`, porque não há mais relatório do cliente que possa sobrescrever). O cliente recebe o delta pelo `Self`. |
| Aviso global | `announce` (existente) | Opcional: via `MessagingService` para todos os servidores (≤ 1 KB, best effort) |

Toda operação de mundo vai para o log de auditoria (quem, o quê, onde e quando).

---

## 11. Plano de migração em fases

### 11.1 Princípios

- **Cada fase fecha com o jogo jogável.** Uma flag `MP_PHASE` (em `shared/net/mpConfig.ts`) liga os subsistemas no servidor. **O lançamento público do MP é depois da F5.** Até lá o place público pode seguir no modo atual (`MP_PHASE = 0`).
- **Contratos primeiro:** no início de cada fase, **um** agente escreve e mescla os tipos e o protocolo (`shared/net/protocol.ts`, `shared/sim/types.ts`). Só então as frentes paralelas começam.
- **Um arquivo, um dono por fase.** Quem não é dono só lê. Mudanças de contrato passam pelo dono do contrato.
- **Segurança desde o início:** limites de taxa e validação entram na mesma fase de cada mensagem nova. A F6 só acrescenta sinalização, painel e otimização.
- **Arquivos quentes agora:** outros agentes estão editando `src/client/gameLoop.ts`, `src/shared/engine/renderer.ts` e `src/*/admin`. A F0 só começa **depois** desses merges, e as frentes que tocam `gameLoop.ts` fazem rebase antes.

### 11.2 Mapa de movimentação de módulos

| Hoje | Destino | Observação |
|---|---|---|
| `client/systems/zombieAI.ts` | `server/sim/zombieAI.ts` | Multi-jogador (`targetOf`), sem `getCtx`, separação por hash |
| `client/systems/bossAI.ts` | `server/sim/bossAI.ts` | |
| `client/systems/spawner.ts` | `server/sim/spawner.ts` + `server/sim/population.ts` | Aglomerados e S(k) |
| `client/systems/daynight.ts` | `shared/sim/clock.ts` (matemática pura) + `server/sim/waves.ts` | O cliente usa `clock.ts` para exibir |
| `client/systems/combat.ts` | `server/sim/combat.ts` + `client/predict/weaponFx.ts` | Resolução no servidor, cosméticos no cliente |
| `client/systems/interaction.ts` | `server/sim/interaction.ts` + `shared/sim/interactQuery.ts` | As consultas puras servem à dica **e** à validação |
| `client/systems/build.ts` | `shared/sim/placement.ts` (`PLACEABLES`, validade) + `client/view/buildGhost.ts` + `server/sim/build.ts` | |
| `client/systems/craftSystem.ts` | `shared/sim/crafting.ts` (puro) + `server/sim/craft.ts` | |
| `client/systems/items.ts` | `shared/sim/inventory.ts` | Usado pelo servidor; o cliente só lê |
| `client/systems/particles.ts` | `client/view/particles.ts` | Continua no cliente |
| `client/systems/saveClient.ts` | `client/net/session.ts` | Sem relatórios |
| `client/systems/types.ts` (`GameRefs`) | `server/sim/types.ts` (`SimRefs` com `players[]`) + `client/view/viewState.ts` | |
| `FlowField` em `shared/game/physics.ts` | `server/sim/flowField.ts` (multi-fonte) | `physics.ts` fica com `moveActor`/raycast, compartilhados |
| `GameLoop.updatePlayer` | `shared/sim/playerMove.ts` (`stepPlayer`) | Predição e servidor usam o mesmo código |
| Desenho em `gameLoop.ts` | `client/view/{worldView,actorsView,fxView}.ts` | `gameLoop.ts` vira laço fino de quadro |
| `server/main.server.ts` | `server/main.server.ts` (boot) + `server/save/{store,session,economy}.ts` + `server/net/*` + `server/sim/*` | |
| `shared/net/net.ts` | Mantém load e loja; entram `protocol.ts`, `codec.ts`, `snapshot.ts`, `mpConfig.ts` | |

### 11.3 Fases

#### F0: Fundação e contratos (sem mudar o jogo) · **M** · ~2 agente-dias

| Frente | Dono | Arquivos (cria / edita) |
|---|---|---|
| 0A Rede base | agente A | cria `shared/net/codec.ts`, `shared/net/protocol.ts`, `shared/net/mpConfig.ts` |
| 0B Simulação pura | agente B | cria `shared/sim/playerMove.ts`, `shared/sim/inventory.ts`, `shared/sim/interactQuery.ts`, `shared/sim/placement.ts`, `shared/sim/clock.ts`; edita `client/systems/items.ts`, `build.ts` e `daynight.ts` (passam a reexportar ou usar os puros) |
| 0C Desacoplar | agente C | edita `client/systems/zombieAI.ts`, `combat.ts`, `bossAI.ts`, `spawner.ts`, `interaction.ts`, `types.ts` (fim do `getCtx`: efeitos viram `refs.fx`; `refs.players[]` com `refs.player = players[0]`) e `client/ui/nameplate.ts` (recebe o `Player`) |
| 0D Laço | agente D (**único dono de `gameLoop.ts`**) | `gameLoop.ts` passa a chamar `stepPlayer`, consome `refs.fx` para tremida e partículas, e passa o `Player` ao `Nameplate` |

- **Aceitação:** o solo joga **idêntico** (roteiro de playtest: andar, atirar, golpear, abrir porta, revistar, craftar, construir, morrer, Rebirth). Build, lint e `validate:world` verdes. Zero `getCtx` em `client/systems/*` fora de `particles`/`build` UI. Autoteste de determinismo do `stepPlayer` (a mesma sequência de 300 comandos dá o mesmo hash duas vezes).
- **Riscos:** conflito com os agentes de `gameLoop.ts`/`renderer.ts` (mitigado pela ordem de merge). Regressão sutil de sensação ao extrair `stepPlayer` (mitigado pelo roteiro de playtest).

#### F1: Movimento autoritativo e ver os outros · **L** · ~4 agente-dias

Os zumbis ainda são **locais em cada cliente**, com `MP_PHASE = 1` (só para testes internos).

| Frente | Dono | Arquivos |
|---|---|---|
| 1A Servidor | agente A | cria `server/net/remotes.ts`, `server/sim/simulation.ts` (tick de 30 Hz só com jogadores), `server/sim/players.ts` (entidades e fila de inputs), `server/net/replication.ts`, `server/net/interest.ts`; edita `server/main.server.ts` (só o boot) |
| 1B Rede do cliente | agente B | cria `client/net/netClient.ts`, `client/net/commands.ts` (amostragem, redundância, dilatação), `client/net/prediction.ts`, `client/net/snapshotBuffer.ts` |
| 1C View | agente C (dono de `gameLoop.ts`) | cria `client/view/playersView.ts` e o pool de nameplates; edita `gameLoop.ts` (posição do próprio jogador vinda da predição, outros jogadores, luz de todos) |

- **Aceitação:**
  - 3 clientes no Studio com 100 ms simulados em cada sentido se veem andando **suavemente**.
  - Divergência p99 < 1 u; correções > 16 u < 1/min fora de knockback.
  - Um **cliente modificado** (debug) que envia 2× comandos **não** anda mais rápido e aparece em `inputOverflow`.
  - Banda ≤ 2 KB/s por cliente.
- **Riscos:** determinismo do `moveActor` entre instâncias (mitigado pelo autoteste por hash). Portas diferentes entre os mundos locais nesta fase (esperado; corrigido na F3).

#### F2: Mundo e combate no servidor · **XL** · ~7 agente-dias

| Frente | Dono | Arquivos |
|---|---|---|
| 2A IA e população | agente A | move `zombieAI.ts`, `bossAI.ts`, `spawner.ts` → `server/sim/`; cria `server/sim/flowField.ts` (multi-fonte), `server/sim/population.ts`, `server/sim/spatialHash.ts`; remove `FlowField` de `shared/game/physics.ts` |
| 2B Relógio e ondas | agente B | cria `server/sim/waves.ts`; usa `shared/sim/clock.ts`; remove `client/systems/daynight.ts` do laço do cliente |
| 2C Combate e progresso | agente C | move `combat.ts` → `server/sim/combat.ts`; cria `server/sim/history.ts` (rebobinagem), `server/sim/progress.ts` (XP, abates, conquistas no save vivo), `client/predict/weaponFx.ts` |
| 2D Replicação e view | agente D (dono de `gameLoop.ts` e `shared/net/snapshot.ts`) | escreve **primeiro** o contrato do snapshot; estende `replication.ts` (zumbis, chefes, Fx); cria `client/view/actorsView.ts` e `fxView.ts` (saídos de `gameLoop.ts`) |

- **Aceitação:**
  - 3 clientes veem **os mesmos** zumbis (mesmos `netId`; posições ±4 u depois da interpolação).
  - Tick **p95 ≤ 10 ms** com 150 zumbis (spawn de admin) e 6 jogadores (3 reais + 3 bots, seção 12).
  - Com 150 ms de RTT, **≥ 95%** dos tiros que acertam na tela do atirador registram no servidor.
  - O XP só vem do servidor (os campos `level`, `exp`, `bossKills` e `day` dos relatórios passam a ser **ignorados**).
  - Banda p95 ≤ 20 KB/s por cliente no pior cenário.
- **Riscos:** CPU do flow field (orçamento por tempo + LOD). Sensação de combate (cosméticos previstos precisam ser bons). Zumbis "atrasados" parecendo morder de longe (flag de mordida justa).

#### F3: Itens, interação, construção e inventário autoritativos; save v3 · **L** · ~5 agente-dias

| Frente | Dono | Arquivos |
|---|---|---|
| 3A Mundo interativo | agente A | cria `server/sim/interaction.ts`, `server/sim/items.ts`, `server/sim/build.ts`, `server/sim/craft.ts`, `server/sim/fires.ts`; deltas `World` |
| 3B Save e economia | agente B | divide `server/main.server.ts` em `server/save/{store,session,economy}.ts`; `shared/game/save.ts` v3; **remove** `SaveRequest`/`SaveAck`, `sanitizeClientReport`, `applyProgressLimits` e os créditos; cria `client/net/session.ts` (substitui `saveClient.ts`) e o canal `Self` |
| 3C UI | agente C | `client/ui/backpack.ts`, `hud.ts` e `shop.ts` leem o espelho e enviam intenções (usar, equipar, craftar, aprender skill); `client/view/buildGhost.ts`; textos em `shared/data/lang.ts` |

- **Aceitação:**
  - Um cliente de debug que envia um "save forjado" **não tem efeito** (o remote nem existe).
  - Dois clientes revistam o mesmo prédio ao mesmo tempo e **só um** recebe.
  - Porta e construção de um jogador aparecem para todos em ≤ 200 ms.
  - Migração v2 → v3 testada com cópia de save real (e v1 legado).
  - Crafting e construção funcionam em co-op.
- **Riscos:** regressões na UI da mochila (grande: 1279 linhas). Latência percebida ao usar itens (mitigação: feedback otimista só visual, com o botão em "pendente" até o ack).

#### F4: Vida e morte cooperativas e fluxos de presença · **M** · ~3 agente-dias

| Frente | Dono | Arquivos |
|---|---|---|
| 4A Servidor | agente A | cria `server/sim/downed.ts` (sangramento e reviver), `server/sim/spawnPoint.ts` (spawn seguro), `server/sim/presence.ts` (Join/Leave/Continue, canal de saída, sessão de 5 min, regra de pausa); integra Rebirth e New game |
| 4B Cliente | agente B | `client/ui/pauseMenu.ts` e `hud.ts` (derrubado, sangramento, reviver, tela de morte com Espectar), `client/view/spectate.ts`, `client/ui/lobby.ts` (Continue e informações do servidor), `main.client.ts` (fluxo de fases) |

- **Aceitação:** roteiro com 2 clientes: derrubar → reviver; derrubar → sangrar até a morte → Rebirth (inventário mantido) → New game (kit inicial) → espectar. Sair derrubado = `runOver`. Solo sem espera de 30 s. Pausa: solo congela, grupo não. Spawn nunca a < 900 u de zumbi (log de verificação).
- **Riscos:** estados de borda (reviver quando o alvo desconecta, morrer durante o canal de saída). Mitigação: máquina de estados única no servidor com testes de roteiro.

#### F5: Tipos de servidor · **S–M** · ~1,5 agente-dia

| Frente | Dono | Arquivos |
|---|---|---|
| 5A | agente A | cria `server/net/teleport.ts` (SafeTeleport, `RequestSolo`), detecção de modo (reservado, VIP, público), `BindToClose` com captura do estado de run; botão e estados no `lobby.ts` (coordenado com o dono de F4B) |
| Manual (autor) | — | Creator Dashboard: **MaxPlayers = 6**, habilitar servidores privados, criar o place de testes "Project Z [dev]" |

- **Aceitação (no place de testes publicado):** Play solo abre um servidor reservado com 1 jogador e o mesmo save. VIP funciona. Desligamento salva todos (log). **Lançamento público** possível daqui em diante.
- **Riscos:** o teleporte só é testável fora do Studio. Trava de sessão presa na ida (o flush proativo e o `LOCK_WAIT` cobrem).

#### F6: Anti-cheat, admin autoritativo e otimização · **M–L** · ~4 agente-dias

| Frente | Dono | Arquivos |
|---|---|---|
| 6A Anti-cheat | agente A | cria `server/sim/anticheat.ts` (contadores, pontuação, evidências, kick por flood); acrescenta ao protocolo de admin a lista "Sinalizados" (coordenado com o dono de `shared/admin/protocol.ts`) |
| 6B Admin de mundo | agente B (dono do admin) | operações da seção 10 no servidor; espectar e câmera livre no `interest.ts` (coordenado com o dono de `server/net/interest.ts`) |
| 6C Desempenho | agente C | cria `server/dev/bots.ts` (jogadores sintéticos com input roteirizado, só no Studio); passo de pós-build que prefixa `--!native` em `out/server/sim/*.luau` (**verificar** se o rbxtsc preserva o cabeçalho; senão, usar script em `tools/`); ajuste de LOD, anéis e codificação delta |

- **Aceitação:** sinalizações aparecem com evidências para um cliente de debug que pede 3× a cadência. Flood leva kick. Ferramentas de admin funcionam em MP e ficam no log. Metas de CPU e banda cumpridas com 6 jogadores (3 reais + 3 bots) por 20 min de noite.
- **Riscos:** falsos positivos (mitigação: limiares por percentil do servidor, nada automático além de flood). O `--!native` aumenta memória e tempo de boot (a doc avisa). Medir.

| Fase | Tamanho | Agente-dias | Frentes paralelas |
|---|---|---|---|
| F0 | M | 2 | 4 |
| F1 | L | 4 | 3 |
| F2 | XL | 7 | 4 |
| F3 | L | 5 | 3 |
| F4 | M | 3 | 2 |
| F5 | S–M | 1,5 | 1 (+ passos manuais) |
| F6 | M–L | 4 | 3 |
| **Total** | | **~26,5** (22–28 com incerteza) | |

---

## 12. Plano de teste

### 12.1 Studio: servidor local + 2–3 clientes

1. Na aba **Teste** ("Test"), escolher o modo **Servidor e clientes** ("Server & Clients"), selecionar **2 ou 3 jogadores** (suporta de 1 a 8) e clicar em **Iniciar**.
2. Abrem uma janela de **servidor (borda verde)** e uma por **cliente (borda azul)**. Encerrar em qualquer uma fecha todas.
3. **Simulação de rede** (configuração de teste do Studio): atraso de entrada e de saída de **50–150 ms cada** (o RTT é a soma), jitter de 20 ms e perda de 1–2%. Vale para o modo multi-cliente.
4. **Observar cada cliente:** cada janela azul é um jogador; lado a lado dá para comparar posições. Em cada uma, o console do desenvolvedor (F9) mostra os logs daquele cliente. Na verde, os do servidor.
5. **Jogadores de teste** têm UserIds de teste (não o do admin). O painel de admin precisa de um **bypass só no Studio** (`RunService.IsStudio()`), decisão do dono do módulo de admin. O DataStore segue a regra atual ("unavailable" no Studio sem acesso à API).
6. **Carga de 6 jogadores:** 2–3 clientes reais + **bots** no servidor (`server/dev/bots.ts`, entidades de jogador sem `Player`, com input roteirizado: andar em círculos, atirar e revistar), só no Studio.

### 12.2 Métricas e como medir

| Métrica | Como | Alvo |
|---|---|---|
| Tempo de tick do servidor | `os.clock()` por etapa, num anel de 300 amostras. Publicado a cada 1 s em atributos (`workspace:SetAttribute("pz_tick_avg_ms" / "pz_tick_p95_ms")`) e no painel de admin. MicroProfiler e aba Server Jobs para confirmar que o heartbeat fica perto de 60. | média ≤ 6 ms, p95 ≤ 10 ms |
| Banda por cliente | O servidor soma `buffer.len` + overhead estimado por `FireClient` (atributo `pz_out_Bps` por `Player`). No cliente, Performance Stats (Recv/Sent) e a aba Network do console. | p95 ≤ 20 KB/s no pior caso; ≤ 6 KB/s no típico |
| Divergência de posição | Em cada ack, `|previsto(ack) − servidor|` num anel no cliente. Overlay de debug + atributo `pz_pred_err_p99` no `LocalPlayer`. | p99 < 1 u; correções > 16 u < 1/min |
| Concordância de acerto | Em debug, o cliente registra o `netId` que previu acertar por tiro; o `ShotResult` traz o real | ≥ 95% com 150 ms de RTT |
| Fila de inputs | `bufDepth` e `inputOverflow` por jogador | profundidade média entre 1,5 e 2,5; overflow ≈ 0 |
| Latência simulada | As configurações acima; conferir o ping com `Player:GetNetworkPing()` no servidor | — |
| Determinismo | Autoteste: a mesma sequência de 300 comandos no servidor e em cada cliente → hash do estado final | hashes iguais |

**Cenários roteirizados** (com o painel de admin): (1) dia, 3 jogadores espalhados; (2) noite às 22h, horda máxima de 150 zumbis, 6 jogadores juntos numa base com lampiões; (3) 6 jogadores espalhados (pior caso do flow field); (4) derrubar e reviver com 150 ms; (5) dois clientes revistando o mesmo prédio no mesmo tick; (6) um cliente de debug trapaceando (2× comandos, 3× cadência, `search` a 900 u, flood).

### 12.3 Validação com o MCP do Studio (proposta de verificação)

**Hipótese:** num teste Server & Clients, cada janela (servidor e cada cliente) é uma instância separada do Studio e pode aparecer como uma entrada distinta em `list_roblox_studios`.

**Como verificar:**

1. Iniciar o teste com 2 clientes.
2. Chamar `list_roblox_studios`. Esperado: além da janela de edição, **3 entradas** (servidor + 2 clientes).
3. Em cada entrada, rodar um trecho de Luau que se identifica:
   ```lua
   local rs = game:GetService("RunService")
   local lp = game:GetService("Players").LocalPlayer
   return { server = rs:IsServer(), client = rs:IsClient(), who = lp and lp.Name or "server" }
   ```
4. Se confirmado:
   - Ler as métricas por instância: atributos do servidor (`pz_tick_*`, `pz_out_Bps`) e de cada cliente (`pz_pred_err_p99`, profundidade do buffer de interpolação).
   - Tirar **screenshot por cliente** no mesmo instante, para comparar posições de zumbis e jogadores.
   - Rodar o autoteste de determinismo em cada instância e comparar os hashes.
   - Disparar os cenários pelo servidor (spawn de horda, hora 22h) e observar os clientes.
5. **Se `list_roblox_studios` mostrar só a janela de edição:** a telemetria sai por logs estruturados no Output de cada janela (prefixo `[pz-metrics]`) e pelo painel de admin (que já mostra as métricas do servidor). A comparação visual fica manual.

---

## 13. Regras novas propostas para a bíblia (categoria MP)

> **Só proposta.** Nada foi editado em `docs/DESIGN_RULES.md`. Formato idêntico ao da bíblia.

- **MP-01 [revisão]** ✅ Tiros, flechas, fogo, choque e golpes **atravessam aliados**; torretas e armadilhas nunca afetam jogadores. ❌ Qualquer dano de jogador em jogador. *Exceção proposta:* a explosão do exploder fere todos no raio, porque é ataque do zumbi (P3).
- **MP-02 [revisão]** ✅ Jogadores **não colidem entre si** (passam um pelo outro). *Motivo:* anti-griefing (ninguém tranca uma porta ou um beco com o corpo). Exceção documentada a COL-01.
- **MP-03 [revisão]** ✅ Reviver: aliado em pé a **≤ 70 u** segura E por **4 s**; tomar dano não interrompe. Sangramento de **30 s**, −3 s por mordida. Revive com 30% do HP. Sem aliado em pé no servidor, não há espera.
- **MP-04 [auto, via teste de simulação]** ✅ **Spawn seguro**: fora de prédio, sobre chão livre, **≥ 900 u de qualquer zumbi**, com 3 s de proteção. ❌ Nascer à vista de um zumbi ou dentro de um sólido (reforça COL-03).
- **MP-05 [revisão]** ✅ **Loot de prédio compartilhado**: quem revistar primeiro leva tudo; renasce a cada **12 h de jogo** do relógio do mundo. O conteúdo só é revelado a quem revista.
- **MP-06 [revisão]** ✅ Itens no chão: o primeiro pedido válido leva. ❌ Item "reservado" para quem matou (sem dono = sem disputa).
- **MP-07 [revisão]** ✅ O que o jogador **não vê, o cliente não recebe**: interior de prédio com telhado (jogador fora), zumbi no escuro fora de toda luz, conteúdo de loot. *Motivo:* anti-wallhack, coerente com EDI-04 e LUZ-03.
- **MP-08 [revisão]** ✅ **Legibilidade co-op**: cada aliado tem nameplate com nível e barra de HP. O derrubado mostra anel de reviver e contagem **visíveis no escuro**. As luzes dos aliados iluminam para todos (LUZ-02: o jogador é fonte de luz).
- **MP-09 [revisão]** ✅ Horda escala por aglomerado: **S(k) = 1 + 0,5·(k − 1)**. Teto de 150 zumbis por servidor. ❌ Zumbi nascendo a < 720 u de qualquer jogador.
- **MP-10 [revisão]** ✅ **Pausa** só congela o mundo se **todos** os jogadores estiverem em menu. ❌ Um jogador congelar o mundo dos outros.
- **MP-11 [revisão]** ✅ Construções só são danificadas por zumbis. ❌ Jogador destruir ou desmontar construção alheia. *Proposta:* o construtor pode trancar a porta que construiu.
- **MP-12 [revisão]** ✅ **Sair derrubado conta como morte**. Sair em combate (dano nos últimos 5 s) tem canal de 5 s.
- **MP-13 [revisão]** ✅ HUD mostra **dia do mundo** e **dia da vida**. Recordes e moedas por dia são pessoais e exigem presença (≥ 50% do dia, sem AFK).
- **MP-14 [revisão]** ✅ **Solo é o jogo de hoje**: com um jogador só, S(1) = 1, pausa real, sem espera de derrubado e dia herdado do save. *Motivo:* P2 (o MP não pode piorar o solo).

---

## 14. Riscos gerais e questões abertas

### 14.1 Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| CPU do servidor com 150 zumbis e flow field multi-fonte em Luau interpretado | Heartbeat < 60 e lag geral | Orçamento por tempo, LOD, hash espacial, teto ajustável, `--!native` e, por último, Actors |
| Sensação de combate com latência (traçante divergente, zumbi "atrasado") | Percepção de jogo "pesado" | Cosméticos previstos bem feitos, rebobinagem de 300 ms, mordida justa, interpolação adaptativa |
| Divergência de predição (portas e construções de terceiros) | Tremidas | Deltas confiáveis rápidos, suavização de 100 ms, autoteste de determinismo |
| Banda acima do previsto (overhead por evento desconhecido) | Lag em conexões ruins | Medir na F2; alavancas da seção 4.7 |
| Teleporte e reservados não testáveis no Studio | Bugs só em produção | Place de testes publicado desde a F5 |
| Convivência de servidores v2 (que aceitam relatórios) com MP | Brecha de economia | Desligar todos os servidores no lançamento |
| Conflitos entre agentes em arquivos grandes (`gameLoop.ts`, `backpack.ts`, `main.server.ts`) | Retrabalho | Um dono por arquivo por fase; contratos primeiro; rebase depois dos merges em andamento |
| Tamanho do refactor da UI (a mochila tem 1279 linhas) | Atraso na F3 | Espelho somente leitura mantém a leitura da UI; só as mutações viram intenção |

### 14.2 Decisões do autor (22 set 2026)

1. **Explosão do exploder fere aliados:** sim, com **50% do dano** (é um perigo do ambiente, não PvP; ensina o grupo a se espalhar).
2. **XP:** assistência de **60%** e XP de chefe para **todos os participantes**.
3. **Derrubado:** **rasteja a 20%** da velocidade; não ataca nem usa itens.
4. **Portas construídas:** **trancáveis pelo dono**; trancada, só o dono abre (anti-griefing).
5. **Dia inicial do mundo:** servidores **públicos começam no dia 1**; servidor **solo/privado continua no dia do dono**.
6. **Curva S(k):** 0,5 por jogador extra como ponto de partida; ajustar no playtest.
7. **Colisão entre jogadores:** desligada (MP-02) — ninguém bloqueia portas de outros.
8. **Dono de servidor VIP pode expulsar** do próprio servidor.
