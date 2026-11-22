"""Encode the benchmark's Chinese descriptors with the cached BGE ONNX model."""

import json
from pathlib import Path
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path('.e2e/benchmark-python').resolve()))
from tokenizers import Tokenizer


def encode(texts):
    model_dir = Path('.e2e/benchmark-model')
    tokenizer = Tokenizer.from_file(str(model_dir / 'tokenizer.json'))
    tokenizer.enable_truncation(max_length=128)
    tokenizer.enable_padding(pad_id=0, pad_token='[PAD]')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(model_dir / 'model_quantized.onnx'), options, providers=['CPUExecutionProvider'])
    inputs = {item.name for item in session.get_inputs()}
    vectors = {}
    for start in range(0, len(texts), 16):
        batch = texts[start:start + 16]
        tokens = tokenizer.encode_batch(batch)
        candidates = {
            'input_ids': [token.ids for token in tokens],
            'attention_mask': [token.attention_mask for token in tokens],
            'token_type_ids': [token.type_ids for token in tokens],
        }
        feeds = {key: np.asarray(value, dtype=np.int64) for key, value in candidates.items() if key in inputs}
        hidden, = session.run(['last_hidden_state'], feeds)
        cls_vectors = hidden[:, 0, :]
        if cls_vectors.shape[1] != 512 or not np.isfinite(cls_vectors).all():
            raise ValueError('Expected finite BGE vectors with 512 dimensions')
        vectors.update(zip(batch, cls_vectors.tolist()))
    return vectors


if __name__ == '__main__':
    json.dump(encode(json.load(sys.stdin)), sys.stdout, ensure_ascii=True)
