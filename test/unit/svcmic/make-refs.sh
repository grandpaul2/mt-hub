#!/bin/sh
# Writes ref/, the reference data svcmic.test.mjs compares the hub's microphone chain with:
# made-up input (signal.mjs) through Simple Voice Chat's own natives and MT Utils' keyboard gate,
# taken from their jars, which this repo does not carry:
#   test/unit/svcmic/make-refs.sh voicechat-fabric-1.21.11-2.6.24.jar mt-utils-2.6.0.jar
# Needs Java 21. Run again only when one of those versions changes.
set -eu
cd "$(dirname "$0")"
SVC=$(realpath "$1") MT=$(realpath "$2")
JAVA=${JAVA:-java}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p ref
for seed in 2 3; do
  node signal.mjs $seed 60 $T/in.s16
  sha256sum < $T/in.s16 | cut -d' ' -f1 > ref/in$seed.sha256
  # RNNoise alone (the probability), Speex alone (raw: RNNoise leaves the samples alone), Manual gain.
  "$JAVA" -cp "$SVC" SvcRef.java $T/in.s16 auto $T/auto
  cp $T/auto.prob.f32 ref/auto$seed.prob.f32
  "$JAVA" -cp "$SVC" SvcRef.java $T/in.s16 raw $T/raw
  cp $T/raw.prob.f32 ref/raw$seed.prob.f32
  sha256sum < $T/raw.out.s16 | cut -d' ' -f1 > ref/raw$seed.out.sha256
  "$JAVA" -cp "$SVC" SvcRef.java $T/in.s16 raw-manual:12 $T/rm
  sha256sum < $T/rm.out.s16 | cut -d' ' -f1 > ref/raw-manual$seed.out.sha256
  # Silero alone, and the whole chain with the gate.
  "$JAVA" -cp "$MT" SileroRef.java $T/in.s16 ref/silero$seed.f32
  "$JAVA" -cp "$SVC:$MT" GateRef.java $T/in.s16 $T/gate.txt
  cut -d' ' -f2,4 $T/gate.txt > ref/chain$seed.txt
done
ls -l ref
