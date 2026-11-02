// Completions for LaTeX in the editor: type "\c" and a list of commands that start with it appears; Tab inserts the
// chosen one, with {} when it takes an argument and the caret placed inside. After "\begin{" or "\end{" it offers
// environment names instead.
//
// The first half is plain functions (context, suggest, insertion) that know nothing about the page, so they can be
// tested in Node; `attach` wires them to a textarea in the browser.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.LatexComplete = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // [name, arguments, what it does]. `arguments` is what is inserted after the name: '{}' for one argument, '{}{}'
    // for two, '' for none. The list is in rough order of how often people use a command, which is the order the
    // popup shows its matches in, so "\c" offers \cite before \cdots.
    const COMMANDS = [
        ['cite', '{}', 'citation'], ['label', '{}', 'label for \\ref'], ['ref', '{}', 'reference to a label'],
        ['section', '{}', 'section heading'], ['subsection', '{}', 'subsection heading'],
        ['subsubsection', '{}', 'subsubsection heading'], ['paragraph', '{}', 'run-in paragraph heading'],
        ['chapter', '{}', 'chapter heading'], ['part', '{}', 'part heading'],
        ['begin', '{}', 'start an environment'], ['end', '{}', 'end an environment'],
        ['textbf', '{}', 'bold text'], ['textit', '{}', 'italic text'], ['emph', '{}', 'emphasised text'],
        ['texttt', '{}', 'monospace text'], ['textsc', '{}', 'small capitals'], ['textsf', '{}', 'sans-serif text'],
        ['textrm', '{}', 'roman text'], ['underline', '{}', 'underlined text'], ['textcolor', '{}{}', 'coloured text: colour, text'],
        ['item', '', 'list item'], ['caption', '{}', 'figure or table caption'],
        ['includegraphics', '{}', 'insert an image'], ['usepackage', '{}', 'load a package'],
        ['documentclass', '{}', 'document class'], ['title', '{}', 'document title'], ['author', '{}', 'document author'],
        ['date', '{}', 'document date'], ['maketitle', '', 'print the title block'],
        ['tableofcontents', '', 'table of contents'], ['frac', '{}{}', 'fraction: numerator, denominator'],
        ['sqrt', '{}', 'square root'], ['sum', '', 'summation sign'], ['int', '', 'integral sign'],
        ['footnote', '{}', 'footnote'], ['eqref', '{}', 'reference to an equation, in brackets'],
        ['autoref', '{}', 'named reference (hyperref)'], ['cref', '{}', 'smart reference (cleveref)'],
        ['pageref', '{}', 'page number of a label'], ['citep', '{}', 'parenthetical citation (natbib)'],
        ['citet', '{}', 'textual citation (natbib)'], ['citeauthor', '{}', 'author of a citation'],
        ['citeyear', '{}', 'year of a citation'], ['nocite', '{}', 'list a reference without citing it'],
        ['bibliography', '{}', 'bibliography file (without .bib)'], ['bibliographystyle', '{}', 'bibliography style'],
        ['bibitem', '{}', 'entry in a thebibliography list'], ['addbibresource', '{}', 'bibliography file (biblatex)'],
        ['printbibliography', '', 'print the bibliography (biblatex)'],
        ['input', '{}', 'insert another file'], ['include', '{}', 'insert another file on a new page'],
        ['includeonly', '{}', 'compile only these \\include files'], ['url', '{}', 'web address'],
        ['href', '{}{}', 'link: address, text'], ['hline', '', 'horizontal line in a table'],
        ['cline', '{}', 'partial horizontal line in a table'], ['multicolumn', '{}{}{}', 'cell spanning columns'],
        ['multirow', '{}{}{}', 'cell spanning rows'], ['centering', '', 'centre what follows'],
        ['raggedright', '', 'left-aligned text'], ['raggedleft', '', 'right-aligned text'],
        ['noindent', '', 'no paragraph indent'], ['indent', '', 'paragraph indent'],
        ['newpage', '', 'start a new page'], ['clearpage', '', 'new page, flush floats'],
        ['pagebreak', '', 'allow or force a page break'], ['linebreak', '', 'line break'], ['newline', '', 'new line'],
        ['vspace', '{}', 'vertical space'], ['hspace', '{}', 'horizontal space'], ['vfill', '', 'stretchable vertical space'],
        ['hfill', '', 'stretchable horizontal space'], ['quad', '', 'space of 1 em'], ['qquad', '', 'space of 2 em'],
        ['smallskip', '', 'small vertical space'], ['medskip', '', 'medium vertical space'],
        ['bigskip', '', 'large vertical space'], ['par', '', 'end paragraph'], ['today', '', "today's date"],
        ['ldots', '', 'ellipsis …'], ['cdots', '', 'centred dots ⋯'], ['vdots', '', 'vertical dots ⋮'],
        ['ddots', '', 'diagonal dots ⋱'], ['dots', '', 'dots, spaced to suit'],
        ['textsl', '{}', 'slanted text'], ['textup', '{}', 'upright text'], ['textmd', '{}', 'medium-weight text'],
        ['textnormal', '{}', 'document font'], ['colorbox', '{}{}', 'text on a coloured box: colour, text'],
        ['color', '{}', 'colour of what follows'], ['fbox', '{}', 'framed box'], ['mbox', '{}', 'unbreakable box'],
        ['makebox', '{}', 'box of given width'], ['parbox', '{}{}', 'paragraph box: width, text'],
        ['raisebox', '{}{}', 'raise text: distance, text'], ['hrule', '', 'horizontal rule'],
        ['tiny', '', 'size'], ['scriptsize', '', 'size'], ['footnotesize', '', 'size'], ['small', '', 'size'],
        ['normalsize', '', 'size'], ['large', '', 'size'], ['Large', '', 'size'], ['LARGE', '', 'size'],
        ['huge', '', 'size'], ['Huge', '', 'size'],
        ['bfseries', '', 'bold from here'], ['itshape', '', 'italic from here'], ['scshape', '', 'small caps from here'],
        ['ttfamily', '', 'monospace from here'], ['sffamily', '', 'sans-serif from here'],
        ['rmfamily', '', 'roman from here'], ['mdseries', '', 'medium weight from here'],
        ['upshape', '', 'upright from here'], ['slshape', '', 'slanted from here'],
        ['newcommand', '{}', 'define a command'], ['renewcommand', '{}', 'redefine a command'],
        ['providecommand', '{}', 'define a command if it is new'], ['newenvironment', '{}', 'define an environment'],
        ['renewenvironment', '{}', 'redefine an environment'], ['newtheorem', '{}{}', 'define a theorem: name, title'],
        ['def', '', 'TeX macro definition'], ['let', '', 'copy a macro'],
        ['setlength', '{}{}', 'set a length: name, value'], ['addtolength', '{}{}', 'add to a length'],
        ['setcounter', '{}{}', 'set a counter: name, value'], ['addtocounter', '{}{}', 'add to a counter'],
        ['newcounter', '{}', 'new counter'], ['stepcounter', '{}', 'increment a counter'],
        ['arabic', '{}', 'counter as 1, 2, 3'], ['roman', '{}', 'counter as i, ii, iii'],
        ['Roman', '{}', 'counter as I, II, III'], ['alph', '{}', 'counter as a, b, c'], ['Alph', '{}', 'counter as A, B, C'],
        ['thispagestyle', '{}', 'style for this page'], ['pagestyle', '{}', 'page style'],
        ['pagenumbering', '{}', 'page number format'], ['geometry', '{}', 'page layout (geometry package)'],
        ['hypersetup', '{}', 'link options (hyperref)'], ['AtBeginDocument', '{}', 'run at \\begin{document}'],
        ['DeclareMathOperator', '{}{}', 'define an operator name'], ['hyphenation', '{}', 'hyphenation hints'],
        ['footnotemark', '', 'footnote mark only'], ['footnotetext', '{}', 'text for a footnote mark'],
        ['thanks', '{}', 'footnote on the title'], ['appendix', '', 'switch to appendices'],
        ['abstract', '', 'abstract (use the environment)'], ['tableofcontents', '', 'table of contents'],
        ['listoffigures', '', 'list of figures'], ['listoftables', '', 'list of tables'],
        ['index', '{}', 'index entry'], ['glossary', '{}', 'glossary entry'], ['lipsum', '', 'dummy text (lipsum package)'],

        // Mathematics
        ['dfrac', '{}{}', 'fraction, display size'], ['tfrac', '{}{}', 'fraction, text size'],
        ['binom', '{}{}', 'binomial coefficient'], ['prod', '', 'product sign'], ['iint', '', 'double integral'],
        ['oint', '', 'contour integral'], ['lim', '', 'limit'], ['limits', '', 'limits above and below'],
        ['infty', '', 'infinity ∞'], ['partial', '', 'partial derivative ∂'], ['nabla', '', 'nabla ∇'],
        ['cdot', '', 'dot ⋅'], ['times', '', 'times ×'], ['div', '', 'division ÷'], ['pm', '', 'plus-minus ±'],
        ['mp', '', 'minus-plus ∓'], ['leq', '', 'less than or equal ≤'], ['geq', '', 'greater than or equal ≥'],
        ['neq', '', 'not equal ≠'], ['approx', '', 'approximately ≈'], ['equiv', '', 'equivalent ≡'],
        ['sim', '', 'similar ∼'], ['simeq', '', 'similar or equal ≃'], ['propto', '', 'proportional ∝'],
        ['ll', '', 'much less ≪'], ['gg', '', 'much greater ≫'], ['subset', '', 'subset ⊂'], ['subseteq', '', 'subset or equal ⊆'],
        ['supset', '', 'superset ⊃'], ['supseteq', '', 'superset or equal ⊇'], ['in', '', 'element of ∈'],
        ['notin', '', 'not an element of ∉'], ['cup', '', 'union ∪'], ['cap', '', 'intersection ∩'],
        ['setminus', '', 'set difference ∖'], ['emptyset', '', 'empty set ∅'], ['varnothing', '', 'empty set ∅'],
        ['forall', '', 'for all ∀'], ['exists', '', 'there exists ∃'], ['neg', '', 'not ¬'], ['land', '', 'and ∧'],
        ['lor', '', 'or ∨'], ['implies', '', 'implies ⟹'], ['iff', '', 'if and only if ⟺'],
        ['to', '', 'arrow →'], ['rightarrow', '', 'arrow →'], ['leftarrow', '', 'arrow ←'], ['Rightarrow', '', 'double arrow ⇒'],
        ['Leftarrow', '', 'double arrow ⇐'], ['leftrightarrow', '', 'arrow ↔'], ['Leftrightarrow', '', 'double arrow ⇔'],
        ['mapsto', '', 'maps to ↦'], ['uparrow', '', 'arrow ↑'], ['downarrow', '', 'arrow ↓'],
        ['alpha', '', 'α'], ['beta', '', 'β'], ['gamma', '', 'γ'], ['delta', '', 'δ'], ['epsilon', '', 'ϵ'],
        ['varepsilon', '', 'ε'], ['zeta', '', 'ζ'], ['eta', '', 'η'], ['theta', '', 'θ'], ['vartheta', '', 'ϑ'],
        ['iota', '', 'ι'], ['kappa', '', 'κ'], ['lambda', '', 'λ'], ['mu', '', 'μ'], ['nu', '', 'ν'], ['xi', '', 'ξ'],
        ['pi', '', 'π'], ['varpi', '', 'ϖ'], ['rho', '', 'ρ'], ['varrho', '', 'ϱ'], ['sigma', '', 'σ'],
        ['varsigma', '', 'ς'], ['tau', '', 'τ'], ['upsilon', '', 'υ'], ['phi', '', 'ϕ'], ['varphi', '', 'φ'],
        ['chi', '', 'χ'], ['psi', '', 'ψ'], ['omega', '', 'ω'],
        ['Gamma', '', 'Γ'], ['Delta', '', 'Δ'], ['Theta', '', 'Θ'], ['Lambda', '', 'Λ'], ['Xi', '', 'Ξ'], ['Pi', '', 'Π'],
        ['Sigma', '', 'Σ'], ['Upsilon', '', 'Υ'], ['Phi', '', 'Φ'], ['Psi', '', 'Ψ'], ['Omega', '', 'Ω'],
        ['hat', '{}', 'hat accent'], ['bar', '{}', 'bar accent'], ['tilde', '{}', 'tilde accent'], ['vec', '{}', 'vector arrow'],
        ['dot', '{}', 'dot accent'], ['ddot', '{}', 'double dot accent'], ['overline', '{}', 'line above'],
        ['overbrace', '{}', 'brace above'], ['underbrace', '{}', 'brace below'], ['widehat', '{}', 'wide hat'],
        ['widetilde', '{}', 'wide tilde'], ['mathbf', '{}', 'bold in maths'], ['mathrm', '{}', 'roman in maths'],
        ['mathit', '{}', 'italic in maths'], ['mathcal', '{}', 'calligraphic 𝒜'], ['mathbb', '{}', 'blackboard bold ℝ'],
        ['mathfrak', '{}', 'fraktur 𝔄'], ['mathsf', '{}', 'sans-serif in maths'], ['mathtt', '{}', 'monospace in maths'],
        ['boldsymbol', '{}', 'bold symbol (amsmath)'], ['text', '{}', 'text inside maths (amsmath)'],
        ['operatorname', '{}', 'operator name in maths'], ['left', '', 'auto-sized opening delimiter'],
        ['right', '', 'auto-sized closing delimiter'], ['big', '', 'larger delimiter'], ['Big', '', 'larger delimiter'],
        ['bigg', '', 'larger delimiter'], ['Bigg', '', 'larger delimiter'], ['langle', '', 'angle bracket ⟨'],
        ['rangle', '', 'angle bracket ⟩'], ['lceil', '', 'ceiling ⌈'], ['rceil', '', 'ceiling ⌉'],
        ['lfloor', '', 'floor ⌊'], ['rfloor', '', 'floor ⌋'], ['sin', '', 'sine'], ['cos', '', 'cosine'], ['tan', '', 'tangent'],
        ['log', '', 'logarithm'], ['ln', '', 'natural logarithm'], ['exp', '', 'exponential'], ['max', '', 'maximum'],
        ['min', '', 'minimum'], ['sup', '', 'supremum'], ['inf', '', 'infimum'], ['det', '', 'determinant'],
        ['dim', '', 'dimension'], ['ker', '', 'kernel'], ['arg', '', 'argument'], ['gcd', '', 'greatest common divisor'],
        ['tag', '{}', 'custom equation tag'], ['nonumber', '', 'no number for this line'], ['notag', '', 'no tag for this line'],
        ['intertext', '{}', 'text between aligned lines'], ['substack', '{}', 'stacked sub/superscript lines'],
        ['stackrel', '{}{}', 'symbol on top of another'], ['overset', '{}{}', 'symbol above another'],
        ['underset', '{}{}', 'symbol below another'], ['xrightarrow', '{}', 'arrow with a label'],
        ['mid', '', 'vertical bar |'], ['parallel', '', 'parallel ∥'], ['perp', '', 'perpendicular ⊥'],
        ['angle', '', 'angle ∠'], ['circ', '', 'circle ∘'], ['bullet', '', 'bullet ∙'], ['ast', '', 'asterisk ∗'],
        ['star', '', 'star ⋆'], ['oplus', '', 'circled plus ⊕'], ['otimes', '', 'circled times ⊗'], ['odot', '', 'circled dot ⊙'],
        ['hbar', '', 'h bar ℏ'], ['ell', '', 'script l ℓ'], ['Re', '', 'real part ℜ'], ['Im', '', 'imaginary part ℑ'],
        ['aleph', '', 'aleph ℵ'], ['prime', '', 'prime ′'], ['mathbb', '{}', 'blackboard bold ℝ']
    ].filter(([name], i, all) => all.findIndex(([other]) => other === name) === i)
        .map(([name, args, description]) => ({ name, args, description }));

    const ENVIRONMENTS = [
        ['itemize', 'bulleted list'], ['enumerate', 'numbered list'], ['equation', 'numbered equation'],
        ['equation*', 'unnumbered equation'], ['figure', 'floating figure'], ['table', 'floating table'],
        ['tabular', 'table of rows and columns'], ['align', 'aligned equations (amsmath)'],
        ['align*', 'aligned equations, unnumbered'], ['document', 'the document body'], ['center', 'centred text'],
        ['abstract', 'abstract'], ['description', 'list with labelled items'], ['quote', 'short quotation'],
        ['quotation', 'long quotation'], ['verbatim', 'text exactly as typed'], ['minipage', 'a page inside a page'],
        ['theorem', 'theorem'], ['lemma', 'lemma'], ['proposition', 'proposition'], ['corollary', 'corollary'],
        ['definition', 'definition'], ['proof', 'proof (amsthm)'], ['remark', 'remark'], ['example', 'example'],
        ['gather', 'centred equations (amsmath)'], ['gather*', 'centred equations, unnumbered'],
        ['multline', 'equation broken over lines'], ['split', 'split one equation over lines'],
        ['cases', 'cases with a brace'], ['matrix', 'matrix'], ['pmatrix', 'matrix in ( )'], ['bmatrix', 'matrix in [ ]'],
        ['vmatrix', 'determinant | |'], ['Vmatrix', 'matrix in ‖ ‖'], ['array', 'array in maths'],
        ['subequations', 'sub-numbered equations'], ['figure*', 'figure across both columns'],
        ['table*', 'table across both columns'], ['tabularx', 'table with stretching columns'],
        ['longtable', 'table over several pages'], ['flushleft', 'left-aligned text'], ['flushright', 'right-aligned text'],
        ['thebibliography', 'hand-written bibliography'], ['lstlisting', 'code listing (listings)'],
        ['tikzpicture', 'TikZ drawing'], ['frame', 'slide (beamer)'], ['columns', 'columns (beamer)'],
        ['column', 'one column (beamer)'], ['block', 'titled block (beamer)'], ['wrapfigure', 'text-wrapped figure'],
        ['landscape', 'rotated page'], ['titlepage', 'title page'], ['algorithm', 'floating algorithm'],
        ['algorithmic', 'algorithm steps'], ['filecontents', 'write a file from the document']
    ].map(([name, description]) => ({ name, description }));

    // What the text before the caret is asking for: { kind: 'command' | 'environment', prefix, start } or null. `start`
    // is where the text that a choice replaces begins.
    function context(before) {
        const line = before.slice(before.lastIndexOf('\n') + 1);
        if (/(^|[^\\])(\\\\)*%/.test(line)) return null; // a comment
        const env = /\\(?:begin|end)\{([A-Za-z*]*)$/.exec(line);
        if (env) return { kind: 'environment', prefix: env[1], start: before.length - env[1].length };
        const command = /(^|[^\\])\\([A-Za-z]+)$/.exec(line);
        if (command) return { kind: 'command', prefix: command[2], start: before.length - command[2].length - 1 };
        return null;
    }

    // The matches for a context, best first, as { name, description, args } items.
    function suggest(ctx, limit = 8) {
        if (!ctx) return [];
        const list = ctx.kind === 'environment' ? ENVIRONMENTS : COMMANDS;
        return list.filter((item) => item.name.startsWith(ctx.prefix)).slice(0, limit);
    }

    // What choosing `item` writes: { text, caret, consume } where `text` replaces the text from ctx.start to the caret
    // plus `consume` characters after it, and `caret` is where the caret goes, counted from ctx.start. `after` is the
    // text after the caret: if it already holds the argument braces, they are not added again.
    function insertion(item, ctx, after = '') {
        if (ctx.kind === 'environment') {
            const closed = after.startsWith('}');
            return { text: item.name + '}', caret: item.name.length + 1, consume: closed ? 1 : 0 };
        }
        const head = '\\' + item.name;
        if (!item.args || /^[{[]/.test(after)) return { text: head, caret: head.length, consume: 0 };
        return { text: head + item.args, caret: head.length + 1, consume: 0 };
    }

    // How a match is shown: the command as it will be written.
    const label = (item, ctx) => (ctx.kind === 'environment' ? item.name : '\\' + item.name + (item.args || ''));

    // ---- The popup (browser only) ----

    // Where the caret is on the page, found by laying out the text before it in a hidden copy of the textarea.
    function caretRect(textarea, position) {
        const style = getComputedStyle(textarea);
        const mirror = document.createElement('div');
        for (const property of ['boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
            'textTransform', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
            'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
            mirror.style[property] = style[property];
        }
        mirror.style.cssText += ';position:absolute;visibility:hidden;top:0;left:-9999px;overflow:hidden;white-space:pre-wrap;'
            + 'overflow-wrap:break-word;word-break:normal;width:' + textarea.clientWidth + 'px;box-sizing:border-box;'
            + 'border-style:solid;border-color:transparent;';
        mirror.textContent = textarea.value.slice(0, position);
        const marker = document.createElement('span');
        marker.textContent = '​';
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        const box = textarea.getBoundingClientRect();
        const left = box.left + textarea.clientLeft + marker.offsetLeft - textarea.scrollLeft;
        const top = box.top + textarea.clientTop + marker.offsetTop - textarea.scrollTop;
        const height = parseFloat(style.lineHeight) || marker.offsetHeight;
        mirror.remove();
        return { left, top, height };
    }

    // Offer completions as the user types in `textarea`. Returns { hide, enabled }.
    function attach(textarea) {
        const popup = document.createElement('div');
        popup.className = 'completion-popup';
        popup.id = 'completionPopup';
        popup.setAttribute('role', 'listbox');
        popup.hidden = true;
        document.body.appendChild(popup);
        textarea.setAttribute('aria-autocomplete', 'list');
        textarea.setAttribute('aria-controls', popup.id);

        let items = [];
        let ctx = null;
        let selected = 0;
        let suppress = false;

        const hide = () => { popup.hidden = true; items = []; ctx = null; };

        function render() {
            popup.replaceChildren();
            items.forEach((item, index) => {
                const row = document.createElement('div');
                row.className = 'completion-item' + (index === selected ? ' selected' : '');
                row.setAttribute('role', 'option');
                row.setAttribute('aria-selected', String(index === selected));
                const name = document.createElement('span');
                name.className = 'completion-name';
                const text = label(item, ctx);
                const typed = (ctx.kind === 'command' ? 1 : 0) + ctx.prefix.length;
                const strong = document.createElement('b');
                strong.textContent = text.slice(0, typed);
                name.append(strong, text.slice(typed));
                const description = document.createElement('span');
                description.className = 'completion-desc';
                description.textContent = item.description;
                row.append(name, description);
                row.addEventListener('mousedown', (event) => { event.preventDefault(); selected = index; accept(); });
                popup.appendChild(row);
            });
            const hint = document.createElement('div');
            hint.className = 'completion-hint';
            hint.textContent = 'Tab inserts · ↑↓ choose · Esc closes';
            popup.appendChild(hint);
        }

        function place() {
            const rect = caretRect(textarea, textarea.selectionStart);
            popup.style.left = '0px';
            popup.style.top = '0px';
            popup.hidden = false;
            const width = popup.offsetWidth;
            const height = popup.offsetHeight;
            let left = Math.min(rect.left, window.innerWidth - width - 8);
            let top = rect.top + rect.height + 2;
            if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 2); // not enough room below
            popup.style.left = Math.max(8, left) + 'px';
            popup.style.top = top + 'px';
        }

        function update() {
            if (suppress || textarea.readOnly || textarea.disabled || textarea.selectionStart !== textarea.selectionEnd) return hide();
            const next = context(textarea.value.slice(0, textarea.selectionStart));
            const found = suggest(next);
            if (!found.length) return hide();
            if (!ctx || ctx.start !== next.start || ctx.kind !== next.kind) selected = 0;
            ctx = next;
            items = found;
            selected = Math.min(selected, items.length - 1);
            render();
            place();
        }

        function accept() {
            const item = items[selected];
            if (!item) return;
            const done = insertion(item, ctx, textarea.value.slice(textarea.selectionStart));
            const from = ctx.start;
            const to = textarea.selectionStart + done.consume;
            const expected = textarea.value.slice(0, from) + done.text + textarea.value.slice(to);
            suppress = true;
            try {
                textarea.focus();
                textarea.setSelectionRange(from, to);
                let ok = false;
                try { ok = document.execCommand('insertText', false, done.text); } catch { /* use the fallback */ }
                if (!ok || textarea.value !== expected) { // no execCommand: the text is right, but not the native undo
                    textarea.value = expected;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
                textarea.setSelectionRange(from + done.caret, from + done.caret);
            } finally {
                suppress = false;
            }
            hide();
        }

        const move = (step) => {
            selected = (selected + step + items.length) % items.length;
            render();
        };

        textarea.addEventListener('input', (event) => { if (!event.isComposing) update(); });
        textarea.addEventListener('click', update);
        textarea.addEventListener('keyup', (event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update();
        });
        textarea.addEventListener('keydown', (event) => {
            if (popup.hidden || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
            if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
            else if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); accept(); }
            else if (event.key === 'Escape') { event.preventDefault(); hide(); }
        });
        textarea.addEventListener('blur', hide);
        textarea.addEventListener('scroll', () => { if (!popup.hidden) place(); });
        window.addEventListener('resize', hide);

        return { hide };
    }

    return { COMMANDS, ENVIRONMENTS, context, suggest, insertion, label, attach };
});
