"""Translation for the bot's interface.

The English wording stays in bot.py as the lookup key, so the code is still
readable and a missing translation degrades to English rather than to a blank
message. Set the language with an environment variable:

    BOT_LANG=ckb        Kurdish Sorani
    BOT_LANG=en         English (default)

Translations live in bot/lang/<code>.json as a flat English -> target map.
Regenerate the key list after changing bot.py:

    python tools/extract-bot-strings.py extract

Sorani is right-to-left. Telegram lays out messages according to the text
itself, so no direction marker is needed for ordinary sentences — but a line
that starts with a Latin word or a number can render with its punctuation on
the wrong side. mark_rtl() prefixes those with U+200F (RIGHT-TO-LEFT MARK),
which fixes the ordering without showing a character.
"""
import io
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
LANG_DIR = os.path.join(HERE, "lang")

LANG = (os.environ.get("BOT_LANG") or "en").strip().lower()

# Languages whose text runs right to left.
RTL = {"ckb", "ar", "fa", "ur", "ps", "he"}

_table = {}


def _load():
    """Read the table once. A missing or broken file must never stop the bot —
    it simply means everything stays in English."""
    global _table
    if LANG in ("en", ""):
        _table = {}
        return
    path = os.path.join(LANG_DIR, "%s.json" % LANG)
    try:
        with io.open(path, encoding="utf-8") as fh:
            _table = {k: v for k, v in json.load(fh).items() if v}
    except (OSError, ValueError) as err:
        print("  ! translations for %r not loaded (%s) - falling back to English"
              % (LANG, err))
        _table = {}


_load()


def is_rtl():
    return LANG in RTL


# A letter that carries a direction of its own. Telegram takes a message's
# direction from the first one it meets, so if a Kurdish letter comes first the
# line is already laid out correctly.
_STRONG_RTL = re.compile(r"[֐-׿؀-ۿ܀-ݏހ-޿]")
_STRONG_LTR = re.compile(r"[A-Za-zÀ-ɏ]")


def mark_rtl(text):
    """Prefix a right-to-left marker when the line opens with Latin text or a
    digit, so Telegram does not push the punctuation to the wrong end.

    This used to prefix every translated string. That is invisible but not
    free: it went into button captions too, where Telegram already had a
    Kurdish letter to take the direction from, and it made the caption a
    character longer against the 64-byte callback budget for no gain. Add the
    marker only where the line really does open left-to-right - a reference
    code, a count, a date - which is the case the docstring describes.
    """
    if not text or not is_rtl():
        return text
    # Telegram lays out what the reader sees, so the tags come off first -
    # otherwise the "b" in <b> counts as the first Latin letter and every
    # bold line gets a marker it does not need.
    visible = re.sub(r"<[^>]*>", "", text)
    rtl = _STRONG_RTL.search(visible)
    ltr = _STRONG_LTR.search(visible)
    # No directional letter at all (a bare number or emoji) still needs the
    # marker; so does a line whose first directional letter is Latin.
    if rtl and (not ltr or rtl.start() < ltr.start()):
        return text
    return "‏" + text


def T(text):
    """Translate one interface string. Unknown text passes through unchanged,
    which is what keeps a partly-finished translation usable."""
    if not _table:
        return text
    hit = _table.get(text)
    if not hit:
        return text
    return mark_rtl(hit)


def TF(text, **values):
    """Translate a template, then fill its {placeholders}.

    An f-string cannot be translated — by the time the table is consulted the
    number is already baked into the text. Anything that mixes wording with a
    value has to be written as a template instead:

        TF("{n} files on record", n=12)

    Missing or misspelled placeholders leave the template visible rather than
    raising, so a typo in a translation can never take the bot down.
    """
    out = T(text)
    try:
        return out.format(**values)
    except (KeyError, IndexError, ValueError):
        return out


def stats():
    """How complete the current language is - printed in the startup banner."""
    if LANG in ("en", ""):
        return "English"
    try:
        keys = json.load(io.open(os.path.join(LANG_DIR, "strings.json"), encoding="utf-8"))
    except (OSError, ValueError):
        keys = {}
    if not keys:
        return "%s (%d strings)" % (LANG, len(_table))
    # Count only against the extracted list. The table also carries labels for
    # values that stay English in the data and are translated at display time -
    # nationalities, routes, job categories - and counting those would report
    # more than a hundred per cent.
    done = sum(1 for k in keys if _table.get(k))
    return "%s (%d/%d strings, %d%%)" % (LANG, done, len(keys),
                                         round(100 * done / len(keys)))
