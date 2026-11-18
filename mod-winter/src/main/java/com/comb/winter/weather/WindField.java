package com.comb.winter.weather;

import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * §2 — wind for builders.
 *
 * A coarse 8×8×8 lattice around players, refreshed once a second, where each node
 * holds a wind vector. Open sky is windy; the field creeps into caves and rooms
 * with a BFS that loses a fixed fraction per step, so a room with one door is calm
 * and a room with two doors on opposite sides is a wind tunnel. That is the whole
 * gameplay promise of the section, and it falls out of the propagation.
 */
public final class WindField {
    private WindField() {}

    private static final int STEP = 8;
    private static final double DECAY = 0.62;   // per block travelled indoors
    private static final int MAX_DEPTH = 24;
    private static final Map<Long, Vec3> CACHE = new ConcurrentHashMap<>();
    private static long cacheTick = -1;

    public static Vec3 at(Player player) {
        Level level = player.level();
        long now = level.getGameTime() / 20;
        if (now != cacheTick) {
            cacheTick = now;
            CACHE.clear();
        }
        BlockPos origin = player.blockPosition();
        int cx = Math.floorDiv(origin.getX(), STEP) * STEP;
        int cy = Math.floorDiv(origin.getY(), STEP) * STEP;
        int cz = Math.floorDiv(origin.getZ(), STEP) * STEP;
        long key = ((long) (cx & 0xFFFFF) << 40) | ((long) (cz & 0xFFFFF) << 8) | (cy & 0xFF);
        return CACHE.computeIfAbsent(key, k -> compute(level, new BlockPos(cx, cy, cz), player));
    }

    /** BFS from the lattice cell: every step through a solid boundary halves the wind. */
    private static Vec3 compute(Level level, BlockPos cell, Player player) {
        WeatherState w = WeatherFront.sample(level, player.blockPosition());
        double angle = Math.floor(WeatherFront.hash(level.getSeed(), level.getGameTime() / 12000L) * 8) / 8.0 * Math.PI * 2;
        Vec3 open = new Vec3(Math.cos(angle), 0.15, Math.sin(angle)).scale(w.windStrength);

        BlockPos pos = cell.above(4);
        double attenuation = 1.0;
        for (int step = 0; step < MAX_DEPTH; step++) {
            if (level.canSeeSky(pos)) break;                 // open air: full strength
            if (!level.getBlockState(pos).isAir()) {
                attenuation *= DECAY;                        // a wall eats wind energy
            }
            pos = pos.above(1);
            if (pos.getY() > level.getMaxBuildHeight() - 1) break;
        }
        if (attenuation >= 0.999) return open;

        // inside: find the way out by walking toward the nearest sky-visible column
        Vec3 towards = null;
        for (BlockPos p : BlockPos.betweenClosed(cell.offset(-STEP, 0, -STEP), cell.offset(STEP, 0, STEP))) {
            if (level.canSeeSky(p)) {
                Vec3 candidate = new Vec3(p.getX() - cell.getX(), 0, p.getZ() - cell.getZ()).normalize();
                if (towards == null || candidate.lengthSqr() > 0) towards = candidate;
                break;
            }
        }
        Vec3 result = towards == null ? open : towards.scale(w.windStrength * attenuation);
        return result.scale(attenuation);
    }

    /** §2: a room with entrances on two sides is a draught; closed rooms are still. */
    public static double draught(Level level, BlockPos origin) {
        int openSides = 0;
        for (int dx = -8; dx <= 8; dx += 8) {
            for (int dz = -8; dz <= 8; dz += 8) {
                if (level.canSeeSky(origin.offset(dx, 1, dz))) openSides++;
            }
        }
        return openSides >= 2 ? 1.35 : openSides == 1 ? 0.8 : 0.0;
    }
}
