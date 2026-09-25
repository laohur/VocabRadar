"""日志初始化（plan-backend §5.4）：纯标准库，双通道。

- 控制台 stderr：INFO 起，终端即时可见
- 文件 backend/logs/backend.log：UTF-8，2MB × 5 轮转（RotatingFileHandler）
- werkzeug 访问日志收敛到 WARNING：扩展每秒轮询 /api/health，不收敛则刷屏

单写者原则：只有常驻 app 进程写 backend.log（setup() 由 app.py main() 调用）。
install.py 等独立进程 CLI 保持 print——与常驻进程并发轮转同一文件
在 Windows 有撞锁风险。setup() 幂等，重复调用不重复挂 handler。
"""

import logging
import os
from logging.handlers import RotatingFileHandler

_LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "logs")
_FMT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATEFMT = "%m-%d %H:%M:%S"


def setup():
    """根 logger 挂 stderr + 滚动文件双 handler（幂等）。"""
    root = logging.getLogger()
    if getattr(root, "_vocabradar_logs_ready", False):
        return
    root.setLevel(logging.INFO)
    fmt = logging.Formatter(_FMT, datefmt=_DATEFMT)

    console = logging.StreamHandler()  # 默认 stderr
    console.setFormatter(fmt)
    root.addHandler(console)

    os.makedirs(_LOG_DIR, exist_ok=True)
    file_handler = RotatingFileHandler(os.path.join(_LOG_DIR, "backend.log"),
                                       maxBytes=2 * 1024 * 1024, backupCount=5,
                                       encoding="utf-8")
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    root._vocabradar_logs_ready = True


def log_path():
    """backend.log 当前文件路径（api 层展示用）。"""
    return os.path.join(_LOG_DIR, "backend.log")


def tail(n=200):
    """读 backend.log 末尾 n 行（管理页日志卡片用）；文件缺失返回空列表。"""
    try:
        with open(log_path(), "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    return [l.rstrip("\n") for l in lines[-max(1, min(n, 2000)):]]
