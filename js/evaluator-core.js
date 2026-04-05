(function (global) {
    'use strict';

    function getNodeRequire() {
        if (typeof module !== 'undefined' && module.require) {
            return module.require.bind(module);
        }
        return null;
    }

    function getComputeEngineLib() {
        if (global.ComputeEngine?.ComputeEngine) {
            return global.ComputeEngine;
        }

        const nodeRequire = getNodeRequire();
        if (nodeRequire) {
            return nodeRequire('@cortex-js/compute-engine');
        }

        throw new Error('Compute Engine is not available');
    }

    function readTextFile(path) {
        const nodeRequire = getNodeRequire();
        if (!nodeRequire) {
            throw new Error('Local file access is not available in this environment');
        }

        const fs = nodeRequire('fs');
        return fs.readFileSync(path, 'utf8');
    }

    function joinUrl(base, path) {
        if (!base) return path;
        if (/^[a-z]+:/i.test(path)) return path;
        return new URL(path, base).href;
    }

    function trimOuterSpaces(text) {
        return (text ?? '').trim();
    }

    function splitTopLevel(text, separator = ',') {
        const parts = [];
        let depthBrace = 0;
        let depthParen = 0;
        let depthBracket = 0;
        let start = 0;

        for (let i = 0; i < text.length; i += 1) {
            const char = text[i];
            if (char === '\\') {
                i += 1;
                continue;
            }

            if (char === '{') depthBrace += 1;
            else if (char === '}') depthBrace = Math.max(0, depthBrace - 1);
            else if (char === '(') depthParen += 1;
            else if (char === ')') depthParen = Math.max(0, depthParen - 1);
            else if (char === '[') depthBracket += 1;
            else if (char === ']') depthBracket = Math.max(0, depthBracket - 1);
            else if (char === separator && depthBrace === 0 && depthParen === 0 && depthBracket === 0) {
                parts.push(text.slice(start, i).trim());
                start = i + 1;
            }
        }

        const tail = text.slice(start).trim();
        if (tail !== '') {
            parts.push(tail);
        }

        return parts;
    }

    function findTopLevelToken(text, token) {
        let depthBrace = 0;
        let depthParen = 0;
        let depthBracket = 0;

        for (let i = 0; i <= text.length - token.length; i += 1) {
            const char = text[i];
            if (char === '\\') {
                if (text.startsWith(token, i) && depthBrace === 0 && depthParen === 0 && depthBracket === 0) {
                    return i;
                }
                i += 1;
                continue;
            }

            if (char === '{') depthBrace += 1;
            else if (char === '}') depthBrace = Math.max(0, depthBrace - 1);
            else if (char === '(') depthParen += 1;
            else if (char === ')') depthParen = Math.max(0, depthParen - 1);
            else if (char === '[') depthBracket += 1;
            else if (char === ']') depthBracket = Math.max(0, depthBracket - 1);

            if (depthBrace === 0 && depthParen === 0 && depthBracket === 0 && text.startsWith(token, i)) {
                return i;
            }
        }

        return -1;
    }

    function normalizeBoldConstants(latex) {
        const constantMap = {
            e: '\\operatorname{__const_e__}',
            '\\phi': '\\operatorname{__const_phi__}',
            '\\gamma': '\\operatorname{__const_gamma__}',
            '\\delta': '\\operatorname{__const_delta__}',
            c: '\\operatorname{__const_c__}',
            h: '\\operatorname{__const_h__}',
            g: '\\operatorname{__const_g__}',
        };

        return latex.replace(/\\pmb\{([^{}]+)\}/g, (_, inner) => {
            const key = inner.trim();
            return constantMap[key] ?? inner;
        });
    }

    function normalizeNormBars(latex) {
        let isOpen = true;
        return latex.replace(/\\\|/g, () => {
            const replacement = isOpen ? '\\lVert' : '\\rVert';
            isOpen = !isOpen;
            return replacement;
        });
    }

    function preprocessLatexBase(latex) {
        return normalizeNormBars(normalizeBoldConstants(latex))
            .replace(/\\_/g, '_')
            .replace(/\\left/g, '')
            .replace(/\\right/g, '')
            .replace(/\\,/g, '')
            .replace(/\\!/g, '')
            .replace(/\\;/g, '')
            .replace(/\\quad/g, ' ')
            .replace(/\\neq/g, '\\ne')
            .replace(/\\eigv\b/g, '\\text{eigv}')
            .replace(/\\eig\b/g, '\\text{eig}')
            .replace(/\\frac\{d ([^{}]+)\}\{d([A-Za-z_][A-Za-z0-9_]*)\}/g, '\\frac{d}{d$2}($1)')
            .replace(/\\mathrm\{d([A-Za-z][A-Za-z0-9_]*)\}/g, 'd$1')
            .replace(/\\text\{([^{}]*)\}/g, (_, content) => {
                const normalized = content.replace(/\\_/g, '_');
                return /^[A-Za-z0-9_]+$/.test(normalized) ? `\\text{${normalized}}` : '';
            })
            .trim();
    }

    function readBalancedGroup(text, start, open = '{', close = '}') {
        if (text[start] !== open) return null;
        let depth = 0;

        for (let i = start; i < text.length; i += 1) {
            const char = text[i];
            if (char === '\\') {
                i += 1;
                continue;
            }
            if (char === open) depth += 1;
            else if (char === close) {
                depth -= 1;
                if (depth === 0) {
                    return {
                        content: text.slice(start + 1, i),
                        end: i + 1,
                    };
                }
            }
        }

        return null;
    }

    function normalizeIdentifierContent(content) {
        let current = (content ?? '')
            .replace(/\\_/g, '_')
            .replace(/\s+/g, '');

        let previous;
        do {
            previous = current;
            current = current.replace(/([A-Za-z0-9]+)_\{([^{}]+)\}/g, (_, head, tail) => `${head}_${normalizeIdentifierContent(tail)}`);
        } while (current !== previous);

        return current
            .replace(/[{}]/g, '')
            .replace(/\\([A-Za-z]+)/g, '$1');
    }

    function readSubscript(text, start) {
        if (text[start] !== '_') {
            return {
                raw: '',
                normalized: '',
                end: start,
                wasBraced: false,
                isPlain: false,
            };
        }

        if (text[start + 1] === '{') {
            const group = readBalancedGroup(text, start + 1);
            if (!group) return null;
            return {
                raw: text.slice(start, group.end),
                normalized: normalizeIdentifierContent(group.content),
                end: group.end,
                wasBraced: true,
                isPlain: false,
            };
        }

        const match = text.slice(start + 1).match(/^[A-Za-z0-9_]+/);
        if (!match) return null;
        return {
            raw: `_${match[0]}`,
            normalized: normalizeIdentifierContent(match[0]),
            end: start + 1 + match[0].length,
            wasBraced: false,
            isPlain: true,
        };
    }

    function buildIdentifierResult(start, end, raw, base, subscript, displayLatex, safeLatex) {
        const normalizedName = base + (subscript?.normalized ? `_${subscript.normalized}` : '');

        return {
            name: normalizedName,
            base,
            end,
            raw,
            displayLatex,
            safeLatex: safeLatex ?? raw,
        };
    }

    function readMathIdentifier(text, start) {
        const operatornamePrefix = '\\operatorname{';
        const textPrefix = '\\text{';
        const vecPrefix = '\\vec{';

        if (text.startsWith(operatornamePrefix, start) || text.startsWith(textPrefix, start) || text.startsWith(vecPrefix, start)) {
            const prefix = text.startsWith(operatornamePrefix, start)
                ? operatornamePrefix
                : text.startsWith(textPrefix, start)
                    ? textPrefix
                    : vecPrefix;
            const command = prefix === vecPrefix ? 'vec' : prefix === textPrefix ? 'text' : 'operatorname';
            const group = readBalancedGroup(text, start + prefix.length - 1);
            if (!group) return null;

            const subscript = readSubscript(text, group.end) ?? {
                raw: '',
                normalized: '',
                end: group.end,
                wasBraced: false,
                isPlain: false,
            };
            const raw = text.slice(start, subscript.end);
            const displayLatex = raw;
            const base = normalizeIdentifierContent(group.content);
            if (!/^[A-Za-z0-9_]+$/.test(base)) return null;

            if (command === 'vec') {
                return buildIdentifierResult(
                    start,
                    subscript.end,
                    raw,
                    base,
                    subscript,
                    displayLatex,
                    `\\operatorname{${base + (subscript.normalized ? `_${subscript.normalized}` : '')}}`,
                );
            }

            return buildIdentifierResult(
                start,
                subscript.end,
                raw,
                base,
                subscript,
                displayLatex,
                `\\operatorname{${base + (subscript.normalized ? `_${subscript.normalized}` : '')}}`,
            );
        }

        const baseMatch = text.slice(start).match(/^[A-Za-z]+/);
        if (!baseMatch) return null;
        const base = baseMatch[0];
        const subscript = readSubscript(text, start + base.length) ?? {
            raw: '',
            normalized: '',
            end: start + base.length,
            wasBraced: false,
            isPlain: false,
        };
        const end = subscript.end;
        const raw = text.slice(start, end);
        return buildIdentifierResult(start, end, raw, base, subscript, raw);
    }

    function skipSpaces(text, index) {
        let i = index;
        while (/\s/.test(text[i] ?? '')) {
            i += 1;
        }
        return i;
    }

    function readCallArguments(text, openIndex) {
        if (text[openIndex] !== '(') return null;

        let depth = 0;
        for (let i = openIndex; i < text.length; i += 1) {
            const char = text[i];
            if (char === '\\') {
                i += 1;
                continue;
            }
            if (char === '(') depth += 1;
            else if (char === ')') {
                depth -= 1;
                if (depth === 0) {
                    return {
                        args: splitTopLevel(text.slice(openIndex + 1, i)),
                        end: i + 1,
                    };
                }
            }
        }

        return null;
    }

    function parseCallLike(text) {
        const normalized = preprocessLatexBase(text);
        const identifier = readMathIdentifier(normalized, 0);
        if (!identifier) return null;

        const openIndex = skipSpaces(normalized, identifier.end);
        const call = readCallArguments(normalized, openIndex);
        if (!call) return null;

        const tail = normalized.slice(call.end).trim();
        if (tail !== '') return null;
        return {
            name: identifier.name,
            displayName: identifier.displayLatex,
            args: call.args,
        };
    }

    function normalizeSequenceItemShorthand(text) {
        const trimmed = trimOuterSpaces(text);
        const sumProd = trimmed.match(/^\\(sum|prod)_([^{}\\\s]+)\^([^{}\\\s]+)([\s\S]+)$/);
        if (!sumProd) return trimmed;

        const [, op, lower, upper, body] = sumProd;
        const variable = op === 'sum' ? 'k' : 'k';
        const command = op === 'sum' ? '\\sum' : '\\prod';
        return `${command}_{${variable}=${lower}}^{${upper}} ${body.trim()}`;
    }

    function isWholeMatrixProduct(text) {
        const trimmed = trimOuterSpaces(text);
        if (!trimmed.startsWith('\\begin{bmatrix}')) return null;
        const pivot = trimmed.indexOf('\\end{bmatrix}');
        if (pivot === -1) return null;
        const left = trimmed.slice(0, pivot + '\\end{bmatrix}'.length);
        const right = trimmed.slice(pivot + '\\end{bmatrix}'.length).trim();
        if (!right.startsWith('\\begin{bmatrix}')) return null;
        return { left, right };
    }

    function makeComputeEngine() {
        const ceLib = getComputeEngineLib();
        return new ceLib.ComputeEngine();
    }

    function normalizeIdentifierLatex(latex) {
        const normalized = preprocessLatexBase(latex);
        const identifier = readMathIdentifier(normalized, 0);
        if (!identifier || normalized.slice(identifier.end).trim() !== '') {
            return null;
        }
        return {
            name: identifier.name,
            displayName: identifier.displayLatex,
        };
    }

    function parseWithComputeEngine(ce, latex) {
        const expr = ce.parse(latex);
        return expr.json;
    }

    function prepareLatexForComputeEngine(latex, state, ce) {
        const source = preprocessLatexBase(latex);
        const placeholders = [];
        let result = '';

        for (let i = 0; i < source.length; i += 1) {
            const char = source[i];
            if (char === '\\') {
                if (source.startsWith('\\begin{', i) || source.startsWith('\\end{', i)) {
                    const commandLength = source.startsWith('\\begin{', i) ? '\\begin'.length : '\\end'.length;
                    const group = readBalancedGroup(source, i + commandLength);
                    if (!group) {
                        result += char;
                        continue;
                    }
                    result += source.slice(i, group.end);
                    i = group.end - 1;
                    continue;
                }

                const command = source.slice(i).match(/^\\[A-Za-z]+/);
                if (command && !/^\\(?:text|operatorname|vec)$/.test(command[0])) {
                    result += command[0];
                    i += command[0].length - 1;
                    continue;
                }
            }

            const identifier = readMathIdentifier(source, i);
            if (!identifier) {
                result += char;
                continue;
            }

            const openIndex = skipSpaces(source, identifier.end);
            const call = readCallArguments(source, openIndex);
            if (call) {
                const placeholderName = `__call_${placeholders.length}__`;
                const args = call.args.map((arg) => parseExpression(arg, state, ce));
                placeholders.push({
                    name: placeholderName,
                    node: state.knownFunctions.has(identifier.name)
                        ? { type: 'function_call', name: identifier.name, args }
                        : {
                            type: 'undefined_function_call',
                            name: identifier.name,
                            displayName: identifier.displayLatex,
                            args,
                        },
                });
                result += `\\operatorname{${placeholderName}}`;
                i = call.end - 1;
                continue;
            }

            result += identifier.safeLatex;
            i = identifier.end - 1;
        }

        return { latex: result, placeholders };
    }

    function parseExpression(rawText, state, ce) {
        const text = normalizeSequenceItemShorthand(rawText);
        const assignmentIndex = findTopLevelToken(text, '\\coloneq');
        if (assignmentIndex >= 0) {
            const lhs = text.slice(0, assignmentIndex).trim();
            const rhs = text.slice(assignmentIndex + '\\coloneq'.length).trim();
            const call = parseCallLike(lhs);
            if (call) {
                state.knownFunctions.add(call.name);
                return {
                    type: 'function_assign',
                    name: call.name,
                    displayName: call.displayName,
                    params: call.args.map((arg) => normalizeIdentifierLatex(arg)?.name ?? preprocessLatexBase(arg)),
                    displayParams: call.args,
                    value: parseExpression(rhs, state, ce),
                };
            }

            const normalizedLhs = normalizeIdentifierLatex(lhs);
            return {
                type: 'assign',
                name: normalizedLhs?.name ?? preprocessLatexBase(lhs),
                displayName: normalizedLhs?.displayName ?? preprocessLatexBase(lhs),
                value: parseExpression(rhs, state, ce),
            };
        }

        if (/^\\oint/.test(text)) {
            return { type: 'custom', op: 'contour_integral', raw: preprocessLatexBase(text) };
        }

        if (/^\\mathcal\{F\}/.test(text)) {
            return { type: 'custom', op: 'fourier_transform', raw: preprocessLatexBase(text) };
        }

        if (/^\\mathcal\{L\}\^\{-1\}/.test(text)) {
            return { type: 'custom', op: 'inverse_laplace', raw: preprocessLatexBase(text) };
        }

        const partialMatch = text.match(/^\\frac\{\\partial\}\{\\partial ([A-Za-z_][A-Za-z0-9_]*)\}([\s\S]+)$/);
        if (partialMatch) {
            return {
                type: 'custom',
                op: 'partial_derivative',
                variable: partialMatch[1],
                expression: parseExpression(partialMatch[2], state, ce),
            };
        }

        const dotIndex = findTopLevelToken(text, '\\bullet');
        if (dotIndex >= 0) {
            return {
                type: 'custom',
                op: 'dot',
                args: [
                    parseExpression(text.slice(0, dotIndex), state, ce),
                    parseExpression(text.slice(dotIndex + '\\bullet'.length), state, ce),
                ],
            };
        }

        const crossIndex = findTopLevelToken(text, '\\times');
        if (crossIndex >= 0) {
            return {
                type: 'custom',
                op: 'cross',
                args: [
                    parseExpression(text.slice(0, crossIndex), state, ce),
                    parseExpression(text.slice(crossIndex + '\\times'.length), state, ce),
                ],
            };
        }

        const matrixProduct = isWholeMatrixProduct(text);
        if (matrixProduct) {
            return {
                type: 'custom',
                op: 'matmul',
                args: [
                    parseExpression(matrixProduct.left, state, ce),
                    parseExpression(matrixProduct.right, state, ce),
                ],
            };
        }

        const call = parseCallLike(text);
        if (call) {
            if (state.knownFunctions.has(call.name)) {
                return {
                    type: 'function_call',
                    name: call.name,
                    args: call.args.map((arg) => parseExpression(arg, state, ce)),
                };
            }

            if (['solve', 'solve_integer', 'factor_integer', 'residue', 'eig', 'eigv', 'simplify'].includes(call.name)) {
                return {
                    type: 'custom',
                    op: call.name,
                    args: call.args.map((arg) => parseExpression(arg, state, ce)),
                };
            }
        }

        const prepared = prepareLatexForComputeEngine(text, state, ce);
        return {
            type: 'mathjson',
            value: parseWithComputeEngine(ce, prepared.latex),
            placeholders: prepared.placeholders,
        };
    }

    function buildAstBlocks(latexBlocks) {
        const ce = makeComputeEngine();
        const state = { knownFunctions: new Set() };
        return latexBlocks.map((latex) => ({
            raw: latex,
            items: splitTopLevel(latex).map((item) => parseExpression(item, state, ce)),
        }));
    }

    async function loadPythonBridgeCode(options = {}) {
        if (options.pythonBridgeCode) return options.pythonBridgeCode;
        if (options.pythonBridgePath) return readTextFile(options.pythonBridgePath);

        if (options.pythonBridgeUrl && typeof fetch === 'function') {
            const response = await fetch(options.pythonBridgeUrl);
            if (!response.ok) {
                throw new Error(`Failed to load Python bridge: ${response.status}`);
            }
            return await response.text();
        }

        throw new Error('Python bridge source was not provided');
    }

    async function getLoadPyodide() {
        if (typeof global.loadPyodide === 'function') {
            return global.loadPyodide;
        }

        const nodeRequire = getNodeRequire();
        if (nodeRequire) {
            return nodeRequire('pyodide').loadPyodide;
        }

        throw new Error('Pyodide is not available');
    }

    async function createPyodideSession(options = {}) {
        const loadPyodide = await getLoadPyodide();
        const pyodide = await loadPyodide({ indexURL: options.indexURL });

        if (typeof options.onStatus === 'function') {
            options.onStatus('Loading Python packages');
        }

        await pyodide.loadPackage('micropip');
        await pyodide.loadPackage('sympy');
        const micropip = pyodide.pyimport('micropip');
        try {
            await micropip.install(options.symengineWheelUrl);
        } finally {
            micropip.destroy?.();
        }

        const pythonBridgeCode = await loadPythonBridgeCode(options);
        await pyodide.runPythonAsync(pythonBridgeCode);

        return pyodide;
    }

    async function createEvaluatorRuntime(options = {}) {
        const pyodide = await createPyodideSession(options);

        return {
            pyodide,
            async evaluateLatexBlocks(latexBlocks) {
                const payload = buildAstBlocks(latexBlocks);
                const evaluator = pyodide.globals.get('evaluate_math_blocks');
                try {
                    const raw = evaluator(JSON.stringify(payload));
                    return JSON.parse(raw);
                } finally {
                    evaluator.destroy?.();
                }
            },
            buildAstBlocks,
        };
    }

    const api = {
        buildAstBlocks,
        createEvaluatorRuntime,
        preprocessLatexBase,
        splitTopLevel,
    };

    global.MathEditorEvaluator = api;

    if (typeof module !== 'undefined') {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
