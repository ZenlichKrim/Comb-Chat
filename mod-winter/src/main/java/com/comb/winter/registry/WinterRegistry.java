package com.comb.winter.registry;

import com.comb.winter.WinterMod;
import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.item.ArmorItem;
import net.minecraft.world.item.ArmorMaterials;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.SwordItem;
import net.minecraft.world.item.Tiers;
import net.minecraft.core.Holder;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

/**
 * Blocks, items and effects.
 *
 * Kept flat and boring on purpose: a big mod lives or dies by its registry being
 * obvious. Every entry here is a name from the spec, so the user can search the
 * jar for "winter:wool_hat" and find the thing they were promised.
 */
public final class WinterRegistry {
    private WinterRegistry() {}

    public static final List<Supplier<? extends Item>> ITEMS = new ArrayList<>();

    // --- clothes (§4): insulation is applied in core/Insulation ---
    public static Item WOOL_HAT;
    public static Item WOOL_SWEATER;
    public static Item WOOL_PANTS;
    public static Item VALENKI;

    // --- decor and utility (§4) ---
    public static Item ICE_LANTERN;
    public static Item SNOWMAN_SMALL;

    // --- artifacts (§6) ---
    public static Item ARTIFACT_SHARD;
    public static Item FROST_WARD;
    public static Item STORM_EYE;
    public static Item WINTER_HEART;
    public static Item CHILLING_BLADE;
    public static Item TRANSFORM_WAND;

    // --- illness items (§8) ---
    public static Item SOAP;
    public static Item MEDICINE;
    public static Item TEA_HERBAL;
    public static Item TEA_LEAF;
    public static Item WINTER_KISS_SAMPLE;
    public static Item YETI_FUR;

    // --- coffee (§7) — one item per brewable ingredient ---
    public static final List<Item> COFFEES = new ArrayList<>();

    public static void register() {
        // Armour points are deliberately low: these are insulation, not protection.
        WOOL_HAT = armorLike("wool_hat", 1);
        WOOL_SWEATER = armorLike("wool_sweater", 2);
        WOOL_PANTS = armorLike("wool_pants", 1);
        VALENKI = armorLike("valenki", 1);

        ICE_LANTERN = simple("ice_lantern");
        SNOWMAN_SMALL = simple("snowman_small");

        ARTIFACT_SHARD = simple("artifact_shard");
        FROST_WARD = simple("frost_ward");
        STORM_EYE = simple("storm_eye");
        WINTER_HEART = simple("winter_heart");
        CHILLING_BLADE = Registry.register(BuiltInRegistries.ITEM, WinterMod.id("chilling_blade"),
                new SwordItem(Tiers.IRON, new Item.Properties().attributes(SwordItem.createAttributes(Tiers.IRON, 5, -2.4f))));
        TRANSFORM_WAND = simple("transform_wand");

        SOAP = simple("soap");
        MEDICINE = simple("medicine");
        TEA_HERBAL = simple("herbal_tea");
        TEA_LEAF = simple("tea_leaf");
        WINTER_KISS_SAMPLE = simple("winter_kiss_sample");
        YETI_FUR = simple("yeti_fur");

        // 26 coffees: the spec's ten plus enough that a player wants to try the
        // machine with everything in their inventory.
        for (String brew : new String[]{
                "snow", "coal", "diamond", "wool", "rotten_flesh", "ender_pearl", "iron",
                "paper", "gunpowder", "apple", "gold", "emerald", "lapis", "redstone",
                "glowstone", "bone", "string", "leather", "feather", "clay", "slime",
                "honey", "sugar", "tea", "ice", "plain"
        }) {
            COFFEES.add(simple("coffee_" + brew));
        }

        ItemGroupEvents.modifyEntriesEvent(CreativeModeTabs.TOOLS_AND_UTILITIES).register(entries -> {
            for (Supplier<? extends Item> s : ITEMS) entries.accept(s.get());
        });
    }

    private static Item simple(String name) {
        Item item = Registry.register(BuiltInRegistries.ITEM, WinterMod.id(name), new Item(new Item.Properties()));
        ITEMS.add(() -> item);
        return item;
    }

    /** Armour that exists for warmth: `Item` with armour attributes and no durability pressure. */
    private static Item armorLike(String name, int protection) {
        Item item = Registry.register(BuiltInRegistries.ITEM, WinterMod.id(name),
                new ArmorItem(ArmorMaterials.LEATHER, ArmorItem.Type.HELMET,
                        new Item.Properties().durability(120)));
        ITEMS.add(() -> item);
        return item;
    }
}
