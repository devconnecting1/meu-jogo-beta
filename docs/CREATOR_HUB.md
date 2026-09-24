# Creator Hub: o que configurar, e por quê

Decisões de configuração da experiência no Creator Hub, ancoradas no que o jogo **é**: sobrevivência zumbi
co-op 2D top-down, servidor autoritativo, **6 jogadores** por servidor (MP-01), sem pay-to-win, ainda privado.

O que o Open Cloud consegue mudar está marcado `[api]` — o resto é mão no painel, e está dito onde e por quê.

---

## Já aplicado por API (verificado lendo de volta)

| Campo | Era | É | Por quê |
| --- | --- | --- | --- |
| `serverSize` | **50** | **6** | O host tem 6 vagas (`MAX_PLAYERS`). Com 50, do 7º jogador em diante a pessoa entra, fica no lobby e **nunca recebe corpo no mundo** — o servidor não tem slot. Era a configuração mais errada do painel. |
| `vrEnabled` | true | **false** | O jogo é desenhado em `ScreenGui` 2D. Em VR não há o que renderizar: o jogador entraria numa experiência quebrada. |

Estado atual confirmado: `ageRating AGE_RATING_13_PLUS`, `voiceChatEnabled false`, `visibility PRIVATE`,
desktop/mobile/tablet/console habilitados.

**A API aceita e ignora `displayName` e `description`** (responde 200, devolve o valor antigo e não mexe no
`updateTime`). Esses dois são obrigatoriamente manuais.

---

## Configure

### Settings — **faça antes de publicar**

- **Nome**: hoje é "Experiência sem título". O nome no repositório é **Project Z**.
- **Descrição**: está vazia. Sugestão, escrita a partir do que o jogo realmente faz:

  > Survive the night in a town that has already fallen.
  >
  > Scavenge houses for food, ammo and parts. Build barricades before dusk. Then hold the line: every night
  > the horde is bigger than the last, and the zombies see you, hear you, remember where you were and call
  > the others.
  >
  > Play alone or with up to 5 survivors in the same town. Shared world, shared loot, and a downed friend can
  > be picked back up.
  >
  > No pay-to-win: everything that decides whether you live through the night is earned in the game.
  >
  > Rules: play fair (no exploits, cheats or scripts, no abusing bugs), be kind in chat, keep personal
  > information private, don't ruin the game for other survivors on purpose, and follow the Roblox Community
  > Standards. Breaking a rule can get you kicked or banned; only a person bans, never the game on its own.
  > Appeals: message us through our group: <link do grupo>.

  A linha do pay-to-win não é marketing: é a regra que já governa a loja, e dizê-la na página filtra a
  expectativa certa de quem entra. **As regras e o recurso são obrigatórios** (diretrizes de ban do Roblox:
  regras que todo usuário possa ler, e um jeito de recorrer ao criador): são o mesmo texto de
  `src/shared/data/rules.ts` (no jogo em How to play › Rules), e a mensagem de ban aponta para **esta página**,
  que é o único lugar que um jogador banido ainda consegue abrir. Troque `<link do grupo>` pelo link do grupo
  e ponha o mesmo grupo em **Social links**.
- **Classificação**: não se escolhe aqui — sai do questionário (abaixo, "Maturity & Compliance"). Com as
  respostas honestas o jogo fica **Moderate (13+)**: o sobrevivente derrubado rasteja sangrando (consequência
  realista = violência moderada) e há sangue de pixel a cada golpe, poças por 10 s e manchas secas no mapa.
- **Gêneros**: Survival como principal; Action como secundário.
- **Dispositivos**: desktop, celular e tablet ligados (temos controles de toque medidos em 500 combinações de
  tela). **Console pode ficar ligado** — o suporte a gamepad existe e foi construído junto. VR desligado.

### Places — **feito**

`serverSize` = 6. Não mexa para cima sem mudar `MAX_PLAYERS` no código junto: os dois números **são o mesmo
número**, e se divergirem o sintoma é um jogador fantasma no lobby.

### Custom matchmaking — **só dois atributos, sem fila** (MP-24)

Fila continua fora: não há partida para enfileirar. Mas um jogador novo não pode cair num mundo público no dia 23
(`docs/MULTIPLAYER.md` §7.4), e o servidor público já publica dois números para isso (`server/match/matchmaking.ts`,
`MatchmakingService:SetServerAttribute`, só quando mudam). Sem os passos abaixo o jogo funciona igual (a oferta de
cidade nova no lobby continua valendo) e o log avisa uma vez "the matchmaking attributes were refused".

1. **Matchmaking → atributos de servidor** (a página "Customize your matchmaking configuration"): crie
   `WorldDay` (número, padrão 1) e `Survivors` (número, padrão 0). Os nomes são os do código: não traduza.
2. **Uma configuração de pontuação** a partir da padrão (mantenha _Friends_ 15, _Occupancy_ 2 etc.) com um **sinal
   customizado numérico de servidor**: atributo `WorldDay`, comparado a uma **constante** 1, `maxRelevantDifference`
   10 (dia 11 em diante já pontua 0), peso 3. Quem entra passa a preferir cidades jovens; amigos continuam juntos.
3. Opcional: um segundo sinal numérico de servidor com `Survivors` contra a constante 6, `maxRelevantDifference` 6,
   peso 1: a pontuação cresce com quem está de pé, e uma cidade onde todos estão mortos (que vai acabar, MP-22) pontua
   0. Ligue só se o painel mostrar gente chegando em cidades à beira do fim.
4. **Prévia com servidores de mentira** (a própria página oferece) antes de ativar. Um atributo **de jogador** (o
   recorde) não é usado: ele seria lido de um data store por um caminho JSON, e o save guarda o `data` como texto.

### Server management — **Play solo feito; VIP é decisão sua**

O "jogar sozinho" que você pediu é o **Play solo** da tela Survivor: um servidor **reservado** pelo próprio jogo
(`TeleportService:ReserveServerAsync` + `TeleportAsync`), com as mesmas regras do público e a cidade no dia 1
(`docs/MULTIPLAYER.md` §7.4, MP-24). Não precisa de configuração nenhuma aqui, e **só funciona no jogo publicado**: no
Studio a tela explica que não há teleporte. Teste numa experiência de teste separada (o roteiro está na §7.4). O
servidor privado (VIP) é independente: ligue se quiser vendê-lo ou dá-lo; o jogo o reconhece sozinho
(`pz_server_kind = private`). O que **não** pode acontecer continua sendo o solo virar um modo pior que o co-op — MP-14.

### Permissions / Collaborators — **só você, por enquanto**

Cada colaborador com acesso de escrita pode publicar e ler DataStore. Adicione um por vez, quando houver
motivo, e prefira o papel mais fraco que resolva.

### Configs — **vale a pena, depois da F2**

Permite mudar número de balanceamento sem republicar. Os nossos candidatos naturais são os que já sabemos
que vão pedir ajuste: `SIM_HZ`, o alcance de visão dos zumbis, o teto da horda e o raio do chat. Fazer antes
da F2 fechar é ajustar um alvo em movimento. O gancho de código já existe (`src/server/config/experiments.ts`, a
chave `pz_welcome_pack`): uma config só faz algo quando o código a lê (`docs/ANALYTICS.md` §12).

### Experiments — **depois de ter jogadores**

Teste A/B sem base de jogadores não mede nada: a própria página avisa que com menos de 1.000 DAU é difícil ter dado
útil (MDE). O código já lê o knob por jogador e a inscrição acontece só quando o valor é usado; passo a passo e as três
propostas (pacote de boas-vindas, primeira noite mais leve, preço do Rebirth) em `docs/ANALYTICS.md` §12.

### Alerts — **ligue assim que tiver 100+ DAU**

Crash, memória, FPS, CCU e data store — é o que avisa que algo quebrou sem depender de alguém reclamar. A página não
oferece alerta de **taxa de erro** (só métricas de performance e de data store): erros se olham no Error Report depois
de cada publish. Precisa de um webhook (Configure → Webhooks). Lista com limites em `docs/ANALYTICS.md` §13.

### Secrets — **não precisamos**

O jogo não chama serviço externo nenhum. A nossa chave de Open Cloud vive no `.env` local, fora do jogo, e
**não** deve ser colocada aqui.

### Webhooks — **opcional (depois dos modelos de RTBF)**

Um gatilho **Right to Erasure Request** (com segredo) avisa na hora de um pedido de exclusão, em vez de
esperar a mensagem diária da caixa de entrada. Não é bloqueante: os modelos de RTBF (abaixo) apagam sozinhos
o que cabe neles, e o resto sai com `npm run cloud -- erase <userId> --yes`.

### Data Stores manager — **RTBF: faça antes de publicar**

O Roblox manda **todo dia** para a caixa de entrada do Creator Hub a lista de pedidos de exclusão de dados
(direito ao esquecimento, RTBF), e quem responde por apagar é o criador. O caminho recomendado são os **modelos
de exclusão**: com eles, o Roblox apaga sozinho as chaves de quem pediu.

**Checklist — Configure → Data Stores Manager → RTBF → Create template** (uma linha por modelo):

| # | Tipo | Data store | Chave (`key pattern`) | Escopo |
| --- | --- | --- | --- | --- |
| 1 | Standard | `ProjectZ_Save_v2` | `{UserId}` | `global` |
| 2 | Standard | `ProjectZ_Save_v1` | `{UserId}` | `global` |
| 3 | Standard | `ProjectZ_Titles` | `{UserId}` | `global` |
| 4 | Standard | `ProjectZ_Save_v2_studio` | `{UserId}` | `global` |
| 5 | Standard | `ProjectZ_Save_v1_studio` | `{UserId}` | `global` |
| 6 | Standard | `ProjectZ_Titles_studio` | `{UserId}` | `global` |

- [ ] Escreva `{UserId}` exatamente assim (`{userId}` não vale) e confira a **amostra** de cada modelo: um UserId
      de teste deve virar a chave `12345` no escopo `global`.
- [ ] **Se o painel recusar a chave `{UserId}` sozinha**, não mude as chaves do jogo: use o comando abaixo para
      cada pedido da mensagem diária.
- [ ] `ProjectZ_AdminLog` **não tem modelo**: é um log com vários jogadores por chave (uma por servidor por dia,
      `log_AAAAMMDD_<job>`). Ele guarda só UserIds e texto filtrado (`server/admin/auditLog.ts`); para cada pedido,
      `npm run cloud -- erase <userId> --yes` tira as entradas sobre aquele jogador. **Limite:** o `erase` acha as
      entradas pelo UserId (o admin que agiu ou o jogador alvo). Um motivo de kick/ban ou um anúncio **filtrado**
      que cite alguém pelo nome, em palavras, continua lá: se um pedido citar isso, procure o nome no painel de
      admin (Server › Audit log) e apague a entrada à mão pelo Data Stores Manager.
- [ ] `ProjectZ_Worlds` não tem dado de jogador (semente, dias, JobId, uma contagem): fica de fora.
- [ ] **Uma chave de Open Cloud só para isto:** crie uma chave com **apenas** as permissões de data store —
      ler, listar, atualizar e apagar **entradas** — para o universo do jogo, restrita ao seu IP, e ponha no `.env`
      como `ROBLOX_ERASE_API_KEY`. É separada da `ROBLOX_API_KEY` do `publish` / `upload-art`: a chave que apaga
      saves não publica o jogo, e a que publica não apaga saves. (Sem ela, o `erase` usa a `ROBLOX_API_KEY` e avisa.)
- [ ] **Uma vez, antes do primeiro pedido real:** com uma conta de teste sua (uma alt que jogou no Studio e no
      jogo publicado), rode `npm run cloud -- erase <UserId da alt> --yes` e confira no Data Stores Manager que as
      chaves sumiram — inclusive as `_studio` — e que o log de admin foi regravado. O teste em Node roda contra um
      Open Cloud falso; a forma exata das respostas reais (o `etag` numa gravação concorrente) só se confirma assim.
- [ ] **Para cada pedido da mensagem diária:**
      1. O jogador tem de estar **fora do jogo**. Se estiver online, **kick** pelo painel de admin (ou ban, se ele
         não deve voltar) e **espere 1 minuto**: ao sair, o servidor dele ainda grava o registro de títulos, o save e
         o log de admin (a cada 30 s) — rodar antes disso recria as chaves que o comando apaga.
      2. `npm run cloud -- erase <userId> --dry-run` mostra o plano (não lê chave nenhuma).
      3. `npm run cloud -- erase <userId> --yes` apaga, no PC, com o `.env`. Sem `--yes` ele só mostra o plano; um
         argumento a mais ou digitado errado (`--dryrun`, dois UserIds, um nome) recusa o comando inteiro. Se
         nenhuma das seis chaves existia, ele sai com erro: confira o UserId e o `ROBLOX_UNIVERSE_ID`.
      Apagar marca a chave como apagada; o Roblox remove as versões antigas em até 30 dias (o mesmo prazo dos
      modelos).

Cada gravação do save e do registro de títulos leva o UserId do dono (`UpdateAsync` devolve `[userId]`), então
o próprio Data Stores Manager mostra de quem é cada chave. O sufixo `_studio` (feito) separa os playtests do
Studio dos saves de produção.

### Leaderboard — **depois da F2**

Recorde de dias sobrevividos, via `OrderedDataStore`. Depende do XP e do progresso já serem do servidor
(F2-2C), senão o ranking premia quem edita o cliente.

### Maturity & Compliance Questionnaire — **obrigatório, e declarando o sangue**

Sem o questionário completo e correto, o Roblox **restringe a experiência para todos**; declarar menos do que o
jogo mostra é o que gera moderação (declarar a mais não é punido). O jogo tem: sangue vermelho do sobrevivente e
verde dos zumbis a cada golpe, poças que duram 10 s, manchas de sangue seco no mapa, o sobrevivente derrubado que
**rasteja sangrando** por 30 s (MP-03), zumbis que somem ao morrer, armas e hordas à noite.

**Checklist — Configure → Maturity & Compliance (Questionnaire):**

- [ ] **Violence:** Yes → intensidade **Moderate**. Os zumbis somem ao morrer (seria Mild), mas basta **um**
      momento de consequência realista, e o sobrevivente derrubado rastejando e sangrando imita um ferimento real.
- [ ] **Blood:** Yes → **Unrealistic** (pixel, e verde nos zumbis) → **não** é "infrequent / fleeting" (a cada
      golpe, poças de 10 s, manchas permanentes no mapa): o nível pesado do sangue irrealista.
- [ ] **Fear:** Yes → **Mild** (NPCs assustadores, música e batimento cardíaco, tensão das ondas à noite; nada de
      susto repentino nem conteúdo perturbador).
- [ ] **Crude humor:** No. **Romance:** No. **Alcohol:** No. **Strong language:** No (o chat é filtrado pelo
      Roblox; conteúdo de jogador não conta).
- [ ] **Gambling:** No. **Paid random items:** No (os pacotes da loja têm conteúdo fixo e declarado e custam
      moedas do jogo, não Robux — MON-03). **Paid item trading:** No.
- [ ] **Free-form user creation:** No (construir barricada/porta é peça pronta, sem texto nem desenho livre).
      **Social hangout:** No (é um jogo de sobrevivência).
- [ ] Rótulo esperado: **Moderate (13+)** — o mesmo `AGE_RATING_13_PLUS` que a API mostra hoje. Confira também
      o resultado de conformidade regional.
- [ ] Refaça o questionário quando o conteúdo mudar (ex.: Robux, anúncios, sangue realista).

---

## Analytics

**Ligue tudo.** Retention, Engagement, Acquisition e Demographics funcionam sozinhos. Economy, Funnels e Custom
events vêm das chamadas de `AnalyticsService` do servidor (`src/server/analytics/events.ts`): o catálogo, o
orçamento de taxa e o que aparece em cada página estão em `docs/ANALYTICS.md`. Só um jogo **publicado** manda
eventos (o Studio não); os gráficos levam ~24 h, e **View Events** mostra os eventos em minutos.

Os funis que valem, para este jogo especificamente:

1. **Entrou → apertou PLAY → sobreviveu à primeira noite.** É a curva que diz se o onboarding funciona (funil
   Onboarding).
2. **Primeira morte → jogou de novo.** Diz se morrer é frustrante ou convidativo (funil Rebirth e `SessionEnded`
   com `Where - Dead`).
3. **Jogou sozinho → jogou acompanhado.** Diz se o co-op está sendo descoberto (funil Night, breakdown `Survivors`).

O que configurar em cada página (funis, dashboard custom, regras do Error Report, alertas, experimentos) está na
checklist da §14 de `docs/ANALYTICS.md`.

---

## Monetization — **a aba onde a sua regra tem que virar decisão**

Você foi explícito: **não quero pay-to-win**. Isso se traduz assim:

| Item | Decisão |
| --- | --- |
| Passes / Developer products | **Só cosmético e conveniência.** Skin, roupa, cor de nameplate: sim. Arma, munição, dano, XP, vida: **não**. |
| Shop / Managed pricing | Não antes de publicar. |
| Subscriptions | Não. Assinatura num jogo de sobrevivência cria pressão para tornar o jogo pior para quem não assina. |
| Ads | **Desligado** enquanto privado. Reavaliar só depois de o jogo estar bom. |
| Third-party avatar commissions | Pode ligar: é receita que não afeta equilíbrio nenhum. |

A regra prática para qualquer item futuro: **se dá vantagem numa noite, não se vende.**

---

## Monitoring — **liga depois de publicar, e economiza Studio**

Performance, Error report, Crashes, Memory Stores, Data Stores, HTTP e Messaging Service. Isto responde em
produção parte do que hoje só o Studio responde — especialmente **Error report** e **Crashes**, que capturam
exatamente a classe de erro que os testes em Node não veem (limite de registradores do Luau, asset que não
carrega, remote que estoura). Vale conferir aqui **depois de cada publicação**. O Error Report agrupa por
mensagem: os avisos do jogo são frases fixas (ids e contagens vão para o log), e as regras sugeridas estão na §14 de
`docs/ANALYTICS.md`.

---

## Audience

- **Access settings**: mantenha **privado** até a F2 fechar e o teste de 2 clientes passar. Publicar um jogo
  em que dois jogadores veem hordas diferentes queima a primeira impressão, que não volta.
- **Communication settings**: o chat já está no `TextChatService` (trocado do legado). O nosso chat é **por
  proximidade**, filtrado no servidor (MP-17), **sem sussurro** (o `/whisper` do Roblox fica desligado pelo
  jogo) e sem barra de digitar no lobby, onde ninguém ouve (MP-18). Voz continua desligada: não está no design
  e adiciona superfície de moderação.
- **Localization**: os textos do jogo passam por `src/shared/data/lang.ts`. O original tinha coreano; hoje
  respondemos em inglês. Traduzir é barato e amplia alcance, mas só depois que os textos pararem de mudar.
  A **Automatic Text Capture** pode ser ligada: todo rótulo que mostra nome de jogador ou texto digitado (placar,
  palco do lobby, aviso do admin, painel de admin) tem `AutoLocalize` desligado, então nenhum nome vai parar na
  tabela de tradução.

---

## Engagement

- **Badges**: valem, e são baratos. Os que fazem sentido aqui: sobreviver à primeira noite, ao dia 5, ao dia
  10; matar o primeiro chefe; reviver um companheiro. **Nenhum badge por compra.**
- **Social links / Events & updates / Notifications**: só quando houver comunidade para avisar.
- **Referral rewards**: não antes de o jogo estar bom. Convite para um jogo inacabado gasta a boa vontade de
  quem convidou.

---

## Safety

- **Moderation**: acompanhe depois de publicar. O chat por proximidade já entrega **texto filtrado pelo
  Roblox** (MP-19) — nunca desenhamos texto cru de jogador.
- **Collaborators**: vazio é o certo hoje.

---

## Moderação e bans

- **`Players.BanningEnabled`** liga o `BanAsync` / `UnbanAsync` / `GetBanHistoryAsync` do painel de admin e não
  pode ser mudado por script. Ele agora vai **fixo** no `default.project.json`, então todo `rojo build` (o place
  da CI e o `npm run cloud -- publish`) o leva ligado; a CI confere o `.rbxlx` que o Rojo escreveu
  (`npm run check:place`), e o `publish` se recusa a subir sem ele. Depois do próximo publish, abra o painel de
  admin e peça o **Ban history** de um UserId qualquer: deve responder sem "Ban API failed".
- A mensagem de ban diz o motivo **filtrado** e aponta para as regras e o recurso na página da experiência.
- O log do painel guarda só UserIds e texto filtrado, numa chave por servidor por dia (`server/admin/auditLog.ts`).
- Os bans podem ser revistos em Creator Hub → **Moderation → Bans**.

---

## Resumo do que depende de você

1. **Nome e descrição** em Settings (a API ignora esses dois), **com as regras e o recurso** e o link do grupo.
2. **Maturity & Compliance Questionnaire**: responder como na checklist acima (Moderate, sangue irrealista
   frequente, medo leve).
3. **RTBF**: criar os seis modelos do Data Stores Manager e a chave `ROBLOX_ERASE_API_KEY` (só data store); testar
   o `erase` uma vez com uma alt; para cada pedido da mensagem diária, jogador fora do jogo e `npm run cloud --
   erase <userId> --yes`.
4. **Server management**: decidir como será o "jogar sozinho".
5. **Alerts**: ligar assim que tiver 100+ DAU (lista na §13 de `docs/ANALYTICS.md`).
6. **Access settings**: manter privado até a F2 fechar.
7. Depois do próximo publish: conferir o **Ban history** no painel de admin (bans ligados).
