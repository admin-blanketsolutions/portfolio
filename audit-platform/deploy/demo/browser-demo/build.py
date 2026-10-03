#!/usr/bin/env python3
"""Builds the single-file browser demo (audit-demo.html) from demo.src.html,
embedding the demo firm's chart of accounts (../seed/demo.sql) and the sample
trial balances (../sample-tbs/make_samples.py), so the page always matches
the hosted demo's data. Standard library only:

    python3 build.py
"""
import ast
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent


def chart():
    sql = (DEMO / 'seed' / 'demo.sql').read_text(encoding='utf-8')
    rows = re.findall(r"\('([^']*)', '([^']*)', '((?:[^']|'')*)', '([^']*)', '(\w+)', '(\w+)', '(BS|IS)', '\w+', (true|false)\)", sql)
    out = [[code, path, en.replace("''", "'"), ar, cls, nb[0]] for code, path, en, ar, cls, nb, _fs, _post in rows]
    postable = sum(1 for r in rows if r[7] == 'true')
    assert postable == 87, f'expected 87 postable accounts, found {postable}'
    return out


def samples():
    src = (DEMO / 'sample-tbs' / 'make_samples.py').read_text(encoding='utf-8')
    calls = re.finditer(r"write\('([^']+)',\s*'([^']+)',\s*\n?\s*(\[[^\]]*\]),\s*\[(.*?)\n\](?:, rtl=True)?, "
                        r"balance_line=\(('[^']*'), ('[^']*')\)\)", src, re.S)
    out = {}
    for key, m in zip(['nakheel', 'petra', 'zahran', 'security'], calls):
        rows = ast.literal_eval('[' + m.group(4) + ']')
        out[key] = {'file': m.group(1), 'title': m.group(2), 'headers': ast.literal_eval(m.group(3)),
                    'rows': [[r[0], r[1], r[2] or 0, r[3] or 0] for r in rows],
                    'balance': [ast.literal_eval(m.group(5)), ast.literal_eval(m.group(6))]}
    assert len(out) == 4, f'expected 4 sample trial balances, found {len(out)}'
    return out


def main():
    dump = lambda v: json.dumps(v, ensure_ascii=False, separators=(',', ':'))
    page = (HERE / 'demo.src.html').read_text(encoding='utf-8')
    page = page.replace('__COA__', dump(chart())).replace('__SAMPLES__', dump(samples()))
    (HERE / 'audit-demo.html').write_text(page, encoding='utf-8')
    print(f'audit-demo.html: {len(page.encode()):,} bytes')


if __name__ == '__main__':
    main()
