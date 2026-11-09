"""Compatibility shim for bridge/collector.py pointing to server/collector.py"""
import importlib.util
from pathlib import Path
import sys

_target = Path(__file__).resolve().parents[1] / 'server' / 'collector.py'
_spec = importlib.util.spec_from_file_location('_server_collector', _target)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

for _k, _v in _mod.__dict__.items():
    globals()[_k] = _v

if __name__ == '__main__':
    sys.exit(_mod.main())
