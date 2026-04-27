
import re
from collections import Counter
import os

html_path = 'f:/Produzione/MaeSkimmer/public/index.html'
if not os.path.exists(html_path):
    print(f"Error: {html_path} not found")
else:
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()

    ids = re.findall(r'id="([^"]*)"', content)
    counts = Counter(ids)
    duplicates = {id: count for id, count in counts.items() if count > 1}

    if duplicates:
        print("Duplicate IDs found:")
        for id, count in duplicates.items():
            print(f"  {id}: {count}")
    else:
        print("No duplicate IDs found.")
