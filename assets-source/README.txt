Original images — not served, not deployed
==========================================

These are the full-size sources the hero pictures were generated from. The
site never loads them; it loads the resized copies in media/. They live here
so the hero can be regenerated at different sizes later, and so nothing
unused is sitting on a public URL.

  hero-poster.jpg   the original hero still  (1280x720)
  Rome.jpg          Colosseum                (1200x704)
  newyork.jpg       Statue of Liberty        (1000x667)
  London.jpg        Big Ben                  ( 736x460)
  Paris.jpg         Eiffel Tower             ( 700x394)

To regenerate a hero image at all four widths:

    python tools/make-hero.py assets-source/Rome.jpg hero-rome

Then list the name in data-hero-slides in index.html. The tool prints the
exact widths string to paste, and never upscales — if a source is smaller
than 1280px the srcset simply stops at its real width.

Several of these are only 700-1200px wide, which is why the hero looks soft
on a laptop. Replacing them with 1600px+ originals and re-running the command
above is the single easiest quality win available.

.dockerignore excludes this folder, so it adds nothing to the deployed image.
