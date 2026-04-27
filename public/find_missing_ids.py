
import re
import os

html_path = 'f:/Produzione/MaeSkimmer/public/index.html'
js_path = 'f:/Produzione/MaeSkimmer/public/script.js'

if not os.path.exists(html_path) or not os.path.exists(js_path):
    print("Error: Files not found")
else:
    with open(html_path, 'r', encoding='utf-8') as f:
        html_content = f.read()
    with open(js_path, 'r', encoding='utf-8') as f:
        js_content = f.read()

    # Find IDs in HTML
    html_ids = set(re.findall(r'id="([^"]*)"', html_content))

    # Find IDs referenced in JS via getElementById
    js_ids = set(re.findall(r"getElementById\('([^']*)'\)", js_content))
    # Also find querySelector with ID
    js_ids.update(re.findall(r"querySelector\('#([^']*)'\)", js_content))

    missing_ids = js_ids - html_ids

    if missing_ids:
        print("Missing IDs referenced in JS but not in HTML:")
        for id in sorted(missing_ids):
            print(f"  - {id}")
    else:
        print("No missing IDs found.")
