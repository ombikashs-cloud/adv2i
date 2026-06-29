import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

path = r"d:\antigravity\biorivet-tools\public\BioRivet_Diagnostic_Tool_v2 (1).html"
with open(path, "r", encoding="utf-8", errors="ignore") as f:
    lines = f.readlines()

print("".join(lines[410:450]))
