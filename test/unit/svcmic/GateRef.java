// Reference output for the whole chain, gate included: the input through Simple Voice Chat's
// natives (its defaults: Noise Suppression on, Gain Auto, Voice Activation Auto, a 500 ms
// tail) and then MT Utils' keyboard noise gate, the way the game runs them:
//
//   java -cp voicechat-fabric-1.21.11-2.6.24.jar:mt-utils-<version>.jar GateRef.java in.s16 out.txt
//
// One line per 20 ms frame: RNNoise's probability, 1 if Simple Voice Chat sends the frame,
// Silero's newest probability (- when the gate wasn't asked), and which input frame goes out
// in its place (- for none). Frames Simple Voice Chat doesn't send never reach the gate, and
// time passes for it at 20 ms a frame, as on the game's microphone thread.
import com.macrotech.mtutils.feature.noisegate.NoiseGate;
import de.maxhenkel.rnnoise4j.Denoiser;
import de.maxhenkel.speex4j.AutomaticGainControl;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.Arrays;

public class GateRef {
    public static void main(String[] a) throws Exception {
        byte[] in = Files.readAllBytes(Path.of(a[0]));
        ByteBuffer src = ByteBuffer.wrap(in).order(ByteOrder.LITTLE_ENDIAN);
        int frames = in.length / 2 / 960;
        NoiseGate gate = NoiseGate.withSilero(t -> { throw new RuntimeException(t); });
        try (Denoiser d = new Denoiser(); AutomaticGainControl agc = new AutomaticGainControl(960, 48000);
             PrintWriter out = new PrintWriter(a[1])) {
            agc.setTarget((int) Math.round(32768.0 * Math.pow(10, -5 / 20.0)));
            int tail = 0;
            for (int i = 0; i < frames; i++) {
                short[] f = new short[960];
                for (int k = 0; k < 960; k++) f[k] = src.getShort();
                float p = d.denoiseInPlace(f);
                agc.setIncrement(p >= 0.95f ? 12 : 0);
                agc.agc(f);
                boolean sent;
                if (p >= 0.5f) {
                    tail = 25;
                    sent = true;
                } else if (tail > 0) {
                    tail--;
                    sent = true;
                } else {
                    sent = false;
                }
                String gp = "-", which = "-";
                if (sent) {
                    recent.addLast(new Object[]{i, f.clone()});
                    if (recent.size() > 8) recent.removeFirst();
                    short[] o = gate.process(f, 0.5, 8, 3, i * 20_000_000L);
                    gp = Float.toString(gate.probability());
                    if (o != null) which = Integer.toString(findTag(o));
                }
                out.println(p + " " + (sent ? 1 : 0) + " " + gp + " " + which);
            }
        }
    }

    // The gate returns a copy of a held frame: found by its samples among the last few sent.
    private static final ArrayDeque<Object[]> recent = new ArrayDeque<>();

    private static int findTag(short[] o) {
        for (Object[] e : recent) {
            if (Arrays.equals((short[]) e[1], o)) return (Integer) e[0];
        }
        return -2;
    }
}
