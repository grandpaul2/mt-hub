#!/usr/bin/env python3
"""Writes silero16k.bin, the keyboard noise gate's Silero weights, from the model file:
    silero-export.py silero_vad_v6.onnx
The model is Silero VAD v6 (MIT, github.com/snakers4/silero-vad); only its 16 kHz half is
used. Also in the file: the 61-tap low-pass filter in front of taking every third sample
(48 kHz to 16 kHz). The same file, byte for byte, as the game's keyboard noise gate carries, so
both hear the same. silero.c reads the arrays in this order. Needs numpy and onnx.
"""
import hashlib
import struct
import sys
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent / 'silero16k.bin'
PINNED = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
PREFIX = 'If_0_then_branch__Inline_0__'
ARRAYS = ['stft.forward_basis_buffer',
          'encoder.0.reparam_conv.weight', 'encoder.0.reparam_conv.bias',
          'encoder.1.reparam_conv.weight', 'encoder.1.reparam_conv.bias',
          'encoder.2.reparam_conv.weight', 'encoder.2.reparam_conv.bias',
          'encoder.3.reparam_conv.weight', 'encoder.3.reparam_conv.bias',
          'decoder.rnn.weight_ih', 'decoder.rnn.weight_hh', 'decoder.rnn.bias_ih', 'decoder.rnn.bias_hh',
          'decoder.decoder.2.weight', 'decoder.decoder.2.bias']


def load(path):
    """The 16 kHz half's arrays, by name, from the pinned model file."""
    import onnx
    from onnx import numpy_helper
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != PINNED:
        sys.exit(f'{path} is not the pinned model file (sha256 {PINNED})')
    model = onnx.load_from_string(data)
    branch = next(a.g for n in model.graph.node if n.op_type == 'If' for a in n.attribute if a.name == 'then_branch')
    found = {n.output[0][len(PREFIX):]: numpy_helper.to_array(n.attribute[0].t).astype(np.float32)
             for n in branch.node if n.op_type == 'Constant' and n.output[0].startswith(PREFIX)}
    return {name: found[name] for name in ARRAYS}


def lowpass():
    """61 taps, Kaiser window: the filter scipy.signal.resample_poly(x, 1, 3) uses."""
    n = np.arange(-30, 31)
    h = np.sinc(n / 3) / 3 * np.kaiser(61, 5.0)
    return (h / h.sum()).astype(np.float32)


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    arrays = load(argv[1])
    with open(OUT, 'wb') as f:
        f.write(b'MTSV1\0\0\0')
        for a in [lowpass()] + [arrays[name] for name in ARRAYS]:
            f.write(struct.pack('<i', a.size))
            f.write(a.astype('<f4').tobytes())
    print(f'{OUT}: {OUT.stat().st_size} bytes, sha256 {hashlib.sha256(OUT.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    main(sys.argv)
