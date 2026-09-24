# Motivação, dopamina e ética de design — o que a ciência sustenta, e o que muda no Project Z

Pedido do dono (2026-09-24): "Pesquise cientificamente sobre dopamina, vícios e afins, para tornar nosso jogo melhor, de
um jeito que faça sentido." Base: `main` em `21aab2a`. Complementa `docs/research/DEAD_TOWN_GAP_ANALYSIS.md` (o que falta
em relação ao original) com outra pergunta: **por que** um jogador volta, e **como fazer isso sem explorá-lo**. Não é
parecer jurídico: onde aparece uma lei, o texto diz o que ela diz e de onde veio; decisão com risco legal passa por um
advogado.

**Como ler.** Cada afirmação tem um rótulo:

- **[forte]**: evidência forte. Meta-análise, experimentos replicados ou estudo grande com dado objetivo (telemetria).
- **[misto]**: evidência mista. A favor, mas correlacional, pequena, heterogênea, contestada, ou medida em outro contexto
  (animais, cassino, sala de aula) e transposta para jogos.
- **[fraco]**: afirmação fraca ou popular. Divulgação, folclore de indústria, não replicada ou contrariada.
- **[norma]**: o que diz uma lei, um regulador, uma classificação etária ou uma política do Roblox. Não é evidência, é
  regra. Diz-se quando só foi lida numa fonte secundária.
- **[repo]**: fato do nosso código ou das nossas regras (arquivo ou ID ao lado).
- **[inferência]**: conclusão nossa a partir dos anteriores. É uma aposta de design, nunca um fato.

Esforço (a mesma unidade de `docs/MULTIPLAYER.md` §11): **S** ≤ 1 agente-dia · **M** 2–4 · **L** 5–8 · **XL** > 8.

---

## 0. Resumo

- **Dopamina não é prazer.** É, sobretudo, um sinal de **aprendizagem** (o erro de predição da recompensa) e de
  **querer** (saliência de incentivo); o **gostar** mora em outros circuitos [forte]. Querer sem gostar é a assinatura
  da compulsão, não da diversão [misto]. Para nós: construir coisas que valem a pena gostar (dominar a noite, proteger os
  amigos, descobrir a cidade) e usar a antecipação com honestidade [inferência].
- **O que prevê diversão e bem-estar é a qualidade, não as horas.** Satisfazer competência, autonomia e vínculo prevê
  diversão e vontade de voltar [forte]; o tempo jogado quase não mexe no bem-estar [forte]; jogar por pressão ou
  obrigação (motivação extrínseca) anda junto com bem-estar pior [misto].
- **O dano se concentra em poucos mecanismos:** acaso pago (loot boxes) [misto a forte na associação; misto na causa],
  pressão (FOMO, sequência que pune, urgência falsa) [misto] e necessidades frustradas [misto]. O transtorno de jogo existe
  (CID-11, 6C51) [norma], mas atinge uma minoria pequena, perto de 2% ou menos [misto].
- **O Project Z já evita a maior parte por regra** [repo]: moedas só jogando, pacotes de conteúdo fixo, nada por Robux,
  sem anúncios, nenhum menu pausa e nada vende capacidade (MON-01..05, UI-06, `docs/CREATOR_HUB.md`).
- **O que falta** [inferência]: (1) o novato pode cair num mundo no dia 20, o pior golpe na competência; (2) a noite acaba
  sem fechar o ciclo: não há um ponto de parada saudável ao amanhecer; (3) não há retenção nenhuma, e ela precisa nascer
  sem sequência e sem punição; (4) a tremida da câmera e dos sólidos ignora o Reduzir Movimento [repo]; (5) não há regra
  escrita contra pressão de compra para o dia em que o Robux chegar; (6) a cidade persistente (gap P1-1), se vier, não pode
  apodrecer com o dono offline; (7) o público inclui crianças: pelas regras atuais do Roblox, a classificação Moderate é
  aberta à conta Roblox Select, de 9 a 15 anos [norma].

### Top 10

| #   | Recomendação                                                                                                        | Por quê                                                                                    | Prioridade / esforço |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------- |
| 1   | Escrever as regras de bem-estar (BEM-01..08, §4.0) na DESIGN_RULES antes de qualquer retenção ou Robux              | Sem regra escrita, cada ideia de receita recomeça do zero (é o motivo da MON-01) [repo]    | P0 · S               |
| 2   | O novato nunca cai num mundo de dia alto, e a primeira noite é vencível (gap P0-1 + experimento 2 da ANALYTICS)     | Competência prevê diversão e retorno [forte]; frustração prevê uso problemático            | P0 · S–M; P1 · M     |
| 3   | A tremida da câmera e dos sólidos respeita o Reduzir Movimento                                                      | Acessibilidade básica [norma]; a UI já o respeita, a tremida não [repo]                    | P0 · S               |
| 4   | Som da mordida e dos eventos centrais (gap P0-4)                                                                    | A mordida é muda [repo]; feedback que informa sustenta a competência [forte]               | P0 · S–M             |
| 5   | Guardas de bem-estar na analítica antes de lançar retenção (§6)                                                     | Tempo de sessão mede querer, não gostar [misto]; sem guarda, a métrica puxa o design       | P0 · S               |
| 6   | Relatório do amanhecer: fecha a noite, diz o que foi salvo, e só em sessão longa sugere pausa                       | Regra do pico-fim [forte]; mensagens de pausa têm efeito moderado [misto]                  | P1 · M               |
| 7   | A tela de morte ensina: a causa e uma dica                                                                          | Falha com sentido sustenta a competência [misto]                                           | P1 · S–M             |
| 8   | Contratos diários sem sequência (acumulam, nada se perde) e eventos com recompensa que volta                        | Sequência quebrada derruba o engajamento [misto]; PEGI 2026 separa premiar e punir         | P1 · M; P2 · M       |
| 9   | Co-op com vínculo: pings, crédito e título por reviver, espectar; Play solo com opções de assistência               | Cooperação e interdependência aumentam vínculo e confiança [misto]; autonomia              | P1 · M cada          |
| 10  | Progressão que informa: o level-up diz o que deu, respec grátis por vida, conquistas de variedade no lugar de grind | Feedback informativo sustenta a motivação intrínseca; recompensa esperada a corrói [forte] | P1–P2 · S–M          |

O "não faremos" está na §5; as métricas na §6; a lista completa na §7.

---

## 1. Dopamina: o que ela faz de verdade

### 1.1 Erro de predição da recompensa

- Neurônios de dopamina do mesencéfalo disparam quando a recompensa é **melhor que o esperado**, não mudam quando ela é
  exatamente a esperada e **caem** abaixo da linha de base quando ela é pior; com o aprendizado, o disparo migra da
  recompensa para a pista que a anuncia (Schultz, Dayan & Montague, 1997) [forte]. É o mesmo "erro de predição" dos
  algoritmos de aprendizagem por diferença temporal.
- Consequência [inferência]: uma recompensa totalmente previsível deixa de ensinar. Não por ser ruim, mas porque já foi
  aprendida. Um jogo mantém o interesse oferecendo **coisas novas a prever** (situações, inimigos, cidade nova, técnica a
  dominar), não necessariamente prêmios sorteados.

### 1.2 Querer não é gostar

- Berridge e colegas separam **"querer"** (saliência de incentivo: a atração por uma pista, dopaminérgica, em sistemas
  grandes) de **"gostar"** (o impacto hedônico, em "pontos quentes" pequenos, opioides e endocanabinoides). Estimular a
  dopamina no núcleo accumbens aumenta o querer por açúcar sem aumentar o gostar (Berridge & Kringelbach, 2015) [forte em
  animais; misto a transposição direta para humanos].
- A teoria da **sensibilização de incentivo** descreve o vício como querer amplificado por pistas, **sem** aumento do
  gostar (Berridge & Robinson, 2016; Robinson & Berridge, 2025) [forte para drogas em animais; misto para comportamentos].
- Consequência [inferência]: tempo e número de sessões medem o **querer**. Só a opinião do jogador e a volta espontânea
  medem o **gostar**. Um recurso que sobe o tempo e desce a avaliação é querer sem gostar: é o alarme da §6.

### 1.3 Antecipação e incerteza

- Além do disparo curto, há uma ativação que **sobe até o momento da recompensa** e é máxima com 50% de chance (Fiorillo,
  Tobler & Schultz, 2003) [forte como observação em primatas; misto a interpretação: pode ser efeito do próprio
  aprendizado por diferença temporal, Niv, Duff & Dayan, 2005].
- "Quase ganhar" aumenta a vontade de continuar apostando e recruta circuitos de ganho, **quando** o jogador sente que
  controlou a jogada (Clark et al., 2009); a resposta do mesencéfalo ao quase-ganho cresce com a gravidade do jogo
  patológico (Chase & Clark, 2010) [misto: laboratório de aposta com dinheiro; sem dado em jogo sem dinheiro].
- Caça-níqueis que tocam a festa da vitória quando o jogador **perdeu** dinheiro (ganhou menos do que apostou) são
  vividos como vitórias: "perdas disfarçadas de ganho" (Dixon et al., 2010) [misto].
- Consequência [inferência]: incerteza é um motor legítimo quando é **do jogo** (vamos segurar a escola até o amanhecer?
  o zumbi me viu?) e ilegítimo quando é **vendida** ou **fabricada** (quase-acerto de mentira, festa em cima de perda).

### 1.4 Aprendizagem e curiosidade

- Curiosidade nasce de uma **lacuna de informação** percebida: saber um pouco e perceber o que falta (Loewenstein, 1994)
  [misto: teoria com apoio experimental, sem uma medida aceita de curiosidade, Kidd & Hayden, 2015].
- Em estado de muita curiosidade a memória melhora, até para o que é incidental, com mesencéfalo, accumbens e hipocampo
  mais ativos (Gruber, Gelman & Ranganath, 2014) [misto: um estudo de fMRI, com apoio conceitual].
- Consequência [inferência]: a cidade nova a cada fim de mundo (MP-22), o letreiro que diz o tipo de prédio (ART-07) e o
  saque coerente (EDI-03) já criam lacunas **pequenas e respondíveis** [repo]. O desenho certo mostra **o que existe** e
  deixa o jogador descobrir **o que tem dentro**.

### 1.5 Mitos

| Afirmação popular                                           | O que a evidência diz                                                                                                                                                                                                         | Rótulo                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| "Dopamina é a molécula do prazer."                          | É querer e aprendizagem; o prazer vem de outros sistemas (§1.2).                                                                                                                                                              | [fraco]                              |
| "Videogame solta tanta dopamina quanto droga."              | Vem de um estudo pequeno de PET (Koepp et al., 1998) em que os participantes eram **pagos em dinheiro** por fase vencida: jogo e dinheiro misturados. O estudo não compara com droga nenhuma.                                 | [fraco]                              |
| "Detox de dopamina."                                        | Rótulo de autoajuda. Nenhum estudo que encontramos mostra dopamina "se esgotando" por jogar nem voltando com abstinência de jogo.                                                                                             | [fraco]                              |
| "Recompensa variável vicia por si só."                      | Esquemas de razão variável sustentam mais resposta e resistem mais à extinção em animais (Ferster & Skinner, 1957). Em jogos, o dano documentado aparece quando o acaso **custa dinheiro** (§3.3).                            | [forte] em animais; [misto] em jogo  |
| "Tempo de tela ou de jogo faz mal."                         | Tecnologia digital explica no máximo 0,4% da variação do bem-estar de adolescentes (Orben & Przybylski, 2019); horas de jogo quase não afetam o bem-estar, com 38.935 jogadores medidos por telemetria (Vuorre et al., 2022). | [forte] contra o mito                |
| "Lembramos mais do que ficou inacabado (efeito Zeigarnik)." | Meta-análise: sem vantagem de memória; há, sim, uma tendência a **retomar** o inacabado, o efeito Ovsiankina (Ghibellini & Meier, 2025).                                                                                      | Zeigarnik [fraco]; retomar [misto]   |
| "Perder pesa o dobro de ganhar, sempre."                    | Uma meta-análise dá λ ≈ 1,96 (Brown et al., 2024); uma re-meta-análise diz que não é robusto (Yechiam & Zeif, 2025); Gal & Rucker (2018) dizem que depende do contexto.                                                       | [misto]                              |
| "Flow é manter desafio e habilidade sempre iguais."         | Um ritmo que varia com pausas curtas superou o equilíbrio constante em flow **e** em diversão (Baumann, Lürig & Engeser, 2016).                                                                                               | [misto] contra o mito                |
| "Os jogadores são quatro tipos (Bartle)."                   | Taxonomia de observação de MUDs. Uma análise fatorial com 3.000 jogadores achou motivações que coexistem (conquista, social, imersão), não tipos (Yee, 2006).                                                                 | [fraco]                              |
| "Quanto mais juice, melhor."                                | Juice médio e alto venceram "nenhum" e "extremo" em experiência, motivação e desempenho (Kao, 2020).                                                                                                                          | [misto] contra o mito                |
| "Todo jogo precisa de tutorial."                            | Com 45 mil jogadores, tutorial só ajudou o jogo mais complexo (até +29% de tempo); nos simples, nada (Andersen et al., 2012).                                                                                                 | [forte] no estudo; [misto] fora dele |
| "Vício em jogo é comum."                                    | Perto de 2% em meta-análise, com heterogeneidade grande (Stevens et al., 2021); 0,3–1,0% com critérios estritos (Przybylski, Weinstein & Murayama, 2017).                                                                     | [misto]                              |
| "Hooked", "Octalysis" e afins provam como reter.            | Frameworks de consultoria: úteis como checklist, sem validação empírica própria.                                                                                                                                              | [fraco]                              |

### 1.6 Três princípios que saem daqui [inferência]

1. **Ensine, não sorteie.** O sinal de aprendizagem se renova com situações novas e habilidade crescente; não precisa de
   prêmio aleatório para existir.
2. **Meça o gostar, não só o querer.** Tempo de jogo é o número mais fácil e o mais enganoso.
3. **Incerteza honesta.** Tensão vem do mundo (a horda, a noite, o zumbi que desconfia), nunca de um sorteio pago, de um
   quase-acerto fabricado ou de uma festa sobre uma perda.

---

## 2. Os modelos de motivação que preveem diversão e retenção

### 2.1 Autodeterminação (SDT) e PENS

- Três necessidades, **competência**, **autonomia** e **vínculo** (relatedness), predizem cada uma, de forma
  independente, a diversão e a intenção de jogar de novo; competência e autonomia também dependem de **controles
  intuitivos** (Ryan, Rigby & Przybylski, 2006, quatro estudos; modelo em Przybylski, Rigby & Ryan, 2010) [forte].
- A outra face: **necessidade frustrada** no jogo e fora dele explica a ligação entre motivação e uso problemático (Mills
  et al., 2018) [misto: correlacional]; necessidade satisfeita favorece a paixão "harmoniosa" (quero jogar), frustrada a
  "obsessiva" (tenho de jogar) (Przybylski, Weinstein, Ryan & Rigby, 2009) [misto].
- Crítica honesta: a pesquisa de jogos costuma usar a SDT de forma descritiva, sem as suas mini-teorias (Tyack &
  Mekler, 2020) [misto]. Existe hoje uma escala validada para jogos que mede **satisfação e frustração** das três
  necessidades, a BANGS (Ballou et al., 2024) [misto: instrumento novo].

### 2.2 Tempo × qualidade

- **Horas não preveem bem-estar.** Com telemetria de 38.935 jogadores de sete editoras, seis semanas: pouco ou nenhum efeito
  causal do tempo de jogo no bem-estar; **motivação intrínseca** com efeito positivo e **extrínseca** com negativo (Vuorre
  et al., 2022) [forte para o tempo; misto para a motivação, observacional].
- Com telemetria de Plants vs. Zombies e Animal Crossing, relação pequena e **positiva** entre tempo e bem-estar afetivo;
  satisfação das necessidades ligada ao bem-estar de forma independente do tempo (Johannes, Vuorre & Przybylski, 2021)
  [misto: dois jogos].
- Em 703 adultos, o **valor percebido** do jogo na vida previu bem-estar; horas, não (Ballou et al., 2025) [misto].
- Consequência [inferência]: a meta do Project Z não é "mais minutos", é "jogador que volta porque vale a pena".

### 2.3 Fluxo e desafio

- Flow (Csikszentmihalyi, 1990) é a absorção quando desafio e habilidade estão altos e próximos [misto: o conceito é
  forte, a medida é discutida].
- **Desafio prevê diversão.** No xadrez online, partidas contra oponentes **um pouco** mais fortes foram as mais
  apreciadas (Abuhamdeh & Csikszentmihalyi, 2012) [forte que desafio importa; misto sobre a forma exata da curva].
- **Equilíbrio constante não é o ótimo.** Num jogo com três ritmos, o constante perdeu: flow foi máximo com demanda que
  oscila e passa um pouco do limite ("dynamic high"), diversão com demanda que oscila sem sobrecarga ("dynamic medium")
  (Baumann, Lürig & Engeser, 2016) [misto: um experimento].
- Ajuste dinâmico de dificuldade funciona quando não é percebido como trapaça (Hunicke, 2005) [misto]; o diretor do
  Left 4 Dead (pico → alívio → subida) é o exemplo de indústria (Booth, 2009) [misto: prática de indústria, sem
  experimento controlado]. O nosso `director.ts` segue esse modelo [repo].

### 2.4 Falha e morte com sentido

- Falhar dói e mesmo assim os jogadores escolhem jogos em que vão falhar: a falha motiva quando o jogador a vê como **sua**
  e aprende com ela (Juul, 2013) [misto: ensaio teórico].
- Em DayZ, morte com consequência intensificou as relações sociais, o investimento e os dilemas morais (Carter, Gibbs &
  Wadley, 2013) [misto: qualitativo].
- Consequência [inferência]: o nosso modelo (a vida acaba, nível/skills/moedas/títulos ficam, MP-21/MP-22 [repo]) dá
  consequência sem apagar o investimento. O que falta é a morte **ensinar** (§4.8).

### 2.5 Maestria e feedback que informa

- Meta-análise de 128 experimentos: recompensas **tangíveis e esperadas** (condicionadas a fazer, terminar ou desempenhar)
  reduzem a motivação intrínseca (d ≈ −0,28 a −0,40); **feedback verbal positivo e informativo** a aumenta (Deci, Koestner
  & Ryan, 1999) [forte; houve debate com Cameron & Pierce, e a meta-análise o respondeu].
- Pontos, níveis e placar aumentaram o desempenho numa tarefa, mas **não** a motivação intrínseca nem a competência:
  agiram como incentivo externo (Mekler et al., 2017) [misto].
- Badges aumentaram a atividade num serviço real, em comparação antes/depois de um ano cada (Hamari, 2017) [misto].
- Consequência [inferência]: conquista, nível e título funcionam quando **dizem algo** ("você aprendeu a cozinhar", "você
  aguentou uma semana"), e viram moeda de troca extrínseca quando são contadores de repetição.

### 2.6 Curiosidade e lacunas de informação

Ver §1.4. Em design [inferência]: névoa do que não se viu, prédios que se leem de fora e se revelam por dentro (EDI-04),
a cidade nova de cada mundo (MP-22) e o estado do zumbi que ainda não decidiu (IA-05) são lacunas pequenas e honestas.

### 2.7 Jogo social

- Numa série de jogos de teste com pares de desconhecidos, **cooperação** e **interdependência** (cada um tem uma parte
  que o outro não tem) aumentaram, cada uma por si, vínculo, diversão e confiança interpessoal (Depping & Mandryk, 2017)
  [misto: laboratório].
- Meta-análise de 98 estudos: jogo com conteúdo pró-social aumenta desfechos pró-sociais (Greitemeyer & Mügge, 2014)
  [misto: a mesma meta-análise sobre jogo violento é contestada; aqui só a parte pró-social].
- Consequência [inferência]: reviver (MP-03), saque compartilhado (MP-05) e a horda que escala por grupo (MP-09) já
  criam cooperação [repo]; papéis legíveis e pings criariam interdependência leve.

### 2.8 Gradiente de meta e progresso dotado

- **Gradiente de meta:** perto do prêmio, o esforço acelera; num programa "compre 10 cafés", as compras ficaram mais
  frequentes perto do fim, e num site de avaliar músicas os usuários voltavam mais e largavam menos a sessão perto
  da meta (Kivetz, Urminsky & Zheng, 2006) [forte: campo e laboratório].
- **Progresso dotado:** um cartão de lavagem de carro de 10 carimbos com 2 já dados foi completado mais (34%) que um de 8
  vazio (19%), com o mesmo esforço (Nunes & Drèze, 2006) [misto: um estudo de campo marcante, poucas réplicas
  independentes].
- Consequência [inferência]: barras de progresso ajudam; **progresso de verdade** é o que usamos. Os objetivos do
  onboarding já contam o que o jogador fez antes de o objetivo aparecer [repo `client/onboarding/objectives.ts`]: é
  progresso dotado honesto. Progresso **falso** (barra pré-cheia que não corresponde a nada) fica de fora.

### 2.9 Zeigarnik × Ovsiankina

- A meta-análise de 2025 não achou vantagem de memória para tarefas interrompidas (Zeigarnik), mas achou uma tendência
  geral a **retomá-las** (Ovsiankina) (Ghibellini & Meier, 2025) [forte para o nulo de memória; misto para a retomada].
- Consequência [inferência]: "deixar um gancho aberto no fim da sessão" tem algum apoio para trazer o jogador de volta,
  e por isso mesmo é uma ferramenta de pressão. Regra nossa: o jogo **fecha o ciclo** no amanhecer (§4.7), e o que fica
  em aberto é escolha do jogador, não armadilha do design.

### 2.10 Esquemas variáveis × fixos

- Em animais, reforço de razão variável produz taxas de resposta altas e resistência à extinção (Ferster &
  Skinner, 1957) [forte em animais].
- Em jogos humanos a evidência controlada é escassa [misto]; o texto de indústria mais citado é um ensaio (Hopson, 2001)
  [fraco como evidência]. O dano documentado aparece quando o sorteio **custa dinheiro** (§3.3) [misto].
- Consequência [inferência]: saque aleatório de prédio (MP-05, ITM-03) é conteúdo legítimo, porque se ganha jogando e
  não se compra. Acaso comprável não entra (§5).

### 2.11 Perda, sequências e aversão à perda

- A força da aversão à perda está em disputa (Brown et al., 2024; Yechiam & Zeif, 2025; Gal & Rucker, 2018) [misto].
- **Sequências (streaks):** em sete estudos, mostrar uma sequência intacta aumenta o comportamento seguinte em comparação
  com mostrar uma sequência quebrada; a diferença cresce quando a pessoa se culpa pela quebra e diminui quando ela pode
  "consertar" a sequência (Silverman & Barasch, 2023) [misto: estudos de consumidor, não de jogo].
- Consequência [inferência]: sequência que pune gera exatamente o que não queremos: quem falha um dia se sente pior e
  joga **menos**, e quem mantém joga por obrigação (motivação extrínseca, §2.2).

### 2.12 Pico-fim

- A lembrança de uma experiência segue sobretudo o **pico** e o **fim** (Kahneman et al., 1993); meta-análise de 174
  amostras: efeito grande, r = 0,58, robusto, embora a média da experiência inteira preveja quase tão bem (Alaybek et
  al., 2022) [forte].
- Consequência [inferência]: como a sessão termina importa. Terminar ao amanhecer, depois de uma noite vencida, é o fim
  mais forte que o jogo tem; terminar derrubado no meio da onda é o pior.

### 2.13 Juice (feedback audiovisual)

- Embelezamentos visuais aumentam o apelo visual, mas só afetam a competência em certas condições (Hicks et al., 2019)
  [misto].
- Num RPG de ação com quatro níveis de juice, médio e alto venceram nenhum e extremo em experiência, motivação intrínseca,
  comportamento e desempenho (Kao, 2020) [misto: um estudo].
- Consequência [inferência]: juice é para **informar** (acertou, matou, subiu de nível, levou dano), na medida do evento.

### 2.14 Onboarding

- Em 45 mil jogadores e oito desenhos de tutorial, tutorial só compensou no jogo mais complexo; instrução **no contexto**
  (na hora em que se precisa) foi melhor que instrução antes do jogo (Andersen et al., 2012) [forte no estudo; misto a
  generalização].
- Consequência [inferência]: o Project Z é complexo (fome, saque, craft, construção, noite); o modelo atual, objetivos que
  observam o mundo e nunca interrompem [repo `objectives.ts`], é o certo.

### 2.15 Tipos de jogador

Bartle é folclore útil, não modelo [fraco]; as motivações coexistem na mesma pessoa (Yee, 2006) [misto]. Consequência
[inferência]: oferecer **vários caminhos** (luta, furtividade, construção, cozinha, exploração, apoio ao grupo) serve à
autonomia sem precisar classificar ninguém.

---

## 3. Uso problemático e dano

### 3.1 Transtorno de jogo: o que é e quão comum

- **CID-11, 6C51:** padrão de jogo com controle prejudicado, prioridade crescente sobre outras atividades e continuação
  apesar de consequências negativas, com prejuízo significativo, normalmente por 12 meses; em vigor desde 2022 [norma,
  OMS]. A própria OMS diz que afeta "only a small proportion" de quem joga [norma].
- **DSM-5:** "Internet Gaming Disorder" está na Seção III, condição para estudo futuro, não diagnóstico formal [norma].
- **Prevalência:** 53 estudos, 226.247 participantes, 17 países: cerca de 2%, com heterogeneidade grande e mais em
  adolescentes do sexo masculino (Stevens et al., 2021, com corrigendum em 2023) [misto]; com critérios estritos,
  0,3–1,0% da população geral (Przybylski, Weinstein & Murayama, 2017) [misto].
- **O debate:** um grupo de pesquisadores argumentou que a base científica era fraca e que o diagnóstico traria pânico
  moral e falsos positivos em crianças (Aarseth et al., 2017) [misto]; clínicos responderam que há pessoas buscando
  tratamento e que a categoria serve à saúde pública (Rumpf et al., 2018) [misto]. O consenso prático: **existe, é raro,
  e o jogo típico não é o problema**.

### 3.2 Fatores de risco (o que o design pode piorar)

- **Necessidades frustradas** e jogar para **fugir** delas se associam a uso problemático (Mills et al., 2018; Przybylski
  et al., 2009) [misto].
- **Motivação extrínseca** se associa a bem-estar pior (Vuorre et al., 2022) [misto].
- **Monetização** que obscurece preço, usa dados do jogador para vender na hora certa ou manipula a dificuldade para
  empurrar compra está descrita em patentes da indústria (King et al., 2019) [misto: análise de patentes, não de efeito].
- Consequência [inferência]: o design mais protetor é o mesmo que diverte: competência, autonomia e vínculo **dentro**
  do jogo, sem obrigação e sem venda de alívio.

### 3.3 Loot boxes: a evidência

- Em 7.422 jogadores, o gasto com loot boxes se associou à gravidade do jogo problemático, mais do que o gasto com outros
  itens pagos (Zendle & Cairns, 2018; replicado em 2019) [misto a forte na associação].
- Meta-síntese: 12 de 13 publicações acharam relação positiva com jogo problemático, r médio = 0,27; com uso
  problemático de videogame, r = 0,40 (Spicer et al., 2022) [forte na associação].
- **Adolescentes** de 16 a 18 anos (n = 1.155): a mesma ligação, com motivações de compra parecidas com as de aposta
  (Zendle, Meyer & Over, 2019) [misto].
- **Direção causal:** dois estudos longitudinais de seis meses, um com jovens adultos e outro com adolescentes de 11 a 17
  anos, acharam que comprar loot box prediz começar a apostar e gastar mais depois (Brooks & Clark, 2023;
  González-Cabrera et al., 2023) [misto: seguimento curto, poucos estudos].

### 3.4 Loot boxes: leis e classificações

| Onde                                | O que vale                                                                                                                                                                                                                                                                                                                                                                | Fonte e rótulo                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Brasil**                          | O ECA Digital (Lei 15.211/2025, em vigor desde 17/03/2026) proíbe caixas de recompensa em jogos eletrônicos dirigidos a crianças e adolescentes **ou de acesso provável por eles**; também pede limites a recursos que prolongam artificialmente o uso por menores e proteção máxima por padrão. Multa de até 10% do faturamento no Brasil ou R$ 50 milhões por infração. | [norma, fonte secundária: o texto no Planalto não abriu] |
| **Bélgica**                         | A Comissão de Jogos entendeu em 2018 que loot box paga é jogo de azar sem licença; na prática a proibição foi mal aplicada (Xiao, 2023).                                                                                                                                                                                                                                  | [norma] + [misto] sobre a eficácia                       |
| **Holanda**                         | O Conselho de Estado (março de 2022) anulou a multa de € 5 milhões à EA: loot box não é automaticamente jogo de azar.                                                                                                                                                                                                                                                     | [norma]                                                  |
| **Reino Unido**                     | O governo (2022) preferiu não legislar; a indústria publicou princípios em 2023 (compra por menor de 18 só com consentimento dos pais, aviso de presença, probabilidades). Um estudo longitudinal achou nenhum dos 100 jogos mais rentáveis do iPhone pedindo consentimento (Xiao et al., 2025).                                                                          | [norma] + [misto] sobre a eficácia                       |
| **Austrália**                       | Desde 22/09/2024, jogo com compra ligada a acaso tem classificação mínima M; jogo de azar simulado, R18+.                                                                                                                                                                                                                                                                 | [norma]                                                  |
| **PEGI** (Europa), desde junho/2026 | Item aleatório pago: PEGI 16 por padrão. Oferta com prazo ou estoque limitado: PEGI 12. Mecanismo que premia voltar (missão diária, sequência de login): PEGI 7; se **pune** quem não volta (perde conteúdo ou progresso): PEGI 12. NFT/blockchain: PEGI 18.                                                                                                              | [norma, pegi.info]                                       |
| **União Europeia**                  | Princípios da rede CPC sobre moedas virtuais (março/2025): preço claro, sem esconder custo, atenção a crianças; moedas só ganhas jogando ficam fora do escopo. Diretrizes do art. 28 do DSA (julho/2025): desligar por padrão para menores recursos como **sequências** e notificações push, evitar loot boxes e moedas que escondem o valor real.                        | [norma, não vinculante]                                  |

Nenhuma dessas classificações se aplica diretamente a uma experiência do Roblox (quem classifica é o questionário do
Roblox, §3.7), mas elas são a régua externa mais clara de onde a linha está hoje [inferência].

### 3.5 Dark patterns

- **Taxonomia:** padrões temporais, monetários e sociais "usados de propósito para causar experiências negativas contra
  o interesse do jogador e provavelmente sem o seu consentimento", como grind, jogo por hora marcada (a plantação que
  murcha se você não volta), pagar para pular e pirâmides sociais (Zagal, Björk & Lewis, 2013) [misto: conceitual].
- **A crítica:** chamar um padrão de "sombrio" em si é incoerente, porque o mesmo mecanismo pode ser justo ou abusivo
  conforme o contexto, a intenção e o efeito; faltou base empírica sobre o que jogadores consideram abusivo (Deterding,
  Stenros & Montola, 2020) [misto]. Por isso avaliamos cada mecanismo **no nosso contexto**: público com menores,
  mundo compartilhado, moeda só ganha jogando.
- **Do ponto de vista do jogador:** 1.104 jogadores descreveram 35 técnicas percebidas como injustas, enganosas ou
  agressivas, em oito grupos: dinâmica feita para empurrar gasto, produto abaixo do prometido, cobrar por conforto básico,
  publicidade predatória, moeda virtual, pagar para vencer, microtransação onipresente e outros (Petrovskaya &
  Zendle, 2022) [misto].
- **Caso de fiscalização:** a Epic pagou US$ 245 milhões à FTC por botões confusos que geravam compra com um toque e por
  deixar crianças comprarem sem os pais, mais US$ 275 milhões por violar a COPPA (2022–2023) [norma].

| Padrão                                              | Onde a evidência ou a norma está                           | Nossa situação hoje [repo]                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Acaso pago (loot box, gacha, roleta)                | §3.3, §3.4; política do Roblox (§3.7)                      | Não existe: MON-03 proíbe caixa aleatória, paga ou não                                           |
| Pagar para vencer                                   | Petrovskaya & Zendle (2022); MON-01                        | Não existe: MON-01                                                                               |
| Pagar para pular espera / energia                   | Zagal et al. (2013)                                        | O Rebirth pula a espera do amanhecer **com moedas ganhas jogando**; a espera é grátis            |
| Urgência falsa (contagem, estoque, "última chance") | Diretrizes do Roblox (§3.7); PEGI 12 para oferta com prazo | Não existe; nenhuma regra escrita a proíbe                                                       |
| Sequência que pune ausência                         | Silverman & Barasch (2023); PEGI 12; diretrizes do DSA     | Não existe                                                                                       |
| Hora marcada / algo que apodrece offline            | Zagal et al. (2013)                                        | A obra de quem saiu cai 10 + 5 min depois (MP-24), num mundo que segue vivo; a base não persiste |
| FOMO de exclusivo                                   | Petrovskaya & Zendle (2022)                                | Não existe (não há evento)                                                                       |
| Notificação que culpa ou apressa                    | Diretrizes de notificação do Roblox; diretrizes do DSA     | Não existe (não há notificação)                                                                  |
| Moeda que esconde o preço real                      | Princípios da CPC; diretrizes do DSA                       | Moedas não se compram; preço sempre com o ícone da moeda (UI-13)                                 |
| Compra no momento da perda                          | Petrovskaya & Zendle (2022); ICO (neutralidade)            | A tela de morte oferece o Rebirth **em moedas do jogo**, com a espera grátis ao lado             |
| Dificuldade manipulada para vender                  | King et al. (2019), patentes                               | Não existe: o diretor só ritma a noite e não sabe de moedas                                      |
| Anúncio com recompensa                              | CREATOR_HUB (desligado)                                    | Não existe                                                                                       |

### 3.6 Menores

- **Adolescência:** o modelo de "dois sistemas" propõe recompensa mais saliente e controle ainda imaturo (Steinberg,
  2010); há um pico de resposta do estriado ventral à recompensa na adolescência, mas os resultados são inconsistentes e
  o modelo funciona mais como heurística que como teoria testável (Meisel et al., 2019) [misto]. O que é firme: menor tem
  menos **letramento comercial**, e as normas partem daí [norma].
- **Reino Unido, ICO (Children's Code):** recursos "grudentos", como ciclos de recompensa, rolagem infinita,
  notificações e autoplay, não devem usar dados de crianças para prolongar o uso; as opções de continuar devem ser
  neutras; incentivar pausas sem perda de progresso é recomendado [norma].
- **Brasil:** além do ECA Digital (§3.4), o Código de Defesa do Consumidor proíbe publicidade que se aproveite da
  deficiência de julgamento da criança (art. 37, §2º) e prática que se prevaleça da idade do consumidor (art. 39, IV)
  [norma, texto não reconferido nesta pesquisa].
- **UNICEF/LEGO (RITEC-8):** oito dimensões de bem-estar no jogo digital (segurança, diversidade e inclusão, autonomia,
  emoções, competência, relações, criatividade e identidades), validadas com 787 crianças de 8 a 12 anos em 18 países, e
  um kit de design feito com 35 empresas (UNICEF, 2024) [misto: framework validado qualitativamente].

### 3.7 Roblox: o que a plataforma exige ou recomenda

- **Itens aleatórios pagos** (com Robux ou com moeda comprada com Robux, direta ou indiretamente, via chave ou ticket):
  mostrar todos os resultados e as probabilidades em porcentagem antes da compra; declarar no questionário de maturidade;
  consultar `PolicyService:GetPolicyInfoForPlayerAsync` e esconder a compra de quem tem `ArePaidRandomItemsRestricted`.
  Recompensa aleatória que **não** envolve Robux nem moeda comprável dispensa a divulgação [norma, docs do Roblox via
  Context7]. A mesma API já expõe `IsEndlessContentLoadAllowed` e `IsEndlessContentAutoplayAllowed`, sinal de para onde a
  regulação vai [norma].
- **Monetização:** produtos apresentados de forma "transparent, honest, and user-friendly"; desconto não é genuíno se
  está sempre em promoção nem justo se dura pouco para pressionar; proibido afirmar falsamente estoque ou disponibilidade
  limitada e usar contagem regressiva imprecisa ou que reinicia; para público jovem, trocar "GET IT NOW" por "View Item"
  e "LAST CHANCE, ACT NOW" por "See Price"; "Users must never be misled, confused, or pressured into purchases" [norma,
  create.roblox.com/docs/production/monetization].
- **Notificações de experiência:** só para quem tem 13+ e aceitou pelo prompt padrão; no máximo uma por dia por
  experiência; evitar anúncio disfarçado, **falsa pressão de tempo** e iscas de recompensa [norma].
- **Maturidade e contas:** o questionário é obrigatório; as contas são Roblox Kids (5–8), Roblox Select (9–15, idade
  autodeclarada até ser verificada) e Roblox (16+); **Moderate é acessível à Roblox Select**, depois de uma avaliação do
  jogo com jogadores verificados de 16+ [norma, docs "Kids and Select" e "Content maturity"]. O CREATOR_HUB registra o
  jogo como Moderate [repo]. Consequência [inferência]: **projetar supondo jogadores de 9 a 17 anos.**
- **Controles dos pais:** limite diário de tempo de tela (atingido, a criança sai do Roblox até o dia seguinte) e limite de
  gasto, geridos à distância [norma, Roblox Support e newsroom]. Consequência [inferência]: saídas forçadas vão
  acontecer no meio da noite; o jogo não pode transformá-las em castigo além do que as regras já cobram (MP-12).
- **Contraexemplo da própria plataforma:** a página de boas práticas de anúncio com recompensa sugere oferecê-la "after a
  loss" e usar recompensas por tempo limitado para engajamento, e o pacote de recompensas de engajamento traz recompensa
  por login consecutivo [norma, docs do Roblox]. Não seguimos essas duas sugestões (§5).

---

## 4. O que isso vira no Project Z

### 4.0 O norte e o teste de cinco perguntas

**Norte** [inferência]: sucesso é o jogador que **volta porque vale a pena** (D7, avaliação, satisfação das
necessidades), não o que fica mais tempo. Toda proposta de retenção, economia ou feedback passa por cinco perguntas:

1. **Transparência:** ainda funcionaria se o jogador soubesse exatamente como funciona?
2. **A quem serve:** ajuda o jogador a fazer o que ele quer, ou só move a nossa métrica?
3. **Ausência:** pune quem não jogou, quem saiu cedo ou quem parou?
4. **Menor:** é aceitável para uma criança de 10 anos e para os pais dela?
5. **Dinheiro:** vira pressão ou vantagem se um dia houver Robux?

**Regras propostas para a DESIGN_RULES** (uma categoria nova, **BEM**, bem-estar; este documento só as propõe, quem
decide é o dono):

- **BEM-01 Nada se perde por não jogar.** Nenhum item, progresso, recompensa ou construção salva expira ou apodrece em
  tempo real enquanto o jogador está fora. Exceção documentada: a MP-24 (obra de quem saiu apodrece num servidor que
  continua vivo), porque a cidade é compartilhada e efêmera; numa cidade persistente de servidor privado (gap P1-1), o
  mundo vazio **congela**.
- **BEM-02 Só o mundo tem pressa.** Contagem regressiva só para o que é do jogo (a noite, a janela de 30 s da MP-22);
  nenhuma oferta, preço ou recompensa com prazo ou estoque artificial; nenhum texto de pressão ("last chance", "act now").
- **BEM-03 Acaso nunca à venda.** Nenhum resultado aleatório comprável com Robux ou com moeda que se possa comprar,
  direta ou indiretamente. Sorte só como resultado de jogar (é a MON-03 escrita com a definição do Roblox).
- **BEM-04 A noite termina bem.** Ao amanhecer o jogo fecha o ciclo, diz a verdade sobre o que ficou salvo e deixa sair
  sem custo; nada empurra "mais uma noite".
- **BEM-05 Voltar é premiado, faltar nunca é punido.** Desafios acumulam, sem sequência; recompensa de evento volta ou
  continua ganhável depois.
- **BEM-06 Notificação só aceita, informativa e rara.** Nunca culpa, pressa, sequência ou "sua base está sendo atacada".
- **BEM-07 Sucesso medido com guarda.** Nenhuma mudança fica por aumentar tempo de sessão ou gasto de moedas se piorar o
  retorno (D7), a avaliação da página ou a parada ao amanhecer (§6).
- **BEM-08 Menor por padrão.** Todo texto, preço e recurso é desenhado para um jogador de 9 a 17 anos (§3.7).

Cada subseção abaixo traz: **o que já temos**, o **mecanismo**, a **evidência**, as **recomendações**, o **efeito
esperado**, o **risco a evitar** e **onde** mexer.

### 4.1 Laço central: saque de dia → defesa à noite

- **Já temos** [repo]: dia de 387 s e noite de 218 s (~10 min por dia de jogo); o céu do console com "Night in 2:14" e os
  pips das ondas (UI-09); três ondas às 19h, 22h e 1h; o diretor pico → alívio → subida (`shared/sim/ai/director.ts`);
  as falas de relógio da HUD e os stingers de onda e de amanhecer (`client/audio/gameAudio.ts`).
- **Mecanismo:** ciclo de tensão e alívio com antecipação visível (preparar → testar → aliviar), curiosidade de dia.
- **Evidência:** antecipação e incerteza (§1.3) [forte/misto]; ritmo que oscila (§2.3) [misto]; pico-fim (§2.12)
  [forte]; lacunas de informação (§1.4) [misto].
- **Recomendações** [inferência]:
    1. **Relatório do amanhecer** (§4.7): às 06:00, um cartão que não bloqueia nada (UI-06) com a noite em números
       (sobreviveu, zumbis postos no chão, aliados levantados) e o que ficou salvo. É o pico e o fim no mesmo lugar.
    2. **Motivos para sair de dia com incerteza honesta:** as encomendas do gap P1-5 (a caixa que cai com fumaça e chama a
       horda) e o saque noturno raro do gap P2-9.
    3. **A preparação conversa com a noite:** objetivos de dia que apontam para a noite ("Barricade a window before
       19:00", já no espírito do objetivo da fogueira [repo `objectives.ts`]).
- **Efeito esperado:** mais noites vencidas por quem prepara, sessões que terminam ao amanhecer (§6).
- **Risco a evitar:** o cartão virar um "próxima noite começa em…" que empurra para ficar; recompensa que só paga a quem
  emenda noites; cartão que cobre o perigo (UI-06).
- **Onde:** `client/ui/` (cartão novo, no vocabulário da UI-07), `server/sim/simulation.ts` (`creditDawn`),
  `server/sim/progress.ts`, `shared/data/lang.ts`; ANALYTICS §5.

### 4.2 Curva de dificuldade e ondas

- **Já temos** [repo]: a tabela de ondas do original × S(k) (MP-09); degraus de população nos dias 2, 4, 10, 20 e de
  dificuldade nos dias 15 (×2 vida e dano, +33% velocidade) e 30; o diretor; o funil NightSurvival e o Night por
  `Survivors - Solo/Group`. A dificuldade é a do **dia do mundo** (`server/sim/waves.ts`): um save novo pode cair no dia 20.
- **Mecanismo:** desafio um pouco acima da habilidade, com respiros.
- **Evidência:** desafio prevê diversão, com teto (Abuhamdeh & Csikszentmihalyi, 2012) [forte/misto]; equilíbrio
  constante não é ótimo (Baumann et al., 2016) [misto]; competência prevê retorno (Ryan et al., 2006) [forte];
  necessidade frustrada prevê uso problemático (Mills et al., 2018) [misto]; ajuste dinâmico funciona se não parece
  trapaça (Hunicke, 2005) [misto].
- **Recomendações** [inferência]:
    1. **O novato nunca cai num mundo de dia alto** (gap P0-1: atributo de matchmaking `WorldDay`, preferência por dia ≤ 5
       no primeiro save).
    2. **A primeira noite é vencível para quem é novo:** rodar o experimento 2 da ANALYTICS §12 (dano recebido ×0,75 na
       primeira vida até o amanhecer do dia 2, por jogador, sem mexer na horda compartilhada).
    3. **Suavizar o degrau do dia 15** só depois de ver o NightSurvival (gap P2-6): uma rampa nos dias 12–15 em vez do
       salto, se o funil mostrar o penhasco.
    4. **O diretor só ritma a noite.** Registrar como regra: dificuldade, spawn e saque **nunca** olham moedas, compras ou
       tempo de sessão (o padrão de patente descrito por King et al., 2019).
- **Efeito esperado:** passo 5 do onboarding (primeira noite) e D1 sobem; mortes de `Life day - 1` por `Horde` caem.
- **Risco a evitar:** tornar o jogo fácil para todos (a tensão é o produto); ajuste visível que o jogador sente como
  trapaça; qualquer ligação entre dificuldade e dinheiro.
- **Onde:** `server/sim/waves.ts`, `shared/data/spawns.ts`, `server/sim/combat.ts` (`damageActor`, o knob por jogador),
  `server/config/experiments.ts`; MP-09, MP-13, MP-20.

### 4.3 A tensão da percepção dos zumbis (ponto azul, "?" dourado, "!" vermelho)

- **Já temos** [repo]: olhos com cone, alcance e luz; vislumbre de 0,3–1,5 s antes da certeza; ruído por ação; grito
  limitado (IA-01..03); as marcas da IA-05 com forma **e** cor, contraste medido e Reduzir Movimento.
- **Mecanismo:** incerteza graduada com uma janela para agir (quebrar a linha de visão antes do "!").
- **Evidência:** a ativação de antecipação cresce com a incerteza (Fiorillo et al., 2003) [forte/misto]; competência vem
  de ameaça legível e controlável (Ryan et al., 2006) [forte]; a mordida telegrafada da LEG-04 é o mesmo princípio.
- **Recomendações** [inferência]:
    1. **As marcas nunca mentem:** nenhum "!" falso para subir a tensão; o estado desenhado é sempre o do servidor
       (hoje é [repo]; vira regra).
    2. **Furtividade como caminho de maestria:** dar gatilho real à conquista escondida "Unseen" (Ninja, CON-04), por
       exemplo revistar N prédios numa noite sem virar "!" em nenhum zumbi; o arco silencioso e o Stealth já existem
       (IA-02).
    3. **Aviso fora da tela:** um marcador na borda quando um zumbi em "!" persegue você de fora do enquadramento, para quem
       não ouve (§4.11).
- **Efeito esperado:** mais estilos de jogo (autonomia), mais leitura da ameaça (competência).
- **Risco a evitar:** tensão contínua sem alívio (o diretor já força o respiro); susto repentino (o questionário declara
  Fear **Mild**, CREATOR_HUB); movimento para quem pediu Reduzir Movimento.
- **Onde:** `client/view/zombieAwareness.ts`, `shared/data/achievements.ts`, `server/save/achievements.ts`; IA-05, CON-04.

### 4.4 Progressão: nível, skills, Rebirth, New game, títulos, conquistas

- **Já temos** [repo]: 21 skills, 1 ponto por nível (`shared/game/save.ts`); nível, skills, moedas, pacotes e títulos
  sobrevivem à morte, ao New game e ao fim do mundo (MP-21, MP-22, MON-05); três títulos ganhos jogando; 18 conquistas à
  vista contadas só pelo servidor (CON-04); o level-up é a mensagem "Level UP" e o pulso do nível na placa
  (`client/main.client.ts`, `client/ui/nameplate.ts`); só o admin tem "reset skills" (`shared/admin/ops.ts`).
- **Mecanismo:** competência visível e escolhas que importam.
- **Evidência:** feedback informativo ajuda e recompensa tangível esperada corrói a motivação intrínseca (Deci et
  al., 1999) [forte]; elementos de jogo como incentivo externo (Mekler et al., 2017) [misto]; badges aumentam atividade
  (Hamari, 2017) [misto]; gradiente de meta (Kivetz et al., 2006) [forte]; consequência com sentido (Juul, 2013; Carter
  et al., 2013) [misto].
- **Recomendações** [inferência]:
    1. **O level-up diz o que deu:** "Level 5 · +1 skill point" e onde gastar (Bag › Skills). Feedback informativo, não
       fanfarra vazia.
    2. **Respec grátis uma vez por vida** (ou no New game): errar uma árvore não pode custar dezenas de horas. Autonomia.
       Nunca vendido (MON-01).
    3. **Conquistas de variedade em vez de grind:** as novas pedem **fazer coisas diferentes** (cozinhar, fortificar, não
       ser visto, levantar um aliado), com barra de progresso honesta; contadores gigantes ("mate 10.000") ficam fora.
    4. **Títulos que reconhecem o apoio:** um título para quem levanta aliados (MP-03), outro para a furtividade, pelo mesmo
       caminho da MON-05 (só o servidor concede).
    5. **Rebirth continua honesto:** preço com a moeda, a espera grátis ao lado, o preço que sobe dito na tela (UI-13 já
       faz [repo]).
- **Efeito esperado:** mais skills diferentes em uso (WeaponKills por tipo, Crafted), mais conquistas de sistema.
- **Risco a evitar:** grind extrínseco; placar global que desanima quem está embaixo (§4.10); tornar o New game tão
  caro que ninguém recomeça.
- **Onde:** `client/main.client.ts` (o texto do level-up), `client/ui/backpack.ts` (Skills), `server/sim/progress.ts`,
  `shared/data/achievements.ts`, `shared/data/titles.ts`, `server/save/titles.ts`; MON-01, MON-05, CON-04.

### 4.5 Economia e loja

- **Já temos** [repo]: moedas só jogando (3 por dia sobrevivido, +10 a cada 5 dias de recorde, 8 por chefe, 20 de
  boas-vindas, `shared/data/shop.ts` `ECONOMY`); nove pacotes de conteúdo fixo (MON-03); trajes e pets visíveis
  (MON-04); Rebirth por 10 + 10·d² moedas; nenhuma chamada de `MarketplaceService`; questionário com "Paid random items:
  No".
- **Mecanismo:** metas de gasto que valorizam o tempo jogado, sem pressão.
- **Evidência:** loot boxes e jogo problemático (§3.3) [forte na associação]; técnicas percebidas como abusivas
  (Petrovskaya & Zendle, 2022) [misto]; diretrizes do Roblox, PEGI, CPC, DSA, ECA Digital (§3.4, §3.7) [norma].
- **Recomendações** [inferência]:
    1. **BEM-02 e BEM-03 por escrito** (§4.0), ao lado da MON-01. Hoje a loja é limpa por acaso de escopo; a regra a
       mantém limpa quando o Robux chegar.
    2. **Nunca vender moedas.** Com moedas se compram arma, remédio e o Rebirth: vender moeda transformaria os pacotes em
       pagar para vencer e o Rebirth em pagar para continuar (já dito no gap P2-3; aqui com o motivo de dano).
    3. **Na tela de morte, o foco padrão numa ação paga só é aceitável porque a moeda é ganha jogando.** Se algo ali um
       dia custar Robux, o foco vai para a opção grátis (a espera) e a paga fica ao lado, sem destaque.
    4. **Robux, se vier, só como no MONETIZATION.md** (VIP, paleta, cor da placa), com preço sempre em Robux, sem
       pacotes de moeda, sem promoção com prazo e sem compra dentro da noite.
- **Efeito esperado:** confiança (a linha "No pay-to-win" da página continua verdadeira), nenhuma mudança de
  classificação.
- **Risco a evitar:** o Rebirth virar pagar-para-pular; uma "oferta de boas-vindas" com prazo; qualquer sorteio pago.
- **Onde:** `docs/DESIGN_RULES.md` (MON, BEM), `docs/MONETIZATION.md`, `client/onboarding/gameOver.ts`,
  `server/main.server.ts` (`handleAction`).

### 4.6 Co-op e social

- **Já temos** [repo]: reviver segurando E por 4 s (MP-03); XP de assistência de 60% (MP-15); saque compartilhado
  (MP-05); horda por grupo (MP-09); chat de proximidade filtrado, sem sussurro (MP-17..19); placar da partida (MP-23);
  nada de PvP (MP-01).
- **Mecanismo:** cooperação (objetivo comum) e interdependência leve (cada um traz algo).
- **Evidência:** cooperação e interdependência aumentam vínculo, diversão e confiança (Depping & Mandryk, 2017) [misto];
  jogo pró-social aumenta desfechos pró-sociais (Greitemeyer & Mügge, 2014) [misto]; vínculo é uma das três necessidades
  (Ryan et al., 2006) [forte].
- **Recomendações** [inferência]:
    1. **Pings e falas rápidas** (gap P1-2): no celular e no console digitar no meio da horda não dá.
    2. **Crédito visível por apoio:** levantar um aliado vira linha no relatório do amanhecer, conquista e título (§4.4).
    3. **Papéis legíveis a partir das skills** (gap P2-4): um glifo no placar, sem classe nova.
    4. **Espectar enquanto espera o amanhecer** (gap P1-7): o morto continua no grupo.
    5. **Convite sem prêmio** (gap P1-8): convidar amigos, sim; recompensa por convite, não (pressão sobre relações).
    6. **O solo é de primeira classe** (MP-14, gap P0-2): vínculo é oferta, não obrigação.
- **Efeito esperado:** mais noites em grupo (funil Night por `Survivors - Group`), mais revives, sessões que terminam
  juntas.
- **Risco a evitar:** dependência forçada ("sem o médico você não passa"), mensagens de "o grupo precisa de você",
  toxicidade (o chat continua filtrado e de proximidade), exposição de menores (sem canal privado, MP-17).
- **Onde:** `client/ui/scoreboard.ts`, `server/sim/life.ts` (revive), `server/sim/progress.ts`, `client/ui/hud.ts`;
  MP-03, MP-15, MP-17, MP-23.

### 4.7 Desenho da sessão: parada saudável ao amanhecer, nenhuma punição por ausência

- **Já temos** [repo]: um dia de jogo a cada ~10 min; o amanhecer às 06:00 paga o título Survivor; sair derrubado conta
  como morte e sair em combate espera 5 s (MP-12); o corpo fica guardado 5 min depois de sair (`KEEP_AFTER_LEAVE_S`,
  `server/sim/life.ts`); a obra de quem saiu apodrece depois de 10 + 5 min (`BUILD_ABANDON_GRACE_S`,
  `BUILD_ABANDON_DECAY_S`, MP-24); nenhuma recompensa diária, nenhuma notificação.
- **Mecanismo:** fechar o ciclo no ponto alto e tornar a saída fácil e sem custo.
- **Evidência:** pico-fim (§2.12) [forte]; retomada do inacabado (Ovsiankina) [misto], que pede cuidado com ganchos;
  mensagens de pausa têm efeito moderado e de curto prazo em jogo de azar (meta-análise de 18 estudos, g ≈ 0,5; Bjørseth
  et al., 2021) [misto: transposto de aposta]; o ICO recomenda incentivar pausas sem perda de progresso [norma]; horas
  não são o problema (Vuorre et al., 2022) [forte], então a pausa não é sermão.
- **Recomendações** [inferência]:
    1. **O relatório do amanhecer** diz a verdade sobre o que fica: "Level, skills, coins and titles are saved." Nunca
       "your town will be here": a cidade pública pode acabar ou fechar (MP-22) e a base não persiste [repo]. Dizer
       "saved" só depois de o save do servidor gravar.
    2. **Sair ao amanhecer nunca custa nada:** é a hora sem combate; o texto do menu pode dizer isso.
    3. **Lembrete de pausa só em sessão longa:** depois de ~2 h reais contínuas na cidade, e só no relatório do amanhecer,
       uma linha que se fecha sozinha ("You've played for 2 hours. Dawn is a good place to stop."), uma vez por sessão;
       nunca com recompensa para continuar.
    4. **BEM-01:** se a cidade persistente do gap P1-1 vier, o mundo vazio congela; nada apodrece nem é atacado offline.
    5. **Saída forçada** (limite de tempo dos pais, queda de rede) não ganha castigo novo: o corpo guardado e a MP-12
       bastam; nenhum "abandonou o grupo" público.
- **Efeito esperado:** mais sessões terminando de dia (§6), avaliação da página estável ou melhor, D7 igual ou maior.
- **Risco a evitar:** sermão (autonomia); lembrete que vira ruído; contagem para "a próxima noite"; oferta de "fique mais
  uma".
- **Onde:** `client/ui/` (o cartão), `client/main.client.ts`, `server/main.server.ts` (o save do amanhecer),
  `server/sim/simulation.ts`, `shared/data/lang.ts`; MP-12, MP-21, MP-24, UI-06.

### 4.8 Onboarding e os primeiros 10 minutos

- **Já temos** [repo]: a pergunta do tutorial; cinco objetivos que observam o mundo (andar, pegar, acertar, revistar,
  acender uma fogueira antes das 19:00) sem interromper (`client/onboarding/objectives.ts`); o coach; o funil de
  onboarding (Joined → Tutorial answered → Entered the city → First kill → First night survived); o experimento do pacote
  de boas-vindas (`pz_welcome_pack`); a frase da primeira morte ("Everyone's first night ends this way. The second one
  goes better.", UI-13).
- **Mecanismo:** vitórias cedo e reais, instrução no contexto, falha que ensina.
- **Evidência:** instrução no contexto supera a de antes, e tutorial vale em jogo complexo (Andersen et al., 2012)
  [forte/misto]; competência (Ryan et al., 2006) [forte]; gradiente de meta (Kivetz et al., 2006) [forte]; falha com
  sentido (Juul, 2013) [misto].
- **Recomendações** [inferência]:
    1. **Dia 1 garantido e primeira noite vencível** (§4.2, recomendações 1 e 2).
    2. **A tela de morte ensina:** a causa que o servidor já calcula (`causeOfDeath`: fome, veneno, chefe, horda) com uma
       dica ligada a ela ("Bitten by the horde at 22:14. A barricaded window holds them for a while."). Um byte a mais no
       aviso de morte.
    3. **A loja não é empurrada nos primeiros 10 minutos:** as 20 moedas de boas-vindas existem, mas nenhum objetivo nem
       aviso aponta para a loja antes da primeira noite.
    4. **Objetivos continuam informativos:** não viram fonte de moedas (Deci et al., 1999).
- **Efeito esperado:** passos 4 e 5 do onboarding e D1 sobem; `SessionEnded Where - Dead` na primeira sessão cai.
- **Risco a evitar:** texto demais na tela; mão que segura demais (autonomia); monetizar o novato.
- **Onde:** `client/onboarding/gameOver.ts`, `server/sim/life.ts` (`died`), `server/analytics/events.ts`
  (`causeOfDeath` já existe), `shared/net/protocol.ts`; UI-13, ANALYTICS §2 e §12.

### 4.9 Juice e feedback (acertos, coleta, level-up)

- **Já temos** [repo]: tremida da câmera em tiro e golpe (`client/systems/combat.ts` → `client/view/fxView.ts` →
  `shared/engine/camera.ts`); sangue e entulho; o flash local de acerto (PR #42); a tremida das árvores e carros
  atingidos (`client/view/solidFlinch.ts`); o pulso do nível; toasts de conquista e título; o "pop" das marcas de
  percepção com a variante de Reduzir Movimento; o flash de dano acima dos menus a no máximo 3 por segundo (UI-06).
  **A tremida da câmera e a dos sólidos não consultam `reducedMotion()`** (`client/ui/skin.ts`), ao contrário do resto.
  Faltam sons de mordida, porta, uso de item e lança-chamas (gap §2.18).
- **Mecanismo:** feedback redundante e proporcional ao evento.
- **Evidência:** juice médio a alto é o ótimo (Kao, 2020) [misto]; apelo visual sim, competência às vezes (Hicks et
  al., 2019) [misto]; perdas disfarçadas de ganho (Dixon et al., 2010) [misto]; diretrizes de acessibilidade [norma].
- **Recomendações** [inferência]:
    1. **Reduzir Movimento vale para a tremida:** com ele ligado, a câmera não treme (ou treme a 30%) e o sólido atingido
       pisca em vez de tremer. `fxView.ts` (`applySim`, o `cam.shake`) e `solidFlinch.ts`, com um teste em `test:flinch`
       ou `test:settings`.
    2. **Som para o que importa** (gap P0-4): a mordida primeiro.
    3. **Celebração proporcional:** subir de nível > conquista > abate > coleta; nenhuma festa para gastar moedas, para o
       Rebirth ou para qualquer perda.
    4. **Legibilidade antes do brilho à noite:** com 150 zumbis na tela, o juice não pode cobrir a leitura da LEG-03
       (medir no `test:world-art` se algum efeito novo entrar).
- **Efeito esperado:** mais clareza do que aconteceu, menos enjoo para quem pediu menos movimento.
- **Risco a evitar:** sobrecarga sensorial; flash acima de 3/s; festa que ensina a gostar de gastar.
- **Onde:** `client/view/fxView.ts`, `shared/engine/camera.ts`, `client/view/solidFlinch.ts`, `client/audio/fxAudio.ts`,
  `design/audio-credits.md`; UI-06, LEG-03, LEG-04.

### 4.10 Retenção que respeita

- **Já temos** [repo]: nada de diário, evento, badge, ranking ou notificação (gap §2.20).
- **Mecanismo:** motivos novos para voltar, ancorados em conteúdo que funciona, sem custo por faltar.
- **Evidência:** sequência quebrada derruba o engajamento seguinte (Silverman & Barasch, 2023) [misto]; o PEGI separa
  premiar a volta (PEGI 7) de punir a falta (PEGI 12) e oferta com prazo (PEGI 12) [norma]; as diretrizes do DSA pedem
  sequências desligadas por padrão para menores [norma]; badges aumentam atividade (Hamari, 2017) [misto]; placar absoluto
  desanima quem está embaixo, e placar relativo menos [misto: estudos de gamificação em ensino].
- **Recomendações** [inferência]:
    1. **Contratos diários sem sequência** (redesenho do gap P1-6): três por dia real, cada um vale **72 h** (quem falta
       dois dias encontra seis); sem contador de dias seguidos; recompensa pequena em moedas (a régua é o dia
       sobrevivido, 3) e progresso para um título; temas que ensinam o jogo ("Cook 3 meals", "Barricade a window before
       19:00", "Revive an ally"); contados só pelo servidor (MP-00). Quando feitos na cidade, contam para todos a até
       `INTEREST_MID` de quem fez (vínculo).
    2. **Eventos que voltam** (gap P2-1): a "Long Night" de Halloween com recompensa que volta todo ano ou continua
       ganhável depois por contratos; datas anunciadas antes; nada à venda.
    3. **Badges** (gap P1-4) para conquistas e títulos, nunca por compra.
    4. **Ranking que não humilha** (redesenho do gap P1-9): melhor marca pessoal primeiro, depois amigos, depois a sua
       faixa no global ("top 20%") em vez de uma posição 48.213.
    5. **Notificações: não agora** (CREATOR_HUB). Se um dia: só pelo prompt padrão, nunca na primeira sessão, no máximo uma
       por semana (abaixo do teto de uma por dia do Roblox), só para evento real ("The Long Night starts Friday"), nunca
       culpa nem pressa (BEM-06).
    6. **"Welcome back" é positivo, nunca perda:** voltar depois de semanas pode ganhar um presente pequeno; faltar nunca
       tira nada.
- **Efeito esperado:** D7 e D30 sobem sem subir o p95 da sessão (§6).
- **Risco a evitar:** FOMO, obrigação, classificação mais alta, menores pressionados.
- **Onde:** `server/save/` (contratos, novo), `shared/data/` (tabela de contratos), `server/analytics/events.ts`,
  `client/ui/records.ts`, `client/ui/survivor.ts`; MON-01, MON-05, CON-03, MP-00.

### 4.11 Acessibilidade

- **Já temos** [repo]: Reduzir Movimento, Transparência e Tamanho de Texto do sistema respeitados na UI (`skin.ts`);
  contraste medido (UI-05); estado por forma e cor (IA-05); alvos de toque ≥ 44 px, analógico flutuante e canhoto
  (UI-09, `SettingsData.mirror`); volumes separados de efeitos e música (`soundEffect`, `bgm`); flash ≤ 3/s; esquemas de
  teclas prontos (`SCHEMES` em `client/ui/tutorial.ts`), sem remapeamento livre; reviver exige **segurar** E por 4 s
  (MP-03); nenhum menu pausa (UI-06).
- **Evidência:** as diretrizes básicas do Game Accessibility Guidelines incluem: ajustar a velocidade do jogo, remapear
  controles, evitar imagens que piscam, nenhuma informação essencial só por som ou só por cor, volumes separados,
  ampla escolha de dificuldade e pedir retorno de acessibilidade [norma, gameaccessibilityguidelines.com]; estimativas de
  jogadores com deficiência vão de ~20% a mais, com metodologia variada [fraco a misto].
- **Recomendações** [inferência]:
    1. **Tremida com Reduzir Movimento** (§4.9, P0).
    2. **Nada só por som:** marcador de borda para ameaça fora da tela (zumbi em "!" perseguindo, explosão), além das
       falas de relógio que já aparecem na HUD.
    3. **Play solo com opções de assistência** (junto do gap P0-2): dano recebido menor, dia mais longo; os recordes de uma
       vida assistida ficam marcados, sem vergonha. No mundo compartilhado, só o knob por jogador do §4.2.
    4. **Decisão do dono:** a UI-06 vale "até no solo, para a regra ser uma só". Num servidor reservado de uma pessoa, uma
       pausa real não prejudica ninguém e é a diretriz básica "game speed". Fica registrado como escolha, não como
       recomendação contra a regra.
    5. **Segurar ou alternar:** opção para trocar o "segurar E" (reviver, conserto) por "tocar para começar, tocar para
       parar".
    6. **Remapeamento livre** das teclas e botões (P2) e uma linha "Accessibility feedback" no About apontando para o grupo.
- **Efeito esperado:** menos abandono por barreira física ou sensorial; mais gente consegue ser competente.
- **Risco a evitar:** assistência estigmatizada; excesso de opções no celular; opção que divide o mundo compartilhado.
- **Onde:** `client/view/fxView.ts`, `client/view/solidFlinch.ts`, `client/ui/hud.ts`, `client/ui/settings.ts`,
  `shared/engine/input.ts`, `shared/game/save.ts` (`SettingsData`); UI-06, UI-09, MP-03.

---

## 5. O que NÃO faremos

| #   | Prática                                                                                       | Por quê                                                                                      | Evidência / norma                                                              | Regra          |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- |
| 1   | Loot box, gacha, roleta ou qualquer sorteio comprável com Robux ou com moeda comprável        | Associado a jogo problemático, pior em adolescentes; proibido no Brasil para o nosso público | Spicer et al. (2022) [forte]; ECA Digital, PEGI 16, política do Roblox [norma] | MON-03, BEM-03 |
| 2   | Vender moedas do jogo por Robux                                                               | Transforma pacotes em pagar-para-vencer e o Rebirth em pagar-para-continuar                  | Petrovskaya & Zendle (2022) [misto]                                            | MON-01         |
| 3   | Pagar para vencer: XP, dano, vida, velocidade, reviver, espaço, sorte de saque                | Quebra a noite do amigo que não comprou                                                      | MONETIZATION.md [repo]; Petrovskaya & Zendle (2022) [misto]                    | MON-01         |
| 4   | Pagar (em Robux) para pular espera, energia ou cronômetro                                     | A espera do amanhecer é grátis e continua grátis                                             | Zagal et al. (2013) [misto]                                                    | MON-01, BEM-02 |
| 5   | Sequência de login ou de dias que pune quem falta; recompensa que expira                      | Quem quebra joga menos e se sente pior; sobe a classificação                                 | Silverman & Barasch (2023) [misto]; PEGI 12, DSA [norma]                       | BEM-01, BEM-05 |
| 6   | Construção, item ou progresso que apodrece ou é atacado com o jogador offline                 | Jogo por hora marcada, o exemplo clássico                                                    | Zagal et al. (2013) [misto]                                                    | BEM-01         |
| 7   | Urgência falsa: contagem de oferta, "últimas unidades", oferta relâmpago, "de/por" permanente | Proibido pelas diretrizes do Roblox; oferta com prazo sobe a classificação                   | Roblox, PEGI 12 [norma]                                                        | BEM-02         |
| 8   | Exclusivo de evento que nunca volta; passe pago com prazo                                     | FOMO é pressão, não diversão                                                                 | Petrovskaya & Zendle (2022) [misto]                                            | BEM-05         |
| 9   | Notificação de culpa ou pressa ("sua base está sendo atacada", "sua sequência vai acabar")    | Falsa pressão de tempo é vetada pelo Roblox                                                  | Roblox, DSA [norma]                                                            | BEM-06         |
| 10  | Anúncio com recompensa, inclusive "depois de uma derrota"                                     | Moeda de anúncio compraria capacidade; a sugestão do Roblox é exatamente a que recusamos     | CREATOR_HUB [repo]; docs do Roblox [norma]                                     | MON-01         |
| 11  | Compra com Robux oferecida no momento da perda (tela de morte, derrubado, fim do mundo)       | Explora o pior momento; opções devem ser neutras                                             | ICO [norma]; Petrovskaya & Zendle (2022) [misto]                               | BEM-02, UI-13  |
| 12  | Dificuldade, spawn ou saque ajustados por gasto, moedas ou tempo de sessão                    | Manipular o jogo para vender                                                                 | King et al. (2019) [misto]                                                     | §4.2           |
| 13  | Quase-acerto fabricado; festa em cima de perda                                                | Aumenta a vontade de continuar sem ganho real                                                | Clark et al. (2009), Dixon et al. (2010) [misto]                               | §1.6           |
| 14  | Incentivo personalizado pelos dados do jogador para prolongar a sessão                        | Vetado para crianças pelo ICO; é querer sem gostar                                           | ICO [norma]; Berridge & Robinson (2016) [forte/misto]                          | BEM-07, BEM-08 |
| 15  | Prêmio por convidar amigos                                                                    | Usa relações como alavanca de aquisição                                                      | CREATOR_HUB [repo]; [inferência]                                               | §4.6           |
| 16  | Botão confuso, compra com um toque, "não, prefiro morrer" (confirmshaming)                    | Gerou US$ 245 milhões de acordo com a FTC                                                    | FTC × Epic (2022–2023) [norma]                                                 | UI-12, UI-13   |
| 17  | Grind artificial para vender o atalho                                                         | O tempo do jogador vira mercadoria                                                           | Zagal et al. (2013) [misto]                                                    | MON-01         |
| 18  | Experimento A/B cuja meta é só tempo de sessão ou gasto, sem guarda de bem-estar              | A métrica puxa o design para o querer                                                        | Vuorre et al. (2022) [forte/misto]                                             | BEM-07         |

---

## 6. Como medir se ajuda, sem explorar

### 6.1 Princípio

Cada mudança tem uma **métrica de sucesso** (o jogador está melhor?) e uma **guarda** (estamos puxando o querer sem o
gostar?). A ANALYTICS já fixa que tudo é agregado, do servidor e de cardinalidade baixa [repo `docs/ANALYTICS.md` §1];
nada aqui muda isso. As hipóteses se escrevem antes (ANALYTICS §12).

### 6.2 Por mudança

| Mudança                                      | Sucesso (evento existente)                                                                          | Guarda / sinal de exploração                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Novato em dia baixo; primeira noite vencível | Onboarding passos 4–5 sobem; Night passo 5 por `Life day - 1`; D1                                   | `Died` por `Cause - Horde` em `Life day - 1` não pode subir; NightSurvival dos veteranos não pode ficar trivial |
| Relatório do amanhecer + parada saudável     | `SessionEnded` com `Time - Day` sobe (e `Time - Dawn`, se criado); D7 igual ou maior                | p95 de `SessionEnded` (minutos) não sobe sem D7 subir; `Where - Dead` não sobe                                  |
| Lembrete de pausa                            | Sessões que terminam depois do lembrete (`BreakNudge`, novo)                                        | Avaliação da página (Feedback) não cai; D7 não cai                                                              |
| A morte ensina                               | As vidas seguintes vão mais longe: NightSurvival passos 2–3 e `LifeEnded` (dia alcançado) sobem     | Conversão do funil Rebirth subindo sem as vidas ficarem mais longas = empurrão para gastar, não aprendizado     |
| Contratos diários                            | D7/D30; `TitleEarned` do título de contratos; `Crafted` e `ItemsUsed` sobem (sistemas descobertos)  | p95 da sessão e sessões por dia sobem sem D7; fatia de jogadores com sessão > 3 h sobe                          |
| Co-op (pings, revive, espectar)              | Night por `Survivors - Group`; revives por sessão (novo, agregado); `LifeEnded` mais longo em grupo | `SessionEnded Where - Dead` sobe (espectar prendendo morto na tela)                                             |
| Progressão informativa e respec              | `WeaponKills` com mais tipos por usuário; `Levels`                                                  | Nenhuma: não mexe em gasto                                                                                      |
| Loja (sempre)                                | `Shop` Opened → Bought por `Coins`                                                                  | `Tried to buy` com `Coins - 0-9` alto (frustração); gasto de moedas subindo depois de mudança de UI             |
| Acessibilidade                               | `SessionEnded` com `Visit - Returning`; Feedback                                                    | Nenhuma                                                                                                         |

Métricas da plataforma que vêm sozinhas [repo ANALYTICS §7]: retenção D1/D7/D30, tempo de sessão, jogo por usuário e a
página de Feedback (votos e comentários): é o nosso melhor termômetro do **gostar**.

### 6.3 Guardas de bem-estar (ponto de partida)

Olhar 2–4 semanas de base antes de fixar números; os valores abaixo são o ponto de partida [inferência]:

- **Cauda da sessão:** p95 de `SessionEnded` (minutos) e a fatia de sessões acima de 3 h. Uma mudança que aumenta
  qualquer um dos dois em mais de 15% **sem** aumentar D7 é revista.
- **Onde se para:** fatia de `SessionEnded` com `Time - Day` (dia e amanhecer) contra `Time - Night`. Queremos que suba.
- **Gasto sob pressão:** conversão do funil Rebirth por `Afford - Yes`. Subindo depois de mudança de interface, sem
  mudança nas noites vividas, é empurrão.
- **Gostar:** votos e comentários da página (Feedback), semanalmente. Queda depois de uma mudança de retenção é alarme
  mesmo com D7 subindo.

### 6.4 Eventos novos propostos (seguindo a ANALYTICS §9)

- `SessionEnded`: novo valor `Time - Dawn` (06:00–07:30 do mundo), para separar a parada saudável do dia comum.
- `BreakNudge` (custom, sem valor): mostrado; campo `Left - Yes/No` (saiu em até 2 min).
- `ContractDone` (custom, agregado na saída, como o `Crafted`): valor = contratos feitos na sessão; campo `Kind - …`
  com os temas fixos.
- `Revives` (custom, agregado na saída): valor = aliados levantados na sessão.
- Opcional, P2: uma pergunta de um toque no relatório do amanhecer, rara (uma vez por semana, no máximo), com três
  respostas fixas ("Great / OK / Not fun"), para medir valor percebido (Ballou et al., 2025) sem texto livre.

---

## 7. Lista priorizada

**P0** = antes de abrir o jogo, ou pequeno e protege de dano. **P1** = maior impacto em seguida. **P2** = depois.
Os IDs "gap" são os de `docs/research/DEAD_TOWN_GAP_ANALYSIS.md` §5.

| ID   | O quê                                                                                        | Evidência principal                                     | Esforço       | Arquivos / regras                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P0-1 | Regras BEM-01..08 na DESIGN_RULES e a regra "o diretor só ritma a noite"                     | §3.4, §3.5, §3.7 [norma]; §2.2 [forte]                  | S             | `docs/DESIGN_RULES.md` (categoria BEM, MON-03), `docs/MONETIZATION.md`                                                   |
| P0-2 | Tremida da câmera e dos sólidos respeita Reduzir Movimento                                   | Game Accessibility Guidelines [norma]                   | S             | `client/view/fxView.ts`, `shared/engine/camera.ts`, `client/view/solidFlinch.ts`; teste em `test:flinch`/`test:settings` |
| P0-3 | Novato nunca num mundo de dia alto (= gap P0-1)                                              | Competência [forte]; necessidade frustrada [misto]      | S–M           | `server/sim/waves.ts`, matchmaking; MP-09, MP-13, MP-20                                                                  |
| P0-4 | Som da mordida e dos eventos centrais (= gap P0-4)                                           | Feedback informativo [forte]; juice [misto]             | S–M           | `client/audio/fxAudio.ts`, `design/audio-credits.md`; LEG-04                                                             |
| P0-5 | Guardas de bem-estar e hipóteses escritas antes de qualquer retenção                         | Querer × gostar [forte/misto]; Vuorre et al. [forte]    | S             | `docs/ANALYTICS.md` (seção nova), painel do Creator Hub                                                                  |
| P1-1 | Relatório do amanhecer + "salvo" verdadeiro + lembrete só em sessão longa                    | Pico-fim [forte]; pausas [misto]; ICO [norma]           | M             | `client/ui/` (cartão novo), `server/sim/simulation.ts`, `server/main.server.ts`, `lang.ts`; UI-06, UI-07, MP-21          |
| P1-2 | Primeira noite vencível (experimento 2 da ANALYTICS §12)                                     | Competência [forte]; desafio com teto [misto]           | M             | `server/sim/combat.ts`, `server/config/experiments.ts`                                                                   |
| P1-3 | A tela de morte mostra a causa e uma dica                                                    | Falha com sentido [misto]; feedback informativo [forte] | S–M           | `client/onboarding/gameOver.ts`, `server/sim/life.ts`, `shared/net/protocol.ts`; UI-13                                   |
| P1-4 | Contratos diários sem sequência (redesenho do gap P1-6)                                      | Streaks [misto]; PEGI [norma]                           | M             | `server/save/` (novo), `shared/data/` (tabela), `server/analytics/events.ts`; MON-01, MON-05, CON-03                     |
| P1-5 | Co-op: pings (gap P1-2), crédito e título por reviver, espectar (gap P1-7)                   | Cooperação e interdependência [misto]                   | M cada        | `client/ui/hud.ts`, `client/ui/scoreboard.ts`, `server/sim/life.ts`, `shared/data/titles.ts`; MP-03, MP-17, MON-05       |
| P1-6 | Play solo com assistência (junto do gap P0-2); decisão do dono sobre pausa no solo reservado | Autonomia [forte]; dificuldade ampla [norma]            | M             | `server/sim/`, `client/ui/survivor.ts`; MP-14, UI-06                                                                     |
| P1-7 | Level-up informativo e respec grátis por vida                                                | Feedback informativo [forte]; autonomia [forte]         | S–M           | `client/main.client.ts`, `client/ui/backpack.ts`, `server/sim/progress.ts`                                               |
| P1-8 | Marcador de ameaça fora da tela                                                              | "Nada só por som" [norma]                               | M             | `client/ui/hud.ts`, `client/view/zombieAwareness.ts`; IA-05, LEG-03                                                      |
| P1-9 | Badges para conquistas e títulos (= gap P1-4)                                                | Badges [misto]                                          | S             | `server/save/achievements.ts`, `server/save/titles.ts`; CON-04                                                           |
| P2-1 | Eventos que voltam (redesenho do gap P2-1)                                                   | FOMO [misto]; PEGI 12 [norma]                           | M cada        | `shared/data/`, `server/`; MON-01, APO-03, BEM-05                                                                        |
| P2-2 | Ranking pessoal, de amigos e por faixa (redesenho do gap P1-9)                               | Placar relativo [misto]                                 | M             | `client/ui/records.ts`, `OrderedDataStore`; MON-05                                                                       |
| P2-3 | Suavizar o degrau do dia 15 com dados (= gap P2-6)                                           | Desafio com teto [misto]                                | S             | `shared/game/save.ts` (`difficultyOfDay`), `shared/data/spawns.ts`                                                       |
| P2-4 | Conquistas de variedade: "Unseen" com gatilho de furtividade; nada de contador gigante       | Deci et al. [forte]; Mekler et al. [misto]              | S–M           | `shared/data/achievements.ts`, `server/save/achievements.ts`; CON-04                                                     |
| P2-5 | Segurar ou alternar; remapeamento livre; linha "Accessibility feedback"                      | Game Accessibility Guidelines [norma]                   | M             | `shared/engine/input.ts`, `client/ui/settings.ts`, `shared/game/save.ts`                                                 |
| P2-6 | Pergunta de valor de um toque, rara                                                          | Valor percebido [misto]                                 | S             | `server/analytics/events.ts`; ANALYTICS §1                                                                               |
| P2-7 | Política de notificações (hoje: nenhuma)                                                     | Roblox, DSA [norma]                                     | S             | `docs/CREATOR_HUB.md`; BEM-06                                                                                            |
| P2-8 | Se a cidade persistente vier (gap P1-1): o mundo vazio congela                               | Hora marcada [misto]                                    | parte do L–XL | `server/save/` (formato novo); BEM-01, MP-24                                                                             |

---

## 8. Limites deste documento

- **Acesso:** o texto integral de Koepp et al. (1998) e várias páginas de editoras (Nature, Springer, PubMed) não abriram
  daqui; usamos resumos e fontes secundárias, e o texto diz quando. O texto do ECA Digital no Planalto devolveu 503: o
  que está na §3.4 vem de três fontes secundárias concordantes. O CDC (§3.6) foi citado sem reconferir o texto.
- **Transposição:** boa parte da evidência de dano vem de jogo de azar (pop-ups, quase-acerto) ou de gamificação em
  ensino (placar); rotulamos como [misto] quando é esse o caso.
- **Números do Roblox** (tiers de conta, limites de notificação) são os da documentação lida em 2026-09-24 via Context7 e
  create.roblox.com; a plataforma muda. Conferir no Creator Hub antes de decidir.
- **Nada aqui foi implementado.** Este commit é só o documento; as regras BEM são proposta para o dono.

---

## 9. Referências

Consultadas em 2026-09-24.

**Neurociência da recompensa**

- Schultz, W., Dayan, P., & Montague, P. R. (1997). A neural substrate of prediction and reward. _Science_, 275,
  1593–1599. <https://pubmed.ncbi.nlm.nih.gov/9054347/>
- Fiorillo, C. D., Tobler, P. N., & Schultz, W. (2003). Discrete coding of reward probability and uncertainty by dopamine
  neurons. _Science_, 299, 1898–1902. <https://pubmed.ncbi.nlm.nih.gov/12649484/>
- Niv, Y., Duff, M. O., & Dayan, P. (2005). Dopamine, uncertainty and TD learning. _Behavioral and Brain Functions_, 1, 6.
  <https://link.springer.com/article/10.1186/1744-9081-1-6>
- Berridge, K. C., & Kringelbach, M. L. (2015). Pleasure systems in the brain. _Neuron_, 86(3), 646–664.
  <https://sites.lsa.umich.edu/berridge-lab/wp-content/uploads/sites/743/2019/09/Pleasure-Systems-in-the-Brain.pdf>
- Berridge, K. C., & Robinson, T. E. (2016). Liking, wanting, and the incentive-sensitization theory of addiction.
  _American Psychologist_, 71(8), 670–679. <https://pmc.ncbi.nlm.nih.gov/articles/PMC5171207/>
- Robinson, T. E., & Berridge, K. C. (2025). The incentive-sensitization theory of addiction 30 years on. _Annual Review
  of Psychology_. <https://www.annualreviews.org/content/journals/10.1146/annurev-psych-011624-024031>
- Koepp, M. J., et al. (1998). Evidence for striatal dopamine release during a video game. _Nature_, 393, 266–268.
  <https://pubmed.ncbi.nlm.nih.gov/9607763/>
- Clark, L., Lawrence, A. J., Astley-Jones, F., & Gray, N. (2009). Gambling near-misses enhance motivation to gamble and
  recruit win-related brain circuitry. _Neuron_, 61(3), 481–490. <https://pubmed.ncbi.nlm.nih.gov/19217383/>
- Chase, H. W., & Clark, L. (2010). Gambling severity predicts midbrain response to near-miss outcomes. _Journal of
  Neuroscience_, 30(18), 6180–6187. <https://www.jneurosci.org/content/30/18/6180>
- Dixon, M. J., Harrigan, K. A., Sandhu, R., Collins, K., & Fugelsang, J. A. (2010). Losses disguised as wins in modern
  multi-line video slot machines. _Addiction_, 105, 1819–1824. <https://onlinelibrary.wiley.com/doi/10.1111/j.1360-0443.2010.03050.x>
- Loewenstein, G. (1994). The psychology of curiosity: A review and reinterpretation. _Psychological Bulletin_, 116(1),
  75–98. <https://www.cmu.edu/dietrich/sds/docs/loewenstein/PsychofCuriosity.pdf>
- Kidd, C., & Hayden, B. Y. (2015). The psychology and neuroscience of curiosity. _Neuron_, 88(3), 449–460.
  <https://pubmed.ncbi.nlm.nih.gov/26539887/>
- Gruber, M. J., Gelman, B. D., & Ranganath, C. (2014). States of curiosity modulate hippocampus-dependent learning via
  the dopaminergic circuit. _Neuron_, 84(2), 486–496. <https://pubmed.ncbi.nlm.nih.gov/25284006/>
- Ferster, C. B., & Skinner, B. F. (1957). _Schedules of Reinforcement_. Appleton-Century-Crofts.

**Motivação, bem-estar e design**

- Ryan, R. M., Rigby, C. S., & Przybylski, A. (2006). The motivational pull of video games: A self-determination theory
  approach. _Motivation and Emotion_, 30, 347–363.
  <https://selfdeterminationtheory.org/SDT/documents/2006_RyanRigbyPrzybylski_MandE.pdf>
- Przybylski, A. K., Rigby, C. S., & Ryan, R. M. (2010). A motivational model of video game engagement. _Review of General
  Psychology_, 14(2), 154–166. <https://selfdeterminationtheory.org/SDT/documents/2010_PrzybylskiRigbyRyan_ROGP.pdf>
- Przybylski, A. K., Weinstein, N., Ryan, R. M., & Rigby, C. S. (2009). Having to versus wanting to play. _CyberPsychology
  & Behavior_, 12(5), 485–492. <https://pubmed.ncbi.nlm.nih.gov/19772442/>
- Mills, D. J., Milyavskaya, M., Heath, N. L., & Derevensky, J. L. (2018). Gaming motivation and problematic video gaming:
  The role of needs frustration. _European Journal of Social Psychology_, 48(4), 551–559.
  <https://www.semanticscholar.org/paper/Gaming-Motivation-and-Problematic-Video-Gaming:-The-Mills-Milyavskaya/2617d314d45fc8f6dd982a1f72ad1e8aeb2f9fc4>
- Tyack, A., & Mekler, E. D. (2020). Self-determination theory in HCI games research: Current uses and open questions.
  _CHI 2020_. <https://dl.acm.org/doi/abs/10.1145/3313831.3376723>
- Ballou, N., et al. (2024). The Basic Needs in Games Scale (BANGS). _International Journal of Human-Computer Studies_,
  188, 103289. <https://www.sciencedirect.com/science/article/pii/S1071581924000739>
- Vuorre, M., Johannes, N., Magnusson, K., & Przybylski, A. K. (2022). Time spent playing video games is unlikely to
  impact well-being. _Royal Society Open Science_, 9, 220411. <https://pubmed.ncbi.nlm.nih.gov/35911206/>
- Johannes, N., Vuorre, M., & Przybylski, A. K. (2021). Video game play is positively correlated with well-being. _Royal
  Society Open Science_, 8, 202049. <https://pubmed.ncbi.nlm.nih.gov/33972879/>
- Ballou, N., Vuorre, M., Hakman, T., Magnusson, K., & Przybylski, A. K. (2025). Perceived value of video games, but not
  hours played, predicts mental well-being in casual adult Nintendo players. _Royal Society Open Science_, 12(3), 241174. <https://pmc.ncbi.nlm.nih.gov/articles/PMC11896691/>
- Orben, A., & Przybylski, A. K. (2019). The association between adolescent well-being and digital technology use.
  _Nature Human Behaviour_, 3, 173–182. <https://www.nature.com/articles/s41562-018-0506-1>
- Csikszentmihalyi, M. (1990). _Flow: The Psychology of Optimal Experience_. Harper & Row.
- Abuhamdeh, S., & Csikszentmihalyi, M. (2012). The importance of challenge for the enjoyment of intrinsically motivated,
  goal-directed activities. _Personality and Social Psychology Bulletin_, 38(3), 317–330.
  <https://doi.org/10.1177/0146167211427147>
- Baumann, N., Lürig, C., & Engeser, S. (2016). Flow and enjoyment beyond skill-demand balance: The role of game pacing
  curves and personality. _Motivation and Emotion_, 40, 507–519. <https://doi.org/10.1007/s11031-016-9549-7>
- Hunicke, R. (2005). The case for dynamic difficulty adjustment in games. _ACE 2005_.
  <https://dl.acm.org/doi/10.1145/1178477.1178573>
- Booth, M. (2009). The AI systems of Left 4 Dead. AIIDE 2009 (Valve).
  <https://steamcdn-a.akamaihd.net/apps/valve/2009/ai_systems_of_l4d_mike_booth.pdf>
- Juul, J. (2013). _The Art of Failure: An Essay on the Pain of Playing Video Games_. MIT Press.
  <https://mitpress.mit.edu/9780262529952/the-art-of-failure/>
- Carter, M., Gibbs, M., & Wadley, G. (2013). Death and dying in DayZ. _Interactive Entertainment 2013_.
  <https://dl.acm.org/doi/pdf/10.1145/2513002.2513013>
- Deci, E. L., Koestner, R., & Ryan, R. M. (1999). A meta-analytic review of experiments examining the effects of extrinsic
  rewards on intrinsic motivation. _Psychological Bulletin_, 125(6), 627–668.
  <https://home.ubalt.edu/tmitch/642/articles%20syllabus/Deci%20Koestner%20Ryan%20meta%20IM%20psy%20bull%2099.pdf>
- Mekler, E. D., Brühlmann, F., Tuch, A. N., & Opwis, K. (2017). Towards understanding the effects of individual
  gamification elements on intrinsic motivation and performance. _Computers in Human Behavior_, 71, 525–534.
  <https://www.sciencedirect.com/science/article/abs/pii/S0747563215301229>
- Hamari, J. (2017). Do badges increase user activity? A field experiment on the effects of gamification. _Computers in
  Human Behavior_, 71, 469–478.
  <https://bibbase.org/network/publication/hamari-dobadgesincreaseuseractivityafieldexperimentontheeffectsofgamification-2017>
- Depping, A. E., & Mandryk, R. L. (2017). Cooperation and interdependence: How multiplayer games increase social
  closeness. _CHI PLAY 2017_, 449–461. <https://dl.acm.org/doi/10.1145/3116595.3116639>
- Greitemeyer, T., & Mügge, D. O. (2014). Video games do affect social outcomes. _Personality and Social Psychology
  Bulletin_, 40(5), 578–589. <https://journals.sagepub.com/doi/full/10.1177/0146167213520459>
- Kivetz, R., Urminsky, O., & Zheng, Y. (2006). The goal-gradient hypothesis resurrected. _Journal of Marketing
  Research_, 43, 39–58. <https://home.uchicago.edu/ourminsky/Goal-Gradient_Illusionary_Goal_Progress.pdf>
- Nunes, J. C., & Drèze, X. (2006). The endowed progress effect. _Journal of Consumer Research_, 32(4), 504–512.
  <https://www.researchgate.net/publication/23547282_The_Endowed_Progress_Effect_How_Artificial_Advancement_Increases_Effort>
- Ghibellini, R., & Meier, B. (2025). Interruption, recall and resumption: A meta-analysis of the Zeigarnik and
  Ovsiankina effects. _Humanities and Social Sciences Communications_, 12, 962.
  <https://www.nature.com/articles/s41599-025-05000-w>
- Silverman, J., & Barasch, A. (2023). On or off track: How (broken) streaks affect consumer decisions. _Journal of
  Consumer Research_, 49(6), 1095–1117. <https://academic.oup.com/jcr/article-abstract/49/6/1095/6623414>
- Brown, A. L., Imai, T., Vieider, F. M., & Camerer, C. F. (2024). Meta-analysis of empirical estimates of loss aversion.
  _Journal of Economic Literature_, 62(2), 485–516. <https://www.aeaweb.org/articles?id=10.1257%2Fjel.20221698>
- Yechiam, E., & Zeif, D. (2025). Loss aversion is not robust: A re-meta-analysis. _Journal of Economic Psychology_, 107, 102801. <https://www.sciencedirect.com/science/article/abs/pii/S0167487025000133>
- Gal, D., & Rucker, D. D. (2018). The loss of loss aversion: Will it loom larger than its gain? _Journal of Consumer
  Psychology_, 28(3), 497–516. <https://myscp.onlinelibrary.wiley.com/doi/abs/10.1002/jcpy.1047>
- Kahneman, D., Fredrickson, B. L., Schreiber, C. A., & Redelmeier, D. A. (1993). When more pain is preferred to less:
  Adding a better end. _Psychological Science_, 4(6), 401–405. <https://doi.org/10.1111/j.1467-9280.1993.tb00589.x>
- Alaybek, B., et al. (2022). All's well that ends (and peaks) well? A meta-analysis of the peak-end rule and duration
  neglect. _Organizational Behavior and Human Decision Processes_, 170, 104149.
  <https://www.sciencedirect.com/science/article/abs/pii/S0749597822000334>
- Hicks, K., Gerling, K., Dickinson, P., & Vanden Abeele, V. (2019). Juicy game design: Understanding the impact of visual
  embellishments on player experience. _CHI PLAY 2019_, 185–197.
  <https://www.semanticscholar.org/paper/Juicy-Game-Design:-Understanding-the-Impact-of-on-Hicks-Gerling/5914c05b99f717e4ada667e1b23630493eabf3ad>
- Kao, D. (2020). The effects of juiciness in an action RPG. _Entertainment Computing_, 34.
  <https://www.sciencedirect.com/science/article/pii/S1875952118300879>
- Andersen, E., et al. (2012). The impact of tutorials on games of varying complexity. _CHI 2012_, 59–68.
  <https://grail.cs.washington.edu/projects/game-abtesting/chi2012/chi2012.pdf>
- Yee, N. (2006). Motivations for play in online games. _CyberPsychology & Behavior_, 9(6), 772–775.
  <https://journals.sagepub.com/doi/10.1089/cpb.2006.9.772>
- Hopson, J. (2001). Behavioral game design. _Gamasutra_ (ensaio de indústria, citado só como exemplo de folclore).
- Game Accessibility Guidelines, nível básico. <https://gameaccessibilityguidelines.com/basic/>
- Microsoft. Xbox Accessibility Guidelines. <https://learn.microsoft.com/en-us/xbox/accessibility/guidelines>

**Uso problemático, loot boxes e monetização**

- Organização Mundial da Saúde. Addictive behaviours: Gaming disorder (perguntas e respostas).
  <https://www.who.int/news-room/questions-and-answers/item/addictive-behaviours-gaming-disorder>
- Stevens, M. W. R., Dorstyn, D., Delfabbro, P. H., & King, D. L. (2021). Global prevalence of gaming disorder: A
  systematic review and meta-analysis. _Australian & New Zealand Journal of Psychiatry_, 55, 553–568 (corrigendum 2023).
  <https://journals.sagepub.com/doi/10.1177/0004867420962851>
- Przybylski, A. K., Weinstein, N., & Murayama, K. (2017). Internet gaming disorder: Investigating the clinical relevance
  of a new phenomenon. _American Journal of Psychiatry_, 174(3), 230–236. <https://pubmed.ncbi.nlm.nih.gov/27809571/>
- Aarseth, E., et al. (2017). Scholars' open debate paper on the World Health Organization ICD-11 Gaming Disorder
  proposal. _Journal of Behavioral Addictions_, 6(3), 267–270. <https://akjournals.com/view/journals/2006/6/3/article-p267.xml>
- Rumpf, H.-J., et al. (2018). Including gaming disorder in the ICD-11: The need to do so from a clinical and public
  health perspective. _Journal of Behavioral Addictions_, 7(3), 556–561. <https://pubmed.ncbi.nlm.nih.gov/30010410/>
- Zendle, D., & Cairns, P. (2018). Video game loot boxes are linked to problem gambling: Results of a large-scale survey.
  _PLOS ONE_, 13(11), e0206767. <https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0206767>
- Zendle, D., & Cairns, P. (2019). Loot boxes are again linked to problem gambling: Results of a replication study. _PLOS
  ONE_. <https://pmc.ncbi.nlm.nih.gov/articles/PMC6405116/>
- Zendle, D., Meyer, R., & Over, H. (2019). Adolescents and loot boxes: Links with problem gambling and motivations for
  purchase. _Royal Society Open Science_, 6, 190049.
  <https://royalsocietypublishing.org/rsos/article/6/6/190049/94826/Adolescents-and-loot-boxes-links-with-problem>
- Spicer, S. G., et al. (2022). Loot boxes, problem gambling and problem video gaming: A systematic review and
  meta-synthesis. _New Media & Society_, 24, 1001–1022. <https://journals.sagepub.com/doi/10.1177/14614448211027175>
- Brooks, G. A., & Clark, L. (2023). The gamblers of the future? Migration from loot boxes to gambling in a longitudinal
  study of young adults. _Computers in Human Behavior_. <https://www.sciencedirect.com/science/article/pii/S0747563222004253>
- González-Cabrera, J., et al. (2023). Loot box purchases and their relationship with internet gaming disorder and
  online gambling disorder in adolescents: A prospective study. _Computers in Human Behavior_.
  <https://www.sciencedirect.com/science/article/pii/S0747563223000365>
- Xiao, L. Y. (2023). Breaking ban: Belgium's ineffective gambling law regulation of video game loot boxes. _Collabra:
  Psychology_, 9(1), 57641. <https://online.ucpress.edu/collabra/article/9/1/57641/195100/Breaking-Ban-Belgium-s-Ineffective-Gambling-Law>
- Xiao, L. Y., et al. (2025). Non-compliance with and non-enforcement of UK loot box industry self-regulation on the Apple
  App Store. _Royal Society Open Science_, 12(5), 250704. <https://pmc.ncbi.nlm.nih.gov/articles/PMC12115820/>
- Zagal, J. P., Björk, S., & Lewis, C. (2013). Dark patterns in the design of games. _FDG 2013_, 39–46.
  <https://www.semanticscholar.org/paper/Dark-patterns-in-the-design-of-games-Zagal-Bj%C3%B6rk/19a241378b06d868eb5f6b76027172c3aaca86f4>
- Deterding, S., Stenros, J., & Montola, M. (2020). Against "dark game design patterns". _DiGRA 2020_.
  <https://eprints.whiterose.ac.uk/id/eprint/156460/>
- Petrovskaya, E., & Zendle, D. (2022). Predatory monetisation? A categorisation of unfair, misleading and aggressive
  monetisation techniques in digital games from the player perspective. _Journal of Business Ethics_, 181, 1065–1081.
  <https://link.springer.com/article/10.1007/s10551-021-04970-6>
- King, D. L., Delfabbro, P. H., Gainsbury, S. M., Dreier, M., Greer, N., & Billieux, J. (2019). Unfair play? Video games
  as exploitative monetized services. _Computers in Human Behavior_, 101, 131–143.
  <https://www.sciencedirect.com/science/article/pii/S0747563219302602>
- Bjørseth, B., et al. (2021). The effects of responsible gambling pop-up messages on gambling behaviors and cognitions:
  A systematic review and meta-analysis. _Frontiers in Psychiatry_, 11, 601800.
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC7868407/>
- Auer, M., & Griffiths, M. D. (2015). Testing normative and self-appraisal feedback in an online slot-machine pop-up
  message in a real-world setting. _Frontiers in Psychology_, 6, 339.
  <https://www.frontiersin.org/articles/10.3389/fpsyg.2015.00339/pdf>
- Steinberg, L. (2010). A dual systems model of adolescent risk-taking. _Developmental Psychobiology_, 52(3), 216–224.
  <https://pubmed.ncbi.nlm.nih.gov/20213754/>
- Meisel, S. N., Fosco, W. D., Hawk, L. W., & Colder, C. R. (2019). Mind the gap: A review and recommendations for
  statistically evaluating Dual Systems models of adolescent risk behavior. _Developmental Cognitive Neuroscience_, 39, 100681. <https://pmc.ncbi.nlm.nih.gov/articles/PMC6969358/>

**Normas, reguladores e plataforma**

- OMS, CID-11, 6C51 Gaming disorder. <https://www.who.int/news-room/questions-and-answers/item/addictive-behaviours-gaming-disorder>
- Brasil, Lei 15.211/2025 (ECA Digital). Fontes secundárias: ASCJogos
  <https://www.ascjogos.org.br/en/post/brazil-loot-box-ban-eca-digital-kids-games>; Assis e Mendes
  <https://assisemendes.com.br/loot-boxes-eca-digital-e-monetizacao-em-jogos-2836273/>; Factotum
  <https://factotumcom.substack.com/p/brazil-digital-eca-bans-loot-boxes>. Texto oficial (não abriu):
  <https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/lei/L15211.htm>
- Holanda, Raad van State (9/3/2022), EA × Kansspelautoriteit. <https://cms-lawnow.com/en/ealerts/2022/03/dutch-court-rules-fifa-loot-boxes-not-a-game-of-chance-revokes-ea-penalty>
- Reino Unido: House of Commons Library, "Loot boxes in video games" <https://commonslibrary.parliament.uk/research-briefings/cbp-8498/>;
  Ukie, "New loot box principles agreed by industry" (2023) <https://ukie.org.uk/news/new-loot-box-principles-agreed-by-industry>
- Austrália, Classification: "New classifications for gambling-like content in video games" (2024).
  <https://www.classification.gov.au/about-us/media-and-news/news/new-classifications-for-gambling-content-video-games>
- PEGI (2026). PEGI expands age rating criteria with interactive risk categories.
  <https://pegi.info/news/pegi-expands-age-rating-criteria-interactive-risk-categories>
- Comissão Europeia, rede CPC (2025). Key principles on in-game virtual currencies.
  <https://commission.europa.eu/document/download/8af13e88-6540-436c-b137-9853e7fe866a_en?filename=Key+principles+on+in-game+virtual+currencies.pdf>
- Comissão Europeia (2025). Guidelines on the protection of minors (art. 28 DSA).
  <https://digital-strategy.ec.europa.eu/en/library/commission-publishes-guidelines-protection-minors>
- UK ICO. Age appropriate design code, padrão 5 (uso prejudicial de dados) e 13 (técnicas de nudge).
  <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/>
- FTC (2022, 2023). Epic Games: US$ 245 milhões por dark patterns; US$ 275 milhões por COPPA.
  <https://www.ftc.gov/news-events/news/press-releases/2023/03/ftc-finalizes-order-requiring-fortnite-maker-epic-games-pay-245-million-tricking-users-making>
- UNICEF & LEGO Group (2024). RITEC Design Toolbox e framework RITEC-8.
  <https://www.unicef.org/childrightsandbusiness/workstreams/responsible-technology/online-gaming/ritec-design-toolbox>
- Roblox Creator Docs (via Context7 `/websites/create_roblox` e create.roblox.com): Paid random items
  <https://create.roblox.com/docs/production/monetization/paid-random-items>; Monetization (Guidelines)
  <https://create.roblox.com/docs/production/monetization>; Experience notifications
  <https://create.roblox.com/docs/production/promotion/experience-notifications>; Content maturity
  <https://create.roblox.com/docs/production/promotion/content-maturity>; Roblox Kids and Select
  <https://create.roblox.com/docs/production/publishing/kids-and-select>; PolicyService
  <https://create.roblox.com/docs/reference/engine/classes/PolicyService>; Rewarded video ads
  <https://create.roblox.com/docs/production/promotion/rewarded-video-ads>; Engagement rewards
  <https://create.roblox.com/docs/resources/feature-packages/engagement-rewards>
- Roblox (2024). Major updates to our safety systems and parental controls.
  <https://about.roblox.com/newsroom/2024/11/major-updates-to-our-safety-systems-and-parental-controls>; Roblox Support,
  Managing Screen Time <https://en.help.roblox.com/hc/en-us/articles/30428328969492-Managing-Screen-Time>

**Repo:** `docs/DESIGN_RULES.md` (UI-06, UI-09, UI-13, IA-01..05, LEG-03/04, MP-00..24, MON-01..05, CON-03/04),
`docs/ANALYTICS.md`, `docs/MONETIZATION.md`, `docs/CREATOR_HUB.md`, `docs/research/DEAD_TOWN_GAP_ANALYSIS.md`,
`src/shared/data/shop.ts`, `src/shared/game/save.ts`, `src/shared/sim/ai/director.ts`,
`src/client/onboarding/objectives.ts`, `src/client/onboarding/gameOver.ts`, `src/client/view/fxView.ts`,
`src/shared/engine/camera.ts`, `src/client/view/solidFlinch.ts`, `src/client/ui/skin.ts`, `src/client/ui/settings.ts`,
`src/client/main.client.ts`, `src/shared/net/mpConfig.ts`, `src/server/sim/life.ts`, `src/shared/data/achievements.ts`.
