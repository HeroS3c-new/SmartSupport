
content = open('f:/Produzione/MaeSkimmer/public/script.js', 'r', encoding='utf-8').read()
stack = []
for i, char in enumerate(content):
    if char == '{':
        stack.append(i)
    elif char == '}':
        if not stack:
            print(f"Extra closing brace at position {i}")
        else:
            stack.pop()

if stack:
    print(f"Unclosed opening braces at positions: {stack}")
else:
    print("Braces are balanced (only checking {} )")
