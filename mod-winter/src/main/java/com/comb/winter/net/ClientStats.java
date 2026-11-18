package com.comb.winter.net;

/** Last numbers the server sent us — the HUD reads this, nothing else. */
public final class ClientStats {
    private ClientStats() {}

    public static volatile double cold;
    public static volatile double warmth = 50;
    public static volatile double bodyTemp = 37;
    public static volatile double wetness;
    public static volatile double pressure = 1013;
    public static volatile boolean snowblind;

    public static void accept(byte[] data) {
        io.netty.buffer.ByteBuf buf = io.netty.buffer.Unpooled.wrappedBuffer(data);
        cold = buf.readDouble();
        warmth = buf.readDouble();
        bodyTemp = buf.readDouble();
        wetness = buf.readDouble();
    }
}
