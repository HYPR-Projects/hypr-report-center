"""Coloca o diretório `backend/` no sys.path pra os testes importarem os
módulos (`sheets_integration`, `sheets_alerts`, ...) sem precisar de pacote."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
