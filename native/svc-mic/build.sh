#!/bin/sh
# Builds web/src/svc-mic.wasm: RNNoise and SpeexDSP at the versions, model and settings
# Simple Voice Chat 2.6.24 ships (rnnoise4j 2.1.3, speex4j 1.0.3), with shim.c on top.
# The .wasm is committed, so building the hub never needs this; run it only to change it.
# Needs git, curl, python3 and zig 0.14.1 (the compiler Simple Voice Chat's natives are built
# with), all fetched into fetched/ (not in git) and checked against the hashes below.
set -eu
cd "$(dirname "$0")/../.."
F=fetched
OUT=web/src/svc-mic.wasm

ZIG_VERSION=0.14.1
ZIG_SHA=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c
RNNOISE_COMMIT=372f7b4b76cde4ca1ec4605353dd17898a99de38 # rnnoise4j 2.1.3: one after v0.2
RNNOISE_DATA=0b50c45
RNNOISE_DATA_SHA=4ac81c5c0884ec4bd5907026aaae16209b7b76cd9d7f71af582094a2f98f4b43
# The small model as Simple Voice Chat loads it (henkelmax/rnnoise-weights v0.2,
# weights_blob_small.bin): xiph's "little" model dumped without its float debug copies.
WEIGHTS_SHA=92d017c4c95e834c06534e916ee876df4a49890d37d3f398d6ea4ec0e1da9eaf
# The keyboard noise gate's Silero weights, as MT Utils carries them: silero16k.bin here, made by
# silero-export.py from Silero VAD v6 (silero_vad_v6.onnx, sha256 1a153a22...).
SILERO_SHA=f251839a36a8909ae5f18519062ccde2117ab33812419d8d6985b9a72bfb7729
SPEEXDSP_TAG=SpeexDSP-1.2.1
SPEEXDSP_COMMIT=1b28a0f61bc31162979e1f26f3981fc3637095c8
# On x86-64 (most players), RNNoise compiles its SSE2 code, whose maths differs from its plain C
# (other approximations of tanh and sigmoid, another int8 layout). Emscripten's SSE headers
# (MIT) turn those intrinsics into WebAssembly SIMD, so the hub runs the SSE2 code too.
EMSCRIPTEN_TAG=4.0.9
XMMINTRIN_SHA=dae75290072a1481af7d8bcebb8fd3c2e0dc189a00bad2d3a832358008482a99
EMMINTRIN_SHA=b9bbbf4209c3e645f716e3395f52ce5f5405098314cd6c3285ed9d11e3bebba7

check() { echo "$2  $1" | sha256sum -c --quiet || { echo "$1: wrong checksum" >&2; exit 1; }; }
mkdir -p $F

if [ ! -x $F/zig/zig ]; then
  curl -sSL -o $F/zig.tar.xz https://ziglang.org/download/$ZIG_VERSION/zig-x86_64-linux-$ZIG_VERSION.tar.xz
  check $F/zig.tar.xz $ZIG_SHA
  tar xf $F/zig.tar.xz -C $F && rm $F/zig.tar.xz && mv $F/zig-x86_64-linux-$ZIG_VERSION $F/zig
fi
[ "$($F/zig/zig version)" = $ZIG_VERSION ] || { echo "fetched/zig is not $ZIG_VERSION" >&2; exit 1; }
ZIG=$F/zig/zig

[ -d $F/rnnoise ] || git clone -q https://github.com/xiph/rnnoise.git $F/rnnoise
git -C $F/rnnoise checkout -q $RNNOISE_COMMIT
[ -d $F/speexdsp ] || git clone -q --depth 1 -b $SPEEXDSP_TAG https://github.com/xiph/speexdsp.git $F/speexdsp
[ "$(git -C $F/speexdsp rev-parse HEAD)" = $SPEEXDSP_COMMIT ] || { echo "fetched/speexdsp is not $SPEEXDSP_TAG" >&2; exit 1; }

E=$F/emscripten-compat
mkdir -p $E
for h in xmmintrin emmintrin; do
  [ -f $E/$h.h ] || curl -sSL -o $E/$h.h https://raw.githubusercontent.com/emscripten-core/emscripten/$EMSCRIPTEN_TAG/system/include/compat/$h.h
done
check $E/xmmintrin.h $XMMINTRIN_SHA
check $E/emmintrin.h $EMMINTRIN_SHA
# immintrin.h as RNNoise's SSE2 code expects it from an x86 compiler: SSE and SSE2, the name of
# the AVX2 integer type (only renamed, never used without AVX2), and SSSE3's maddubs, which the
# SSE2 path never calls (a trap if it ever did).
cat > $E/immintrin.h <<'EOF2'
#define isnanf(x) __builtin_isnan(x)
#include <emmintrin.h>
typedef struct { __m128i lo, hi; } __m256i;
static inline __m128i _mm_maddubs_epi16(__m128i a, __m128i b) { (void)a; (void)b; __builtin_trap(); }
EOF2

T=$F/rnnoise_data-$RNNOISE_DATA.tar.gz
[ -f $T ] || curl -sSL -o $T https://media.xiph.org/rnnoise/models/rnnoise_data-$RNNOISE_DATA.tar.gz
check $T $RNNOISE_DATA_SHA
B=$F/svc-mic-build
rm -rf $B && mkdir -p $B/data $B/rn $B/speex
tar xzf $T -C $B/data

# RNNoise's sources with the little model's header in place of the big one's (as rnnoise4j).
cp -r $F/rnnoise/src/*.c $F/rnnoise/src/*.h $F/rnnoise/src/x86 $B/rn/
cp $B/data/src/rnnoise_data_little.h $B/rn/rnnoise_data.h
cp $B/data/src/rnnoise_data_little.c $B/rn/rnnoise_data.c

# The weights blob, dumped natively from the little model and checked against the pinned hash.
$ZIG cc -O2 -DDUMP_BINARY_WEIGHTS -DDISABLE_DEBUG_FLOAT -I$B/rn -I$F/rnnoise/include \
  $B/rn/write_weights.c -o $B/dump -lm
(cd $B && ./dump)
check $B/weights_blob.bin $WEIGHTS_SHA
check native/svc-mic/silero16k.bin $SILERO_SHA
python3 -I - "$B/weights.h" "$B/weights_blob.bin" weights native/svc-mic/silero16k.bin silero <<'EOF'
import sys
with open(sys.argv[1], 'w') as f:
    for path, name in zip(sys.argv[2::2], sys.argv[3::2]):
        d = open(path, 'rb').read()
        f.write('static const unsigned char %s[%d] __attribute__((aligned(64))) = {\n' % (name, len(d)))
        for i in range(0, len(d), 32):
            f.write(','.join(str(b) for b in d[i:i + 32]) + ',\n')
        f.write('};\n')
EOF

# SpeexDSP's integer types, as its configure step would write them.
mkdir -p $B/speex/speex
cat > $B/speex/speex/speexdsp_config_types.h <<'EOF'
#ifndef SPEEXDSP_CONFIG_TYPES_H
#define SPEEXDSP_CONFIG_TYPES_H
#include <stdint.h>
typedef int16_t spx_int16_t;
typedef uint16_t spx_uint16_t;
typedef int32_t spx_int32_t;
typedef uint32_t spx_uint32_t;
#endif
EOF

# The flags Simple Voice Chat's natives are built with (-Oz; no fast-math, no FMA).
CFLAGS="-target wasm32-wasi -Oz -std=c99"
OBJ=""
for c in $B/rn/*.c; do
  case $(basename $c) in dump_features.c|dump_rnnoise_tables.c|write_weights.c) continue ;; esac
  o=$B/rn-$(basename $c .c).o
  $ZIG cc $CFLAGS -msimd128 -D__SSE__ -D__SSE2__ -DUSE_WEIGHTS_FILE -I$E -I$B/rn -I$F/rnnoise/include -c $c -o $o
  OBJ="$OBJ $o"
done
for c in $F/speexdsp/libspeexdsp/*.c; do
  case $(basename $c) in test*.c) continue ;; esac
  o=$B/sp-$(basename $c .c).o
  $ZIG cc $CFLAGS -DFLOATING_POINT -DUSE_SMALLFT -DDISABLE_WARNINGS -DEXPORT= \
    -I$B/speex/speex -I$F/speexdsp/include -I$F/speexdsp/libspeexdsp -c $c -o $o
  OBJ="$OBJ $o"
done
$ZIG cc $CFLAGS -ffp-contract=off -I$B -I$B/speex/speex -I$F/rnnoise/include -I$F/speexdsp/include -c native/svc-mic/shim.c -o $B/shim.o
$ZIG cc $CFLAGS -mexec-model=reactor -Wl,--gc-sections -Wl,--strip-all $OBJ $B/shim.o -o $OUT
echo "$OUT: $(wc -c < $OUT) bytes, sha256 $(sha256sum $OUT | cut -d' ' -f1)"
