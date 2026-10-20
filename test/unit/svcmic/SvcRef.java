// Reference output for the hub's microphone chain (web/src/svcmic.ts): the same input through
// Simple Voice Chat's own classes and natives, taken from its jar (not part of this repo):
//
//   java -cp voicechat-fabric-1.21.11-2.6.24.jar SvcRef.java in.s16 <mode> out-prefix
//
// mode: auto (Noise Suppression on, Gain Auto: the defaults), raw (Noise Suppression off,
// Gain Auto), manual:<dB> (Noise Suppression on, Gain Manual at <dB>) or raw-manual:<dB>.
// Writes <prefix>.prob.f32 (RNNoise's speech probability per 20 ms frame), <prefix>.rn.s16
// (each frame after RNNoise) and <prefix>.out.s16 (after the gain), little-endian.
// What it calls follows MicrophoneProcessor.preprocess in Simple Voice Chat 2.6.24.
import de.maxhenkel.rnnoise4j.Denoiser;
import de.maxhenkel.speex4j.AutomaticGainControl;
import de.maxhenkel.voicechat.voice.client.VolumeManager;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;

public class SvcRef {
    public static void main(String[] a) throws Exception {
        byte[] in = Files.readAllBytes(Path.of(a[0]));
        String mode = a[1];
        boolean denoise = !mode.startsWith("raw");
        Double manual = mode.contains("manual:") ? Double.parseDouble(mode.substring(mode.indexOf(':') + 1)) : null;
        ByteBuffer src = ByteBuffer.wrap(in).order(ByteOrder.LITTLE_ENDIAN);
        int frames = in.length / 2 / 960;
        ByteBuffer prob = ByteBuffer.allocate(frames * 4).order(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer rn = ByteBuffer.allocate(frames * 960 * 2).order(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer out = ByteBuffer.allocate(frames * 960 * 2).order(ByteOrder.LITTLE_ENDIAN);
        VolumeManager volume = new VolumeManager();
        try (Denoiser d = new Denoiser(); AutomaticGainControl agc = new AutomaticGainControl(960, 48000)) {
            agc.setTarget((int) Math.round(32768.0 * Math.pow(10, -5 / 20.0)));
            short[] f = new short[960];
            for (int i = 0; i < frames; i++) {
                for (int k = 0; k < 960; k++) f[k] = src.getShort();
                float p = denoise ? d.denoiseInPlace(f) : d.getSpeechProbability(f);
                prob.putFloat(p);
                for (short s : f) rn.putShort(s);
                if (manual == null) {
                    agc.setIncrement(p >= 0.95f ? 12 : 0);
                    agc.agc(f);
                } else {
                    volume.adjustVolume(f, manual);
                }
                for (short s : f) out.putShort(s);
            }
        }
        write(a[2] + ".prob.f32", prob);
        write(a[2] + ".rn.s16", rn);
        write(a[2] + ".out.s16", out);
    }

    static void write(String file, ByteBuffer b) throws Exception {
        try (FileOutputStream o = new FileOutputStream(file)) {
            o.write(b.array());
        }
    }
}
