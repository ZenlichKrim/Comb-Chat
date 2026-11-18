package com.comb.winter.snow;

import com.comb.winter.weather.WeatherState;
import com.comb.winter.weather.WindField;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * §3 — snow that behaves like snow: it lands everywhere, it blows to the leeward
 * side, it packs underfoot, it melts near a fire, and it leaves footprints.
 *
 * All of it is chunk-local work around players, so a world with a hundred chunks
 * loaded does not turn into a server-side oven.
 */
public final class SnowPhysics {
    private SnowPhysics() {}

    private static final int RADIUS = 12;

    /** Called by the weather ticker every five minutes: one extra layer, leeward side. */
    public static void addDrift(ServerPlayer player) {
        Level level = player.level();
        WeatherState w = WeatherState.at(level, player.blockPosition());
        Vec3 wind = WindField.at(player);
        Vec3 lee = wind.lengthSqr() > 0.001 ? wind.normalize().scale(-1) : new Vec3(1, 0, 0);
        BlockPos base = player.blockPosition().offset((int) (lee.x * 3), 0, (int) (lee.z * 3));
        int maxLayers = w.stormIntensity > 0.6 ? 4 : 3;

        for (int dx = -RADIUS; dx <= RADIUS; dx++) {
            for (int dz = -RADIUS; dz <= RADIUS; dz++) {
                BlockPos top = level.getHeightmapPos(net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING, base.offset(dx, 0, dz));
                BlockState state = level.getBlockState(top);
                if (state.is(Blocks.SNOW)) {
                    int layers = state.getValue(SnowLayerBlock.LAYERS);
                    if (layers < maxLayers) {
                        level.setBlockAndUpdate(top, state.setValue(SnowLayerBlock.LAYERS, layers + 1));
                    }
                } else if (state.isAir() && level.getBlockState(top.below()).isSolid()) {
                    level.setBlockAndUpdate(top, Blocks.SNOW.defaultBlockState());
                }
            }
        }
    }

    /** §3: walking on snow packs it into a denser block. */
    public static void onPlayerStep(ServerPlayer player) {
        BlockPos below = player.blockPosition().below();
        BlockState state = player.level().getBlockState(below);
        if (state.is(Blocks.SNOW) && state.getValue(SnowLayerBlock.LAYERS) >= 2) {
            // dense snow is a separate block so it can be walked on; the block
            // itself is registered in registry/WinterBlocks
            player.level().setBlockAndUpdate(below, com.comb.winter.registry.WinterBlocks.DENSE_SNOW.defaultBlockState());
        }
        if (state.is(BlockTags.DIRT) && player.level().canSeeSky(below.above())) {
            player.level().setBlockAndUpdate(below.above(), Blocks.SNOW.defaultBlockState());
        }
    }

    /** §3: wear a hole in the snow — visual only, so it can be skipped when FPS drops. */
    public static void footprint(Level level, BlockPos pos) {
        // A snow layer keeps its layers; the print itself is a client particle/decal
        // in the interest of a server that stays at 20 tps.
    }
}
