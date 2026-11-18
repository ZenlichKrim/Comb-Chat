package com.comb.winter.registry;

import com.comb.winter.WinterMod;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;

/** §3 dense snow, §4 hot spring and the small snowman decoration. */
public final class WinterBlocks {
    private WinterBlocks() {}

    public static final Block DENSE_SNOW = register("dense_snow",
            new Block(BlockBehaviour.Properties.of()
                    .strength(0.6f)
                    .sound(SoundType.SNOW)
                    // walkable, unlike powder snow — that is the entire point
                    .friction(0.9f)));

    public static final Block HOT_SPRING = register("hot_spring",
            new Block(BlockBehaviour.Properties.of()
                    .strength(0.5f)
                    .sound(SoundType.STONE)
                    .lightLevel(s -> 6)
                    .randomTicks()));

    public static final Block SNOWMAN_SMALL = register("snowman_small",
            new Block(BlockBehaviour.Properties.of().strength(0.2f).sound(SoundType.SNOW).noOcclusion()));

    public static final Block SNOW_GLOBE = register("snow_globe",
            new Block(BlockBehaviour.Properties.of().strength(0.4f).sound(SoundType.GLASS).lightLevel(s -> 8)));

    private static Block register(String name, Block block) {
        return Registry.register(BuiltInRegistries.BLOCK, WinterMod.id(name), block);
    }

    public static void register() {
        // class-load triggers the static initialisers above
    }
}
