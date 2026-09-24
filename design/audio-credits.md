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

**Os ids do P0-4 (2026-09-24, sessão na nuvem, sem Studio)** — voz da horda, mordida, portas, uso de item,
lança-chamas, motor, buzina e campainha — foram checados por três APIs públicas da Roblox, id a id:

1. **Busca na biblioteca do próprio criador:** `apis.roblox.com/toolbox-service/v2/assets:search?searchCategoryType=Audio`
   com `userId=7462895450` (a conta **ProSoundEffects**). Só entra o que a busca devolve **dessa conta**; nada de
   upload de usuário (a mesma busca sem o filtro devolve "zombie growl" do COD e do Minecraft — rejeitados).
2. **Detalhes do asset:** `economy.roblox.com/v2/assets/{id}/details` → `Creator.Name = "ProSoundEffects"`,
   `IsPublicDomain = true`, a descrição "Courtesy of Pro Sound Effects" e a categoria (ex.: "Voices - Beasts").
3. **Download do arquivo:** `assetdelivery.roblox.com/v2/assetId/{id}` → o OGG baixa **sem autenticação** (um áudio
   privado, pela regra de privacidade de 2022, é recusado aqui) e foi **decodificado** (libsndfile): duração real,
   envelope, onde começa e termina cada frase. Os campos `startAt`/`maxPlay`/`loopStart`/`loopEnd` saíram dessa
   medição, não de chute.

O que essa checagem **não** faz: ouvir. Os takes foram escolhidos pela descrição da biblioteca e cortados pelo
envelope; a passada de escuta no Studio é a pendência F.

**Reconferência de todos os ids (auditoria de áudio, 2026-09-24, sessão na nuvem):** os **37** `rbxassetid://` do
catálogo passaram de novo pelas APIs públicas: `economy.roblox.com/v2/assets/{id}/details` → `AssetTypeId = 3`
(Audio), criador **Roblox** (3), **ProSoundEffects** (31) ou **APMOfficial** (3), `IsPublicDomain = true` em todos; e
`assetdelivery.roblox.com/v2/assetId/{id}` devolve a localização do arquivo, sem autenticação, para todos (um áudio
privado ou removido seria recusado ali). **Nenhum id quebrado.** Os 16 arquivos `rbxasset://sounds/*` são conteúdo do
cliente e foram conferidos no Studio (acima); não há API pública que os liste, e o espelho do cliente na web não
publica a pasta `content/sounds`.

## Os nossos sons (sintetizados)

Desde a auditoria de 2026-09-24 o jogo tem **sons próprios**: 40 eventos, 67 takes, gerados por código em
`tools/gen-sfx.mjs` (osciladores, ruído filtrado, envelopes, uma corda de Karplus-Strong, um reverb pequeno; nenhuma
amostra, nenhuma biblioteca, nenhuma dependência) e empacotados em cinco bancos WAV em `design/audio/banks/`. São
**nossos** — nada a creditar, nada que uma biblioteca possa retirar. A tabela evento → banco → takes → loudness → por
que soa assim está em `design/audio/README.md`; para ouvir, `docs/audio/preview.html`. As regras (estilo, loudness,
variação, limites, a volta à biblioteca) são a seção **SND** de `docs/DESIGN_RULES.md`.

- **Até o dono subir os bancos** (`npm run cloud -- upload-audio`), **cada evento toca a entrada desta tabela**, a da
  biblioteca: é o fallback de cada um (SND-01). Um banco que não carrega no cliente volta à biblioteca na sessão.
- **O que continua na biblioteca, de propósito:** o que é orgânico — vozes da horda, rugido de chefe, mordida, dor e
  morte do sobrevivente, portas, comer, bandagem, zíper, comprimidos, lança-chamas, motor, buzina, campainha,
  explosão, vidro, música da noite e ambientes (SND-02).
- **Eventos novos** (existem para os nossos sons; até o upload tocam o fallback indicado): `pickupAmmo`,
  `pickupFood`, `pickupMaterial` (o `clickfast.wav` do motor em alturas diferentes), `levelUp` (`victory.wav` a
  1,12×), `buildPlace` (`snap.wav` grave), `buildDeny` (`bass.wav` agudo).

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

| Nome lógico   | Asset                                                                    | Criador         | Duração | Observação                                                                                   |
| ------------- | ------------------------------------------------------------------------ | --------------- | ------- | -------------------------------------------------------------------------------------------- |
| `hitFlesh`    | `rbxasset://sounds/splat.wav`                                            | Roblox (engine) | 0,50 s  |                                                                                              |
| `zombieDeath` | `rbxasset://sounds/uuhhh.mp3`                                            | Roblox (engine) | 0,33 s  | Grunhido, tocado 0,60–0,78× (grave).                                                         |
| `bossRoar`    | `rbxassetid://9114628818` — "Goliath Vocal Deep Growling Voice 22 (SFX)" | ProSoundEffects | 2,12 s  | Tocado 0,58–0,68× (bem grave).                                                               |
| `playerHurt`  | `rbxasset://sounds/uuhhh.mp3`                                            | Roblox (engine) | 0,33 s  | Mesmo take do zumbi, 1,05–1,20× (agudo). Ver pendência C.                                    |
| `playerDeath` | `rbxasset://sounds/uuhhh.mp3`                                            | Roblox (engine) | 0,33 s  | 0,50–0,55×. Ver pendência C.                                                                 |
| `explosion`   | `rbxasset://sounds/impact_explosion_03.mp3`                              | Roblox (engine) | 2,59 s  | Zumbi-bomba e barris.                                                                        |
| `debrisWood`  | `rbxasset://sounds/collide.wav`                                          | Roblox (engine) | 1,20 s  | Árvore, construção.                                                                          |
| `debrisMetal` | `rbxasset://sounds/metal.ogg`                                            | Roblox (engine) | 0,60 s  | Carro, chefe, ricochete.                                                                     |
| `debrisGlass` | `rbxasset://sounds/glassbreak.wav`                                       | Roblox (engine) | 1,58 s  | O vidro de uma janela cedendo (EDI-18: o `Debris` "glass").                                  |
| `pickupItem`  | `rbxasset://sounds/clickfast.wav`                                        | Roblox (engine) | 0,29 s  |                                                                                              |
| `pickupCoin`  | `rbxasset://sounds/electronicpingshort.wav`                              | Roblox (engine) | 0,72 s  |                                                                                              |
| `craftDone`   | `rbxasset://sounds/switch3.wav`                                          | Roblox (engine) | 0,37 s  |                                                                                              |
| `footstepA`   | `rbxassetid://9114523345` — "Foot Stomp 3 (SFX)"                         | ProSoundEffects | 0,45 s  | Foley. O arquivo tem **vários** passos: `maxPlay` 0,22 s corta no primeiro. Ver pendência A. |
| `footstepB`   | `rbxassetid://9114523358` — "Foot Stomp 4 (SFX)"                         | ProSoundEffects | 0,47 s  | Mesma série, alternado com o A (um id só vira metrônomo a 2 passos/s). Ver pendência A.      |

### SFX — P0-4: a horda, a mordida, portas, uso de item, lança-chamas, moto

Todos **ProSoundEffects** (biblioteca oficial gratuita, `IsPublicDomain = true`, verificados como descrito acima).
"Janela" é o trecho do arquivo que toca (`startAt` → `startAt + maxPlay`), ou o trecho que faz o loop
(`loopStart`–`loopEnd`, `Sound.LoopRegion`). Quem decide: **servidor** = um `Fx Sound` (§4.2 do
`docs/MULTIPLAYER.md`, id u8 da lista `WIRE_SOUNDS` de `shared/net/fxWire.ts`, filtrado por interesse como todo
efeito) no lugar onde aconteceu; **cliente** = derivado do estado que o cliente já tem.

| Evento                    | Nome lógico     | Asset (id — nome na biblioteca)                                    | Janela           | Quem decide | Observação                                                                                                                                                         |
| ------------------------- | --------------- | ------------------------------------------------------------------ | ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mordida que tirou sangue  | `bite`          | `9114574294` — "Giant Bug Chomps 3" (Gore / mordidas)              | 0,20–0,90 s      | servidor    | "Crunching thuds, tearing, snapping, mushy". Só a mordida que acertou (LEG-04), nunca a inclinação.                                                                |
| Porta de madeira abre     | `doorOpen`      | `9120839599` — "Wood Door Creak Squeak 11"                         | 0,55–1,85 s      | servidor    | Rangido; take baixo (pico −34 dB), volume base 0,5; some a 1100 u.                                                                                                 |
| Porta de madeira fecha    | `doorClose`     | `9120839870` — "Wood Door Open Soft Close 4"                       | 0,95–1,75 s      | servidor    | A batida do trinco.                                                                                                                                                |
| Porta de ferro abre       | `ironDoorOpen`  | `9116841392` — "Metal Screen Security Door 9" (Creaks and Squeaks) | 0,68–1,58 s      | servidor    |                                                                                                                                                                    |
| Porta de ferro fecha      | `ironDoorClose` | `9116835170` — "Metal Screen Security Door 2" (Big Bang, Slam)     | 0,00–1,00 s      | servidor    | Take alto: volume base 0,3.                                                                                                                                        |
| Comer (toda comida)       | `useEat`        | `9113138343` — "Apple Chew 1" (Bite and Chew)                      | 0,00–1,45 s      | servidor    | O uso que o servidor ACEITOU (`itemUseEffect`); um recusado não faz som.                                                                                           |
| Enfaixar (Bandage)        | `useBandage`    | `9113827650` — "Cloth Rip Linen 11"                                | 0,00–0,60 s      | servidor    |                                                                                                                                                                    |
| Kit de primeiros socorros | `useMedkit`     | `9113260699` — "Bag Zipper From Nylon Bag Backpack Luggage 1"      | 0,00–0,80 s      | servidor    | A bolsa do kit aberta.                                                                                                                                             |
| Analgésico, sedativo      | `usePills`      | `9114074235` — "Dice Shake 1" (Rattle)                             | 0,30–1,50 s      | servidor    | Chocalho de dados no lugar do frasco: a biblioteca não tem frasco de comprimido audível (o "Safety Lock Lid Cold Medicine Bottle", `9125891613`, tem pico −43 dB). |
| Adrenalina (injeção)      | `useInject`     | **vazio** (`id: ""`)                                               | —                | servidor    | **Slot vazio, silêncio.** Ver pendência D.                                                                                                                         |
| Lança-chamas: o jato      | `flameLoop`     | `9120192302` — "Torch Lighter 1" (Steady Mini Rocket Flame)        | loop 1,5–8,5 s   | cliente     | Loop preso enquanto a arma cospe fogo, tocado a 0,55× (o chiado vira rugido).                                                                                      |
| Lança-chamas: a ignição   | `flameIgnite`   | `9117988736` — "Pyro Fire Ball Burst 7"                            | inteiro (0,65 s) | cliente     | Uma vez por rajada. Antes o lança-chamas tocava o "ping" da arma de choque 15×/s.                                                                                  |
| Motor da moto             | `engineMoto`    | `9112787824` — "Go Kart Exhaust Constant 1" (bicilíndrico 4T)      | loop 28,5–42,5 s | cliente     | O trecho em marcha lenta; altura 0,78× (parada) → 1,8× (máxima) e volume 55 % → 100 % pela velocidade. Todo piloto ao alcance, você e os aliados.                  |
| Buzina da moto            | `hornMoto`      | `9120383448` — "Vehicle Horn Honk European Buzzing Whine 1"        | 0,00–0,50 s      | servidor    | Buzina fina e zumbida, de moto. O mesmo aperto que o `onVehicleNoise` manda à horda.                                                                               |
| Campainha da bicicleta    | `bellBike`      | `9125390319` — "Bicycle Bell Ringing Single Double One Deeper"     | 0,22–0,82 s      | servidor    | O primeiro toque (o arquivo tem vários).                                                                                                                           |
| Gemido 1 (zumbi parado)   | `zombieGroanA`  | `9120231499` — "Tracheotomy Voice 1" (Gross Grunt, Gurgles)        | 1,08–3,13 s      | cliente     | Voz **humana** ("Voices - Misc"): grunhido com gorgolejo e respiração difícil.                                                                                     |
| Gemido 2                  | `zombieGroanB`  | `9120231499` — o mesmo take                                        | 3,46–4,36 s      | cliente     | A engasgada curta do mesmo take.                                                                                                                                   |
| Gemido 3 (respiração)     | `zombieGroanC`  | `9114663862` — "Gross Snoring Cu Breathing Inhale Exhale 8"        | 0,15–2,10 s      | cliente     | "Creature, Beast": respiração molhada pelo nariz.                                                                                                                  |
| Gemido 4 (grunhido)       | `zombieGroanD`  | `9114625030` — "Goblin Growl 9" (Human Generated Roar)             | 0,00–1,10 s      | cliente     | Tocado 0,72–0,82× (vira gemido).                                                                                                                                   |
| Um zumbi te viu           | `zombieAggroA`  | `9116968474` — "Monster Vocals 12" (Snarling, Growling)            | 0,30–1,35 s      | cliente     | Rosnado.                                                                                                                                                           |
| Um zumbi te viu (outro)   | `zombieAggroB`  | `9114624779` — "Goblin Growl 6" (Human Generated Roar)             | 0,12–1,77 s      | cliente     | Alternado com o A.                                                                                                                                                 |
| Um grupo vira de uma vez  | `zombieShout`   | `9113989593` — "Creature Vocals 1" (Attacking, Throaty Groans)     | 2,28–4,03 s      | cliente     | O grito da IA-03: 3+ zumbis te vendo no mesmo quadro são UM grito.                                                                                                 |

**Como a horda não vira barulho** (`client/audio/gameAudio.ts`): toda fala de zumbi gasta uma ficha de um orçamento
de **3**, que volta **1 a cada 0,75 s**; o gemido ambiente vem a cada `7 / √n` s (n = zumbis a até 1100 u; entre
1,5 e 7 s, ×0,7–1,3), nunca o mesmo take duas vezes seguidas e nunca o mesmo zumbi em 7 s; a altura segue o tipo
(charger 0,8×, explosivo 0,9×, cuspidor 1,12×, saltador 1,16×; o grande 0,85×). Medido por `npm run test:audio`
§G: um zumbi perto, ~6 gemidos por minuto; sessenta, ~40 — nunca sessenta vozes.

**Motor e jato são loops presos** (`audio.holdLoop`): 6 vozes em loop no pool, criadas no início (nenhuma Instance
por motor ou por rajada), cada uma presa a um emissor que segue a fonte; quem as segura as pede a cada quadro, e
a que ninguém segurou esvai em 0,25 s e volta ao pool. SFX em 0 as para.

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
- Teto de vozes: 20 espaciais + 14 planas (a UI e os sons do próprio sobrevivente, que são centrados: SND-05);
  por som, no máximo 4 tiros sobrepostos (3 na escopeta/MG, 2 no sniper), roubando sempre a mais antiga; o mesmo som
  de novo dentro do seu `minGap` (30 ms; 50 ms impacto, 80 ms morte de zumbi, 120 ms explosão) não toca (SND-04).
- Tiros, impactos, passos, gemidos e detritos variam também o volume (`volJitter`, até −12 %…−20 %).

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
- **B — voz de zumbi. Resolvida (P0-4, 2026-09-24).** A série "Goliath Vocal Deep Growling Voice" (_Robots -
  Voice_) saiu da horda; ficou só no `bossRoar`. A busca **filtrada pela conta ProSoundEffects** achou vozes humanas
  e de criatura nas categorias "Voices - Misc" / "Voices - Beasts" (tabela do P0-4 acima). A busca aberta continua
  devolvendo upload de usuário com origem em COD/Minecraft — rejeitados, como antes.
- **C — dor do jogador.** `playerHurt` e `playerDeath` reaproveitam o `uuhhh.mp3` do engine com pitch
  diferente. Passa, mas o ideal é um take humano próprio da biblioteca oficial. (Voz não se sintetiza: SND-02.)
  Desde a auditoria, a dor só toca num **golpe** (≥ 1 HP num quadro, no máximo a cada 0,35 s): antes, veneno e fome
  a repetiam a cada quadro.
- **D — slots vazios: `useInject` (a adrenalina).** **Resolvida pelos nossos sons**: o banco `impacts` tem a injeção
  (um estalo de plástico, um "pssht", um tilintar de vidro); toca assim que o dono subir os bancos. Até lá, o slot da
  biblioteca continua `id: ""` e em **silêncio**, pelo motivo de sempre: "syringe", "injection", "needle" e "shot"
  na biblioteca da ProSoundEffects só acham "Pressure Blast" e robôs, e upload de usuário não entra. **Para o dono
  preencher:** achar um take oficial (ProSoundEffects / APMOfficial / Roblox) de seringa ou autoinjetor, conferir
  `Creator` e `IsPublicDomain` (acima), pôr o id em `src/shared/data/sounds.ts` `useInject` e uma linha nesta
  tabela; `npm run test:audio` §A passa a exigir o crédito. Os outros eventos que não tinham som (porta, uso de
  item, lança-chamas, mordida, motor, buzina) **agora têm evento e som** (P0-4). O passo continua fora desta lista:
  vem do ciclo de caminhada da view (`client/view/footsteps.ts` → `client/audio/footstepAudio.ts`).
- **F — passada de escuta do P0-4.** As janelas (`startAt`, `maxPlay`, `loopStart`/`loopEnd`) foram medidas no
  envelope decodificado, sem ouvir. No Studio, com o som ligado: o loop do motor (28,5–42,5 s) não pode estalar na
  volta; o `flameLoop` a 0,55× tem de soar como jato, não como chiado; e cada gemido tem de ser um gemido. Ajustar
  é mudar um número no catálogo.
- **G — sons de outros jogadores (P0-4, de brinde).** Até aqui o tiro de um aliado era **mudo** nas outras telas
  (o `Shot` do fio desenhava a linha e o impacto, sem som). Agora toca o som da arma dele, do corpo dele
  (`fxAudio.remoteShotSound`), e a flecha e o jato do lança-chamas dele também (`remoteProjectileSound`). As
  torretas seguem mudas (o fio não diz de onde atiraram).
- **E — terceiro slider.** O save tem `soundEffect` e `bgm`; o barramento de UI anda pendurado no de SFX. Se
  quisermos um controle separado, é um campo novo em `SettingsData` (`src/shared/game/save.ts`, que não é meu)
  e uma linha em `refreshGains`.
