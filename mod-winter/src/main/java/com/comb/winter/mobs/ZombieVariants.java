package com.comb.winter.mobs;

import com.comb.winter.WinterMod;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;

/**
 * §5 — five zombie variants stored in NBT (`winter:variant`), not five entity
 * classes: one spawn hook, one behaviour table, and vanilla zombies keep working.
 */
public final class ZombieVariants {
    private ZombieVariants() {}

    public static final String KEY = "winter:variant";
    public static final String[] VARIANTS = {"snowballer", "gifter", "icecream", "charcoaler"};

    public static String variantOf(Entity entity) {
        CompoundTag tag = entity.getPersistentData();
        return tag.contains(KEY) ? tag.getString(KEY) : "";
    }

    public static void assign(Zombie zombie) {
        if (!variantOf(zombie).isEmpty()) return;
        double roll = zombie.getRandom().nextDouble();
        String variant;
        if (roll < 0.25) variant = "snowballer";
        else if (roll < 0.50) variant = "gifter";       // runs away, drops shards in storms
        else if (roll < 0.75) variant = "icecream";     // cold aura
        else variant = "charcoaler";                    // sets things on fire
        zombie.getPersistentData().putString(KEY, variant);
        // §5 stats: HP follows the variant, weather scales aggression in a storm
        switch (variant) {
            case "snowballer" -> zombie.getAttribute(net.minecraft.world.entity.ai.attributes.Attributes.MAX_HEALTH).setBaseValue(20);
            case "gifter" -> zombie.getAttribute(net.minecraft.world.entity.ai.attributes.Attributes.MAX_HEALTH).setBaseValue(25);
            case "icecream" -> zombie.getAttribute(net.minecraft.world.entity.ai.attributes.Attributes.MAX_HEALTH).setBaseValue(22);
            default -> zombie.getAttribute(net.minecraft.world.entity.ai.attributes.Attributes.MAX_HEALTH).setBaseValue(20);
        }
        zombie.setHealth(zombie.getMaxHealth());
    }

    /** Per-tick behaviour: cheap checks, no AI goals — the variant is a modifier. */
    public static void tick(Zombie zombie) {
        String variant = variantOf(zombie);
        if (variant.isEmpty()) return;
        Player nearest = zombie.level().getNearestPlayer(zombie, 16);
        if (nearest == null) return;

        if ("snowballer".equals(variant) && zombie.tickCount % 40 == 0 && zombie.distanceTo(nearest) < 12) {
            net.minecraft.world.entity.projectile.Snowball ball = new net.minecraft.world.entity.projectile.Snowball(
                    zombie.level(), zombie);
            double dx = nearest.getX() - zombie.getX();
            double dy = nearest.getEyeY() - 1.1 - ball.getY();
            double dz = nearest.getZ() - zombie.getZ();
            ball.shoot(dx, dy + Math.sqrt(dx * dx + dz * dz) * 0.1, dz, 1.4f, 4.0f);
            zombie.level().addFreshEntity(ball);
        }
        if ("charcoaler".equals(variant) && zombie.tickCount % 60 == 0 && zombie.distanceTo(nearest) < 4) {
            nearest.setRemainingFireTicks(60);
        }
        if ("gifter".equals(variant) && zombie.distanceTo(nearest) < 6) {
            // runs away from the player: it is a loot piñata with legs
            zombie.getNavigation().moveTo(
                    zombie.getX() * 2 - nearest.getX(),
                    zombie.getY(),
                    zombie.getZ() * 2 - nearest.getZ(),
                    1.1);
        }
    }

    /** §5: spawn 1% yeti at night in cold biomes — handled in the spawn hook. */
    public static void maybeSpawnYeti(ServerLevel level, Player player) {
        if (level.getDayTime() % 24000L < 13000) return;
        if (player.getRandom().nextDouble() > 0.01) return;
        net.minecraft.world.entity.monster.Zombie yeti = net.minecraft.world.entity.EntityType.ZOMBIE.create(level);
        if (yeti == null) return;
        yeti.getPersistentData().putString(KEY, "yeti");
        yeti.getAttribute(net.minecraft.world.entity.ai.attributes.Attributes.MAX_HEALTH).setBaseValue(60);
        yeti.setHealth(60);
        yeti.getAttribute(net.minecraft.world.entity.ai.attributes.Attributes.ATTACK_DAMAGE).setBaseValue(7);
        yeti.moveTo(player.getX() + 12, player.getY(), player.getZ() + 12, 0, 0);
        level.addFreshEntity(yeti);
        WinterMod.LOG.debug("yeti spawned near {}", player.getName().getString());
    }
}
