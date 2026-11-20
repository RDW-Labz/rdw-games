import ast, subprocess, sys

def draw(b):
    W, H = b['w'], b['h']; L = b['loop']; cl = b['clues']
    hrow = L[:(H + 1) * W]; vrow = L[(H + 1) * W:]
    h = lambda x, y: hrow[y * W + x] == '1'
    v = lambda x, y: vrow[y * (W + 1) + x] == '1'
    out = []
    for y in range(H + 1):
        top = ''.join('o' + ('---' if h(x, y) else '   ') for x in range(W)) + 'o'
        out.append(top)
        if y < H:
            mid = ''
            for x in range(W + 1):
                mid += '|' if v(x, y) else ' '
                if x < W:
                    c = cl[y * W + x]
                    mid += (' %s ' % c) if c != '.' else ' . '
            out.append(mid)
    return '\n'.join(out)

for a in sys.argv[1:]:
    r = subprocess.run(['python3', 'scripts/slitherlink-gen.py'] + a.split(),
                       cwd='/home/cluer/cloned-free-games', capture_output=True, text=True)
    if r.returncode:
        print(a, 'FAILED', r.stderr); continue
    b = ast.literal_eval(r.stdout)
    print('%s x %s  loop=%d expect=%d  clues=%s' % (b['w'], b['h'], len(b['loop']),
          (b['h'] + 1) * b['w'] + b['h'] * (b['w'] + 1), b['clues']))
    print(draw(b)); print()
