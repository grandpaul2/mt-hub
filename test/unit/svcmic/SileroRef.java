// Reference for the keyboard gate's Silero alone: MT Utils' NoiseGate given every input frame
// (no tail or look-ahead needed for this: only its newest probability is read).
//
//   java -cp mt-utils-<version>.jar SileroRef.java in.s16 out.f32
//
// Writes the probability after each 20 ms frame, float32 little-endian.
import com.macrotech.mtutils.feature.noisegate.NoiseGate;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;

public class SileroRef {
    public static void main(String[] a) throws Exception {
        byte[] in = Files.readAllBytes(Path.of(a[0]));
        ByteBuffer src = ByteBuffer.wrap(in).order(ByteOrder.LITTLE_ENDIAN);
        int frames = in.length / 2 / 960;
        ByteBuffer out = ByteBuffer.allocate(frames * 4).order(ByteOrder.LITTLE_ENDIAN);
        NoiseGate gate = NoiseGate.withSilero(t -> { throw new RuntimeException(t); });
        for (int i = 0; i < frames; i++) {
            short[] f = new short[960];
            for (int k = 0; k < 960; k++) f[k] = src.getShort();
            gate.process(f, 0.5, 8, 0, i * 20_000_000L);
            out.putFloat(gate.probability());
        }
        try (FileOutputStream o = new FileOutputStream(a[1])) {
            o.write(out.array());
        }
    }
}
