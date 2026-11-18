package com.comb.winter.core;

import com.comb.winter.WinterMod;
import com.comb.winter.weather.WeatherState;
import com.comb.winter.weather.WindField;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import net.minecraft.core.BlockPos;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The heart: once per second, for every player, apply the spec's numbers.
 *
 * Written as a single pass with the reasons inline so the numbers stay reviewable
 * against §1 of the design. Anything visual is left to the client (HUD, vignette).
 */
public final class StatsTicker {
    private StatsTicker() {}

    private static final Map<UUID, WinterStats> STATS = new HashMap<>();
    private static int seconds = 0;

    public static WinterStats stats(ServerPlayer player) {
        return STATS.computeIfAbsent(player.getUUID(), id -> new WinterStats());
    }

    public static void forget(UUID id) { STATS.remove(id); }

    public static void tick(MinecraftServer server) {
        // the spec is written per second; running every tick would multiply it by 20
        if (++seconds % WinterMod.TICK != 0) return;
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            step(player, stats(player));
        }
    }

    private static void step(ServerPlayer player, WinterStats s) {
        if (!WeatherState.isWinterActive(player)) return;
        if (s.respawnGrace > 0) { s.respawnGrace--; return; }
        if (s.coldImmunity > 0) s.coldImmunity--;

        WeatherState w = WeatherState.at(player.level(), player.blockPosition());
        boolean sheltered = isSheltered(player);
        boolean wet = s.isWet();

        // ---- cold gain (§1) ----
        double gain = 0.5;                                   // day baseline
        double dayTime = player.level().getDayTime() % 24000L;
        if (dayTime > 13000) gain = 1.5;                     // night is colder
        if (w.stormIntensity > 0.6) gain += 2.5;             // storm
        if (player.isInWaterOrRain()) gain += 2.0;           // water
        if (player.getY() < 40 && w.warmthNearby(player) <= 0) gain += 1.0; // deep and unheated
        if (sheltered) gain *= 0.7;                          // a roof helps
        if (wet) gain *= 1.5;                                // soaked
        Vec3 wind = WindField.at(player);
        double windSpeed = wind.length();
        if (windSpeed >= 1.0) gain += 0.5;                   // wind chill
        if (s.warmth <= 0) gain *= 2.0;                      // no warmth left at all
        gain *= (1.0 - Insulation.reduction(player, wet));
        gain *= 1.0 + 0.2 * w.stormIntensity;
        if (w.coldNearby(player) > 0) gain += 1.0;           // zombie-icecream aura

        if (w.warmthNearby(player) > 0) {
            s.cold -= 2.0 * (wet ? 2.0 : 1.0);               // drying by the fire
        } else if (s.coldImmunity <= 0) {
            s.cold += gain;
        }
        if (s.stormExposure > 0 && !sheltered) s.stormExposure++;
        else if (!sheltered && w.stormIntensity > 0.6) s.stormExposure++;

        // ---- warmth (§1) ----
        double heat = w.warmthNearby(player);
        if (heat > 0) {
            s.warmth += heat * (w.groupBonusNear(player) ? 1.5 : 1.0); // §12.5 party bonus
        } else {
            s.warmth -= 1.0;
        }

        // ---- wetness (§1) ----
        if (player.isInWater()) s.wetness += 10;
        else if (w.snowing) s.wetness += w.stormIntensity > 0.6 ? 2 : 1;
        if (heat > 0) s.wetness -= 2;
        else if (sheltered) s.wetness -= 0.5;

        // ---- body temperature (§1) ----
        double target = 37.0;
        double drift = (37.0 - s.bodyTemp) * 0.02;
        double chill = (s.cold / 100.0) * 0.06 * Insulation.bodyExchange(player);
        double warming = heat > 0 ? 0.08 : 0;
        s.bodyTemp += warming - chill + drift;
        if (player.isSprinting()) s.bodyTemp -= 0.01;         // you do not warm up by running

        s.clamp();
        applyEffects(player, s);
        WinterStatsSync.push(player, s);
    }

    /** §1 thresholds: 75 slows and frosts the screen, 100 hurts and freezes. */
    private static void applyEffects(ServerPlayer player, WinterStats s) {
        if (s.cold >= 75) {
            player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 40, 0, true, false));
        }
        if (s.cold >= 100) {
            player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 40, 1, true, false));
            player.addEffect(new MobEffectInstance(MobEffects.DIG_SLOWDOWN, 40, 0, true, false));
            if (player.tickCount % 40 == 0) player.hurt(player.damageSources().freeze(), 1.0f);
        }
        if (s.bodyTemp < 32) {
            player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 40, 1, true, false));
        }
        if (s.bodyTemp < 30 && player.tickCount % 100 == 0) {
            player.hurt(player.damageSources().freeze(), 1.0f);
        }
    }

    /** §1: `canSeeSky = false` in a small BFS around the player counts as shelter. */
    public static boolean isSheltered(ServerPlayer player) {
        BlockPos origin = player.blockPosition();
        int seen = 0;
        for (BlockPos p : BlockPos.betweenClosed(origin.offset(-3, 0, -3), origin.offset(3, 2, 3))) {
            if (!player.level().canSeeSky(p)) seen++;
        }
        return seen >= 20;
    }

    /** warmth sources per §1: campfire 6/+3, active furnace 12/+4, torch 4/+1, ice lantern 3/+1.5 */
    public static double warmthAt(ServerPlayer player, BlockPos origin) {
        double best = 0;
        for (BlockPos p : BlockPos.betweenClosed(origin.offset(-12, -6, -12), origin.offset(12, 6, 12))) {
            double d = Math.sqrt(p.distSqr(origin));
            var state = player.level().getBlockState(p);
            if (state.is(Blocks.CAMPFIRE) || state.is(Blocks.SOUL_CAMPFIRE)) { if (d <= 6) best = Math.max(best, 3); }
            else if (state.is(Blocks.FURNACE) || state.is(Blocks.BLAST_FURNACE)) { if (d <= 12) best = Math.max(best, 4); }
            else if (state.is(Blocks.TORCH) || state.is(Blocks.WALL_TORCH)) { if (d <= 4) best = Math.max(best, 1); }
        }
        return best;
    }
}
