package com.comb.winter.weather;

import com.comb.winter.core.StatsTicker;
import com.comb.winter.mobs.ZombieVariants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.world.entity.monster.Zombie;

/**
 * A snapshot of the weather at one point in the world.
 *
 * The spec insists on fronts rather than zones: the same storm is weak in one
 * village and a whiteout in the next, and it arrives over a minute instead of
 * switching instantly. That is why everything here is a function of position and
 * time, never a global boolean.
 */
public final class WeatherState {
    public final double stormIntensity; // 0..1
    public final double windStrength;   // 0..3, "румбы" carry direction separately
    public final boolean snowing;
    public final double pressure;       // falls before a front, HUD shows the arrow

    public WeatherState(double stormIntensity, double windStrength, boolean snowing, double pressure) {
        this.stormIntensity = stormIntensity;
        this.windStrength = windStrength;
        this.snowing = snowing;
        this.pressure = pressure;
    }

    public static WeatherState at(Level level, BlockPos pos) {
        return WeatherFront.sample(level, pos);
    }

    /** §4: is there a heat source close enough to count? */
    public double warmthNearby(ServerPlayer player) {
        return StatsTicker.warmthAt(player, player.blockPosition());
    }

    /** §12.5: two or more players around one heat source warm a bit faster. */
    public boolean groupBonusNear(ServerPlayer player) {
        return player.level().getEntitiesOfClass(ServerPlayer.class, player.getBoundingBox().inflate(3)).size() >= 2;
    }

    /** §5.3: the ice-cream zombie's cold aura. */
    public double coldNearby(ServerPlayer player) {
        return player.level()
                .getEntitiesOfClass(net.minecraft.world.entity.monster.Zombie.class, player.getBoundingBox().inflate(3))
                .stream()
                .anyMatch(z -> "icecream".equals(ZombieVariants.variantOf(z)))
                ? 1.0 : 0.0;
    }

    /** Winter simulation only runs in the overworld; the nether is already "warm". */
    public static boolean isWinterActive(ServerPlayer player) {
        return player.level() instanceof ServerLevel serverLevel && serverLevel.dimension() == Level.OVERWORLD;
    }
}
