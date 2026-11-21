#!/usr/bin/env python3
"""Build offline word tables from the pinned source files listed in src/data/NOTICE.md."""

import gzip
import hashlib
import json
import re
import sys
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path


DATA = Path(__file__).resolve().parents[1] / 'src' / 'data'
HANJA_SHA256 = 'b1004034589f1357daaea3534a6136f6b5ef825afa8779886b20f0b7908bbe3b'
KRDICT_SHA256 = '347fe2d225ff2adb48e4ca04fc7ad2004ff4b051b16925b3f43f4d8ce9584adc'
HANGUL = re.compile(r'[가-힣]{1,16}')
JA_FORM = re.compile(r'([\u3041-\u30faー\u3400-\u9fff]{2,24})(?:【([\u3041-\u30faー\u3400-\u9fff]{2,24})】)?')
KANJI = re.compile(r'[\u3400-\u9fff]')
KANA = re.compile(r'[\u3041-\u30fa]')
LEVEL = {'초급': 0, '중급': 1, '고급': 2}


def verify(path, expected):
    with path.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != expected:
            raise SystemExit(f'Wrong source snapshot: {path.name}')


def nodes(value):
    return value if isinstance(value, list) else [value] if isinstance(value, dict) else []


def features(node):
    return {x['att']: x['val'] for x in nodes(node.get('feat'))}


HANGUL_START = 0xAC00
FINAL_COUNT = 28
INITIAL_BLOCK = 21 * FINAL_COUNT
Y_VOWELS = {2, 6, 7, 12, 17, 20}
R_VOWELS = {0, 1, 8, 11, 13, 18}


def korean_reading(raw):
    """Apply word-initial dueum here so the runtime only splits rows."""
    out = []
    for at, syllable in enumerate(raw):
        code = ord(syllable) - HANGUL_START
        if at == 0:
            onset, vowel = divmod(code, INITIAL_BLOCK)[0], code // FINAL_COUNT % 21
            if onset in (2, 5) and vowel in Y_VOWELS:
                syllable = chr(ord(syllable) + (11 - onset) * INITIAL_BLOCK)
            elif onset == 5 and vowel in R_VOWELS:
                syllable = chr(ord(syllable) + (2 - onset) * INITIAL_BLOCK)
        elif syllable in ('렬', '률') and code >= 0:
            if (ord(raw[at - 1]) - HANGUL_START) % FINAL_COUNT in (0, 4):
                syllable = '열' if syllable == '렬' else '율'
        out.append(syllable)
    return ''.join(out)


def hanja_rows(path):
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.startswith('#'):
            continue
        reading, _, rest = line.partition(':')
        source = unicodedata.normalize('NFKC', rest.partition(':')[0])
        if not (2 <= len(source) == len(reading) and HANGUL.fullmatch(reading)):
            continue
        if all(unicodedata.name(char, '').startswith('CJK UNIFIED IDEOGRAPH-') for char in source):
            yield korean_reading(unicodedata.normalize('NFKC', reading)), source


def japanese_rows(path):
    scores = defaultdict(dict)
    # A kana string that also translates a Korean adverb is ambiguous as a heading:
    # むしろ is a straw mat (자리) in one entry and "rather" in another.
    adverbs = set()
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            if not member.filename.endswith('.json'):
                continue
            with archive.open(member) as source:
                entries = json.load(source)['LexicalResource']['Lexicon']['LexicalEntry']
            for entry in entries:
                tags = features(entry)
                if tags.get('partOfSpeech') not in {'명사', '의존 명사', '부사', '감탄사'}:
                    continue
                ko = next((features(lemma).get('writtenForm', '') for lemma in nodes(entry.get('Lemma'))), '')
                if not HANGUL.fullmatch(ko):
                    continue
                level = LEVEL.get(tags.get('vocabularyLevel'), 3)
                for sense in nodes(entry.get('Sense')):
                    for equivalent in nodes(sense.get('Equivalent')):
                        terms = features(equivalent)
                        if terms.get('language') != '일본어':
                            continue
                        for position, term in enumerate(re.split(r'[。;；\t]', terms.get('lemma', ''))):
                            match = JA_FORM.fullmatch(term.strip())
                            if not match:
                                continue
                            kana, kanji_form = match.groups()
                            # Text before 【】 is the reading of the bracketed kanji word, not
                            # a heading of its own; ようやく【要約】 must not become 요약.
                            form = kanji_form or kana
                            if not KANA.search(form):
                                continue
                            if tags.get('partOfSpeech') in {'부사', '감탄사'}:
                                adverbs.update({form, kana, kanji_form} - {None})
                                continue
                            # The first equivalent and common headwords outrank synonyms.
                            score = (position != 0, level, position)
                            scores[form][ko] = min(score, scores[form].get(ko, score))
            del entries
    tied = 0
    for source, candidates in scores.items():
        if source in adverbs:
            continue
        strongest = min(candidates.values())
        winners = [ko for ko, score in candidates.items() if score == strongest]
        if len(winners) == 1:
            yield source, winners[0]
        else:
            tied += 1
    print(f'Japanese headings excluded by tied evidence: {tied}')


def write_table(name, rows):
    table = sorted(set(rows))
    if not table:
        raise SystemExit(f'Empty table: {name}')
    text = ''.join(f'{left}\t{right}\n' for left, right in table)
    output = DATA / name
    output.write_bytes(gzip.compress(text.encode(), compresslevel=9, mtime=0))
    print(f'{name}: {len(table)} rows, {output.stat().st_size} bytes')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python3 scripts/build-lexicons.py HANJA_TXT KRDICT_JSON_ZIP')
    hanja, krdict = map(Path, sys.argv[1:])
    verify(hanja, HANJA_SHA256)
    verify(krdict, KRDICT_SHA256)
    DATA.mkdir(parents=True, exist_ok=True)
    write_table('hanja.tsv.gz', hanja_rows(hanja))
    write_table('japanese-headings.tsv.gz', japanese_rows(krdict))
