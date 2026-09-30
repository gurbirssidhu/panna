"""Build the offline dictionary (www/vendor/dict) from WordNet 3.1.

Needs: npm (for the WordNet packages). Run from the repository root:
    python3 tools/build_dict.py
Output: 550 JSON shards keyed by the first two letters, plus exc.json (irregular forms).
"""
import collections, json, os, re, subprocess, tarfile, tempfile

OUT = 'www/vendor/dict/'
tmp = tempfile.mkdtemp()
for pkg in ['wordnet-db@3.1.14', 'wndb-with-exceptions@3.0.2']:
    name = subprocess.check_output(['npm', 'pack', pkg], cwd=tmp, text=True).strip().splitlines()[-1]
    d = os.path.join(tmp, pkg.split('@')[0]); os.makedirs(d, exist_ok=True)
    tarfile.open(os.path.join(tmp, name)).extractall(d)
D = os.path.join(tmp, 'wordnet-db/package/dict/')
EXC = os.path.join(tmp, 'wndb-with-exceptions/package/data/')
POS = {'noun': 'n', 'verb': 'v', 'adj': 'a', 'adv': 'r'}

syn = {}
for f, p in POS.items():
    for line in open(D + 'data.' + f, encoding='utf-8', errors='replace'):
        if line.startswith(' '): continue
        head, _, gloss = line.partition('|'); t = head.split()
        words = [re.sub(r'\(.*?\)$', '', t[4 + 2 * i]).replace('_', ' ') for i in range(int(t[3], 16))]
        syn[(p, t[0])] = (words, gloss.strip())
entries = collections.defaultdict(dict)
for f, p in POS.items():
    for line in open(D + 'index.' + f, encoding='utf-8', errors='replace'):
        if line.startswith(' '): continue
        t = line.split(); lemma = t[0].replace('_', ' '); offs = t[-int(t[2]):]
        senses = []
        for o in offs:
            words, gloss = syn[(p, o)]
            parts = [x.strip() for x in re.split(r';\s*(?=")', gloss)]
            d = parts[0].rstrip(';').strip()
            ex = [x.strip('"').strip() for x in parts[1:] if x.startswith('"')][:2]
            others = [w for w in words if w.lower() != lemma.lower()][:5]
            s = [d]
            if ex or others: s.append(ex)
            if others: s.append(others)
            senses.append(s)
        entries[lemma][p] = senses
def key(w):
    a = w[0] if w[0].isalpha() and w[0].isascii() else '_'
    b = w[1] if len(w) > 1 and w[1].isalpha() and w[1].isascii() else '_'
    return (a + b).lower()
shards = collections.defaultdict(dict)
for w, e in entries.items(): shards[key(w)][w] = e
os.makedirs(OUT, exist_ok=True)
for k, v in shards.items(): json.dump(v, open(OUT + k + '.json', 'w'), ensure_ascii=False, separators=(',', ':'))
exc = {}
for f in POS:
    for line in open(EXC + f + '.exc'):
        t = line.split()
        if len(t) < 2: continue
        k = t[0].replace('_', ' '); exc.setdefault(k, [])
        for b in t[1:]:
            b = b.replace('_', ' ')
            if b not in exc[k]: exc[k].append(b)
json.dump(exc, open(OUT + 'exc.json', 'w'), separators=(',', ':'))
print('lemmas', len(entries), 'shards', len(shards), 'irregular forms', len(exc))
