#!/usr/bin/env python3
"""seed-vc 音色转换的引擎：加载一次模型，对任意长度的音频做转换。

从 `.tmp/svc_go.py` 的原型整理而来，只保留「给一段音频 → 出转换后的音频」。
模型/依赖都在 `.svclibs`（和 `.pylibs` 分开，因为 numpy 版本冲突）。

对外只有两个函数：

    engine = Engine()                 # 加载模型（约 8s，内存约 4GB）
    out = engine.convert(src, ref)    # 都是 float32 numpy，44.1k 单声道

注意：这里有一堆 import 垫片（tensorboard / matplotlib / 缺的训练依赖），
都是因为 seed-vc 的推理链里混进了训练期依赖；不要删。
"""
from __future__ import annotations

import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".svclibs"))
sys.path.insert(0, os.path.join(ROOT, ".pylibs"))

for _k, _v in {
    "HF_ENDPOINT": "https://hf-mirror.com",
    "HF_HUB_DISABLE_XET": "1",
    "HF_HUB_DISABLE_SYMLINKS": "1",
}.items():
    os.environ.setdefault(_k, _v)

import numpy as np  # noqa: E402
import torch  # noqa: E402

# --- 1) tensorboard 垫片 ---------------------------------------------------
_fake_tb = types.ModuleType("torch.utils.tensorboard")


class _SummaryWriter:
    def __init__(self, *a, **k):
        pass

    def add_scalar(self, *a, **k):
        pass

    def add_audio(self, *a, **k):
        pass

    def add_text(self, *a, **k):
        pass

    def add_image(self, *a, **k):
        pass

    def flush(self):
        pass

    def close(self):
        pass


_fake_tb.SummaryWriter = _SummaryWriter
_fake_tb.__version__ = "2.20.0"
sys.modules["torch.utils.tensorboard"] = _fake_tb

# --- 2) matplotlib 垫片（bigvgan/utils.py 只在画图时用） -------------------
_mpl = types.ModuleType("matplotlib")
_mpl.use = lambda *a, **k: None
_mpl.__version__ = "3.9.0"
_py = types.ModuleType("matplotlib.pyplot")
_pyl = types.ModuleType("matplotlib.pylab")
for _m in (_py, _pyl):
    _m.subplots = _m.colorbar = _m.close = _m.figure = lambda *a, **k: None
_mpl.pyplot, _mpl.pylab = _py, _pyl
sys.modules["matplotlib"] = _mpl
sys.modules["matplotlib.pyplot"] = _py
sys.modules["matplotlib.pylab"] = _pyl


# --- 3) 训练框架里缺的包：白名单钩子 --------------------------------------
class _Dummy:
    def __init__(self, *a, **k):
        pass

    def __call__(self, *a, **k):
        return _Dummy()

    def __getattr__(self, item):
        return _Dummy()

    def __iter__(self):
        return iter(())

    def __getitem__(self, item):
        return _Dummy()


class _DummyModule(types.ModuleType):
    def __getattr__(self, item):
        if item.startswith("__") and item.endswith("__"):
            raise AttributeError(item)
        return _Dummy()


class _StubLoader:
    def __init__(self, name):
        self.name = name

    def create_module(self, spec):
        return _DummyModule(self.name)

    def exec_module(self, module):
        pass


class _StubFinder:
    @staticmethod
    def find_spec(fullname, path=None, target=None):
        root = fullname.split(".")[0]
        if root not in _STUB_PREFIXES or fullname in sys.modules:
            return None
        import importlib.machinery

        return importlib.machinery.ModuleSpec(fullname, _StubLoader(fullname))


def _missing(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is None
    except (ImportError, ValueError):
        return True


_STUB_PREFIXES = {n for n in {"randomname", "tensorboard", "tensorboardx", "wandb", "docstring_parser"} if _missing(n)}
sys.meta_path.insert(0, _StubFinder)

# --- 4) torch.load 兼容（>=2.6 默认 weights_only=True） -------------------
_orig_load = torch.load


def _load(*a, **k):
    k.setdefault("weights_only", False)
    return _orig_load(*a, **k)


torch.load = _load

# --- 5) whisper 在 CPU 上用 fp32，并指向本地权重 -------------------------
import transformers  # noqa: E402

MODELS = os.path.join(ROOT, ".tmp", "svcmodels")
WHISPER_DIR = os.path.join(MODELS, "whisper")
BIGVGAN_DIR = os.path.join(MODELS, "bigvgan")


def _find_one(pattern: str):
    from pathlib import Path

    hits = sorted(Path(ROOT).glob(pattern))
    return str(hits[0]) if hits else None


LOCAL_FILES = {
    "DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth": _find_one(
        "checkpoints/models--Plachta--Seed-VC/snapshots/*/DiT_seed_v2_uvit_whisper_base_f0_44k_*.pth"
    ),
    "config_dit_mel_seed_uvit_whisper_base_f0_44k.yml": _find_one(
        "checkpoints/models--Plachta--Seed-VC/snapshots/*/config_dit_mel_seed_uvit_whisper_base_f0_44k.yml"
    ),
    "rmvpe.pt": _find_one("checkpoints/models--lj1995--VoiceConversionWebUI/snapshots/*/rmvpe.pt"),
    "campplus_cn_common.bin": os.path.join(MODELS, "campplus_cn_common.bin"),
}

_orig_whisper_fp = transformers.WhisperModel.from_pretrained
_orig_fe_fp = transformers.AutoFeatureExtractor.from_pretrained


def _remap(name):
    if isinstance(name, str) and os.path.isdir(WHISPER_DIR) and "whisper" in name.lower():
        return WHISPER_DIR
    return name


def _whisper_fp(name=None, *a, **k):
    if not torch.cuda.is_available():
        k.pop("torch_dtype", None)
        k.pop("dtype", None)
    return _orig_whisper_fp(_remap(name), *a, **k)


def _fe_fp(name=None, *a, **k):
    return _orig_fe_fp(_remap(name), *a, **k)


transformers.WhisperModel.from_pretrained = _whisper_fp
transformers.AutoFeatureExtractor.from_pretrained = _fe_fp

import librosa  # noqa: E402
import torchaudio  # noqa: E402

import seed_vc.inference as svc  # noqa: E402


def _local_hf(repo_id, model_filename="pytorch_model.bin", config_filename=None):
    p = LOCAL_FILES.get(os.path.basename(model_filename))
    if p is None or not os.path.exists(p):
        raise FileNotFoundError(f"本地缺 {model_filename}（repo={repo_id}）")
    if config_filename is None:
        return p
    c = LOCAL_FILES.get(os.path.basename(config_filename))
    if c is None or not os.path.exists(c):
        raise FileNotFoundError(f"本地缺 {config_filename}（repo={repo_id}）")
    return p, c


svc.load_custom_model_from_hf = _local_hf

from seed_vc.modules.bigvgan import bigvgan as _bigvgan  # noqa: E402


def _bv_fp(model_id=None, *a, **k):
    if not os.path.isdir(BIGVGAN_DIR):
        return _bigvgan.BigVGAN.from_pretrained(model_id, *a, **k)
    k.pop("use_cuda_kernel", False)
    h = _bigvgan.load_hparams_from_json(os.path.join(BIGVGAN_DIR, "config.json"))
    model = _bigvgan.BigVGAN(h, use_cuda_kernel=False)
    ckpt = torch.load(os.path.join(BIGVGAN_DIR, "bigvgan_generator.pt"), map_location="cpu", weights_only=False)
    try:
        model.load_state_dict(ckpt["generator"])
    except RuntimeError:
        model.remove_weight_norm()
        model.load_state_dict(ckpt["generator"])
    return model


_bigvgan.BigVGAN.from_pretrained = _bv_fp

SR = 44100


class Engine:
    def __init__(self, threads: int = 8, steps: int = 25, cfg_rate: float = 1.2, f0: bool = True):
        torch.set_num_threads(threads)
        self.steps = steps
        self.cfg_rate = cfg_rate
        self.f0 = f0
        self.ns = types.SimpleNamespace(
            source="",
            target="",
            output="",
            diffusion_steps=steps,
            length_adjust=1.0,
            inference_cfg_rate=cfg_rate,
            f0_condition=f0,
            auto_f0_adjust=False,
            semi_tone_shift=0,
            checkpoint=None,
            config=None,
            fp16=False,
        )
        self.models = svc.load_models(self.ns)

    @torch.no_grad()
    def convert(self, source: np.ndarray, ref: np.ndarray) -> np.ndarray:
        model, semantic_fn, f0_fn, vocoder_fn, campplus_model, mel_fn, mel_fn_args = self.models
        sr = mel_fn_args["sampling_rate"]

        src = torch.tensor(source).unsqueeze(0).float()
        ref_t = torch.tensor(ref[: sr * 25]).unsqueeze(0).float()

        converted_16k = torchaudio.functional.resample(src, sr, 16000)
        ori_16k = torchaudio.functional.resample(ref_t, sr, 16000)

        chunks = []
        if converted_16k.size(-1) <= 16000 * 30:
            S_alt = semantic_fn(converted_16k)
        else:

            def _sem(waves):
                out = []
                step = 16000 * 25
                for i in range(0, waves.size(-1), step):
                    out.append(semantic_fn(waves[:, i : i + step]))
                return torch.cat(out, dim=1)

            S_alt = _sem(converted_16k)
        S_ori = semantic_fn(ori_16k)

        mel = mel_fn(src.to(svc.device).float())
        mel2 = mel_fn(ref_t.to(svc.device).float())
        target_lengths = torch.LongTensor([mel.size(2)]).to(mel.device)
        target2_lengths = torch.LongTensor([mel2.size(2)]).to(mel2.device)

        feat2 = torchaudio.compliance.kaldi.fbank(ori_16k, num_mel_bins=80, dither=0, sample_frequency=16000)
        feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
        style2 = campplus_model(feat2.unsqueeze(0))

        if self.f0:
            F0_ori = torch.from_numpy(f0_fn(ori_16k[0], thred=0.03)).to(svc.device)[None]
            F0_alt = torch.from_numpy(f0_fn(converted_16k[0], thred=0.03)).to(svc.device)[None]
            shifted = torch.exp(torch.log(F0_alt + 1e-5))
        else:
            F0_ori = F0_alt = shifted = None

        cond = model.length_regulator(S_alt, ylens=target_lengths, n_quantizers=3, f0=shifted)[0]
        prompt = model.length_regulator(S_ori, ylens=target2_lengths, n_quantizers=3, f0=F0_ori)[0]

        max_context = sr // 512 * 30
        max_source_window = max_context - mel2.size(2)
        overlap_frames, overlap_wave = 16, 16 * 512
        processed = 0
        previous = None
        gen = []

        while processed < cond.size(1):
            chunk = cond[:, processed : processed + max_source_window]
            is_last = processed + max_source_window >= cond.size(1)
            cat = torch.cat([prompt, chunk], dim=1)
            with torch.autocast(device_type=svc.device.type, dtype=torch.float32):
                vc = model.cfm.inference(
                    cat,
                    torch.LongTensor([cat.size(1)]).to(mel2.device),
                    mel2,
                    style2,
                    None,
                    self.steps,
                    inference_cfg_rate=self.cfg_rate,
                )
                vc = vc[:, :, mel2.size(-1) :]
            wave = vocoder_fn(vc.float()).squeeze()[None, :]
            if processed == 0:
                if is_last:
                    gen.append(wave[0].cpu().numpy())
                    break
                gen.append(wave[0, :-overlap_wave].cpu().numpy())
                previous = wave[0, -overlap_wave:]
                processed += vc.size(2) - overlap_frames
            elif is_last:
                gen.append(svc.crossfade(previous.cpu().numpy(), wave[0].cpu().numpy(), overlap_wave))
                processed += vc.size(2) - overlap_frames
                break
            else:
                gen.append(svc.crossfade(previous.cpu().numpy(), wave[0, :-overlap_wave].cpu().numpy(), overlap_wave))
                previous = wave[0, -overlap_wave:]
                processed += vc.size(2) - overlap_frames

        return np.concatenate(gen).astype(np.float32)
