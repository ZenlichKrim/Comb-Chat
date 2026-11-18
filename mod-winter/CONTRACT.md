# What the spec asked for, and where it lives

This file is the audit the mod ships with: every numbered section of the user's
specification, mapped to the code that implements it, plus the places where a
Minecraft 1.21.11 API name must be confirmed against the real jar (`build.bat`
will show any mismatch as a compile error with the file and line).

| § | Spec | Code | State |
| --- | --- | --- | --- |
| 0 | Versions, official Mojang mappings, Java 21 | `gradle.properties`, `build.gradle` | done |
| 1 | Cold, warmth, body temp, wetness, gating below Y40 | `core/WinterStats`, `core/StatsTicker`, `core/Insulation` | done — numbers are the spec's per second |
| 2 | Fronts, 8-point wind, storms, drifts, wind for buildings, pressure | `weather/WeatherFront`, `weather/WindField`, `weather/WeatherTicker` | done — fronts are bands, not zones |
| 3 | Snow layers, ice, white leaves, packing, melting, drifts | `snow/SnowPhysics`, `registry/WinterBlocks`, `mixin/LeafTintMixin` | partly — surface rules and leaf tint need a resource-pack datapack step |
| 4 | Clothes, ice lantern, small snowman, hot spring | `registry/WinterRegistry`, `core/Insulation` | done |
| 5 | Five zombie variants + yeti, per-weather aggression, breath | `mobs/ZombieVariants` | done (breath particles are client-side, optional) |
| 6 | Storm loot, artifacts | `loot/StormLoot`, `registry/WinterRegistry` | done |
| 7 | Coffee machine, 26 brews, wear, repair, co-op message | `machine/CoffeeMachine` | done |
| 8 | Five illnesses | `illness/Illness`, `illness/IllnessTicker` | done |
| 9 | Transforms (wand placeholder) | `registry/WinterRegistry` (`transform_wand`) | stub on purpose — the spec says a jar will follow |
| 10 | Cold sensorics: vignette, fog, breath, sounds | `hud/WinterHud`, `compat/WinterConfig` | partly — fog/day-length need client mixins |
| 11 | Extra atmosphere (ice sculptures, cave echo) | `weather/WeatherTicker`, `snow/SnowPhysics` | partly |
| 12 | Co-op: warnings, respawn buffer, group bonus | `core/StatsTicker`, `weather/WeatherTicker` | done |
| 13 | HUD (four stats + pressure + frost) | `hud/WinterHud` | done, redesigned as one compact panel |

## Where the spec left room, and what was added

- **Fog and day length**: the spec asks for atmosphere but not how. `compat/WinterConfig`
  exposes `heavy_fog` and `long_nights`; the client hooks that read them are the next
  step, and the defaults are on.
- **HUD layout**: five separate bars in a corner read as a debug overlay. The panel
  is one block: icon, bar, number, colour-coded, and the frost vignette behind it.
- **Snow**: drifting is written as a leeward accumulation pass rather than block-by-block
  physics, because per-block physics at world scale is what makes storm mods unplayable.

## What cannot be verified without a game

Anything in the table marked "partly" needs a real client (fog, particles, sounds,
surface rules). `build.bat` proves it compiles; only a launch proves it looks right.
