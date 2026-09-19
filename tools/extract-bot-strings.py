"""Extract the bot's user-facing strings, or rewrite them into T() calls.

    python tools/extract-bot-strings.py extract   -> writes bot/lang/strings.json
    python tools/extract-bot-strings.py wrap      -> rewrites bot/bot.py in place

Why AST rather than find-and-replace: the same words appear as dict keys, API
parameter names and status codes as well as as visible text. Positions from the
parser let us touch exactly the literals we chose and nothing else.
"""
import ast
import io
import json
import os
import re
import sys

BOT = "bot/bot.py"
OUT = "bot/lang/strings.json"

# Contexts whose strings are machinery, never shown to a person.
# ValueError text is returned to the website as the JSON "error" field, so it
# is an API contract, not copy. Translating it changes what the browser sees.
SKIP_CALLS = {"ValueError", "api", "get", "setdefault", "environ", "getenv", "join", "split",
              "startswith", "endswith", "strip", "replace", "encode", "decode",
              "sub", "match", "fullmatch", "search", "compile", "findall",
              "open", "makedirs", "exists", "dirname", "basename", "format",
              "send_header", "send_response", "send_error"}

# Constants whose members are DATA, not labels: they are written into job and
# client records and matched by the website. "Agriculture & Food" is a category
# the jobs page filters on; "Germany - Work Visa (Type D)" is stored as a
# client's route and shown by /status. Translating any of these silently breaks
# the filters and corrupts existing records, so they stay in English no matter
# what language the interface is in.
DATA_NAMES = {
    "JOB_CATEGORIES", "JOB_TYPES", "NATIONALITIES", "ROUTES", "REGIONS",
    "EDUCATION", "MARITAL", "GENDERS", "STATUSES", "ALPHABET", "APP_FIELDS",
    "COUNTRIES", "CURRENCIES",
}

# Exact strings that look like copy but are keys or protocol values.
DENY = {
    # Country and region names are written into records and matched by the
    # website's filters; callback prefixes are matched by the bot itself.
    "United Kingdom", "North America", "jfs:", "jfc:", "jfk:",
    "review", "approved", "action", "issued", "none", "client", "job",
    "typing", "upload_photo", "HTML", "Markdown", "utf-8", "gzip",
    "inline_keyboard", "callback_query", "message", "photo", "document",
    # Matched against the text Telegram returns when an edit changes nothing.
    "not modified",
    # Written into a client's record and handed to the website through
    # /status, or appended to a stored job title. The site does its own
    # translating, so Kurdish here would put one language inside the data and
    # show it to candidates regardless of what their phone is set to.
    "Application received.",
    "Your case officer will contact you with the next step.",
    " (copy)",
}


# Single words that really are button labels. The rules below throw out every
# lone token, because the file is full of dict keys, callback codes and field
# names that look identical to a one-word label. Rather than loosen the rule
# and sweep those in, the handful of genuine ones are named here.
#
# "Yes" and "No" are deliberately absent: they are the stored answer to the
# arrest question, compared against later and sent to the website, so they are
# data. They get a translated label at display time instead - see choice_label().
ALLOW = {"Any", "Back", "Menu", "Next", "New", "Skip", "Done", "Cancel",
         "All", "Live", "Draft", "Delete", "Edit", "Save",
         # Field captions on the vacancy edit screen. The record keys are the
         # lower-case forms ("title", "country"), so these capitalised ones are
         # only ever drawn on a button.
         "Title", "Country", "City", "Category", "Type", "Salary", "Hours",
         "Benefits", "Description", "Photo",
         # Caption on the photo an applicant uploads. The record key is the
         # lower-case "selfie".
         "Selfie",
         # Captions on the client summary. Again the record keys are the
         # lower-case forms.
         "Route", "Status", "Note"}


def looks_like_ui(text):
    if text in ALLOW:
        return True
    if not (4 <= len(text) <= 400):
        return False
    if text in DENY:
        return False
    if not re.search(r"[A-Za-z]{3}", text):
        return False
    if text.startswith(("http", "application/", "text/", "image/", "/", "%s", "\\")):
        return False
    # A callback prefix like "jfs:" is protocol, never shown to anyone.
    if re.fullmatch(r"[a-z]{2,8}:", text):
        return False
    if re.fullmatch(r"[a-z][a-z0-9_]*", text):          # identifier
        return False
    if re.fullmatch(r"[A-Za-z0-9_.\-]+", text):         # single token / filename
        return False
    # Real copy has a space, or is markup-wrapped, or ends in punctuation.
    return (" " in text) or ("<b>" in text) or text.endswith((":", "?", "!", "."))


def collect(src):
    """Every UI string literal, with the byte span it occupies."""
    tree = ast.parse(src)

    skip_spans = []
    fstring_parts = set()
    wrapped = set()          # literals that already sit inside T(...)

    # Docstrings read exactly like UI copy but are documentation, and the
    # module docstring runs before the import of T even exists.
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", None)
            if body and isinstance(body[0], ast.Expr):
                first = body[0].value
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    docstrings.add(id(first))

    machinery = set()        # literals that are arguments to a skipped call

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            fn = node.func
            name = getattr(fn, "id", None) or getattr(fn, "attr", None)
            if name in SKIP_CALLS:
                # Only this call's own arguments are machinery. Skipping the
                # whole LINE swallowed anything sharing it, so a caption like
                #   TF("<b>Edit {title}</b>", title=esc(j.get("title")))
                # vanished because of the .get() beside it - the same failure
                # the f-string handling below had to be fixed for.
                for arg in list(node.args) + [k.value for k in node.keywords]:
                    for piece in ast.walk(arg):
                        if isinstance(piece, ast.Constant) and isinstance(piece.value, str):
                            machinery.add(id(piece))
            # Already translated. It still belongs in the string list — it has
            # to be translated — but `wrap` must not turn it into T(T("…")).
            if name == "T" and node.args:
                first = node.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    wrapped.add(id(first))

        # A plain string concatenated with an f-string becomes one JoinedStr.
        # Its inner Constant pieces carry positions we must not edit — wrapping
        # them produces "f" T("...") and the file stops parsing.
        #
        # Only those inner pieces are excluded, not the lines they sit on. The
        # line span was skipped here once, which quietly swallowed every label
        # written as {"text": T("…"), "callback_data": f"…"} — almost every
        # button in the bot — so most of the interface could never be
        # translated. The offending literal is the one to skip, not its
        # neighbours.
        if isinstance(node, ast.JoinedStr):
            for piece in ast.walk(node):
                if isinstance(piece, ast.Constant) and isinstance(piece.value, str):
                    fstring_parts.add(id(piece))

        # Assignments to the data constants above, and their options= entries.
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if getattr(target, "id", None) in DATA_NAMES:
                    skip_spans.append((node.lineno, node.end_lineno))

    found = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        if id(node) in docstrings or id(node) in fstring_parts:
            continue
        if id(node) in machinery:
            continue
        if not looks_like_ui(node.value):
            continue
        if any(a <= node.lineno <= b for a, b in skip_spans):
            continue
        found.append(node)
    return found, wrapped


def main(argv):
    if len(argv) != 2 or argv[1] not in ("extract", "wrap"):
        sys.exit(__doc__)

    src = io.open(BOT, encoding="utf-8").read()
    nodes, wrapped = collect(src)
    uniq = sorted({n.value for n in nodes})

    if argv[1] == "extract":
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        existing = {}
        if os.path.exists(OUT):
            existing = json.load(io.open(OUT, encoding="utf-8"))
        table = {s: existing.get(s, "") for s in uniq}
        with io.open(OUT, "w", encoding="utf-8") as fh:
            json.dump(table, fh, ensure_ascii=False, indent=1, sort_keys=True)
        done = sum(1 for v in table.values() if v)
        print("  %d unique strings -> %s" % (len(table), OUT))
        print("  %d translated, %d still empty" % (done, len(table) - done))
        print("  %d words" % sum(len(s.split()) for s in uniq))
        return

    # wrap: rewrite literals as T("...") working from the end so earlier
    # offsets stay valid.
    #
    # col_offset from ast counts UTF-8 BYTES, not characters. bot.py is full of
    # emoji and euro signs, so doing this on the decoded string shifts every
    # literal after the first non-ASCII character on a line. Work in bytes.
    raw = src.encode("utf-8")
    line_starts = []
    total = 0
    for line in src.splitlines(keepends=True):
        line_starts.append(total)
        total += len(line.encode("utf-8"))

    def offset(lineno, col):
        return line_starts[lineno - 1] + col

    edits = []
    for n in nodes:
        if id(n) in wrapped:
            continue
        a = offset(n.lineno, n.col_offset)
        b = offset(n.end_lineno, n.end_col_offset)
        chunk = raw[a:b]
        # Skip anything already wrapped, f-strings, and implicitly concatenated
        # literals — those span several quoted pieces and wrapping the whole
        # span is still valid, but only if the span really starts on a quote.
        if not chunk.lstrip().startswith((b'"', b"'")):
            continue
        edits.append((a, b))

    out = raw
    for a, b in sorted(edits, reverse=True):
        out = out[:a] + b"T(" + out[a:b] + b")" + out[b:]

    decoded = out.decode("utf-8")
    # Refuse to write a file that does not parse.
    try:
        ast.parse(decoded)
    except SyntaxError as err:
        sys.exit("ABORT: rewrite produced invalid Python at line %s: %s"
                 % (err.lineno, err.msg))

    io.open(BOT, "w", encoding="utf-8", newline="").write(decoded)
    print("  wrapped %d literals in %s" % (len(edits), BOT))


if __name__ == "__main__":
    main(sys.argv)
