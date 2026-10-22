"""
Renumbers a manual source (docs/manual/manual*.html) from its headings: part labels, chapter numbers, the table
of contents, the "chapter N" links and the figure numbers. Works for every language.

    python docs/manual/renumber.py docs/manual/manual.it.html
"""
import re
import sys

CHAPTER_WORDS = r'(chapter|capitolo|Kapitel|chapitre|capítulo)'
FIGURE_WORDS = r'(Figure|Figura|Abbildung)'

for path in sys.argv[1:]:
    s = open(path, encoding='utf-8').read()

    opener = r'<section class="page part" id="([^"]+)">\s*<div class="opener[^"]*"><div class="label">([^<\d]+) [0-9]+</div><h1>([^<]+)</h1>'
    tokens = list(re.finditer(opener + r'|<h2 id="([^"]+)"[^>]*>\d+ · ([^<]+)</h2>', s))
    parts = []  # (id, word, title, [(chapter id, title, n)])
    chapter_no = {}
    n = 0
    for m in tokens:
        if m.group(1):
            parts.append((m.group(1), m.group(2), m.group(3), []))
        else:
            n += 1
            chapter_no[m.group(4)] = n
            parts[-1][3].append((m.group(4), m.group(5), n))
    part_no = {pid: i + 1 for i, (pid, _, _, _) in enumerate(parts)}

    s = re.sub(r'(<section class="page part" id="([^"]+)">\s*<div class="opener[^"]*"><div class="label">[^<\d]+ )[0-9]+(</div>)',
               lambda m: f'{m.group(1)}{part_no[m.group(2)]}{m.group(3)}', s)
    s = re.sub(r'<h2 id="([^"]+)"([^>]*)>\d+ · ',
               lambda m: f'<h2 id="{m.group(1)}"{m.group(2)}>{chapter_no[m.group(1)]} · ', s)
    s = re.sub(r'<a href="#([^"]+)">' + CHAPTER_WORDS + r' \d+</a>',
               lambda m: f'<a href="#{m.group(1)}">{m.group(2)} {chapter_no[m.group(1)]}</a>'
               if m.group(1) in chapter_no else m.group(0), s)

    # table of contents: the first list of the contents page
    lines = []
    for pid, word, title, chapters in parts:
        lines.append(f'    <li><a href="#{pid}">{word} {part_no[pid]} — {title}</a>')
        lines.append('      <ol>')
        for cid, ctitle, cn in chapters:
            lines.append(f'        <li><a href="#{cid}"><span class="num">{cn}</span>{ctitle}</a></li>')
        lines.append('      </ol>')
        lines.append('    </li>')
    toc = s.index('<section class="page toc">')
    start = s.index('<ol>\n', toc) + len('<ol>\n')
    end = s.index('  </ol>\n  <div class="box', start)
    s = s[:start] + '\n'.join(lines) + '\n' + s[end:]

    counter = iter(range(1, 1000))
    s = re.sub(r'<b>' + FIGURE_WORDS + r' \d+</b>', lambda m: f'<b>{m.group(1)} {next(counter)}</b>', s)

    open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print(f'{path}: {len(parts)} parts, {n} chapters')
