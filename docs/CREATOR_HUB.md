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

  A última linha não é marketing: é a regra que já governa a loja, e dizê-la na página filtra a expectativa
  certa de quem entra.
- **Classificação 13+**: correta. Violência estilizada contra zumbis, sem sangue realista.
- **Gêneros**: Survival como principal; Action como secundário.
- **Dispositivos**: desktop, celular e tablet ligados (temos controles de toque medidos em 500 combinações de
  tela). **Console pode ficar ligado** — o suporte a gamepad existe e foi construído junto. VR desligado.

### Places — **feito**

`serverSize` = 6. Não mexa para cima sem mudar `MAX_PLAYERS` no código junto: os dois números **são o mesmo
número**, e se divergirem o sintoma é um jogador fantasma no lobby.

### Custom matchmaking — **não agora**

Só faz sentido com fila e volume de jogadores. Antes disso é complexidade sem uso. Reavaliar quando houver
gente suficiente para uma fila existir.

### Server management — **decida antes de publicar**

É aqui que mora o "jogar sozinho" que você pediu. As opções são servidor privado (VIP) ou reserva por
`TeleportService`. Está sob análise numa frente de pesquisa (`docs/research/servidores-e-dados.md`); o que
**não** pode acontecer é o solo virar um modo pior que o co-op — é a regra MP-14.

### Permissions / Collaborators — **só você, por enquanto**

Cada colaborador com acesso de escrita pode publicar e ler DataStore. Adicione um por vez, quando houver
motivo, e prefira o papel mais fraco que resolva.

### Configs — **vale a pena, depois da F2**

Permite mudar número de balanceamento sem republicar. Os nossos candidatos naturais são os que já sabemos
que vão pedir ajuste: `SIM_HZ`, o alcance de visão dos zumbis, o teto da horda e o raio do chat. Fazer antes
da F2 fechar é ajustar um alvo em movimento.

### Experiments — **depois de ter jogadores**

Teste A/B sem base de jogadores não mede nada.

### Alerts — **ligue antes de publicar**

Alerta de taxa de erro e de crash. É o que avisa que algo quebrou sem depender de alguém reclamar.

### Secrets — **não precisamos**

O jogo não chama serviço externo nenhum. A nossa chave de Open Cloud vive no `.env` local, fora do jogo, e
**não** deve ser colocada aqui.

### Webhooks — **opcional**

Útil o dia em que quisermos avisar de moderação ou de publicação num canal. Não é bloqueante.

### Data Stores manager — **atenção agora**

Contém `ProjectZ_Save_v2`, com save real dentro (já verificado por API). **Risco ativo**: com o acesso do
Studio a serviços de API ligado, um playtest no Studio escreve nesse mesmo store — o de produção. A F3 vai
mexer no formato do save (v3), e testar migração contra o store de produção é a receita para perder save. A
correção é de três linhas (sufixo `_studio` quando `RunService:IsStudio()`) e está na fila, esperando o
arquivo `server/main.server.ts` sair da mão do agente da F2-2D.

### Leaderboard — **depois da F2**

Recorde de dias sobrevividos, via `OrderedDataStore`. Depende do XP e do progresso já serem do servidor
(F2-2C), senão o ranking premia quem edita o cliente.

### Extended services / Questionnaire — **pule**

Nada que o jogo use hoje.

---

## Analytics

**Ligue tudo.** Retention, Engagement, Acquisition e Demographics funcionam sozinhos. Economy, Funnels e Custom
events vêm das chamadas de `AnalyticsService` do servidor (`src/server/analytics/events.ts`): o catálogo, o
orçamento de taxa e o que aparece em cada página estão em `docs/ANALYTICS.md`. Só um jogo **publicado** manda
eventos (o Studio não); os gráficos levam ~24 h, e **View Events** mostra os eventos em minutos.

Os funis que valem, para este jogo especificamente:

1. **Entrou → apertou PLAY → sobreviveu à primeira noite.** É a curva que diz se o onboarding funciona.
2. **Primeira morte → jogou de novo.** Diz se morrer é frustrante ou convidativo.
3. **Jogou sozinho → jogou acompanhado.** Diz se o co-op está sendo descoberto.

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
carrega, remote que estoura). Vale conferir aqui **depois de cada publicação**.

---

## Audience

- **Access settings**: mantenha **privado** até a F2 fechar e o teste de 2 clientes passar. Publicar um jogo
  em que dois jogadores veem hordas diferentes queima a primeira impressão, que não volta.
- **Communication settings**: o chat já está no `TextChatService` (trocado do legado). O nosso chat é **por
  proximidade**, filtrado no servidor (MP-17). Voz continua desligada: não está no design e adiciona
  superfície de moderação.
- **Localization**: os textos do jogo passam por `src/shared/data/lang.ts`. O original tinha coreano; hoje
  respondemos em inglês. Traduzir é barato e amplia alcance, mas só depois que os textos pararem de mudar.

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

## Resumo do que depende de você

1. **Nome e descrição** em Settings (a API ignora esses dois).
2. **Server management**: decidir como será o "jogar sozinho".
3. **Alerts**: ligar antes de publicar.
4. **Access settings**: manter privado até a F2 fechar.
