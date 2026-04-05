const fs = require('fs');
const http = require('http');
const path = require('path');

const { createEvaluatorRuntime } = require('../js/evaluator-core.js');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_PATH = path.join(ROOT, 'py', 'python-bridge.py');
const PYODIDE_INDEX = path.join(ROOT, 'node_modules', 'pyodide');
const SYMENGINE_WHEEL = 'lib/symengine-0.14.1-cp312-cp312-pyodide_2024_0_wasm32.whl';

function createStaticServer(rootDir) {
    const server = http.createServer((req, res) => {
        const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
        const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const filePath = path.join(rootDir, relativePath);

        fs.readFile(filePath, (error, data) => {
            if (error) {
                res.writeHead(error.code === 'ENOENT' ? 404 : 500);
                res.end(error.code === 'ENOENT' ? 'Not found' : String(error));
                return;
            }

            res.writeHead(200);
            res.end(data);
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({
                server,
                url: `http://127.0.0.1:${server.address().port}/`,
            });
        });
    });
}

async function main() {
    const inputPath = process.argv[2];
    if (!inputPath) {
        throw new Error('Usage: node scripts/eval-blocks.js <blocks.json>');
    }

    const blocks = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
    const staticServer = await createStaticServer(ROOT);
    let runtime;

    try {
        runtime = await createEvaluatorRuntime({
            indexURL: `${PYODIDE_INDEX}/`,
            pythonBridgePath: BRIDGE_PATH,
            symengineWheelUrl: new URL(SYMENGINE_WHEEL, staticServer.url).href,
        });

        const result = await runtime.evaluateLatexBlocks(blocks);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
        runtime?.pyodide?.terminate?.();
        await new Promise((resolve) => staticServer.server.close(resolve));
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
});
