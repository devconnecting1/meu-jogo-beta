# Auditoria: Áudio (Sound/SoundGroup vs. API nova de áudio)

Escopo: `src/client/audio/**` (`audio.ts`, `gameAudio.ts`, `music.ts`, `fxAudio.ts`, `footstepAudio.ts`,
`uiAudio.ts`), `src/shared/data/sounds.ts`, `design/audio-credits.md`. Confrontado com:

- Visão geral: https://create.roblox.com/docs/audio
- Objetos de áudio: https://create.roblox.com/docs/audio/objects
- Efeitos: https://create.roblox.com/docs/audio/effects
- Assets de áudio: https://create.roblox.com/docs/audio/assets
- Privacidade de assets: https://create.roblox.com/docs/projects/assets/privacy
- Classes: [`Sound`](https://create.roblox.com/docs/reference/engine/classes/Sound) ·
  [`SoundService`](https://create.roblox.com/docs/reference/engine/classes/SoundService) ·
  [`SoundEffect`](https://create.roblox.com/docs/reference/engine/classes/SoundEffect) ·
  [`EqualizerSoundEffect`](https://create.roblox.com/docs/reference/engine/classes/EqualizerSoundEffect) ·
  [`AudioPlayer`](https://create.roblox.com/docs/reference/engine/classes/AudioPlayer) ·
  [`AudioEmitter`](https://create.roblox.com/docs/reference/engine/classes/AudioEmitter) ·
  [`AudioListener`](https://create.roblox.com/docs/reference/engine/classes/AudioListener) ·
  [`AudioFader`](https://create.roblox.com/docs/reference/engine/classes/AudioFader) ·
  [`AudioChannelMixer`](https://create.roblox.com/docs/reference/engine/classes/AudioChannelMixer) ·
  [`Wire`](https://create.roblox.com/docs/reference/engine/classes/Wire)
- Enums: [`RollOffMode`](https://create.roblox.com/docs/reference/engine/enums/RollOffMode) ·
  [`ListenerType`](https://create.roblox.com/docs/reference/engine/enums/ListenerType) ·
  [`EmitterPositionType`](https://create.roblox.com/docs/reference/engine/enums/EmitterPositionType)
- Anúncios (DevForum): [API nova, beta (22/02/2024)](https://devforum.roblox.com/t/new-audio-api-beta-elevate-sound-and-voice-in-your-experiences/2848873) ·
  [saída do beta (10/09/2024)](https://devforum.roblox.com/t/roblox-audio-api-exits-beta-enhanced-sound-controls-now-available/3153454) ·
  [áudio direcional + AudioLimiter (02/12/2024)](https://devforum.roblox.com/t/new-audio-api-features-directional-audio-audiolimiter-and-more/3282100)

---

## Resumo executivo (os dois vereditos)

**1. Não migrar para `AudioPlayer`/`AudioEmitter`/`Wire`.** O ganho concreto para um jogo que não tem mundo 3D
é praticamente zero, e o custo é reescrever `audio.ts` inteiro. A API nova **não resolve** a nossa dor: ela
continua sendo 3D (emissor + ouvinte com posições reais no espaço), então a "gambiarra" do plano falso
continuaria existindo, só que com o dobro de instâncias. Detalhes e gatilhos de reavaliação no achado #1.

**2. A nossa espacialização não é gambiarra — é o padrão da casa para 2D no Roblox.** Não existe painel de pan
2D em nenhuma das duas APIs; a doc de 2D audio da Roblox é literalmente "sem posição nenhuma". O que existe
de melhor documentado é exatamente o que fizemos (peça invisível + attachments). **Mas a nossa variante está
invertida** e isso tem um custo real de qualidade: achado #2.

---

## 1. A API nova substitui `Sound`/`SoundGroup` no nosso caso?

**Regra da doc:** a página de objetos de áudio diz, textualmente:

> "`Sound`, `SoundGroup`, and `SoundEffect` objects are now **discouraged** in favor of the more robust
> functionality of audio objects."
> — https://create.roblox.com/docs/audio/objects

"Discouraged", não "deprecated". Em nenhuma página de referência (`Sound`, `SoundGroup`, `SoundService`) há
marcação de deprecação; as propriedades que usamos (`RollOffMode`, `RollOffMinDistance`, `RollOffMaxDistance`,
`SoundGroup`, `PlaybackSpeed`, `TimePosition`, `Volume`) estão todas vivas — as deprecadas de verdade são as
antigas (`MinDistance`, `MaxDistance`, `EmitterSize`, `Pitch`, `play()`/`stop()` minúsculos), que não usamos.
O anúncio original é explícito: *"the older APIs will remain active"*. A API nova saiu do beta em
**10/09/2024** e convive com a antiga desde então; não há prazo de sunset publicado.

**Veredito: NÃO migrar.** Razões, na ordem em que pesam:

1. **A API nova também é 3D.** Para ter pan estéreo e atenuação por distância ela exige `AudioEmitter` +
   `AudioListener` com posições reais no espaço 3D (doc: "six objects" — `AudioPlayer` → `Wire` →
   `AudioEmitter`, e `AudioListener` → `Wire` → `AudioDeviceOutput`). O "2D audio" da doc é o oposto do que
   precisamos: *"non-directional sound that plays from no particular location, remaining at the same volume
   regardless of the player's position"*. Ou seja: **mono, centrado, sem distância**. Migrar não elimina o
   plano falso — só troca `Attachment` por `AudioEmitter.PositionInstance`.
2. **Custo de instâncias piora.** Hoje: 30 `Sound` + 20 `Attachment` + 1 `Part` + 3 `SoundGroup` ≈ **54
   instâncias**. O equivalente na API nova: 30 `AudioPlayer` + 20 `AudioEmitter` + 1 `AudioListener` + 3
   `AudioFader` + 1 `AudioDeviceOutput` + ~54 `Wire` ≈ **109 instâncias**, e há um problema conhecido e
   **ainda aberto**: cada `AudioEmitter` faz *"panning & distance attenuation work per-frame"* mesmo sem
   conexão ativa ([Audio API Performance Issue](https://devforum.roblox.com/t/audio-api-performance-issue/3928632)).
   Com um pool de vozes ociosas, isso é custo puro que hoje não pagamos.
3. **`SoundGroup` não tem análogo.** Resposta de staff no DevForum: *"the `SoundGroup` instance doesn't have a
   direct analogue in the Audio API"* — vira `AudioFader` + um `Wire` por voz
   ([thread](https://devforum.roblox.com/t/what-is-the-soundgroup-replacement-for-the-new-audio-api/3621505)).
   No nosso pool a **mesma voz troca de barramento a cada trigger** (`audio.ts:364`,
   `sound.SoundGroup = this.groups.get(def.bus)`). Hoje é uma escrita de propriedade; lá vira re-apontar
   `Wire.TargetInstance` a cada disparo. Funciona, mas não ganhamos nada.
4. **Perderíamos coisas que só existem no legado.** `SoundService.AmbientReverb` ("applied to all **Sounds**",
   explicitamente não afeta `AudioEmitter`), `SoundService:SetListener` / `ListenerType` (idem),
   `SoundService:PlayLocalSound`, e o `SoundGroup.Volume` de uma linha que hoje liga os sliders do save
   (`audio.ts:448-452`). O achado #5 usa justamente o `AmbientReverb`.
5. **Ganharíamos pouco.** O que a API nova tem de verdadeiramente melhor para nós: curva de atenuação
   arbitrária (`AudioEmitter:SetDistanceAttenuation(dicionário distância→volume)`) e `AudioLimiter`. A curva
   custom é elegante, mas o achado #3 mostra que `Linear` já cobre o caso. A simulação acústica (oclusão,
   reverb por geometria) é inútil aqui — depende de geometria 3D real, que não temos, e tem
   [regressão grave de performance documentada](https://devforum.roblox.com/t/acoustic-simulation-causes-severe-performance-regression/3956931)
   (relato de 120 → 30 fps com 7 emissores).

- **Prioridade:** Informativo (é uma decisão, não um defeito).
- **Esforço se fosse feito:** Alto — `src/client/audio/audio.ts` inteiro (481 linhas) + `sounds.ts:` o campo
  `bus` passaria a significar "fader de destino".
- **Arquivo:linha:** `src/client/audio/audio.ts:192-478` (toda a classe `AudioEngine`).
- **Link:** https://create.roblox.com/docs/audio/objects

### Gatilhos para reavaliar

Vale reabrir esta decisão se **qualquer** um destes acontecer:

- A referência de `Sound` passar a exibir marcação **Deprecated** (hoje exibe só a capability `LegacySound`,
  que é a classificação de containers sandboxed — sinal de como a Roblox enquadra a classe, não deprecação).
- Precisarmos de **voice chat** (a integração de voz só existe na API nova, via `VoiceChatService.UseAudioApi`).
- Precisarmos de pan por voz mais preciso do que o panner do FMOD entrega — aí a rota é a do quadro abaixo.

### Se um dia migrar: plano em fases e o que quebra

| Fase | O quê | O que quebra |
| --- | --- | --- |
| 0 | `AudioDeviceOutput` + 3 `AudioFader` (sfx/ui/bgm) + `Wire`s; `refreshGains` escreve `AudioFader.Volume` no lugar de `SoundGroup.Volume` | Nada — as duas árvores podem coexistir |
| 1 | Tracks (`AudioTrack`, música/ambiente) → `AudioPlayer` + `Wire` para o fader `bgm`. São 6 slots fixos, sem posição: é a parte trivial | Crossfade precisa ser reescrito sobre `AudioPlayer.Volume` (não há `SoundGroup` intermediário) |
| 2 | Vozes planas (UI, sons sem posição) → 10 `AudioPlayer` + `Wire` | `PlayLocalSound` some (não usamos) |
| 3 | Vozes espaciais → 20 `AudioPlayer` + 20 `AudioEmitter` (`PositionType = Instance`, `PositionInstance = Attachment`) + 1 `AudioListener`; `SetDistanceAttenuation` no lugar de `RollOffMode` | **`SoundService.AmbientReverb` para de funcionar** (achado #5 morre junto); `SetListener`/`ListenerType` para de funcionar — o ouvinte passa a ser o `AudioListener`; o custo por frame dos 20 emissores ociosos entra |
| 4 | Opcional: pan 2D honesto sem plano falso — `AudioPlayer` → 2 `AudioFader` (L/R, ganho por lei de potência constante) → `AudioChannelMixer` (Layout estéreo) → saída. Nenhuma peça invisível, nenhuma coordenada 3D | Atenuação por distância e pan viram **conta nossa** (≈20 linhas), atualizada por frame para cada voz ativa. **Não verificado em Studio** — a doc de `AudioChannelMixer` descreve os pinos (`Left`/`Right`) mas não há receita oficial de pan |

O item 4 é o único caminho para espacialização 2D *sem* mundo 3D falso, e é a única razão técnica honesta
para migrar. Mas ele troca "o FMOD faz o pan" por "nós fazemos o pan" — mais código nosso, não menos.

---

## 2. A nossa espacialização é gambiarra aceitável?

**Regra da doc:** não existe controle de pan L/R em nenhuma das duas APIs para um som sem posição. A doc de
"2D audio" define 2D como *ausência* de direção. A única forma documentada de obter lado estéreo é colocar
algo no espaço 3D e um ouvinte olhando para ele.

**Achado A (a abordagem está certa).** Peça invisível + um `Attachment` por voz + `SetListener` é exatamente o
workaround que a comunidade usa e que a Roblox nunca desencorajou: *"creating invisible parts on the client
and positioning them at the right distance and direction from the camera for each sound"*. Nosso mapeamento
(`x` da tela → eixo X do ouvinte, `y` da tela → eixo Z / frente-trás) e a limitação declarada no comentário
(frente e trás soam igual em estéreo, então o jogador ouve **esquerda/direita** e **perto/longe**) estão
corretos e bem documentados no próprio arquivo.

- **Prioridade:** Informativo — manter.
- **Arquivo:linha:** `src/client/audio/audio.ts:21-35` (o comentário) e `audio.ts:226-244` (a construção).

**Achado B (a montagem está invertida, e isso custa qualidade).** Hoje o **ouvinte é fixo na origem** e cada
voz é colocada em coordenada **relativa à câmera no instante do trigger** (`audio.ts:368-374`). Consequência:
o som fica **grudado no ouvinte** pelo resto da reprodução. Se a câmera anda enquanto o som toca, o som anda
junto — o mundo é que deveria ficar parado.

Números concretos: `DESIGN.MOVE_SPEED = 7` px/frame a 30 fps (`src/shared/engine/constants.ts:19`) ×
`SPEED_SCALE = 30` (`src/shared/sim/types.ts:16`) = **210 unidades/s**. Um `bossRoar` dura 2,12 s
(`design/audio-credits.md`): a câmera anda até ~445 unidades = **~28 studs** dos 100 studs de alcance total.
O rugido que deveria varrer da direita para a esquerda quando o jogador passa por ele fica imóvel no estéreo.
Vale para todos os takes longos: `explosion` (2,59 s), `zombieAlert` (2,26 s, cortado em 1,4 s),
`zombieGrowl` (1,83 s, cortado em 1,6 s), `stingerWave*` (3,71 s).

**Correção (duas linhas, sem instância nova):** inverter os papéis — o ouvinte anda, o mundo fica parado.

1. Em `setListener(x, y)` (`audio.ts:299-302`), passar a chamar por frame
   `SoundService.SetListener(Enum.ListenerType.CFrame, new CFrame(x * STUDS_PER_UNIT, 0, y * STUDS_PER_UNIT))`
   em vez de só guardar as coordenadas (a chamada de `audio.ts:242` deixa de ser única, no `start()`).
2. Em `play()` (`audio.ts:368-374`), gravar a posição **absoluta**:
   `attachment.Position = new Vector3(x * STUDS_PER_UNIT, 0, y * STUDS_PER_UNIT)` — sem subtrair
   `listenerX/listenerY`.

Com isso a Roblox passa a recalcular pan e distância por frame de graça, o desvio some, e `distanceToListener`
(`audio.ts:308-312`) e a curva manual das vozes planas continuam idênticas (elas já trabalham em unidades de
mundo). A `Part` na origem continua necessária só como pai dos `Attachment`s.

- **Prioridade:** **Média-Alta** — é o único defeito audível desta auditoria.
- **Esforço:** Baixo (duas linhas + remover a chamada única de `SetListener` do `start`).
- **Arquivo:linha:** `src/client/audio/audio.ts:242`, `audio.ts:299-302`, `audio.ts:368-374`.
- **Link:** https://create.roblox.com/docs/reference/engine/enums/ListenerType

**Achado C (risco de Doppler, correção de graça).** `SoundService.DopplerScale` tem padrão **1** e a doc diz
que afeta *"any Sound parented to a BasePart or Attachment"* — que é exatamente o nosso caso. Nunca tocamos
nessa propriedade (grep: `SoundService` só aparece em `audio.ts`). Hoje os `Attachment`s são **teleportados**
a cada trigger; com a correção do achado B, é o ouvinte que passa a se mover 210 u/s (≈13 studs/s). Em nenhum
dos dois casos queremos desvio de tom.

**Correção:** `SoundService.DopplerScale = 0` dentro de `start()`. Uma linha, custo zero, elimina uma classe
inteira de artefato antes que ela apareça. (Com Doppler desligado, `SoundService.DistanceFactor`, que a doc
descreve como *"the number of studs to be considered a meter ... when simulating the Doppler effect"*, vira
irrelevante — não precisa ser calibrado.)

- **Prioridade:** Média (preventivo, mas é uma linha).
- **Arquivo:linha:** `src/client/audio/audio.ts:208-249` (`start()`).
- **Link:** https://create.roblox.com/docs/reference/engine/classes/SoundService

---

## 3. `RollOffMode` e as distâncias: os números fazem sentido?

**Regra da doc** (descrições verbatim de `Enum.RollOffMode`):

| Modo | Comportamento |
| --- | --- |
| `Inverse` (0) | *"Volume attenuates from `RollOffMinDistance` in an inverse manner, mirroring how sounds attenuate in the real world."* |
| `Linear` (1) | *"Volume attenuates between `RollOffMinDistance` and `RollOffMaxDistance` with a linear relationship."* |
| `LinearSquare` (2) | *"...with a linear squared relationship."* |
| `InverseTapered` (3) | *"A hybrid model which follows the Inverse model when close to `RollOffMinDistance` and the LinearSquare model when close to `RollOffMaxDistance`."* |

**Achado A (os números estão coerentes e `Linear` é a escolha certa).** Nossa escala:
`STUDS_PER_UNIT = 100/1600 = 0,0625` (`audio.ts:50`), logo `RollOffMinDistance = 140 × 0,0625 = 8,75 studs`
e `RollOffMaxDistance = 1600 × 0,0625 = 100 studs` (`audio.ts:262-263`). Como o comentário do arquivo situa
`AUDIO_RANGE` em "cerca de uma tela e meia", uma tela ≈ 1067 unidades e a borda da tela fica a ≈533 unidades
= 33,3 studs. Com `Linear` — a tabela abaixo usa a reta padrão `v = (max − d) / (max − min)`; a fórmula que a
página do enum imprime para `Linear` está corrompida no HTML da doc, a descrição em prosa é que vale:

| Posição | studs | Volume (amplitude) | dB |
| --- | --- | --- | --- |
| Em cima do jogador | ≤ 8,75 | 1,00 | 0 |
| Borda da tela | 33,3 | 0,73 | −2,7 |
| Uma tela inteira fora | 66,7 | 0,37 | −8,8 |
| `AUDIO_RANGE` | 100 | 0,00 | −∞ |

Isso é o que um top-down precisa: **tudo que está na tela continua nítido** e o que sai de quadro some
depressa. Para comparação, `Inverse` (o padrão do engine) daria `8,75/33,3 = 0,26` (−11,6 dB) na borda da
tela — o combate visível ficaria inaudível. `Linear` está certo, e por um motivo que vale escrever no código:
num jogo 2D a leitura da tela vale mais que o realismo acústico.

Coerência extra que vale registrar: a curva manual das vozes planas com posição
(`audio.ts:354`, `1 - clamp((d - NEAR)/(RANGE - NEAR))`) é **exatamente** a mesma reta em unidades de mundo.
Uma voz espacial e uma plana no mesmo lugar soam no mesmo nível. Isso não foi acidente e é raro de acertar.

- **Prioridade:** Informativo — manter `Linear`.
- **Arquivo:linha:** `src/client/audio/audio.ts:46-50`, `audio.ts:261-263`, `audio.ts:354`.

**Achado B (falta curva por categoria).** `RollOffMode.Linear` está *hard-coded* para todas as 20 vozes
espaciais em `makeVoice` (`audio.ts:261`), o que força o mesmo alcance de 100 studs para o rugido do chefe e
para o detrito de um carro. O catálogo já diferencia tudo o mais por entrada (`volume`, `voices`, `priority`,
`maxPlay`); falta o alcance.

Duas coisas que isso resolveria:

- **`footstepA`/`footstepB` pagam atenuação duas vezes.** `footstepAudio.ts:50-54` aplica a própria reta
  (cull em 900 u, fade a partir de 220 u) *por cima* da reta do engine, que ainda vai até 1600 u. A 500
  unidades: `0,588` (manual) × `0,753` (engine) = **0,44**, quase o quadrado da curva pretendida. Funciona
  ("um passo não carrega"), mas o número não é o que o comentário do arquivo diz que é.
- **Sons locais vs. sons que carregam.** `debrisWood`/`debrisMetal`/`meleeHit` deveriam morrer bem antes da
  tela e meia; `bossRoar`/`explosion`/`zombieAlert` deveriam carregar até o fim.

**Correção sugerida:** dois campos opcionais em `SoundDef` (`src/shared/data/sounds.ts:22-50`) —
`rangeNear?: number` e `range?: number`, em unidades de mundo — lidos em `play()` para escrever
`sound.RollOffMinDistance` / `RollOffMaxDistance` antes do `Play()`. O `voice.sound` já é reconfigurado por
trigger (`SoundId`, `SoundGroup`, `Volume`, `PlaybackSpeed`), então são mais duas escritas no mesmo lugar.
Com isso os passos dispensam a reta manual de `footstepAudio.ts` (bastaria `range: 900, rangeNear: 220`).

- **Prioridade:** Média.
- **Esforço:** Baixo (2 campos + 2 linhas em `play()`, e uma simplificação em `footstepAudio.ts`).
- **Arquivo:linha:** `src/client/audio/audio.ts:261-263` e `audio.ts:362-367`; `src/shared/data/sounds.ts:22-50`;
  `src/client/audio/footstepAudio.ts:24-27`, `footstepAudio.ts:49-54`.

**Achado C (`LinearSquare` para a camada ambiente).** Se em algum momento o rosnado ambiente
(`zombieGrowl`, `gameAudio.ts:290-307`) parecer "perto demais" quando o zumbi está a meia tela,
`LinearSquare` é o ajuste certo para ele isoladamente (0,73² = 0,53 na borda da tela) — mas **não** para
combate, senão a leitura da tela se perde. Isso vira um terceiro campo opcional (`rolloff?: Enum.RollOffMode`)
no mesmo lugar do achado B. Não recomendo mexer antes de uma sessão de escuta.

- **Prioridade:** Baixa (só depois de ouvir).

---

## 4. Orçamento de vozes: limite, custo e streaming

**Regra da doc:** a documentação da Roblox **não publica** um limite de sons simultâneos nem um custo por
`Sound`. O que existe é medição da comunidade e um bug report com resposta de staff.

**Achado A (nosso pool está folgado — por muita margem).** Benchmark da comunidade
([Total sound instance limit](https://devforum.roblox.com/t/total-sound-instance-limit/3736250), i5-12500H):
**1–400 instâncias = "normal operation expected"**; 401–450 começa a dessincronizar em troca de tela;
451–500 o áudio toca 5–7 s e perde sincronismo; acima de 500 o áudio corta em segundos. O autor ressalva que
*"results may vary depending on the device"*.

Nós temos **30 vozes** (`SPATIAL_VOICES = 20` + `FLAT_VOICES = 10`, `audio.ts:58-60`) mais 6 slots de track
(3 `AudioTrack` × 2 slots, `audio.ts:116-124`) = **36 `Sound`**, e o `MAX_SHOTS_PER_FRAME = 2`
(`gameAudio.ts:26`) impede que uma rajada consuma o pool num frame. Estamos a **menos de 10%** do primeiro
degrau de degradação medido, num aparelho de referência de PC — e esse é o número que importa, porque a
degradação é de mixagem, não de memória.

- **Prioridade:** Informativo — não mexer. Se um dia houver aperto de vozes (6 jogadores co-op × passos +
  horda), há folga técnica para subir `SPATIAL_VOICES` de 20 para ~32 sem chegar perto do limite. O limitador
  real hoje é estético (`design/audio-credits.md`: "teto de vozes"), não técnico.
- **Arquivo:linha:** `src/client/audio/audio.ts:58-62`; `src/client/audio/gameAudio.ts:26`.

**Achado B (reaproveitar `Sound` é o caminho certo, e agora com evidência).** Criar/destruir `Sound` por
disparo é o antipadrão: o bug report
[Audio API Performance Issue](https://devforum.roblox.com/t/audio-api-performance-issue/3928632) mostra que o
custo do mixer não é do som *tocando*, é do **objeto existindo** — a task `Sound` do microprofiler chegou a
*"about 30ms"* com ~5000 `AudioPlayer` **ociosos e nem sequer conectados**. (Era bug do engine, corrigido na
versão 691, mas o princípio vale: a tarefa `Sound` roda sobre o conjunto de objetos, não sobre o conjunto de
vozes ativas.) Nosso `makeVoice` cria o conjunto fechado uma vez em `start()` (`audio.ts:244-245`) e nunca
mais instancia nada — é exatamente o que a evidência recomenda.

- **Prioridade:** Informativo — manter.
- **Arquivo:linha:** `src/client/audio/audio.ts:251-269`, `audio.ts:401-432` (`claim`/`steal`).

**Achado C (streaming e o pré-carregamento).** O pré-carregamento (`audio.ts:272-290`) está correto e resolve
o "primeiro tiro mudo": cria `Sound`s temporários **parenteados** (a pegadinha já registrada em
`design/audio-credits.md`: `PreloadAsync` com `Sound` sem pai devolve `IsLoaded = false` para tudo), chama
`ContentProvider:PreloadAsync` e destrói o holder. São ~20 assets distintos (`soundAssetIds()`,
`sounds.ts:631-641`), a maioria `rbxasset://` (embutidos no cliente, sem rede).

Um ponto fino: `PreloadAsync` **cede** (yield) e a destruição do holder só acontece quando todos carregam. Se
um asset tiver sido moderado ou estiver fora do ar, a chamada demora e os `Sound` temporários ficam vivos até
lá. Está dentro de `task.spawn` + `pcall`, então não trava o boot — comportamento aceitável. O que **falta** é
o passo seguinte: hoje um asset que não carrega vira uma voz consumida que não produz som. Ver achado #6-B.

- **Prioridade:** Baixa.
- **Arquivo:linha:** `src/client/audio/audio.ts:272-290`.
- **Link:** https://create.roblox.com/docs/reference/engine/classes/ContentProvider

**Achado D (escrita de propriedade por frame nas tracks).** `AudioTrack.update` escreve
`slot.sound.Volume` todo frame para os 6 slots, mesmo quando `gain` já chegou no `target` e nada mudou
(`audio.ts:179`). São 6 escritas/frame — irrelevante em CPU, mas cada escrita de propriedade dispara os sinais
de mudança do datamodel. Guardar o último valor escrito e só escrever na diferença é uma linha.

- **Prioridade:** Baixa (higiene).
- **Arquivo:linha:** `src/client/audio/audio.ts:164-182`.

---

## 5. `AudioFader` / efeitos (reverb, compressor) para noite / chuva / dentro de construção

**Veredito: sim, vale — mas com `SoundEffect` legado, não com a API nova.** É barato, é uma linha por
ambiente, e não exige migração nenhuma.

**Regra da doc:**

- `SoundEffect` — *"the base class that all other sound effects derive from. A SoundEffect can be applied to
  either a `Sound` or `SoundGroup` by being parented to either."* Não está deprecada. Ou seja: **o nosso
  barramento já é um ponto de inserção de efeito**, de graça.
- `SoundService.AmbientReverb` — *"A reverb preset that should be applied to all Sounds in the experience."*
  Um `Enum.ReverbType` por preset FMOD. A referência avisa explicitamente que **só afeta `Sound` legado**, não
  `AudioEmitter`.
- `EqualizerSoundEffect` — `LowGain` (< 400 Hz), `MidGain` (400–4000 Hz), `HighGain` (> 4000 Hz), cada um de
  **−80 a +10 dB**, padrão 0.
- `AudioFader` (API nova) — só `Volume` e `Bypass`. **Não nos dá nada**: é o `SoundGroup.Volume` que já temos.

**Achado A — "dentro de construção" é uma linha.** `SoundService.AmbientReverb = Enum.ReverbType.Room`
(ou `StoneRoom`, `Hallway`) quando o jogador entra numa construção e `Enum.ReverbType.NoReverb` quando sai.
O sistema de construção (`src/client/systems`) já sabe quando o jogador está dentro; o áudio só precisa do
sinal. Custo: um bus de reverb no FMOD, ligado uma vez. É o efeito de maior retorno por linha desta auditoria.

- **Prioridade:** Média (é feature nova, não correção).
- **Esforço:** Baixo — um `setAmbience(inside: boolean)` em `audio.ts` + a chamada de quem já sabe.
- **Arquivo:linha:** `src/client/audio/audio.ts:208-249` (onde o `SoundService` já está em mãos).
- **Link:** https://create.roblox.com/docs/reference/engine/classes/SoundService

**Achado B — chuva e noite pedem EQ no barramento, não reverb.** Um `EqualizerSoundEffect` parenteado ao
`SoundGroup` `sfx` (`audio.ts:217-224`) com `HighGain` em −6…−12 dB dá o abafamento de "chuva forte" ou
"dentro de um cômodo" sem tocar em nenhuma voz. A noite pede o contrário do abafamento: nada de EQ, e sim o
que já fazemos (a cama de som troca por crossfade em `music.ts:56-58`).

Um `CompressorSoundEffect` no grupo `sfx` também é tentador para "domar os picos" (escopeta/explosão a 0,50–
0,55 de base), mas **não recomendo**: o achado #4 mostra que o pool nunca satura, e os volumes base já estão
calibrados com teto de 0,55 em `design/audio-credits.md`. Compressor aqui só achataria a diferença entre a
pistola e a explosão, que é justamente a informação que o jogador usa.

- **Prioridade:** Baixa (melhoria estética, depois de ouvir).
- **Esforço:** Baixo (1 instância por grupo, ligada/desligada por `Enabled`).
- **Arquivo:linha:** `src/client/audio/audio.ts:217-224`.
- **Link:** https://create.roblox.com/docs/reference/engine/classes/EqualizerSoundEffect

**Achado C — o que NÃO fazer.** A "simulação acústica" da API nova (`AudioEmitter.AcousticSimulationEnabled`,
`SoundService.AcousticSimulationEnabled`) faz oclusão e reverb a partir da **geometria 3D real** via consultas
de física. Não temos geometria 3D, então ela não teria o que ocluir, **e** tem regressão de performance
documentada (relato de 120 → 30 fps com 7 emissores; correção parcial em Studio em setembro/2025).
Descartado.

- **Link:** https://devforum.roblox.com/t/acoustic-simulation-causes-severe-performance-regression/3956931

---

## 6. Moderação e licenciamento: algo que afete a regra de "só biblioteca oficial"?

**Regra da doc:**

- O Creator Store tem *"a wide variety of free-to-use audio assets made by Roblox and the Roblox community"*,
  *"more than 100,000 professionally-produced sound effects and music tracks"* dos parceiros de áudio. São
  gratuitos para uso pelos criadores.
- Para **importar** áudio próprio: é preciso ter *"the legal rights to that audio asset"*, e ele passa por
  *"moderation and copyright checks"*. Limites técnicos: **< 20 MB e < 7 minutos**, amostragem ≤ 48 kHz,
  mono/estéreo 2.0/3.0/5.1, `.mp3`/`.ogg`/`.wav`/`.flac`. Cota: **2.000 assets/30 dias** com verificação de
  identidade, **100/30 dias** sem.
- Privacidade de assets: *"the asset privacy system automatically ensures that the IDs of your imported audio
  can't be accessed by users without proper permissions"*, com concessão de permissão por experiência
  (universeID), por amigo ou por grupo. **Isso vale para áudio que você mesmo sobe** — a página de privacidade
  de assets diz que o *default* restrito só alcança *"Images, Decals, and Meshes"* e que *"the setting is not
  retroactive"*.

**Achado A — a nossa regra continua válida e está do lado certo da linha.** `design/audio-credits.md` só
admite (1) `rbxasset://sounds/*` (conteúdo do engine, distribuído com o cliente), (2) `rbxassetid://` de
criador **Roblox** (id 1), (3) **ProSoundEffects** e (4) **APMOfficial**, todos com `IsPublicDomain = true`
verificado via `MarketplaceService:GetProductInfo`. Nada disso é "áudio privado de terceiro" — não há
permissão a conceder, não há universeID a cadastrar. A rejeição explícita de uploads de usuário comum ("COD",
"Left 4 Dead", "Minecraft", "MM2") é exatamente o que a política de importação exige do lado de quem sobe, e
evita o risco real: um asset de terceiro que é removido por moderação **depois** do nosso ship.

Nada nas fontes lidas contradiz ou aperta a regra. **Nenhuma mudança necessária na política.**

- **Prioridade:** Informativo.
- **Arquivo:linha:** `design/audio-credits.md` (seção "Fontes aceitas"); `src/shared/data/sounds.ts:3-14`.
- **Link:** https://create.roblox.com/docs/audio/assets

**Achado B — falta o degrau entre "slot vazio" e "asset que não carrega".** O catálogo trata `id: ""` como
silêncio legítimo (`sounds.ts:626-628`, `isSilentSlot`) e `play()` sai cedo nesse caso (`audio.ts:339`). Mas
um `rbxassetid://` **válido no código e inválido em runtime** (moderado, removido, ou rede fora) passa por
todas as guardas: `claim()` toma uma voz, `sound.Play()` é chamado, nada soa, e a voz só é liberada em
`update()` quando `IsPlaying` volta falso depois de `MIN_VOICE_AGE` (`audio.ts:463-467`). Não é grave — a voz
volta em 50 ms — mas é a única forma de o nosso pipeline "mentir" sobre o catálogo, e é justamente o risco que
a política de licenciamento existe para cobrir.

**Correção:** no `preload()` (`audio.ts:272-290`), depois do `PreloadAsync`, ler `s.IsLoaded` de cada `Sound`
temporário e registrar os ids que falharam num `Set`; `play()` trata um id desse conjunto como slot vazio.
Isso transforma "moderaram um asset nosso" de um bug silencioso num silêncio *declarado*, coerente com a regra
da casa — e dá um ponto óbvio para um `warn` em Studio.

- **Prioridade:** Média.
- **Esforço:** Baixo (~10 linhas, tudo dentro de `preload`/`play`).
- **Arquivo:linha:** `src/client/audio/audio.ts:272-290`, `audio.ts:336-340`.

**Achado C — pendência que a doc não resolve, e não vai resolver.** As pendências A/B/C de
`design/audio-credits.md` (takes de rajada com vários disparos no mesmo arquivo; a série "Goliath Vocal" ser
catalogada como *Robots - Voice*; `playerHurt`/`playerDeath` reaproveitando `uuhhh.mp3`) são de **escuta**, não
de API. Nenhuma fonte lida tem uma forma programática de medir o envelope de um asset antes de tocá-lo — o
mais perto é `AudioPlayer:GetWaveformAsync(timeRange, samples)`, que devolve a forma de onda e **existe só na
API nova**. É o único uso em que a API nova nos daria algo que a antiga não dá; mas para três arquivos, uma
sessão de Play com ouvido resolve mais rápido do que migrar o mixer.

- **Prioridade:** Baixa (fica onde está, em `design/audio-credits.md`).
- **Link:** https://create.roblox.com/docs/reference/engine/classes/AudioPlayer

---

## Resumo por prioridade

| Prioridade | Achado | Esforço |
| --- | --- | --- |
| **Média-Alta** | #2-B — som fica grudado no ouvinte; inverter (ouvinte anda, mundo parado). `audio.ts:242`, `:299-302`, `:368-374` | Baixo |
| Média | #2-C — `SoundService.DopplerScale = 0` (preventivo, uma linha). `audio.ts:208-249` | Baixo |
| Média | #3-B — alcance por entrada (`range`/`rangeNear` em `SoundDef`); resolve a atenuação dupla dos passos. `audio.ts:261-263`, `sounds.ts:22-50`, `footstepAudio.ts:49-54` | Baixo |
| Média | #6-B — asset que não carrega deve virar slot silencioso declarado. `audio.ts:272-290`, `:336-340` | Baixo |
| Média | #5-A — `AmbientReverb` por ambiente ("dentro de construção"). `audio.ts:208-249` | Baixo |
| Baixa | #3-C — `LinearSquare` só para o rosnado ambiente (depois de ouvir) | Baixo |
| Baixa | #4-C — `preload` pode segurar `Sound`s temporários se um asset demorar | Baixo |
| Baixa | #4-D — `AudioTrack.update` escreve `Volume` por frame sem necessidade. `audio.ts:164-182` | Baixo |
| Baixa | #5-B — `EqualizerSoundEffect` no grupo `sfx` para chuva/abafamento | Baixo |
| Informativo | #1 — **não migrar** para a API nova (com gatilhos de reavaliação e plano em fases) | — |
| Informativo | #2-A — a espacialização por peça invisível é o padrão documentado para 2D | — |
| Informativo | #3-A — `Linear` é a curva certa; os números batem com a tela | — |
| Informativo | #4-A/B — 36 `Sound` contra ~400 do primeiro degrau medido; pool reaproveitado é o padrão correto | — |
| Informativo | #6-A — a política de licenciamento não precisa mudar | — |

---

## Avaliado e descartado

- **Migrar para `AudioPlayer`/`AudioEmitter`/`AudioListener`/`Wire`.** Descartado: não resolve o 2D (a API
  nova também é 3D), dobra a contagem de instâncias, custa `AmbientReverb` + `SetListener` + `PlayLocalSound`,
  e `SoundGroup` não tem análogo direto (confirmado por staff). Achado #1.
- **`AudioFader` como substituto do `SoundGroup`.** Descartado: só tem `Volume` e `Bypass` — é literalmente o
  que `SoundGroup.Volume` já faz, ao preço de um `Wire` por voz.
- **`AudioChannelSplitter` + `AudioChannelMixer` para pan 2D honesto.** Registrado como fase 4 do plano de
  migração, **não recomendado agora**: é o único caminho sem mundo 3D falso, mas move o cálculo de pan e de
  distância para código nosso, por frame, por voz. Não verificado em Studio.
- **`AcousticSimulationEnabled` (oclusão/reverb por geometria).** Descartado: depende de geometria 3D real,
  que não temos, e tem regressão de performance documentada.
- **`CompressorSoundEffect` no barramento `sfx`.** Descartado por ora: o pool nunca satura e os volumes base
  já têm teto; comprimir achataria a diferença entre pistola e explosão, que é informação de jogo.
- **`SoundService.DistanceFactor` / `RolloffScale`.** Descartados como knobs: `DistanceFactor` a doc define
  como parâmetro **do Doppler**, que vamos zerar; `RolloffScale` escalaria globalmente uma curva que já está
  calibrada por som (achado #3-B é mais preciso).
- **`RollOffMode.InverseTapered`.** Avaliado como alternativa "realista"; descartado porque o trecho perto do
  mínimo segue `Inverse`, e num top-down o ouvinte fica muito perto dos eventos — pequenos passos do jogador
  virariam grandes saltos de volume. `Linear` + platô de 8,75 studs evita isso.
- **`Sound.PlayOnRemove`.** Avaliado para o caso "som de morte de uma entidade que some"; descartado —
  o nosso pool nunca destrói `Sound`, e `gameAudio` já deriva a morte do estado (`gameAudio.ts:231-256`).
- **`SoundService.RespectFilteringEnabled = false`** (deixar outros clientes ouvirem). Descartado: contraria
  `docs/MULTIPLAYER.md` §11.2 (o áudio é client-side e continua client-side).
- **`AudioPlayer:GetWaveformAsync` para medir os takes de rajada.** Registrado no achado #6-C como o único
  ganho real da API nova para nós; descartado como motivo de migração — três arquivos, uma sessão de escuta.
