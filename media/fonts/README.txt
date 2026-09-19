Self-hosted webfonts
====================

inter-var-subset.woff2        Inter, variable weight axis  (28 KB)
newsreader-var-subset.woff2   Newsreader, variable weight axis  (41 KB)

Both are subsets: Latin plus the European diacritics this site actually uses
(Polish city names such as Poznan and Wroclaw, German, Nordic and French
accents), the euro sign, dashes, quotes and arrows. Around 155 glyphs each.

Why these are self-hosted rather than loaded from Google Fonts
--------------------------------------------------------------
Most candidates open this site on a phone, often on mobile data.

  Google Fonts, full subsets   259 KB over 3 files, plus a DNS lookup and a
                               TLS handshake to two extra origins
                               (fonts.googleapis.com, fonts.gstatic.com)
  These files                   69 KB over 2 files, same origin, already warm

Two Polish characters alone ("n" with acute in Poznan, "l" with stroke in
Wroclaw) pulled Inter's entire 83 KB latin-ext file. Subsetting keeps the
spellings correct and drops the weight.

Regenerating after a text change
--------------------------------
If you add copy in a language with characters outside the subset, those
letters fall back to a system font. Regenerate with fonttools:

    pip install fonttools brotli
    pyftsubset <source.ttf> --flavor=woff2 --output-file=<out.woff2> \
      --text-file=<all-site-text.txt> --layout-features=kern,liga,clig,calt,ccmp,locl,mark,mkmk

Keep the wght axis: pass the VARIABLE source, not a static instance, or the
500 and 600 weights the stylesheet asks for will be synthesised badly.

Licensing
---------
Inter and Newsreader are both released under the SIL Open Font License 1.1,
which permits self-hosting, subsetting and redistribution. Full licence text
is in Inter-OFL.txt and Newsreader-OFL.txt; keep those files alongside the
fonts.
