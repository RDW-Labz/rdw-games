import sys, re
x = open(sys.argv[1]).read()
for m in re.finditer(r'text="([^"]*)"[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"', x):
    t = m.group(1)
    if t.strip():
        nums = re.findall(r"\d+", m.group(2))
        cx = (int(nums[0]) + int(nums[2])) // 2
        cy = (int(nums[1]) + int(nums[3])) // 2
        print(f"{t}\t{cx}\t{cy}")
