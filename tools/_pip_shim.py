#!/usr/bin/env python3
"""在受限沙箱里运行 pip 的垫片。

问题：某些沙箱实现下，用 `os.mkdir(path, 0o700)` 创建的目录后续无法写入，
而 Python 的 `tempfile.mkdtemp()` 恰好用 0o700。pip 整个安装流程都建在临时目录上，
于是必然失败，报 `[Errno 13] Permission denied: ...whl.metadata`。

做法：把 os.mkdir 的 mode 一律改成 0o777，再以模块方式执行 pip。

这不是给最终用户用的——正常环境直接 `pip install` 即可。
用法：
    python tools/_pip_shim.py install --target .pylibs faster-whisper
"""

from __future__ import annotations

import os
import runpy
import sys

_real_mkdir = os.mkdir


def _mkdir(path, mode=0o777, *args, **kwargs):  # noqa: ANN001, ANN201
    return _real_mkdir(path, 0o777, *args, **kwargs)


os.mkdir = _mkdir

sys.argv = ["pip"] + sys.argv[1:]
runpy.run_module("pip", run_name="__main__")
