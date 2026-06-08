(function () {
  'use strict';

  // ── BibTeX ────────────────────────────────────────────────────────────────

  function parseBibtex(text) {
    const entries = [];
    let i = 0;
    while (i < text.length) {
      const at = text.indexOf('@', i);
      if (at === -1) break;
      const hm = text.slice(at).match(/^@(\w+)\s*\{\s*([^,]+)\s*,/);
      if (!hm) { i = at + 1; continue; }
      const type = hm[1].toLowerCase();
      const key = hm[2].trim();
      let body = at + hm[0].length;
      let depth = 1, cur = body;
      while (cur < text.length && depth > 0) {
        if (text[cur] === '{') depth++; else if (text[cur] === '}') depth--;
        cur++;
      }
      const src = text.slice(body, depth === 0 ? cur - 1 : text.length);
      const fields = {};
      const rx = /(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"(?:[^"\\]|\\.)*"|[^,\n]+)\s*,?/g;
      let m;
      while ((m = rx.exec(src)) !== null) {
        let v = String(m[2] || '').trim();
        if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
        fields[m[1].toLowerCase()] = v.replace(/\s+/g, ' ').trim();
      }
      entries.push({ type, key, fields });
      i = cur;
    }
    return entries;
  }

  function formatAuthor(name) {
    name = name.replace(/\s+/g, ' ').trim();
    if (!name) return '';
    if (name.includes(',')) {
      const [surname, ...rest] = name.split(',');
      const initials = rest.join(',').trim().split(/\s+/).filter(Boolean).map(p => p[0].toUpperCase() + '.').join(' ');
      return initials ? `${initials} ${surname.trim()}` : surname.trim();
    }
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0];
    const surname = parts.pop();
    return parts.map(p => p[0].toUpperCase() + '.').join(' ') + ' ' + surname;
  }

  function formatPub(entry) {
    const f = entry.fields;
    const rawAuthors = (f.author || '').split(/\s+and\s+/i).map(formatAuthor).filter(Boolean);
    const authStr = rawAuthors.length > 2
      ? rawAuthors.slice(0, -1).join(', ') + ', and ' + rawAuthors[rawAuthors.length - 1]
      : rawAuthors.join(' and ');
    const venue = f.journal || f.booktitle || f.publisher || '';
    const doi = f.doi ? `https://doi.org/${f.doi}` : (f.url || '');
    let s = '';
    if (authStr) s += authStr + '. ';
    if (f.title) s += `"${f.title}." `;
    if (venue) s += `<em>${venue}</em>. `;
    if (f.year) s += f.year + '.';
    if (doi) s += ` <a href="${doi}" style="color:#555;">Link</a>`;
    return s.trim();
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  const BAD_PHRASES = [
    'this site is built', 'html5 up', 'last updated', 'get in touch',
    'todo', '©', 'copyright', 'download cv', 'google scholar',
    "hi, i'm", "hi, i am", 'list the active', 'fill in ', 'replace with',
    'optional section', 'a collection of my', 'teaching provided',
    'courses, supervision', 'students, projects', 'month year',
    'click here', 'read more',
  ];

  function isBad(s) {
    if (!s) return true;
    const low = s.toLowerCase().trim();
    for (const b of BAD_PHRASES) if (low.includes(b)) return true;
    return low.length < 4;
  }

  // ── Scraping (browser-side: fetch + DOMParser) ────────────────────────────

  async function fetchDoc(url) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return new DOMParser().parseFromString(await r.text(), 'text/html');
    } catch (e) {
      console.warn('fetchDoc failed', url, e);
      return null;
    }
  }

  function scrapeArticle(a) {
    const titleEl = a.querySelector('.title h2') || a.querySelector('h2');
    const title = titleEl ? titleEl.textContent.trim() : '';

    const lis = [];
    a.querySelectorAll('ul li').forEach(li => {
      if (li.closest('ul.actions')) return; // skip button lists
      const h3 = li.querySelector('h3');
      const pEl = li.querySelector('p');
      if (h3) {
        lis.push({ label: h3.textContent.trim(), detail: pEl ? pEl.textContent.trim() : '' });
      } else {
        lis.push({ label: li.textContent.replace(/\s+/g, ' ').trim(), detail: '' });
      }
    });

    // exclude paragraphs inside list items or inside .title (template subtitle text)
    const paras = Array.from(a.querySelectorAll('p'))
      .filter(p => !p.closest('li') && !p.closest('.title'))
      .map(p => p.textContent.trim())
      .filter(Boolean);

    return { title, lis, paras };
  }

  async function scrapeSection(url, articleTitle) {
    const doc = await fetchDoc(url);
    if (!doc) return [];
    const main = doc.querySelector('#main');
    if (!main) return [];
    const articles = Array.from(main.querySelectorAll('article.post')).slice(1);
    if (!articleTitle) return articles.map(scrapeArticle);
    return articles
      .filter(a => {
        const h = a.querySelector('.title h2, h2');
        return h && h.textContent.trim().toLowerCase() === articleTitle.toLowerCase();
      })
      .map(scrapeArticle);
  }

  // ── HTML building ─────────────────────────────────────────────────────────

  const esc = s => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Inline styles for html2canvas compatibility
  const S = {
    wrap:    'font-family:"Helvetica Neue",Arial,Helvetica,sans-serif;color:#111;font-size:10.5px;line-height:1.5;width:760px;padding:22px 24px;box-sizing:border-box;',
    header:  'border-bottom:1.5px solid #111;padding-bottom:10px;margin-bottom:16px;',
    h1:      'font-size:21px;font-weight:700;margin:0 0 3px 0;letter-spacing:0;',
    subtitle:'font-size:10.5px;color:#444;margin-bottom:4px;',
    contact: 'font-size:10px;color:#555;',
    section: 'margin-bottom:13px;',
    h3:      'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;border-bottom:0.75px solid #bbb;padding-bottom:2px;margin-bottom:7px;color:#444;margin-top:0;',
    h4:      'font-size:10.5px;font-weight:700;margin:6px 0 3px;color:#111;',
    p:       'margin-bottom:5px;font-size:10.5px;margin-top:0;',
    ul:      'margin:3px 0 4px 14px;padding:0;list-style:disc;',
    ol:      'margin:3px 0 4px 14px;padding:0;',
    li:      'margin-bottom:3px;line-height:1.4;font-size:10.5px;',
    detail:  'color:#555;',
  };

  function renderArticles(articles, secTitle) {
    return (articles || []).map(art => {
      const showSub = art.title && !isBad(art.title) &&
        art.title.toLowerCase() !== secTitle.toLowerCase();
      const subHead = showSub ? `<h4 style="${S.h4}">${esc(art.title)}</h4>` : '';

      const parasHtml = (art.paras || [])
        .filter(p => !isBad(p))
        .map(p => `<p style="${S.p}">${esc(p)}</p>`)
        .join('');

      const liHtml = (art.lis || [])
        .filter(li => !isBad(li.label))
        .map(li => {
          const detail = li.detail && !isBad(li.detail)
            ? `<span style="${S.detail}"> — ${esc(li.detail)}</span>` : '';
          return `<li style="${S.li}">${esc(li.label)}${detail}</li>`;
        }).join('');

      return `${subHead}${parasHtml}${liHtml ? `<ul style="${S.ul}">${liHtml}</ul>` : ''}`;
    }).join('');
  }

  async function buildCVHtml() {
    // Identity from current page (cv.js is loaded on index.html)
    const name = (document.querySelector('h1 a') || document.querySelector('h1'))?.textContent.trim() || 'Name';
    const profTitle = document.querySelector('#main article .title p')?.textContent.trim() || '';

    // Contact from contact.html
    let email = '', github = '', orcid = '';
    const contactDoc = await fetchDoc('contact.html');
    if (contactDoc) {
      // email is plain text in #main (no mailto link there); check whole doc then fall back to regex
      const emailEl = contactDoc.querySelector('a[href^="mailto:"]');
      email = emailEl ? emailEl.href.replace('mailto:', '') : '';
      if (!email) {
        for (const li of contactDoc.querySelectorAll('#main li')) {
          const m = li.textContent.match(/[\w.+\-]+@[\w.\-]+\.\w+/);
          if (m) { email = m[0]; break; }
        }
      }
      github = contactDoc.querySelector('#main a[href*="github.com"]')?.href || '';
      orcid  = contactDoc.querySelector('#main a[href*="orcid.org"]')?.textContent.trim() || '';
    }

    // Publications from bib.bib (fetch directly, don't rely on rendered page JS)
    let pubs = [];
    try {
      const r = await fetch('bib.bib', { cache: 'no-store' });
      if (r.ok) pubs = parseBibtex(await r.text()).map(formatPub).filter(Boolean);
    } catch (e) { console.warn('bib.bib fetch failed', e); }

    // Content sections in CV order
    const sections = [
      { title: 'Research Interests',     articles: await scrapeSection('index.html',      'Research interests') },
      { title: 'Education',              articles: await scrapeSection('experience.html',  'Education') },
      { title: 'Publications',           pubs },
      { title: 'Current Projects',       articles: await scrapeSection('research.html',    'Current projects') },
      { title: 'Teaching',               articles: await scrapeSection('teaching.html',    'Demonstrating') },
      { title: 'Professional Activities',articles: await scrapeSection('experience.html',  'Professional Projects') },
    ];

    const contactParts = [
      email  ? `<a href="mailto:${email}"  style="color:#555;text-decoration:none;">${email}</a>` : '',
      github ? `<a href="${github}" style="color:#555;text-decoration:none;">${github.replace(/^https?:\/\//, '')}</a>` : '',
      orcid  ? `ORCID: ${orcid}` : '',
    ].filter(Boolean);
    const contactLine = contactParts.join('<span style="color:#bbb;"> · </span>');

    const sectionsHtml = sections.map(sec => {
      let inner = '';
      if (sec.pubs !== undefined) {
        inner = sec.pubs.length
          ? `<ol style="${S.ol}">${sec.pubs.map(p => `<li style="${S.li}">${p}</li>`).join('')}</ol>`
          : '';
      } else {
        inner = renderArticles(sec.articles, sec.title);
      }
      if (!inner.trim()) return '';
      return `<div style="${S.section}"><h3 style="${S.h3}">${esc(sec.title)}</h3>${inner}</div>`;
    }).join('');

    return `
      <div style="${S.wrap}">
        <div style="${S.header}">
          <h1 style="${S.h1}">${esc(name)}</h1>
          ${profTitle ? `<div style="${S.subtitle}">${esc(profTitle)}</div>` : ''}
          <div style="${S.contact}">${contactLine}</div>
        </div>
        ${sectionsHtml}
      </div>
    `;
  }

  // ── PDF generation ────────────────────────────────────────────────────────

  async function generatePdf(button) {
    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = 'Building CV...';
    try {
      const markup = await buildCVHtml();
      if (!markup?.trim()) throw new Error('No content');

      if (typeof html2pdf === 'undefined') throw new Error('html2pdf not loaded');

      const name = (document.querySelector('h1 a') || document.querySelector('h1'))?.textContent.trim() || 'cv';

      // Pass as string so html2pdf appends its own element in normal document flow,
      // which html2canvas can reliably capture (negative-coord containers render blank).
      await html2pdf()
        .set({
          margin: 0.4,
          filename: name.replace(/\s+/g, '_') + '_CV.pdf',
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true, logging: false, windowWidth: 760 },
          jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
        })
        .from(markup, 'string')
        .save();
    } catch (err) {
      console.error('CV generation failed', err);
      alert('Could not build CV: ' + (err?.message || err));
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  function init() {
    const btn = document.getElementById('download-cv');
    if (!btn) return;
    btn.addEventListener('click', ev => { ev.preventDefault(); generatePdf(btn); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
