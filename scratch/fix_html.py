# Python script to fix HTML file bytes encoding-safely
path = r"d:\antigravity\biorivet-tools\public\BioRivet_Diagnostic_Tool_v2 (1).html"

with open(path, "rb") as f:
    content = f.read()

# 1. Replace the syntax error line
target1 = b'}\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\r\n'
replace1 = b'}\r\n// \xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\r\n'

if target1 in content:
    content = content.replace(target1, replace1)
    print("Replacement 1 successful!")
else:
    print("Replacement 1 target NOT found in file.")

# 2. Replace the generateReport function to unlock step 3 navigation
# Let's normalize newlines in search/replace to be robust
js_target = """function generateReport() {
  if(!QP||!SA) { alert('Please upload both question paper and student answers first.'); return; }
  RPT = computeReport();
  renderSummaryCards();
  renderSecA();
  renderSecB('name');
  renderSecC();
  renderSecD();
  gotoStep(3);
}""".encode('utf-8')

js_replace = """function generateReport() {
  if(!QP||!SA) { alert('Please upload both question paper and student answers first.'); return; }
  RPT = computeReport();
  renderSummaryCards();
  renderSecA();
  renderSecB('name');
  renderSecC();
  renderSecD();
  const step3Nav = document.getElementById('step3-nav');
  if (step3Nav) {
    step3Nav.classList.remove('locked');
  }
  gotoStep(3);
}""".encode('utf-8')

# Handle CRLF vs LF in binary content
if js_target in content:
    content = content.replace(js_target, js_replace)
    print("Replacement 2 (LF) successful!")
elif js_target.replace(b'\n', b'\r\n') in content:
    content = content.replace(js_target.replace(b'\n', b'\r\n'), js_replace.replace(b'\n', b'\r\n'))
    print("Replacement 2 (CRLF) successful!")
else:
    print("Replacement 2 target NOT found in file.")

# Write back
with open(path, "wb") as f:
    f.write(content)

# Scan again for validation
print("Re-scanning for decode errors...")
with open(path, "rb") as f:
    lines = f.readlines()

errors_found = 0
for idx, line in enumerate(lines):
    try:
        line.decode("utf-8")
    except UnicodeDecodeError as e:
        print(f"Line {idx+1} decode error: {e}")
        errors_found += 1

if errors_found == 0:
    print("Success! No decode errors found. File is valid UTF-8.")
else:
    print(f"Failed! {errors_found} decode errors remain.")
