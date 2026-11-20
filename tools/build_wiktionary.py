"""Build Panna's optional Wiktionary dictionary pack from kaikki.org's English Wiktionary extract.

    curl -LO https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz
    python3 tools/build_wiktionary.py kaikki.org-dictionary-English.jsonl.gz panna-wiktionary-en.zip

The pack is a zip (deflate) of JSON shards keyed by the first three letters of the word, plus info.json and
LICENSE.txt. Panna downloads it on request (Settings > Dictionary) and reads one shard per lookup.

An entry is { pos: [sense, ...], "_": "/ipa/" } where pos is n, v, a, r (noun, verb, adjective, adverb, as in the
built-in WordNet) or a longer code (pron, prep, conj, det, intj, article, num, particle, prefix, suffix, phrase,
contraction, name, abbrev, ...), and a sense is [gloss, [example], [synonyms], "form-of target"] with empty tails
left off. Regular inflections that Panna's lookup already strips (cats, walked, faster) are left out; irregular
ones (spake, thee, mice) stay, pointing to their base word.

Wiktionary text is available under CC BY-SA 4.0 and the GFDL; the pack carries that notice.
"""
import gzip, json, os, re, sys, tempfile, unicodedata, zipfile, datetime, collections

SRC, OUT = sys.argv[1], sys.argv[2]
POS = {'noun': 'n', 'verb': 'v', 'adj': 'a', 'adv': 'r'}
SKIP_POS = {'punct', 'character', 'romanization', 'symbol', 'unknown'}
MAX_SENSES, MAX_NAME_SENSES = 10, 3

# Panna's own stemming (www/app.js Dict.lookup): a form these rules turn into its target needs no entry of its own.
RULES = [('ies', 'y'), ('ches', 'ch'), ('shes', 'sh'), ('ses', 's'), ('xes', 'x'), ('zes', 'z'), ('men', 'man'), ('es', 'e'),
         ('es', ''), ('s', ''), ('ied', 'y'), ('ed', 'e'), ('ed', ''), ('ing', 'e'), ('ing', ''), ('ier', 'y'), ('iest', 'y'),
         ('er', 'e'), ('er', ''), ('est', 'e'), ('est', ''), ('ily', 'y'), ('ly', '')]
def stems(w):
    out = set()
    for suf, rp in RULES:
        if w.endswith(suf) and len(w) > len(suf) + 1:
            b = w[:-len(suf)] + rp; out.add(b)
            if not rp and re.search(r'(ed|ing|er|est)$', suf) and re.search(r'([bdfgklmnprtvz])\1$', b): out.add(b[:-1])
    return out

def norm(w):
    return unicodedata.normalize('NFKC', w).lower().replace('’', "'").replace('‘', "'").strip()

def key(w):  # first three characters, letters only, '_' otherwise (Panna computes the same)
    return ''.join(c if 'a' <= c <= 'z' else '_' for c in (w + '__')[:3])

def one_line(s, n):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return s if len(s) <= n else ''

def senses_of(rec):
    out, all_forms, targets = [], True, []
    for s in rec.get('senses') or []:
        gls = s.get('glosses') or []
        gl = (s.get('raw_glosses') or gls or [None])[-1]
        if not gl or 'no-gloss' in (s.get('tags') or []): continue
        # a sub-sense ("With dative effect…") needs its parent ("Third-person singular masculine…") to make sense
        if len(gls) > 1 and gls[0] and gls[0] not in gl: gl = gls[0].rstrip(' .:;') + ': ' + gl
        gl = re.sub(r'\s+', ' ', gl).strip()
        ex = next((one_line(e.get('text'), 160) for e in s.get('examples') or [] if e.get('type') == 'example' and one_line(e.get('text'), 160)), '')
        syn = [x['word'] for x in (s.get('synonyms') or []) if x.get('word')][:4]
        tgt = ((s.get('form_of') or s.get('alt_of') or [{}])[0]).get('word', '')
        tags = s.get('tags') or []
        if not (tgt and ('form-of' in tags or 'alt-of' in tags)): all_forms = False
        if tgt: targets.append(norm(tgt))
        sn = [gl, [ex] if ex else [], syn, tgt]
        while sn and not sn[-1]: sn.pop()
        out.append(sn)
    return out, all_forms, targets

def main():
    tmp = tempfile.mkdtemp(prefix='wikt-')
    buckets = {}
    def bucket(c):
        if c not in buckets: buckets[c] = open(os.path.join(tmp, c + '.jsonl'), 'w', encoding='utf-8')
        return buckets[c]
    n = kept = regular = 0
    opener = gzip.open if SRC.endswith('.gz') else open
    with opener(SRC, 'rt', encoding='utf-8') as f:
        for line in f:
            n += 1
            if n % 200000 == 0: print(f'  read {n:,} entries, kept {kept:,}', flush=True)
            rec = json.loads(line)
            if rec.get('lang_code') not in (None, 'en'): continue
            pos = rec.get('pos') or ''
            if pos in SKIP_POS: continue
            w = norm(rec.get('word') or '')
            if not w or len(w) > 40 or w.count(' ') > 2: continue
            sn, all_forms, targets = senses_of(rec)
            if not sn: continue
            if all_forms and targets and all(t in stems(w) for t in targets):
                regular += 1; continue  # cats → cat: Panna finds the base word itself
            ipa = next((x['ipa'] for x in rec.get('sounds') or [] if x.get('ipa')), '')
            kept += 1
            bucket(key(w)[0]).write(json.dumps([w, POS.get(pos, pos), sn, ipa], ensure_ascii=False) + '\n')
    for b in buckets.values(): b.close()
    print(f'read {n:,} entries; kept {kept:,}; left {regular:,} regular inflections to the stemmer', flush=True)

    words = 0
    shard_sizes = []
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for c in sorted(buckets):
            shards = collections.defaultdict(dict)
            for line in open(os.path.join(tmp, c + '.jsonl'), encoding='utf-8'):
                w, p, sn, ipa = json.loads(line)
                e = shards[key(w)].setdefault(w, {})
                cap = MAX_NAME_SENSES if p == 'name' else MAX_SENSES
                have = e.setdefault(p, [])
                for s in sn:
                    if len(have) < cap and s not in have: have.append(s)
                if ipa and '_' not in e: e['_'] = ipa
            for k in sorted(shards):
                data = json.dumps(shards[k], ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                shard_sizes.append(len(data)); words += len(shards[k])
                z.writestr(f'{k}.json', data)
            os.remove(os.path.join(tmp, c + '.jsonl'))
        src_date = datetime.datetime.fromtimestamp(os.path.getmtime(SRC), datetime.timezone.utc).date().isoformat()
        info = {'format': 'panna-dict', 'version': 1, 'id': 'wiktionary-en', 'name': 'Wiktionary (English)',
                'source': 'English Wiktionary, via the kaikki.org extract (wiktextract)', 'sourceDate': src_date,
                'built': datetime.date.today().isoformat(), 'words': words, 'keyLength': 3,
                'licence': 'CC BY-SA 4.0 and GFDL', 'url': 'https://en.wiktionary.org/'}
        z.writestr('info.json', json.dumps(info, indent=1))
        z.writestr('LICENSE.txt', (
            'Definitions, examples and pronunciations in this pack come from English Wiktionary\n'
            '(https://en.wiktionary.org/), written by its contributors, as extracted by kaikki.org\n'
            '(https://kaikki.org/, Tatu Ylonen, "Wiktextract", LREC 2022).\n\n'
            'Wiktionary text is available under the Creative Commons Attribution-ShareAlike 4.0 licence\n'
            '(https://creativecommons.org/licenses/by-sa/4.0/) and the GNU Free Documentation Licence.\n'
            'This pack is a shortened adaptation (selected senses, one example, a few synonyms) and is\n'
            'shared under the same CC BY-SA 4.0 licence.\n'))
    os.rmdir(tmp)
    shard_sizes.sort()
    print(f'{words:,} words in {len(shard_sizes):,} shards; largest shard {shard_sizes[-1] / 1e6:.1f} MB, '
          f'median {shard_sizes[len(shard_sizes) // 2] / 1e3:.0f} kB; pack {os.path.getsize(OUT) / 1048576:.1f} MB')

main()
