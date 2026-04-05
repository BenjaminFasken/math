const fs = require('fs');
const http = require('http');
const path = require('path');

const { createEvaluatorRuntime } = require('../js/evaluator-core.js');

const ROOT = path.resolve(__dirname, '..');
const TESTS_PATH = path.join(ROOT, 'tests-w-results.txt');
const BRIDGE_PATH = path.join(ROOT, 'py', 'python-bridge.py');
const PYODIDE_INDEX = path.join(ROOT, 'node_modules', 'pyodide');
const SYMENGINE_WHEEL = 'lib/symengine-0.14.1-cp312-cp312-pyodide_2024_0_wasm32.whl';

function normalizeLatex(text) {
    return (text ?? '')
        .replace(/\s+/g, '')
        .replace(/\\left/g, '')
        .replace(/\\right/g, '')
        .replace(/\\,/g, '')
        .replace(/\\!/g, '')
        .trim();
}

function extractLatex(line) {
    const match = line.match(/\$\$([\s\S]*?)\$\$/);
    return match ? match[1].trim() : null;
}

function parseCases(text) {
    const cases = [];
    const lines = text.split(/\r?\n/);
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];
        if (/^Inverse dynamics:/i.test(line.trim())) {
            break;
        }

        if (!line.trim().startsWith('$$')) {
            index += 1;
            continue;
        }

        const symbolicLine = lines[index + 1] ?? '';
        const numericLine = lines[index + 2] ?? '';
        const input = extractLatex(line);
        const expectedSymbolic = extractLatex(symbolicLine.startsWith('#') ? symbolicLine.slice(1) : symbolicLine);
        const expectedNumeric = extractLatex(numericLine.startsWith('#') ? numericLine.slice(1) : numericLine);

        if (input && expectedSymbolic && expectedNumeric) {
            cases.push({
                input,
                expectedSymbolic,
                expectedNumeric,
                line: index + 1,
            });
            index += 3;
            continue;
        }

        index += 1;
    }

    return cases;
}

function createStaticServer(rootDir) {
    const server = http.createServer((req, res) => {
        const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
        const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const filePath = path.join(rootDir, relativePath);

        if (!filePath.startsWith(rootDir)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.readFile(filePath, (error, data) => {
            if (error) {
                res.writeHead(error.code === 'ENOENT' ? 404 : 500);
                res.end(error.code === 'ENOENT' ? 'Not found' : String(error));
                return;
            }

            if (filePath.endsWith('.whl')) {
                res.setHeader('Content-Type', 'application/octet-stream');
            } else if (filePath.endsWith('.js')) {
                res.setHeader('Content-Type', 'application/javascript');
            } else if (filePath.endsWith('.wasm')) {
                res.setHeader('Content-Type', 'application/wasm');
            } else if (filePath.endsWith('.json')) {
                res.setHeader('Content-Type', 'application/json');
            } else if (filePath.endsWith('.data')) {
                res.setHeader('Content-Type', 'application/octet-stream');
            }

            res.writeHead(200);
            res.end(data);
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                server,
                url: `http://127.0.0.1:${address.port}/`,
            });
        });
    });
}

async function main() {
    const source = fs.readFileSync(TESTS_PATH, 'utf8');
    const cases = parseCases(source);
    const staticServer = await createStaticServer(ROOT);
    let runtime;

    try {
        runtime = await createEvaluatorRuntime({
            indexURL: `${PYODIDE_INDEX}/`,
            pythonBridgePath: BRIDGE_PATH,
            symengineWheelUrl: new URL(SYMENGINE_WHEEL, staticServer.url).href,
            onStatus(message) {
                process.stderr.write(`${message}\n`);
            },
        });

        const evaluation = await runtime.evaluateLatexBlocks(cases.map((entry) => entry.input));
        const failures = [];

        evaluation.results.forEach((result, caseIndex) => {
            const testCase = cases[caseIndex];
            const actualSymbolic = result.symbolic ?? '';
            const actualNumeric = result.numeric ?? '';
            const symbolicMatches = normalizeLatex(actualSymbolic) === normalizeLatex(testCase.expectedSymbolic);
            const numericMatches = normalizeLatex(actualNumeric) === normalizeLatex(testCase.expectedNumeric);

            if (!symbolicMatches || !numericMatches || !result.ok) {
                failures.push({
                    line: testCase.line,
                    input: testCase.input,
                    ok: result.ok,
                    expectedSymbolic: testCase.expectedSymbolic,
                    actualSymbolic,
                    expectedNumeric: testCase.expectedNumeric,
                    actualNumeric,
                });
            }
        });

        if (failures.length > 0) {
            process.stderr.write(`Failed ${failures.length} of ${cases.length} cases before inverse dynamics.\n`);
            for (const failure of failures.slice(0, 40)) {
                process.stderr.write(`\nLine ${failure.line}: ${failure.input}\n`);
                process.stderr.write(`  symbolic expected: ${failure.expectedSymbolic}\n`);
                process.stderr.write(`  symbolic actual:   ${failure.actualSymbolic}\n`);
                process.stderr.write(`  numeric expected:  ${failure.expectedNumeric}\n`);
                process.stderr.write(`  numeric actual:    ${failure.actualNumeric}\n`);
            }
            process.exitCode = 1;
            return;
        }

        process.stdout.write(`Passed ${cases.length} cases before inverse dynamics.\n`);
    } finally {
        runtime?.pyodide?.terminate?.();
        await new Promise((resolve) => staticServer.server.close(resolve));
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
});
