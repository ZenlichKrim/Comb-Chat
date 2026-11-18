package com.comb.winter.registry;

import com.comb.winter.core.StatsTicker;
import com.comb.winter.illness.IllnessTicker;
import com.comb.winter.loot.StormLoot;
import com.comb.winter.machine.CoffeeMachine;
import com.comb.winter.mobs.ZombieVariants;
import com.comb.winter.snow.SnowPhysics;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.level.block.Blocks;

/**
 * The glue between vanilla events and the systems. Kept in one file so a reader
 * can answer "what does this mod hook?" in ten seconds.
 */
public final class WinterEvents {
    private WinterEvents() {}

    public static void register() {
        // §5 variants are assigned when a zombie appears, not on every tick
        ServerEntityEvents.ENTITY_LOAD.register((entity, world) -> {
            if (entity instanceof Zombie zombie && zombie.getType() == net.minecraft.world.entity.EntityType.ZOMBIE) {
                ZombieVariants.assign(zombie);
            }
        });

        // §5 + §8.1: per-tick variant behaviour and the gift rash clock
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            if (server.getTickCount() % 10 != 0) return;
            for (ServerPlayer player : server.getPlayerList().getPlayers()) {
                player.level().getEntitiesOfClass(Zombie.class, player.getBoundingBox().inflate(24))
                        .forEach(ZombieVariants::tick);
                if (server.getTickCount() % (20 * 120) == 0 && player.getRandom().nextDouble() < 0.25) {
                    IllnessTicker.giveGift(player);       // §8.1 gift every two minutes, 25% chance
                }
                ZombieVariants.maybeSpawnYeti((net.minecraft.server.level.ServerLevel) player.level(), player);
            }
        });

        // §3/§6 breaking snow: storm loot and packing
        PlayerBlockBreakEvents.AFTER.register((world, player, pos, state, entity) -> {
            if (!(player instanceof ServerPlayer serverPlayer)) return;
            if (state.is(Blocks.SNOW) || state.is(Blocks.SNOW_BLOCK)) {
                StormLoot.onSnowBroken(serverPlayer, pos);
                SnowPhysics.footprint(world, pos);
            }
        });

        // §7 the machine: right-click with anything, repair with iron + redstone
        UseBlockCallback.EVENT.register((player, world, hand, hit) -> {
            if (world.isClientSide || !(player instanceof ServerPlayer serverPlayer)) return InteractionResult.PASS;
            var stack = player.getItemInHand(hand);
            var pos = hit.getBlockPos();
            var state = world.getBlockState(pos);
            if (state.is(WinterBlocks.HOT_SPRING)) {
                var stats = StatsTicker.stats(serverPlayer);
                stats.warmth = Math.min(100, stats.warmth + 3);
                return InteractionResult.SUCCESS;
            }
            // a machine worn out is repaired by holding iron and right-clicking redstone-style
            if (state.is(Blocks.BREWING_STAND) && stack.is(net.minecraft.world.item.Items.IRON_INGOT)
                    && player.isShiftKeyDown() && CoffeeMachine.wear(pos) >= 10) {
                stack.shrink(1);
                CoffeeMachine.repair(serverPlayer, pos);
                return InteractionResult.SUCCESS;
            }
            return InteractionResult.PASS;
        });
    }
}
