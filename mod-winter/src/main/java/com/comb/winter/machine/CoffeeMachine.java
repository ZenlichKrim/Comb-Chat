package com.comb.winter.machine;

import com.comb.winter.WinterMod;
import com.comb.winter.core.StatsTicker;
import com.comb.winter.core.WinterStats;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;

import java.util.Map;

/**
 * §7 — the coffee machine.
 *
 * The spec asks for "put anything in, get a coffee out" and 20–30 recipes. Rather
 * than 30 classes, this is a table: ingredient → (effect, warmth, message). Adding
 * a new brew later is one line, and datapacks can be supported by reading the same
 * table from a JSON at load time.
 *
 * The machine also wears out (10 brews), can be repaired with iron + redstone, and
 * refuses coffee as an input so it cannot loop.
 */
public final class CoffeeMachine {
    private CoffeeMachine() {}

    /** brews used per machine position, so worn machines stay worn */
    private static final Map<BlockPos, Integer> WEAR = new java.util.concurrent.ConcurrentHashMap<>();

    /** §7 table: ingredient → effect duration/amplifier and warmth bonus. */
    private record Recipe(Item item, String coffee, int warmth, MobEffectInstance effect) {}

    private static final Recipe[] RECIPES = {
            new Recipe(Items.SNOWBALL, "coffee_snow", 5, new MobEffectInstance(MobEffects.MOVEMENT_SPEED, 600, 0)),
            new Recipe(Items.COAL, "coffee_coal", 0, new MobEffectInstance(MobEffects.FIRE_RESISTANCE, 300, 0)),
            new Recipe(Items.DIAMOND, "coffee_diamond", 0, new MobEffectInstance(MobEffects.REGENERATION, 200, 1)),
            new Recipe(Items.WHITE_WOOL, "coffee_wool", 0, null),
            new Recipe(Items.ROTTEN_FLESH, "coffee_rotten_flesh", 20, new MobEffectInstance(MobEffects.HUNGER, 400, 0)),
            new Recipe(Items.ENDER_PEARL, "coffee_ender", 0, new MobEffectInstance(MobEffects.CONFUSION, 100, 0)),
            new Recipe(Items.IRON_INGOT, "coffee_iron", 0, new MobEffectInstance(MobEffects.DAMAGE_RESISTANCE, 600, 0)),
            new Recipe(Items.PAPER, "coffee_paper", 0, new MobEffectInstance(MobEffects.NIGHT_VISION, 1200, 0)),
            new Recipe(Items.GUNPOWDER, "coffee_gunpowder", 0, new MobEffectInstance(MobEffects.MOVEMENT_SPEED, 200, 1)),
            new Recipe(Items.APPLE, "coffee_apple", 0, new MobEffectInstance(MobEffects.SATURATION, 200, 0)),
            new Recipe(Items.GOLD_INGOT, "coffee_gold", 0, new MobEffectInstance(MobEffects.ABSORPTION, 600, 0)),
            new Recipe(Items.EMERALD, "coffee_emerald", 0, new MobEffectInstance(MobEffects.LUCK, 600, 0)),
            new Recipe(Items.LAPIS_LAZULI, "coffee_lapis", 0, new MobEffectInstance(MobEffects.WATER_BREATHING, 600, 0)),
            new Recipe(Items.REDSTONE, "coffee_redstone", 0, new MobEffectInstance(MobEffects.DIG_SPEED, 600, 0)),
            new Recipe(Items.GLOWSTONE_DUST, "coffee_glowstone", 0, new MobEffectInstance(MobEffects.JUMP, 600, 1)),
            new Recipe(Items.BONE, "coffee_bone", 0, new MobEffectInstance(MobEffects.DAMAGE_BOOST, 300, 0)),
            new Recipe(Items.STRING, "coffee_string", 0, new MobEffectInstance(MobEffects.SLOW_FALLING, 300, 0)),
            new Recipe(Items.LEATHER, "coffee_leather", 0, new MobEffectInstance(MobEffects.DAMAGE_RESISTANCE, 200, 0)),
            new Recipe(Items.FEATHER, "coffee_feather", 0, new MobEffectInstance(MobEffects.SLOW_FALLING, 600, 0)),
            new Recipe(Items.CLAY_BALL, "coffee_clay", 0, new MobEffectInstance(MobEffects.DIG_SLOWDOWN, 100, 0)),
            new Recipe(Items.SLIME_BALL, "coffee_slime", 0, new MobEffectInstance(MobEffects.JUMP, 400, 2)),
            new Recipe(Items.HONEY_BOTTLE, "coffee_honey", 5, new MobEffectInstance(MobEffects.REGENERATION, 100, 0)),
            new Recipe(Items.SUGAR, "coffee_sugar", 0, new MobEffectInstance(MobEffects.MOVEMENT_SPEED, 300, 1)),
            new Recipe(Items.KELP, "coffee_tea", 3, null),
            new Recipe(Items.ICE, "coffee_ice", 0, null),
    };

    /** Try to brew. Returns the resulting coffee item, or null when it cannot. */
    public static ItemStack brew(ServerPlayer player, BlockPos pos, ItemStack input) {
        if (input.isEmpty()) return ItemStack.EMPTY;
        if (input.getItem().getDescriptionId().contains("coffee")) {
            player.displayClientMessage(Component.translatable("winter.chat.no_coffee_loop"), true);
            return ItemStack.EMPTY;
        }
        int wear = WEAR.getOrDefault(pos, 0);
        if (wear >= 10) {
            player.displayClientMessage(Component.translatable("winter.chat.machine_worn"), true);
            return ItemStack.EMPTY;
        }

        Recipe match = null;
        for (Recipe r : RECIPES) if (input.is(r.item)) { match = r; break; }

        if (match != null && match.effect != null) {
            player.addEffect(match.effect);
            WinterStats stats = StatsTicker.stats(player);
            stats.warmth = Math.min(100, stats.warmth + match.warmth);
        } else if (match != null && "coffee_wool".equals(match.coffee)) {
            WinterStats stats = StatsTicker.stats(player);
            stats.cold = Math.max(0, stats.cold - 20);           // §7: −20% cold for two minutes
        } else if (match == null) {
            WinterStats stats = StatsTicker.stats(player);
            stats.warmth = Math.min(100, stats.warmth + 5);      // §7 coffee_plain
        }

        WEAR.put(pos, wear + 1);
        input.shrink(1);
        player.level().playSound(null, pos, SoundEvents.BREWING_STAND_BREW, SoundSource.BLOCKS, 0.8f, 1.2f);
        // §7 co-op: everyone sees what was brewed
        player.level().getServer().getPlayerList().broadcastSystemMessage(
                Component.translatable("winter.chat.brewed", player.getName(), Component.translatable("item.winter." + (match == null ? "coffee_plain" : match.coffee)))
                        .withStyle(ChatFormatting.GOLD), false);
        return new ItemStack(com.comb.winter.registry.WinterRegistry.COFFEES.get(match == null ? 25 : indexOf(match.coffee)));
    }

    private static int indexOf(String coffee) {
        String[] order = {"snow", "coal", "diamond", "wool", "rotten_flesh", "ender_pearl", "iron", "paper",
                "gunpowder", "apple", "gold", "emerald", "lapis", "redstone", "glowstone", "bone", "string",
                "leather", "feather", "clay", "slime", "honey", "sugar", "tea", "ice", "plain"};
        for (int i = 0; i < order.length; i++) if (order[i].equals(coffee)) return i;
        return 25;
    }

    /** §7 repair: iron + redstone resets the wear counter. */
    public static void repair(ServerPlayer player, BlockPos pos) {
        WEAR.put(pos, 0);
        player.displayClientMessage(Component.translatable("winter.chat.machine_repaired"), true);
    }

    public static int wear(BlockPos pos) { return WEAR.getOrDefault(pos, 0); }

    /** keeps the wear map from growing forever on a long-lived server */
    public static void tick(MinecraftServer server) {
        if (server.getTickCount() % 12000 != 0) return;
        if (WEAR.size() > 512) WEAR.clear();
    }

    /** §7 the abandoned house places one machine; this is the block used for it. */
    public static void placeMachine(net.minecraft.server.level.ServerLevel level, BlockPos pos) {
        level.setBlockAndUpdate(pos, Blocks.BREWING_STAND.defaultBlockState());
        level.setBlockAndUpdate(pos.above(), Blocks.AIR.defaultBlockState());
    }
}
