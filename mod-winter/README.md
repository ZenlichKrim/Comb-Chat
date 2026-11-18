# Winter Atmosphere

A Fabric mod for **Minecraft 1.21.11** (Java 21, official Mojang mappings) that turns
winter into a system instead of a texture pack: body heat, wetness, weather fronts,
wind that respects walls, snow that accumulates and blows into drifts, clothes,
illness, five zombie variants, storm loot, artifacts, an abandoned house with a
coffee machine, and a HUD that tells you what is actually happening to you.

## Build a jar (Windows)

Double-click **`build.bat`**. First run downloads Gradle 8.10 + Minecraft + Fabric
(5–15 min), then writes the jar to `out\winter-atmosphere-1.0.0.jar`.
Drop it into `.minecraft\mods` together with Fabric API.

## Build a jar (Linux / macOS)

```bash
./gradlew build      # or: gradle build
# jar lands in build/libs/
```

## What is inside

| System | Where |
| --- | --- |
| Heat / cold / body temperature / wetness | `core/WinterStats.java`, `core/StatsTicker.java` |
| Weather fronts, wind, storms | `weather/WeatherFront.java`, `weather/WindField.java` |
| Snow physics, drifts, footprints | `snow/SnowPhysics.java` |
| Clothes and their insulation | `clothes/WinterClothes.java` |
| Five zombie variants + yeti | `mobs/ZombieVariants.java` |
| Storm loot and artifacts | `loot/StormLoot.java` |
| Coffee machine and abandoned house | `machine/CoffeeMachine.java` |
| Illnesses with hooks | `illness/Illness.java` |
| HUD | `hud/WinterHud.java` |
| Multiplayer sync | `net/WinterNet.java` |

Every number comes from the spec the user wrote; where an API name had to be
matched against 1.21.11 it is called out in a comment so a single `javap` fixes it.
