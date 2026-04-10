(() => {
  const ATTRS = [
    { selector: 'img', kind: 'media', handle: handleImage },
    { selector: 'source[srcset]', kind: 'media', handle: handleSourceSrcset },
    { selector: 'source[src]', kind: 'media', handle: handleSourceSrc },
    { selector: 'video', kind: 'media', handle: handleVideo },
    { selector: 'audio', kind: 'media', handle: handleAudio },
    { selector: 'link[rel~="stylesheet"][href]', kind: 'style', handle: handleLinkHref('href', 'style') },
    { selector: 'link[rel~="icon"][href]', kind: 'media', handle: handleLinkHref('href', 'media') },
    { selector: 'link[rel="preload"][href]', kind: 'asset', handle: handleLinkHref('href', 'asset') },
    { selector: 'script[src]', kind: 'script', handle: handleLinkHref('src', 'script') },
    { selector: 'iframe[src]', kind: 'document', handle: handleLinkHref('src', 'document') }
  ];

  const CSS_URL_PROPS = [
    'background-image',
    'background',
    'mask-image',
    'mask',
    'border-image-source',
    'border-image',
    'list-style-image',
    'content',
    'cursor',
    'filter',
    'clip-path'
  ];

  const CSS_URL_RE = /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi;

  function absoluteUrl(url) {
    if (!url) return null;
    const trimmed = String(url).trim();
    if (!trimmed || /^(data:|blob:|javascript:|about:|#)/i.test(trimmed)) return null;
    try {
      return new URL(trimmed, document.baseURI).href;
    } catch {
      return null;
    }
  }

  function absoluteUrlFrom(url, baseUrl) {
    if (!url) return null;
    const trimmed = String(url).trim();
    if (!trimmed || /^(data:|blob:|javascript:|about:|#)/i.test(trimmed)) return null;
    try {
      return new URL(trimmed, baseUrl).href;
    } catch {
      return null;
    }
  }

  function tokenizeUrl(url) {
    return `__ARCHIVE_URL__${url}`;
  }

  function tokenizeSrcset(value, baseUrl) {
    return String(value || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const match = part.match(/^(\S+)(\s+.*)?$/);
        if (!match) return part;
        const rawUrl = match[1];
        const descriptor = match[2] || '';
        const absolute = absoluteUrlFrom(rawUrl, baseUrl);
        if (!absolute) return part;
        return `__ARCHIVE_SRCSET__${encodeURIComponent(absolute)}${descriptor}`;
      })
      .join(', ');
  }

  function extractCssUrls(value, baseUrl, addResource, fallbackKind = 'style-asset') {
    const found = [];
    String(value || '').replace(CSS_URL_RE, (_full, quote, quotedInner, bareInner) => {
      const raw = String(quote ? quotedInner : bareInner || '').trim().replace(/^['"]|['"]$/g, '');
      const absolute = absoluteUrlFrom(raw, baseUrl);
      if (!absolute) return _full;
      const kind = /\.(woff2?|ttf|otf|eot|ttc)(\?|#|$)/i.test(absolute) ? 'font' : fallbackKind;
      addResource(absolute, kind);
      found.push(absolute);
      return _full;
    });
    return found;
  }

  function rewriteCssTextToAbsoluteTokens(text, baseUrl, addResource) {
    let output = String(text || '');

    output = output.replace(/@import\s+(?:url\()?\s*(['"]?)([^'"\)]+)\1\s*\)?([^;]*);/gi, (full, _quote, rawUrl, trailing) => {
      const absolute = absoluteUrlFrom(rawUrl, baseUrl);
      if (!absolute) return full;
      addResource(absolute, 'style');
      return `@import url("${tokenizeUrl(absolute)}")${trailing || ''};`;
    });

    output = output.replace(CSS_URL_RE, (full, quote, quotedInner, bareInner) => {
      const raw = String(quote ? quotedInner : bareInner || '').trim().replace(/^['"]|['"]$/g, '');
      const absolute = absoluteUrlFrom(raw, baseUrl);
      if (!absolute) return full;
      const kind = /\.(woff2?|ttf|otf|eot|ttc)(\?|#|$)/i.test(absolute) ? 'font' : 'style-asset';
      addResource(absolute, kind);
      return `url("${tokenizeUrl(absolute)}")`;
    });

    return output;
  }

  async function waitForPageSettled() {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const originalX = window.scrollX;
    const originalY = window.scrollY;
    const maxPasses = 10;
    let previousHeight = 0;

    for (let pass = 0; pass < maxPasses; pass += 1) {
      const maxY = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0,
        document.documentElement.offsetHeight,
        document.body?.offsetHeight || 0
      );
      const step = Math.max(500, Math.floor(window.innerHeight * 0.8));

      for (let y = 0; y <= maxY; y += step) {
        window.scrollTo(0, y);
        triggerLazyLoadSignals();
        await pause(220);
      }

      await pause(450);
      const newHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0,
        document.documentElement.offsetHeight,
        document.body?.offsetHeight || 0
      );
      if (newHeight <= previousHeight) break;
      previousHeight = newHeight;
    }

    hydrateLazyAssets(document);

    const images = Array.from(document.images || []);
    await Promise.allSettled(images.map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 5000);
      });
    }));

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, pause(3500)]);
    }

    await pause(300);
    window.scrollTo(originalX, originalY);
    await pause(100);
  }

  function triggerLazyLoadSignals() {
    document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => {
      try {
        el.loading = 'eager';
      } catch {}
    });
  }

  function hydrateLazyAssets(root) {
    root.querySelectorAll('img, source, video, audio, iframe').forEach((el) => {
      const srcCandidates = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-flickity-lazyload', 'data-lazyload', 'data-bg', 'data-src-retina', 'data-lazy', 'data-image', 'data-desktop-src', 'data-mobile-src'];
      const srcsetCandidates = ['data-srcset', 'data-lazy-srcset', 'data-bgset'];
      if (!el.getAttribute('src')) {
        for (const attr of srcCandidates) {
          const value = el.getAttribute(attr);
          if (value) {
            el.setAttribute('src', value);
            break;
          }
        }
      }
      if (!el.getAttribute('srcset')) {
        for (const attr of srcsetCandidates) {
          const value = el.getAttribute(attr);
          if (value) {
            el.setAttribute('srcset', value);
            break;
          }
        }
      }
    });
  }


  function shouldInlineAsDataImage(original) {
    if (!(original instanceof HTMLImageElement)) return false;
    const w = Number(original.naturalWidth || original.width || 0);
    const h = Number(original.naturalHeight || original.height || 0);
    const attrs = `${original.className || ''} ${original.id || ''} ${original.getAttribute('alt') || ''}`.toLowerCase();
    const isSmall = w > 0 && h > 0 && w <= 160 && h <= 160;
    const iconish = /icon|logo|badge|feature|search|support|coupon|commission|reply/.test(attrs);
    return isSmall || iconish;
  }

  function imageToDataUrl(original) {
    try {
      const width = Number(original.naturalWidth || original.width || 0);
      const height = Number(original.naturalHeight || original.height || 0);
      if (!width || !height) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(original, 0, 0, width, height);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  function looksLikeSearchForm(form) {
    if (!form || !(form instanceof HTMLFormElement)) return false;
    const attrs = `${form.action || ''} ${form.className || ''} ${form.id || ''} ${form.getAttribute('role') || ''}`.toLowerCase();
    if (/search|searchiqit|pm_asblockoutput|home_search|search-widget/.test(attrs)) return true;
    const input = form.querySelector('input[type="search"], input[name="s"], input[placeholder*="OOH" i], input[placeholder*="search" i], input[placeholder*="搜尋" i]');
    return !!input;
  }

  function searchStyleProps() {
    return [
      'display','flex-direction','flex-wrap','align-items','justify-content','gap',
      'width','max-width','min-width','height','min-height','padding','padding-top','padding-right','padding-bottom','padding-left',
      'margin','margin-top','margin-right','margin-bottom','margin-left',
      'background','background-color','background-image','background-size','background-position','background-repeat',
      'border','border-top','border-right','border-bottom','border-left','border-radius',
      'box-shadow','font','font-family','font-size','font-weight','line-height','letter-spacing','text-align','color',
      'outline','appearance','overflow','white-space','text-overflow'
    ];
  }

  function applyConservativeInlineStyle(original, cloned, baseUrl, addResource, props) {
    try {
      const style = getComputedStyle(original);
      const declarations = [];
      props.forEach((prop) => {
        const value = style.getPropertyValue(prop);
        if (!value) return;
        let finalValue = value;
        if (CSS_URL_PROPS.includes(prop) || /url\(/i.test(value)) {
          finalValue = rewriteCssTextToAbsoluteTokens(value, baseUrl, addResource);
        }
        declarations.push(`${prop}:${finalValue};`);
      });
      if (declarations.length) {
        const existing = String(cloned.getAttribute('style') || '');
        cloned.setAttribute('style', `${existing}${existing.trim().endsWith(';') || !existing.trim() ? '' : ';'}${declarations.join('')}`);
      }
    } catch {}
  }

  function preserveSearchFormBehavior(originalForm, clonedForm, addResource) {
    try {
      const actionAbs = absoluteUrlFrom(originalForm.getAttribute('action') || location.href, document.baseURI) || location.href;
      clonedForm.setAttribute('action', actionAbs);
      clonedForm.setAttribute('method', 'get');
      const props = searchStyleProps();
      applyConservativeInlineStyle(originalForm, clonedForm, document.baseURI, addResource, props);
      const originalNodes = [originalForm, ...Array.from(originalForm.querySelectorAll('input, button, .input-group, .PM_ASCriterionsGroup, .submit-search, .btn, .form-control'))];
      const clonedNodes = [clonedForm, ...Array.from(clonedForm.querySelectorAll('input, button, .input-group, .PM_ASCriterionsGroup, .submit-search, .btn, .form-control'))];
      originalNodes.forEach((node, index) => {
        const clone = clonedNodes[index];
        if (!clone) return;
        applyConservativeInlineStyle(node, clone, document.baseURI, addResource, props);
        if (clone.matches && clone.matches('input, textarea')) {
          clone.removeAttribute('readonly');
          clone.removeAttribute('disabled');
        }
        if (clone.matches && clone.matches('button')) {
          clone.setAttribute('type', 'submit');
        }
      });
    } catch {}
  }

  function handleLinkHref(attr, kind) {
    return ({ original, cloned, addResource }) => {
      const value = original.getAttribute(attr);
      const url = absoluteUrl(value);
      if (!url) return;
      addResource(url, kind);
      cloned.setAttribute(attr, tokenizeUrl(url));
    };
  }

  function handleImage({ original, cloned, addResource }) {
    const current = original.currentSrc || original.getAttribute('src') || original.getAttribute('data-src') || original.getAttribute('data-lazy-src') || original.getAttribute('data-original');
    const absolute = absoluteUrl(current);
    const inlineData = shouldInlineAsDataImage(original) ? imageToDataUrl(original) : null;
    if (inlineData) {
      cloned.setAttribute('src', inlineData);
      cloned.removeAttribute('srcset');
    } else if (absolute) {
      addResource(absolute, 'media');
      cloned.setAttribute('src', tokenizeUrl(absolute));
    }

    const srcset = !inlineData && (original.currentSrc ? `${original.currentSrc} 1x` : (original.getAttribute('srcset') || original.getAttribute('data-srcset') || original.getAttribute('data-lazy-srcset')));
    if (srcset) {
      cloned.setAttribute('srcset', tokenizeSrcset(srcset, document.baseURI));
    } else {
      cloned.removeAttribute('srcset');
    }

    cloned.setAttribute('loading', 'eager');
    if (original.getAttribute('sizes')) cloned.setAttribute('sizes', original.getAttribute('sizes'));
  }

  function handleSourceSrcset({ original, cloned, addResource }) {
    const current = original.getAttribute('srcset') || original.getAttribute('data-srcset');
    if (!current) return;
    cloned.setAttribute('srcset', tokenizeSrcset(current, document.baseURI));
    String(current).split(',').forEach((part) => {
      const raw = part.trim().split(/\s+/)[0];
      const absolute = absoluteUrlFrom(raw, document.baseURI);
      if (absolute) addResource(absolute, 'media');
    });
  }

  function handleSourceSrc({ original, cloned, addResource }) {
    const value = original.getAttribute('src') || original.getAttribute('data-src');
    const absolute = absoluteUrl(value);
    if (!absolute) return;
    addResource(absolute, 'media');
    cloned.setAttribute('src', tokenizeUrl(absolute));
  }

  function handleVideo({ original, cloned, addResource }) {
    const src = original.currentSrc || original.getAttribute('src') || original.getAttribute('data-src');
    const absolute = absoluteUrl(src);
    if (absolute) {
      addResource(absolute, 'video');
      cloned.setAttribute('src', tokenizeUrl(absolute));
    }
    const poster = original.getAttribute('poster');
    const posterAbs = absoluteUrl(poster);
    if (posterAbs) {
      addResource(posterAbs, 'media');
      cloned.setAttribute('poster', tokenizeUrl(posterAbs));
    }
    cloned.removeAttribute('autoplay');
  }

  function handleAudio({ original, cloned, addResource }) {
    const src = original.currentSrc || original.getAttribute('src') || original.getAttribute('data-src');
    const absolute = absoluteUrl(src);
    if (!absolute) return;
    addResource(absolute, 'audio');
    cloned.setAttribute('src', tokenizeUrl(absolute));
    cloned.removeAttribute('autoplay');
  }


  function isNearlyTransparentColor(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === 'transparent') return true;
    if (v.startsWith('rgba(')) {
      const parts = v.replace(/^rgba\(/, '').replace(/\)$/, '').split(',');
      const alpha = Number(parts[3]);
      return Number.isFinite(alpha) ? alpha <= 0.05 : false;
    }
    return false;
  }

  function isRootLikeElement(node) {
    if (!node || !(node instanceof Element)) return false;
    const tag = node.tagName;
    return tag === 'HTML' || tag === 'BODY' || tag === 'MAIN' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'NAV';
  }

  function isLikelyFullscreenOverlay(node) {
    if (!node || !(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const coversViewport = rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.6;
    const overlayPosition = style.position === 'fixed' || style.position === 'sticky';
    const visuallyPresent = !isNearlyTransparentColor(style.backgroundColor) || style.backgroundImage !== 'none' || Number(style.opacity || '1') < 1;
    const textLen = (node.textContent || '').trim().length;
    return coversViewport && overlayPosition && visuallyPresent && textLen < 600;
  }

  function isLargeDecorativeCanvas(node) {
    if (!node || !(node instanceof HTMLCanvasElement)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const bigEnough = rect.width >= window.innerWidth * 0.7 && rect.height >= window.innerHeight * 0.3;
    const floating = style.position === 'absolute' || style.position === 'fixed';
    return bigEnough && floating;
  }

  function sanitizeFrozenStyle(styleText, original) {
    let out = String(styleText || '');
    if (isRootLikeElement(original)) {
      out = out
        .replace(/(?:^|;)display\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)visibility\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)opacity\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)position\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)transform\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)top\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)right\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)bottom\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)left\s*:[^;]*;?/gi, ';')
        .replace(/(?:^|;)inset[^;]*;?/gi, ';');
      out += 'display:block !important;visibility:visible !important;opacity:1 !important;';
    }
    return out;
  }

  function freezeFormState(original, cloned) {
    try {
      if (original instanceof HTMLInputElement) {
        if (original.type === 'checkbox' || original.type === 'radio') {
          if (original.checked) cloned.setAttribute('checked', 'checked');
          else cloned.removeAttribute('checked');
        } else {
          cloned.setAttribute('value', original.value || '');
        }
        return;
      }

      if (original instanceof HTMLTextAreaElement) {
        cloned.textContent = original.value || '';
        return;
      }

      if (original instanceof HTMLSelectElement) {
        const originalOptions = original.options ? Array.from(original.options) : Array.from(original.querySelectorAll('option'));
        const clonedOptions = cloned && cloned.options ? Array.from(cloned.options) : Array.from(cloned.querySelectorAll('option'));
        clonedOptions.forEach((opt, index) => {
          if (originalOptions[index]?.selected) opt.setAttribute('selected', 'selected');
          else opt.removeAttribute('selected');
        });
      }
    } catch {
      // Skip malformed form controls instead of failing the whole archive.
    }
  }

  function serializeComputedStyle(style, baseUrl, addResource) {
    const declarations = [];
    for (let i = 0; i < style.length; i += 1) {
      const prop = style[i];
      const value = style.getPropertyValue(prop);
      if (!value) continue;
      let finalValue = value;
      if (CSS_URL_PROPS.includes(prop) || /url\(/i.test(value)) {
        finalValue = rewriteCssTextToAbsoluteTokens(value, baseUrl, addResource);
      }
      if (prop === 'animation' || prop === 'animation-name' || prop.startsWith('transition')) {
        continue;
      }
      declarations.push(`${prop}:${finalValue};`);
    }
    declarations.push('animation:none !important;');
    declarations.push('transition:none !important;');
    return declarations.join('');
  }

  function appendPseudoStyle(cloned, pseudo, style, baseUrl, addResource) {
    const content = style.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal') return;
    const span = document.createElement('span');
    span.setAttribute('data-archived-pseudo', pseudo.replace(/:/g, ''));
    span.setAttribute('aria-hidden', 'true');
    span.style.cssText = serializeComputedStyle(style, baseUrl, addResource) + 'pointer-events:none;';
    if (content.startsWith('"') || content.startsWith("'")) {
      span.textContent = content.slice(1, -1);
    }
    if (pseudo === '::before') cloned.prepend(span);
    else cloned.append(span);
  }


  function createPlaceholderBlock(docRef, title, detail, compact = false) {
    const node = docRef.createElement('section');
    node.setAttribute('data-archiver-placeholder', 'true');
    node.style.cssText = compact
      ? 'margin:8px 0;padding:10px 12px;border:1px dashed #c7c7d1;border-radius:8px;background:#fafafe;color:#333;font:12px/1.5 Arial,sans-serif;'
      : 'margin:24px auto;padding:24px;max-width:1200px;min-height:120px;border:1px dashed #c7c7d1;border-radius:12px;background:#fafafe;color:#333;box-sizing:border-box;font:14px/1.7 Arial,sans-serif;';
    const heading = docRef.createElement('div');
    heading.textContent = title || '已过滤交互表单区块';
    heading.style.cssText = compact ? 'font-size:13px;font-weight:700;margin:0 0 6px;' : 'font-size:22px;font-weight:700;margin:0 0 10px;';
    const body = docRef.createElement('div');
    body.textContent = detail || '此区块包含表单、验证码或交互脚本，归档时已转为占位块，建议后续人工补全。';
    body.style.cssText = compact ? 'font-size:12px;line-height:1.6;color:#666;' : 'font-size:14px;line-height:1.7;color:#666;max-width:720px;';
    node.appendChild(heading);
    node.appendChild(body);
    return node;
  }



  function textSnippet(value, max = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function describeNode(node) {
    if (!node || !(node instanceof Element)) return '';
    const parts = [];
    let current = node;
    let depth = 0;
    while (current && current.nodeType === 1 && depth < 4) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }
      const classes = String(current.className || '').split(/\s+/).filter(Boolean).slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((el) => el.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function rectSnapshot(node) {
    try {
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    } catch {
      return null;
    }
  }

  function pushDebug(debug, key, entry, limit = 80) {
    if (!debug || !key) return;
    if (!Array.isArray(debug[key])) debug[key] = [];
    if (debug[key].length < limit) debug[key].push(entry);
  }

  function collectHeadingDebug(debug) {
    const selectors = 'h1,h2,h3,h4,h5,h6,.elementor-heading-title,.section-title,.block-title';
    Array.from(document.querySelectorAll(selectors)).slice(0, 140).forEach((node) => {
      const text = textSnippet(node.textContent, 220);
      if (!text) return;
      const style = getComputedStyle(node);
      pushDebug(debug, 'headings', {
        selector: describeNode(node),
        tag: node.tagName.toLowerCase(),
        text,
        rect: rectSnapshot(node),
        styles: {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          color: style.color,
          textAlign: style.textAlign,
          textTransform: style.textTransform
        }
      }, 180);
    });
  }

  function collectButtonDebug(debug) {
    Array.from(document.querySelectorAll('a,button,.btn,input[type="submit"],input[type="button"]')).slice(0, 120).forEach((node) => {
      const text = textSnippet(node.textContent || node.getAttribute('value'), 120);
      if (!text) return;
      const style = getComputedStyle(node);
      pushDebug(debug, 'buttons', {
        selector: describeNode(node),
        text,
        rect: rectSnapshot(node),
        styles: {
          display: style.display,
          padding: style.padding,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          color: style.color,
          background: style.background,
          backgroundColor: style.backgroundColor,
          border: style.border,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow
        }
      }, 120);
    });
  }

  function collectBackgroundDebug(debug) {
    const nodes = Array.from(document.querySelectorAll('section,article,main,header,footer,div')).slice(0, 1200);
    nodes.forEach((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 60) return;
      const hasBgImage = style.backgroundImage && style.backgroundImage !== 'none';
      const hasBgColor = !isNearlyTransparentColor(style.backgroundColor);
      if (!hasBgImage && !hasBgColor) return;
      const heading = textSnippet((node.querySelector('h1,h2,h3,h4,h5,h6,.elementor-heading-title,.section-title,.block-title') || node).textContent, 120);
      pushDebug(debug, 'backgrounds', {
        selector: describeNode(node),
        heading,
        rect: rectSnapshot(node),
        styles: {
          backgroundImage: style.backgroundImage,
          backgroundColor: style.backgroundColor,
          backgroundSize: style.backgroundSize,
          backgroundPosition: style.backgroundPosition,
          backgroundRepeat: style.backgroundRepeat,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow
        }
      }, 120);
    });
  }

  function collectImageDebug(debug) {
    Array.from(document.querySelectorAll('img')).slice(0, 180).forEach((img) => {
      pushDebug(debug, 'images', {
        selector: describeNode(img),
        alt: textSnippet(img.getAttribute('alt'), 80),
        currentSrc: img.currentSrc || img.getAttribute('src') || '',
        srcset: textSnippet(img.getAttribute('srcset'), 180),
        naturalWidth: Number(img.naturalWidth || 0),
        naturalHeight: Number(img.naturalHeight || 0),
        rect: rectSnapshot(img),
        complete: !!img.complete,
        classes: textSnippet(img.className, 120)
      }, 180);
    });
  }

  function getElementText(node) {
    return String(node?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function looksLikeCookieOrConsentPanel(node) {
    if (!node || !(node instanceof Element)) return false;
    const attrs = `${node.id || ''} ${node.className || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('role') || ''}`.toLowerCase();
    const text = getElementText(node).slice(0, 2000);
    const keywordHit = /(cookie|cookies|consent|privacy|gdpr|idxcookies|cookies nécessaires|cookies fonctionnelles|cookies de performance)/.test(attrs + ' ' + text);
    if (!keywordHit) return false;
    const hasToggles = node.querySelectorAll('input[type="checkbox"], button, [role="switch"], .switch, .toggle').length >= 2;
    const isPanelLike = /modal|popup|dialog|banner|consent|cookie/.test(attrs) || isLikelyFullscreenOverlay(node);
    return hasToggles || isPanelLike;
  }

  function getClosestHeadingText(el) {
    const container = el.closest('section, article, .elementor-section, .elementor-column, .elementor-widget, .block, .container, .row, div') || el.parentElement;
    if (!container) return '';
    const heading = container.querySelector('h1, h2, h3, h4, h5, h6, .elementor-heading-title, .block-title, .section-title');
    return heading ? heading.textContent.trim() : '';
  }

  function replaceNodeWithPlaceholder(node, title, detail, compact = false) {
    if (!node || !node.parentNode) return;
    const docRef = node.ownerDocument || document;
    const placeholder = createPlaceholderBlock(docRef, title, detail, compact);
    node.parentNode.replaceChild(placeholder, node);
  }


  function normalizeElementorStretchedSections(root) {
    if (!root || !root.querySelectorAll) return;
    const docRef = root.ownerDocument || document;
    root.querySelectorAll('.elementor-section-stretched').forEach((section) => {
      if (!(section instanceof Element)) return;
      section.style.removeProperty('left');
      section.style.removeProperty('right');
      section.style.removeProperty('transform');
      section.style.removeProperty('width');
      section.style.removeProperty('max-width');
      section.style.removeProperty('min-width');
      section.style.removeProperty('margin-left');
      section.style.removeProperty('margin-right');
      section.setAttribute('data-archiver-elementor-normalized', 'true');
      const container = section.querySelector(':scope > .elementor-container') || section.querySelector('.elementor-container');
      if (container) {
        container.style.removeProperty('left');
        container.style.removeProperty('right');
        container.style.removeProperty('transform');
        container.style.removeProperty('width');
        container.style.removeProperty('max-width');
        container.style.removeProperty('min-width');
        container.style.removeProperty('margin-left');
        container.style.removeProperty('margin-right');
      }
    });
    if (!root.querySelector('style[data-archiver-elementor-normalized]')) {
      const patch = docRef.createElement('style');
      patch.setAttribute('data-archiver-elementor-normalized', 'true');
      patch.textContent = `
.elementor-section-stretched[data-archiver-elementor-normalized="true"] {
  position: relative !important;
  left: 0 !important;
  right: auto !important;
  width: 100% !important;
  max-width: 100% !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  transform: none !important;
}
.elementor-section-stretched[data-archiver-elementor-normalized="true"] > .elementor-container,
.elementor-section-stretched[data-archiver-elementor-normalized="true"] > .elementor-column-gap-default {
  width: min(1220px, calc(100% - 32px)) !important;
  max-width: 1220px !important;
  margin-left: auto !important;
  margin-right: auto !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  box-sizing: border-box !important;
}
.elementor-section-stretched[data-archiver-elementor-normalized="true"] .elementor-row {
  margin-left: 0 !important;
  margin-right: 0 !important;
  width: auto !important;
  transform: none !important;
}
.elementor-section-stretched[data-archiver-elementor-normalized="true"] .elementor-widget-wrap,
.elementor-section-stretched[data-archiver-elementor-normalized="true"] .elementor-column-wrap {
  margin-left: 0 !important;
  margin-right: 0 !important;
}
`;
      const head = root.querySelector('head');
      if (head) head.appendChild(patch);
      else root.prepend(patch);
    }
  }

  function collectUniqueCarouselItems(carouselRoot) {
    const items = [];
    const seen = new Set();
    carouselRoot.querySelectorAll('img').forEach((img) => {
      if (img.closest('.slick-cloned')) return;
      const src = img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '';
      const alt = img.getAttribute('alt') || '';
      const key = `${src}||${alt}`;
      if (!src || seen.has(key)) return;
      seen.add(key);
      items.push({ src, alt });
    });
    return items;
  }

  function buildStaticCarouselGrid(docRef, items, mode = 'logos') {
    const grid = docRef.createElement('div');
    grid.className = `archiver-static-carousel-grid archiver-static-carousel-grid-${mode}`;
    const min = mode === 'media' ? 150 : 130;
    grid.style.cssText = `display:grid;grid-template-columns:repeat(auto-fit,minmax(${min}px,1fr));gap:${mode === 'media' ? '30px 26px' : '26px 22px'};align-items:center;justify-items:center;max-width:1220px;margin:0 auto;`;
    items.forEach(({ src, alt }) => {
      const cell = docRef.createElement('div');
      cell.className = 'archiver-static-carousel-item';
      cell.style.cssText = mode === 'media'
        ? 'display:flex;align-items:center;justify-content:center;min-height:76px;width:100%;padding:10px 8px;box-sizing:border-box;'
        : 'display:flex;align-items:center;justify-content:center;min-height:78px;width:100%;padding:8px 6px;box-sizing:border-box;';
      const img = docRef.createElement('img');
      img.setAttribute('src', src);
      if (alt) img.setAttribute('alt', alt);
      img.setAttribute('loading', 'eager');
      img.style.cssText = mode === 'media'
        ? 'display:block;max-width:170px;max-height:58px;width:auto;height:auto;object-fit:contain;'
        : 'display:block;max-width:180px;max-height:72px;width:auto;height:auto;object-fit:contain;';
      cell.appendChild(img);
      grid.appendChild(cell);
    });
    return grid;
  }

  function applyKnownSectionLook(section, mode) {
    if (!(section instanceof Element)) return;
    const container = section.querySelector(':scope > .elementor-container') || section.querySelector('.elementor-container');
    const target = container || section;
    if (mode === 'logos') {
      section.style.background = 'linear-gradient(90deg, rgba(245,235,247,1) 0%, rgba(237,248,246,1) 100%)';
      section.style.backgroundRepeat = 'no-repeat';
      section.style.backgroundSize = 'cover';
      section.style.paddingTop = '28px';
      section.style.paddingBottom = '36px';
      target.style.maxWidth = '1220px';
      target.style.marginLeft = 'auto';
      target.style.marginRight = 'auto';
      target.style.paddingLeft = '16px';
      target.style.paddingRight = '16px';
      target.style.boxSizing = 'border-box';
    }
    if (mode === 'media') {
      section.style.paddingTop = '24px';
      section.style.paddingBottom = '16px';
      target.style.maxWidth = '1220px';
      target.style.marginLeft = 'auto';
      target.style.marginRight = 'auto';
      target.style.paddingLeft = '16px';
      target.style.paddingRight = '16px';
      target.style.boxSizing = 'border-box';
      const card = section.querySelector('.archiver-static-carousel-grid');
      if (card) {
        card.style.maxWidth = '1220px';
      }
    }
  }

  function normalizeKnownCalloutSections(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.elementor-section').forEach((section) => {
      const heading = section.querySelector('h1, h2, h3, .elementor-heading-title');
      const text = String(heading?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (/您即將要投放廣告？|不知道哪種廣告牌形式最適合您？/.test(text)) {
        section.style.removeProperty('left');
        section.style.removeProperty('width');
        section.style.removeProperty('transform');
        section.style.marginLeft = '0';
        section.style.marginRight = '0';
        const container = section.querySelector(':scope > .elementor-container') || section.querySelector('.elementor-container');
        const wrap = section.querySelector('.elementor-widget-wrap') || container || section;
        if (container) {
          container.style.maxWidth = '1220px';
          container.style.marginLeft = 'auto';
          container.style.marginRight = 'auto';
          container.style.paddingLeft = '16px';
          container.style.paddingRight = '16px';
          container.style.boxSizing = 'border-box';
        }
        wrap.style.maxWidth = '1120px';
        wrap.style.marginLeft = 'auto';
        wrap.style.marginRight = 'auto';
        wrap.style.padding = '44px 24px';
        wrap.style.background = 'linear-gradient(90deg, rgba(241,249,248,1) 0%, rgba(235,245,243,1) 100%)';
        wrap.style.borderRadius = '0px';
        wrap.style.boxSizing = 'border-box';
        wrap.style.textAlign = 'center';
        section.querySelectorAll('.elementor-button-wrapper').forEach((btn) => {
          btn.style.display = 'flex';
          btn.style.justifyContent = 'center';
          btn.style.margin = '24px auto 0';
        });
      }
    });
  }

  function repairBrokenImageSections(root) {
    if (!root || !root.querySelectorAll) return;
    const docRef = root.ownerDocument || document;
    const candidateSections = new Set();
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (/\/zh\/0(?:$|[?#])/.test(src) || /\/$/.test(src)) {
        const sec = img.closest('.elementor-section');
        if (sec) candidateSections.add(sec);
      }
    });
    root.querySelectorAll('.elementor-section').forEach((section) => {
      const html = section.innerHTML || '';
      if (/sibforms|newsletter|電子報|subscribe/i.test(html)) candidateSections.add(section);
    });

    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (/\/zh\/0(?:$|[?#])/.test(src) || /\/$/.test(src)) {
        img.remove();
      }
    });

    candidateSections.forEach((section) => {
      const imgs = Array.from(section.querySelectorAll('img')).filter((img) => {
        const src = img.getAttribute('src') || '';
        if (!src || /\/zh\/0(?:$|[?#])/.test(src) || /logo-footer\.png/.test(src)) return false;
        return true;
      });
      if (!imgs.length) return;
      const heroImg = imgs.sort((a,b)=>((parseInt(b.getAttribute('width')||0)||0)*(parseInt(b.getAttribute('height')||0)||0))-((parseInt(a.getAttribute('width')||0)||0)*(parseInt(a.getAttribute('height')||0)||0)))[0] || imgs[0];
      const src = heroImg.getAttribute('src');
      if (!src) return;
      section.innerHTML = '';
      const container = docRef.createElement('div');
      container.style.cssText = 'max-width:1220px;margin:0 auto;padding:24px 16px;display:grid;grid-template-columns:minmax(300px,1fr) minmax(320px,570px);gap:36px;align-items:center;box-sizing:border-box;';
      const left = docRef.createElement('section');
      left.style.cssText = 'min-height:260px;border:1px dashed #c7c7d1;border-radius:12px;background:#fafafe;color:#333;padding:24px;box-sizing:border-box;font:14px/1.7 Arial,sans-serif;display:flex;flex-direction:column;justify-content:center;';
      const h = docRef.createElement('div');
      h.textContent = '已过滤订阅表单区块';
      h.style.cssText = 'font-size:22px;font-weight:700;margin:0 0 10px;';
      const d = docRef.createElement('div');
      d.textContent = '此区块包含外嵌表单与验证码，归档时已转为占位块；右侧展示图已保留。';
      d.style.cssText = 'font-size:14px;line-height:1.7;color:#666;max-width:520px;';
      left.appendChild(h); left.appendChild(d);
      const right = docRef.createElement('div');
      right.style.cssText = 'display:flex;justify-content:center;align-items:center;';
      const im = docRef.createElement('img');
      im.src = src; im.loading = 'eager'; im.style.cssText = 'display:block;max-width:100%;height:auto;object-fit:contain;';
      right.appendChild(im);
      container.appendChild(left); container.appendChild(right); section.appendChild(container);
      section.style.background = 'linear-gradient(90deg, rgba(245,235,247,1) 0%, rgba(237,248,246,1) 100%)';
      section.style.paddingTop = '20px'; section.style.paddingBottom = '20px';
    });
  }

  function hardStaticizeKnownCarouselSections(root) {
    if (!root || !root.querySelectorAll) return;
    const docRef = root.ownerDocument || document;
    const targets = [
      { title: '超過500個品牌信賴', mode: 'logos' },
      { title: '我們與超過300個媒體合作', mode: 'media' }
    ];
    root.querySelectorAll('.elementor-section').forEach((section) => {
      const heading = section.querySelector('h1, h2, h3, .elementor-heading-title');
      const text = String(heading?.textContent || '').replace(/\s+/g, ' ').trim();
      const hit = targets.find((t) => text.includes(t.title));
      if (!hit) return;
      const carouselWidget = section.querySelector('.elementor-widget-image-carousel');
      if (!carouselWidget) return;
      const items = collectUniqueCarouselItems(carouselWidget);
      if (!items.length) return;
      const grid = buildStaticCarouselGrid(docRef, items, hit.mode);
      carouselWidget.innerHTML = '';
      carouselWidget.appendChild(grid);
      carouselWidget.setAttribute('data-archiver-static-carousel', hit.mode);
      applyKnownSectionLook(section, hit.mode);
      const buttonWrapper = section.querySelector('.elementor-button-wrapper');
      if (buttonWrapper) {
        buttonWrapper.style.display = 'flex';
        buttonWrapper.style.justifyContent = 'center';
        buttonWrapper.style.margin = '24px auto 0';
      }
      const headingContainer = section.querySelector('.elementor-widget-heading .elementor-widget-container');
      if (headingContainer) headingContainer.style.textAlign = 'center';
      if (hit.mode === 'media') {
        const ctaWrap = section.querySelector('.you-are-title')?.closest('.elementor-widget-wrap') || section.querySelector('.you-are-title')?.parentElement;
        if (ctaWrap) {
          ctaWrap.style.maxWidth = '1130px';
          ctaWrap.style.margin = '26px auto 0';
          ctaWrap.style.padding = '42px 24px';
          ctaWrap.style.background = 'linear-gradient(90deg, rgba(241,249,248,1) 0%, rgba(235,245,243,1) 100%)';
          ctaWrap.style.boxSizing = 'border-box';
          ctaWrap.style.textAlign = 'center';
        }
      }
      section.querySelectorAll('.slick-prev, .slick-next, .slick-dots, .slick-arrow').forEach((n) => n.remove());
    });
    if (!root.querySelector('style[data-archiver-static-slick]')) {
      const patch = docRef.createElement('style');
      patch.setAttribute('data-archiver-static-slick', 'true');
      patch.textContent = `
[data-archiver-static-carousel] .elementor-image-carousel-wrapper,
[data-archiver-static-carousel] .elementor-image-carousel {
  width: 100% !important;
  max-width: 1220px !important;
  margin-left: auto !important;
  margin-right: auto !important;
}
.archiver-static-carousel-grid {
  display:grid !important;
  grid-template-columns:repeat(auto-fit,minmax(130px,1fr)) !important;
  gap:24px 22px !important;
  align-items:center !important;
  justify-items:center !important;
}
.archiver-static-carousel-item img { object-fit: contain !important; }
`;
      const head = root.querySelector('head');
      if (head) head.appendChild(patch);
      else root.prepend(patch);
    }
  }


  function collectImageLikeResourceCandidates(original, addResource) {
    if (!(original instanceof Element)) return;
    const attrs = [
      'src', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-image',
      'data-desktop-src', 'data-mobile-src', 'data-bg', 'data-background', 'data-lazy-background',
      'poster', 'data-poster'
    ];
    attrs.forEach((attr) => {
      const raw = original.getAttribute(attr);
      const absolute = absoluteUrl(raw);
      if (absolute) addResource(absolute, 'media');
    });

    const srcsetAttrs = ['srcset', 'data-srcset', 'data-lazy-srcset', 'data-bgset'];
    srcsetAttrs.forEach((attr) => {
      const srcset = original.getAttribute(attr);
      if (!srcset) return;
      String(srcset).split(',').forEach((part) => {
        const raw = part.trim().split(/\s+/)[0];
        const absolute = absoluteUrl(raw);
        if (absolute) addResource(absolute, 'media');
      });
    });
  }

  function forceCarouselVisualState(original, cloned, addResource, mode = 'visual') {
    if (!(original instanceof Element) || !(cloned instanceof Element)) return;
    const classText = `${original.className || ''} ${original.getAttribute('data-swiper-slide-index') || ''}`.toLowerCase();
    const roleText = `${original.getAttribute('role') || ''} ${original.getAttribute('aria-roledescription') || ''}`.toLowerCase();
    const isCarouselNode = /(carousel|slider|slick|swiper|splide|glide|flickity|owl)/.test(classText) || /(slide|carousel)/.test(roleText);
    if (!isCarouselNode) return;

    cloned.style.setProperty('display', 'block', 'important');
    cloned.style.setProperty('visibility', 'visible', 'important');
    cloned.style.setProperty('opacity', '1', 'important');
    cloned.style.setProperty('transform', 'none', 'important');

    if (mode === 'assets' && /track|wrapper|list|rail/.test(classText)) {
      cloned.style.setProperty('display', 'flex', 'important');
      cloned.style.setProperty('flex-wrap', 'wrap', 'important');
      cloned.style.setProperty('gap', '16px', 'important');
    }

    const style = getComputedStyle(original);
    if (style.backgroundImage && style.backgroundImage !== 'none') {
      extractCssUrls(style.backgroundImage, document.baseURI, addResource, 'style-asset');
      cloned.style.backgroundImage = rewriteCssTextToAbsoluteTokens(style.backgroundImage, document.baseURI, addResource);
      cloned.style.backgroundSize = style.backgroundSize;
      cloned.style.backgroundPosition = style.backgroundPosition;
      cloned.style.backgroundRepeat = style.backgroundRepeat;
    }
  }

  function applyHighFidelityStyleSnapshot(original, cloned, addResource) {
    if (!(original instanceof Element) || !(cloned instanceof Element)) return;
    const style = getComputedStyle(original);
    if (!style) return;
    const rect = original.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;

    const props = [
      'display', 'position', 'z-index', 'width', 'height', 'max-width', 'min-height',
      'margin', 'padding', 'border', 'border-radius', 'box-shadow',
      'background', 'background-image', 'background-size', 'background-position', 'background-repeat',
      'opacity', 'visibility', 'overflow',
      'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color',
      'text-align', 'white-space'
    ];
    applyConservativeInlineStyle(original, cloned, document.baseURI, addResource, props);
  }

  function shouldSnapshotForHighFidelity(node) {
    if (!(node instanceof Element)) return false;
    const tag = node.tagName.toLowerCase();
    const cls = String(node.className || '').toLowerCase();
    if (/carousel|slider|hero|banner|header|footer|cta|btn|card/.test(cls)) return true;
    if (['h1', 'h2', 'h3', 'button', 'nav', 'section', 'article', 'main'].includes(tag)) return true;
    const rect = node.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 40 && rect.top < window.innerHeight * 2;
  }

  function markCarouselScopes(root) {
    if (!root || !root.querySelectorAll) return 0;
    const candidates = Array.from(root.querySelectorAll(
      '.slick-slider, .slick-track, .swiper, .swiper-container, .swiper-wrapper, .owl-carousel, .owl-stage, .splide, .splide__track, .glide, .glide__track, [class*="carousel"], [class*="slider"]'
    ));
    const unique = new Set();
    candidates.forEach((node) => {
      if (!(node instanceof Element)) return;
      const host = node.closest('section, article, main, div') || node;
      host.setAttribute('data-archiver-carousel-scope', 'true');
      unique.add(host);
    });
    return unique.size;
  }

  function staticizeGenericCarousels(root) {
    if (!root || !root.querySelectorAll) return 0;
    const docRef = root.ownerDocument || document;
    let updated = 0;
    root.querySelectorAll('[data-archiver-carousel-scope="true"]').forEach((scope) => {
      const images = Array.from(scope.querySelectorAll('img')).filter((img) => !!img.getAttribute('src'));
      if (images.length < 2) return;
      const grid = docRef.createElement('div');
      grid.setAttribute('data-archiver-static-carousel-generic', 'true');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;align-items:center;';
      images.slice(0, 80).forEach((img) => {
        const wrap = docRef.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:60px;padding:6px;';
        const clone = img.cloneNode(true);
        clone.removeAttribute('srcset');
        clone.style.cssText = 'max-width:100%;max-height:70px;object-fit:contain;';
        wrap.appendChild(clone);
        grid.appendChild(wrap);
      });
      const host = scope.querySelector('.slick-track, .swiper-wrapper, .owl-stage, .splide__list, .glide__slides') || scope;
      host.innerHTML = '';
      host.appendChild(grid);
      updated += 1;
    });
    return updated;
  }


  function cleanupArchivedDocument(root, debug, options = {}) {
    const docRef = root.ownerDocument || document;
    const removableSelectors = [
      'remove-web-limits-iqxin',
      'iframe[src*="hotjar"]',
      'iframe[src*="intercom"]',
      'iframe[src*="recaptcha"]',
      '.grecaptcha-badge',
      '[id*="recaptcha"]',
      '[class*="recaptcha"]',
      '.cp-popup',
      '[class*="creativepopup"]',
      '[id^="cp_"]',
      '[id*="cookie-banner"]',
      '[class*="cookie-banner"]',
      '[id*="cookie-consent"]',
      '[class*="cookie-consent"]',
      '[id*="consent-banner"]',
      '[class*="consent-banner"]',
      '[id*="gdpr"]',
      '[class*="gdpr"]'
    ];
    root.querySelectorAll(removableSelectors.join(',')).forEach((node) => {
      pushDebug(debug, 'removedNodes', { reason: 'matched-removable-selector', selector: describeNode(node), text: textSnippet(node.textContent) }, 120);
      node.remove();
    });

    Array.from(root.querySelectorAll('section, div, aside, dialog, form, [role="dialog"], [aria-modal="true"]')).forEach((node) => {
      if (looksLikeCookieOrConsentPanel(node)) {
        pushDebug(debug, 'removedNodes', { reason: 'cookie-or-consent-panel', selector: describeNode(node), text: textSnippet(node.textContent) }, 120);
        node.remove();
      }
    });

    const liveForms = Array.from(document.querySelectorAll('form'));
    const clonedForms = Array.from(root.querySelectorAll('form'));
    clonedForms.forEach((form, index) => {
      const liveForm = liveForms[index];
      const title = getClosestHeadingText(form) || form.getAttribute('aria-label') || form.getAttribute('name') || '已过滤表单区块';
      const controlCount = form.querySelectorAll('input, button, select, textarea').length;
      const hasCaptcha = !!form.querySelector('iframe[src*="recaptcha"], [class*="recaptcha"], [id*="recaptcha"], .g-recaptcha, .grecaptcha-badge');
      const hasTextarea = !!form.querySelector('textarea');
      if (liveForm && looksLikeSearchForm(liveForm)) {
        pushDebug(debug, 'searchForms', { selector: describeNode(form), action: liveForm.getAttribute('action') || location.href, text: textSnippet(form.textContent) }, 20);
        preserveSearchFormBehavior(liveForm, form, () => {});
        return;
      }
      const isLargeForm = controlCount >= 4 || hasTextarea || hasCaptcha;
      if (isLargeForm) {
        pushDebug(debug, 'placeholders', { selector: describeNode(form), title, controlCount, hasCaptcha, reason: hasCaptcha ? 'form-with-captcha' : 'interactive-form' }, 80);
        replaceNodeWithPlaceholder(
          form,
          title,
          hasCaptcha
            ? '此区块包含表单与验证码，归档时已转为占位块，建议后续人工补全。'
            : '此区块包含交互表单，归档时已转为占位块，建议后续人工补全。',
          false
        );
      } else {
        form.setAttribute('action', '#');
        form.querySelectorAll('input, textarea').forEach((el) => {
          el.setAttribute('readonly', 'readonly');
          el.removeAttribute('required');
        });
        form.querySelectorAll('button').forEach((btn) => btn.setAttribute('type', 'button'));
      }
    });

    normalizeElementorStretchedSections(root);
    hardStaticizeKnownCarouselSections(root);
    normalizeKnownCalloutSections(root);
    repairBrokenImageSections(root);

    root.querySelectorAll('base, meta[http-equiv="refresh"], link[rel="preconnect"], link[rel="dns-prefetch"], link[rel="modulepreload"], link[rel="prefetch"], link[rel="prerender"]').forEach((node) => node.remove());

    const patch = docRef.createElement('style');
    patch.setAttribute('data-archiver-form-filter', 'true');
    patch.textContent = `
html, body, main, #main-page-content { opacity:1 !important; visibility:visible !important; display:block !important; }
body { min-width:0 !important; }
[data-archiver-placeholder="true"] { clear:both; }
canvas[data-archived-from-canvas="true"] { display:none !important; }
iframe[src*="recaptcha"], .grecaptcha-badge { display:none !important; }
.elementor-section-stretched { overflow: visible !important; }
.elementor-section-stretched > .elementor-container { overflow: visible !important; }
[data-archiver-static-carousel="logos"] { background: linear-gradient(90deg, rgba(245,235,247,1) 0%, rgba(237,248,246,1) 100%) !important; }
[data-archiver-static-carousel] .elementor-widget-container { width: 100% !important; }
[data-archiver-static-carousel="logos"] .archiver-static-carousel-grid { padding: 8px 0 12px !important; }
[data-archiver-static-carousel="media"] .archiver-static-carousel-grid { padding: 8px 0 12px !important; }
[data-archiver-carousel-scope="true"] .slick-slide, [data-archiver-carousel-scope="true"] .swiper-slide, [data-archiver-carousel-scope="true"] .owl-item, [data-archiver-carousel-scope="true"] .splide__slide, [data-archiver-carousel-scope="true"] .glide__slide {
  display:block !important;
  visibility:visible !important;
  opacity:1 !important;
  transform:none !important;
}
[data-archiver-carousel-scope="true"] .slick-track, [data-archiver-carousel-scope="true"] .swiper-wrapper, [data-archiver-carousel-scope="true"] .owl-stage, [data-archiver-carousel-scope="true"] .splide__list, [data-archiver-carousel-scope="true"] .glide__slides {
  display:flex !important;
  flex-wrap:wrap !important;
  transform:none !important;
  gap:16px !important;
}
[data-archiver-carousel-scope="true"] .slick-arrow, [data-archiver-carousel-scope="true"] .slick-dots, [data-archiver-carousel-scope="true"] .swiper-button-prev, [data-archiver-carousel-scope="true"] .swiper-button-next, [data-archiver-carousel-scope="true"] .swiper-pagination, [data-archiver-carousel-scope="true"] .owl-nav, [data-archiver-carousel-scope="true"] .owl-dots, [data-archiver-carousel-scope="true"] .splide__arrows, [data-archiver-carousel-scope="true"] .splide__pagination, [data-archiver-carousel-scope="true"] .glide__arrows, [data-archiver-carousel-scope="true"] .glide__bullets {
  display:none !important;
}
`;
    if (options.carouselMode === 'assets') {
      patch.textContent += `
[data-archiver-carousel-scope="true"] .slick-track, [data-archiver-carousel-scope="true"] .swiper-wrapper, [data-archiver-carousel-scope="true"] .owl-stage, [data-archiver-carousel-scope="true"] .splide__list, [data-archiver-carousel-scope="true"] .glide__slides {
  align-items: stretch !important;
}
`;
    }
    const head = root.querySelector('head');
    if (head) head.appendChild(patch);
    else root.prepend(patch);
  }

  async function buildCapturePayload(options = {}) {
    await waitForPageSettled();

    const debug = {
      archiverVersion: '2.3.1-carousel-scope-refine',
      pageUrl: location.href,
      title: document.title || 'untitled',
      capturedAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
      options: {
        includeScripts: options.includeScripts !== false,
        includeStyles: options.includeStyles !== false,
        includeMedia: options.includeMedia !== false,
        imagesOnly: options.imagesOnly === true,
        carouselMode: options.carouselMode === 'assets' ? 'assets' : 'visual',
        styleFidelity: options.styleFidelity === 'high' ? 'high' : 'basic'
      },
      counters: { resourcesAdded: 0 },
      headings: [],
      buttons: [],
      backgrounds: [],
      images: [],
      placeholders: [],
      removedNodes: [],
      searchForms: []
    };

    collectHeadingDebug(debug);
    collectButtonDebug(debug);
    collectBackgroundDebug(debug);
    collectImageDebug(debug);

    const doc = document.documentElement.cloneNode(true);
    hydrateLazyAssets(doc);
    const carouselScopeCount = markCarouselScopes(doc);
    debug.counters.carouselScopes = carouselScopeCount;
    const resources = [];
    const seen = new Set();
    let resourceIndex = 0;
    let highFidelityApplied = 0;
    const highFidelityLimit = options.styleFidelity === 'high' ? 600 : 0;

    function shouldInclude(kind) {
      if (kind === 'script') return options.includeScripts !== false;
      if (kind === 'style') return options.includeStyles !== false;
      if (kind === 'video' || kind === 'audio') return options.includeMedia !== false && options.imagesOnly !== true;
      if (options.imagesOnly === true) return kind === 'media' || kind === 'style-asset' || kind === 'asset';
      if (kind === 'media' || kind === 'style-asset' || kind === 'font' || kind === 'asset') return options.includeMedia !== false;
      return true;
    }

    function addResource(url, kind, preferredName) {
      if (!url || seen.has(url)) return;
      if (!shouldInclude(kind)) return;
      seen.add(url);
      resources.push({
        id: `res_${resourceIndex++}`,
        url,
        kind,
        preferredName: preferredName || null
      });
      debug.counters.resourcesAdded += 1;
    }

    for (const rule of ATTRS) {
      if (!shouldInclude(rule.kind)) continue;
      const originals = Array.from(document.querySelectorAll(rule.selector));
      const clones = Array.from(doc.querySelectorAll(rule.selector));
      originals.forEach((node, index) => {
        const cloned = clones[index];
        if (!cloned) return;
        rule.handle({ original: node, cloned, addResource });
      });
    }

    const originalAll = Array.from(document.querySelectorAll('*'));
    const clonedAll = Array.from(doc.querySelectorAll('*'));
    originalAll.forEach((original, index) => {
      const cloned = clonedAll[index];
      if (!cloned) return;

      if (isLikelyFullscreenOverlay(original) && !isRootLikeElement(original)) {
        pushDebug(debug, 'removedNodes', { reason: 'fullscreen-overlay', selector: describeNode(original), text: textSnippet(original.textContent), rect: rectSnapshot(original) }, 120);
        cloned.remove();
        return;
      }

      freezeFormState(original, cloned);

      const inlineStyle = cloned.getAttribute('style');
      if (inlineStyle) {
        cloned.setAttribute('style', rewriteCssTextToAbsoluteTokens(inlineStyle, document.baseURI, addResource));
      }

      if (original instanceof Element && cloned instanceof Element && original.classList.contains('elementor-section')) {
        try {
          const style = getComputedStyle(original);
          if (style.backgroundImage && style.backgroundImage !== 'none') {
            extractCssUrls(style.backgroundImage, document.baseURI, addResource, 'style-asset');
            cloned.style.backgroundImage = rewriteCssTextToAbsoluteTokens(style.backgroundImage, document.baseURI, addResource);
            cloned.style.backgroundSize = style.backgroundSize;
            cloned.style.backgroundPosition = style.backgroundPosition;
            cloned.style.backgroundRepeat = style.backgroundRepeat;
          }
          if (style.backgroundColor && !isNearlyTransparentColor(style.backgroundColor)) {
            cloned.style.backgroundColor = style.backgroundColor;
          }
        } catch {}
      }

      const bgCandidates = [
        original.getAttribute('data-bg'),
        original.getAttribute('data-background'),
        original.getAttribute('data-lazy-background'),
        original.getAttribute('data-image')
      ].filter(Boolean);
      for (const candidate of bgCandidates) {
        const absolute = absoluteUrl(candidate);
        if (absolute) addResource(absolute, 'media');
      }

      collectImageLikeResourceCandidates(original, addResource);
      forceCarouselVisualState(original, cloned, addResource, options.carouselMode === 'assets' ? 'assets' : 'visual');
      if (options.styleFidelity === 'high' && highFidelityApplied < highFidelityLimit && shouldSnapshotForHighFidelity(original)) {
        applyHighFidelityStyleSnapshot(original, cloned, addResource);
        highFidelityApplied += 1;
      }
    });

    if (options.carouselMode === 'assets') {
      const staticized = staticizeGenericCarousels(doc);
      debug.counters.staticizedCarousels = staticized;
    }
    debug.counters.highFidelityApplied = highFidelityApplied;

    if (options.includeStyles !== false) {
      const originalStyleTags = Array.from(document.querySelectorAll('style'));
      const clonedStyleTags = Array.from(doc.querySelectorAll('style'));
      originalStyleTags.forEach((tag, index) => {
        const text = tag.textContent || '';
        const rewritten = rewriteCssTextToAbsoluteTokens(text, document.baseURI, addResource);
        if (clonedStyleTags[index]) clonedStyleTags[index].textContent = rewritten;
      });
    }

    const originalCanvases = Array.from(document.querySelectorAll('canvas'));
    const clonedCanvases = Array.from(doc.querySelectorAll('canvas'));
    clonedCanvases.forEach((canvas, index) => {
      const original = originalCanvases[index];
      if (!original) return;
      if (isLargeDecorativeCanvas(original)) {
        pushDebug(debug, 'removedNodes', { reason: 'large-decorative-canvas', selector: describeNode(original), rect: rectSnapshot(original) }, 120);
        canvas.remove();
      } else {
        canvas.setAttribute('data-archived-from-canvas', 'true');
        canvas.style.display = 'none';
      }
    });

    if (options.includeScripts === false) {
      doc.querySelectorAll('script').forEach((node) => node.remove());
    }

    doc.querySelectorAll('noscript').forEach((node) => node.remove());

    cleanupArchivedDocument(doc, debug, options);

    const doctype = document.doctype
      ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}${document.doctype.systemId ? ` "${document.doctype.systemId}"` : ''}>`
      : '<!DOCTYPE html>';

    return {
      pageUrl: location.href,
      title: document.title || 'untitled',
      capturedAt: new Date().toISOString(),
      html: `${doctype}\n${doc.outerHTML}`,
      resources,
      options: {
        includeScripts: options.includeScripts !== false,
        includeStyles: options.includeStyles !== false,
        includeMedia: options.includeMedia !== false,
        imagesOnly: options.imagesOnly === true,
        carouselMode: options.carouselMode === 'assets' ? 'assets' : 'visual',
        styleFidelity: options.styleFidelity === 'high' ? 'high' : 'basic'
      },
      debug
    };
  }


  async function sendPayloadToBackground(payload, requestId) {
    const json = JSON.stringify(payload);
    const chunkSize = 240000;
    const total = Math.ceil(json.length / chunkSize) || 1;
    for (let index = 0; index < total; index += 1) {
      const chunk = json.slice(index * chunkSize, (index + 1) * chunkSize);
      await chrome.runtime.sendMessage({ type: 'ARCHIVE_CAPTURE_CHUNK', requestId, index, total, chunk });
    }
    await chrome.runtime.sendMessage({ type: 'ARCHIVE_CAPTURE_DONE', requestId, total });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ARCHIVE_CAPTURE_RUN') return false;

    sendResponse({ ok: true });

    (async () => {
      try {
        const payload = await buildCapturePayload(message.options || {});
        await sendPayloadToBackground(payload, message.requestId);
      } catch (error) {
        await chrome.runtime.sendMessage({
          type: 'ARCHIVE_CAPTURE_ERROR',
          requestId: message.requestId,
          error: error instanceof Error ? `${error.message}${error.stack ? `
${error.stack}` : ''}` : String(error)
        });
      }
    })();

    return false;
  });

  window.__webArchiverCapturePage = buildCapturePayload;
})();
