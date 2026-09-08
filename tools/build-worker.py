#!/usr/bin/env python3
"""
Builds the two worker artefacts from their sources:

  server/worker/src/index.js      + server/website/index.html
        -> server/worker/src/index.js       (call page inlined into CALL_PAGE)
        -> server/worker/worker.paste.js    (same code, line comments only, paste-safe)

Run it after changing either file:

    python3 tools/build-worker.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'server' / 'worker' / 'src' / 'index.js'
PAGE = ROOT / 'server' / 'website' / 'index.html'
OUT = ROOT / 'server' / 'worker' / 'worker.paste.js'

HEADER = [
    "// ============================================================================",
    "// Vehicle Call Alert - wake-up worker (paste-safe version, line comments only)",
    "// Paste this WHOLE file into the Cloudflare editor after emptying it (Ctrl+A, Delete).",
    "// The last line must be: // END OF FILE - nothing may follow it.",
    "// ============================================================================",
]


def inline_page(source: str, page_html: str) -> str:
    """Puts the call page inside the CALL_PAGE template literal."""
    # Served from the worker itself, so the page always talks to the right server.
    page_html = re.sub(r"const WAKE_SERVER = '[^']*';",
                       "const WAKE_SERVER = location.origin;", page_html)
    escaped = (page_html.replace('\\', '\\\\')
                        .replace('`', '\\`')
                        .replace('${', '\\${'))
    pattern = re.compile(r'const CALL_PAGE = `.*?`;', re.S)
    if not pattern.search(source):
        sys.exit('CALL_PAGE marker not found in ' + str(SRC))
    return pattern.sub(lambda _: 'const CALL_PAGE = `' + escaped + '`;', source, count=1)


def to_line_comments(source: str) -> str:
    """The Cloudflare dashboard editor mangles block comments on paste - drop them."""
    out = []
    in_block = False
    in_template = False
    for line in source.split('\n'):
        # Never touch anything inside the inlined HTML template literal.
        if line.startswith('const CALL_PAGE = `'):
            in_template = True
        if in_template:
            out.append(line.rstrip())
            if line.rstrip().endswith('`;'):
                in_template = False
            continue

        stripped = line.strip()
        if not in_block and stripped.startswith('/*'):
            in_block = not stripped.endswith('*/')
            body = stripped[2:]
            if body.endswith('*/'):
                body = body[:-2]
            out.append(('// ' + body.strip()).rstrip())
            continue
        if in_block:
            body = stripped
            if body.endswith('*/'):
                in_block = False
                body = body[:-2]
            if body.startswith('*'):
                body = body[1:]
            out.append(('// ' + body.strip()).rstrip())
            continue
        if '/*' in line and '*/' in line:
            line = re.sub(r'/\*.*?\*/', '', line)
        out.append(line.rstrip())
    return '\n'.join(out)


def main() -> None:
    source = inline_page(SRC.read_text(), PAGE.read_text())
    SRC.write_text(source)

    paste = '\n'.join(HEADER + [to_line_comments(source)]).rstrip() + '\n// END OF FILE\n'
    paste = paste.replace('\u2014', '-').replace('\u2019', "'").replace('\u2026', '...')
    OUT.write_text(paste)
    print('wrote {} ({} lines) and {} ({} lines)'.format(
        SRC.relative_to(ROOT), len(source.split('\n')),
        OUT.relative_to(ROOT), len(paste.split('\n'))))


if __name__ == '__main__':
    main()
