/* ==========================================================================
   ARYOS GROUP — script.js
   Vanilla JS, no dependencies, no backend.
   Contents:
     1. Helpers
     2. Sample data (jobs + visa records)
     3. Header & navigation
     4. Hero background video
     5. Jobs: render, filter, save, apply
     6. Visa status lookup
     7. Contact form
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     0. Configuration

     Client files are created and updated entirely in the Telegram bot. The
     website only READS them, through this endpoint — see bot/README.md. When
     you run everything on one PC with start.bat this is set automatically
     (see just below), so you can normally leave it empty.

     Leave it empty and the visa page falls back to the four built-in demo
     records, so the site still works before the bot is running.

     NEVER put the bot token in this file. Everything here is public: any
     visitor can read it with View Source. The token lives with the bot only.
     ------------------------------------------------------------------------ */
  /* The hosted app serves the website and /status from the same origin.
     This avoids localhost and cross-origin dependencies. */
  var STATUS_API = '/status';

  /* Vacancies are created and edited in the Telegram bot and published here.
     If the endpoint is unreachable — the site opened straight from disk, or
     the bot is down — the built-in sample listings below are used instead, so
     the jobs page is never empty. */
  var JOBS_API = '/jobs';

  /* ------------------------------------------------------------------------
     1. Helpers
     ------------------------------------------------------------------------ */
  var $  = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatDate(iso) {
    var parts = iso.split('-');
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    return Number(parts[2]) + ' ' + tr(months[Number(parts[1]) - 1]) + ' ' + parts[0];
  }

  /* localStorage is wrapped: it throws in private mode on some browsers. */
  var store = {
    get: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
  };

  /* Carry anything saved under a previous company name across to the current
     one. Renaming the keys without this would silently empty every returning
     visitor's saved jobs and reset the language they chose. Runs once: after
     the copy the old keys are removed, so it is a no-op on every later visit.
     The list is append-only — a visitor who last came by under the very first
     name still has their saved jobs carried the whole way forward. */
  (function migrateStorageKeys() {
    var moved = [
      ['karwan.lang', 'aryos.lang'],
      ['karwan.savedJobs', 'aryos.savedJobs']
    ];
    try {
      moved.forEach(function (pair) {
        var old = window.localStorage.getItem(pair[0]);
        if (old === null) return;
        if (window.localStorage.getItem(pair[1]) === null) {
          window.localStorage.setItem(pair[1], old);
        }
        window.localStorage.removeItem(pair[0]);
      });
    } catch (e) { /* private mode, or storage disabled — nothing to carry */ }
  }());

  /* ------------------------------------------------------------------------
     1b. Motion utilities

     Every animation in the site funnels through here so that one check —
     prefers-reduced-motion — can switch the whole thing off. `motionOK()` is
     read live rather than cached, so toggling the OS setting takes effect
     without a reload.
     ------------------------------------------------------------------------ */
  function motionOK() { return !reduceMotion.matches; }

  /* Marks the document so CSS can un-hide [data-reveal] when JS is missing. */
  document.documentElement.classList.remove('no-js');

  /* --- Toasts ------------------------------------------------------------- */
  var toastBox = null;

  function toast(message, kind) {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'toasts';
      toastBox.setAttribute('role', 'status');
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }

    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.innerHTML = '<span class="toast__dot" aria-hidden="true"></span><span>' +
                   escapeHtml(message) + '</span>';
    toastBox.appendChild(el);

    var life = window.setTimeout(dismiss, 3200);
    el.addEventListener('click', dismiss);

    function dismiss() {
      window.clearTimeout(life);
      if (!el.parentNode) return;
      el.classList.add('is-out');
      window.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, motionOK() ? 240 : 0);
    }
  }

  /* --- Scroll reveal ------------------------------------------------------ */
  /* One observer for the whole page. Elements reveal once and are then
     unobserved, so scrolling back up never replays them. */
  var revealObserver = null;

  function observeReveals(root) {
    var targets = $$('[data-reveal]', root || document)
      .filter(function (el) { return !el.classList.contains('is-in'); });

    if (!targets.length) return;

    if (!('IntersectionObserver' in window) || !motionOK()) {
      targets.forEach(function (el) { el.classList.add('is-in', 'is-settled'); });
      return;
    }

    if (!revealObserver) {
      revealObserver = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          el.classList.add('is-in');
          obs.unobserve(el);
          /* Drop will-change once the transition has finished. */
          window.setTimeout(function () { el.classList.add('is-settled'); }, 900);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    }

    targets.forEach(function (el) {
      /* Anything already on screen at load reveals immediately rather than
         waiting for a scroll that may never happen on short pages. */
      var box = el.getBoundingClientRect();
      if (box.top < window.innerHeight * 0.92 && box.bottom > 0) {
        el.classList.add('is-in');
        window.setTimeout(function () { el.classList.add('is-settled'); }, 900);
        return;
      }
      revealObserver.observe(el);
    });
  }

  /* Applies the stagger delay declared with data-reveal-group on a parent. */
  function applyStagger(container, step) {
    var kids = $$('[data-reveal]', container);
    kids.forEach(function (el, i) {
      el.style.setProperty('--reveal-delay', (i * (step || 70)) + 'ms');
    });
  }

  /* --- Ripple ------------------------------------------------------------- */
  function initRipples() {
    document.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest('.btn');
      if (!btn || !motionOK()) return;

      var rect = btn.getBoundingClientRect();
      var size = Math.max(rect.width, rect.height);
      var span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = size + 'px';
      span.style.left = (e.clientX - rect.left - size / 2) + 'px';
      span.style.top  = (e.clientY - rect.top  - size / 2) + 'px';
      btn.appendChild(span);
      window.setTimeout(function () {
        if (span.parentNode) span.parentNode.removeChild(span);
      }, 640);
    }, { passive: true });
  }

  /* --- Scroll progress + back to top -------------------------------------- */
  function initScrollUi() {
    var progress = document.createElement('div');
    progress.className = 'scroll-progress';
    progress.setAttribute('aria-hidden', 'true');
    var bar = document.createElement('div');
    bar.className = 'scroll-progress__bar';
    progress.appendChild(bar);
    document.body.appendChild(progress);

    var toTop = document.createElement('button');
    toTop.type = 'button';
    toTop.className = 'to-top';
    toTop.setAttribute('aria-label', 'Back to top');
    toTop.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    document.body.appendChild(toTop);

    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' });
    });

    var ticking = false;
    function update() {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
      bar.style.transform = 'scaleX(' + ratio + ')';
      toTop.classList.toggle('is-visible', window.scrollY > window.innerHeight * 0.7);
      document.body.classList.toggle('is-scrolled', window.scrollY > 8);
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  }

  /* --- Count up ----------------------------------------------------------- */
  /* Animates 0 → target. Falls back to setting the value outright when the
     visitor prefers reduced motion. */
  function countUp(el, target, render, duration) {
    if (!motionOK()) { el.textContent = render(target); return; }

    var start = null;
    var ms = duration || 900;

    function frame(now) {
      if (start === null) start = now;
      var p = Math.min((now - start) / ms, 1);
      var eased = 1 - Math.pow(1 - p, 3);           /* easeOutCubic */
      el.textContent = render(Math.round(target * eased));
      if (p < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  /* --- Scrolling ----------------------------------------------------------- */
  /* Wrapped because scrollIntoView options are ignored on older browsers and
     the method itself is missing in a few embedded webviews. Never let a
     convenience scroll break the step that follows it. */
  function scrollToEl(el) {
    if (!el || !el.scrollIntoView) return;
    try {
      el.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'center' });
    } catch (e) {
      el.scrollIntoView();
    }
  }

  /* --- Button busy state --------------------------------------------------- */
  function setBusy(btn, busy) {
    if (!btn) return;
    btn.classList.toggle('is-busy', !!busy);
    btn.disabled = !!busy;
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }

  /* ------------------------------------------------------------------------
     2. Sample data
     ------------------------------------------------------------------------ */

  /* Job listings. `salaryUsd` is the monthly minimum converted to USD and is
     used only by the salary filter; `salary` is what the card displays.
     `region` groups the country cards on the homepage. */
  var JOBS = [
    {
      id: 'ARY-1042',
      title: 'Construction Worker',
      country: 'Germany',
      city: 'Berlin',
      region: 'Europe',
      category: 'Construction',
      salary: '€2,300 – €2,700 / month',
      salaryUsd: 2480,
      hours: '40 hrs / week · Monday to Friday',
      type: 'Full-time',
      tags: ['Work permit sponsored', 'Housing assistance'],
      desc: 'General site work for a residential building contractor: formwork, concrete pouring and site preparation. Basic German is an advantage but not required at start.',
      photo: 'media/jobs/ARY-1042.jpg',
      photoWidths: [600, 1200],
      posted: '3 days ago'
    },
    {
      id: 'ARY-1043',
      title: 'CNC Machine Operator',
      country: 'Germany',
      city: 'Munich',
      region: 'Europe',
      category: 'Technical & Trades',
      salary: '€2,600 – €3,100 / month',
      salaryUsd: 2800,
      hours: '38 hrs / week · two shifts',
      type: 'Full-time',
      tags: ['Work permit sponsored', 'Paid training'],
      desc: 'Setting and running CNC lathes and milling machines for an automotive supplier. Technical certificate and two years of workshop experience required.',
      photo: 'media/jobs/ARY-1043.jpg',
      photoWidths: [600, 1200],
      posted: '1 week ago'
    },
    {
      id: 'ARY-1051',
      title: 'Warehouse Assistant',
      country: 'Poland',
      city: 'Poznań',
      region: 'Europe',
      category: 'Logistics',
      salary: '€1,150 – €1,400 / month',
      salaryUsd: 1240,
      hours: '40 hrs / week · day and night shifts',
      type: 'Full-time',
      tags: ['Shared accommodation', 'Overtime paid'],
      desc: 'Order picking, scanning and packing in a distribution centre. Forklift licence is a plus; training is provided in the first two weeks.',
      photo: 'media/jobs/ARY-1051.jpg',
      photoWidths: [600, 1200],
      posted: '5 days ago'
    },
    {
      id: 'ARY-1052',
      title: 'Welder MIG/MAG',
      country: 'Poland',
      city: 'Wrocław',
      region: 'Europe',
      category: 'Technical & Trades',
      salary: '€1,400 – €1,750 / month',
      salaryUsd: 1510,
      hours: '40 hrs / week · Monday to Friday',
      type: 'Full-time',
      tags: ['Accommodation provided', 'Trade test on arrival'],
      desc: 'Steel structure fabrication for an industrial workshop. Certificate 135 or 136 preferred; a practical trade test is arranged in Erbil before travel.',
      photo: 'media/jobs/ARY-1052.jpg',
      photoWidths: [600, 1200],
      posted: '4 days ago'
    },
    {
      id: 'ARY-1061',
      title: 'Order Picker — Distribution',
      country: 'Netherlands',
      city: 'Rotterdam',
      region: 'Europe',
      category: 'Logistics',
      salary: '€2,100 – €2,450 / month',
      salaryUsd: 2270,
      hours: '38 hrs / week · rotating shifts',
      type: 'Full-time',
      tags: ['Housing arranged', 'Transport to site', 'Health insurance'],
      desc: 'Voice-picking and pallet building in a large retail distribution centre. No experience required; a two-week paid induction is included.',
      photo: 'media/jobs/ARY-1061.jpg',
      photoWidths: [600, 1200],
      posted: '2 days ago'
    },
    {
      id: 'ARY-1062',
      title: 'Greenhouse Horticulture Worker',
      country: 'Netherlands',
      city: 'Westland',
      region: 'Europe',
      category: 'Agriculture & Food',
      salary: '€2,000 – €2,300 / month',
      salaryUsd: 2160,
      hours: '40 hrs / week · Monday to Saturday',
      type: 'Full-time',
      tags: ['Housing arranged', 'Seasonal bonus'],
      desc: 'Planting, harvesting and quality sorting in climate-controlled greenhouses. Physically active outdoor-style work; English at basic level is enough.',
      photo: 'media/jobs/ARY-1062.jpg',
      photoWidths: [600, 1200],
      posted: '1 week ago'
    },
    {
      id: 'ARY-1071',
      title: 'Warehouse Operative',
      country: 'Belgium',
      city: 'Antwerp',
      region: 'Europe',
      category: 'Logistics',
      salary: '€2,150 – €2,500 / month',
      salaryUsd: 2320,
      hours: '38 hrs / week · early and late shifts',
      type: 'Full-time',
      tags: ['Meal vouchers', 'Transport allowance'],
      desc: 'Goods receiving, replenishment and dispatch for a port logistics operator. Reach-truck licence is an advantage and can be obtained on site.',
      photo: 'media/jobs/ARY-1071.jpg',
      photoWidths: [600, 1200],
      posted: '6 days ago'
    },
    {
      id: 'ARY-1072',
      title: 'Hotel Housekeeping',
      country: 'Belgium',
      city: 'Brussels',
      region: 'Europe',
      category: 'Hospitality',
      salary: '€1,950 – €2,200 / month',
      salaryUsd: 2100,
      hours: '38 hrs / week · rotating rota',
      type: 'Full-time',
      tags: ['Uniform and meals', 'Language course'],
      desc: 'Room cleaning and floor service in a city business hotel. Suitable for candidates with hotel or cleaning experience and basic English or French.',
      photo: 'media/jobs/ARY-1072.jpg',
      photoWidths: [600, 1200],
      posted: '3 days ago'
    },
    {
      id: 'ARY-1081',
      title: 'Agricultural Harvest Worker',
      country: 'Spain',
      city: 'Valencia',
      region: 'Europe',
      category: 'Agriculture & Food',
      salary: '€1,300 – €1,600 / month',
      salaryUsd: 1400,
      hours: '40 hrs / week · Monday to Saturday',
      type: 'Seasonal',
      tags: ['Accommodation provided', 'Seasonal contract'],
      desc: 'Citrus and vegetable harvesting, grading and packing for an export cooperative. Season runs roughly eight months with renewal for reliable workers.',
      photo: 'media/jobs/ARY-1081.jpg',
      photoWidths: [600, 1200],
      posted: '4 days ago'
    },
    {
      id: 'ARY-1082',
      title: 'Kitchen Assistant',
      country: 'Spain',
      city: 'Barcelona',
      region: 'Europe',
      category: 'Hospitality',
      salary: '€1,400 – €1,700 / month',
      salaryUsd: 1510,
      hours: '40 hrs / week · split shifts',
      type: 'Full-time',
      tags: ['Meals included', 'Permanent contract'],
      desc: 'Preparation, plating support and kitchen hygiene in a busy restaurant group. Previous kitchen experience preferred; Spanish is taught on the job.',
      photo: 'media/jobs/ARY-1082.jpg',
      photoWidths: [600, 1200],
      posted: '1 week ago'
    },
    {
      id: 'ARY-1091',
      title: 'Hotel Housekeeper',
      country: 'Portugal',
      city: 'Lisbon',
      region: 'Europe',
      category: 'Hospitality',
      salary: '€960 – €1,150 / month',
      salaryUsd: 1040,
      hours: '40 hrs / week · rotating rota',
      type: 'Full-time',
      tags: ['Accommodation support', 'Meals on shift'],
      desc: 'Guest room and public area cleaning for a hotel group in the city centre. Entry-level role with structured training in the first month.',
      photo: 'media/jobs/ARY-1091.jpg',
      photoWidths: [600, 1200],
      posted: '2 days ago'
    },
    {
      id: 'ARY-1092',
      title: 'Construction Finisher',
      country: 'Portugal',
      city: 'Porto',
      region: 'Europe',
      category: 'Construction',
      salary: '€1,050 – €1,300 / month',
      salaryUsd: 1130,
      hours: '40 hrs / week · Monday to Friday',
      type: 'Full-time',
      tags: ['Work permit sponsored', 'Tools provided'],
      desc: 'Plastering, tiling and painting on residential renovation projects. Three years of finishing-trade experience and references are required.',
      photo: 'media/jobs/ARY-1092.jpg',
      photoWidths: [600, 1200],
      posted: '5 days ago'
    },
    {
      id: 'ARY-1101',
      title: 'Restaurant Waiter',
      country: 'Italy',
      city: 'Milan',
      region: 'Europe',
      category: 'Hospitality',
      salary: '€1,450 – €1,750 / month',
      salaryUsd: 1560,
      hours: '40 hrs / week · split shifts',
      type: 'Full-time',
      tags: ['Meals and uniform', 'Tips shared'],
      desc: 'Table service in a mid-range restaurant near the centre. Conversational English required; Italian lessons are offered during the first six months.',
      photo: 'media/jobs/ARY-1101.jpg',
      photoWidths: [600, 1200],
      posted: '3 days ago'
    },
    {
      id: 'ARY-1102',
      title: 'Truck Driver — Category CE',
      country: 'Italy',
      city: 'Verona',
      region: 'Europe',
      category: 'Logistics',
      salary: '€1,900 – €2,300 / month',
      salaryUsd: 2050,
      hours: '45 hrs / week · national routes',
      type: 'Full-time',
      tags: ['Licence conversion support', 'Nights paid separately'],
      desc: 'Regional and national distribution runs for a food logistics company. CE licence and digital tachograph card required; conversion is supported.',
      photo: 'media/jobs/ARY-1102.jpg',
      photoWidths: [600, 1200],
      posted: '1 week ago'
    },
    {
      id: 'ARY-1111',
      title: 'Hotel Housekeeping — Season',
      country: 'Greece',
      city: 'Heraklion, Crete',
      region: 'Europe',
      category: 'Hospitality',
      salary: '€900 – €1,150 / month',
      salaryUsd: 970,
      hours: '40 hrs / week · six days',
      type: 'Seasonal',
      tags: ['Accommodation and meals', 'Return flight after season'],
      desc: 'Seasonal resort role from April to October. Room cleaning and linen service, with accommodation and meals provided on the property.',
      photo: 'media/jobs/ARY-1111.jpg',
      photoWidths: [600, 1200],
      posted: '6 days ago'
    },
    {
      id: 'ARY-1112',
      title: 'Chef de Partie',
      country: 'Greece',
      city: 'Athens',
      region: 'Europe',
      category: 'Hospitality',
      salary: '€1,250 – €1,550 / month',
      salaryUsd: 1350,
      hours: '40 hrs / week · rotating shifts',
      type: 'Full-time',
      tags: ['Accommodation support', 'Permanent contract'],
      desc: 'Section chef in a hotel restaurant kitchen. Minimum three years in a professional kitchen and one recognised culinary qualification.',
      photo: 'media/jobs/ARY-1112.jpg',
      photoWidths: [600, 1200],
      posted: '4 days ago'
    },
    {
      id: 'ARY-1121',
      title: 'Hotel Breakfast Service',
      country: 'Austria',
      city: 'Vienna',
      region: 'Europe',
      category: 'Hospitality',
      salary: '€1,900 – €2,200 / month',
      salaryUsd: 2050,
      hours: '40 hrs / week · early shifts',
      type: 'Full-time',
      tags: ['Staff accommodation', 'German course paid'],
      desc: 'Buffet setup, guest service and clearing in a four-star hotel. Early start suits candidates who prefer finishing by mid-afternoon.',
      photo: 'media/jobs/ARY-1121.jpg',
      photoWidths: [600, 1200],
      posted: '2 days ago'
    },
    {
      id: 'ARY-1122',
      title: 'Carpenter',
      country: 'Austria',
      city: 'Salzburg',
      region: 'Europe',
      category: 'Construction',
      salary: '€2,400 – €2,800 / month',
      salaryUsd: 2590,
      hours: '39 hrs / week · Monday to Friday',
      type: 'Full-time',
      tags: ['Work permit sponsored', 'Tools and PPE provided'],
      desc: 'Timber frame and interior fit-out work for a regional construction firm. Trade certificate and four years of experience required.',
      photo: 'media/jobs/ARY-1122.jpg',
      photoWidths: [600, 1200],
      posted: '1 week ago'
    },
    {
      id: 'ARY-1131',
      title: 'Nurse — Elderly Care',
      country: 'Sweden',
      city: 'Malmö',
      region: 'Europe',
      category: 'Healthcare',
      salary: '€2,900 – €3,400 / month',
      salaryUsd: 3130,
      hours: '38 hrs / week · planned rota',
      type: 'Full-time',
      tags: ['Licence recognition support', 'Language course included'],
      desc: 'Care home role for qualified nurses. Daily care, medication and family contact. Aryos Group supports the diploma recognition and registration process.',
      photo: 'media/jobs/ARY-1131.jpg',
      photoWidths: [600, 1200],
      posted: '2 days ago'
    },
    {
      id: 'ARY-1132',
      title: 'Cleaner — Facility Services',
      country: 'Sweden',
      city: 'Stockholm',
      region: 'Europe',
      category: 'Cleaning & Facilities',
      salary: '€2,200 – €2,500 / month',
      salaryUsd: 2370,
      hours: '38 hrs / week · daytime',
      type: 'Full-time',
      tags: ['Permanent contract', 'Transport card'],
      desc: 'Office and school cleaning on a fixed daytime route. Entry-level position with a permanent contract after a six-month probation period.',
      photo: 'media/jobs/ARY-1132.jpg',
      photoWidths: [600, 1200],
      posted: '5 days ago'
    },
    {
      id: 'ARY-1141',
      title: 'Construction Carpenter',
      country: 'Norway',
      city: 'Oslo',
      region: 'Europe',
      category: 'Construction',
      salary: 'NOK 38,000 – 44,000 / month',
      salaryUsd: 3500,
      hours: '37.5 hrs / week · Monday to Friday',
      type: 'Full-time',
      tags: ['Housing arranged', 'Travel paid twice a year'],
      desc: 'Formwork and timber construction on commercial projects. Recognised trade certificate and four years of documented experience required.',
      photo: 'media/jobs/ARY-1141.jpg',
      photoWidths: [600, 1200],
      posted: '3 days ago'
    },
    {
      id: 'ARY-1142',
      title: 'Fish Processing Operative',
      country: 'Norway',
      city: 'Bergen',
      region: 'Europe',
      category: 'Agriculture & Food',
      salary: 'NOK 32,000 – 36,000 / month',
      salaryUsd: 2950,
      hours: '37.5 hrs / week · two shifts',
      type: 'Full-time',
      tags: ['Accommodation provided', 'Cold-weather gear supplied'],
      desc: 'Filleting, trimming and packing on a processing line. No experience required; work is in a chilled environment and physically steady.',
      photo: 'media/jobs/ARY-1142.jpg',
      photoWidths: [600, 1200],
      posted: '1 week ago'
    },
    {
      id: 'ARY-1151',
      title: 'Cleaner — Facility Services',
      country: 'Finland',
      city: 'Helsinki',
      region: 'Europe',
      category: 'Cleaning & Facilities',
      salary: '€2,100 – €2,400 / month',
      salaryUsd: 2270,
      hours: '37.5 hrs / week · daytime',
      type: 'Full-time',
      tags: ['Permanent contract', 'Finnish course included'],
      desc: 'Daily cleaning of offices and public buildings on a fixed route. Reliable entry-level work with a clear path to a permanent contract.',
      photo: 'media/jobs/ARY-1151.jpg',
      photoWidths: [600, 1200],
      posted: '4 days ago'
    },
    {
      id: 'ARY-1152',
      title: 'Welder TIG',
      country: 'Finland',
      city: 'Tampere',
      region: 'Europe',
      category: 'Technical & Trades',
      salary: '€2,500 – €2,900 / month',
      salaryUsd: 2700,
      hours: '38 hrs / week · Monday to Friday',
      type: 'Full-time',
      tags: ['Work permit sponsored', 'Trade test on arrival'],
      desc: 'Stainless steel welding for a machinery manufacturer. TIG certificate and three years of experience with thin-wall material required.',
      photo: 'media/jobs/ARY-1152.jpg',
      photoWidths: [600, 1200],
      posted: '6 days ago'
    },
    {
      id: 'ARY-1161',
      title: 'Warehouse Operative',
      country: 'United Kingdom',
      city: 'Manchester',
      region: 'Europe',
      category: 'Logistics',
      salary: '£1,950 – £2,250 / month',
      salaryUsd: 2470,
      hours: '40 hrs / week · four-on four-off',
      type: 'Full-time',
      tags: ['Skilled Worker sponsorship', 'Overtime at 1.5x'],
      desc: 'Picking, packing and loading for a national retailer. Sponsorship is provided by the employer; English at B1 level is required for the visa.',
      photo: 'media/jobs/ARY-1161.jpg',
      photoWidths: [600, 1200],
      posted: '2 days ago'
    },
    {
      id: 'ARY-1162',
      title: 'Care Assistant',
      country: 'United Kingdom',
      city: 'London',
      region: 'Europe',
      category: 'Healthcare',
      salary: '£2,100 – £2,450 / month',
      salaryUsd: 2660,
      hours: '37.5 hrs / week · rotating rota',
      type: 'Full-time',
      tags: ['Health and Care visa', 'Training paid'],
      desc: 'Supporting residents with daily living in a care home. The employer holds a Health and Care Worker sponsor licence; B1 English is required.',
      photo: 'media/jobs/ARY-1162.jpg',
      photoWidths: [600, 1200],
      posted: '1 week ago'
    },
    {
      id: 'ARY-1171',
      title: 'Commercial Electrician',
      country: 'USA',
      city: 'Houston, TX',
      region: 'North America',
      category: 'Technical & Trades',
      salary: '$3,800 – $4,600 / month',
      salaryUsd: 3800,
      hours: '40 hrs / week · overtime available',
      type: 'Full-time',
      tags: ['H-2B sponsorship', 'Relocation allowance'],
      desc: 'Conduit, panel and lighting installation on commercial fit-outs. Five years of experience and a recognised electrical certificate required.',
      photo: 'media/jobs/ARY-1171.jpg',
      photoWidths: [600, 1200],
      posted: '3 days ago'
    },
    {
      id: 'ARY-1172',
      title: 'CDL Truck Driver',
      country: 'USA',
      city: 'Chicago, IL',
      region: 'North America',
      category: 'Logistics',
      salary: '$4,200 – $5,200 / month',
      salaryUsd: 4200,
      hours: 'Regional routes · home weekly',
      type: 'Full-time',
      tags: ['Licence conversion support', 'Per diem paid'],
      desc: 'Regional freight for a national carrier. Class A licence conversion and the required medical certificate are arranged before travel.',
      photo: 'media/jobs/ARY-1172.jpg',
      photoWidths: [600, 1200],
      posted: '5 days ago'
    },
    {
      id: 'ARY-1181',
      title: 'Heavy Duty Mechanic',
      country: 'Canada',
      city: 'Calgary, AB',
      region: 'North America',
      category: 'Technical & Trades',
      salary: 'CAD 5,200 – 6,000 / month',
      salaryUsd: 3800,
      hours: '40 hrs / week · Monday to Friday',
      type: 'Full-time',
      tags: ['LMIA sponsorship', 'Permanent residence pathway'],
      desc: 'Servicing and repairing heavy equipment for a fleet operator. Red Seal equivalency support is provided for experienced mechanics.',
      photo: 'media/jobs/ARY-1181.jpg',
      photoWidths: [600, 1200],
      posted: '4 days ago'
    },
    {
      id: 'ARY-1182',
      title: 'Long-Haul Truck Driver',
      country: 'Canada',
      city: 'Toronto, ON',
      region: 'North America',
      category: 'Logistics',
      salary: 'CAD 4,600 – 5,400 / month',
      salaryUsd: 3350,
      hours: 'Long-haul routes · two weeks out',
      type: 'Full-time',
      tags: ['LMIA sponsorship', 'Licence conversion support'],
      desc: 'Cross-province freight for a logistics company. AZ licence conversion, medical and training are arranged by the employer on arrival.',
      photo: 'media/jobs/ARY-1182.jpg',
      photoWidths: [600, 1200],
      posted: '1 week ago'
    }
  ];

  /* Every country we recruit into, in the order the homepage lists them.
     The job data above is the single source of truth for the counts, so a
     country with no open role still appears here and simply shows zero. */
  var COUNTRIES = [
    { name: 'Germany',        region: 'Europe' },
    { name: 'Netherlands',    region: 'Europe' },
    { name: 'Belgium',        region: 'Europe' },
    { name: 'United Kingdom', region: 'Europe' },
    { name: 'Poland',         region: 'Europe' },
    { name: 'Austria',        region: 'Europe' },
    { name: 'Sweden',         region: 'Europe' },
    { name: 'Norway',         region: 'Europe' },
    { name: 'Finland',        region: 'Europe' },
    { name: 'Italy',          region: 'Europe' },
    { name: 'Spain',          region: 'Europe' },
    { name: 'Portugal',       region: 'Europe' },
    { name: 'Greece',         region: 'Europe' },
    { name: 'USA',            region: 'North America' },
    { name: 'Canada',         region: 'North America' }
  ];

  var REGIONS = ['Europe', 'North America'];

  /* Flag per country, looked up at render time rather than stored on the
     record, so a country arriving from the bot still gets its flag. */
  var FLAGS = {
    'Germany': '🇩🇪', 'Netherlands': '🇳🇱', 'Belgium': '🇧🇪', 'United Kingdom': '🇬🇧',
    'Poland': '🇵🇱', 'Austria': '🇦🇹', 'Sweden': '🇸🇪', 'Norway': '🇳🇴',
    'Finland': '🇫🇮', 'Italy': '🇮🇹', 'Spain': '🇪🇸', 'Portugal': '🇵🇹',
    'Greece': '🇬🇷', 'USA': '🇺🇸', 'Canada': '🇨🇦', 'Ireland': '🇮🇪',
    'Denmark': '🇩🇰', 'France': '🇫🇷', 'Czechia': '🇨🇿', 'Romania': '🇷🇴',
    'Hungary': '🇭🇺', 'Croatia': '🇭🇷', 'Slovakia': '🇸🇰', 'Lithuania': '🇱🇹',
    'Latvia': '🇱🇻', 'Estonia': '🇪🇪', 'Switzerland': '🇨🇭', 'Malta': '🇲🇹'
  };

  function flagFor(name) { return FLAGS[name] || '🌍'; }

  /* Country code for the drawn flags in FLAG_ART further down. Emoji flags are
     the fallback, not the first choice: Windows ships no glyphs for them, so
     🇩🇪 comes out as two boxed letters on the desktop half of the audience.
     A country with no drawing here simply keeps its emoji. */
  var FLAG_CODES = {
    'Germany': 'de', 'Netherlands': 'nl', 'Belgium': 'be', 'United Kingdom': 'gb',
    'Poland': 'pl', 'Austria': 'at', 'Sweden': 'se', 'Norway': 'no',
    'Finland': 'fi', 'Italy': 'it', 'Spain': 'es', 'Portugal': 'pt',
    'Greece': 'gr', 'USA': 'us', 'Canada': 'ca', 'Ireland': 'ie',
    'France': 'fr'
  };

  /* The flag mark itself — the drawing where there is one, the emoji where
     there is not. Decorative either way: every caller prints the country name
     next to it or hides one for screen readers. */
  function flagMark(country, cls) {
    var code = FLAG_CODES[country];
    if (!code) {
      return '<span class="' + cls + '" aria-hidden="true">' + flagFor(country) + '</span>';
    }
    /* The drawings live in a sprite filled on demand: these marks are rendered
       on pages that carry no flag ticker to build it. */
    ensureFlagSprite([code]);
    return '<svg class="' + cls + '" viewBox="0 0 30 20" aria-hidden="true">' +
             '<use href="#flag-' + code + '"/></svg>';
  }

  /* The flag on its own, with the country name left for assistive tech: the
     card already prints "city, country" a line below, so the badge repeating
     it in full was the same word twice. */
  function flagBadge(country, label) {
    return '<span class="job__flag">' + flagMark(country, 'job__flag-img') +
             '<span class="sr-only">' + escapeHtml(label || country) + '</span>' +
           '</span>';
  }

  /* ------------------------------------------------------------------------
     2b. Live vacancies

     JOBS above is the fallback. On load we ask the bot for the published set
     and swap it in. Everything downstream reads JOBS, so nothing else needs
     to know where the data came from.
     ------------------------------------------------------------------------ */
  var JOBS_SOURCE = 'samples';

  function loadJobs(done) {
    if (!window.fetch || !JOBS_API) { done(); return; }

    var settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      done();
    }

    /* Never let a hanging request hold the page hostage. */
    var giveUp = window.setTimeout(finish, 4000);

    fetch(JOBS_API, { headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (list) {
        if (Array.isArray(list) && list.length) {
          JOBS = list;
          JOBS_SOURCE = 'live';
          rebuildCountries();
        }
      })
      .catch(function () { /* offline or opened from disk — keep the samples */ })
      .then(function () {
        window.clearTimeout(giveUp);
        finish();
      });
  }

  /* Any country the admin adds in Telegram should appear on the site without
     a code change, so the country list is derived from the jobs themselves. */
  function rebuildCountries() {
    var seen = {};
    var order = [];

    COUNTRIES.forEach(function (c) { seen[c.name] = c.region; order.push(c.name); });

    JOBS.forEach(function (j) {
      if (!j.country || seen[j.country]) return;
      seen[j.country] = j.region || 'Other';
      order.push(j.country);
    });

    COUNTRIES = order.map(function (name) {
      return { name: name, region: seen[name] };
    });

    /* Show a region only once it actually has a country in it. */
    var regionOrder = ['Europe', 'North America', 'Other'];
    var present = {};
    COUNTRIES.forEach(function (c) { present[c.region] = true; });
    REGIONS = regionOrder.filter(function (r) { return present[r]; });
    Object.keys(present).forEach(function (r) {
      if (regionOrder.indexOf(r) === -1) REGIONS.push(r);
    });
  }

  /* Visa records used by the demo lookup. */
  var VISA_RECORDS = {
    'ARY-2481': {
      code: 'review',
      status: 'Under Review',
      route: 'Germany — National Work Visa (Type D)',
      submitted: '2026-07-14',
      updated: '2026-08-04',
      step: 2,
      note: 'Your file is complete and is with the consulate for assessment. No action is needed from you right now. Reviews at this stage usually take two to four weeks.'
    },
    'ARY-7390': {
      code: 'approved',
      status: 'Approved',
      route: 'Poland — Work Permit Type A',
      submitted: '2026-06-02',
      updated: '2026-08-06',
      step: 3,
      note: 'The employer permit has been approved. Your case officer will contact you to book the visa appointment and confirm the travel window.'
    },
    'ARY-5162': {
      code: 'action',
      status: 'Need More Documents',
      route: 'Sweden — Work Permit',
      submitted: '2026-07-21',
      updated: '2026-08-07',
      step: 2,
      note: 'Your application is on hold until the documents below reach our office. Send clear photos or scans by WhatsApp, or bring the originals to the Erbil office.',
      docs: [
        'Passport copy valid for at least 12 more months',
        'Signed employment contract — page 3 is missing',
        'Medical certificate issued within the last 3 months'
      ]
    },
    'ARY-6034': {
      code: 'issued',
      status: 'Issued',
      route: 'Netherlands — Highly Skilled / GVVA Permit',
      submitted: '2026-05-19',
      updated: '2026-08-01',
      step: 4,
      note: 'Your visa has been issued and sent to the email on your file. Keep a printed copy with you when you travel. Contact us if the details on the visa do not match your passport.'
    }
  };

  var VISA_STEPS = ['Application received', 'Under review', 'Decision', 'Visa issued'];

  /* ------------------------------------------------------------------------
     3. Header & navigation
     ------------------------------------------------------------------------ */
  /* ------------------------------------------------------------------------
     4b. Back control

     Real history is preferred over the hard-coded href, so "back" returns the
     visitor to where they actually were — a filtered job list, say, rather
     than the generic parent page. The href in the markup is the fallback for a
     cold entry (shared link, new tab, search result) and for no-JS, so the
     control is never a dead end.
     ------------------------------------------------------------------------ */
  function initBack() {
    var btn = $('[data-back]');
    if (!btn) return;

    /* A same-origin referrer is the reliable signal that the previous entry in
       history belongs to this site. history.length counts the browser's whole
       session and would send people to another site. */
    var cameFromSite = false;
    try {
      cameFromSite = !!document.referrer &&
        new URL(document.referrer).origin === window.location.origin;
    } catch (e) {
      cameFromSite = false;
    }

    if (!cameFromSite) {
      /* The home page has no parent to offer, so it drops the control rather
         than linking to itself. Inner pages keep the href fallback. */
      if (btn.hasAttribute('data-back-optional') && btn.parentNode) {
        btn.parentNode.removeChild(btn);
      }
      return;
    }

    btn.hidden = false;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      window.history.back();
    });
  }

  /* ------------------------------------------------------------------------
     Language picker

     The list of languages is generated; the translations are not. Anything
     carrying a data-i18n key is swapped from UI_STRINGS below. A language with
     no entry still switches the page's lang and direction — which is what
     makes the browser's own translate prompt offer to do the rest — and falls
     back to English text rather than showing blanks.
     ------------------------------------------------------------------------ */
  /* Filled from lang/<code>.json as languages are chosen. `en` is captured
     from the page itself, since the HTML already carries the English wording. */
  var UI_STRINGS = {};

  /* Which languages have a translation file. Used for the tick in the picker,
     so nobody picks a language expecting more than it delivers. */
  var TRANSLATED = ['en', 'ckb', 'ar', 'tr'];

  function t(key, lang) {
    var table = UI_STRINGS[lang] || UI_STRINGS[String(lang).split('-')[0]];
    return (table && table[key]) || (UI_STRINGS.en && UI_STRINGS.en[key]) || null;
  }

  /* The JS-built sections (regions, job cards, filters, the wizard, the visa
     result) render from English data in this file, so their words would stay
     English no matter what the language menu said. `tr` maps a *source
     English string* to the dictionary the current language ships (the dyn.*
     keys at the bottom of each lang/<code>.json). Anything the dictionary
     has not covered yet is returned verbatim, so data arriving from Telegram
     stays readable instead of vanishing. */
  function tr(en, lang) {
    if (en == null) return en;
    lang = lang || currentLang();
    var base = String(lang).split('-')[0];
    var table = UI_STRINGS[lang] || UI_STRINGS[base];
    if (table) {
      var hit = table['dyn.' + en];
      if (hit != null && hit !== '') return hit;
    }
    return en;
  }

  /* Like tr, but swaps {0} {1} … placeholders in the translated template.
     English is the template itself, so the same key works for every language:
     trt('Showing all {0} jobs', ar, 30) -> 'عرض جميع الوظائف (30)'. */
  function trt(en, lang) {
    var out = tr(en, lang);
    for (var i = 2; i < arguments.length; i++) {
      out = out.replace('{' + (i - 2) + '}', arguments[i]);
    }
    return out;
  }

  /* The jobs page keeps its filters wired to one live closure; this hook lets
     the language repaint reach inside and re-draw, preserving the selection. */
  var JOBS_REPAINT = null;

  /* The English wording already sits in the HTML, so it is the fallback for
     any key a language file has not translated yet. Captured before the first
     swap, otherwise switching twice would "fall back" to the previous
     language instead of to English. */
  function captureEnglish() {
    if (UI_STRINGS.en) return;
    UI_STRINGS.en = {};
    $$('[data-i18n], [data-i18n-ph]').forEach(function (el) {
      var key = el.getAttribute('data-i18n') || el.getAttribute('data-i18n-ph');
      UI_STRINGS.en[key] = el.hasAttribute('data-i18n-ph')
        ? (el.getAttribute('placeholder') || '')
        : el.textContent.trim();
    });
  }

  function paintLanguage(code) {
    var html = document.documentElement;
    html.lang = code;
    html.dir = langDir(code);

    $$('[data-i18n]').forEach(function (el) {
      var text = t(el.getAttribute('data-i18n'), code);
      if (text) el.textContent = text;
    });

    $$('[data-i18n-ph]').forEach(function (el) {
      var text = t(el.getAttribute('data-i18n-ph'), code);
      if (text) el.setAttribute('placeholder', text);
    });

    var btn = $('[data-lang-button]');
    if (btn) {
      var cur = $('[data-lang-current]', btn);
      if (cur) cur.textContent = code.split('-')[0].toUpperCase();
      btn.setAttribute('aria-label',
        (t('lang.title', code) || 'Choose your language') + ' — ' + langName(code));
    }

    /* Sections built by script.js bake their English text in at render time,
       so a language switch has to draw them again once the words are in. */
    repaintDynamic();
  }

  /* Language files are fetched on demand and kept, so adding a language is a
     file in lang/ rather than an edit to this script — and a visitor only ever
     downloads the one language they actually read. */
  function applyLanguage(code, save) {
    captureEnglish();
    if (save !== false) store.set(LANG_KEY, code);

    var base = String(code).split('-')[0];
    if (UI_STRINGS[code] || UI_STRINGS[base]) { paintLanguage(code); return; }

    /* Flip direction immediately; the words follow when the file lands. */
    document.documentElement.dir = langDir(code);

    /* Default caching, not force-cache: the server marks these no-cache so a
       corrected translation reaches people on their next visit, and the
       revalidation costs a 304 rather than a download. */
    fetch('lang/' + encodeURIComponent(code) + '.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (table) {
        if (table) UI_STRINGS[code] = table;
      })
      .catch(function () { /* no file for this language — English stands */ })
      .then(function () { paintLanguage(code); });
  }

  /* Re-draw every JS-built section after the language changes. Each painter
     is a no-op on pages that do not carry its markup, so one function serves
     all five pages. Filters on the jobs page keep their selection because the
     repaint reads the live <select> values before rebuilding the options. */
  function repaintDynamic() {
    if ($('[data-regions]')) { paintRegions(); initCountryCounts(); }
    if ($('[data-dotmap]')) paintDotMarkers();
    if ($('[data-featured-jobs]')) { paintFeaturedJobs(); wireJobActions($('[data-featured-jobs]')); }
    if ($('[data-reviews]')) paintReviews();
    if (JOBS_REPAINT) JOBS_REPAINT();
    paintBoard();

    /* Apply wizard chrome that lives in static markup. */
    var applyBack = $('[data-apply-back]');
    if (applyBack) applyBack.textContent = tr('Back');
    var applyNext = $('[data-apply-next]');
    if (applyNext) {
      if (applyState && applyState.done) applyNext.hidden = true;
      else if (!applyState) applyNext.textContent = tr('Continue');
    }
    var applyClose = $('[data-apply-close]');
    if (applyClose) applyClose.setAttribute('aria-label', tr('Close application'));
    if (applyState && applyState.job) setApplyJobLabel(applyState.job);
    else {
      var ail = $('[data-apply-job]');
      if (ail) ail.innerHTML = tr('Application');
    }

    /* If the wizard is mid-flight, redraw the open step in the new language.
       Answers survive because they live in applyState, not in the markup. */
    if (applyState && !applyState.done && !applyState.sending) renderApplyStep('back');

    afterRender();
  }

  function initLanguage() {
    /* Applied with save=false: the device's language is followed, not pinned.
       Only an explicit pick in the menu below writes a preference. This also
       runs before the button check, so pages without the switcher are still
       translated. */
    applyLanguage(currentLang(), false);

    var btn = $('[data-lang-button]');
    if (!btn) return;

    var panel = null;

    function close() {
      if (!panel) return;
      panel.remove();
      panel = null;
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    }

    function open() {
      if (panel) { close(); return; }
      var cur = currentLang();

      /* Rows are built here rather than in the HTML so the names always come
         from the device, in the language being read right now. */
      var rows = LANG_CODES.map(function (c) {
        var own = langName(c);
        var here = langName(c, cur);
        var translated = TRANSLATED.indexOf(c) !== -1;
        /* The row keeps the page's direction so every row lines up; only the
           name itself is marked with its own language and direction, which is
           what makes Arabic and Sorani render correctly inside an otherwise
           left-to-right list. */
        return '<button type="button" class="langpick__item' +
          (c === cur ? ' is-on' : '') + '" data-lang-choose="' + escapeHtml(c) + '">' +
          '<span class="langpick__own" lang="' + escapeHtml(c) + '" dir="' + langDir(c) + '">' +
            escapeHtml(own) + '</span>' +
          (here && here !== own
            ? '<span class="langpick__alt">' + escapeHtml(here) + '</span>'
            : '') +
          (translated ? '<span class="langpick__tick" aria-hidden="true">✓</span>' : '') +
          '</button>';
      }).join('');

      panel = document.createElement('div');
      panel.className = 'langpick';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', t('lang.title', cur));
      panel.innerHTML =
        '<div class="langpick__scrim" data-lang-close></div>' +
        '<div class="langpick__panel">' +
          '<div class="langpick__head">' +
            '<h2 class="langpick__title">' + escapeHtml(t('lang.title', cur)) + '</h2>' +
            '<button type="button" class="langpick__close" data-lang-close ' +
              'aria-label="' + escapeHtml(t('lang.close', cur)) + '">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
            '</button>' +
          '</div>' +
          '<p class="langpick__note">' + escapeHtml(t('lang.note', cur)) + '</p>' +
          '<div class="langpick__list">' + rows + '</div>' +
        '</div>';

      document.body.appendChild(panel);
      btn.setAttribute('aria-expanded', 'true');

      panel.addEventListener('click', function (e) {
        if (e.target.closest('[data-lang-close]')) { close(); return; }
        var pick = e.target.closest('[data-lang-choose]');
        if (!pick) return;
        applyLanguage(pick.getAttribute('data-lang-choose'));
        close();
      });

      var first = $('.langpick__item.is-on', panel) || $('.langpick__item', panel);
      if (first) first.scrollIntoView({ block: 'center' });
      var closeBtn = $('.langpick__close', panel);
      if (closeBtn) closeBtn.focus();
    }

    btn.addEventListener('click', open);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel) close();
    });
  }

  function initHeader() {
    var header = $('[data-header]');
    var toggle = $('[data-nav-toggle]');
    var panel  = $('[data-mobile-nav]');
    if (!header) return;

    /* Shadow once the page is scrolled */
    var onScroll = function () {
      header.classList.toggle('is-stuck', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /* Mobile panel — opens with a CSS slide, closes with the mirror animation
       before the element is actually hidden. */
    var closing = null;

    function closeNav() {
      if (!toggle || !panel || panel.hidden) return;
      toggle.setAttribute('aria-expanded', 'false');

      if (!motionOK()) { panel.hidden = true; return; }

      panel.classList.add('is-closing');
      window.clearTimeout(closing);
      closing = window.setTimeout(function () {
        panel.classList.remove('is-closing');
        panel.hidden = true;
      }, 210);
    }

    function openNav() {
      if (!toggle || !panel) return;
      window.clearTimeout(closing);
      panel.classList.remove('is-closing');
      toggle.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
    }

    if (toggle && panel) {
      toggle.addEventListener('click', function () {
        var open = toggle.getAttribute('aria-expanded') === 'true';
        if (open) closeNav(); else openNav();
      });

      $$('a', panel).forEach(function (link) {
        link.addEventListener('click', closeNav);
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
          closeNav();
          toggle.focus();
        }
      });

      document.addEventListener('click', function (e) {
        if (panel.hidden) return;
        if (!panel.contains(e.target) && !toggle.contains(e.target)) closeNav();
      });

      window.matchMedia('(min-width: 768px)').addEventListener('change', closeNav);
    }

    /* The current page is marked with aria-current="page" in each HTML file,
       so navigation highlighting works even before this script runs. */
  }

  /* ------------------------------------------------------------------------
     4. Hero background video

     Plays muted and looped. Autoplay is skipped when the visitor asks for
     reduced motion, or when the browser reports a metered or slow connection —
     the poster frame shows instead and the button starts it by hand.
     ------------------------------------------------------------------------ */
  /* ------------------------------------------------------------------------
     Hero slideshow

     Every extra hero image is another download on a phone that may be paying
     per megabyte, so the loop is deliberately conservative:

       * the first slide is the one already in the HTML and always loads
       * the rest are fetched only after the page is idle, so nothing competes
         with first paint
       * a metered or slow connection, or reduced-motion, gets no loop at all
       * it stops while the tab is hidden or the hero is scrolled off screen,
         and stops for good if the background video takes over

     Slides are named by base name; the four responsive widths are derived, so
     adding a picture is dropping files in media/ and listing the name.
     ------------------------------------------------------------------------ */
  var HERO_WIDTHS_DEFAULT = [480, 750, 1080, 1280];

  /* "hero-rome:480|750|1080|1200" — the widths that actually exist for that
     picture. Sources are rarely all the same size, and listing widths that
     were never generated just produces 404s. Omit them to get the default set.
     tools/make-hero.py prints the exact string to paste. */
  function parseHeroSlide(entry) {
    var bits = entry.split(':');
    var name = bits[0].trim();
    var widths = bits[1]
      ? bits[1].split('|').map(Number).filter(function (n) { return n > 0; })
      : HERO_WIDTHS_DEFAULT.slice();
    return { name: name, widths: widths.sort(function (a, b) { return a - b; }) };
  }

  function heroSlideMarkup(slide) {
    function set(ext) {
      return slide.widths.map(function (w) {
        return 'media/' + slide.name + '-' + w + '.' + ext + ' ' + w + 'w';
      }).join(', ');
    }
    /* Fall back to the largest real size rather than assuming 750 exists. */
    var fallback = slide.widths.indexOf(750) !== -1 ? 750
                 : slide.widths[slide.widths.length - 1];
    var pic = document.createElement('picture');
    pic.innerHTML =
      '<source type="image/webp" srcset="' + set('webp') + '" sizes="100vw">' +
      '<img class="hero__slide" src="media/' + slide.name + '-' + fallback + '.jpg" ' +
      'srcset="' + set('jpg') + '" sizes="100vw" ' +
      'decoding="async" alt="">';
    return pic;
  }

  /* ------------------------------------------------------------------------
     Hero pictures from the bot

     data-hero-slides in the markup is the set that ships with the site, and it
     stays: Telegram is how an admin adds a picture, not how they replace the
     ones on file. Anything /hero returns is appended after them, so the poster
     still paints first and the uploads join the end of the loop.
     ------------------------------------------------------------------------ */
  function heroSlideFromBot(slide) {
    var pic = document.createElement('picture');
    var img = document.createElement('img');
    img.className = 'hero__slide';
    img.decoding = 'async';
    img.alt = '';
    if (slide.srcset) {
      img.setAttribute('srcset', slide.srcset);
      img.setAttribute('sizes', '100vw');
    }
    img.src = slide.src;
    pic.appendChild(img);
    return pic;
  }

  function loadHero(done) {
    var media = $('[data-hero-slides]');
    if (!media) { if (done) done(); return; }

    fetch('/hero', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (slides) {
        if (!slides || !slides.length) return;
        window.__heroFromBot = slides;
      })
      .catch(function () { /* not deployed, or offline — bundled pictures stand */ })
      .then(function () { if (done) done(); });
  }

  function initHeroSlides() {
    var media = $('[data-hero-slides]');
    if (!media) return;

    /* The pictures on file come first, then anything uploaded through the bot.
       Entry 0 is therefore always the bundled poster, which is the image
       already painted above the fold. */
    var entries = (media.getAttribute('data-hero-slides') || '')
      .split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      .map(parseHeroSlide);

    (window.__heroFromBot || []).forEach(function (s) {
      entries.push({ bot: s });
    });

    /* One picture is not a slideshow. */
    if (entries.length < 2) return;

    /* Stricter than the video gate on purpose, but not so strict it never
       runs: 3G is the normal connection across much of our audience, so
       blocking it would mean nobody ever sees the loop. Only an explicit
       Save-Data request, or a genuinely unusable 2G link, opts out. The extra
       slides still wait for idle, so they never delay the first paint. */
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var frugal = !!(conn && (conn.saveData || /^(2g|slow-2g)$/.test(conn.effectiveType || '')));
    if (frugal || reduceMotion.matches) return;

    var still = $('.hero__still', media);
    var slides = [];
    var shown = 0;
    var timer = null;

    /* Slide 0 is the existing still — reuse it rather than downloading it
       twice under a different element. */
    function build() {
      entries.slice(1).forEach(function (slide) {
        var pic = slide.bot ? heroSlideFromBot(slide.bot) : heroSlideMarkup(slide);
        /* Behind the scrim, above the still. */
        media.insertBefore(pic, $('.hero__scrim', media));
        slides.push($('img', pic));
      });
    }

    /* Index 0 is the original still, which is always opaque at the bottom.
       Slide n in `slides` is entry n + 1.

       Exactly one layer is ever allowed to animate, and it always fades
       against something solid:

         moving forward   the incoming slide fades in over the opaque stack
         wrapping to 0    the top slide fades out to reveal the still

       Everything else is snapped with the transition switched off — those
       layers sit behind an opaque one, so the change cannot be seen. */
    function show(i) {
      slides.forEach(function (img, n) {
        var idx = n + 1;
        var animate = (idx === i) || (i === 0 && idx === shown);
        var on = idx <= i;

        img.classList.toggle('is-instant', !animate);
        img.classList.toggle('is-on', on);
      });

      /* Re-enable transitions on the snapped layers once the browser has
         applied this frame, ready for the next step. */
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          slides.forEach(function (img) { img.classList.remove('is-instant'); });
        });
      });

      shown = i;

      /* The departure board flips its destination in sync with the photo. */
      window.dispatchEvent(new CustomEvent('hero:slide', {
        detail: { name: entries[shown].name || (entries[shown].bot || {}).id || '' }
      }));
    }

    function tick() {
      show((shown + 1) % entries.length);
    }

    function start() {
      if (timer) return;
      timer = window.setInterval(tick, 4200);
    }

    function stop() {
      window.clearInterval(timer);
      timer = null;
    }

    /* Wait for idle so the slides never compete with the hero image, the
       fonts or the vacancies fetch. requestIdleCallback is missing on Safari,
       hence the timeout fallback. */
    var begin = function () {
      build();

      /* Do not start until the second image can actually paint, or the first
         transition would fade to an empty frame. */
      var first = slides[0];
      var go = function () {
        if (!document.hidden) start();
      };
      if (first.complete) go();
      else first.addEventListener('load', go, { once: true });
      first.addEventListener('error', function () { stop(); }, { once: true });
    };

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(begin, { timeout: 3000 });
    } else {
      window.setTimeout(begin, 1200);
    }

    /* Nothing animates that nobody is looking at. */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else if (slides.length) start();
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { if (slides.length) start(); } else stop();
        });
      }, { threshold: 0.1 }).observe(media);
    }

    /* If a background clip loads on desktop it covers the stills entirely —
       cycling underneath it would burn battery for nothing. */
    var video = $('[data-hero-video]');
    if (video) video.addEventListener('canplay', stop, { once: true });

    /* Honour a mid-visit change to the OS motion setting. */
    var onMotion = function () {
      if (reduceMotion.matches) { stop(); show(0); }
    };
    if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotion);
    else if (reduceMotion.addListener) reduceMotion.addListener(onMotion);

    /* Keep a reference so the still is never garbage-collected mid-fade. */
    void still;
  }

  /* ------------------------------------------------------------------------
     Split-flap placement board

     Rows are built from BOARD_ROWS, one per hero photo — but this is a job
     board, not a flight board: each row is a live vacancy in that
     destination, and the flap rolls between the real roles Aryos is
     recruiting there. When the hero slideshow advances it fires hero:slide
     and the matching row lights up with a split-flap roll while the photo
     behind it changes. The board also runs on its own slow timer so it
     stays alive where the slideshow has opted out (metered connections,
     video takeover); a hero:slide always resets the self-timer so the two
     never flip together. Reduced motion swaps the role instantly instead of
     rolling letters. Roles and countries come from the same dictionaries
     the jobs list uses, so every language sees the board in its own words.
     ------------------------------------------------------------------------ */
  var BOARD_ROWS = [
    { name: 'hero-london',  ref: 'KG-114', roles: ['Warehouse Operative', 'Care Assistant'],
      city: 'London', country: 'United Kingdom', visa: 'SKILLED WORKER' },
    { name: 'hero-newyork', ref: 'KG-207', roles: ['Commercial Electrician', 'CDL Truck Driver'],
      city: 'New York', country: 'USA', visa: 'WORK VISA' },
    { name: 'hero-paris',   ref: 'KG-312', roles: ['Hotel Housekeeping', 'Kitchen Assistant'],
      city: 'Paris', country: 'France', visa: 'SCHENGEN' },
    { name: 'hero-rome',    ref: 'KG-452', roles: ['Restaurant Waiter', 'Truck Driver'],
      city: 'Rome', country: 'Italy', visa: 'SCHENGEN' },
    { name: 'hero-poster',  ref: 'KG-001', roles: ['List a vacancy'],
      city: 'Aryos Hub', country: 'Group HQ', visa: 'EMPLOYERS' }
  ];
  var BOARD_MS = 5600;
  var FLAP_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  /* Painted text is re-rendered on language switches, so the live role index
     per row lives out here where paintBoard can read it. */
  var BOARD_STATE = null;

  function boardRowMarkup(f) {
    return '<div class="board__row is-idle" data-row="' + f.name + '">' +
      '<span class="board__ref">' + f.ref + '</span>' +
      '<span class="board__dest">' +
        '<span class="flap"><span class="flap__inner" data-flap>' +
          tr(f.roles[0]).toUpperCase() + '</span></span>' +
        '<span class="board__city"><span data-city>' + f.city + '</span>' +
          ' · <span data-country>' + tr(f.country) + '</span></span>' +
      '</span>' +
      '<span class="board__visa">' + f.visa + '</span>' +
      '<span class="board__status" data-status>' + tr('VERIFIED') + '</span>' +
    '</div>';
  }

  function initBoard() {
    var root = $('[data-board]');
    if (!root) return;
    var rows = $('[data-board-rows]', root);
    if (!rows || !BOARD_ROWS.length) return;

    var head = '<div class="board__row board__row--head" aria-hidden="true">' +
      '<span>Ref</span><span>Role · Destination</span><span>Visa</span><span>Status</span></div>';
    rows.innerHTML = head + BOARD_ROWS.map(boardRowMarkup).join('');

    var cells = BOARD_ROWS.map(function (f) {
      return { name: f.name, row: $('[data-row="' + f.name + '"]', rows) };
    });
    var active = 0;
    var roleIdx = BOARD_ROWS.map(function () { return 0; });
    var timer = null;
    var visible = true;
    BOARD_STATE = { active: 0, roleIdx: roleIdx };

    function scramble(s) {
      return s.split('').map(function (ch) {
        return ch === ' ' ? ' ' : FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)];
      }).join('');
    }

    /* Roll a burst of random letters, then slam the real text in with a 3D
       flip. Reduced motion skips straight to the answer. */
    function flipCell(cell, finalText) {
      var inner = $('[data-flap]', cell);
      var flap = $('.flap', cell);
      if (!inner) return;
      if (reduceMotion.matches) { inner.textContent = finalText; return; }
      var steps = 5, delay = 46, n = 0;
      (function step() {
        if (n < steps) {
          n++;
          inner.textContent = scramble(finalText);
          window.setTimeout(step, delay);
        } else {
          inner.textContent = finalText;
          if (flap) flap.classList.add('is-flipping');
          window.setTimeout(function () { if (flap) flap.classList.remove('is-flipping'); }, 420);
        }
      })();
    }

    function setActive(i, animate) {
      active = (i + cells.length) % cells.length;
      BOARD_STATE.active = active;
      cells.forEach(function (c, n) {
        var isOn = n === active;
        c.row.classList.toggle('is-on', isOn);
        c.row.classList.toggle('is-idle', !isOn);
        var st = $('[data-status]', c.row);
        if (st) st.textContent = isOn ? tr('NOW HIRING') : tr('VERIFIED');
      });
      if (animate) {
        var f = BOARD_ROWS[active];
        roleIdx[active] = (roleIdx[active] + 1) % f.roles.length;
        flipCell($('.board__dest', cells[active].row), tr(f.roles[roleIdx[active]]).toUpperCase());
      }
    }

    /* The hero's still is the poster, so the Aryos employer row starts lit. */
    setActive(BOARD_ROWS.length - 1, false);

    function startTimer() {
      if (!timer) timer = window.setInterval(function () {
        setActive(active + 1, true);
      }, BOARD_MS);
    }
    function stopTimer() {
      if (timer) { window.clearInterval(timer); timer = null; }
    }
    function resetTimer() {
      stopTimer();
      if (visible && !document.hidden) startTimer();
    }

    document.addEventListener('visibilitychange', resetTimer);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { visible = e.isIntersecting; resetTimer(); });
      }, { threshold: 0.15 }).observe(root);
    }

    /* Photo flips, board flips — and the self-timer is rescheduled so the
       two never double-flip. */
    window.addEventListener('hero:slide', function (e) {
      var name = e.detail && e.detail.name;
      if (!name) return;
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].name === name) { setActive(i, true); resetTimer(); return; }
      }
    });

    /* Local time in the head, like a real status screen. The page's own
       language is preferred so Arabic visitors get Arabic digits. */
    var clock = $('[data-board-clock]', root);
    var paintClock = function () {
      var t = new Date().toLocaleTimeString([currentLang() || 'en', 'en'],
        { hour: '2-digit', minute: '2-digit' });
      if (clock && clock.textContent !== t) clock.textContent = t;
    };
    paintClock();
    window.setInterval(paintClock, 1000);

    resetTimer();
  }

  /* Language repaint: roles, countries, statuses and the title all come from
     the dictionaries. The flap text is re-set without a roll. */
  function paintBoard() {
    if (!BOARD_STATE) return;
    var rows = $('[data-board-rows]');
    if (!rows) return;
    $$('[data-row]', rows).forEach(function (row) {
      var name = row.getAttribute('data-row');
      var isOn = row.classList.contains('is-on');
      var st = $('[data-status]', row);
      if (st) st.textContent = isOn ? tr('NOW HIRING') : tr('VERIFIED');
      for (var i = 0; i < BOARD_ROWS.length; i++) {
        if (BOARD_ROWS[i].name !== name) continue;
        var f = BOARD_ROWS[i];
        var role = f.roles[BOARD_STATE.roleIdx[i] % f.roles.length];
        var flap = $('[data-flap]', row);
        if (flap) flap.textContent = tr(role).toUpperCase();
        var country = $('[data-country]', row);
        if (country) country.textContent = tr(f.country);
        break;
      }
    });
    var title = $('[data-board] .board__title');
    if (title) title.textContent = tr('PLACEMENTS').toUpperCase();
  }

    /* ------------------------------------------------------------------------
     Dotted world map — magicui.design/docs/components/dotted-map

     The React component builds its dot field with svg-dotted-map's
     createMap({ width, height, mapSamples }), draws one <circle> per
     sample, shifts alternate rows by half a step and pulses markers
     with SMIL <animate>. Same idea here, minus React and minus the
     npm package: MAP_ROWS below is the land source the sampler reads
     (a 180x72 bitmap on a 2-degree grid, 84N..60S, Antarctica left
     off the way dotted maps usually draw it), and the markers are the
     countries actually hiring, each one a link into the filtered job
     list. Reduced motion keeps the map and drops the pulses.
     ------------------------------------------------------------------------ */
  var MAP_ROWS = [
    '000000000000000000000000000000000000000000000000011111111000000000001111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000010111111111110011111111111111111111111110000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000011000011101111100001111111111111111111111110000000000000000111110000000000000000000000000000000000000111100000000000000000000000000000000000000',
    '000000000000000000000000000000110000000000100111110000111111111111111111111111111000000000000000001000000000000000000000000000000000000000000110000000000000000000000000000000000000',
    '000000000000000000000000000000000011100010101111110000000000011111111111111111110000000000000000000000000000000000000011000000000000011111111111110000000000000111011000000000000000',
    '000000000000000000000000000011101000100010110111101100000000001111111111111111100000000000000000000000000000000000001100000000000011111111111111111111101100000000000000000000000000',
    '100000000001100000000000000010011111110000110011111111000000000011111111111110100000000000000000000000110000000000000100000111011111111111111111111111111110111111111100100000000001',
    '000000001111111111111011111111100111001001011101100011110000000011111111111110000000000000000000000111111111000000000000111011011111111111111111111111111111111111111111111111011111',
    '111000001111111111111111111111111111111111111111100001111100000111111111100000000000000000000000011111111111111010111111111111011111111111111111111111111111111111111111111111111111',
    '001100011111111111111111111111111111111111111101000111111000000011111100000000011110000000000000111110011110101111111111111111111111111111111111111111111111111111111111111111111111',
    '000000001111111111111111111111111111111111111000000000110100000001111000000000000000000000000011111001111111111111111111111111111111111111111111111111111111111111111111111111111111',
    '000000011111110111111111111111111111111111100000000111100000000000111000000000000000000000000111111001111111111111111111111111111111111111111111111111111111111111111111001011110000',
    '000000000111100000000111111111111111111111100000000111100100000000000000000000000000000000000111111000111111111111111111111111111111111111111111111111111111111110000010001000000000',
    '000000000001000000000001111111111111111111111000000011111110000000000000000000000000000110000010110001111111111111111111111111111111111111111111111111111111111000000000111100000000',
    '000000001000000000000000011111111111111111111111100111111111100000000000000000000000001110000010000011111111111111111111111111111111111111111111111111111111110000000000111000000000',
    '000000000000000000000000011111111111111111111111100111111111110000000000000000000000011011001111111111111111111111111111111111111111111111111111111111111111111111000000100000000000',
    '000000000000000000000000001111111111111111111111111111111111110000000000000000000000000011011111111111111111111111111111111111111111111111111111111111111111111101000000000000000000',
    '000000000000000000000000000101111111111111111111111111110100011000000000000000000000000001111111111111111111111111111111111111111111111111111111111111111111111101000000000000000000',
    '000000000000000000000000000011111111111111111111111111111100000100000000000000000000000001111111111111111111111111111111111111111111111111111111111111111111111001000000000000000000',
    '000000000000000000000000000011111111111111111111111111110110000000000000000000000000000001111111011111111001011111001111111111111111111111111111111111111111110000000000000000000000',
    '000000000000000000000000000011111111111111111111111111100000000000000000000000000000011111110001100111110000001111001111111111111111111111111111111111111111100011000000000000000000',
    '000000000000000000000000000011111111111111111111111111000000000000000000000000000000001111000010011011110111111111100111111111111111111111111111111111111110000010000000000000000000',
    '000000000000000000000000000011111111111111111111111100000000000000000000000000000000011111000000001011011111111111100111111111111111111111111111111110000100000010000000000000000000',
    '000000000000000000000000000001111111111111111111111100000000000000000000000000000000000110000111010000001111111111100111111111111111111111111111111111100110001100000000000000000000',
    '000000000000000000000000000000111111111111111111111100000000000000000000000000000000000111111110000000100010111111111111111111111111111111111111111111000100111100000000000000000000',
    '000000000000000000000000000000011111111111111111110000000000000000000000000000000000001111111111000000000000111111111111111111111111111111111111111111000001100000000000000000000000',
    '000000000000000000000000000000001111111111111111100000000000000000000000000000000000011111111111111011110111111111111111111111111111111111111111111111100000000000000000000000000000',
    '000000000000000000000000000000000011111111000000010000000000000000000000000000000000011111111111111111111111111111011111111111111111111111111111111111100000000000000000000000000000',
    '000000000000000000000000000000000101111110000000010000000000000000000000000000000001111111111111111111111110111111100111111111111111111111111111111111000000000000000000000000000000',
    '000000000000000000000000000000000010111110000000000000000000000000000000000000000001111111111111111111111110011111110100000111111111111111111111111111000000000000000000000000000000',
    '000000000000000000000000000000000000011110000000110000000000000000000000000000000011111111111111111111111111011111111111000001111111111111111111111100100000000000000000000000000000',
    '000000000000000000000000000000000000011110000110000100000000000000000000000000000111111111111111111111111111101111111110000001111111110011111111000000000000000000000000000000000000',
    '000000000000000000000000000000000000001111001100000000100000000000000000000000000011111111111111111111111111100111111110000000111111000001111110100000000000000000000000000000000000',
    '000000000000000000000000000000000000000011111100000000000000000000000000000000000011111111111111111111111111100111111000000000011110000001111111000000100000000000000000000000000000',
    '000000000000000000000000000000000000000000001111000000000000000000000000000000000111111111111111111111111111110111100000000000011100000000011111000000100000000000000000000000000000',
    '000000000000000000000000000000000000000000000011000000000000000000000000000000000011111111111111111111111111111010000000000000011100000000011111100000100000000000000000000000000000',
    '000000000000000000000000000000000000000000000001000011110000000000000000000000000011111111111111111111111111111100110000000000001100000000010011000000001000000000000000000000000000',
    '000000000000000000000000000000000000000000000000101011111111000000000000000000000001111111111111111111111111111111100000000000001010000000010010000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000111111111100000000000000000000000111111111111111111111111111111100000000000000010000000000000000000001000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000111111111111100000000000000000000011010000111111111111111111111000000000000000000000000101100000110000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000111111111111110000000000000000000000000000001111111111111111110000000000000000000000000010100001110000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000001111111111111110000000000000000000000000000001111111111111111100000000000000000000000000011000011110100000000000000000000000000000',
    '000000000000000000000000000000000000000000000000001111111111111111100000000000000000000000000011111111111111111000000000000000000000000000001100011110000001100000000000000000000000',
    '000000000000000000000000000000000000000000000000001111111111111111111100000000000000000000000001111111111111110000000000000000000000000000000110011101100010101110000000000000000000',
    '000000000000000000000000000000000000000000000000011111111111111111111111000000000000000000000000111111111111110000000000000000000000000000000010000000010000000111100000000000000000',
    '000000000000000000000000000000000000000000000000001111111111111111111111100000000000000000000000111111111111110000000000000000000000000000000001110000000000000111110000100000000000',
    '000000000000000000000000000000000000000000000000000111111111111111111111000000000000000000000000111111111111110000000000000000000000000000000000000010001000000011010000001000000000',
    '000000000000000000000000000000000000000000000000000111111111111111111110000000000000000000000000011111111111110000000000000000000000000000000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000011111111111111111110000000000000000000000000111111111111110000100000000000000000000000000000000000000001110001000000000000000000',
    '000000000000000000000000000000000000000000000000000011111111111111111110000000000000000000000000111111111111110000100000000000000000000000000000000000001111110001100000000001000000',
    '000000000000000000000000000000000000000000000000000000111111111111111100000000000000000000000000111111111111100011100000000000000000000000000000000000011111111001100000000000000000',
    '000000000000000000000000000000000000000000000000000000011111111111111100000000000000000000000000111111111111000011100000000000000000000000000000000000011111111111100000000000000000',
    '000000000000000000000000000000000000000000000000000000011111111111111100000000000000000000000000011111111111000011000000000000000000000000000000000011111111111111111000000010000000',
    '000000000000000000000000000000000000000000000000000000011111111111110000000000000000000000000000011111111111000011000000000000000000000000000000000111111111111111111000000000000000',
    '000000000000000000000000000000000000000000000000000000011111111111000000000000000000000000000000011111111110000010000000000000000000000000000000000111111111111111111100000000000000',
    '000000000000000000000000000000000000000000000000000000011111111111000000000000000000000000000000001111111100000000000000000000000000000000000000000111111111111111111110000000000000',
    '000000000000000000000000000000000000000000000000000000111111111110000000000000000000000000000000001111111100000000000000000000000000000000000000000111111111111111111110000000000000',
    '000000000000000000000000000000000000000000000000000000111111111110000000000000000000000000000000000111111000000000000000000000000000000000000000000011111111111111111110000000000000',
    '000000000000000000000000000000000000000000000000000000111111111100000000000000000000000000000000000111110000000000000000000000000000000000000000000011110000011111111100000000000000',
    '000000000000000000000000000000000000000000000000000000111111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000111111000000000001000',
    '000000000000000000000000000000000000000000000000000001111111110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011111000000000000100',
    '000000000000000000000000000000000000000000000000000001111110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000110',
    '000000000000000000000000000000000000000000000000000001111010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000110000000000001100',
    '000000000000000000000000000000000000000000000000000000111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000011000',
    '000000000000000000000000000000000000000000000000000001111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000110000',
    '000000000000000000000000000000000000000000000000000001111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000011110000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000011100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000001110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  ];

  /* The bitmap covers -180..180 of longitude and 84N..60S of latitude. */
  var MAP_LON_MIN = -180, MAP_LON_SPAN = 360;
  var MAP_LAT_MAX = 84,   MAP_LAT_SPAN = 144;

  /* The component's props, as one object because there is no JSX to pass
     them in. width/height keep the bitmap's 2.5:1 ratio so nothing is
     stretched, and mapSamples is the same target-number-of-dots knob. */
  var DOTMAP = {
    width: 240,
    height: 96,
    mapSamples: 6000,
    dotRadius: 0.42,
    stagger: true,
    markerRadius: 0.9,
    originRadius: 1.2,
    hitRadius: 1.6,   /* under half a cell — see dotMarkerMarkup */
    reachRadius: 3.5  /* how far a pointer may miss a pin and still hit it */
  };

  /* Capital coordinates [lat, lng] for every country the site can list, so a
     country the admin adds in Telegram gets a pin without a code change here.
     A country with no entry simply has no pin; the grid below still lists it. */
  var COUNTRY_PINS = {
    'Germany':        [52.520,  13.405],
    'Netherlands':    [52.370,   4.895],
    'Belgium':        [50.851,   4.352],
    'United Kingdom': [51.507,  -0.128],
    'Ireland':        [53.350,  -6.260],
    'France':         [48.857,   2.352],
    'Poland':         [52.230,  21.012],
    'Austria':        [48.209,  16.373],
    'Switzerland':    [46.948,   7.447],
    'Czechia':        [50.076,  14.438],
    'Slovakia':       [48.146,  17.107],
    'Hungary':        [47.498,  19.040],
    'Romania':        [44.427,  26.103],
    'Croatia':        [45.815,  15.982],
    'Sweden':         [59.329,  18.069],
    'Norway':         [59.914,  10.752],
    'Finland':        [60.170,  24.938],
    'Denmark':        [55.677,  12.569],
    'Estonia':        [59.437,  24.754],
    'Latvia':         [56.949,  24.105],
    'Lithuania':      [54.687,  25.280],
    'Italy':          [41.903,  12.496],
    'Spain':          [40.417,  -3.704],
    'Portugal':       [38.722,  -9.139],
    'Greece':         [37.984,  23.728],
    'Malta':          [35.899,  14.514],
    'USA':            [38.907, -77.037],
    'Canada':         [45.421, -75.697]
  };

  var MAP_ORIGIN = [36.191, 44.011]; /* Erbil — where our candidates start */

  /* createMap: the sampler svg-dotted-map provides. Returns the dot field and
     an addMarkers() that snaps lat/lng onto it, exactly like the package. */
  function createMap(opts) {
    var width = opts.width, height = opts.height;
    var spacing = Math.sqrt((width * height) / opts.mapSamples);
    var cols = Math.max(1, Math.round(width / spacing));
    var rows = Math.max(1, Math.round(height / spacing));
    var xStep = width / cols, yStep = height / rows;

    var bmpCols = MAP_ROWS[0].length, bmpRows = MAP_ROWS.length;

    /* Alternate rows shift half a step so the field reads as a honeycomb
       instead of as columns. The component offsets when it draws; doing it
       here keeps the land test honest — a dot survives only when the spot it
       is actually drawn at is land. */
    function rowOffset(row) {
      return opts.stagger && row % 2 === 1 ? xStep / 2 : 0;
    }

    /* The sample grid is coarser than the bitmap, so a dot is land when any
       bitmap cell under it is land. Coastlines come out a touch generous,
       but Britain, Japan and New Zealand survive the downsample. */
    function isLand(x, y) {
      var cx = (x / width) * bmpCols, cy = (y / height) * bmpRows;
      var rx = (xStep / width) * bmpCols / 2, ry = (yStep / height) * bmpRows / 2;
      for (var r = Math.floor(cy - ry); r <= Math.floor(cy + ry); r++) {
        if (r < 0 || r >= bmpRows) continue;
        var row = MAP_ROWS[r];
        for (var c = Math.floor(cx - rx); c <= Math.floor(cx + rx); c++) {
          var wrapped = ((c % bmpCols) + bmpCols) % bmpCols; /* wrap at the date line */
          if (row.charAt(wrapped) === '1') return true;
        }
      }
      return false;
    }

    var points = [];
    for (var r = 0; r < rows; r++) {
      var y = (r + 0.5) * yStep;
      var offset = rowOffset(r);
      for (var c = 0; c < cols; c++) {
        var x = (c + 0.5) * xStep + offset;
        if (x > width || !isLand(x, y)) continue;
        points.push({ x: x, y: y });
      }
    }

    function cellX(cell) { return (cell.col + 0.5) * xStep + rowOffset(cell.row); }
    function cellY(cell) { return (cell.row + 0.5) * yStep; }

    /* Two capitals can share one cell of a grid this coarse — Amsterdam and
       Brussels do. The package would stack them; we walk out to the nearest
       free cell instead, preferring one that is land, so every hiring country
       stays its own target and no pin ends up adrift in the sea. */
    var taken = {};
    function place(col, row) {
      var spare = null;
      for (var ring = 0; ring <= 2; ring++) {
        for (var dr = -ring; dr <= ring; dr++) {
          for (var dc = -ring; dc <= ring; dc++) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
            var cell = { col: col + dc, row: row + dr };
            if (cell.row < 0 || cell.row >= rows || cell.col < 0 || cell.col >= cols) continue;
            if (taken[cell.col + ':' + cell.row]) continue;
            if (!isLand(cellX(cell), cellY(cell))) { spare = spare || cell; continue; }
            taken[cell.col + ':' + cell.row] = true;
            return cell;
          }
        }
      }
      if (spare) { taken[spare.col + ':' + spare.row] = true; return spare; }
      return { col: col, row: row };
    }

    function addMarkers(list) {
      taken = {};
      return list.map(function (marker) {
        var x = ((marker.lng - MAP_LON_MIN) / MAP_LON_SPAN) * width;
        var y = ((MAP_LAT_MAX - marker.lat) / MAP_LAT_SPAN) * height;
        var row = Math.min(rows - 1, Math.max(0, Math.round(y / yStep - 0.5)));
        var col = Math.min(cols - 1, Math.max(0, Math.round((x - rowOffset(row)) / xStep - 0.5)));
        var cell = place(col, row);
        var out = { x: cellX(cell), y: cellY(cell) };
        for (var k in marker) { if (k !== 'lat' && k !== 'lng') out[k] = marker[k]; }
        return out;
      });
    }

    return { points: points, addMarkers: addMarkers };
  }

  var DOT_MAP = null;  /* the sampler result — the dot field is built once */
  var DOT_PINS = [];   /* placed markers, kept for the pointer hit test */

  /* One marker: hit area, pulse rings, pin. Wrapped in an <a> so a click
     lands on the filtered job list. */
  function dotMarkerMarkup(marker, index) {
    var x = marker.x.toFixed(2), y = marker.y.toFixed(2);
    var r = marker.size || DOTMAP.markerRadius;
    var rings = '';

    if (marker.pulse && motionOK()) {
      /* The component's expanding rings, slowed from 1.4s to the calmer
         cadence the rest of the page animates at, and started at staggered
         times so a dozen pins do not beat in lockstep. */
      var to = (r * 2.8).toFixed(2);
      var lead = (index % 5) * 0.4;
      rings = [0, 1.2].map(function (delay) {
        return '<circle class="dotmap__ping" cx="' + x + '" cy="' + y + '" r="' + r + '">' +
                 '<animate attributeName="r" values="' + r + ';' + to + '" dur="2.4s"' +
                   ' begin="' + (lead + delay).toFixed(1) + 's" repeatCount="indefinite"/>' +
                 '<animate attributeName="opacity" values="0.9;0" dur="2.4s"' +
                   ' begin="' + (lead + delay).toFixed(1) + 's" repeatCount="indefinite"/>' +
               '</circle>';
      }).join('');
    }

    /* The click target is kept under half a cell so it can never swallow the
       pin next door — Europe is only a couple of cells wide here. Anything
       looser than that is handled by the nearest-pin search below, which
       picks by distance instead of by which marker was drawn last. */
    var pin = rings +
      '<circle class="dotmap__hit" cx="' + x + '" cy="' + y + '" r="' + DOTMAP.hitRadius + '"/>' +
      '<circle class="dotmap__pin" cx="' + x + '" cy="' + y + '" r="' + r + '"/>';

    if (!marker.country) return '<g class="dotmap__marker dotmap__marker--origin">' + pin + '</g>';

    return '<a class="dotmap__marker" tabindex="-1" href="' + marker.href + '"' +
             ' data-pin="' + escapeHtml(marker.country) + '">' + pin + '</a>';
  }

  /* Markers are redrawn whenever the vacancies or the language change: the
     label carries the live count and the pin only pulses while that country
     has something open. */
  function paintDotMarkers() {
    var layer = $('[data-dotmap-markers]');
    if (!layer || !DOT_MAP) return;

    var markers = [{ lat: MAP_ORIGIN[0], lng: MAP_ORIGIN[1], size: DOTMAP.originRadius, pulse: true }];

    COUNTRIES.forEach(function (c) {
      var at = COUNTRY_PINS[c.name];
      if (!at) return;
      var open = JOBS.filter(function (j) { return j.country === c.name; }).length;
      var count = open === 0 ? tr('Register interest')
                : open === 1 ? '1 ' + tr('open role')
                : open + ' ' + tr('open roles');
      markers.push({
        lat: at[0], lng: at[1],
        pulse: open > 0,
        country: c.name,
        href: 'jobs.html?country=' + encodeURIComponent(c.name),
        label: flagFor(c.name) + '  ' + tr(c.name) + ' · ' + count
      });
    });

    DOT_PINS = DOT_MAP.addMarkers(markers);
    layer.innerHTML = DOT_PINS.map(dotMarkerMarkup).join('');

    /* Markup order is marker order, so each pin keeps a handle on its own
       node — that is what the pointer search highlights. */
    DOT_PINS.forEach(function (pin, i) { pin.node = layer.children[i] || null; });
  }

  function initDottedMap() {
    var root = $('[data-dotmap]');
    var stage = $('[data-dotmap-stage]', root || document);
    var tip = $('[data-dotmap-tip]', root || document);
    if (!root || !stage) return;

    DOT_MAP = createMap(DOTMAP);

    /* The dot field never changes, so it goes in as one string rather than a
       few thousand createElementNS calls. */
    var dots = DOT_MAP.points.map(function (p) {
      return '<circle cx="' + p.x.toFixed(2) + '" cy="' + p.y.toFixed(2) + '" r="' + DOTMAP.dotRadius + '"/>';
    }).join('');

    stage.insertAdjacentHTML('afterbegin',
      '<svg class="dotmap__svg" viewBox="0 0 ' + DOTMAP.width + ' ' + DOTMAP.height + '"' +
        ' aria-hidden="true" focusable="false">' +
        '<g class="dotmap__dots" fill="currentColor">' + dots + '</g>' +
        '<g data-dotmap-markers></g>' +
      '</svg>');

    paintDotMarkers();

    /* Pins are a couple of viewBox units apart in Europe, which is a few
       pixels on a phone. So the pointer is matched to the *nearest* pin
       within a forgiving radius rather than to whatever shape it happens to
       be over — the map stays usable without pins the size of Denmark. */
    function nearest(ev) {
      var box = stage.getBoundingClientRect();
      if (!box.width) return null;
      var x = (ev.clientX - box.left) / box.width * DOTMAP.width;
      var y = (ev.clientY - box.top) / box.height * DOTMAP.height;
      var best = null, bestDist = DOTMAP.reachRadius;
      DOT_PINS.forEach(function (pin) {
        if (!pin.country) return;
        var d = Math.sqrt((pin.x - x) * (pin.x - x) + (pin.y - y) * (pin.y - y));
        if (d <= bestDist) { bestDist = d; best = pin; }
      });
      return best;
    }

    /* The label is HTML rather than SVG <text> so it picks up the page's
       type, its shadow and RTL for free. The pin grows with it, so the map
       always says which country the label belongs to. */
    var hot = null;
    function show(pin) {
      if (hot && hot !== (pin && pin.node)) hot.classList.remove('is-hot');
      hot = pin ? pin.node : null;
      if (hot) hot.classList.add('is-hot');

      if (!tip) return;
      if (!pin) { tip.hidden = true; return; }
      tip.textContent = pin.label;
      tip.style.left = (pin.x / DOTMAP.width * 100).toFixed(3) + '%';
      tip.style.top = (pin.y / DOTMAP.height * 100).toFixed(3) + '%';
      tip.hidden = false;
    }

    stage.addEventListener('pointermove', function (ev) { show(nearest(ev)); });
    stage.addEventListener('pointerleave', function () { show(null); });

    /* A finger never leaves the map, it just lifts, so a touched label clears
       itself once it has been read rather than sitting there for good. */
    var clear = null;
    stage.addEventListener('pointerdown', function (ev) {
      window.clearTimeout(clear);
      show(nearest(ev));
      if (ev.pointerType === 'touch') clear = window.setTimeout(function () { show(null); }, 2000);
    });

    /* A click inside a pin's own <a> is already a link; this only catches the
       near misses, so a tap next to a pin opens the same filtered list.

       Not on touch, though. reachRadius is a few pixels once the map is phone
       sized, and the pins around the Low Countries are closer together than
       that — "nearest" would confidently pick the wrong country. Fingers get
       the label on tap and use the country grid below to navigate. */
    var coarse = window.matchMedia('(pointer: coarse)');
    stage.addEventListener('click', function (ev) {
      if (coarse.matches) return;
      if (ev.target.closest && ev.target.closest('a')) return;
      var pin = nearest(ev);
      if (pin) window.location.href = pin.href;
    });
  }

  /* ------------------------------------------------------------------------
     Morphing wordmark — magicui.design/docs/components/morphing-text

     The React component holds two <span>s on top of each other, blurs one up
     as it fades the other down, and runs the pair through an SVG threshold
     filter so the letters melt into one another instead of just cross-fading.
     Ported here as plain DOM on one shared rAF loop.

     The words come from the logo lockup itself, so the cycle is ARYOS, then
     GROUP on its own, then the two together — and renaming the company stays
     a one-line edit in the markup. Without JS, or when the visitor asks for
     reduced motion, the stacked lockup is left exactly as it is.
     ------------------------------------------------------------------------ */
  var MORPH_TIME = 1.5;      /* seconds spent morphing one word into the next */
  var MORPH_COOLDOWN = 0.5;  /* seconds the finished word is held still */

  var MORPHS = [];
  var morphRunning = false;
  var morphLast = 0;

  /* The states are markup rather than plain strings so the third one can be
     the real lockup — big name, small sub — instead of one long line. Writing
     it only when the word actually changes keeps the per-frame work down to
     the two style properties the component animates. */
  function morphFill(span, html) {
    if (span.getAttribute('data-shown') === html) return;
    span.setAttribute('data-shown', html);
    span.innerHTML = html;
  }

  function morphStyles(inst, fraction) {
    /* The component divides by the fraction, which is what makes the blur run
       away to nothing at the edges of the morph. The blur is scaled to the
       type size here — 8px is right for the demo's 53px display type and pure
       soup on a 20px wordmark. */
    var incoming = Math.max(fraction, 0.001);
    var outgoing = Math.max(1 - fraction, 0.001);
    var base = inst.blur;

    inst.b.style.filter = 'blur(' + Math.min(base / incoming - base, 100).toFixed(2) + 'px)';
    inst.b.style.opacity = Math.pow(incoming, 0.4) * 100 + '%';
    inst.a.style.filter = 'blur(' + Math.min(base / outgoing - base, 100).toFixed(2) + 'px)';
    inst.a.style.opacity = Math.pow(outgoing, 0.4) * 100 + '%';

    morphFill(inst.a, inst.texts[inst.index % inst.texts.length]);
    morphFill(inst.b, inst.texts[(inst.index + 1) % inst.texts.length]);
  }

  function morphSettle(inst) {
    inst.morph = 0;
    inst.b.style.filter = 'none';
    inst.b.style.opacity = '100%';
    inst.a.style.filter = 'none';
    inst.a.style.opacity = '0%';
  }

  function morphTick(now) {
    /* A tab that has been in the background hands back one enormous frame;
       clamping it keeps the wordmark from jumping a whole word on return. */
    var dt = Math.min((now - morphLast) / 1000, 0.05);
    morphLast = now;

    var live = 0;
    MORPHS.forEach(function (inst) {
      if (!inst.visible) return;
      live++;
      inst.cooldown -= dt;
      if (inst.cooldown > 0) { morphSettle(inst); return; }

      inst.morph -= inst.cooldown;  /* cooldown is negative — this adds the overshoot */
      inst.cooldown = 0;

      var fraction = inst.morph / MORPH_TIME;
      if (fraction > 1) { inst.cooldown = MORPH_COOLDOWN; fraction = 1; }
      morphStyles(inst, fraction);
      if (fraction === 1) inst.index++;
    });

    if (!live || document.hidden) { morphRunning = false; return; }
    window.requestAnimationFrame(morphTick);
  }

  function morphStart() {
    if (morphRunning || document.hidden) return;
    if (!MORPHS.some(function (inst) { return inst.visible; })) return;
    morphRunning = true;
    morphLast = window.performance ? window.performance.now() : Date.now();
    window.requestAnimationFrame(morphTick);
  }

  function initMorphingText() {
    if (reduceMotion.matches || MORPHS.length) return;
    var hosts = $$('.logo__text');
    if (!hosts.length) return;

    document.body.insertAdjacentHTML('beforeend',
      '<svg class="morph-filters" aria-hidden="true" focusable="false">' +
        '<defs>' +
          '<filter id="morph-threshold">' +
            '<feColorMatrix in="SourceGraphic" type="matrix" values="' +
              '1 0 0 0 0 ' +
              '0 1 0 0 0 ' +
              '0 0 1 0 0 ' +
              '0 0 0 255 -140"/>' +
          '</filter>' +
        '</defs>' +
      '</svg>');

    hosts.forEach(function (host) {
      var name = $('.logo__name', host);
      var sub  = $('.logo__sub', host);
      if (!name || !sub) return;

      var first = name.textContent.trim();
      var second = sub.textContent.trim();
      if (!first || !second) return;

      /* ARYOS, then GROUP on its own, then the two together — and "together"
         is the lockup the header already wears, sub-line and all, so the logo
         is only ever animating back into itself. Keeping the pair stacked
         rather than spelling it across one line is also what lets this run at
         every width: the header has no spare 90px at tablet sizes. */
      var lockup = escapeHtml(first) +
        '<span class="' + escapeHtml(sub.className) + '">' + escapeHtml(second) + '</span>';
      var texts = [escapeHtml(first), escapeHtml(second), lockup];

      /* The second word now lives inside the morph, and the link's own
         aria-label already reads "Aryos Group", so the animation is hidden
         from screen readers rather than spelling the brand out in pieces. */
      sub.hidden = true;
      name.classList.add('morph');
      name.setAttribute('aria-hidden', 'true');
      name.innerHTML =
        '<span class="morph__sizer">' + lockup + '</span>' +
        '<span class="morph__text"></span>' +
        '<span class="morph__text"></span>';

      /* The lockup holds the box open. A single word set at the name's size
         can still be a shade wider than it, so the floor is carried in em —
         px would be wrong the moment a breakpoint changes the type size. */
      var sizer = $('.morph__sizer', name);
      var spans = $$('.morph__text', name);
      var floor = sizer.offsetWidth;
      spans[0].style.opacity = '0%';
      texts.forEach(function (html) {
        morphFill(spans[0], html);
        if (spans[0].offsetWidth > floor) floor = spans[0].offsetWidth;
      });
      var unit = parseFloat(window.getComputedStyle(name).fontSize) || 16;
      name.style.minWidth = (floor / unit).toFixed(3) + 'em';

      var inst = {
        a: spans[0], b: spans[1],
        texts: texts,
        index: 0,
        morph: 0,
        cooldown: 0,
        blur: Math.max(2, unit * 0.15),
        visible: true
      };
      morphStyles(inst, 0);
      MORPHS.push(inst);

      /* The footer lockup should not burn frames while it is three screens
         below the fold. */
      if ('IntersectionObserver' in window) {
        inst.visible = false;
        new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) { inst.visible = entry.isIntersecting; });
          morphStart();
        }, { threshold: 0 }).observe(host);
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) morphStart();
    });

    morphStart();
  }

  function initHero() {
    var video  = $('[data-hero-video]');
    var toggle = $('[data-hero-toggle]');
    if (!video) return;

    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var saveData = !!(conn && (conn.saveData || /^(2g|slow-2g|3g)$/.test(conn.effectiveType || '')));

    /* A background clip is decoration. On a phone it is decoration that costs
       megabytes of the visitor's data and battery, so the still is the whole
       hero there and the mp4 is never requested. Anything under a tablet, on a
       metered or slow connection, or with reduced motion asked for, keeps the
       still. */
    var bigScreen = window.matchMedia('(min-width: 900px)').matches;
    var wantsVideo = bigScreen && !saveData && !reduceMotion.matches;

    var src = video.getAttribute('data-src');
    if (!wantsVideo || !src) {
      /* Nothing to pause, so the control never appears. */
      video.remove();
      if (toggle) toggle.remove();
      return;
    }

    function setState(playing) {
      if (!toggle) return;
      toggle.setAttribute('data-state', playing ? 'playing' : 'paused');
      toggle.setAttribute('aria-label', playing ? 'Pause background video' : 'Play background video');
    }

    function play() {
      var p = video.play();
      /* Autoplay is refused in some contexts — fall back to the still. */
      if (p && typeof p.catch === 'function') p.catch(function () { setState(false); });
    }

    var allowAutoplay = true;

    /* The clip is optional: if media/hero.mp4 was never added, drop the video
       and its control and let the still stand, rather than leaving a dead
       element and a button that does nothing. */
    video.addEventListener('error', function () {
      allowAutoplay = false;
      video.remove();
      if (toggle) toggle.remove();
    });

    /* Only cross-fade to the clip once it can actually paint a frame, so the
       hero never flashes black between the still and the first frame. */
    video.addEventListener('canplay', function () {
      video.classList.add('is-ready');
      if (toggle) toggle.hidden = false;
    }, { once: true });

    video.preload = 'auto';
    video.src = src;
    play();

    if (toggle) {
      toggle.addEventListener('click', function () {
        if (video.paused) play(); else video.pause();
      });
    }

    video.addEventListener('play',  function () { setState(true); });
    video.addEventListener('pause', function () { setState(false); });

    /* Don't decode video the visitor cannot see. */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) video.pause();
      else if (allowAutoplay) play();
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!allowAutoplay) return;
          if (entry.isIntersecting) play(); else video.pause();
        });
      }, { threshold: 0.15 }).observe(video);
    }
  }

  /* ------------------------------------------------------------------------
     5. Jobs
     ------------------------------------------------------------------------ */
  var savedJobs = store.get('aryos.savedJobs', []);

  /* Most roles are advertised in five countries at once, so they share one
     photograph keyed on the title. Values are paths under media/jobs/ without
     the extension, the same shape a vacancy's own picture has, so the
     responsive copies are derived identically.
     tools/make-job-photos.py prints this block. */
  var ROLE_PHOTO = {
    'Accountant/Auditor':              'roles/accountant-auditor',
    'Chef/Cook':                       'roles/chef-cook',
    'Civil Engineer':                  'roles/civil-engineer',
    'Construction Laborer':            'roles/construction-laborer',
    'Customer Service Representative': 'roles/customer-service-representative',
    'Cybersecurity Analyst':           'roles/cybersecurity-analyst',
    'Data Scientist':                  'roles/data-scientist',
    'Electrician':                     'roles/electrician',
    'General/Operations Manager':      'roles/general-operations-manager',
    'Graphic Designer':                'roles/graphic-designer',
    'HVAC Technician':                 'roles/hvac-technician',
    'Home Health/Personal Care Aide':  'roles/home-health-personal-care-aide',
    'Janitor/Cleaner':                 'roles/janitor-cleaner',
    'Lawyer':                          'roles/lawyer',
    'Manufacturing/Machine Operator':  'roles/manufacturing-machine-operator',
    'Mechanical Engineer':             'roles/mechanical-engineer',
    'Pharmacist':                      'roles/pharmacist',
    'Physician (Specialist)':          'roles/physician-specialist',
    'Police Officer':                  'roles/police-officer',
    'Registered Nurse':                'roles/registered-nurse',
    'Sales Representative':            'roles/sales-representative',
    'Secondary School Teacher':        'roles/secondary-school-teacher',
    'Social Worker':                   'roles/social-worker',
    'Software Developer':              'roles/software-developer',
    /* No separate photograph was supplied for the generic driving role; it is
       the same work as the Category CE vacancy, so it uses that picture. */
    'Truck Driver':                    'ARY-1102'
  };

  /* Last resort before the striped placeholder: a title nobody has
     photographed — a vacancy an admin posts from Telegram under a new name —
     borrows from another job in the same line of work. Categories with no
     photograph anywhere are absent here on purpose. */
  var CATEGORY_PHOTO = {
    'Agriculture & Food':    'ARY-1062',
    'Cleaning & Facilities': 'ARY-1132',
    'Construction':          'ARY-1042',
    'Healthcare':            'ARY-1131',
    'Hospitality':           'ARY-1101',
    'Logistics':             'ARY-1071',
    'Manufacturing':         'ARY-1043',
    'Social Care':           'ARY-1162',
    'Technical & Trades':    'ARY-1152'
  };

  /* Every photograph tools/make-job-photos.py builds gets these two widths. */
  var JOB_PHOTO_WIDTHS = [600, 1200];

  /* The grid is one column, then two from 720px, inside a 1180px container —
     so a card tops out around 560px however wide the screen gets. */
  var JOB_PHOTO_SIZES = '(min-width: 1180px) 560px, (min-width: 720px) 50vw, 100vw';

  /* The responsive copies exist only for photographs that went through the
     build script, which is why widths are passed in rather than assumed: a
     picture uploaded from Telegram has none, and listing widths nobody
     generated just points the browser at a 404. */
  function jobPhotoMarkup(src, widths) {
    var sizes = widths && widths.length ? widths : [];
    var top = sizes.length ? Math.max.apply(null, sizes) : 0;
    var base = src.replace(/\.[a-z0-9]+$/i, '');

    function srcset(ext) {
      return sizes.map(function (w) {
        /* The largest copy keeps the bare name; see tools/make-job-photos.py. */
        return base + (w === top ? '' : '-' + w) + '.' + ext + ' ' + w + 'w';
      }).join(', ');
    }

    var img = '<img src="' + escapeHtml(src) + '"' +
              (top ? ' srcset="' + escapeHtml(srcset('jpg')) + '"' +
                     ' sizes="' + JOB_PHOTO_SIZES + '"' : '') +
              ' alt="" loading="lazy" decoding="async"' +
              ' onerror="this.closest(\'.job__media\').classList.add(\'is-broken\')">';

    if (!top) return img;
    return '<picture>' +
             '<source type="image/webp" srcset="' + escapeHtml(srcset('webp')) + '"' +
               ' sizes="' + JOB_PHOTO_SIZES + '">' +
             img +
           '</picture>';
  }

  function jobCard(job, index) {
    var isSaved = savedJobs.indexOf(job.id) !== -1;
    var stagger = 'style="--stagger:' + (Math.min(index || 0, 8) * 70) + 'ms"';

    var name = tr(job.title);
    var tags = (job.tags || []).map(function (tag) {
      return '<li class="tag tag--muted">' + escapeHtml(tr(tag)) + '</li>';
    }).join('');

    /* A photo uploaded through the bot replaces the placeholder. onerror
       falls back to the placeholder if the file went missing on the server. */
    var country = tr(job.country);
    var flag = flagBadge(job.country, country);

    var photo = job.photo;
    var widths = job.photoWidths;
    if (!photo) {
      var shared = ROLE_PHOTO[job.title] || CATEGORY_PHOTO[job.category];
      if (shared) {
        photo = 'media/jobs/' + shared + '.jpg';
        widths = JOB_PHOTO_WIDTHS;
      }
    }

    var media = photo
      ? '<div class="job__media job__media--photo">' +
          jobPhotoMarkup(photo, widths) +
          flag +
        '</div>'
      : '<div class="job__media ph ph--job">' +
          '<span class="ph__label">' + escapeHtml(tr('Job image placeholder')) + '</span>' + flag +
        '</div>';

    return '' +
      '<article class="job is-entering" id="job-' + job.id + '" ' + stagger + '>' +
        media +
        '<div class="job__body">' +
          '<h3 class="job__title">' + escapeHtml(name) + '</h3>' +
          '<p class="job__location">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.1 7-11a7 7 0 10-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>' +
            escapeHtml(job.city) + ', ' + escapeHtml(country) +
          '</p>' +
          '<dl class="job__facts">' +
            '<div><dt>' + escapeHtml(tr('Salary')) + '</dt><dd class="job__salary">' + escapeHtml(job.salary) + '</dd></div>' +
            '<div><dt>' + escapeHtml(tr('Working hours')) + '</dt><dd>' + escapeHtml(job.hours) + '</dd></div>' +
          '</dl>' +
          '<ul class="job__tags">' +
            '<li class="tag">' + escapeHtml(tr(job.type)) + '</li>' +
            '<li class="tag">' + escapeHtml(tr(job.category)) + '</li>' +
            tags +
          '</ul>' +
          '<p class="job__desc">' + escapeHtml(job.desc) + '</p>' +
          '<div class="job__pass" aria-label="' + escapeHtml(tr('Boarding pass')) + '">' +
            '<span class="job__pass-cell job__pass-cell--passenger">' +
              '<small>' + escapeHtml(tr('Passenger')) + '</small>' +
              '<b>' + escapeHtml(tr('You')) + '</b>' +
            '</span>' +
            '<span class="job__pass-cell job__pass-cell--route">' +
              '<small>' + escapeHtml(tr('From')) + ' ARYOS HUB</small>' +
              '<b>' + escapeHtml(tr('To')) + ' ' + escapeHtml(job.city) + ', ' + escapeHtml(country) + '</b>' +
            '</span>' +
            '<span class="job__pass-cell job__pass-cell--ref">' +
              '<small>' + escapeHtml(tr('Ref')) + '</small>' +
              '<b>' + escapeHtml(job.id) + '</b>' +
            '</span>' +
            '<span class="job__pass-barcode" aria-hidden="true"></span>' +
          '</div>' +
          '<div class="job__actions">' +
            '<button type="button" class="btn btn--primary btn--magnetic" data-apply-job-id="' + job.id + '">' + escapeHtml(tr('Apply Now')) + '</button>' +
            '<button type="button" class="icon-btn" data-save="' + job.id + '"' +
              ' aria-pressed="' + isSaved + '"' +
              ' aria-label="' + escapeHtml(tr('Save') + ' ' + name) + '">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10a1 1 0 011 1v15l-6-4-6 4V5a1 1 0 011-1z"/></svg>' +
            '</button>' +
          '</div>' +
          '<p class="job__ref">' + escapeHtml(tr('Ref')) + ' ' + escapeHtml(job.id) +
            ' · ' + escapeHtml(tr('Posted')) + ' ' + escapeHtml(tr(job.posted)) + '</p>' +
        '</div>' +
      '</article>';
  }

  /* Save + Apply work the same on the jobs page and in the homepage shortlist. */
  function wireJobActions(container) {
    if (container.dataset.wiredJobActions) return;
    container.dataset.wiredJobActions = '1';

    container.addEventListener('click', function (e) {
      var saveBtn = e.target.closest('[data-save]');
      if (saveBtn) {
        var id = saveBtn.getAttribute('data-save');
        var i = savedJobs.indexOf(id);
        var nowSaved = i === -1;
        if (nowSaved) savedJobs.push(id); else savedJobs.splice(i, 1);

        /* Mirror the change on every copy of the card that is on screen. */
        $$('[data-save="' + id + '"]').forEach(function (btn) {
          btn.setAttribute('aria-pressed', String(nowSaved));
        });
        store.set('aryos.savedJobs', savedJobs);

        var job = JOBS.filter(function (j) { return j.id === id; })[0];
        var label = tr(job ? job.title : 'Job');
        toast(label + ' ' + tr(nowSaved ? 'saved' : 'removed from saved'),
              nowSaved ? 'ok' : null);
        return;
      }

      var applyBtn = e.target.closest('[data-apply-job-id]');
      if (applyBtn) applyJob(applyBtn.getAttribute('data-apply-job-id'));
    });
  }

  /* Homepage: the three most recent roles, no filters. */
  function paintFeaturedJobs() {
    var box = $('[data-featured-jobs]');
    if (!box) return;
    box.innerHTML = JOBS.slice(0, 3).map(jobCard).join('');
  }

  /* ------------------------------------------------------------------------
     Reviews

     ⚠ PLACEHOLDER CONTENT. Every entry below is written copy, not a real
     customer. Swap them for testimonials people actually gave you before this
     site is public: passing invented reviews off as genuine breaks the EU
     Unfair Commercial Practices Directive and the UK DMCC Act — the two
     markets you place candidates into — and the FTC rule in the US.

     Each review carries its own `lang`. A Kurdish or Arabic testimonial is
     then rendered right-to-left even while the page is in English, which is
     how a real multilingual wall of reviews has to behave.

     Fields: name, place (where they were hired from), role, country (where
     they went), rating 1-5, lang, date (YYYY-MM), text.
     ------------------------------------------------------------------------ */
  var REVIEWS = [
    {
      name: 'Karwan A.', place: 'Erbil', role: 'Electrician', country: 'Germany',
      rating: 5, lang: 'en', date: '2026-05',
      text: 'They explained every step before I paid anything. The permit took four months and nobody ever stopped answering my messages. I have been on site in Bremen since March.'
    },
    {
      name: 'Dilan H.', place: 'Sulaymaniyah', role: 'Nurse', country: 'Netherlands',
      rating: 5, lang: 'ckb', date: '2026-04',
      text: 'بڕوانامەکەم شەش مانگی خایاند تا دان بەوەدا بنرێت. ئەریۆس هەموو کاغەزەکانی ڕێکخست و خولی زمانەکەشیان بۆ دۆزیمەوە. ئێستا لە ڕۆتردام کار دەکەم.'
    },
    {
      name: 'Mustafa J.', place: 'Baghdad', role: 'Warehouse Assistant', country: 'Poland',
      rating: 4, lang: 'ar', date: '2026-03',
      text: 'العقد كان واضحاً والراتب كما اتفقنا تماماً. تأخر موعد السفارة شهراً كاملاً، لكنهم أبلغوني بكل جديد أولاً بأول ولم أشعر أنني وحدي.'
    },
    {
      name: 'Hemin S.', place: 'Duhok', role: 'Construction Worker', country: 'Sweden',
      rating: 5, lang: 'en', date: '2026-02',
      text: 'What I valued most was that they told me honestly when a job was not right for me, instead of sending me anyway. The one they did send me to, I am still in.'
    },
    {
      name: 'Ahmet Y.', place: 'Mosul', role: 'Truck Driver', country: 'Germany',
      rating: 4, lang: 'tr', date: '2026-01',
      text: 'Ehliyet denklik işlemi düşündüğümden uzun sürdü ama her aşamada bilgilendirildim. Şu an Hamburg merkezli çalışıyorum, ailemi de yanıma almak için başvurdum.'
    },
    {
      name: 'Rezan M.', place: 'Erbil', role: 'Hotel Receptionist', country: 'United Kingdom',
      rating: 5, lang: 'en', date: '2025-12',
      text: 'I applied from my phone on the bus. Somebody called me the next morning, went through my documents with me, and I had an interview that same week.'
    }
  ];

  function starsMarkup(rating) {
    var n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += '<span class="review__star' + (i <= n ? ' is-on' : '') + '" aria-hidden="true">★</span>';
    }
    /* One label for the row rather than five, so a screen reader says
       "4 out of 5" instead of reading a wall of stars. */
    return '<p class="review__stars" role="img" aria-label="' +
      escapeHtml(trt('{0} out of 5', undefined, n)) + '">' + out + '</p>';
  }

  function reviewCard(r) {
    var dir = langDir(r.lang || 'en');
    var initials = String(r.name || '?').trim().charAt(0).toUpperCase();
    var when = '';
    if (r.date) {
      var bits = String(r.date).split('-');
      var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                    'August', 'September', 'October', 'November', 'December'];
      when = tr(months[Number(bits[1]) - 1] || '') + ' ' + bits[0];
    }

    return '' +
      '<li class="review" data-reveal="up">' +
        '<article>' +
          starsMarkup(r.rating) +
          '<blockquote class="review__text" lang="' + escapeHtml(r.lang || 'en') + '" dir="' + dir + '">' +
            escapeHtml(r.text) +
          '</blockquote>' +
          '<footer class="review__by">' +
            '<span class="review__avatar" aria-hidden="true">' + escapeHtml(initials) + '</span>' +
            '<span class="review__who">' +
              '<span class="review__name">' + escapeHtml(r.name) + '</span>' +
              '<span class="review__meta">' +
                escapeHtml(tr(r.role)) + ' · ' + escapeHtml(r.place) +
                ' → ' + escapeHtml(tr(r.country)) +
              '</span>' +
            '</span>' +
          '</footer>' +
          (when ? '<p class="review__date">' + escapeHtml(when) + '</p>' : '') +
        '</article>' +
      '</li>';
  }

  function paintReviews() {
    var box = $('[data-reviews]');
    if (!box) return;
    box.innerHTML = REVIEWS.map(reviewCard).join('');
    afterRender();
  }

  /* Real reviews come from the bot, exactly as vacancies do. The samples above
     stand in only until the first one is published, so the section is never
     empty — and are replaced wholesale the moment real ones exist. */
  function loadReviews(done) {
    if (!$('[data-reviews]')) { if (done) done(); return; }

    fetch('/reviews', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (rows && rows.length) REVIEWS = rows;
      })
      .catch(function () { /* offline or not deployed — samples stand */ })
      .then(function () { paintReviews(); if (done) done(); });
  }

  function initFeaturedJobs() {
    var box = $('[data-featured-jobs]');
    if (!box) return;
    paintFeaturedJobs();
    wireJobActions(box);
  }

  /* Homepage: rebuild the region blocks straight from the job data, so adding
     a country to COUNTRIES (or a job to JOBS) is the only edit ever needed. */
  function paintRegions() {
    var box = $('[data-regions]');
    if (!box) return;

    var html = REGIONS.map(function (region) {
      var inRegion = COUNTRIES.filter(function (c) { return c.region === region; });
      if (!inRegion.length) return '';

      var total = JOBS.filter(function (j) { return j.region === region; }).length;

      var cards = inRegion.map(function (c) {
        return '<li data-reveal="zoom">' +
                 '<a class="country" data-tilt href="jobs.html?country=' + encodeURIComponent(c.name) + '">' +
                   '<span class="country__row">' +
                     '<span class="country__flag" aria-hidden="true">' +
                       flagMark(c.name, 'country__flag-img') + '</span>' +
                     '<span class="country__name">' + escapeHtml(tr(c.name)) + '</span>' +
                   '</span>' +
                   '<span class="country__meta" data-count="' + escapeHtml(c.name) + '">—</span>' +
                 '</a>' +
               '</li>';
      }).join('');

      return '' +
        '<section class="region" data-reveal="up">' +
          '<div class="region__head">' +
            '<h3 class="region__title">' + escapeHtml(tr(region)) + '</h3>' +
            '<span class="region__count">' + inRegion.length + ' ' + tr('countries') +
              ' · ' + total + ' ' + (total === 1 ? tr('role') : tr('roles')) + '</span>' +
          '</div>' +
          '<ul class="countries" data-reveal-group="60">' + cards + '</ul>' +
        '</section>';
    }).join('');

    box.innerHTML = html;
  }

  function initRegions() {
    paintRegions();
  }

  /* Homepage country cards show counts taken from the job data itself.
     The number counts up the first time the card scrolls into view. */
  function initCountryCounts() {
    var cells = $$('[data-count]');
    if (!cells.length) return;

    function fill(el) {
      var name = el.getAttribute('data-count');
      var n = JOBS.filter(function (j) { return j.country === name; }).length;
      el.classList.add('is-counting');
      countUp(el, n, function (v) {
        if (n === 0) return tr('Register interest');
        return v === 1 ? '1 ' + tr('open role') : v + ' ' + tr('open roles');
      });
    }

    if (!('IntersectionObserver' in window) || !motionOK()) {
      cells.forEach(fill);
      return;
    }

    var obs = new IntersectionObserver(function (entries, o) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        fill(entry.target);
        o.unobserve(entry.target);
      });
    }, { threshold: 0.4 });

    cells.forEach(function (el) { obs.observe(el); });
  }

  /* ------------------------------------------------------------------------
     5b. Structured data

     Search engines read this, not the cards. It is built here rather than
     written into the HTML for two reasons: the vacancies arrive from /jobs at
     runtime, and the production domain is not known to the code — Railway,
     Render and a custom domain all serve the same files, so every URL is
     resolved against location.origin instead of being hard-coded.

     Note for anyone extending this: Google's *jobs* rich results want one
     vacancy per URL. This site puts all of them on jobs.html with #job-ARY-0000
     anchors, so what follows is an honest ItemList of everything on the page —
     good machine-readable data, but not on its own enough for Google Jobs.
     ------------------------------------------------------------------------ */
  var EMPLOYMENT_TYPE = {
    'Full-time': 'FULL_TIME',
    'Part-time': 'PART_TIME',
    'Contract': 'CONTRACTOR',
    'Temporary': 'TEMPORARY',
    'Seasonal': 'TEMPORARY',
    'Internship': 'INTERN'
  };

  function absolute(path) {
    return window.location.origin + '/' + String(path).replace(/^\//, '');
  }

  function organizationLd() {
    return {
      '@type': 'Organization',
      '@id': absolute('#organization'),
      name: 'Aryos Group',
      url: absolute('index.html'),
      logo: absolute('media/apple-touch-icon.png'),
      email: 'info@aryosgroup.com',
      telephone: '+9647500000000',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Gulan Street',
        addressLocality: 'Erbil',
        addressRegion: 'Kurdistan Region',
        addressCountry: 'IQ'
      }
    };
  }

  function jobPostingLd(job) {
    /* Google treats a JobPosting with no date as incomplete, and a guessed one
       would be worse than none — the card's "3 days ago" is a label, not a
       date. Vacancies without a real one are simply left out. */
    if (!job.datePosted) return null;

    /* "Houston, TX" is a city and a region; "Berlin" is just a city. */
    var parts = String(job.city).split(',');
    var address = {
      '@type': 'PostalAddress',
      addressLocality: parts[0].trim(),
      addressCountry: (FLAG_CODES[job.country] || '').toUpperCase() || job.country
    };
    if (parts.length > 1) address.addressRegion = parts.slice(1).join(',').trim();

    var posting = {
      '@type': 'JobPosting',
      title: job.title,
      description: job.desc,
      identifier: {
        '@type': 'PropertyValue',
        name: 'Aryos Group reference',
        value: job.id
      },
      datePosted: job.datePosted,
      employmentType: EMPLOYMENT_TYPE[job.type] || 'FULL_TIME',
      hiringOrganization: { '@id': absolute('#organization') },
      jobLocation: { '@type': 'Place', address: address },
      url: absolute('jobs.html#job-' + job.id),
      directApply: false
    };

    /* salaryUsd is the monthly minimum already converted, which is the only
       figure held as a number — job.salary is display text in local currency. */
    if (job.salaryUsd) {
      posting.baseSalary = {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: {
          '@type': 'QuantitativeValue',
          minValue: job.salaryUsd,
          unitText: 'MONTH'
        }
      };
    }
    return posting;
  }

  function writeLd(id, graph) {
    var existing = document.getElementById(id);
    if (existing) existing.remove();
    var el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = id;
    /* "</script>" inside a value would close this tag early. */
    el.textContent = JSON.stringify(graph).replace(/</g, '\\u003c');
    document.head.appendChild(el);
  }

  function initStructuredData() {
    var graph = [organizationLd()];

    /* Only the page that actually lists the vacancies describes them. */
    if (document.querySelector('[data-jobs]')) {
      var items = [];
      JOBS.forEach(function (job) {
        var posting = jobPostingLd(job);
        if (!posting) return;
        items.push({
          '@type': 'ListItem',
          position: items.length + 1,
          item: posting
        });
      });
      if (items.length) {
        graph.push({
          '@type': 'ItemList',
          name: 'Open positions at Aryos Group',
          numberOfItems: items.length,
          itemListElement: items
        });
      }
    }

    writeLd('aryos-ld', { '@context': 'https://schema.org', '@graph': graph });
  }

  function initJobs() {
    var list    = $('[data-jobs]');
    var empty   = $('[data-jobs-empty]');
    var form    = $('[data-filters]');
    var counter = $('[data-results-count]');
    if (!list || !form) return;

    var search   = $('#f-search');
    var country  = $('#f-country');
    var category = $('#f-category');
    var salary   = $('#f-salary');

    /* Rebuild the country and category menus from the jobs actually on offer,
       so a country or category added in Telegram shows up here by itself and
       no option ever points at an empty result. */
    function syncFilters() {
      var keepCountry = country.value;
      var keepCategory = category.value;

      var used = {};
      JOBS.forEach(function (j) { used[j.country] = true; });

      var groups = REGIONS.map(function (region) {
        var names = COUNTRIES
          .filter(function (c) { return c.region === region && used[c.name]; })
          .map(function (c) { return c.name; })
          .sort();
        if (!names.length) return '';
        return '<optgroup label="' + escapeHtml(tr(region)) + '">' +
          names.map(function (n) {
            return '<option value="' + escapeHtml(n) + '">' + escapeHtml(tr(n)) + '</option>';
          }).join('') + '</optgroup>';
      }).join('');

      country.innerHTML = '<option value="">' + escapeHtml(tr('All countries')) + '</option>' + groups;
      if (keepCountry) country.value = keepCountry;

      var cats = [];
      JOBS.forEach(function (j) {
        if (j.category && cats.indexOf(j.category) === -1) cats.push(j.category);
      });
      cats.sort();

      category.innerHTML = '<option value="">' + escapeHtml(tr('All categories')) + '</option>' +
        cats.map(function (c) {
          return '<option value="' + escapeHtml(c) + '">' + escapeHtml(tr(c)) + '</option>';
        }).join('');
      if (keepCategory) category.value = keepCategory;
    }

    function matches(job) {
      var q = search.value.trim().toLowerCase();
      if (q) {
        var haystack = [job.title, job.city, job.country, job.category, job.desc].join(' ').toLowerCase();
        if (haystack.indexOf(q) === -1) return false;
      }
      if (country.value && job.country !== country.value) return false;
      if (category.value && job.category !== category.value) return false;
      if (Number(salary.value) && job.salaryUsd < Number(salary.value)) return false;
      return true;
    }

    /* Placeholder cards shown for a beat while the list is re-filtered, so the
       grid never flashes empty. */
    function skeletonMarkup(n) {
      var one =
        '<div class="job-skeleton" aria-hidden="true">' +
          '<div class="skeleton job-skeleton__media"></div>' +
          '<div class="skeleton job-skeleton__line job-skeleton__line--lg"></div>' +
          '<div class="skeleton job-skeleton__line job-skeleton__line--sm"></div>' +
          '<div class="skeleton job-skeleton__block"></div>' +
          '<div class="skeleton job-skeleton__line"></div>' +
        '</div>';
      return new Array(n + 1).join(one);
    }

    function paint(results) {
      list.innerHTML = results.map(jobCard).join('');
      list.hidden = results.length === 0;
      list.classList.remove('is-swapping');
      if (empty) empty.hidden = results.length !== 0;

      if (counter) {
        counter.textContent = results.length === JOBS.length
          ? trt('Showing all {0} jobs', undefined, JOBS.length)
          : trt('Showing {0} of {1} jobs', undefined, results.length, JOBS.length);
        counter.classList.remove('is-updating');
        /* Force a reflow so the pop animation restarts on every change. */
        void counter.offsetWidth;
        counter.classList.add('is-updating');
      }
    }

    var swapTimer = null;

    function render(animate) {
      var results = JOBS.filter(matches);

      if (!animate || !motionOK()) { paint(results); return; }

      list.classList.add('is-swapping');
      window.clearTimeout(swapTimer);
      swapTimer = window.setTimeout(function () { paint(results); }, 170);
    }

    /* First paint: show skeletons briefly so the page feels alive on arrival. */
    function firstRender() {
      if (!motionOK()) { render(false); return; }
      list.innerHTML = skeletonMarkup(Math.min(JOBS.length, 4));
      window.setTimeout(function () { render(false); }, 380);
    }

    ['input', 'change'].forEach(function (evt) {
      form.addEventListener(evt, function () { render(true); });
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); render(true); });

    $$('[data-clear-filters]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        form.reset();
        render(true);
        search.focus();
        toast(tr('Filters cleared'));
      });
    });

    wireJobActions(list);
    syncFilters();

    /* Language repaints reach back in here to re-draw the option labels and
       the card grid, keeping whatever country/category the visitor picked. */
    JOBS_REPAINT = function () {
      syncFilters();
      render(false);
    };

    /* Arriving from a homepage country card: jobs.html?country=Germany */
    var params = new URLSearchParams(window.location.search);
    var preCountry = params.get('country');
    var preSearch  = params.get('q');
    if (preCountry) country.value = preCountry;
    if (preSearch) search.value = preSearch;

    firstRender();

    if (preCountry) {
      window.setTimeout(function () {
        toast(trt('Filtered to {0}', undefined, tr(preCountry)));
      }, 500);
    }
  }

  /* ------------------------------------------------------------------------
     5b. Apply wizard

     "Apply Now" opens a full-screen, one-question-at-a-time application. The
     answers and three photos are posted to the bot, which notifies the admin
     in Telegram. If the endpoint is unreachable the candidate is handed to
     the contact page instead, so an application is never simply lost.
     ------------------------------------------------------------------------ */
  var APPLY_API = '/apply';

  /* ========================================================================
     Languages

     iOS and Android both build their Settings language list from CLDR, the
     Unicode locale database, and every browser exposes the same data through
     Intl.DisplayNames. So this file carries no table of language names: it
     carries codes, and the device supplies each name — in its own script, and
     in whatever language the visitor is currently reading. About 1 KB of
     codes buys the whole menu, and it stays correct without maintenance.

     What the platform cannot supply is translated page copy. That is content,
     and it lives in the language files, not here.
     ======================================================================== */

  /* Every language iOS or Android offers as a display language, plus the
     most-spoken languages worldwide, plus the ones our candidates actually
     read. Codes only — names come from the device. */
  var LANG_CODES = [
    'ckb', 'ku', 'ar', 'en', 'tr', 'fa',
    'af', 'am', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da', 'de',
    'el', 'es', 'et', 'eu', 'fi', 'fil', 'fr', 'ga', 'gl', 'gu', 'ha', 'he',
    'hi', 'hr', 'hu', 'hy', 'id', 'ig', 'is', 'it', 'ja', 'ka', 'kk', 'km',
    'kn', 'ko', 'ky', 'lo', 'lt', 'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt',
    'my', 'ne', 'nl', 'no', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sd', 'si',
    'sk', 'sl', 'so', 'sq', 'sr', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk',
    'tt', 'uk', 'ur', 'uz', 'vi', 'xh', 'yo', 'zh-Hans', 'zh-Hant', 'zu'
  ];

  /* CLDR does not ship an endonym for every language in its own script — it
     answers "Central Kurdish" for ckb rather than the Sorani name. A short
     override list covers the ones our audience would notice. */
  var ENDONYMS = {
    'ckb': 'کوردیی ناوەندی',
    'ku': 'Kurdî',
    'fil': 'Filipino',
    'zh-Hans': '简体中文',
    'zh-Hant': '繁體中文'
  };

  /* Last-resort direction table for browsers too old for Intl.Locale. */
  var RTL_LANGS = ['ar', 'he', 'fa', 'ur', 'ckb', 'ps', 'sd', 'ug', 'yi', 'dv'];

  function langDir(code) {
    var base = String(code).split('-')[0];
    try {
      var loc = new Intl.Locale(code);
      var info = loc.textInfo || (loc.getTextInfo && loc.getTextInfo());
      if (info && info.direction) return info.direction;
    } catch (e) { /* fall through */ }
    return RTL_LANGS.indexOf(base) !== -1 ? 'rtl' : 'ltr';
  }

  /* The language's own name for itself. `inLang` renders it in the language
     the visitor is currently reading, for the second line of each menu row. */
  function langName(code, inLang) {
    if (!inLang && ENDONYMS[code]) return ENDONYMS[code];
    try {
      var name = new Intl.DisplayNames([inLang || code], { type: 'language' }).of(code);
      /* DisplayNames echoes the code back when it has no entry. */
      if (name && name !== code) return name;
    } catch (e) { /* fall through */ }
    return ENDONYMS[code] || code;
  }

  var LANG_KEY = 'aryos.lang';

  /* Tags a device may report that belong to another entry in LANG_CODES.
     Sorani is the only Kurdish translation the site carries, so every Kurdish
     tag lands there rather than on an untranslated 'ku'. The rest are legacy
     or regional codes Android and older browsers still emit. */
  var LANG_ALIASES = {
    'ku': 'ckb', 'kmr': 'ckb', 'sdh': 'ckb',   /* Kurdish → Sorani */
    'nb': 'no', 'nn': 'no',                    /* Bokmål / Nynorsk → Norwegian */
    'iw': 'he', 'in': 'id', 'ji': 'yi',        /* superseded ISO codes */
    'tl': 'fil'                                /* Tagalog → Filipino */
  };

  /* The language the phone or computer is set to, matched against what the
     site offers. Reads navigator.languages in the visitor's own order of
     preference, so a phone set to Kurdish first and Arabic second gets
     Kurdish, and falls back through the list before settling on English. */
  function deviceLang() {
    var wanted = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || navigator.userLanguage || ''];

    for (var i = 0; i < wanted.length; i++) {
      var tag = String(wanted[i] || '').trim().replace(/_/g, '-');
      if (!tag) continue;
      var base = tag.split('-')[0].toLowerCase();

      /* Aliases first: 'ku' is itself in LANG_CODES, so an exact match would
         return it and hand a Kurdish phone untranslated English copy. */
      if (LANG_ALIASES[base]) return LANG_ALIASES[base];

      /* Then exact, so zh-Hant is not flattened to zh-Hans. */
      for (var j = 0; j < LANG_CODES.length; j++) {
        if (LANG_CODES[j].toLowerCase() === tag.toLowerCase()) return LANG_CODES[j];
      }
      /* Chinese arrives as zh-CN / zh-TW far more often than with a script. */
      if (base === 'zh') return /hant|tw|hk|mo/i.test(tag) ? 'zh-Hant' : 'zh-Hans';
      if (LANG_CODES.indexOf(base) !== -1) return base;
    }
    return 'en';
  }

  /* A stored choice always wins — but until the visitor makes one, the device
     decides. Nothing is written on a first visit, so changing the phone's
     language changes the site too. */
  function currentLang() {
    return store.get(LANG_KEY, null) || deviceLang();
  }

  /* ------------------------------------------------------------------------
     Date of birth helpers

     The wizard asks for a birth date and derives the age. Keeping the two in
     one place means the bounds the picker enforces and the bounds the
     validator checks can never disagree.
     ------------------------------------------------------------------------ */
  var MIN_AGE = 16, MAX_AGE = 70;

  function isoDate(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  /* Oldest date the picker allows — someone turning MAX_AGE today. */
  function minDobISO() {
    var d = new Date();
    d.setFullYear(d.getFullYear() - MAX_AGE);
    return isoDate(d);
  }

  /* Youngest — someone turning MIN_AGE today. */
  function maxDobISO() {
    var d = new Date();
    d.setFullYear(d.getFullYear() - MIN_AGE);
    return isoDate(d);
  }

  function ageFromDob(iso) {
    var parts = String(iso).split('-');
    if (parts.length !== 3) return null;
    var y = +parts[0], m = +parts[1], day = +parts[2];
    if (!y || !m || !day) return null;

    var born = new Date(y, m - 1, day);
    /* Rejects 31 February and friends: the Date constructor rolls them over. */
    if (born.getFullYear() !== y || born.getMonth() !== m - 1 || born.getDate() !== day) return null;

    var now = new Date();
    var age = now.getFullYear() - y;
    /* Not had this year's birthday yet. */
    if (now.getMonth() < m - 1 || (now.getMonth() === m - 1 && now.getDate() < day)) age -= 1;
    return age;
  }

  function formatDob(iso) {
    var age = ageFromDob(iso);
    if (age == null) return iso;
    var parts = iso.split('-');
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
    return +parts[2] + ' ' + tr(months[+parts[1] - 1]) + ' ' + parts[0] + ' ' +
      trt('(age {0})', undefined, age);
  }

  /* Every sovereign state and the territories candidates actually hold papers
     from, in the English short form used on travel documents. The Kurdistan
     Region is listed first: it is not a separate nationality on a passport,
     but it is how most of our candidates describe themselves, and the case
     officer needs to know which authority issued the documents. */
  /* ------------------------------------------------------------------------
     Country dialling codes

     Only the ISO code and the number are listed. The country's name comes
     from Intl.DisplayNames, so it arrives in whatever language the phone is
     set to — Arabic on an Arabic phone, Kurdish where the device has it — and
     the flag is built from the ISO letters rather than pasted in as an emoji
     nobody can search for.

     A flag emoji is two regional-indicator letters. Windows has no font for
     them and shows the letters instead, which still reads as "IQ +964", so
     the code is kept next to the name for everyone.
     ------------------------------------------------------------------------ */
  var DIAL_CODES = [
    ['IQ', '964'], ['SY', '963'], ['IR', '98'], ['TR', '90'], ['JO', '962'],
    ['LB', '961'], ['SA', '966'], ['AE', '971'], ['QA', '974'], ['KW', '965'],
    ['BH', '973'], ['OM', '968'], ['YE', '967'], ['EG', '20'], ['PS', '970'],
    null,
    ['AF', '93'], ['AL', '355'], ['DZ', '213'], ['AM', '374'], ['AT', '43'],
    ['AU', '61'], ['AZ', '994'], ['BD', '880'], ['BY', '375'], ['BE', '32'],
    ['BA', '387'], ['BR', '55'], ['BG', '359'], ['CA', '1'], ['CN', '86'],
    ['HR', '385'], ['CY', '357'], ['CZ', '420'], ['DK', '45'], ['EE', '372'],
    ['ET', '251'], ['FI', '358'], ['FR', '33'], ['GE', '995'], ['DE', '49'],
    ['GH', '233'], ['GR', '30'], ['HU', '36'], ['IN', '91'], ['ID', '62'],
    ['IE', '353'], ['IL', '972'], ['IT', '39'], ['JP', '81'], ['KZ', '7'],
    ['KE', '254'], ['KG', '996'], ['LV', '371'], ['LY', '218'], ['LT', '370'],
    ['LU', '352'], ['MY', '60'], ['MT', '356'], ['MX', '52'], ['MD', '373'],
    ['MA', '212'], ['NL', '31'], ['NZ', '64'], ['NG', '234'], ['NO', '47'],
    ['PK', '92'], ['PH', '63'], ['PL', '48'], ['PT', '351'], ['RO', '40'],
    ['RU', '7'], ['RS', '381'], ['SG', '65'], ['SK', '421'], ['SI', '386'],
    ['SO', '252'], ['ZA', '27'], ['KR', '82'], ['ES', '34'], ['SD', '249'],
    ['SE', '46'], ['CH', '41'], ['TJ', '992'], ['TZ', '255'], ['TH', '66'],
    ['TN', '216'], ['TM', '993'], ['UA', '380'], ['GB', '44'], ['US', '1'],
    ['UZ', '998'], ['VN', '84']
  ];

  /* The languages the wizard offers. The codes are the site's own list; every
     name is asked of the device, so an Arabic phone lists them in Arabic. The
     ones our candidates actually speak are floated to the top — the rest stay
     alphabetical by their own name. */
  var LANGUAGE_CHOICES = (function () {
    var first = ['ckb', 'ku', 'ar', 'en', 'tr', 'fa'];
    var rest = LANG_CODES.filter(function (c) { return first.indexOf(c) === -1; });
    var named = function (c) { return langName(c, currentLang()) || c; };
    rest.sort(function (a, b) { return named(a).localeCompare(named(b)); });
    return first.concat(['—'], rest);
  })();

  /* "+964 750 123 4567" -> { cc: '964', rest: '750 123 4567' }. Longest code
     first, so +1 never swallows a +964. An empty value falls back to the code
     the device's locale suggests. */
  function splitPhone(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return { cc: guessDialCode(), rest: '' };

    var digits = raw.replace(/[^\d+]/g, '');
    var codes = DIAL_CODES.filter(Boolean).map(function (e) { return e[1]; })
      .sort(function (a, b) { return b.length - a.length; });

    if (digits.charAt(0) === '+') {
      var bare = digits.slice(1);
      for (var i = 0; i < codes.length; i++) {
        if (bare.indexOf(codes[i]) === 0) {
          return { cc: codes[i], rest: bare.slice(codes[i].length) };
        }
      }
    }
    return { cc: guessDialCode(), rest: raw };
  }

  function flagEmoji(iso2) {
    return String(iso2).toUpperCase().replace(/./g, function (c) {
      return String.fromCodePoint(127397 + c.charCodeAt(0));
    });
  }

  /* The device's own name for a country, in the language it is set to. */
  function regionName(iso2) {
    try {
      var name = new Intl.DisplayNames([currentLang(), 'en'], { type: 'region' }).of(iso2);
      if (name && name !== iso2) return name;
    } catch (e) { /* older browser — fall through */ }
    return iso2;
  }

  /* Best guess at the visitor's dialling code, from the device locale. */
  function guessDialCode() {
    var tags = (navigator.languages && navigator.languages.length)
      ? navigator.languages : [navigator.language || ''];
    for (var i = 0; i < tags.length; i++) {
      var m = /-([A-Z]{2})\b/.exec(String(tags[i]).toUpperCase());
      if (!m) continue;
      for (var j = 0; j < DIAL_CODES.length; j++) {
        if (DIAL_CODES[j] && DIAL_CODES[j][0] === m[1]) return DIAL_CODES[j][1];
      }
    }
    return '964';
  }

  var NATIONALITIES = [
    'Iraq — Kurdistan Region', 'Iraq', 'Syria', 'Iran', 'Turkey', 'Jordan', 'Lebanon',
    '—',
    'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda',
    'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain',
    'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan',
    'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria',
    'Burkina Faso', 'Burundi', 'Cambodia', 'Cameroon', 'Canada', 'Cape Verde',
    'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros',
    'Congo', 'Congo (Democratic Republic)', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus',
    'Czechia', 'Denmark', 'Djibouti', 'Dominica', 'Dominican Republic', 'Ecuador',
    'Egypt', 'El Salvador', 'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini',
    'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia', 'Germany',
    'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana',
    'Haiti', 'Honduras', 'Hong Kong', 'Hungary', 'Iceland', 'India', 'Indonesia',
    'Ireland', 'Israel', 'Italy', 'Ivory Coast', 'Jamaica', 'Japan', 'Kazakhstan',
    'Kenya', 'Kiribati', 'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia',
    'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg',
    'Macau', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta',
    'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova',
    'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia',
    'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria',
    'North Korea', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau',
    'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines',
    'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda',
    'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines',
    'Samoa', 'San Marino', 'Sao Tome and Principe', 'Saudi Arabia', 'Senegal',
    'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia',
    'Solomon Islands', 'Somalia', 'South Africa', 'South Korea', 'South Sudan',
    'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Taiwan',
    'Tajikistan', 'Tanzania', 'Thailand', 'Timor-Leste', 'Togo', 'Tonga',
    'Trinidad and Tobago', 'Tunisia', 'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine',
    'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay',
    'Uzbekistan', 'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Yemen',
    'Zambia', 'Zimbabwe', 'Stateless', 'Other'
  ];

  var APPLY_STEPS = [
    /* Nothing is collected until this is accepted. It is a real step so it
       gets its own screen, its own history entry and its own Back button. */
    { id: 'consent', type: 'consent', label: 'Before you start' },

    { id: 'fullName', type: 'text', label: 'What is your full name?',
      help: 'Exactly as it appears on your passport or national ID.',
      placeholder: 'First and family name', autocomplete: 'name',
      validate: function (v) { return v.trim().length >= 3 || 'Please enter your full name.'; } },

    { id: 'phone', type: 'tel', label: 'What is your phone number?',
      help: 'We reply on WhatsApp where possible.',
      placeholder: '750 123 4567', autocomplete: 'tel',
      validate: function (v) { return v.replace(/\D/g, '').length >= 9 || 'Please enter a phone number we can reach you on.'; } },

    /* Date of birth rather than a typed age: it is what the passport and every
       consulate form actually asks for, it cannot drift out of date in a file
       that sits open for months, and the device supplies its own date picker
       so nobody mistypes it. The age is derived, never entered. */
    { id: 'dob', type: 'date', label: 'What is your date of birth?',
      help: 'As printed on your passport or national ID. We work out your age from this.',
      min: minDobISO(), max: maxDobISO(),
      validate: function (v) {
        if (!v) return 'Please choose your date of birth.';
        var age = ageFromDob(v);
        if (age == null) return 'That date does not look right.';
        if (age < 16) return 'You must be at least 16 to apply.';
        if (age > 70) return 'Please contact the office directly — we cannot process this online.';
        return true;
      } },

    { id: 'gender', type: 'select', label: 'Gender',
      options: ['Male', 'Female', 'Prefer not to say'] },

    /* Every country, from the system list, rather than six guesses and a text
       box. The region is offered first because it is who applies most. */
    { id: 'nationality', type: 'select', search: true,
      label: 'What is your nationality?',
      help: 'Start typing to find your country.',
      placeholder: 'Search countries…',
      options: NATIONALITIES,
      validate: function (v) {
        return (v && String(v).trim()) ? true : 'Please choose your nationality.';
      } },

    { id: 'maritalStatus', type: 'select', label: 'Are you married or single?',
      options: ['Single', 'Married', 'Divorced', 'Widowed'] },

    { id: 'familyMembers', type: 'number', label: 'How many people are in your family?',
      help: 'Including yourself. This helps us advise on housing and family visas.',
      placeholder: 'Number of family members', min: 1, max: 30,
      validate: function (v) {
        var n = Number(v);
        return (v !== '' && n >= 1 && n <= 30) || 'Enter a number between 1 and 30.';
      } },

    { id: 'education', type: 'choice', label: 'What is your highest level of education?',
      options: ['No formal schooling', 'Primary school', 'Secondary / high school',
                'Vocational / diploma', "Bachelor's degree", "Master's degree or higher"] },

    { id: 'currentJob', type: 'text', label: 'What is your current job?',
      help: 'Write "Not working" if you are between jobs.',
      placeholder: 'e.g. Electrician at a construction company',
      validate: function (v) { return v.trim().length >= 2 || 'Tell us your current job, or write "Not working".'; } },

    { id: 'experience', type: 'textarea', label: 'What work experience do you have?',
      help: 'Trade, how many years, which employers and which countries.',
      placeholder: 'e.g. 6 years as an electrician in Erbil, 2 years in Turkey…',
      validate: function (v) { return v.trim().length >= 15 || 'Please give us a little more detail — a sentence or two is enough.'; } },

    { id: 'skills', type: 'textarea', label: 'What skills do you have?',
      help: 'Licences, certificates, machines you can operate, software you know.',
      placeholder: 'e.g. Driving licence, forklift certificate, welding MIG/MAG…',
      validate: function (v) { return v.trim().length >= 3 || 'List at least one skill.'; } },

    { id: 'languages', type: 'multiselect', label: 'Which languages do you speak?',
      help: 'Choose every one you speak. The names come from your device.',
      options: LANGUAGE_CHOICES,
      validate: function (v) { return (v && v.length) ? true : 'Select at least one language.'; } },

    { id: 'criminalRecord', type: 'choice', label: 'Have you ever been arrested or convicted of a crime?',
      help: 'Answer honestly. Consulates check this, and a declared old case is far less of a problem than one they discover.',
      options: ['No', 'Yes'] },

    { id: 'criminalDetails', type: 'textarea', label: 'Please give the details',
      help: 'Year, country, the charge, and whether the case is closed.',
      placeholder: 'e.g. 2016, Iraq, traffic offence, case closed and fine paid',
      onlyIf: function (d) { return d.criminalRecord === 'Yes'; },
      validate: function (v) { return v.trim().length >= 10 || 'Please describe the case briefly.'; } },

    { id: 'selfie', type: 'photo', label: 'Now take a selfie',
      help: 'Stand in a bright place, face the camera and keep your whole face visible.',
      guide: true, capture: 'user' },

    { id: 'idFront', type: 'photo', label: 'Photo of your national ID — front',
      help: 'Lay it flat, fill the frame, and make sure every number is readable.' },

    { id: 'idBack', type: 'photo', label: 'Photo of your national ID — back',
      help: 'Same again for the reverse side.' }
  ];

  var applyState = null;

  function applyVisibleSteps() {
    return APPLY_STEPS.filter(function (s) {
      return !s.onlyIf || s.onlyIf(applyState.data);
    });
  }

  /* --- Opening and closing ------------------------------------------------ */
  /* The wizard's heading names the role being applied for. One builder keeps
     it consistent and lets a language switch re-draw it without reopening. */
  function setApplyJobLabel(job) {
    var label = $('[data-apply-job]');
    if (!label) return;
    label.innerHTML = job
      ? tr('Applying for') + ' <strong>' + escapeHtml(tr(job.title)) + '</strong> — ' +
        escapeHtml(job.city) + ', ' + escapeHtml(tr(job.country))
      : tr('Open application');
  }

  function openApply(jobId) {
    var root = $('[data-apply]');
    if (!root) { window.location.href = 'contact.html?job=' + encodeURIComponent(jobId); return; }

    var job = JOBS.filter(function (j) { return j.id === jobId; })[0];

    applyState = {
      i: 0,
      data: {},
      jobId: jobId,
      job: job,
      sending: false,
      done: false,
      lastFocus: document.activeElement
    };

    setApplyJobLabel(job);

    root.hidden = false;
    document.body.classList.add('is-locked');

    /* Each screen becomes its own history entry, so the phone's Back button
       returns to the previous question instead of leaving the site. */
    applyState.baseUrl = window.location.pathname + window.location.search;
    pushApplyHistory(true);

    renderApplyStep();
  }

  /* history: replace for the first screen, push for the rest. Guarded so the
     popstate handler can move between steps without pushing again. */
  var applyPopping = false;

  function pushApplyHistory(replace) {
    if (!applyState || !window.history || !window.history.pushState) return;

    var step = applyVisibleSteps()[applyState.i];
    var slug = step ? step.id : 'review';
    var url = applyState.baseUrl + '#apply/' + slug;
    var state = { aryosApply: true, step: applyState.i };

    try {
      if (replace) window.history.replaceState(state, '', url);
      else window.history.pushState(state, '', url);
    } catch (e) { /* file:// blocks pushState — the wizard still works */ }
  }

  function onApplyPop(e) {
    var root = $('[data-apply]');
    if (!root || root.hidden || !applyState) return;

    var st = e.state;

    /* Navigated away from the wizard entirely — close it. */
    if (!st || !st.aryosApply) {
      applyPopping = true;
      closeApply(true);
      applyPopping = false;
      return;
    }

    /* Otherwise land on whichever step that entry represents. */
    var target = Math.max(0, Math.min(st.step, applyVisibleSteps().length));
    if (target === applyState.i) return;

    applyPopping = true;
    var back = target < applyState.i;
    applyState.i = target;
    renderApplyStep(back ? 'back' : 'fwd');
    applyPopping = false;
  }

  function closeApply(force) {
    var root = $('[data-apply]');
    if (!root || root.hidden) return;

    var answered = applyState && Object.keys(applyState.data).length > 0;
    if (!force && answered && !applyState.done &&
        !window.confirm(tr('Close the application? Your answers will be lost.'))) {
      return;
    }

    root.hidden = true;
    document.body.classList.remove('is-locked');

    /* Drop the wizard's history entries so Back does not reopen it. */
    if (!applyPopping && window.history && window.history.state &&
        window.history.state.aryosApply) {
      try {
        window.history.replaceState({}, '', applyState.baseUrl || window.location.pathname);
      } catch (e) { /* ignore */ }
    }

    if (applyState && applyState.lastFocus && applyState.lastFocus.focus) {
      applyState.lastFocus.focus();
    }
    applyState = null;
  }

  /* --- Rendering ---------------------------------------------------------- */
  function renderApplyStep(direction) {
    var body = $('[data-apply-body]');
    var steps = applyVisibleSteps();
    var step = steps[applyState.i];

    /* Record the new screen unless we got here by the Back button itself. */
    if (!applyPopping && direction) pushApplyHistory(false);

    updateApplyChrome(steps);

    if (!step) { renderApplyReview(); return; }

    var value = applyState.data[step.id];
    var html = '<div class="astep" data-astep>' +
      '<h3 class="astep__q">' + escapeHtml(tr(step.label)) + '</h3>' +
      (step.help ? '<p class="astep__help">' + escapeHtml(tr(step.help)) + '</p>' : '');

    if (step.type === 'tel') {
      /* The dialling code is its own native picker rather than something to
         type: it removes the commonest mistake on the form (a number saved
         with no country code, or with a leading zero that should have gone).
         The two controls sit on one row and are joined back together on save. */
      var split = splitPhone(value);
      html += '<div class="aphone">' +
        '<select class="astep__input aphone__cc" data-acc ' +
        'aria-label="' + escapeHtml(tr('Country code')) + '">';
      DIAL_CODES.forEach(function (entry) {
        if (!entry) { html += '<option disabled>──────────</option>'; return; }
        var iso = entry[0], dial = entry[1];
        html += '<option value="' + dial + '" data-iso="' + iso + '"' +
          (split.cc === dial ? ' selected' : '') + '>' +
          escapeHtml(flagEmoji(iso) + ' ' + regionName(iso) + ' +' + dial) + '</option>';
      });
      html += '</select>' +
        '<input class="astep__input aphone__num" type="tel" inputmode="tel" ' +
        (step.autocomplete ? 'autocomplete="' + step.autocomplete + '" ' : '') +
        'placeholder="' + escapeHtml(tr(step.placeholder) || '') + '" ' +
        'value="' + escapeHtml(split.rest) + '" data-afield>' +
        '</div>';

    } else if (step.type === 'text' || step.type === 'number') {
      html += '<input class="astep__input" type="' +
        (step.type === 'number' ? 'number' : 'text') + '" ' +
        (step.type === 'number' ? 'inputmode="numeric" min="' + step.min + '" max="' + step.max + '" ' : '') +
        (step.autocomplete ? 'autocomplete="' + step.autocomplete + '" ' : 'autocomplete="off" ') +
        'placeholder="' + escapeHtml(tr(step.placeholder) || '') + '" ' +
        'value="' + escapeHtml(value == null ? '' : value) + '" data-afield>';

    } else if (step.type === 'date') {
      /* The platform's own date picker — a spinner on iOS, a calendar on
         Android — so nobody types a date in the wrong order. min/max stop an
         out-of-range birthday being pickable at all, rather than accepting it
         and complaining afterwards. */
      html += '<input class="astep__input astep__input--date" type="date" ' +
        'min="' + escapeHtml(step.min || '') + '" max="' + escapeHtml(step.max || '') + '" ' +
        'value="' + escapeHtml(value == null ? '' : value) + '" ' +
        'autocomplete="bday" data-afield>' +
        '<p class="astep__note" data-aderived aria-live="polite">' +
        (value ? escapeHtml(formatDob(value)) : '') + '</p>';

    } else if (step.type === 'select') {
      /* A closed <select> is the one control every platform renders itself:
         the wheel on iOS, the dialog on Android, the OS dropdown on desktop.
         It used to carry size="8", which turns it into an inline list box and
         stops the native picker opening at all — so the size is gone.

         The search field is only for the country list; with 190 entries the
         wheel alone is painful. Short lists get no clutter. */
      if (step.search) {
        html += '<input class="astep__input astep__input--search" type="text" ' +
          'placeholder="' + escapeHtml(tr(step.placeholder) || tr('Search…')) + '" ' +
          'autocomplete="off" aria-label="' + escapeHtml(tr('Filter the list')) + '" data-afilter>';
      }
      html += '<select class="astep__input astep__input--select" data-afield ' +
        'aria-label="' + escapeHtml(tr(step.label)) + '">';
      if (value == null || value === '') {
        html += '<option value="" disabled selected>' +
          escapeHtml(tr('Choose…')) + '</option>';
      }
      step.options.forEach(function (o) {
        if (o === '—') {
          html += '<option disabled>──────────</option>';
          return;
        }
        html += '<option value="' + escapeHtml(o) + '"' +
          (value === o ? ' selected' : '') + '>' + escapeHtml(tr(o)) + '</option>';
      });
      html += '</select>';

    } else if (step.type === 'multiselect') {
      /* The platform's own multi-picker. iOS and Android both open a proper
         selection sheet for this; on a desktop it is a list you ctrl-click,
         so the hint below says so rather than leaving people guessing. */
      var chosen = value || [];
      html += '<select class="astep__input astep__input--multi" multiple size="8" ' +
        'data-afield aria-label="' + escapeHtml(tr(step.label)) + '">';
      step.options.forEach(function (o) {
        if (o === '—') {
          html += '<option disabled>──────────</option>';
          return;
        }
        var isCode = /^[a-z]{2,3}(-[A-Za-z]+)?$/.test(o);
        /* Shown in the applicant's own language, stored in English: the
           office and the employer read one consistent set of names however
           the applicant's phone is set. */
        var label = isCode ? langName(o, currentLang()) : tr(o);
        var stored = isCode ? langName(o, 'en') : o;
        html += '<option value="' + escapeHtml(stored) + '"' +
          (chosen.indexOf(stored) !== -1 ? ' selected' : '') + '>' +
          escapeHtml(label) + '</option>';
      });
      html += '</select><p class="astep__note" data-acount></p>';

    } else if (step.type === 'textarea') {
      html += '<textarea class="astep__input astep__input--area" rows="5" ' +
        'placeholder="' + escapeHtml(tr(step.placeholder) || '') + '" data-afield>' +
        escapeHtml(value == null ? '' : value) + '</textarea>';

    } else if (step.type === 'choice') {
      html += '<div class="achoices" role="radiogroup" aria-label="' + escapeHtml(tr(step.label)) + '">';
      step.options.forEach(function (o) {
        html += '<button type="button" class="achoice' + (value === o ? ' is-on' : '') +
          '" role="radio" aria-checked="' + (value === o) + '" data-achoice="' + escapeHtml(o) + '">' +
          '<span class="achoice__dot" aria-hidden="true"></span>' + escapeHtml(tr(o)) + '</button>';
      });
      if (step.other) {
        var isOther = value != null && step.options.indexOf(value) === -1 && value !== '';
        html += '<button type="button" class="achoice' + (isOther ? ' is-on' : '') +
          '" role="radio" aria-checked="' + isOther + '" data-aother>' +
          '<span class="achoice__dot" aria-hidden="true"></span>' + escapeHtml(tr(step.other)) + '</button>';
        html += '<input class="astep__input astep__input--other" type="text" ' +
          'placeholder="' + escapeHtml(tr('Type it here')) + '" value="' + (isOther ? escapeHtml(value) : '') + '" ' +
          'data-aotherfield' + (isOther ? '' : ' hidden') + '>';
      }
      html += '</div>';

    } else if (step.type === 'tags') {
      var picked = value || [];
      html += '<div class="achoices achoices--wrap">';
      step.options.forEach(function (o) {
        var on = picked.indexOf(o) !== -1;
        html += '<button type="button" class="atag' + (on ? ' is-on' : '') +
          '" aria-pressed="' + on + '" data-atag="' + escapeHtml(o) + '">' + escapeHtml(tr(o)) + '</button>';
      });
      html += '</div>' +
        '<input class="astep__input astep__input--other" type="text" ' +
        'placeholder="' + escapeHtml(tr(step.other) || tr('Add another')) + '" data-aextra>' +
        '<p class="astep__note" data-acount></p>';

    } else if (step.type === 'photo') {
      html += applyPhotoMarkup(step, value);

    } else if (step.type === 'consent') {
      html += applyConsentMarkup(value === true);
    }

    html += '<p class="astep__error" data-aerror hidden></p></div>';

    body.innerHTML = html;
    body.scrollTop = 0;

    var panel = $('[data-apply-panel]');
    if (panel && motionOK()) {
      panel.classList.remove('is-fwd', 'is-back');
      void panel.offsetWidth;
      panel.classList.add(direction === 'back' ? 'is-back' : 'is-fwd');
    }

    wireApplyStep(step);
  }

  /* The gate every applicant passes through first. The points below are a
     plain-language summary; terms.html carries the full text. */
  var CONSENT_POINTS = [
    ['What we collect',
     'Your answers, a selfie and photographs of both sides of your national ID. ' +
     'We need the ID to prepare a work permit and visa application in your name.'],
    ['Who sees it',
     'Aryos Group staff, the employer offering the job, and the consulate or ' +
     'immigration authority handling your permit. Nobody else.'],
    ['We never ask for money to apply',
     'Applying is free. No Aryos Group employee will ever ask you for a payment ' +
     'to be shortlisted. Report anyone who does.'],
    ['Your answers must be true',
     'Consulates verify what you tell them. A false answer — especially about a ' +
     'past arrest — can get your application refused and you banned from ' +
     'reapplying for years.'],
    ['You stay in control',
     'You can ask us to correct or delete your file at any time. Files with no ' +
     'activity are deleted after 24 months.']
  ];

  function applyConsentMarkup(agreed) {
    var points = CONSENT_POINTS.map(function (p) {
      return '<li class="aterms__point">' +
        '<strong>' + escapeHtml(tr(p[0])) + '</strong>' +
        '<span>' + escapeHtml(tr(p[1])) + '</span></li>';
    }).join('');

    return '' +
      '<ul class="aterms">' + points + '</ul>' +
      '<p class="aterms__link">' +
        tr('Read the') + ' <a href="terms.html" target="_blank" rel="noopener">' +
        tr('full terms of use and privacy notice') + '</a> ' +
        tr('(opens in a new tab).') +
      '</p>' +
      '<label class="aagree' + (agreed ? ' is-on' : '') + '" data-aagree-box>' +
        '<input type="checkbox" data-aagree' + (agreed ? ' checked' : '') + '>' +
        '<span class="aagree__box" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-11"/></svg>' +
        '</span>' +
        '<span class="aagree__text">' +
          escapeHtml(tr('I have read and agree to the terms of use and privacy notice, and I confirm that the information I am about to give is true.')) +
        '</span>' +
      '</label>';
  }

  function applyPhotoMarkup(step, value) {
    var html = '';

    /* The two guide images carry their own headings and captions, so no
       labels are added around them — that would only repeat the artwork. */
    if (step.guide) {
      html +=
        '<div class="aguide">' +
          '<picture class="aguide__item">' +
            '<source type="image/webp" srcset="media/guide/kyc-good-480.webp 480w, media/guide/kyc-good.webp 719w" ' +
                    'sizes="(min-width: 560px) 47vw, 100vw">' +
            '<img src="media/guide/kyc-good.jpg" ' +
                 'srcset="media/guide/kyc-good-480.jpg 480w, media/guide/kyc-good.jpg 719w" ' +
                 'sizes="(min-width: 560px) 47vw, 100vw" ' +
                 'width="719" height="1086" loading="lazy" decoding="async" ' +
                 'alt="' + escapeHtml(tr('Good KYC photo, accepted: well lit, face clearly visible and facing the camera')) + '">' +
          '</picture>' +
          '<picture class="aguide__item">' +
            '<source type="image/webp" srcset="media/guide/kyc-bad-480.webp 480w, media/guide/kyc-bad.webp 708w" ' +
                    'sizes="(min-width: 560px) 47vw, 100vw">' +
            '<img src="media/guide/kyc-bad.jpg" ' +
                 'srcset="media/guide/kyc-bad-480.jpg 480w, media/guide/kyc-bad.jpg 708w" ' +
                 'sizes="(min-width: 560px) 47vw, 100vw" ' +
                 'width="708" height="1086" loading="lazy" decoding="async" ' +
                 'alt="' + escapeHtml(tr('Bad KYC photos, rejected: one too dark to see the face, one not facing the camera')) + '">' +
          '</picture>' +
        '</div>';
    }

    html +=
      '<div class="ashot' + (value ? ' has-photo' : '') + '" data-ashot>' +
        '<div class="ashot__preview" data-apreview>' +
          (value ? '<img src="' + value + '" alt="' + escapeHtml(tr('Your photo')) + '">' : '') +
        '</div>' +
        '<label class="ashot__drop">' +
          '<input type="file" accept="image/*"' +
            (step.capture ? ' capture="' + step.capture + '"' : '') +
            ' data-aphoto hidden>' +
          '<span class="ashot__icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.4"/></svg>' +
          '</span>' +
          '<span class="ashot__label">' + escapeHtml(tr(value ? 'Take a different photo' : 'Take or choose a photo')) + '</span>' +
          '<small class="ashot__hint">' + escapeHtml(tr('JPG or PNG · up to 12 MB')) + '</small>' +
        '</label>' +
      '</div>';

    return html;
  }

  function updateApplyChrome(steps) {
    var total = steps.length + 1;                 /* + the review screen */
    var at = Math.min(applyState.i, steps.length);
    var pct = Math.round((at / total) * 100);

    var onConsent = steps[at] && steps[at].type === 'consent';
    /* The terms screen is not a question, so it is excluded from the count. */
    var questions = steps.filter(function (s) { return s.type !== 'consent'; }).length;
    var qAt = steps.slice(0, at).filter(function (s) { return s.type !== 'consent'; }).length;

    var bar = $('[data-apply-bar]');
    var track = $('[data-apply-progress]');
    var count = $('[data-apply-count]');
    var back = $('[data-apply-back]');
    var next = $('[data-apply-next]');

    if (bar) bar.style.transform = 'scaleX(' + (at / total) + ')';
    if (track) track.setAttribute('aria-valuenow', String(pct));
    if (count) {
      count.textContent =
        applyState.done ? '' :
        onConsent       ? tr('Terms of use') :
        at >= steps.length ? tr('Last step — check your answers')
                           : trt('Question {0} of {1}', undefined, qAt + 1, questions);
    }
    if (back) back.hidden = applyState.i === 0 || applyState.done;
    if (next) {
      next.hidden = !!applyState.done;
      next.textContent =
        onConsent ? tr('I agree — continue') :
        at >= steps.length ? tr('Send application') : tr('Continue');
    }
  }

  function wireApplyStep(step) {
    var body = $('[data-apply-body]');
    var field = $('[data-afield]', body);

    /* Consent: Continue stays disabled until the box is ticked. */
    if (step.type === 'consent') {
      var box = $('[data-aagree]', body);
      var wrap = $('[data-aagree-box]', body);
      var cont = $('[data-apply-next]');

      var sync = function () {
        applyState.data.consent = !!box.checked;
        if (wrap) wrap.classList.toggle('is-on', box.checked);
        if (cont) {
          cont.disabled = !box.checked;
          cont.classList.toggle('is-disabled', !box.checked);
        }
        if (box.checked) clearApplyError();
      };

      box.addEventListener('change', sync);
      sync();
      return;
    }

    /* Every other step re-enables it. */
    var nextBtn = $('[data-apply-next]');
    if (nextBtn) { nextBtn.disabled = false; nextBtn.classList.remove('is-disabled'); }

    if (field) {
      /* Never steal focus on a touch device: it throws up the keyboard over
         the question the person is still reading. A <select> is worse — it
         opens the picker before they have seen the list. */
      if (!('ontouchstart' in window) && step.type !== 'select') field.focus();
      field.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && step.type !== 'textarea') {
          e.preventDefault();
          applyNext();
        }
      });
      field.addEventListener('input', clearApplyError);
    }

    /* Date of birth: echo the age back as it is picked, so the person can see
       we read the date the way they meant it. */
    if (step.type === 'date' && field) {
      var derived = $('[data-aderived]', body);
      var showAge = function () {
        if (!derived) return;
        derived.textContent = field.value ? formatDob(field.value) : '';
      };
      field.addEventListener('change', showAge);
      field.addEventListener('input', showAge);
    }

    /* The dialling code is remembered as soon as it changes, so going Back
       and forward again does not reset it. */
    if (step.type === 'tel') {
      var ccField = $('[data-acc]', body);
      if (ccField) {
        ccField.addEventListener('change', function () {
          clearApplyError();
          if (field && field.value.trim()) {
            applyState.data[step.id] = readApplyField(step);
          }
        });
      }
    }

    /* Multi-select: keep a running count so it is obvious something was
       chosen, especially on a desktop list where selection is easy to miss. */
    if (step.type === 'multiselect' && field) {
      var note = $('[data-acount]', body);
      var tally = function () {
        var n = $$('option', field).filter(function (o) { return o.selected && !o.disabled; }).length;
        if (note) {
          note.textContent = n
            ? n + ' ' + (n === 1 ? tr('language selected') : tr('languages selected'))
            : tr('On a computer, hold Ctrl (or ⌘) to choose more than one.');
        }
        if (n) clearApplyError();
      };
      field.addEventListener('change', tally);
      tally();
    }

    /* Long list: filter it down as they type, and keep the current pick
       visible when the filter is cleared. */
    if (step.type === 'select' && field) {
      var filter = $('[data-afilter]', body);
      if (filter) {
        filter.addEventListener('input', function () {
          var q = filter.value.trim().toLowerCase();
          var startsWith = null;
          $$('option', field).forEach(function (opt) {
            if (opt.disabled) { opt.hidden = !!q; return; }   // hide the divider while filtering
            var name = opt.value.toLowerCase();
            var hit = !q || name.indexOf(q) !== -1;
            opt.hidden = !hit;
            if (q && !startsWith && name.indexOf(q) === 0) startsWith = opt;
          });
          /* Only jump the selection for a match on the start of the name.
             Typing "ger" should land on Germany, not on Algeria because the
             letters happen to appear in the middle of it — and if nothing
             starts with what they typed, leave their previous pick alone
             rather than silently answering for them. */
          if (startsWith) field.value = startsWith.value;
          if (field.value) applyState.data[step.id] = field.value;
          clearApplyError();
        });
      }
      field.addEventListener('change', function () {
        applyState.data[step.id] = field.value;
        clearApplyError();
      });
    }

    /* Single-choice */
    $$('[data-achoice]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyState.data[step.id] = btn.getAttribute('data-achoice');
        clearApplyError();
        var other = $('[data-aotherfield]', body);
        if (other) other.hidden = true;
        $$('[data-achoice],[data-aother]', body).forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-checked', String(on));
        });
        /* A tap is an answer — move on, but leave time to see the selection. */
        window.setTimeout(applyNext, motionOK() ? 220 : 0);
      });
    });

    var otherBtn = $('[data-aother]', body);
    if (otherBtn) {
      otherBtn.addEventListener('click', function () {
        var other = $('[data-aotherfield]', body);
        $$('[data-achoice],[data-aother]', body).forEach(function (b) {
          var on = b === otherBtn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-checked', String(on));
        });
        if (other) { other.hidden = false; other.focus(); }
        applyState.data[step.id] = other ? other.value.trim() : '';
      });
      var otherField = $('[data-aotherfield]', body);
      if (otherField) {
        otherField.addEventListener('input', function () {
          applyState.data[step.id] = otherField.value.trim();
          clearApplyError();
        });
        otherField.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); applyNext(); }
        });
      }
    }

    /* Multi-select */
    if (step.type === 'tags') {
      if (!applyState.data[step.id]) applyState.data[step.id] = [];
      var picked = applyState.data[step.id];

      var refresh = function () {
        var note = $('[data-acount]', body);
        if (note) {
          note.textContent = picked.length
            ? picked.length + ' ' + (picked.length === 1 ? tr('language selected') : tr('languages selected'))
            : '';
        }
      };
      refresh();

      $$('[data-atag]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var v = btn.getAttribute('data-atag');
          var at = picked.indexOf(v);
          if (at === -1) picked.push(v); else picked.splice(at, 1);
          btn.classList.toggle('is-on', at === -1);
          btn.setAttribute('aria-pressed', String(at === -1));
          clearApplyError();
          refresh();
        });
      });

      var extra = $('[data-aextra]', body);
      if (extra) {
        extra.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          var v = extra.value.trim();
          if (!v) { applyNext(); return; }
          if (picked.indexOf(v) === -1) picked.push(v);
          extra.value = '';
          renderApplyStep();
        });
      }
    }

    /* Photo capture */
    var input = $('[data-aphoto]', body);
    if (input) {
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          showApplyError('That file is not an image. Please choose a photo.');
          return;
        }
        if (file.size > 12 * 1024 * 1024) {
          showApplyError('That photo is larger than 12 MB. Try again with a smaller one.');
          return;
        }

        var shot = $('[data-ashot]', body);
        shot.classList.add('is-working');
        clearApplyError();

        shrinkImage(file, 1400, 0.85, function (dataUrl) {
          shot.classList.remove('is-working');
          if (!dataUrl) {
            showApplyError('That photo could not be read. Please try another one.');
            return;
          }
          applyState.data[step.id] = dataUrl;
          var prev = $('[data-apreview]', body);
          prev.innerHTML = '<img src="' + dataUrl + '" alt="Your photo">';
          shot.classList.add('has-photo');
          var lbl = $('.ashot__label', body);
          if (lbl) lbl.textContent = tr('Take a different photo');
          toast(tr('Photo added'), 'ok');
        });
      });
    }
  }

  /* Photos from a phone camera are several megabytes. Re-encoding in the
     browser keeps the upload small enough to reach Telegram quickly. */
  function shrinkImage(file, maxSide, quality, done) {
    var reader = new FileReader();
    reader.onerror = function () { done(null); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { done(null); };
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, maxSide / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);

        try {
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, cw, ch);
          done(canvas.toDataURL('image/jpeg', quality));
        } catch (e) {
          done(reader.result);          /* canvas blocked — send the original */
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function showApplyError(msg) {
    var el = $('[data-aerror]');
    if (!el) return;
    el.textContent = tr(msg);
    el.hidden = false;
    var step = $('[data-astep]');
    if (step && motionOK()) {
      step.classList.remove('is-invalid');
      void step.offsetWidth;
      step.classList.add('is-invalid');
    }
  }

  function clearApplyError() {
    var el = $('[data-aerror]');
    if (el) { el.hidden = true; el.textContent = ''; }
  }

  /* --- Navigation --------------------------------------------------------- */
  function readApplyField(step) {
    var body = $('[data-apply-body]');
    var field = $('[data-afield]', body);
    if (!field) return applyState.data[step.id];

    /* The number is typed without its country code, so put it back — stored
       and sent as one E.164-looking string the office can dial. */
    if (step.type === 'tel') {
      var cc = $('[data-acc]', body);
      var rest = field.value.replace(/[^\d\s-]/g, '').trim();
      if (!rest) return '';
      /* A local number often starts 0; that zero is dropped once a country
         code is in front of it. */
      rest = rest.replace(/^0+/, '');
      return '+' + (cc ? cc.value : guessDialCode()) + ' ' + rest;
    }

    if (step.type === 'multiselect') {
      return $$('option', field)
        .filter(function (o) { return o.selected && !o.disabled; })
        .map(function (o) { return o.value; });
    }

    return field.value;
  }

  function applyNext() {
    if (!applyState || applyState.sending) return;

    var steps = applyVisibleSteps();
    var step = steps[applyState.i];

    if (!step) { submitApplication(); return; }

    var value = readApplyField(step);

    if (step.type === 'consent') {
      if (applyState.data.consent !== true) {
        showApplyError('Please tick the box to agree before you continue.');
        return;
      }
      applyState.consentAt = new Date().toISOString();
      applyState.i += 1;
      renderApplyStep('fwd');
      return;
    }

    if (step.type === 'photo') {
      if (!applyState.data[step.id]) {
        showApplyError('Please add the photo before continuing.');
        return;
      }
    } else if (step.type === 'tags') {
      var extra = $('[data-aextra]');
      if (extra && extra.value.trim()) {
        var v = extra.value.trim();
        if (applyState.data[step.id].indexOf(v) === -1) applyState.data[step.id].push(v);
        extra.value = '';
      }
      value = applyState.data[step.id];
    } else if (step.type === 'choice') {
      value = applyState.data[step.id];
      if (!value) { showApplyError('Please choose an answer.'); return; }
    }

    if (step.validate) {
      var result = step.validate(value == null ? '' : value);
      if (result !== true) { showApplyError(result); return; }
    }

    if (step.type === 'multiselect') {
      /* An array, not a string — String(value) would flatten the languages
         into "Kurdish,Arabic" and the summary would lose the list. */
      applyState.data[step.id] = value || [];
    } else if (step.type !== 'photo' && step.type !== 'tags' && step.type !== 'choice') {
      applyState.data[step.id] = String(value).trim();
    }

    /* Answering "No" later must not leave stale details behind. */
    if (step.id === 'criminalRecord' && applyState.data.criminalRecord === 'No') {
      delete applyState.data.criminalDetails;
    }

    applyState.i += 1;
    renderApplyStep('fwd');
  }

  /* The on-screen Back button walks the history so the two stay in step. */
  function applyBack() {
    if (!applyState || applyState.i === 0 || applyState.sending) return;

    if (window.history && window.history.state && window.history.state.aryosApply) {
      window.history.back();
      return;
    }
    applyState.i -= 1;
    renderApplyStep('back');
  }

  /* --- Review ------------------------------------------------------------- */
  var APPLY_LABELS = {
    fullName: 'Full name', phone: 'Phone', dob: 'Date of birth', gender: 'Gender',
    nationality: 'Nationality', maritalStatus: 'Marital status',
    familyMembers: 'Family members', education: 'Education',
    currentJob: 'Current job', experience: 'Work experience', skills: 'Skills',
    languages: 'Languages', criminalRecord: 'Arrested or convicted',
    criminalDetails: 'Case details'
  };

  function renderApplyReview() {
    var body = $('[data-apply-body]');
    var d = applyState.data;

    var rows = Object.keys(APPLY_LABELS).map(function (k) {
      if (d[k] == null || d[k] === '') return '';
      var v = Array.isArray(d[k]) ? d[k].join(', ') : d[k];
      /* Show the birth date the way a person reads it, with the age we derived
         from it, so they can check both before sending. */
      if (k === 'dob') v = formatDob(v);
      return '<div class="areview__row"><dt>' + escapeHtml(tr(APPLY_LABELS[k])) + '</dt>' +
             '<dd>' + escapeHtml(v) + '</dd></div>';
    }).join('');

    var shots = [['selfie', 'Selfie'], ['idFront', 'ID front'], ['idBack', 'ID back']]
      .map(function (p) {
        return d[p[0]]
          ? '<figure class="areview__shot"><img src="' + d[p[0]] + '" alt="' + escapeHtml(tr(p[1])) + '">' +
            '<figcaption>' + escapeHtml(tr(p[1])) + '</figcaption></figure>'
          : '';
      }).join('');

    body.innerHTML =
      '<div class="astep" data-astep>' +
        '<h3 class="astep__q">' + escapeHtml(tr('Check your application')) + '</h3>' +
        '<p class="astep__help">' + escapeHtml(tr('Tap Back to change anything. Once you send it, a case officer reviews your file and replies within 48 hours.')) + '</p>' +
        (applyState.job
          ? '<p class="areview__job">' + escapeHtml(tr('Position')) + ': <strong>' +
            escapeHtml(tr(applyState.job.title)) + '</strong> — ' +
            escapeHtml(applyState.job.city) + ', ' + escapeHtml(tr(applyState.job.country)) +
            ' <span>' + escapeHtml(tr('Ref')) + ' ' + escapeHtml(applyState.job.id) + '</span></p>'
          : '') +
        '<dl class="areview">' + rows + '</dl>' +
        '<div class="areview__shots">' + shots + '</div>' +
        '<p class="astep__note">' + escapeHtml(tr('By sending this you agree that Aryos Group may share these details with the employer and the relevant consulate for this application.')) + '</p>' +
        '<p class="astep__error" data-aerror hidden></p>' +
      '</div>';

    body.scrollTop = 0;
  }

  /* --- Submit ------------------------------------------------------------- */
  function submitApplication() {
    var next = $('[data-apply-next]');
    applyState.sending = true;
    setBusy(next, true);

    var payload = {
      jobId: applyState.jobId || '',
      jobTitle: applyState.job ? applyState.job.title : '',
      jobCountry: applyState.job ? applyState.job.country : '',
      jobCity: applyState.job ? applyState.job.city : '',
      submitted: new Date().toISOString(),
      consent: applyState.data.consent === true,
      consentAt: applyState.consentAt || '',
      answers: {}
    };

    Object.keys(applyState.data).forEach(function (k) {
      if (k === 'consent') return;              /* recorded above, not an answer */
      payload.answers[k] = applyState.data[k];
    });

    /* Send the age alongside the birth date. The date is the record of truth —
       it is what the consulate forms need and it does not go stale — but the
       case officer reads the age, so derive it here rather than making them
       work it out in their head. */
    if (applyState.data.dob) {
      var derivedAge = ageFromDob(applyState.data.dob);
      if (derivedAge != null) payload.answers.age = String(derivedAge);
    }

    var box   = $('[data-aprogress]');
    var fill  = $('[data-aprogress-fill]');
    var label = $('[data-aprogress-label]');

    function showProgress(pct) {
      if (!box) return;
      box.hidden = false;
      if (fill) fill.style.width = pct + '%';
      if (label) {
        label.textContent = pct < 100
          ? trt('Sending your application — {0}%', undefined, pct)
          : tr('Almost done — waiting for confirmation…');
      }
    }

    function hideProgress() {
      if (box) box.hidden = true;
      if (fill) fill.style.width = '0%';
    }

    var settled = false;
    var giveUp;

    /* The clock is restarted every time bytes actually move. A candidate on a
       slow connection sending three photographs can legitimately take longer
       than any fixed deadline; what must not be tolerated is a stall. */
    function armTimeout() {
      window.clearTimeout(giveUp);
      giveUp = window.setTimeout(function () { finish(false, 'timeout'); }, 45000);
    }

    function finish(ok, why) {
      if (settled) return;
      settled = true;
      window.clearTimeout(giveUp);
      applyState.sending = false;
      setBusy(next, false);
      hideProgress();
      if (ok) applyDone();
      else applyFailed(why);
    }

    /* XMLHttpRequest rather than fetch: fetch still cannot report upload
       progress, and this request carries several megabytes of photographs up a
       mobile link. Without a meter the candidate watches a frozen button and
       cannot tell a slow upload from a dead one. */
    if (!window.XMLHttpRequest) { finish(false, 'unsupported'); return; }

    var body;
    try {
      body = JSON.stringify(payload);
    } catch (err) {
      finish(false, 'unsupported');
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', APPLY_API, true);
    xhr.setRequestHeader('Content-Type', 'application/json');

    showProgress(0);
    armTimeout();

    if (xhr.upload) {
      xhr.upload.onprogress = function (e) {
        if (!e.lengthComputable) return;
        armTimeout();
        showProgress(Math.min(99, Math.round(e.loaded / e.total * 100)));
      };
      /* Everything is on the wire; the wait is now the server's. */
      xhr.upload.onload = function () { armTimeout(); showProgress(100); };
    }

    xhr.onload = function () {
      if (xhr.status === 429) { finish(false, 'rate'); return; }
      if (xhr.status < 200 || xhr.status >= 300) { finish(false, 'http'); return; }
      var parsed = null;
      try { parsed = JSON.parse(xhr.responseText); } catch (err) { parsed = null; }
      finish(!!(parsed && parsed.ok), 'server');
    };
    xhr.onerror = function () { finish(false, 'network'); };
    xhr.onabort = function () { finish(false, 'network'); };
    xhr.send(body);
  }

  /* ------------------------------------------------------------------------
     Review invitation

     Offered once the application is sent, never before — at that point the
     candidate has actually dealt with us and has something honest to say
     about the process. It is optional, it does not block the confirmation,
     and nothing they write appears on the site until an admin publishes it
     from Telegram.
     ------------------------------------------------------------------------ */
  function reviewInviteMarkup() {
    var stars = '';
    for (var i = 1; i <= 5; i++) {
      stars += '<button type="button" class="rinvite__star" data-rate="' + i +
               '" aria-label="' + escapeHtml(trt('{0} out of 5', undefined, i)) + '">★</button>';
    }
    return '' +
      '<section class="rinvite" data-rinvite>' +
        '<h4>' + escapeHtml(tr('How was the application?')) + '</h4>' +
        '<p class="rinvite__lead">' +
          escapeHtml(tr('Optional. We read every one, and publish it only with your permission.')) +
        '</p>' +
        '<div class="rinvite__stars" role="group" aria-label="' +
          escapeHtml(tr('Your rating')) + '" data-rinvite-stars>' + stars + '</div>' +
        '<textarea class="rinvite__text" rows="3" data-rinvite-text ' +
          'placeholder="' + escapeHtml(tr('What went well, and what could be better?')) + '"></textarea>' +
        '<label class="rinvite__consent">' +
          '<input type="checkbox" data-rinvite-consent>' +
          '<span>' + escapeHtml(tr('Aryos Group may show this on the website with my first name.')) + '</span>' +
        '</label>' +
        '<button type="button" class="btn btn--outline btn--block" data-rinvite-send>' +
          escapeHtml(tr('Send review')) + '</button>' +
        '<p class="rinvite__status" role="status" data-rinvite-status hidden></p>' +
      '</section>';
  }

  function wireReviewInvite() {
    var box = $('[data-rinvite]');
    if (!box) return;

    var rating = 0;
    var starsBox = $('[data-rinvite-stars]', box);
    var status = $('[data-rinvite-status]', box);
    var send = $('[data-rinvite-send]', box);

    function paintStars() {
      $$('.rinvite__star', starsBox).forEach(function (b, i) {
        b.classList.toggle('is-on', i < rating);
        b.setAttribute('aria-pressed', String(i < rating));
      });
    }

    starsBox.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rate]');
      if (!b) return;
      rating = Number(b.getAttribute('data-rate')) || 0;
      paintStars();
    });

    function say(msg, ok) {
      status.hidden = false;
      status.textContent = msg;
      status.classList.toggle('is-ok', !!ok);
    }

    send.addEventListener('click', function () {
      var text = ($('[data-rinvite-text]', box).value || '').trim();
      var consent = $('[data-rinvite-consent]', box).checked;

      if (!rating) { say(tr('Please choose a rating first.')); return; }
      if (text.length < 10) { say(tr('Please write a little more.')); return; }
      if (!consent) { say(tr('Please tick the box so we may show it.')); return; }

      send.disabled = true;
      say(tr('Sending…'));

      var d = (applyState && applyState.data) || {};
      fetch('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          /* First name plus an initial — a full name on a public page is more
             than anyone agreed to. */
          name: shortName(d.fullName || ''),
          place: d.city || d.nationality || '',
          role: (applyState && applyState.jobTitle) || '',
          country: (applyState && applyState.jobCountry) || '',
          rating: rating,
          lang: currentLang(),
          text: text,
          appId: (applyState && applyState.jobId) || ''
        })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (r) {
          if (r && r.ok) {
            box.innerHTML = '<p class="rinvite__thanks">' +
              escapeHtml(tr('Thank you — your review is with our team.')) + '</p>';
          } else {
            send.disabled = false;
            say(tr('We could not send that. Please try again later.'));
          }
        })
        .catch(function () {
          send.disabled = false;
          say(tr('We could not send that. Please try again later.'));
        });
    });
  }

  /* "Karwan Ahmed Salih" -> "Karwan A." */
  function shortName(full) {
    var bits = String(full).trim().split(/\s+/).filter(Boolean);
    if (!bits.length) return '';
    if (bits.length === 1) return bits[0];
    return bits[0] + ' ' + bits[1].charAt(0).toUpperCase() + '.';
  }

  function applyDone() {
    applyState.done = true;
    var body = $('[data-apply-body]');
    var ref = applyState.jobId || '';

    body.innerHTML =
      '<div class="adone">' +
        '<span class="adone__tick" aria-hidden="true">' +
          '<svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l8 8 15-16"/></svg>' +
        '</span>' +
        '<h3>' + escapeHtml(tr('Application sent')) + '</h3>' +
        '<p>' +
          trt('Thank you, {0}.', undefined, escapeHtml((applyState.data.fullName || '').split(' ')[0])) + ' ' +
          tr('Your application has reached our office') +
          (ref ? ' ' + trt('for {0}', undefined, escapeHtml(ref)) : '') + '. ' +
          trt('A case officer will review it and contact you on {0} within 48 hours.',
              undefined, escapeHtml(applyState.data.phone || tr('the number you gave'))) +
        '</p>' +
        '<p class="adone__next">' + escapeHtml(tr('Keep your phone available — we usually reply on WhatsApp.')) + '</p>' +
        '<div class="adone__actions">' +
          '<a class="btn btn--primary btn--block" href="https://wa.me/9647500000000">' + escapeHtml(tr('Message us on WhatsApp')) + '</a>' +
          '<button type="button" class="btn btn--outline btn--block" data-apply-close>' + escapeHtml(tr('Close')) + '</button>' +
        '</div>' +
        reviewInviteMarkup() +
      '</div>';

    wireReviewInvite();

    updateApplyChrome(applyVisibleSteps());
    var bar = $('[data-apply-bar]');
    if (bar) bar.style.transform = 'scaleX(1)';
    var count = $('[data-apply-count]');
    if (count) count.textContent = '';
    toast(tr('Application sent'), 'ok');
  }

  /* The office must still be reachable if the endpoint is down, so the
     candidate is offered WhatsApp and the contact form rather than a dead end. */
  function applyFailed(why) {
    var msg = why === 'rate'
      ? tr('Too many applications from this connection. Please wait a few minutes and try again.')
      : tr('We could not send your application automatically.');

    showApplyError(msg + ' ' + tr('Nothing is lost — contact us directly and quote the job reference.'));

    var body = $('[data-apply-body]');
    if ($('[data-afallback]', body)) return;

    var extra = document.createElement('div');
    extra.className = 'adone__actions';
    extra.setAttribute('data-afallback', '');
    extra.innerHTML =
      '<a class="btn btn--primary btn--block" href="https://wa.me/9647500000000">' + escapeHtml(tr('Send on WhatsApp instead')) + '</a>' +
      '<a class="btn btn--outline btn--block" href="contact.html?job=' +
        encodeURIComponent(applyState.jobId || '') + '">' + escapeHtml(tr('Use the contact form')) + '</a>';
    body.appendChild(extra);
  }

  /* --- Wiring ------------------------------------------------------------- */
  function initApply() {
    var root = $('[data-apply]');
    if (!root) return;

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-apply-close]')) { closeApply(applyState && applyState.done); }
    });

    var next = $('[data-apply-next]');
    var back = $('[data-apply-back]');
    if (next) next.addEventListener('click', applyNext);
    if (back) back.addEventListener('click', applyBack);

    document.addEventListener('keydown', function (e) {
      if (root.hidden) return;
      if (e.key === 'Escape') closeApply(applyState && applyState.done);
    });

    window.addEventListener('popstate', onApplyPop);

    /* Keep focus inside the dialog while it is open. */
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || root.hidden) return;
      var panel = $('[data-apply-panel]');
      var focusable = $$('button, [href], input, select, textarea', panel)
        .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* Apply opens the wizard. */
  function applyJob(id) {
    openApply(id);
  }

  /* ------------------------------------------------------------------------
     6. Visa status lookup
     ------------------------------------------------------------------------ */
  function initVisa() {
    var form = $('[data-visa-form]');
    var out  = $('[data-visa-result]');
    if (!form || !out) return;

    var input = $('#visa-key');
    var button = $('button[type="submit"]', form);
    var panel = form.closest('.panel');

    /* "ary 7k2m9qx4" and "ARY-7K2M-9QX4" are the same key. */
    function normalizeKey(value) {
      var bare = value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^ARY/, '');
      if (/^\d{4}$/.test(bare)) return 'ARY-' + bare;                       // legacy demo keys
      if (/^[A-Z0-9]{8}$/.test(bare)) return 'ARY-' + bare.slice(0, 4) + '-' + bare.slice(4);
      return 'ARY-' + bare;
    }

    /* Re-inserting the markup restarts every entrance animation inside it. */
    function show(html) {
      out.hidden = false;
      out.innerHTML = html;
      void out.offsetWidth;
      wireResult();
    }

    /* Copy button on the reference number, added after each render. */
    function wireResult() {
      var copy = $('[data-copy]', out);
      if (!copy) return;

      copy.addEventListener('click', function () {
        var value = copy.getAttribute('data-copy');
        var done = function () {
          copy.classList.add('is-copied');
          copy.textContent = tr('Copied');
          toast(tr('Reference number copied'), 'ok');
          window.setTimeout(function () {
            copy.classList.remove('is-copied');
            copy.textContent = tr('Copy');
          }, 1800);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(done, function () {
            toast(tr('Could not copy — select the text instead'), 'warn');
          });
        } else {
          toast(tr('Copying is not supported in this browser'), 'warn');
        }
      });
    }

    function notFound(raw) {
      show(notFoundMarkup(
        tr('We could not find a file with the key') + ' <strong>' + escapeHtml(raw) +
        '</strong>. ' + tr('Check the key your case officer sent you, or contact us.')
      ));
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var raw = input.value.trim();
      if (!raw) {
        show(notFoundMarkup(tr('Please enter your visa key to continue.')));
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }

      input.removeAttribute('aria-invalid');
      var key = normalizeKey(raw);

      /* No bot deployed yet — fall back to the built-in demo records. */
      if (!STATUS_API) {
        var demo = VISA_RECORDS[key];
        if (demo) show(resultMarkup(key, demo)); else notFound(raw);
        return;
      }

      setBusy(button, true);
      if (panel) panel.classList.add('is-loading');
      show('<p class="status-loading">' + escapeHtml(tr('Checking your file…')) + '</p>');

      fetch(STATUS_API + '?key=' + encodeURIComponent(key), { headers: { 'Accept': 'application/json' } })
        .then(function (res) {
          if (res.status === 404) return null;
          if (res.status === 429) throw new Error(tr('Too many attempts. Please wait a minute and try again.'));
          if (!res.ok) throw new Error(tr('The status service is not responding.'));
          return res.json();
        })
        .then(function (record) {
          /* Not in the bot? It may still be one of the built-in demo keys,
             which keeps the site demonstrable while you are setting things up. */
          if (!record) record = VISA_RECORDS[key];
          if (record) show(resultMarkup(record.key || key, record)); else notFound(raw);
        })
        .catch(function (err) {
          /* Service unreachable (bot not running, network down). Demo keys
             should still answer rather than showing a scary error. */
          var demo = VISA_RECORDS[key];
          if (demo) { show(resultMarkup(key, demo)); return; }
          show(notFoundMarkup(escapeHtml(tr(err.message)) + ' ' +
            escapeHtml(tr('You can also ask your case officer directly on WhatsApp.'))));
        })
        .then(function () {
          setBusy(button, false);
          if (panel) panel.classList.remove('is-loading');
        });
    });

    /* Only render a row when the bot actually sent that field. */
    function row(label, value) {
      return value ? '<div><dt>' + escapeHtml(tr(label)) + '</dt><dd>' + escapeHtml(value) + '</dd></div>' : '';
    }

    function resultMarkup(key, r) {
      /* --i drives the staggered fill of the progress track in CSS.
         is-current marks the segment the file is sitting on right now. */
      var steps = VISA_STEPS.map(function (label, i) {
        var cls = [];
        if (i < r.step) cls.push('is-done');
        if (i === r.step - 1) cls.push('is-current');
        return '<li class="' + cls.join(' ') + '" style="--i:' + i + '">' +
                 '<span class="step-n">' + trt('Step {0}', undefined, i + 1) + '</span>' + escapeHtml(tr(label)) +
               '</li>';
      }).join('');

      var docs = r.docs
        ? '<ul class="status-docs">' + r.docs.map(function (d, i) {
            return '<li style="--i:' + i + '">' + escapeHtml(tr(d)) + '</li>';
          }).join('') + '</ul>'
        : '';

      return '' +
        '<div class="status-head">' +
          '<span class="status-pill" data-code="' + r.code + '">' + escapeHtml(tr(r.status)) + '</span>' +
          '<span class="status-updated">' + escapeHtml(tr('Last updated')) + ': ' + formatDate(r.updated) + '</span>' +
        '</div>' +
        '<dl class="status-meta">' +
          '<div><dt>' + escapeHtml(tr('Reference number')) + '</dt><dd>' + escapeHtml(key) +
            '<button type="button" class="copy-btn" data-copy="' + escapeHtml(key) + '">' + escapeHtml(tr('Copy')) + '</button>' +
          '</dd></div>' +
          row('Name', r.name) +
          row('Nationality', r.nationality) +
          '<div><dt>' + escapeHtml(tr('Application route')) + '</dt><dd>' + escapeHtml(tr(r.route)) + '</dd></div>' +
          '<div><dt>' + escapeHtml(tr('Submitted on')) + '</dt><dd>' + formatDate(r.submitted) + '</dd></div>' +
          '<div><dt>' + escapeHtml(tr('Current stage')) + '</dt><dd>' + escapeHtml(tr(VISA_STEPS[Math.min(r.step, VISA_STEPS.length) - 1])) + '</dd></div>' +
        '</dl>' +
        '<ol class="status-steps">' + steps + '</ol>' +
        '<p class="status-note"><strong>' + escapeHtml(tr('What this means')) + ':</strong> ' + escapeHtml(tr(r.note)) + '</p>' +
        docs +
        '<a class="btn btn--outline btn--block" href="https://wa.me/9647500000000">' + escapeHtml(tr('Message my case officer')) + '</a>';
    }

    function notFoundMarkup(msg) {
      return '' +
        '<div class="status-head">' +
          '<span class="status-pill" data-code="none">' + escapeHtml(tr('No file found')) + '</span>' +
        '</div>' +
        '<p class="status-note">' + msg + '</p>' +
        '<a class="btn btn--outline btn--block" href="#contact">' + escapeHtml(tr('Contact our team')) + '</a>';
    }
  }

  /* ------------------------------------------------------------------------
     7. Contact form  (front-end validation only — connect your own backend)
     ------------------------------------------------------------------------ */
  /* Fills the message box when the visitor arrived from an "Apply Now" button
     (contact.html?job=ARY-1042) or an employer CTA (contact.html?topic=employer). */
  function initContactPrefill() {
    var message = $('#c-message');
    var note = $('[data-apply-note]');
    if (!message) return;

    var params = new URLSearchParams(window.location.search);
    var jobId = params.get('job');
    var topic = params.get('topic');

    if (jobId) {
      var job = JOBS.filter(function (j) { return j.id === jobId; })[0];
      if (!job) return;

      message.value =
        tr('I would like to apply for') + ': ' + tr(job.title) + ' — ' + job.city + ', ' + tr(job.country) +
        ' (' + tr('Ref') + ' ' + job.id + ').\n\n' + tr('My experience') + ': ';

      if (note) {
        note.hidden = false;
        note.innerHTML = tr('You are applying for') + ' <strong>' + escapeHtml(tr(job.title)) + '</strong> ' +
                         tr('in') + ' ' + escapeHtml(job.city) + ', ' + escapeHtml(tr(job.country)) +
                         '. <a href="jobs.html">' + escapeHtml(tr('Choose a different job')) + '</a>';
      }
    } else if (topic === 'employer') {
      message.value =
        tr('We would like to hire through Aryos Group.') + '\n\n' +
        tr('Company') + ': \n' + tr('Roles needed') + ': \n' +
        tr('Number of workers') + ': \n' + tr('Preferred start date') + ': ';

      if (note) {
        note.hidden = false;
        note.textContent = tr('Employer enquiry — tell us the roles, quantity and start date.');
      }
    } else {
      return;
    }

    var name = $('#c-name');
    if (name && !name.value) name.focus({ preventScroll: true });
  }

  function initContact() {
    var form = $('[data-contact-form]');
    if (!form) return;

    var statusEl = $('[data-contact-status]');

    var rules = [
      { id: 'c-name',    test: function (v) { return v.trim().length >= 2; },  msg: 'Please enter your full name.' },
      { id: 'c-phone',   test: function (v) { return v.replace(/[^\d]/g, '').length >= 7; }, msg: 'Please enter a phone number we can reach you on.' },
      { id: 'c-message', test: function (v) { return v.trim().length >= 10; }, msg: 'Please tell us a little about your profession and goal.' }
    ];

    function validateField(rule) {
      var field = document.getElementById(rule.id);
      var errorEl = $('[data-error-for="' + rule.id + '"]');
      var ok = rule.test(field.value);

      field.setAttribute('aria-invalid', String(!ok));
      if (errorEl) {
        errorEl.textContent = ok ? '' : tr(rule.msg);
        errorEl.hidden = ok;
      }
      return ok;
    }

    rules.forEach(function (rule) {
      var field = document.getElementById(rule.id);
      field.addEventListener('blur', function () { validateField(rule); });
      field.addEventListener('input', function () {
        if (field.getAttribute('aria-invalid') === 'true') validateField(rule);
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var firstInvalid = null;
      rules.forEach(function (rule) {
        var ok = validateField(rule);
        if (!ok && !firstInvalid) firstInvalid = document.getElementById(rule.id);
      });

if (firstInvalid) {
        toast(tr('Please check the highlighted fields'), 'warn');
        firstInvalid.focus();
        scrollToEl(firstInvalid);
        return;
      }

      /* No backend is connected: this only confirms the form on screen.
         The short delay makes the submit feel like a real round trip rather
         than an instant, unbelievable jump. */
      var submitBtn = $('button[type="submit"]', form);
      setBusy(submitBtn, true);

      window.setTimeout(function () {
        setBusy(submitBtn, false);

        if (statusEl) {
          statusEl.hidden = false;
          statusEl.textContent = tr('Thank you. Your message is ready to be sent — connect this form to your email service to receive it.');
          void statusEl.offsetWidth;
        }
        var note = $('[data-apply-note]');
        if (note) note.hidden = true;
        form.reset();
        toast(tr('Message prepared — we reply within 48 hours'), 'ok');
        scrollToEl(statusEl);
      }, motionOK() ? 700 : 0);
    });
  }

  /* ------------------------------------------------------------------------
     Signature finish — grain, lamp, tilt, magnet, counters, ticker
     ------------------------------------------------------------------------ */

  /* Film grain: one fixed overlay, added once, so every page carries it. */
  function initGrain() {
    if (document.getElementById('fx-grain')) return;
    var grain = document.createElement('div');
    grain.id = 'fx-grain';
    grain.className = 'fx-grain';
    grain.setAttribute('aria-hidden', 'true');
    document.body.appendChild(grain);
  }

  /* The lamp: a soft glow that rides the cursor. It only wakes for fine
     pointers, and sits on top of everything without ever eating a click. */
  function initLamp() {
    if (!motionOK()) return;
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches) return;

    var spot = document.createElement('div');
    spot.className = 'fx-spot';
    spot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(spot);

    var raf = null;
    document.addEventListener('pointermove', function (e) {
      if (raf) return;
      raf = window.requestAnimationFrame(function () {
        spot.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
        if (!spot.classList.contains('is-on')) spot.classList.add('is-on');
        raf = null;
      });
    }, { passive: true });
    document.addEventListener('pointerleave', function () {
      spot.classList.remove('is-on');
    });
  }

  /* Cards that lean toward the pointer. */
  function initTilt() {
    if (!motionOK()) return;
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches) return;

    $$('[data-tilt]').forEach(function (card) {
      if (card.dataset.tiltWired) return;
      card.dataset.tiltWired = '1';
      var raf = null;
      card.addEventListener('pointermove', function (e) {
        if (raf) return;
        raf = window.requestAnimationFrame(function () {
          raf = null;
          var box = card.getBoundingClientRect();
          var x = (e.clientX - box.left) / box.width;
          var y = (e.clientY - box.top) / box.height;
          card.style.setProperty('--tilt-x', (x * 100) + '%');
          card.style.setProperty('--tilt-y', (y * 100) + '%');
          card.style.transform =
            'perspective(900px) rotateX(' + (0.5 - y) * 4 + 'deg) rotateY(' + (x - 0.5) * 4 + 'deg) translateY(-4px)';
          card.classList.add('is-tilting');
        });
      });
      card.addEventListener('pointerleave', function () {
        if (raf) { window.cancelAnimationFrame(raf); raf = null; }
        card.classList.remove('is-tilting');
        card.style.transform = '';
        card.style.removeProperty('--tilt-x');
        card.style.removeProperty('--tilt-y');
      });
    });
  }

  /* Primary CTAs lean toward the cursor a hair — a living touch, not a circus. */
  function initMagnet() {
    if (!motionOK()) return;
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches) return;

    $$('.btn--magnetic').forEach(function (btn) {
      if (btn.dataset.magnetWired) return;
      btn.dataset.magnetWired = '1';
      var raf = null;
      btn.addEventListener('pointermove', function (e) {
        if (raf) return;
        raf = window.requestAnimationFrame(function () {
          raf = null;
          var box = btn.getBoundingClientRect();
          var dx = e.clientX - (box.left + box.width / 2);
          var dy = e.clientY - (box.top + box.height / 2);
          btn.style.transform = 'translate(' + (dx * 0.18) + 'px,' + (dy * 0.24) + 'px)';
        });
      });
      btn.addEventListener('pointerleave', function () {
        if (raf) { window.cancelAnimationFrame(raf); raf = null; }
        btn.style.transform = '';
      });
    });
  }

  /* Hero facts count in once they are on screen. Reads the number straight
     out of the label (15+, 48h, 30) so there is nothing to keep in sync. */
  function initCountUps() {
    var stats = $$('[data-fact], [data-hero-fact]');
    if (!stats.length) return;
    var inView = function (el) {
      var box = el.getBoundingClientRect();
      return box.top < window.innerHeight * 0.92 && box.bottom > 0;
    };
    var run = function (el) {
      var raw = (el.getAttribute('data-fact') || el.textContent || '').trim();
      var n = parseInt(raw, 10);
      if (isNaN(n)) return;
      var suffix = /[\+%h]$/.test(raw) ? raw.slice(-1) : '';
      countUp(el, n, function (v) {
        return v + suffix;
      }, 1100);
      el.classList.add('is-counted');
    };
    if (!('IntersectionObserver' in window)) {
      stats.forEach(run);
      return;
    }
    var obs = new IntersectionObserver(function (entries, o) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        run(entry.target);
        o.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.4 });
    stats.forEach(function (el) {
      if (inView(el)) { run(el); return; }
      obs.observe(el);
    });
  }

  /* Editorial ticker: the words run twice so the loop never visibly resets. */
  /* ------------------------------------------------------------------------
     Flags

     Drawn as SVG, never as emoji: 🇩🇪 renders as the letters "DE" on Windows,
     which is most of our desktop traffic, and Android and iOS draw the same
     flag in visibly different styles. Vectors look identical everywhere and
     cost nothing extra — the ticker duplicates its contents, so each flag is
     defined once in a sprite and referenced twice with <use>.

     These are simplified for display at about 20px: Spain's arms, Portugal's
     armillary sphere and the exact star arrangement on the US flag are not
     reproducible at that size, so they are approximated. The colours and
     proportions are the real ones.
     ------------------------------------------------------------------------ */
  function bands(colors, vertical) {
    var n = colors.length, out = '';
    for (var i = 0; i < n; i++) {
      out += vertical
        ? '<rect x="' + (30 / n * i) + '" width="' + (30 / n) + '" height="20" fill="' + colors[i] + '"/>'
        : '<rect y="' + (20 / n * i) + '" width="30" height="' + (20 / n) + '" fill="' + colors[i] + '"/>';
    }
    return out;
  }

  /* Nordic cross: offset to the hoist, as every Nordic flag has it. */
  function nordic(bg, cross, inner) {
    var out = '<rect width="30" height="20" fill="' + bg + '"/>' +
      '<rect x="9" width="4" height="20" fill="' + cross + '"/>' +
      '<rect y="8" width="30" height="4" fill="' + cross + '"/>';
    if (inner) {
      out += '<rect x="10" width="2" height="20" fill="' + inner + '"/>' +
             '<rect y="9" width="30" height="2" fill="' + inner + '"/>';
    }
    return out;
  }

  function usStars() {
    var out = '';
    for (var row = 0; row < 7; row++) {
      var odd = row % 2;
      for (var col = 0; col < (odd ? 5 : 6); col++) {
        out += '<circle cx="' + (1.1 + col * 2 + odd) + '" cy="' +
               (0.9 + row * 1.42) + '" r="0.42" fill="#fff"/>';
      }
    }
    return out;
  }

  /* Named FLAG_ART, not FLAGS: the emoji lookup near the top of this file owns
     that name, and a second `var FLAGS` in the same scope overwrote it — every
     flag on the site came out as the 🌍 fallback. */
  var FLAG_ART = {
    de: bands(['#000000', '#DD0000', '#FFCE00']),
    nl: bands(['#AE1C28', '#FFFFFF', '#21468B']),
    at: bands(['#ED2939', '#FFFFFF', '#ED2939']),
    pl: bands(['#FFFFFF', '#DC143C']),
    be: bands(['#000000', '#FAE042', '#ED2939'], true),
    it: bands(['#009246', '#FFFFFF', '#CE2B37'], true),
    fr: bands(['#0055A4', '#FFFFFF', '#EF4135'], true),
    ie: bands(['#169B62', '#FFFFFF', '#FF883E'], true),
    se: nordic('#006AA7', '#FECC00'),
    fi: nordic('#FFFFFF', '#003580'),
    no: nordic('#EF2B2D', '#FFFFFF', '#002868'),

    /* Spain: the arms sit at the hoist on the real flag; omitted here. */
    es: '<rect width="30" height="20" fill="#AA151B"/>' +
        '<rect y="5" width="30" height="10" fill="#F1BF00"/>',

    /* Portugal: 2:3 green-red split with the sphere reduced to its disc. */
    pt: '<rect width="30" height="20" fill="#FF0000"/>' +
        '<rect width="12" height="20" fill="#006600"/>' +
        '<circle cx="12" cy="10" r="4" fill="#FFE936" stroke="#FFF" stroke-width="0.5"/>' +
        '<circle cx="12" cy="10" r="2.2" fill="#FFF"/><circle cx="12" cy="10" r="1.6" fill="#AA151B"/>',

    gr: (function () {
      var out = '';
      for (var i = 0; i < 9; i++) {
        out += '<rect y="' + (i * 20 / 9) + '" width="30" height="' + (20 / 9) +
               '" fill="' + (i % 2 ? '#FFFFFF' : '#0D5EAF') + '"/>';
      }
      return out +
        '<rect width="11.1" height="11.1" fill="#0D5EAF"/>' +
        '<rect x="4.45" width="2.2" height="11.1" fill="#FFFFFF"/>' +
        '<rect y="4.45" width="11.1" height="2.2" fill="#FFFFFF"/>';
    })(),

    gb: '<rect width="30" height="20" fill="#012169"/>' +
        '<path d="M0,0 30,20 M30,0 0,20" stroke="#FFF" stroke-width="4"/>' +
        '<path d="M0,0 30,20 M30,0 0,20" stroke="#C8102E" stroke-width="2"/>' +
        '<path d="M15,0 V20 M0,10 H30" stroke="#FFF" stroke-width="6"/>' +
        '<path d="M15,0 V20 M0,10 H30" stroke="#C8102E" stroke-width="3.5"/>',

    us: (function () {
      var out = '';
      for (var i = 0; i < 13; i++) {
        out += '<rect y="' + (i * 20 / 13) + '" width="30" height="' + (20 / 13) +
               '" fill="' + (i % 2 ? '#FFFFFF' : '#B22234') + '"/>';
      }
      return out + '<rect width="12" height="' + (20 / 13 * 7) + '" fill="#3C3B6E"/>' + usStars();
    })(),

    ca: '<rect width="30" height="20" fill="#FFFFFF"/>' +
        '<rect width="7.5" height="20" fill="#FF0000"/>' +
        '<rect x="22.5" width="7.5" height="20" fill="#FF0000"/>' +
        '<path fill="#FF0000" d="M15 4.4l.72 1.68 1.7-.38-.55 1.7 1.6.95-1.38 1.1.4 1.36-2.02-.4-.17 2.02h-.6l-.17-2.02-2.02.4.4-1.36-1.38-1.1 1.6-.95-.55-1.7 1.7.38z"/>'
  };

  /* One hidden sprite per page; every flag on it points at the same symbol.
     Callers add to it rather than replace it: the ticker and the job cards
     each need their own set of countries, and whichever ran second used to
     find the sprite already there and leave its flags pointing at nothing. */
  function ensureFlagSprite(codes) {
    /* Deduplicated on the symbol, not on the sprite, so a later caller adds
       only the countries nobody has drawn yet. */
    var symbols = codes.filter(function (c) {
      return FLAG_ART[c] && !document.getElementById('flag-' + c);
    }).map(function (c) {
      return '<symbol id="flag-' + c + '" viewBox="0 0 30 20">' + FLAG_ART[c] + '</symbol>';
    }).join('');
    if (!symbols) return;
    /* Inserted as markup, not built with createElement: document.createElement
       ('svg') produces an HTML element of that name, and its children land in
       the HTML namespace, so every <use> resolves to nothing and the flags
       come out blank. Letting the parser handle it namespaces them properly. */
    document.body.insertAdjacentHTML('beforeend',
      '<svg class="flag-sprite" aria-hidden="true" ' +
      'style="position:absolute;width:0;height:0;overflow:hidden">' +
      symbols + '</svg>');
  }

  function initTicker() {
    $$('[data-ticker]').forEach(function (track) {
      var raw = (track.getAttribute('data-ticker') || '').split('|').filter(Boolean);
      if (raw.length < 2) return;

      /* "de:Germany" renders a flag; a plain word stays a plain word, so the
         same ticker can still be used for text elsewhere. */
      var items = raw.map(function (entry) {
        var bits = entry.split(':');
        return bits.length > 1 && FLAG_ART[bits[0].trim()]
          ? { code: bits[0].trim(), label: bits.slice(1).join(':').trim() }
          : { code: null, label: entry.trim() };
      });

      ensureFlagSprite(items.map(function (i) { return i.code; }).filter(Boolean));

      var half = items.map(function (i) {
        var flag = i.code
          ? '<svg class="ticker__flag" viewBox="0 0 30 20" aria-hidden="true">' +
            '<use href="#flag-' + i.code + '"/></svg>'
          : '';
        return '<span>' + flag + escapeHtml(tr(i.label)) + '</span>';
      }).join('');

      track.innerHTML = half + half;
    });
  }

  function initSignature() {
    initGrain();
    initLamp();
    initTilt();
    initMagnet();
    initCountUps();
    initTicker();
  }

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */

  /* Called after any batch of markup is injected: applies the stagger delays
     the new elements declare, then hands them to the reveal observer. Safe to
     call repeatedly — elements already revealed are skipped. */
  function afterRender() {
    $$('[data-reveal-group]').forEach(function (group) {
      applyStagger(group, Number(group.getAttribute('data-reveal-group')) || 70);
    });
    observeReveals();
    window.setTimeout(observeReveals, 400);
    initTilt();
    initMagnet();
  }

  function init() {
    var year = $('[data-year]');
    if (year) year.textContent = new Date().getFullYear();

    /* Each init exits quietly when its markup is absent, so one script
       serves every page: index, jobs, visa, employers and contact. */
    initHeader();
    initLanguage();
    initBack();
    initHero();
    /* Ask the bot for its pictures first. If it has any they replace the
       bundled ones before the slideshow is built; if not — or if the site is
       running without the bot — the callback still fires and nothing changes. */
    loadHero(initHeroSlides);
    initBoard();
    initDottedMap();
    initMorphingText();
    initVisa();
    initApply();

    /* Motion first for the parts that exist already, so the hero and page
       header animate while the vacancies are still being fetched. */
    initRipples();
    initScrollUi();
    initSignature();

    /* Everything that reads JOBS waits for the live list — or for the fetch
       to fail, in which case the built-in samples are already in place. */
    loadJobs(function () {
      initRegions();        /* must run before the counts look for [data-count] */
      initCountryCounts();
      paintDotMarkers();    /* pins follow the live vacancies, samples included */
      initFeaturedJobs();
      initJobs();
      initStructuredData();  /* after JOBS holds the live list, not the samples */
      initContactPrefill();
      initContact();
      afterRender();
    });

    /* Samples paint immediately so the section is never blank, then the
       published reviews replace them when the fetch lands. */
    paintReviews();
    loadReviews();

    /* Reveal what is already in the markup while the fetch is in flight. */
    afterRender();

    /* If the OS motion setting changes mid-visit, reveal anything still hidden. */
    var onMotionChange = function () {
      if (reduceMotion.matches) {
        $$('[data-reveal]').forEach(function (el) { el.classList.add('is-in', 'is-settled'); });
      }
    };
    if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionChange);
    else if (reduceMotion.addListener) reduceMotion.addListener(onMotionChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

