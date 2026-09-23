# Créditos e licença do áudio — Project Z

Registro de **todo** som que o jogo carrega: nome lógico (`src/shared/data/sounds.ts`), asset, criador e por que
podemos usar. Regra da casa (CON-01/CON-02 de `docs/DESIGN_RULES.md`, estendida ao áudio):

> Só entra áudio que o jogo pode usar legalmente. Na dúvida sobre a origem, o slot fica **vazio** (`id: ""`),
> o jogo fica em silêncio naquele evento e o buraco vira pendência aqui. **Nunca** se preenche um slot com
> áudio de origem duvidosa.

## Fontes aceitas

| Fonte                                           | O que é                                                                              | Por que é utilizável                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rbxasset://sounds/*`                           | Conteúdo do próprio engine, instalado junto com o cliente Roblox                     | Arquivos da Roblox, distribuídos com o motor. Não passam por moderação, não podem ser removidos por terceiros e não dependem de rede.                      |
| `rbxassetid://` com criador **Roblox** (id 1)   | Biblioteca clássica de sons da Roblox                                                | `MarketplaceService:GetProductInfo` retorna `Creator.Name = "Roblox"`, `Creator.CreatorTargetId = 1` e `IsPublicDomain = true` (gratuito, livre para uso). |
| `rbxassetid://` com criador **ProSoundEffects** | Biblioteca oficial gratuita da Roblox ("Courtesy of Pro Sound Effects" na descrição) | Catálogo licenciado pela Roblox e publicado no Creator Store como gratuito para uso **dentro de experiências**. `IsPublicDomain = true`.                   |
| `rbxassetid://` com criador **APMOfficial**     | Biblioteca oficial de música da Roblox ("Courtesy of APM Music")                     | Mesmo caso: licenciada pela Roblox, gratuita para uso dentro de experiências. `IsPublicDomain = true`.                                                     |

**Rejeitado por política**, mesmo aparecendo como gratuito na busca: qualquer upload de usuário comum. A busca do
Creator Store devolve muita coisa marcada "COD", "Left 4 Dead", "Minecraft", "MM2", "taken from the mod …" — é
propriedade intelectual de terceiros republicada, e não entra aqui. Também ficou de fora `rbxassetid://11984254`
("CinematicBoom", criador Roblox), porque `IsPublicDomain` volta **false**: criador certo, marcação de uso livre
faltando.

## Como cada id foi verificado

Tudo abaixo foi checado no Roblox Studio (modo **Edit**, sem Play, sem alterar o place), via MCP:

1. `MarketplaceService:GetProductInfo(id, Enum.InfoType.Asset)` → `Creator.Name`, `Creator.CreatorTargetId`,
   `IsPublicDomain`.
2. `Sound` temporário com o `SoundId`, parenteado sob `SoundService`, seguido de
   `ContentProvider:PreloadAsync` → confere `IsLoaded == true` e `TimeLength > 0` (ou seja: existe, carrega e é
   tocável). Os objetos temporários foram destruídos ao fim.

> Detalhe que custou tempo e vale registrar: `PreloadAsync` com `Sound` **sem parent** devolve `IsLoaded = false`
> para tudo. É preciso parentear antes de pré-carregar.

## Catálogo

### SFX — armas

| Nome lógico    | Asset                                                       | Criador         | Duração | Observação                                                                       |
| -------------- | ----------------------------------------------------------- | --------------- | ------- | -------------------------------------------------------------------------------- |
| `shotPistol`   | `rbxassetid://9114716927` — "Gun Live Ammunition 202 (SFX)" | ProSoundEffects | 2,58 s  | 9 mm Beretta, "full flash singles" (tiro único).                                 |
| `shotRifle`    | `rbxassetid://9114716907` — "Gun Live Ammunition 302 (SFX)" | ProSoundEffects | 2,62 s  | Mesma série, tocado 0,84–0,92× (mais grave).                                     |
| `shotMg`       | `rbxassetid://9114716928` — "Gun Live Ammunition 301 (SFX)" | ProSoundEffects | 2,61 s  | Agudo, mais baixo, `maxPlay` 0,45 s: rajada não vira parede de som.              |
| `shotShotgun`  | `rbxassetid://9112912106` — "12 Gauge Shotgun 1 (SFX)"      | ProSoundEffects | 2,76 s  | O arquivo tem **vários** disparos: `maxPlay` 0,6 s corta em um. Ver pendência A. |
| `shotSniper`   | `rbxassetid://9113195119` — "Assault Rifle 6 (SFX)"         | ProSoundEffects | 4,05 s  | Também é rajada; `maxPlay` 0,35 s + pitch 0,74–0,80. Ver pendência A.            |
| `shotBow`      | `rbxassetid://12222200` — "swoosh.wav"                      | Roblox (id 1)   | 0,20 s  | Arco é a arma silenciosa do dia: um sopro seco, não um estampido.                |
| `shotElectric` | `rbxasset://sounds/electronicpingshort.wav`                 | Roblox (engine) | 0,72 s  | Stun gun / corrente (LEG-02: amarelo = eletricidade).                            |
| `meleeSwing`   | `rbxassetid://12222216` — "swordslash.wav"                  | Roblox (id 1)   | 0,56 s  |                                                                                  |
| `meleeHit`     | `rbxasset://sounds/hit.wav`                                 | Roblox (engine) | 0,84 s  |                                                                                  |
| `reloadStart`  | `rbxasset://sounds/metal.ogg`                               | Roblox (engine) | 0,60 s  | Metálico, tocado 1,15–1,25× (carregador saindo).                                 |
| `reloadEnd`    | `rbxasset://sounds/snap.wav`                                | Roblox (engine) | 0,42 s  | Estalo do carregador entrando.                                                   |
| `weaponSwitch` | `rbxasset://sounds/unsheath.wav`                            | Roblox (engine) | 0,73 s  |                                                                                  |
| `emptyClick`   | `rbxasset://sounds/switch.wav`                              | Roblox (engine) | 0,24 s  | Acompanha a mensagem "No ammo".                                                  |

### SFX — corpos, impactos e mundo

| Nome lógico   | Asset                                                                    | Criador         | Duração | Observação                                                |
| ------------- | ------------------------------------------------------------------------ | --------------- | ------- | --------------------------------------------------------- |
| `hitFlesh`    | `rbxasset://sounds/splat.wav`                                            | Roblox (engine) | 0,50 s  |                                                           |
| `zombieDeath` | `rbxasset://sounds/uuhhh.mp3`                                            | Roblox (engine) | 0,33 s  | Grunhido, tocado 0,60–0,78× (grave).                      |
| `zombieGrowl` | `rbxassetid://9114628598` — "Goliath Vocal Deep Growling Voice 20 (SFX)" | ProSoundEffects | 1,83 s  | Rosnado ambiente da horda próxima. Ver pendência B.       |
| `zombieAlert` | `rbxassetid://9114628620` — "Goliath Vocal Deep Growling Voice 21 (SFX)" | ProSoundEffects | 2,26 s  | Um zumbi acabou de te ver.                                |
| `bossRoar`    | `rbxassetid://9114628818` — "Goliath Vocal Deep Growling Voice 22 (SFX)" | ProSoundEffects | 2,12 s  | Tocado 0,58–0,68× (bem grave).                            |
| `playerHurt`  | `rbxasset://sounds/uuhhh.mp3`                                            | Roblox (engine) | 0,33 s  | Mesmo take do zumbi, 1,05–1,20× (agudo). Ver pendência C. |
| `playerDeath` | `rbxasset://sounds/uuhhh.mp3`                                            | Roblox (engine) | 0,33 s  | 0,50–0,55×. Ver pendência C.                              |
| `explosion`   | `rbxasset://sounds/impact_explosion_03.mp3`                              | Roblox (engine) | 2,59 s  | Zumbi-bomba e barris.                                     |
| `debrisWood`  | `rbxasset://sounds/collide.wav`                                          | Roblox (engine) | 1,20 s  | Árvore, construção.                                       |
| `debrisMetal` | `rbxasset://sounds/metal.ogg`                                            | Roblox (engine) | 0,60 s  | Carro, chefe, ricochete.                                  |
| `debrisGlass` | `rbxasset://sounds/glassbreak.wav`                                       | Roblox (engine) | 1,58 s  | Reservado (ainda sem evento que o dispare).               |
| `pickupItem`  | `rbxasset://sounds/clickfast.wav`                                        | Roblox (engine) | 0,29 s  |                                                           |
| `pickupCoin`  | `rbxasset://sounds/electronicpingshort.wav`                              | Roblox (engine) | 0,72 s  |                                                           |
| `craftDone`   | `rbxasset://sounds/switch3.wav`                                          | Roblox (engine) | 0,37 s  |                                                           |
| `footstepA`   | `rbxassetid://9114523345` — "Foot Stomp 3 (SFX)"                         | ProSoundEffects | 0,45 s  | Foley. O arquivo tem **vários** passos: `maxPlay` 0,22 s corta no primeiro. Ver pendência A. |
| `footstepB`   | `rbxassetid://9114523358` — "Foot Stomp 4 (SFX)"                         | ProSoundEffects | 0,47 s  | Mesma série, alternado com o A (um id só vira metrônomo a 2 passos/s). Ver pendência A.      |

### UI

| Nome lógico | Asset                                        | Criador         | Duração |
| ----------- | -------------------------------------------- | --------------- | ------- |
| `uiClick`   | `rbxasset://sounds/button.wav`               | Roblox (engine) | 0,58 s  |
| `uiHover`   | `rbxasset://sounds/switch.wav`               | Roblox (engine) | 0,24 s  |
| `uiOpen`    | `rbxasset://sounds/switch3.wav`              | Roblox (engine) | 0,37 s  |
| `uiClose`   | `rbxasset://sounds/switch3.wav` (0,82–0,88×) | Roblox (engine) | 0,37 s  |
| `uiBuy`     | `rbxasset://sounds/victory.wav`              | Roblox (engine) | 1,31 s  |
| `uiError`   | `rbxasset://sounds/bass.wav`                 | Roblox (engine) | 1,01 s  |

### BGM, ambiente e stingers

| Nome lógico        | Asset                                                                    | Criador         | Duração | Observação                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------ | --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bgmNight`         | `rbxassetid://9114244977` — "Electric Forest Airy Washy Shrieky 4 (SFX)" | ProSoundEffects | 148,7 s | Leito da noite, em loop.                                                                                                                                |
| `ambDay`           | `rbxassetid://9112833822` — "Neighborhood 3 (SFX)"                       | ProSoundEffects | 67,7 s  | "Pasadena morning, heavy air, **no traffic**, bird chirps, loop" — exatamente a cidade pequena americana poucos dias depois do surto (DESIGN_RULES §1). |
| `ambDawn`          | `rbxassetid://9116969481` — "Morning Birds 5 (SFX)"                      | ProSoundEffects | 74,7 s  | Camada extra entre 6 h e 10 h.                                                                                                                          |
| `heartbeat1`       | `rbxassetid://9043365727` — "HEARTBEAT 01 96BPM"                         | APMOfficial     | 60,1 s  | Nível 1 (< 35 % HP).                                                                                                                                    |
| `heartbeat2`       | `rbxassetid://9043365842` — "HEARTBEAT 02 96BPM"                         | APMOfficial     | 60,1 s  | Nível 2 (< 22 % HP), 1,18×.                                                                                                                             |
| `heartbeat3`       | `rbxassetid://9043365993` — "HEARTBEAT 03 96BPM"                         | APMOfficial     | 60,1 s  | Nível 3 (< 10 % HP), 1,40×.                                                                                                                             |
| `stingerWave1/2/3` | `rbxassetid://12222030` — "HalloweenThunder.wav"                         | Roblox (id 1)   | 3,71 s  | Mesmo trovão nas três ondas, cada vez mais grave (1,00× / 0,90× / 0,78×).                                                                               |
| `stingerDawn`      | `rbxasset://sounds/victory.wav`                                          | Roblox (engine) | 1,31 s  | 7 h: você sobreviveu à noite.                                                                                                                           |

## Calibração de volume

Cadeia completa: `volume_final = base_do_som × ganho_do_barramento × roll-off_por_distância`.

**Ganho do barramento** (`src/client/audio/audio.ts`), a partir dos sliders que já existem no save
(`settings.soundEffect`, `settings.bgm`, ambos 0..1, padrão 0,5):

```
sfx = 1,00 × soundEffect^1.5
ui  = 0,80 × soundEffect^1.5     (a UI anda no slider de SFX; o save não tem um terceiro)
bgm = 0,70 × bgm^1.5
```

O expoente 1,5 é a curva perceptual usual: metade do slider soa como "metade do volume", não como 50 % da
potência. Com o padrão 0,5 → `sfx = 0,354`, `ui = 0,283`, `bgm = 0,247`.

**Volumes base** (todos ≤ 0,55, nenhum som pode estourar):

| Faixa       | Sons                                                                     | Por quê                                                           |
| ----------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 0,11        | `uiHover`                                                                | Tem de ser quase subliminar: passa o mouse por uma lista inteira. |
| 0,22 – 0,32 | UI, detritos, coleta, troca de arma, rosnados, recarga                   | Feedback, não evento.                                             |
| 0,34 – 0,45 | Tiros, morte de zumbi, dano no jogador, rugido de chefe, música da noite | O corpo do jogo.                                                  |
| 0,50 – 0,55 | Escopeta, sniper, explosão                                               | Os únicos picos, e ainda assim abaixo de 0,6.                     |

Na prática, com os sliders no padrão: um tiro de pistola sai a `0,45 × 0,354 ≈ 0,16` de `Sound.Volume`; a
explosão, a `0,195`. Com os sliders no máximo: `0,45` e `0,55`.

**Respeito ao jogador** (requisito de acessibilidade):

- Slider em 0 → `SoundGroup.Volume = 0` **e** o mixer nem chega a tocar (nenhuma voz, nenhum streaming).
- Nada entra "no susto": música e ambiente sempre em fade (2,5 s entrando, 3,5 s saindo), batimento cardíaco
  com crossfade de 1,2 s, stingers no máximo a 0,36 de base.
- Toast informativo ("i") é silencioso de propósito: aparece muito e não merece atenção.
- Cada disparo sorteia o pitch dentro de uma faixa estreita (±6 % na pistola), então um carregador inteiro não
  soa como o mesmo sample repetido.
- Teto de vozes: 20 espaciais + 10 planas; por som, no máximo 4 tiros sobrepostos (3 na escopeta/MG, 2 no
  sniper), roubando sempre a mais antiga.

## Pendências

- **A — takes de rajada.** `shotShotgun` (9112912106, "Multiple Shots") e `shotSniper` (9113195119, "Various
  Shot Bursts") têm mais de um disparo no mesmo arquivo. Estão cortados por `maxPlay` (0,60 s e 0,35 s), o que
  resolve no papel, mas **ninguém ouviu ainda**: se o arquivo começar com sala antes do take, o corte pega a
  parte errada. Precisa de uma passada de escuta para ajustar `startAt`/`maxPlay` — os dois campos já existem
  no catálogo. Plano B (uma linha): apontar os dois para `9114716927` com pitch mais grave.
  **Os dois passos (9114523345 / 9114523358, "Foot Stomp ... Multiple") estão no mesmo caso**, e é o mais
  sensível dos três: o passo toca ~2×/s, então um segundo baque dentro do mesmo passo vira manqueira. O
  corte está em 0,22 s (conservador: garante um baque só). Medição tentada pelo envelope do Ogg — as páginas
  têm 160 ms e o arquivo é quase sem perdas, então o bitrate não resolve os transientes; e `PlaybackLoudness`
  não avança no datamodel Edit (o motor de áudio do Studio não roda ali). Fica para uma sessão de Play: se o
  take for um baque só, tirar o `maxPlay` devolve a cauda natural.
- **B — voz de zumbi.** A série "Goliath Vocal Deep Growling Voice" é catalogada como _Robots - Voice_.
  Funciona grave, mas não é um zumbi. Não achei rosnado de criatura na biblioteca oficial; todos os resultados
  de "zombie growl" na busca eram upload de usuário com origem em COD/Minecraft — rejeitados.
- **C — dor do jogador.** `playerHurt` e `playerDeath` reaproveitam o `uuhhh.mp3` do engine com pitch
  diferente. Passa, mas o ideal é um take humano próprio da biblioteca oficial.
- **D — slots vazios.** Nenhum hoje. O **passo saiu desta lista**: ele não vem de um `FxEvent`, vem do ciclo
  de caminhada da view (`client/view/footsteps.ts` -> `client/audio/footstepAudio.ts`), que é o único lugar
  que sabe quando um pé encosta no chão. Os outros (porta, uso de item, tiro do lança-chamas, mordida) ainda
  não têm som porque **não têm evento** para disparar: ver a lista de `FxEvent` faltando no relatório da tarefa.
- **E — terceiro slider.** O save tem `soundEffect` e `bgm`; o barramento de UI anda pendurado no de SFX. Se
  quisermos um controle separado, é um campo novo em `SettingsData` (`src/shared/game/save.ts`, que não é meu)
  e uma linha em `refreshGains`.
