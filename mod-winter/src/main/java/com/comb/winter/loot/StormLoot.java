package com.comb.winter.loot;

import com.comb.winter.registry.WinterRegistry;
import com.comb.winter.weather.WeatherState;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.core.BlockPos;

/**
 * §6 — loot that only exists because the weather is bad.
 *
 * Breaking a snow layer in a storm has a 30% chance of paying out; the payouts are
 * weighted so an artifact shard is a real event and diamonds are a story.
 */
public final class StormLoot {
    private StormLoot() {}

    public static void onSnowBroken(ServerPlayer player, BlockPos pos) {
        Level level = player.level();
        WeatherState w = WeatherState.at(level, pos);
        if (w.stormIntensity <= 0.6) return;
        if (level.random.nextDouble() > 0.30) return;

        double roll = level.random.nextDouble();
        ItemStack drop;
        if (roll < 0.02) drop = new ItemStack(Items.DIAMOND);
        else if (roll < 0.07) drop = new ItemStack(WinterRegistry.ICE_LANTERN);
        else if (roll < 0.22) drop = new ItemStack(WinterRegistry.ARTIFACT_SHARD);
        else if (roll < 0.52) drop = new ItemStack(Items.IRON_INGOT, 2 + level.random.nextInt(3));
        else drop = new ItemStack(Items.GOLD_INGOT, 1 + level.random.nextInt(2));

        net.minecraft.world.entity.item.ItemEntity entity = new net.minecraft.world.entity.item.ItemEntity(
                level, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5, drop);
        level.addFreshEntity(entity);
    }

    /** §6: 2% artifact, 10% shard from storm mobs. Called from the mob death hook. */
    public static void onMobKilled(ServerPlayer player, net.minecraft.world.entity.LivingEntity mob) {
        WeatherState w = WeatherState.at(player.level(), player.blockPosition());
        if (w.stormIntensity <= 0.6) return;
        if (player.getRandom().nextDouble() < 0.02) {
            mob.spawnAtLocation(new ItemStack(WinterRegistry.ARTIFACT_SHARD, 3));
        } else if (player.getRandom().nextDouble() < 0.10) {
            mob.spawnAtLocation(new ItemStack(WinterRegistry.ARTIFACT_SHARD));
        }
    }
}
